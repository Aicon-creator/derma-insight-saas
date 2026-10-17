const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { MAX_DOCUMENTS, ObjectId, connectionSettings, canonicalJson, digest,
  logicalIndexes, targetFingerprint } = require("../scripts/lib/database-access");
const { inspectIdentities, hasExpectedIndex, auditDatabase } = require("../scripts/audit-database");
const { createManifest } = require("../scripts/database-manifest");
const { compareManifests } = require("../scripts/compare-database-manifests");

const a = new ObjectId("507f1f77bcf86cd799439011");
const b = new ObjectId("507f1f77bcf86cd799439012");
const customerId = new ObjectId("507f1f77bcf86cd799439013");
const productId = new ObjectId("507f1f77bcf86cd799439014");
const primaryIndex = { name: "_id_", key: { _id: 1 } };
const uniqueIndex = (field) => ({ name: `merchantId_1_${field}_1`, key: { merchantId: 1, [field]: 1 },
  unique: true, partialFilterExpression: { [field]: { $type: "string" } } });
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

// Only read operations exist on this fake. An unexpected write or aggregation
// stage fails the tests instead of reaching any database.
function database(specification) {
  const calls = [];
  const db = {
    calls,
    listCollections() { calls.push("listCollections"); return { toArray: async () => Object.entries(specification)
      .map(([name, info]) => ({ name, type: info.type || "collection", options: info.options || {} })) }; },
    collection(name) {
      const info = specification[name] || { rows: [] };
      return new Proxy({
        async countDocuments() { calls.push("countDocuments"); return info.count ?? info.rows.length; },
        listIndexes() { calls.push("listIndexes"); return { toArray: async () => info.indexes || [primaryIndex] }; },
        find(query, options) {
          calls.push("find");
          if (!options.projection) assert.equal(options.promoteValues, false, "Recovery scans must preserve BSON numeric types");
          let rows = info.rows.slice();
          if (options.projection) rows = rows.map((row) => Object.fromEntries(Object.entries(options.projection)
            .filter(([, value]) => value === 1).map(([key]) => [key, row[key]])));
          const cursor = {
            sort() { rows.sort((left, right) => String(left._id).localeCompare(String(right._id))); return this; },
            limit(value) { rows = rows.slice(0, value); return this; },
            batchSize() { return this; }, async toArray() { return rows; },
            async *[Symbol.asyncIterator]() { for (const row of rows) yield row; }
          };
          return cursor;
        },
        aggregate(pipeline) {
          calls.push("aggregate");
          assert.ok(pipeline.every((stage) => Object.keys(stage).every((key) => ["$lookup", "$group"].includes(key))));
          const counts = {};
          for (const { $lookup: lookup } of pipeline.filter((stage) => stage.$lookup)) {
            const field = lookup.let.target.slice(1);
            const tenantScoped = lookup.pipeline[0].$match.$expr.$and.length === 2;
            counts[lookup.as] = info.rows.filter((row) => !(specification[lookup.from]?.rows || []).some((target) =>
              same(target._id, row[field]) && (!tenantScoped || same(target.merchantId, row.merchantId)))).length;
          }
          return { toArray: async () => [counts] };
        }
      }, { get(target, key) {
        if (!(key in target)) throw new Error(`Unexpected database operation: ${String(key)}`);
        return target[key];
      } });
    }
  };
  return db;
}

function healthyData() {
  return {
    merchants: { rows: [{ _id: a, password: "private-password-hash", shopifyAccessToken: "private-access-token" }, { _id: b }] },
    customers: { rows: [{ _id: customerId, merchantId: a, email: "private-customer@example.com" }], indexes: [primaryIndex, uniqueIndex("email")] },
    products: { rows: [{ _id: productId, merchantId: a, handle: "private-product" }], indexes: [primaryIndex, uniqueIndex("handle")] },
    events: { rows: [{ _id: new ObjectId(), merchantId: a, customerId, productId, dedupeKey: "event-1",
      occurredAt: new Date("2026-10-17T12:00:00Z"), price: 19.99, quantity: 2 }], indexes: [primaryIndex, uniqueIndex("dedupeKey")] }
  };
}

test("customer duplicate identities are normalized and scoped to a merchant", () => {
  const result = inspectIdentities([
    { merchantId: a, email: " Owner@Example.com " },
    { merchantId: a, email: "owner@example.com" },
    { merchantId: a, email: "OWNER@example.com" },
    { merchantId: b, email: "owner@example.com" }
  ], "customers");
  assert.equal(result.duplicateGroups, 1);
  assert.equal(result.extraDocuments, 2);
  assert.equal(result.nonCanonicalIdentity, 2);
});

test("product collision checks use CSV handle normalization", () => {
  const result = inspectIdentities([
    { merchantId: a, handle: " My & Product " },
    { merchantId: a, handle: "my-product" },
    { merchantId: b, handle: "my-product" }
  ], "products");
  assert.equal(result.duplicateGroups, 1);
  assert.equal(result.extraDocuments, 1);
});

