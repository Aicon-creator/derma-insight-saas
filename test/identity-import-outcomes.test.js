const assert = require("node:assert/strict");
const { test, before, after, beforeEach, afterEach, mock } = require("node:test");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const originalEnvironment = process.env.NODE_ENV;
const originalSecret = process.env.JWT_SECRET;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "isolated-identity-import-test-secret";
mongoose.set("bufferCommands", false);
const app = require("../server");
const Merchant = require("../models/Merchant");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");
const nativeFetch = global.fetch.bind(global);
const merchantId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
const otherMerchantId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439012");
const configurations = [
  { type: "customers", model: Customer, field: "email", header: "email,first name,last name,skin type,concern",
    row: (identity) => `${identity},Ada,Stone,dry,hydration`, key: (n) => `person${n}@example.com` },
  { type: "products", model: Product, field: "handle", header: "name,category,price",
    row: (identity) => `${identity},serum,12.50`, key: (n) => `product-${n}` }
];
let server;
let baseUrl;
let stores;
let writes;
let loggedErrors;
let wire;
const keyFor = (owner, identity) => `${String(owner)}:${identity}`;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  stores = new Map(configurations.map(({ type }) => [type, new Map()]));
  writes = 0;
  loggedErrors = 0;
  wire = 0;
  const forbidWire = () => { wire += 1; throw new Error("A test attempted database/network access"); };
  mock.method(mongoose, "connect", forbidWire);
  mock.method(global, "fetch", forbidWire);
  mock.method(console, "error", () => { loggedErrors += 1; });
  mock.method(Merchant, "findById", (id) => ({ select: async () => ({ _id: new mongoose.Types.ObjectId(id) }) }));
  for (const config of configurations) {
    const store = stores.get(config.type);
    mock.method(config.model, "aggregate", async (pipeline) => {
      const owner = String(pipeline[0].$match.merchantId);
      const projection = pipeline[1].$project;
      assert.ok(projection.identity.$toLower.$trim.input.$convert, "Existing identities must be trimmed safely");
      const requested = pipeline[2].$match.identity.$in;
      return [...store.values()].filter((row) => String(row.merchantId) === owner)
        .map((row) => ({ identity: String(row[config.field] ?? "").trim().toLowerCase() }))
        .filter((row) => requested.includes(row.identity));
    });
    mock.method(config.model, "find", (query) => ({ lean: async () => [...store.values()].filter((row) =>
      String(row.merchantId) === String(query.merchantId) && query[config.field].$in.includes(row[config.field])) }));
    mock.method(config.model, "bulkWrite", async (operations, options) => {
      writes += 1;
      assert.equal(options.ordered, false);
      let upsertedCount = 0;
      let matchedCount = 0;
      for (const { updateOne: operation } of operations) {
        assert.equal(operation.timestamps, false);
        assert.deepEqual(Object.keys(operation.update), ["$setOnInsert"]);
        const key = keyFor(operation.filter.merchantId, operation.filter[config.field]);
        if (store.has(key)) matchedCount += 1;
        else { store.set(key, { ...operation.update.$setOnInsert }); upsertedCount += 1; }
      }
      return { upsertedCount, matchedCount };
    });
    for (const method of ["deleteMany", "insertMany", "create", "updateMany"]) mock.method(config.model, method, forbidWire);
    for (const method of ["bulkWrite", "createIndex"]) mock.method(config.model.collection, method, forbidWire);
  }
  for (const method of ["bulkWrite", "updateOne", "insertMany"]) mock.method(Event, method, forbidWire);
});

afterEach(() => {
  assert.equal(wire, 0, "Tests must not reach a database, alter indexes or call another service");
  assert.equal(loggedErrors, 0, "Raw write errors must not be logged");
  mock.restoreAll();
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
  if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
});

