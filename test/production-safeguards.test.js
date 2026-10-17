const assert = require("node:assert/strict");
const { test, before, after, beforeEach, afterEach, mock } = require("node:test");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const originalEnvironment = process.env.NODE_ENV;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "isolated-safeguard-test-secret";
mongoose.set("bufferCommands", false);

const app = require("../server");
const Merchant = require("../models/Merchant");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");
const nativeFetch = global.fetch.bind(global);
const merchantId = "507f1f77bcf86cd799439011";
const token = jwt.sign({ id: merchantId }, process.env.JWT_SECRET, { expiresIn: "1h" });
let server;
let baseUrl;
let databaseOperations;
let externalRequests;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  process.env.NODE_ENV = "production";
  databaseOperations = 0;
  externalRequests = 0;
  const rejectDatabaseAccess = () => {
    databaseOperations += 1;
    throw new Error("This test must not access a database");
  };

  mock.method(mongoose, "connect", rejectDatabaseAccess);
  mock.method(Merchant, "findById", rejectDatabaseAccess);
  for (const model of [Customer, Product, Event]) {
    mock.method(model, "deleteMany", rejectDatabaseAccess);
    mock.method(model, "insertMany", rejectDatabaseAccess);
  }
  mock.method(global, "fetch", () => {
    externalRequests += 1;
    throw new Error("This test must not call Shopify");
  });
});

afterEach(() => {
  assert.equal(databaseOperations, 0, "No database connection or data mutation is allowed");
  assert.equal(externalRequests, 0, "No Shopify token exchange or sync is allowed");
  mock.restoreAll();
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

async function request(path, { method = "GET", authenticated = false } = {}) {
  const response = await nativeFetch(`${baseUrl}${path}`, {
    method,
    headers: authenticated ? { Authorization: `Bearer ${token}` } : {}
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

for (const resource of ["customers", "products", "events"]) {
  for (const authenticated of [false, true]) {
    test(`production demo ${resource} is blocked ${authenticated ? "with" : "without"} a signed token`, async () => {
      const response = await request(`/api/sim/${resource}`, { method: "POST", authenticated });
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { message: "Demo data generation is unavailable in production." });
      assert.equal(response.headers.get("cache-control"), "no-store");
    });
  }
}

for (const [method, path] of [
  ["GET", "/api/shopify/connect?shop=test-shop"],
  ["GET", "/api/shopify/callback?shop=test-shop&code=callback-secret&state=callback-state"],
  ["POST", "/api/shopify/sync"]
]) {
  for (const authenticated of [false, true]) {
    test(`production Shopify ${method} ${path.split("?")[0]} is blocked ${authenticated ? "with" : "without"} a signed token`, async () => {
      const response = await request(path, { method, authenticated });
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, {
        message: "Shopify connections and sync are temporarily unavailable while we complete the secure integration."
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(JSON.stringify(response.body), /callback-secret|callback-state|test-shop/);
    });
  }
}

test("merchant profile returns only the public allowlist, even when the document contains credentials", async () => {
  const publicProfile = {
    _id: merchantId,
    businessName: "Test Merchant",
    ownerName: "Test Owner",
    email: "owner@example.com",
    platformType: "shopify",
    subscriptionTier: "free"
  };
  // A real Mongoose document also tests getters and ObjectId JSON serialization.
  const merchant = new Merchant({
    ...publicProfile,
    password: "test-password-hash",
    shopifyAccessToken: "test-shopify-token",
    shopifyStoreDomain: "test-shop.myshopify.com"
  });
  merchant.set("futureServerSecret", "test-future-secret", { strict: false });
  Merchant.findById.mock.restore();
  const lookup = mock.method(Merchant, "findById", (id) => {
    assert.equal(id, merchantId, "Profile must use the authenticated merchant");
    return { select: async (selection) => {
      assert.equal(selection, "-password");
      return merchant;
    } };
  });

  const response = await request("/api/merchants/profile", { authenticated: true });
  assert.equal(response.status, 200);
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(response.body, { message: "Merchant profile loaded", merchant: publicProfile });
  assert.doesNotMatch(JSON.stringify(response.body), /test-password|test-shopify|test-future|futureServerSecret/);
});

test("merchant profile still requires authentication", async () => {
  const response = await request("/api/merchants/profile");
  assert.equal(response.status, 401);
});

test("existing CSV endpoints remain protected and available behind merchant authentication", async () => {
  for (const path of ["/api/imports/csv/preview", "/api/imports/csv/import"]) {
    const response = await request(path, { method: "POST" });
    assert.equal(response.status, 401);
  }
});

test("development demo and Shopify routes still reach their existing authentication middleware", async () => {
  process.env.NODE_ENV = "development";
  for (const path of ["/api/sim/customers", "/api/sim/products", "/api/sim/events", "/api/shopify/sync"]) {
    const response = await request(path, { method: "POST" });
    assert.equal(response.status, 401);
  }
  assert.equal((await request("/api/shopify/connect?shop=test-shop")).status, 401);
});

test("production health endpoint remains available without authentication or a database connection", async () => {
  const response = await request("/api/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.environment, "production");
});
