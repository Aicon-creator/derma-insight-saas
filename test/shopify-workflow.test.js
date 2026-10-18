const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test, before, after, beforeEach, afterEach, mock } = require("node:test");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Merchant = require("../models/Merchant");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");
const ShopifyOrder = require("../models/ShopifyOrder");
const service = require("../services/shopifyService");
const syncService = require("../services/shopifySync");
const app = require("../server");
const nativeFetch = global.fetch.bind(global);
const owner = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
const other = new mongoose.Types.ObjectId("507f1f77bcf86cd799439012");
const shop = "test-store.myshopify.com";
const secret = "isolated-workflow-client-secret";
const encryptionKey = Buffer.alloc(32, 4);
const environment = ["NODE_ENV", "JWT_SECRET", "SHOPIFY_ENABLED", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_TOKEN_ENCRYPTION_KEY", "SHOPIFY_REDIRECT_URI", "SHOPIFY_SCOPES", "SHOPIFY_INCLUDE_TEST_ORDERS"];
const previous = Object.fromEntries(environment.map(key => [key, process.env[key]]));
let server, base, stores, upstream, unexpectedWire, fixture, failEvent, upstreamHandler;

const clone = value => value instanceof Date ? new Date(value) : value instanceof mongoose.Types.ObjectId ? new mongoose.Types.ObjectId(value.toHexString()) :
  Array.isArray(value) ? value.map(clone) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
const equal = (a, b) => String(a ?? "") === String(b ?? "");
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$and") return expected.every(part => matches(row, part));
    if (key === "$or") return expected.some(part => matches(row, part));
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !(expected instanceof mongoose.Types.ObjectId)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === "$exists") return (row[key] !== undefined) === value;
        if (op === "$gt") return row[key] > value;
        if (op === "$gte") return row[key] >= value;
        if (op === "$lte") return row[key] <= value;
        if (op === "$nin") return !value.some(item => equal(row[key], item));
        if (op === "$in") return value.some(item => equal(row[key], item));
        if (op === "$ne") return !equal(row[key], value);
        throw new Error(`Unsupported fixture operator ${op}`);
      });
    }
    return equal(row[key], expected);
  });
}

function query(work) {
  return { select() { return this; }, session() { return this; }, limit() { return this; },
    lean() { return Promise.resolve().then(work); }, then(resolve, reject) { return Promise.resolve().then(work).then(resolve, reject); } };
}

function apply(row, update, inserted) {
  Object.assign(row, clone(inserted ? update.$setOnInsert || {} : {}), clone(update.$set || {}));
  for (const key of Object.keys(update.$unset || {})) delete row[key];
  for (const [key, value] of Object.entries(update.$max || {})) if (row[key] == null || row[key] < value) row[key] = clone(value);
}

function updateRows(name, filter, update, options = {}) {
  const rows = stores[name];
  let row = rows.find(item => matches(item, filter));
  const inserted = !row;
  if (!row && !options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, row: null };
  if (!row) {
    row = { _id: new mongoose.Types.ObjectId() };
    Object.assign(row, Object.fromEntries(Object.entries(filter).filter(([key, value]) => !key.startsWith("$") &&
      (value === null || typeof value !== "object" || value instanceof mongoose.Types.ObjectId))));
    rows.push(row);
  }
  const old = JSON.stringify(row);
  apply(row, update, inserted);
  return { matchedCount: inserted ? 0 : 1, modifiedCount: !inserted && old !== JSON.stringify(row) ? 1 : 0,
    upsertedCount: inserted ? 1 : 0, row: clone(row) };
}

function order(id = 1, options = {}) {
  return { id: `gid://shopify/Order/${id}`, createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date(Date.now() - 1000).toISOString(), cancelledAt: null, test: false, displayFinancialStatus: "PAID",
    customer: { id: "gid://shopify/Customer/1" }, lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { id: `gid://shopify/LineItem/${id}`, quantity: 2, currentQuantity: 2, product: { id: "gid://shopify/Product/1" },
        priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: "19.99", currencyCode: "GBP" } } }
    ] }, ...options };
}

function tokenResponse() { return { access_token: "isolated-access-token", refresh_token: "isolated-refresh-token",
  scope: "read_customers,read_products,read_orders", expires_in: 86400, refresh_token_expires_in: 7776000 }; }