async function upload(config, identities, { owner = merchantId, endpoint = "import", rawCsv } = {}) {
  const body = new FormData();
  body.append("dataType", config.type);
  body.append("merchantId", String(otherMerchantId));
  body.append("file", new Blob([rawCsv ?? `${config.header}\n${identities.map(config.row).join("\n")}\n`], { type: "text/csv" }), "test.csv");
  const token = jwt.sign({ id: String(owner) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const response = await nativeFetch(`${baseUrl}/api/imports/csv/${endpoint}`, { method: "POST", body,
    headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() };
}

function counters(body) {
  const { importedCount, skippedCount, failedCount, unconfirmedCount } = body;
  return { importedCount, skippedCount, failedCount, unconfirmedCount };
}

function writeFailure(upsertedCount, matchedCount, writeErrors, code = writeErrors[0]?.code) {
  return Object.assign(new Error("private-email@example.com mongodb://reader:private-secret@private-host/database"), {
    code, writeErrors, result: { upsertedCount, matchedCount }
  });
}

for (const config of configurations) {
  test(`${config.type}: valid import, preview and replay retain their contracts`, async () => {
    const values = [config.key(1), config.key(2)];
    const preview = await upload(config, values, { endpoint: "preview" });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.totalRows, 2);
    assert.equal(writes, 0);
    const first = await upload(config, values);
    assert.equal(first.status, 200);
    assert.deepEqual(counters(first.body), { importedCount: 2, skippedCount: 0, failedCount: 0, unconfirmedCount: 0 });
    const before = [...stores.get(config.type).values()].map((row) => ({ ...row }));
    const again = await upload(config, values);
    assert.equal(again.status, 200);
    assert.deepEqual(counters(again.body), { importedCount: 0, skippedCount: 2, failedCount: 0, unconfirmedCount: 0 });
    assert.deepEqual([...stores.get(config.type).values()], before);
    assert.equal(writes, 1);
  });

  test(`${config.type}: trim/case matching skips legacy identities without overwriting profiles`, async () => {
    const legacy = { merchantId, [config.field]: ` ${config.key(1).toUpperCase()} `, firstName: "Original", title: "Original" };
    stores.get(config.type).set("legacy", legacy);
    const result = await upload(config, [config.key(1), config.key(2)]);
    assert.equal(result.status, 200);
    assert.equal(result.body.importedCount, 1);
    assert.equal(result.body.skippedCount, 1);
    assert.equal(stores.get(config.type).get("legacy"), legacy);
  });

  test(`${config.type}: same identity under another merchant remains allowed`, async () => {
    const first = await upload(config, [config.key(1)]);
    const second = await upload(config, [config.key(1)], { owner: otherMerchantId });
    assert.equal(first.body.importedCount, 1);
    assert.equal(second.body.importedCount, 1);
    assert.equal(stores.get(config.type).size, 2);
    assert.ok(stores.get(config.type).has(keyFor(merchantId, config.key(1))));
  });

  test(`${config.type}: confirmed duplicate race skips only the conflicting row and keeps other inserts`, async () => {
    config.model.bulkWrite.mock.restore();
    mock.method(config.model, "bulkWrite", async (operations) => {
      for (const { updateOne } of operations) stores.get(config.type).set(
        keyFor(updateOne.filter.merchantId, updateOne.filter[config.field]), { ...updateOne.update.$setOnInsert });
      throw writeFailure(1, 0, [{ index: 0, code: 11000 }]);
    });
    const result = await upload(config, [config.key(1), config.key(2)]);
    assert.equal(result.status, 200);
    assert.deepEqual(counters(result.body), { importedCount: 1, skippedCount: 1, failedCount: 0, unconfirmedCount: 0 });
  });

  test(`${config.type}: a duplicate error is not a skip without a matching same-merchant record`, async () => {
    stores.get(config.type).set("other", { merchantId: otherMerchantId, [config.field]: config.key(1) });
    config.model.bulkWrite.mock.restore();
    mock.method(config.model, "bulkWrite", async () => { throw writeFailure(0, 0, [{ index: 0, code: 11000 }]); });
    const result = await upload(config, [config.key(1)]);
    assert.equal(result.status, 503);
    assert.deepEqual(counters(result.body), { importedCount: 0, skippedCount: 0, failedCount: 1, unconfirmedCount: 0 });
    assert.equal(result.body.errors[0].row, 2);
    assert.doesNotMatch(JSON.stringify(result.body), /private-|mongodb:/);
  });

  test(`${config.type}: partial writes retain confirmed counts and original CSV row numbers`, async () => {
    stores.get(config.type).set("existing", { merchantId, [config.field]: config.key(0) });
    config.model.bulkWrite.mock.restore();
    mock.method(config.model, "bulkWrite", async () => { throw writeFailure(1, 0, [{ index: 1, code: 121 }]); });
    const result = await upload(config, [config.key(0), config.key(1), config.key(2)]);
    assert.equal(result.status, 503);
    assert.deepEqual(counters(result.body), { importedCount: 1, skippedCount: 1, failedCount: 1, unconfirmedCount: 0 });
    assert.equal(result.body.errors[0].row, 4);
    assert.doesNotMatch(JSON.stringify(result.body), /private-|mongodb:/);
  });

  test(`${config.type}: unknown network outcome is explicit and never reported as zero writes`, async () => {
    config.model.bulkWrite.mock.restore();
    mock.method(config.model, "bulkWrite", async () => { throw new Error("private-token private-email@example.com"); });
    const result = await upload(config, [config.key(1), config.key(2)]);
    assert.equal(result.status, 503);
    assert.equal(result.body.unconfirmedCount, 2);
    assert.match(result.body.message, /2 unconfirmed/);
    assert.doesNotMatch(JSON.stringify(result.body), /private-token|private-email/);
  });

  for (const outcome of ["unacknowledged", "write concern", "malformed error indices"]) {
    test(`${config.type}: ${outcome} cannot produce a successful import`, async () => {
      config.model.bulkWrite.mock.restore();
      mock.method(config.model, "bulkWrite", async () => {
        if (outcome === "unacknowledged") return { acknowledged: false, upsertedCount: 1, matchedCount: 0 };
        if (outcome === "write concern") throw writeFailure(1, 0, [], 64);
        throw writeFailure(0, 0, [{ index: 99, code: 11000 }]);
      });
      const result = await upload(config, [config.key(1)]);
      assert.equal(result.status, 503);
      assert.deepEqual(counters(result.body), { importedCount: 0, skippedCount: 0, failedCount: 0, unconfirmedCount: 1 });
      assert.doesNotMatch(JSON.stringify(result.body), /private-|mongodb:/);
    });
  }

  test(`${config.type}: a preflight read failure stops before writes and reports it safely`, async () => {
    config.model.aggregate.mock.restore();
    mock.method(config.model, "aggregate", async () => { throw new Error("private-email@example.com"); });
    const result = await upload(config, [config.key(1)]);
    assert.equal(result.status, 503);
    assert.equal(result.body.failedCount, 1);
    assert.equal(result.body.unconfirmedCount, 0);
    assert.match(result.body.message, /wrote no rows/);
    assert.equal(writes, 0);
    assert.doesNotMatch(JSON.stringify(result.body), /private-email/);
  });

  test(`${config.type}: matched upserts are counted as skips`, async () => {
    config.model.bulkWrite.mock.restore();
    mock.method(config.model, "bulkWrite", async () => ({ upsertedCount: 0, matchedCount: 1 }));
    const result = await upload(config, [config.key(1)]);
    assert.equal(result.status, 200);
    assert.deepEqual(counters(result.body), { importedCount: 0, skippedCount: 1, failedCount: 0, unconfirmedCount: 0 });
  });

  test(`${config.type}: invalid CSV still blocks the complete import before writes`, async () => {
    const result = await upload(config, [config.key(1), config.key(1)]);
    assert.equal(result.status, 400);
    assert.equal(result.body.importedCount, 0);
    assert.equal(writes, 0);
  });

  test(`${config.type}: real Mongoose casting keeps timestamps and defaults insert-only`, async () => {
    config.model.bulkWrite.mock.restore();
    config.model.collection.bulkWrite.mock.restore();
    let nativeCalls = 0;
    mock.method(config.model.collection, "bulkWrite", async (operations, options) => {
      nativeCalls += 1;
      assert.equal(options.ordered, false);
      const { filter, update } = operations[0].updateOne;
      assert.equal(String(filter.merchantId), String(merchantId));
      assert.deepEqual(Object.keys(update), ["$setOnInsert"]);
      assert.ok(update.$setOnInsert.createdAt instanceof Date);
      assert.ok(update.$setOnInsert.updatedAt instanceof Date);
      return { upsertedCount: 1, matchedCount: 0 };
    });
    const result = await upload(config, [config.key(1)]);
    assert.equal(result.status, 200);
    assert.equal(result.body.importedCount, 1);
    assert.equal(nativeCalls, 1);
  });

  test(`${config.type}: overlapping requests handle a simulated unique-index collision`, async () => {
    config.model.bulkWrite.mock.restore();
    let entered = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    mock.method(config.model, "bulkWrite", async (operations) => {
      if (++entered === 2) release();
      await barrier;
      let upsertedCount = 0;
      const writeErrors = [];
      operations.forEach(({ updateOne }, index) => {
        const key = keyFor(updateOne.filter.merchantId, updateOne.filter[config.field]);
        if (stores.get(config.type).has(key)) writeErrors.push({ index, code: 11000 });
        else { stores.get(config.type).set(key, { ...updateOne.update.$setOnInsert }); upsertedCount += 1; }
      });
      if (writeErrors.length) throw writeFailure(upsertedCount, 0, writeErrors);
      return { upsertedCount, matchedCount: 0 };
    });
    const results = await Promise.all([upload(config, [config.key(1), config.key(2)]), upload(config, [config.key(1), config.key(3)])]);
    assert.ok(results.every((result) => result.status === 200));
    assert.equal(results.reduce((count, result) => count + result.body.importedCount, 0), 3);
    assert.equal(results.reduce((count, result) => count + result.body.skippedCount, 0), 1);
    assert.equal(stores.get(config.type).size, 3);
  });
}

test("valid Event preview still resolves merchant-owned references using trimmed identities", async () => {
  Customer.aggregate.mock.restore();
  Product.aggregate.mock.restore();
  const customerId = new mongoose.Types.ObjectId();
  const productId = new mongoose.Types.ObjectId();
  mock.method(Customer, "aggregate", async (pipeline) => {
    assert.equal(String(pipeline[0].$match.merchantId), String(merchantId));
    assert.equal(pipeline[1].$project.normalizedEmail.$toLower.$trim.input.$convert.input, "$email");
    return [{ _id: "person@example.com", customerIds: [customerId] }];
  });
  mock.method(Product, "aggregate", async (pipeline) => {
    assert.equal(String(pipeline[0].$match.merchantId), String(merchantId));
    assert.equal(pipeline[1].$project.normalizedHandle.$toLower.$trim.input.$convert.input, "$handle");
    return [{ _id: "serum", productIds: [productId] }];
  });
  const time = new Date(Date.now() - 60000).toISOString();
  const result = await upload({ type: "events" }, [], { endpoint: "preview", rawCsv:
    `event type,customer email,product name,occurred at,amount\npurchase,person@example.com,serum,${time},10\n` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.errors, []);
  assert.equal(writes, 0);
});

test("Event CSV invalid calendar dates remain blocked with no writes", async () => {
  const config = { type: "events" };
  const result = await upload(config, [], { rawCsv:
    "event type,customer email,product name,occurred at,amount\npurchase,person@example.com,serum,2026-02-30T10:00:00Z,10\n" });
  assert.equal(result.status, 400);
  assert.ok(result.body.errors.some((error) => error.column === "occurred at"));
  assert.equal(writes, 0);
});
