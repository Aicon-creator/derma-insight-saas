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

function objectIdKey(value) {
  return value instanceof ObjectId ? value.toHexString() : null;
}

function referenceIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const id = objectIdKey(row._id);
    if (id !== null) index.set(id, objectIdKey(row.merchantId));
  }
  return index;
}

function countInvalidReferences(rows, checks, referenceIndexes) {
  return Object.fromEntries(checks.map((check) => {
    const targets = referenceIndexes[check.from];
    let invalid = 0;
    for (const row of rows) {
      const id = objectIdKey(row[check.field]);
      const merchant = objectIdKey(row.merchantId);
      if (id === null || !targets.has(id) ||
        (check.tenantScoped && (merchant === null || targets.get(id) !== merchant))) invalid += 1;
    }
    return [check.key, invalid];
  }));
}

async function auditDatabase(db, { onStage = () => {} } = {}) {
  onStage("list_collections");
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  const report = { version: 1, checkedAt: new Date().toISOString(), readOnly: true,
    status: "PASS", backupRestoreVerified: false,
    scope: "Integrity checks only; backup settings, restoration and concurrent-write behavior require separate verification.",
    collections: Object.create(null), issues: [], notes: [] };
  const scannedRows = Object.create(null);
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
    const field = identityFields[name];
    // Reuse the bounded identity scan for references. Parent collections need
    // IDs and ownership only; no customer names or merchant credentials are read.
    const projection = name === "merchants" ? { _id: 1 } : {
      _id: name === "events" ? 0 : 1, merchantId: 1, [field]: 1,
      ...(name === "events" ? { customerId: 1, productId: 1 } : {})
    };
    onStage(name === "merchants" ? "scan_references" : "scan_identities", name);
    const rows = await collection.find({}, { ...READ_OPTIONS, projection })
      .limit(MAX_DOCUMENTS + 1).toArray();
    if (rows.length > MAX_DOCUMENTS) throw new ReadinessError("AUDIT_SIZE_LIMIT", "Data grew beyond the pilot audit limit. Run during a quiet window.");
    if (rows.length !== total) report.issues.push(`${name}: data changed during the audit; rerun in a quiet window`);
    scannedRows[name] = rows;
    if (name === "merchants") continue;
    onStage("check_identities", name);
    result.identities = inspectIdentities(rows, name);
    result.expectedUniqueIndexPresent = hasExpectedIndex(indexes, field);
    if (!result.expectedUniqueIndexPresent) report.issues.push(`${name}: expected merchant-scoped partial unique index not confirmed`);
    for (const key of ["invalidIdentity", "nonCanonicalIdentity", "invalidMerchantId", "duplicateGroups"]) {
      if (result.identities[key] > 0) report.issues.push(`${name}: ${key} requires review`);
    }
    if (name === "products" && result.identities.missingIdentity > 0) report.issues.push("products: missing handles require review");
    if (name !== "products" && result.identities.missingIdentity > 0) report.notes.push(`${name}: records without an identity are outside that unique-index guarantee`);
  }
  // An Event can repeat the same customer/product reference many thousands of
  // times. Checking in-memory maps avoids one correlated database join per row.
  const referenceIndexes = Object.fromEntries(["merchants", "customers", "products"]
    .map((name) => [name, referenceIndex(scannedRows[name] || [])]));
  for (const name of ["customers", "products", "events"]) {
    if (!scannedRows[name]) continue;
    onStage("check_references", name);
    const result = report.collections[name];
    result.invalidReferences = countInvalidReferences(scannedRows[name], [
      { from: "merchants", field: "merchantId", key: "missingMerchant", tenantScoped: false },
      ...(name === "events" ? [
        { from: "customers", field: "customerId", key: "missingOrCrossTenantCustomer", tenantScoped: true },
        { from: "products", field: "productId", key: "missingOrCrossTenantProduct", tenantScoped: true }
      ] : [])
    ], referenceIndexes);
    if (Object.values(result.invalidReferences).some((value) => value > 0)) report.issues.push(`${name}: invalid or cross-merchant references require review`);
  }
  if (report.issues.length) report.status = "ACTION_REQUIRED";
  return report;
}

if (require.main === module) {
  runDatabaseCommand(auditDatabase, "Read-only audit: npm run --silent db:audit -- --database NAME [--env-file PATH]");
}

module.exports = { canonicalIdentity, inspectIdentities, hasExpectedIndex, countInvalidReferences, auditDatabase };