function connected(id = owner) {
  const merchant = stores.Merchant.find(row => equal(row._id, id));
  const tokens = { accessToken: "isolated-access-token", refreshToken: "isolated-refresh-token", expiresAt: Date.now() + 86400000 };
  Object.assign(merchant, { shopifyStoreDomain: shop, shopifyConnectionState: "connected",
    shopifyTokenCiphertext: service.sealTokens(tokens, id, shop, encryptionKey) });
  return merchant;
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: "production", JWT_SECRET: "isolated-workflow-jwt-secret", SHOPIFY_ENABLED: "true",
    SHOPIFY_API_KEY: "isolated-client-id", SHOPIFY_API_SECRET: secret, SHOPIFY_TOKEN_ENCRYPTION_KEY: encryptionKey.toString("base64"),
    SHOPIFY_REDIRECT_URI: "https://example.com/api/shopify/callback", SHOPIFY_SCOPES: "read_customers,read_products,read_orders", SHOPIFY_INCLUDE_TEST_ORDERS: "false" });
  stores = { Merchant: [owner, other].map(_id => ({ _id, shopifyStoreDomain: null, shopifyConnectionState: "disconnected" })),
    Customer: [], Product: [], Event: [], ShopifyOrder: [] };
  fixture = { customers: [{ id: "gid://shopify/Customer/1", firstName: "Ada", lastName: "Stone", email: " ADA@EXAMPLE.COM " }],
    products: [{ id: "gid://shopify/Product/1", title: "Serum", handle: "serum", vendor: "Test Brand", productType: "serum", status: "ACTIVE",
      priceRangeV2: { minVariantPrice: { amount: "15.00", currencyCode: "GBP" } }, featuredImage: null }], orders: [order()] };
  unexpectedWire = 0; upstream = []; failEvent = null; upstreamHandler = null;
  mock.method(mongoose, "connect", () => { unexpectedWire += 1; throw new Error("No database connection is allowed"); });
  mock.method(console, "error", () => { throw new Error("Private database/upstream errors must not be logged"); });
  mock.method(syncService, "assertDatabaseReady", async () => {});
  for (const [name, model] of Object.entries({ Merchant, Customer, Product, Event, ShopifyOrder })) {
    mock.method(model, "findById", id => query(() => clone(stores[name].find(row => equal(row._id, id)) || null)));
    mock.method(model, "findOne", filter => query(() => clone(stores[name].find(row => matches(row, filter)) || null)));
    mock.method(model, "find", filter => query(() => clone(stores[name].filter(row => matches(row, filter)))));
    mock.method(model, "findOneAndUpdate", (filter, update, options) => query(() => updateRows(name, filter, update, options).row));
    mock.method(model, "updateOne", async (filter, update, options) => {
      if (name === "Event" && failEvent?.(filter, update)) throw new Error("private-token mongodb://private:secret@host/database");
      return updateRows(name, filter, update, options);
    });
    mock.method(model, "updateMany", async (filter, update) => {
      let count = 0; for (const row of stores[name].filter(row => matches(row, filter))) { apply(row, update, false); count += 1; }
      return { matchedCount: count };
    });
    mock.method(model, "deleteMany", async filter => {
      assert.equal(name, "Event"); assert.equal(filter.source, "shopify");
      assert.ok(filter.merchantId && filter.shopifyStoreDomain && filter.shopifyOrderId && filter.dedupeKey.$nin);
      const old = stores[name].length; stores[name] = stores[name].filter(row => !matches(row, filter)); return { deletedCount: old - stores[name].length };
    });
  }
  mock.method(mongoose.connection, "transaction", async work => {
    const snapshot = clone(stores);
    try { return await work({ fixtureSession: true }); } catch (error) { stores = snapshot; throw error; }
  });
  mock.method(global, "fetch", async (url, options) => {
    assert.equal(new URL(url).hostname, shop, "Every outbound request must target the authorized store");
    upstream.push({ url, options });
    if (upstreamHandler) { const result = await upstreamHandler(url, options); if (result) return result; }
    if (url.endsWith("/oauth/access_token")) return new Response(JSON.stringify(tokenResponse()));
    const request = JSON.parse(options.body);
    const connection = nodes => ({ nodes: clone(nodes), pageInfo: { hasNextPage: false, endCursor: null } });
    let data;
    if (request.query.includes("ShopCurrency")) data = { shop: { currencyCode: "GBP" } };
    else if (request.query.includes("query Customers")) data = { customers: connection(fixture.customers) };
    else if (request.query.includes("query Products")) data = { products: connection(fixture.products) };
    else if (request.query.includes("query Orders")) data = { orders: connection(fixture.orders) };
    else throw new Error("Unexpected query in workflow fixture");
    return new Response(JSON.stringify({ data }));
  });
});

