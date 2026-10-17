const { MAX_DOCUMENTS, READ_OPTIONS, ReadinessError, ObjectId, canonicalJson,
  runDatabaseCommand } = require("./lib/database-access");
const { canonicalIdentity } = require("./audit-database");

const PROFILE_FIELDS = ["firstName", "lastName", "skinType", "concern", "shopifyCustomerId"];
const customerProjection = Object.fromEntries(["_id", "merchantId", "email", ...PROFILE_FIELDS].map((field) => [field, 1]));
const eventProjection = { _id: 0, merchantId: 1, customerId: 1, dedupeKey: 1, sourceEventId: 1 };
const idKey = (value) => value instanceof ObjectId ? value.toHexString() : null;

function summarizeCustomerDuplicates(customers, events) {
  const groups = new Map();
  const owners = new Map();
  let invalidCustomerRecords = 0;
  let customersWithoutEmail = 0;
  let nonCanonicalEmails = 0;
  for (const customer of customers) {
    const id = idKey(customer._id);
    const merchant = idKey(customer.merchantId);
    if (!id || !merchant) { invalidCustomerRecords += 1; continue; }
    owners.set(id, merchant);
    if (customer.email == null) { customersWithoutEmail += 1; continue; }
    const email = canonicalIdentity(customer.email, "customers");
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalidCustomerRecords += 1;
      continue;
    }
    if (customer.email !== email) nonCanonicalEmails += 1;
    const key = `${merchant}\0${email}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(customer);
  }
  const duplicates = [...groups.values()].filter((rows) => rows.length > 1);
  const duplicateIds = new Set(duplicates.flatMap((rows) => rows.map((row) => idKey(row._id))));
  const historyCounts = new Map();
  let invalidEventCustomerReferences = 0;
  let eventsReferencingDuplicateCustomers = 0;
  let keyedEventsReferencingDuplicateCustomers = 0;
  let keyedEventsWithoutSourceEventId = 0;
  for (const event of events) {
    const customer = idKey(event.customerId);
    const merchant = idKey(event.merchantId);
    if (!customer || !merchant || owners.get(customer) !== merchant) {
      invalidEventCustomerReferences += 1;
      continue;
    }
    if (duplicateIds.has(customer)) {
      historyCounts.set(customer, (historyCounts.get(customer) || 0) + 1);
      eventsReferencingDuplicateCustomers += 1;
      if (typeof event.dedupeKey === "string" && event.dedupeKey.trim()) {
        keyedEventsReferencingDuplicateCustomers += 1;
        if (typeof event.sourceEventId !== "string" || !event.sourceEventId.trim()) keyedEventsWithoutSourceEventId += 1;
      }
    }
  }
  const conflictingGroupsByField = Object.fromEntries(PROFILE_FIELDS.map((field) => [field, 0]));
  let groupsWithConflictingComparedFields = 0;
  let groupsWithHistoryOnMultipleRecords = 0;
  let groupsWithoutEventHistory = 0;
  for (const rows of duplicates) {
    let conflict = false;
    for (const field of PROFILE_FIELDS) {
      const values = new Set(rows.map((row) => canonicalJson({
        present: Object.hasOwn(row, field), value: row[field] ?? null
      })));
      if (values.size > 1) { conflictingGroupsByField[field] += 1; conflict = true; }
    }
    if (conflict) groupsWithConflictingComparedFields += 1;
    const referenced = rows.filter((row) => historyCounts.has(idKey(row._id))).length;
    if (referenced > 1) groupsWithHistoryOnMultipleRecords += 1;
    if (referenced === 0) groupsWithoutEventHistory += 1;
  }
  const duplicateCustomerRecords = duplicateIds.size;
  return {
    version: 1, checkedAt: new Date().toISOString(), readOnly: true, databaseChanged: false,
    status: duplicates.length || invalidCustomerRecords || invalidEventCustomerReferences || nonCanonicalEmails ? "ACTION_REQUIRED" : "PASS",
    automaticMergeAllowed: false, backupRestoreVerified: false,
    scope: "Limited-field duplicate review, not a merge plan, complete customer equivalence check or backup verification. Reads are not a transactional snapshot.",
    customersScanned: customers.length, eventsScanned: events.length, comparedProfileFields: PROFILE_FIELDS,
    invalidCustomerRecords, customersWithoutEmail, nonCanonicalEmails, invalidEventCustomerReferences,
    duplicates: {
      groups: duplicates.length, customerRecords: duplicateCustomerRecords,
      extraCustomerRecords: duplicateCustomerRecords - duplicates.length,
      merchantsAffected: new Set(duplicates.map((rows) => idKey(rows[0].merchantId))).size,
      groupsWithMatchingComparedFields: duplicates.length - groupsWithConflictingComparedFields,
      groupsWithConflictingComparedFields, conflictingGroupsByField,
      customerRecordsWithEventHistory: historyCounts.size,
      customerRecordsWithoutEventHistory: duplicateCustomerRecords - historyCounts.size,
      eventsReferencingDuplicateCustomers, keyedEventsReferencingDuplicateCustomers, keyedEventsWithoutSourceEventId,
      groupsWithHistoryOnMultipleRecords, groupsWithoutEventHistory
    }
  };
}

async function scanCollection(db, name, projection, onStage) {
  const collection = db.collection(name);
  onStage("count_documents", name);
  const before = await collection.countDocuments({}, READ_OPTIONS);
  if (before > MAX_DOCUMENTS) throw new ReadinessError("DUPLICATE_REVIEW_SIZE_LIMIT", "A collection exceeds the 100000-document duplicate review limit.");
  onStage(name === "customers" ? "scan_identities" : "scan_references", name);
  const rows = await collection.find({}, { ...READ_OPTIONS, projection }).limit(MAX_DOCUMENTS + 1).toArray();
  if (rows.length > MAX_DOCUMENTS) throw new ReadinessError("DUPLICATE_REVIEW_SIZE_LIMIT", "Data grew beyond the duplicate review limit. Use a planned batched review.");
  onStage("count_documents", name);
  const after = await collection.countDocuments({}, READ_OPTIONS);
  if (rows.length !== before || rows.length !== after) {
    throw new ReadinessError("DATABASE_CHANGED", "Document counts changed during the review. Repeat during a quiet window.");
  }
  return rows;
}

async function reviewCustomerDuplicates(db, { onStage = () => {} } = {}) {
  onStage("list_collections");
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  if (!["customers", "events"].every((name) => existing.has(name))) {
    throw new ReadinessError("DUPLICATE_REVIEW_COLLECTION_MISSING", "The customer or event collection is missing. Confirm the target and run the integrity audit first.");
  }
  const customers = await scanCollection(db, "customers", customerProjection, onStage);
  const events = await scanCollection(db, "events", eventProjection, onStage);
  onStage("review_duplicates", "customers");
  return summarizeCustomerDuplicates(customers, events);
}

if (require.main === module) {
  runDatabaseCommand(reviewCustomerDuplicates, "Read-only duplicate review: npm run --silent db:review-customer-duplicates -- --database NAME [--env-file PATH]");
}

module.exports = { PROFILE_FIELDS, summarizeCustomerDuplicates, reviewCustomerDuplicates };