test("invalid identities and forged object-shaped merchant IDs are reported safely", () => {
  const result = inspectIdentities([
    { merchantId: { _bsontype: "ObjectId" }, email: "bad-address" },
    { merchantId: a, email: null },
    { merchantId: "invalid", email: 123 }
  ], "customers");
  assert.equal(result.invalidMerchantId, 2);
  assert.equal(result.invalidIdentity, 2);
  assert.equal(result.missingIdentity, 1);
});

test("Event keys stay case-sensitive and null keys are outside replay protection", () => {
  const result = inspectIdentities([
    { merchantId: a, dedupeKey: "KEY" }, { merchantId: a, dedupeKey: "key" },
    { merchantId: a, dedupeKey: null }, { merchantId: a, dedupeKey: "" }
  ], "events");
  assert.equal(result.duplicateGroups, 0);
  assert.equal(result.missingIdentity, 1);
  assert.equal(result.invalidIdentity, 1);
});

test("index verification requires the actual unique, tenant-scoped partial specification", () => {
  const expected = uniqueIndex("dedupeKey");
  assert.equal(hasExpectedIndex([expected], "dedupeKey"), true);
  assert.equal(hasExpectedIndex([{ ...expected, partialFilterExpression: { dedupeKey: { $type: 2 } } }], "dedupeKey"), true);
  for (const wrong of [
    { ...expected, unique: false }, { ...expected, key: { dedupeKey: 1 } },
    { ...expected, partialFilterExpression: undefined },
    { ...expected, partialFilterExpression: { dedupeKey: { $exists: true } } },
    { ...expected, collation: { locale: "en", strength: 2 } }
  ]) assert.equal(hasExpectedIndex([wrong], "dedupeKey"), false);
});

test("a completed audit checks installed indexes and references without emitting private values", async () => {
  const db = database(healthyData());
  const report = await auditDatabase(db);
  assert.equal(report.status, "PASS");
  assert.equal(report.backupRestoreVerified, false);
  assert.equal(report.collections.events.expectedUniqueIndexPresent, true);
  assert.equal(report.collections.events.invalidReferences.missingOrCrossTenantCustomer, 0);
  assert.ok(db.calls.includes("listIndexes"));
  assert.doesNotMatch(JSON.stringify(report), /private-|507f1f77|example.com|mongodb:/);
});

test("missing indexes, duplicates and cross-tenant references prevent an audit pass", async () => {
  const spec = healthyData();
  spec.customers.rows.push({ _id: new ObjectId(), merchantId: a, email: " PRIVATE-CUSTOMER@example.com " });
  spec.customers.indexes = [primaryIndex];
  spec.products.rows[0].merchantId = b;
  const report = await auditDatabase(database(spec));
  assert.equal(report.status, "ACTION_REQUIRED");
  assert.equal(report.collections.customers.identities.duplicateGroups, 1);
  assert.equal(report.collections.customers.expectedUniqueIndexPresent, false);
  assert.equal(report.collections.events.invalidReferences.missingOrCrossTenantProduct, 1);
});

test("missing parent merchants and missing collections are explicit findings", async () => {
  const spec = healthyData();
  spec.merchants.rows = [];
  delete spec.products;
  const report = await auditDatabase(database(spec));
  assert.equal(report.status, "ACTION_REQUIRED");
  assert.equal(report.collections.products.exists, false);
  assert.equal(report.collections.customers.invalidReferences.missingMerchant, 1);
});

test("audit scans stop at the documented size boundary", async () => {
  const spec = healthyData();
  spec.merchants.count = MAX_DOCUMENTS + 1;
  await assert.rejects(auditDatabase(database(spec)), { code: "AUDIT_SIZE_LIMIT" });
});

test("recovery manifests require paused writes and reject empty or unsupported targets", async () => {
  await assert.rejects(createManifest(database(healthyData()), {}), { code: "WRITES_MUST_BE_PAUSED" });
  const options = { writesPaused: true, targetFingerprint: digest("target-a") };
  await assert.rejects(createManifest(database({}), options), { code: "EMPTY_DATABASE" });
  await assert.rejects(createManifest(database({ view: { type: "view", rows: [] } }), options), { code: "UNSUPPORTED_COLLECTION" });
});

test("restore comparison verifies BSON content, indexes and options on a distinct target", async () => {
  const spec = healthyData();
  const source = await createManifest(database(spec), { writesPaused: true, targetFingerprint: digest("source") });
  const restored = await createManifest(database(spec), { writesPaused: true, targetFingerprint: digest("restore") });
  assert.equal(compareManifests(source, restored).status, "MATCH");
  assert.equal(compareManifests(source, source).status, "MISMATCH");
  assert.doesNotMatch(JSON.stringify(source), /private-|507f1f77|example.com/);
  for (const field of ["documentCount", "documentsSha256", "indexesSha256", "optionsSha256"]) {
    const changed = structuredClone(restored);
    changed.collections.events[field] = field === "documentCount" ? 999 : "a".repeat(64);
    assert.equal(compareManifests(source, changed).status, "MISMATCH");
  }
  delete restored.collections.products;
  assert.equal(compareManifests(source, restored).status, "MISMATCH");
});