afterEach(() => { assert.equal(unexpectedWire, 0); mock.restoreAll(); });
after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

async function request(path, { method = "GET", id = owner, authenticated = true, headers = {}, body } = {}) {
  const response = await nativeFetch(base + path, { method, redirect: "manual", headers: {
    ...(authenticated ? { Authorization: `Bearer ${jwt.sign({ id: String(id) }, process.env.JWT_SECRET)}` } : {}), ...headers
  }, body });
  const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  return { status: response.status, headers: response.headers, body: data };
}

async function begin(id = owner) {
  const start = await request(`/api/shopify/connect?shop=${shop}&merchantId=${other}`, { id });
  assert.equal(start.status, 200);
  const auth = new URL(start.body.authorizeUrl);
  const state = auth.searchParams.get("state");
  const params = { code: "isolated-code", shop, state, timestamp: String(Math.floor(Date.now() / 1000)) };
  const hmac = crypto.createHmac("sha256", secret).update(Object.keys(params).sort().map(key => `${key}=${params[key]}`).join("&")).digest("hex");
  return { state, callback: `/api/shopify/callback?${new URLSearchParams({ ...params, hmac })}`,
    cookie: start.headers.get("set-cookie").split(";")[0], start };
}

test("configured endpoints still require merchant authentication", async () => {
  for (const [path, method] of [["/status", "GET"], ["/connect?shop=test-store", "GET"], ["/sync", "POST"], ["/disconnect", "POST"]]) {
    assert.equal((await request(`/api/shopify${path}`, { method, authenticated: false })).status, 401);
  }
  assert.equal(upstream.length, 0);
});

test("OAuth connects only the initiating merchant, encrypts tokens and rejects callback replay", async () => {
  const start = await begin();
  assert.match(start.start.headers.get("set-cookie"), /HttpOnly/); assert.match(start.start.headers.get("set-cookie"), /Secure/);
  assert.match(start.start.headers.get("set-cookie"), /SameSite=Lax/);
  assert.notEqual(stores.Merchant[0].shopifyPendingStateHash, start.state);
  const callback = await request(start.callback, { authenticated: false, headers: { Cookie: start.cookie } });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/settings.html?shopify=connected#shopify-connection");
  assert.equal(stores.Merchant[0].shopifyConnectionState, "connected");
  assert.equal(stores.Merchant[1].shopifyConnectionState, "disconnected");
  assert.doesNotMatch(stores.Merchant[0].shopifyTokenCiphertext, /isolated-access|isolated-refresh/);
  assert.equal(stores.Merchant[0].shopifyLeaseId, undefined);
  assert.equal((await request(start.callback, { authenticated: false, headers: { Cookie: start.cookie } })).status, 409);
  assert.equal(upstream.length, 1);
});

test("bad signatures, missing browser proof and expired nonces never exchange a code", async () => {
  const start = await begin();
  assert.equal((await request(start.callback.replace("isolated-code", "tampered"), { authenticated: false, headers: { Cookie: start.cookie } })).status, 403);
  assert.equal((await request(start.callback, { authenticated: false })).status, 403);
  stores.Merchant[0].shopifyPendingExpiresAt = new Date(0);
  assert.equal((await request(start.callback, { authenticated: false, headers: { Cookie: start.cookie } })).status, 409);
  assert.equal(upstream.length, 0);
});

test("status returns an allowlist without ciphertext, nonce, lease IDs or future summary secrets", async () => {
  const merchant = connected(); merchant.shopifyPendingStateHash = "private-nonce";
  merchant.shopifyLastSyncSummary = { ordersProcessed: 2, accessToken: "private-token" };
  const response = await request("/api/shopify/status");
  assert.equal(response.status, 200); assert.equal(response.body.connected, true);
  assert.deepEqual(response.body.summary, { ordersProcessed: 2 });
  assert.doesNotMatch(JSON.stringify(response.body), /private-|v1\.|Ciphertext|PendingState|LeaseId/);
});

