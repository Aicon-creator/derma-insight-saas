const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ObjectId, MAX_DOCUMENTS, canonicalJson } = require("../scripts/lib/database-access");
const { summarizeCustomerDuplicates, reviewCustomerDuplicates } = require("../scripts/review-customer-duplicates");

const merchant = new ObjectId("507f1f77bcf86cd799439011");
const otherMerchant = new ObjectId("507f1f77bcf86cd799439012");
const customer = (owner = merchant, fields = {}) => ({ _id: new ObjectId(), merchantId: owner,
  email: "private-email@example.com", firstName: "private-first-name", lastName: "private-last-name",
  skinType: "dry", concern: "hydration", ...fields });
const event = (row, owner = row.merchantId) => ({ customerId: new ObjectId(row._id.toHexString()), merchantId: owner });

test("duplicate review scopes identities by merchant and counts history on each duplicate record", () => {
  const rows = [customer(), customer(), customer(), customer(otherMerchant), customer(merchant, { email: "different@example.com" })];
  const events = [event(rows[1]), event(rows[1]), event(rows[2]), event(rows[3]), event(rows[4]), event(rows[0], otherMerchant)];
  const before = canonicalJson({ rows, events });
  const report = summarizeCustomerDuplicates(rows, events);
  assert.equal(report.status, "ACTION_REQUIRED");
  assert.equal(report.readOnly, true);
  assert.equal(report.databaseChanged, false);
  assert.equal(report.automaticMergeAllowed, false);
  assert.equal(report.backupRestoreVerified, false);
  assert.equal(report.invalidEventCustomerReferences, 1);
  assert.deepEqual(report.duplicates, {
    groups: 1, customerRecords: 3, extraCustomerRecords: 2, merchantsAffected: 1,
    groupsWithMatchingComparedFields: 1, groupsWithConflictingComparedFields: 0,
    conflictingGroupsByField: { firstName: 0, lastName: 0, skinType: 0, concern: 0, shopifyCustomerId: 0 },
    customerRecordsWithEventHistory: 2, customerRecordsWithoutEventHistory: 1,
    eventsReferencingDuplicateCustomers: 3, keyedEventsReferencingDuplicateCustomers: 0, keyedEventsWithoutSourceEventId: 0,
    groupsWithHistoryOnMultipleRecords: 1, groupsWithoutEventHistory: 0
  });
  assert.equal(canonicalJson({ rows, events }), before, "The review must not modify its inputs");
  assert.doesNotMatch(JSON.stringify(report), /private-|different@example|507f1f77/);
});

test("profile conflicts are counted by group and field without revealing values", () => {
  const rows = [customer(), customer(merchant, { email: " PRIVATE-EMAIL@EXAMPLE.COM ",
    firstName: "private-other-name", skinType: "oily", shopifyCustomerId: "private-shopify-id" })];
  const report = summarizeCustomerDuplicates(rows, []);
  assert.equal(report.nonCanonicalEmails, 1);
  assert.equal(report.duplicates.groups, 1);
  assert.equal(report.duplicates.groupsWithMatchingComparedFields, 0);
  assert.equal(report.duplicates.groupsWithConflictingComparedFields, 1);
  assert.deepEqual(report.duplicates.conflictingGroupsByField, {
    firstName: 1, lastName: 0, skinType: 1, concern: 0, shopifyCustomerId: 1
  });
  assert.equal(report.duplicates.groupsWithoutEventHistory, 1);
  assert.doesNotMatch(JSON.stringify(report), /private-|PRIVATE-|507f1f77/);
});

test("matching compared fields do not authorize a merge or imply dates and unknown metadata match", () => {
  const rows = [customer(merchant, { lastSeenAt: new Date(0), customField: "private-a" }),
    customer(merchant, { lastSeenAt: new Date(), customField: "private-b" })];
  const report = summarizeCustomerDuplicates(rows, []);
  assert.equal(report.duplicates.groupsWithMatchingComparedFields, 1);
  assert.equal(report.automaticMergeAllowed, false);
  rows[0].shopifyCustomerId = null;
  assert.equal(summarizeCustomerDuplicates(rows, []).duplicates.conflictingGroupsByField.shopifyCustomerId, 1);
});

