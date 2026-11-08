const assert = require("node:assert/strict");
const { test, before, after, beforeEach, afterEach, mock } = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Merchant = require("../models/Merchant");

const originalSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = "isolated-profile-test-secret";
mongoose.set("bufferCommands", false);
const app = express();
app.use(express.json());
app.use("/api/merchants", require("../routes/merchantRoutes"));
app.use(require("../middleware/errorHandler"));
const firstId = "507f1f77bcf86cd799439011";
const secondId = "507f1f77bcf86cd799439012";
const token = jwt.sign({ id: firstId }, process.env.JWT_SECRET);
let server;
let base;
let records;
let writes;
let performWrite;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  records = new Map([firstId, secondId].map((_id, index) => [_id, new Merchant({
    _id, businessName: `Business ${index}`, ownerName: `Owner ${index}`, email: `owner${index}@example.com`,
    password: "test-only-password-hash", shopifyTokenCiphertext: "test-only-ciphertext", platformType: "shopify", subscriptionTier: "free"
  })]));
  records.get(firstId).set("futureServerSecret", "test-only-future-secret", { strict: false });
  writes = [];
  performWrite = (filter, update) => {
    const record = records.get(String(filter._id));
    if (record) record.set(update.$set);
    return record || null;
  };
  mock.method(console, "error", () => {});
  mock.method(mongoose, "connect", () => { throw new Error("No database access in HTTP unit tests"); });
  mock.method(Merchant, "findById", id => ({ select: async selection => {
    assert.equal(selection, "-password");
    return records.get(String(id)) || null;
  } }));
  mock.method(Merchant, "findOneAndUpdate", (filter, update, options) => {
    writes.push({ filter, update, options });
    return { select: async selection => {
      assert.equal(selection, "businessName ownerName email platformType subscriptionTier");
      return performWrite(filter, update);
    } };
  });
});
afterEach(() => mock.restoreAll());
after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

async function request({ method = "PATCH", body, auth = token, query = "" } = {}) {
  const response = await fetch(`${base}/api/merchants/profile${query}`, {
    method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("profile reads and writes require a valid merchant session and never attempt unauthenticated writes", async () => {
  for (const method of ["GET", "PATCH"]) for (const auth of [null, "invalid-test-token"]) {
    const result = await request({ method, auth, ...(method === "PATCH" ? { body: { businessName: "Denied" } } : {}) });
    assert.equal(result.status, 401); assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.equal(writes.length, 0);
});

test("profile updates trim names, use only the authenticated ID, and keep the existing GET contract", async () => {
  const secondBefore = JSON.stringify(records.get(secondId));
  const result = await request({ body: { businessName: "  Éclat Skincare  ", ownerName: "  Tosin O'Neil  " }, query: `?merchantId=${secondId}` });
  assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(String(writes[0].filter._id), firstId);
  assert.deepEqual(Object.keys(writes[0].filter), ["_id"]);
  assert.deepEqual(writes[0].update, { $set: { businessName: "Éclat Skincare", ownerName: "Tosin O'Neil" } });
  assert.deepEqual(writes[0].options, { new: true, runValidators: true });
  assert.deepEqual(result.body, { message: "Business profile saved", merchant: {
    _id: firstId, businessName: "Éclat Skincare", ownerName: "Tosin O'Neil", email: "owner0@example.com", platformType: "shopify", subscriptionTier: "free"
  } });
  const reread = await request({ method: "GET" });
  assert.deepEqual(reread.body, { message: "Merchant profile loaded", merchant: result.body.merchant });
  assert.equal(JSON.stringify(records.get(secondId)), secondBefore);
  assert.equal(records.get(firstId).password, "test-only-password-hash");
  assert.equal(records.get(firstId).shopifyTokenCiphertext, "test-only-ciphertext");
  assert.doesNotMatch(JSON.stringify(result.body) + JSON.stringify(reread.body), /password|Ciphertext|futureServerSecret|test-only-/);
});

test("partial update preserves the other name and accepts documented maximum lengths", async () => {
  const result = await request({ body: { businessName: "B".repeat(120) } });
  assert.equal(result.status, 200); assert.equal(result.body.merchant.ownerName, "Owner 0");
  const owner = await request({ body: { ownerName: "O".repeat(100) } });
  assert.equal(owner.status, 200); assert.equal(owner.body.merchant.businessName.length, 120);
});

test("forbidden fields and update operators reject the whole request before any write", async () => {
  for (const field of ["_id", "merchantId", "email", "password", "platformType", "subscriptionTier", "shopifyAccessToken", "shopifyTokenCiphertext", "shopifyStoreDomain", "logoDataUrl", "$set", "__proto__", "constructor"]) {
    const body = { businessName: "Must not be saved", [field]: "forbidden" };
    assert.equal((await request({ body })).status, 400, field);
  }
  assert.equal(writes.length, 0); assert.equal(records.get(firstId).businessName, "Business 0");
});

test("missing, empty, non-string, overlong and control-character names are rejected without coercion or partial writes", async () => {
  for (const body of [undefined, {}, [], ["name"], { businessName: "" }, { businessName: " \t " }, { ownerName: null },
    { businessName: 123 }, { businessName: { $ne: "" } }, { businessName: "B".repeat(121) }, { ownerName: "O".repeat(101) },
    { businessName: "Acme\nStore" }, { ownerName: "Test\u0000Owner" }, { businessName: "Valid", ownerName: "" }]) {
    assert.equal((await request({ body })).status, 400, JSON.stringify(body));
  }
  assert.equal(writes.length, 0);
});

test("a deleted merchant between authentication and update returns a controlled 404", async () => {
  performWrite = () => null;
  const result = await request({ body: { ownerName: "New owner" } });
  assert.equal(result.status, 404); assert.match(result.body.message, /sign in again/);
});

test("a write acknowledgement failure reports an unconfirmed save, never raw database details", async () => {
  performWrite = () => { throw new Error("private database connection and customer data"); };
  const result = await request({ body: { ownerName: "New owner" } });
  assert.equal(result.status, 503); assert.match(result.body.message, /could not confirm.*Reload/);
  assert.doesNotMatch(JSON.stringify(result.body), /private database|customer data/);
  assert.doesNotMatch(String(console.error.mock.calls[0].arguments[1]), /private database|customer data/);
});