test("sync imports discounted line amounts, preserves CSV profile details and replays without duplicate Events", async () => {
  connected();
  const customerId = new mongoose.Types.ObjectId();
  stores.Customer.push({ _id: customerId, merchantId: owner, email: "ada@example.com", skinType: "dry", concern: "hydration" });
  const first = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.summary.purchasesImported, 1);
  assert.equal(stores.Customer.length, 1); assert.equal(stores.Customer[0].skinType, "dry");
  assert.equal(stores.Event[0].customerId.toString(), customerId.toString());
  assert.equal(stores.Event[0].price * stores.Event[0].quantity, 19.99);
  assert.equal(stores.Product[0].price, 15, "Catalog price stays separate from discounted sold price");
  const eventId = stores.Event[0]._id.toString();
  const again = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.summary.purchasesImported, 0); assert.equal(again.body.summary.purchasesUnchanged, 1);
  assert.equal(stores.Event.length, 1); assert.equal(stores.Event[0]._id.toString(), eventId);
  assert.equal(stores.ShopifyOrder.length, 1);
  assert.equal(stores.Merchant[0].shopifyLastSyncStatus, "complete");
});

test("guest and deleted-product purchases retain revenue without invented customer/product profiles", async () => {
  connected(); fixture.orders[0].customer = null; fixture.orders[0].lineItems.nodes[0].product = null;
  const response = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.summary.guestPurchaseLines, 1); assert.equal(response.body.summary.unknownProductLines, 1);
  assert.equal(stores.Event[0].customerId, null); assert.equal(stores.Event[0].productId, null);
  assert.equal(stores.Event[0].price * stores.Event[0].quantity, 19.99);
  assert.equal(stores.Customer.length, 1); assert.equal(stores.Customer[0].skinType, null);
});

test("refunds update the same Event and cancellations retire only this source order after snapshot persistence", async () => {
  connected(); await request("/api/shopify/sync", { method: "POST" });
  const id = String(stores.Event[0]._id);
  stores.Event.push({ _id: new mongoose.Types.ObjectId(), merchantId: other, source: "shopify", shopifyStoreDomain: shop,
    shopifyOrderId: "gid://shopify/Order/1", dedupeKey: "other-key", type: "purchase", price: 100, quantity: 1 });
  stores.Event.push({ _id: new mongoose.Types.ObjectId(), merchantId: owner, source: "csv", type: "view" });
  fixture.orders[0].displayFinancialStatus = "PARTIALLY_REFUNDED";
  fixture.orders[0].lineItems.nodes[0].currentQuantity = 1;
  fixture.orders[0].lineItems.nodes[0].priceAfterAllDiscountsBeforeTaxesSet.shopMoney.amount = "9.99";
  const refund = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(refund.status, 200); assert.equal(refund.body.summary.purchasesUpdated, 1);
  assert.equal(String(stores.Event[0]._id), id); assert.equal(stores.Event[0].price, 9.99);
  fixture.orders[0].cancelledAt = new Date().toISOString();
  const cancelled = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.summary.purchasesRetired, 1);
  assert.equal(stores.Event.length, 2); assert.ok(stores.Event.some(event => event.source === "csv"));
  assert.equal(stores.ShopifyOrder[0].cancelled, true);
});

test("unknown transaction errors roll back that order, report confirmed earlier progress, release the lease and support safe retry", async () => {
  connected(); fixture.orders.push(order(2));
  failEvent = (filter, update) => update.$set.shopifyOrderId === "gid://shopify/Order/2";
  const response = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(response.status, 503); assert.equal(response.body.complete, false);
  assert.equal(response.body.summary.ordersProcessed, 1);
  assert.equal(stores.Event.length, 1); assert.equal(stores.ShopifyOrder.length, 1);
  assert.equal(stores.Merchant[0].shopifyLeaseId, undefined);
  assert.equal(stores.Merchant[0].shopifyLastSyncStatus, "failed");
  assert.doesNotMatch(JSON.stringify(response.body), /private|mongodb|secret/);
  failEvent = null;
  const retry = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(retry.status, 200); assert.equal(retry.body.summary.purchasesUnchanged, 1);
  assert.equal(retry.body.summary.purchasesImported, 1); assert.equal(stores.Event.length, 2);
});