test("missing emails, invalid identities and ID-shaped reference strings are explicit", () => {
  const rows = [customer(), customer(merchant, { email: null }), customer(merchant, { email: "bad-address" }),
    customer(merchant, { _id: "invalid-id" })];
  const report = summarizeCustomerDuplicates(rows, [
    { customerId: rows[0]._id.toHexString(), merchantId: merchant },
    { customerId: new ObjectId(), merchantId: merchant }, event(rows[1])
  ]);
  assert.equal(report.customersWithoutEmail, 1);
  assert.equal(report.invalidCustomerRecords, 2);
  assert.equal(report.invalidEventCustomerReferences, 2);
  assert.equal(report.duplicates.groups, 0);
  assert.equal(report.status, "ACTION_REQUIRED");
});

test("a review with no duplicates is a limited pass with no backup or merge authorization", () => {
  const row = customer();
  const report = summarizeCustomerDuplicates([row, customer(otherMerchant)], [event(row)]);
  assert.equal(report.status, "PASS");
  assert.equal(report.duplicates.groups, 0);
  assert.equal(report.automaticMergeAllowed, false);
  assert.equal(report.backupRestoreVerified, false);
});

test("keyed Event history is flagged for replay review without printing or changing identities", () => {
  const rows = [customer(), customer()];
  const events = [
    { ...event(rows[0]), dedupeKey: "private-key-1" },
    { ...event(rows[1]), dedupeKey: "private-key-2", sourceEventId: "private-source-id" },
    event(rows[1])
  ];
  const before = canonicalJson(events);
  const report = summarizeCustomerDuplicates(rows, events);
  assert.equal(report.duplicates.eventsReferencingDuplicateCustomers, 3);
  assert.equal(report.duplicates.keyedEventsReferencingDuplicateCustomers, 2);
  assert.equal(report.duplicates.keyedEventsWithoutSourceEventId, 1);
  assert.equal(canonicalJson(events), before);
  assert.doesNotMatch(JSON.stringify(report), /private-key|private-source/);
});

function readOnlyDatabase(specification) {
  const scans = [];
  return {
    scans,
    listCollections() { return { toArray: async () => Object.keys(specification).map((name) => ({ name })) }; },
    collection(name) {
      const info = specification[name];
      let countReads = 0;
      return new Proxy({
        countDocuments: async () => info.counts?.[countReads++] ?? info.rows.length,
        find(query, options) {
          const scan = { name, query, options };
          scans.push(scan);
          return {
            limit(limit) { scan.limit = limit; return this; },
            async toArray() { return info.rows.slice(0, scan.limit).map((row) => Object.fromEntries(Object.entries(row)
              .filter(([field]) => options.projection[field] === 1))); }
          };
        }
      }, { get(target, key) {
        assert.ok(key in target, `Unexpected database operation: ${String(key)}`);
        return target[key];
      } });
    }
  };
}

test("database review uses two projected bounded scans and reads no credentials or amounts", async () => {
  const rows = [customer(), customer()];
  const events = [event(rows[1])];
  const db = readOnlyDatabase({ customers: { rows }, events: { rows: events } });
  const report = await reviewCustomerDuplicates(db);
  assert.equal(report.duplicates.groups, 1);
  assert.equal(report.duplicates.eventsReferencingDuplicateCustomers, 1);
  assert.equal(db.scans.length, 2);
  for (const scan of db.scans) {
    assert.equal(scan.limit, MAX_DOCUMENTS + 1);
    assert.equal(scan.options.maxTimeMS, 10000);
    assert.equal(scan.options.projection.password, undefined);
    assert.equal(scan.options.projection.shopifyAccessToken, undefined);
    assert.equal(scan.options.projection.price, undefined);
  }
});

test("missing collections and changed row counts cannot yield a duplicate review report", async () => {
  await assert.rejects(reviewCustomerDuplicates(readOnlyDatabase({})), { code: "DUPLICATE_REVIEW_COLLECTION_MISSING" });
  for (const counts of [[2, 1], [1, 2]]) {
    const db = readOnlyDatabase({ customers: { rows: [customer()], counts }, events: { rows: [] } });
    await assert.rejects(reviewCustomerDuplicates(db), { code: "DATABASE_CHANGED" });
  }
});

test("size and mid-scan growth limits reject incomplete reviews", async () => {
  const oversized = readOnlyDatabase({ customers: { rows: [], counts: [MAX_DOCUMENTS + 1] }, events: { rows: [] } });
  await assert.rejects(reviewCustomerDuplicates(oversized), { code: "DUPLICATE_REVIEW_SIZE_LIMIT" });
  assert.equal(oversized.scans.length, 0);
  const grown = readOnlyDatabase({ customers: { rows: Array(MAX_DOCUMENTS + 1).fill(customer()), counts: [0] }, events: { rows: [] } });
  await assert.rejects(reviewCustomerDuplicates(grown), { code: "DUPLICATE_REVIEW_SIZE_LIMIT" });
});
