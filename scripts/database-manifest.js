const crypto = require("node:crypto");
const { MAX_DOCUMENTS, READ_OPTIONS, ReadinessError, canonicalJson, digest,
  logicalIndexes, runDatabaseCommand } = require("./lib/database-access");

async function createManifest(db, { writesPaused, targetFingerprint } = {}) {
  if (!writesPaused) throw new ReadinessError("WRITES_MUST_BE_PAUSED", "Pause application writes before using --writes-paused to create a consistent recovery manifest.");
  const collections = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((item) => !item.name.startsWith("system.")).sort((a, b) => a.name.localeCompare(b.name));
  if (!collections.length) throw new ReadinessError("EMPTY_DATABASE", "No application collections were found. Confirm the database target.");
  if (collections.some((item) => item.type !== "collection" || item.options?.timeseries)) {
    throw new ReadinessError("UNSUPPORTED_COLLECTION", "Views and time-series collections need a separate provider-aware recovery check.");
  }
  const manifest = { version: 1, type: "derma-insight-recovery-manifest", createdAt: new Date().toISOString(),
    consistency: "operator-confirmed-writes-paused", readOnly: true, targetFingerprint, collections: Object.create(null) };
  for (const info of collections) {
    const collection = db.collection(info.name);
    const beforeCount = await collection.countDocuments({}, READ_OPTIONS);
    if (beforeCount > MAX_DOCUMENTS) throw new ReadinessError("MANIFEST_SIZE_LIMIT", "A collection exceeds the 100000-document pilot manifest limit.");
    const hash = crypto.createHash("sha256");
    let scanned = 0;
    // Keep Int32/Long/Double wrappers so equal-looking numeric values with
    // different BSON types cannot produce identical recovery fingerprints.
    const cursor = collection.find({}, { ...READ_OPTIONS, promoteValues: false })
      .sort({ _id: 1 }).limit(MAX_DOCUMENTS + 1).batchSize(500);
    for await (const document of cursor) {
      scanned += 1;
      if (scanned > MAX_DOCUMENTS) throw new ReadinessError("MANIFEST_SIZE_LIMIT", "Data grew beyond the pilot manifest limit.");
      hash.update(canonicalJson(document)).update("\n");
    }
    const afterCount = await collection.countDocuments({}, READ_OPTIONS);
    if (scanned !== beforeCount || scanned !== afterCount) {
      throw new ReadinessError("DATABASE_CHANGED", "Document counts changed during fingerprinting. Keep writes paused and repeat the manifest.");
    }
    manifest.collections[info.name] = { documentCount: scanned,
      documentsSha256: hash.digest("hex"),
      indexesSha256: digest(logicalIndexes(await collection.listIndexes(READ_OPTIONS).toArray())),
      optionsSha256: digest(info.options || {}) };
  }
  return manifest;
}

if (require.main === module) {
  runDatabaseCommand(createManifest, "Read-only recovery manifest: npm run --silent db:manifest -- --database NAME --writes-paused [--env-file PATH]");
}

module.exports = { createManifest };