test("same-count content corruption is caught by restoration fingerprints", async () => {
  const spec = healthyData();
  const source = await createManifest(database(spec), { writesPaused: true, targetFingerprint: digest("source") });
  spec.events.rows[0].price = 1;
  const restored = await createManifest(database(spec), { writesPaused: true, targetFingerprint: digest("restore") });
  assert.equal(source.collections.events.documentCount, restored.collections.events.documentCount);
  assert.deepEqual(compareManifests(source, restored).differences, [{ collection: "events", checks: ["documentsSha256"] }]);
});

test("index and collection option changes are detected from actual metadata reads", async () => {
  const spec = healthyData();
  const source = await createManifest(database(spec), { writesPaused: true, targetFingerprint: digest("source") });
  spec.events.indexes = [primaryIndex];
  spec.customers.options = { validationLevel: "strict" };
  const restored = await createManifest(database(spec), { writesPaused: true, targetFingerprint: digest("restore") });
  assert.deepEqual(compareManifests(source, restored).differences, [
    { collection: "customers", checks: ["optionsSha256"] },
    { collection: "events", checks: ["indexesSha256"] }
  ]);
});

test("count drift and manifest size limits cannot produce successful recovery evidence", async () => {
  const spec = healthyData();
  spec.events.count = 0;
  await assert.rejects(createManifest(database(spec), { writesPaused: true, targetFingerprint: digest("source") }), { code: "DATABASE_CHANGED" });
  spec.events.count = MAX_DOCUMENTS + 1;
  await assert.rejects(createManifest(database(spec), { writesPaused: true, targetFingerprint: digest("source") }), { code: "MANIFEST_SIZE_LIMIT" });
});

test("malformed manifests cannot pass the comparison", () => {
  assert.throws(() => compareManifests({}, {}), /Invalid manifests/);
  assert.throws(() => compareManifests({ collections: [] }, { collections: [] }), /Invalid manifests/);
});

test("canonical fingerprints retain BSON types and compound index key order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.notEqual(canonicalJson({ value: new Date(0) }), canonicalJson({ value: "1970-01-01T00:00:00.000Z" }));
  const { BSON } = require("mongoose").mongo;
  const roundTrip = (value) => BSON.deserialize(BSON.serialize({ value }), { promoteValues: false });
  assert.notEqual(canonicalJson(roundTrip(new BSON.Double(1))), canonicalJson(roundTrip(new BSON.Int32(1))));
  assert.notEqual(canonicalJson(roundTrip(new BSON.Int32(1))), canonicalJson(roundTrip(BSON.Long.fromNumber(1))));
  const index = uniqueIndex("email");
  assert.notEqual(digest(logicalIndexes([index])), digest(logicalIndexes([{ ...index, key: { email: 1, merchantId: 1 } }])));
  assert.equal(digest(logicalIndexes([{ ...index, ns: "source.customers", v: 2 }])), digest(logicalIndexes([{ ...index, ns: "restore.customers", v: 1 }])));
});

test("different database names produce different target fingerprints without printing hosts", () => {
  const client = { options: { srvHost: "private-host.example.com" } };
  assert.notEqual(targetFingerprint(client, "source"), targetFingerprint(client, "restored"));
  assert.match(targetFingerprint(client, "source"), /^[a-f0-9]{64}$/);
});

test("an explicit env file wins over process settings and URI/database mismatches fail", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "derma-readiness-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "target.env");
  const uri = "mongodb://reader:fake-secret@localhost:27017/source";
  fs.writeFileSync(file, `MONGO_URI=${uri}\n`);
  assert.equal(connectionSettings({ database: "source", "env-file": file }, { MONGO_URI: "wrong" }).uri, uri);
  assert.throws(() => connectionSettings({ database: "different", "env-file": file }), { code: "DATABASE_MISMATCH" });
  assert.throws(() => connectionSettings({ database: "source", "env-file": `${file}.missing` }), { code: "ENV_FILE_MISSING" });
  assert.throws(() => connectionSettings({ database: "admin.*" }), { code: "DATABASE_REQUIRED" });
});

test("CLI failures are sanitized and missing configuration never starts a database check", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "derma-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(__dirname, "../scripts/audit-database.js");
  const result = spawnSync(process.execPath, [script, "--database", "source"], { cwd: dir, env: {}, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, "MONGO_URI_MISSING");
  const leakedInput = "mongodb://reader:fake-secret@private-host/source";
  const invalid = spawnSync(process.execPath, [script, "--database", "source", "--uri", leakedInput], { cwd: dir, env: {}, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /fake-secret|private-host|mongodb:\/\//);
});
