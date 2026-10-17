const { MAX_DOCUMENTS, READ_OPTIONS, ReadinessError, ObjectId, runDatabaseCommand } = require("./lib/database-access");

const CORE_COLLECTIONS = ["merchants", "customers", "products", "events"];
const identityFields = { customers: "email", products: "handle", events: "dedupeKey" };

function canonicalIdentity(value, kind) {
  if (typeof value !== "string") return "";
  if (kind === "events") return value.trim();
  const lower = value.trim().toLowerCase();
  return kind === "customers" ? lower : lower.replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function inspectIdentities(rows, kind) {
  const field = identityFields[kind];
  const counts = { scanned: 0, missingIdentity: 0, invalidIdentity: 0, nonCanonicalIdentity: 0,
    invalidMerchantId: 0, duplicateGroups: 0, extraDocuments: 0 };
  const seen = new Map();
  for (const row of rows) {
    counts.scanned += 1;
    const raw = row[field];
    if (!(row.merchantId instanceof ObjectId)) counts.invalidMerchantId += 1;
    if (raw == null) { counts.missingIdentity += 1; continue; }
    const identity = canonicalIdentity(raw, kind);
    if (!identity || (kind === "customers" && (identity.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)))) {
      counts.invalidIdentity += 1;
      continue;
    }
    if (identity !== raw) counts.nonCanonicalIdentity += 1;
    if (!(row.merchantId instanceof ObjectId)) continue;
    const key = `${row.merchantId.toHexString()}\0${identity}`;
    const previous = seen.get(key) || 0;
    if (previous === 1) counts.duplicateGroups += 1;
    if (previous >= 1) counts.extraDocuments += 1;
    seen.set(key, previous + 1);
  }
  return counts;
}

function hasExpectedIndex(indexes, field) {
  return indexes.some((index) => {
    const partial = index.partialFilterExpression;
    return index.unique === true &&
      JSON.stringify(Object.entries(index.key)) === JSON.stringify([["merchantId", 1], [field, 1]]) &&
      (!index.collation || index.collation.locale === "simple") &&
      partial && Object.keys(partial).length === 1 &&
      Object.keys(partial[field] || {}).length === 1 &&
      ["string", 2].includes(partial[field]?.$type);
  });
}

function referenceLookup(from, field, output, tenantScoped) {
  return { $lookup: { from, let: { target: `$${field}`, merchant: "$merchantId" },
    pipeline: [{ $match: { $expr: { $and: [
      { $eq: ["$_id", "$$target"] },
      ...(tenantScoped ? [{ $eq: ["$merchantId", "$$merchant"] }] : [])
    ] } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: output } };
}

async function countInvalidReferences(collection, checks) {
  const pipeline = checks.map((check) => referenceLookup(check.from, check.field, check.key, check.tenantScoped));
  pipeline.push({ $group: { _id: null, ...Object.fromEntries(checks.map((check) => [check.key,
    { $sum: { $cond: [{ $eq: [{ $size: `$${check.key}` }, 0] }, 1, 0] } }])) } });
  const [counts = {}] = await collection.aggregate(pipeline, READ_OPTIONS).toArray();
  return Object.fromEntries(checks.map((check) => [check.key, Number(counts[check.key] || 0)]));
}

async function auditDatabase(db, { onStage = () => {} } = {}) {
  onStage("list_collections");
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  const report = { version: 1, checkedAt: new Date().toISOString(), readOnly: true,
    status: "PASS", backupRestoreVerified: false,
    scope: "Integrity checks only; backup settings, restoration and concurrent-write behavior require separate verification.",
    collections: Object.create(null), issues: [], notes: [] };
  for (const name of CORE_COLLECTIONS) {
    if (!existing.has(name)) {
      report.collections[name] = { exists: false };
      report.issues.push(`${name}: collection missing`);
      continue;
    }
    const collection = db.collection(name);
    onStage("count_documents", name);
    const total = await collection.countDocuments({}, READ_OPTIONS);
    if (total > MAX_DOCUMENTS) throw new ReadinessError("AUDIT_SIZE_LIMIT", "A collection exceeds the 100000-document pilot audit limit. Use a planned batched audit.");
    onStage("read_indexes", name);
    const indexes = await collection.listIndexes(READ_OPTIONS).toArray();
    const result = { exists: true, documentCount: total, indexCount: indexes.length };
    report.collections[name] = result;
    if (name === "merchants") continue;
    const field = identityFields[name];
    onStage("scan_identities", name);
    const rows = await collection.find({}, { ...READ_OPTIONS, projection: { _id: 0, merchantId: 1, [field]: 1 } })
      .limit(MAX_DOCUMENTS + 1).toArray();
    if (rows.length > MAX_DOCUMENTS) throw new ReadinessError("AUDIT_SIZE_LIMIT", "Data grew beyond the pilot audit limit. Run during a quiet window.");
    if (rows.length !== total) report.issues.push(`${name}: data changed during the audit; rerun in a quiet window`);
    onStage("check_identities", name);
    result.identities = inspectIdentities(rows, name);
    result.expectedUniqueIndexPresent = hasExpectedIndex(indexes, field);
    if (!result.expectedUniqueIndexPresent) report.issues.push(`${name}: expected merchant-scoped partial unique index not confirmed`);
    for (const key of ["invalidIdentity", "nonCanonicalIdentity", "invalidMerchantId", "duplicateGroups"]) {
      if (result.identities[key] > 0) report.issues.push(`${name}: ${key} requires review`);
    }
    if (name === "products" && result.identities.missingIdentity > 0) report.issues.push("products: missing handles require review");
    if (name !== "products" && result.identities.missingIdentity > 0) report.notes.push(`${name}: records without an identity are outside that unique-index guarantee`);
    onStage("check_references", name);
    result.invalidReferences = await countInvalidReferences(collection, [
      { from: "merchants", field: "merchantId", key: "missingMerchant", tenantScoped: false },
      ...(name === "events" ? [
        { from: "customers", field: "customerId", key: "missingOrCrossTenantCustomer", tenantScoped: true },
        { from: "products", field: "productId", key: "missingOrCrossTenantProduct", tenantScoped: true }
      ] : [])
    ]);
    if (Object.values(result.invalidReferences).some((value) => value > 0)) report.issues.push(`${name}: invalid or cross-merchant references require review`);
  }
  if (report.issues.length) report.status = "ACTION_REQUIRED";
  return report;
}

if (require.main === module) {
  runDatabaseCommand(auditDatabase, "Read-only audit: npm run --silent db:audit -- --database NAME [--env-file PATH]");
}

module.exports = { canonicalIdentity, inspectIdentities, hasExpectedIndex, countInvalidReferences, auditDatabase };