test("a second sync and disconnect cannot race an active sync", async () => {
  connected(); let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  upstreamHandler = async (url, options) => { if (JSON.parse(options.body).query.includes("ShopCurrency")) { reached(); await gate; } };
  const first = request("/api/shopify/sync", { method: "POST" });
  await entered;
  assert.equal((await request("/api/shopify/sync", { method: "POST" })).status, 409);
  assert.equal((await request("/api/shopify/disconnect", { method: "POST" })).status, 409);
  assert.equal((await request("/api/shopify/status")).body.syncStatus, "running");
  release(); assert.equal((await first).status, 200); assert.equal(stores.Event.length, 1);
});

test("a different merchant never reads or syncs another merchant's connection", async () => {
  connected();
  const result = await request(`/api/shopify/sync?merchantId=${owner}`, { method: "POST", id: other });
  assert.equal(result.status, 409); assert.equal(upstream.length, 0);
  const status = await request("/api/shopify/status", { id: other });
  assert.equal(status.body.shop, null); assert.equal(status.body.connected, false);
});

test("expiring offline tokens are refreshed under the sync lease and stored encrypted", async () => {
  const merchant = connected();
  merchant.shopifyTokenCiphertext = service.sealTokens({ accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() - 1 }, owner, shop, encryptionKey);
  const response = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const tokenCall = upstream.find(call => call.url.endsWith("/oauth/access_token"));
  assert.equal(tokenCall.options.body.get("grant_type"), "refresh_token");
  assert.equal(service.openTokens(stores.Merchant[0].shopifyTokenCiphertext, owner, shop, encryptionKey).accessToken, "isolated-access-token");
});

test("ambiguous identities and non-GBP stores fail before import writes", async () => {
  connected();
  stores.Customer.push(...[1, 2].map(() => ({ _id: new mongoose.Types.ObjectId(), merchantId: owner, email: "ada@example.com" })));
  const duplicate = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(duplicate.status, 409); assert.equal(stores.Event.length, 0); assert.equal(stores.Product.length, 0);
  upstreamHandler = async () => new Response(JSON.stringify({ data: { shop: { currencyCode: "USD" } } }));
  const foreignCurrency = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(foreignCurrency.status, 422); assert.equal(stores.Event.length, 0);
});

test("test and unpaid orders do not silently contribute revenue", async () => {
  connected(); fixture.orders = [order(1, { test: true }), order(2, { displayFinancialStatus: "PENDING" })];
  const response = await request("/api/shopify/sync", { method: "POST" });
  assert.equal(response.status, 200); assert.equal(stores.Event.length, 0);
  assert.equal(response.body.summary.excludedTestOrders, 1); assert.equal(response.body.summary.excludedUnpaidOrCancelledOrders, 1);
});

test("disconnect destroys saved credentials while retaining imported records and the original store pin", async () => {
  connected(); await request("/api/shopify/sync", { method: "POST" });
  process.env.SHOPIFY_ENABLED = "false";
  const response = await request("/api/shopify/disconnect", { method: "POST" });
  assert.equal(response.status, 200); assert.equal(stores.Event.length, 1);
  assert.equal(stores.Merchant[0].shopifyTokenCiphertext, undefined);
  assert.equal(stores.Merchant[0].shopifyStoreDomain, shop);
});

test("uninstall webhooks verify raw bytes before clearing matching store credentials", async () => {
  connected(); const body = JSON.stringify({ myshopify_domain: shop });
  const headers = { "Content-Type": "application/json", "X-Shopify-Shop-Domain": shop, "X-Shopify-Topic": "app/uninstalled",
    "X-Shopify-Hmac-Sha256": "forged" };
  assert.equal((await request("/api/shopify/webhooks/app-uninstalled", { method: "POST", authenticated: false, headers, body })).status, 401);
  assert.equal(stores.Merchant[0].shopifyConnectionState, "connected");
  headers["X-Shopify-Hmac-Sha256"] = crypto.createHmac("sha256", secret).update(body).digest("base64");
  assert.equal((await request("/api/shopify/webhooks/app-uninstalled", { method: "POST", authenticated: false, headers, body })).status, 200);
  assert.equal(stores.Merchant[0].shopifyConnectionState, "disconnected");
  assert.equal(stores.Merchant[0].shopifyTokenCiphertext, undefined);
});
