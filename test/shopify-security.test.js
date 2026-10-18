const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test, beforeEach, afterEach, mock } = require("node:test");
const mongoose = require("mongoose");
const service = require("../services/shopifyService");
const sync = require("../services/shopifySync");
const { initializePilotDatabase } = require("../scripts/initialize-pilot-database");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");
const { countInvalidReferences } = require("../scripts/audit-database");
const key = Buffer.alloc(32, 7);
const secret = "isolated-shopify-test-secret";
const shop = "example-shop.myshopify.com";
const scopes = service.REQUIRED_SCOPES;
const config = { clientId: "test-client", clientSecret: secret, encryptionKey: key,
  scopes, version: "2026-07", redirectUri: "https://example.com/api/shopify/callback" };

function signedCallback(extra = {}) {
  const data = { code: "test-code", host: "YWRtaW4uc2hvcGlmeS5jb20=", shop,
    state: "a".repeat(64), timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  const message = Object.keys(data).sort().map(key => `${key}=${data[key]}`).join("&");
  const hmac = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return `/api/shopify/callback?${new URLSearchParams({ ...data, hmac })}`;
}

beforeEach(() => { mock.method(mongoose, "connect", () => { throw new Error("No database access is permitted"); }); });
afterEach(() => mock.restoreAll());

test("store normalization accepts only a canonical Shopify host, slug or HTTPS address", () => {
  for (const input of [shop, "example-shop", " HTTPS://EXAMPLE-SHOP.myshopify.com/ "]) assert.equal(service.normalizeShop(input), shop);
  for (const input of [undefined, [], {}, "localhost", "127.0.0.1", "http://example-shop.myshopify.com", "https://evil.test/", "example-shop.myshopify.com.evil.test", "https://user:pass@example-shop.myshopify.com", "https://example-shop.myshopify.com:8443/", "https://example-shop.myshopify.com/path", "https://example-shop.myshopify.com/?x=1", "-shop", "shop-", "shop\n.evil.test", "https://example-shop.myshopify.com/#x"]) {
    if (input === "localhost") assert.equal(service.normalizeShop(input), "localhost.myshopify.com");
    else assert.throws(() => service.normalizeShop(input));
  }
});

test("OAuth verifies the exact signed query including host, timestamp and state", () => {
  assert.equal(service.validateCallback(signedCallback(), secret).shop, shop);
  for (const url of [signedCallback().replace("test-code", "other-code"), signedCallback({ timestamp: "0" }),
    signedCallback({ timestamp: String(Math.floor(Date.now() / 1000) + 120) }), signedCallback({ state: "bad" }),
    signedCallback({ shop: "evil.test" }), signedCallback() + "&shop=other.myshopify.com", signedCallback().replace(/hmac=[^&]+/, "hmac=bad")]) {
    assert.throws(() => service.validateCallback(url, secret));
  }
});

test("encrypted offline tokens are bound to their merchant and store and reject tampering", () => {
  const tokens = { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 100000 };
  const sealed = service.sealTokens(tokens, "merchant-a", shop, key);
  assert.doesNotMatch(sealed, /test-access|test-refresh/);
  assert.deepEqual(service.openTokens(sealed, "merchant-a", shop, key), tokens);
  assert.throws(() => service.openTokens(sealed, "merchant-b", shop, key));
  assert.throws(() => service.openTokens(sealed, "merchant-a", "another.myshopify.com", key));
  assert.throws(() => service.openTokens(sealed.slice(0, -5) + "AAAAA", "merchant-a", shop, key));
  for (const malformed of [{}, { ...tokens, expiresAt: "invalid" }, { ...tokens, refreshToken: "" }]) {
    assert.throws(() => service.openTokens(service.sealTokens(malformed, "merchant-a", shop, key), "merchant-a", shop, key));
  }
});

test("offline token grants require scopes, expiry and a refresh token", () => {
  const data = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 86400, refresh_token_expires_in: 7776000, scope: scopes.join(",") };
  assert.equal(service.parseTokenResponse(data, scopes, 1000).expiresAt, 86401000);
  assert.equal(service.parseTokenResponse({ ...data, scope: "write_customers,write_products,write_orders" }, scopes).scopes.length, 3);
  for (const bad of [{ ...data, scope: "read_products" }, { ...data, refresh_token: null }, { ...data, expires_in: 0 }, { ...data, access_token: "" }]) assert.throws(() => service.parseTokenResponse(bad, scopes));
});

test("configuration needs an explicit flag, independent encryption key and a safe callback", () => {
  const values = { SHOPIFY_ENABLED: "true", SHOPIFY_API_KEY: "test-id", SHOPIFY_API_SECRET: secret,
    SHOPIFY_TOKEN_ENCRYPTION_KEY: key.toString("base64"), SHOPIFY_REDIRECT_URI: config.redirectUri,
    SHOPIFY_SCOPES: scopes.join(","), NODE_ENV: "production" };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, values);
    assert.equal(service.getShopifyConfig().configured, true);
    for (const [field, value] of [["SHOPIFY_ENABLED", "false"], ["SHOPIFY_TOKEN_ENCRYPTION_KEY", "short"],
      ["SHOPIFY_REDIRECT_URI", "http://example.com/api/shopify/callback"], ["SHOPIFY_REDIRECT_URI", "https://example.com/other"],
      ["SHOPIFY_REDIRECT_URI", "https://example.com/api/shopify/callback?return=evil"], ["SHOPIFY_SCOPES", "read_products"]]) {
      process.env[field] = value; assert.equal(service.getShopifyConfig().configured, false); process.env[field] = values[field];
    }
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test("GraphQL authentication and upstream failures never expose tokens or response details", async () => {
  for (const [status, body, expected] of [[401, { private: "secret-token" }, 409], [403, {}, 403],
    [200, { errors: [{ message: "private-customer", extensions: { code: "ACCESS_DENIED" } }] }, 403],
    [200, { errors: [{ message: "private-customer" }] }, 502]]) {
    mock.method(global, "fetch", async (url, options) => {
      assert.equal(new URL(url).hostname, shop); assert.equal(options.redirect, "error");
      assert.ok(options.signal); return new Response(JSON.stringify(body), { status });
    });
    await assert.rejects(service.shopifyGraphQL(shop, "test-token", "query {}", {}, { config }), error => {
      assert.equal(error.statusCode, expected); assert.doesNotMatch(error.message, /private-|secret-token|test-token/); return true;
    });
    global.fetch.mock.restore();
  }
});

test("pagination traverses every page and rejects repeated cursors or oversized input", async () => {
  let calls = 0;
  mock.method(global, "fetch", async (url, options) => {
    calls += 1; const cursor = JSON.parse(options.body).variables.cursor;
    return new Response(JSON.stringify({ data: { items: { nodes: [{ id: calls }], pageInfo: { hasNextPage: !cursor, endCursor: "next" } } } }));
  });
  assert.deepEqual(await service.fetchAllPages(shop, "test-token", "query {}", data => data.items, { config }), [{ id: 1 }, { id: 2 }]);
  global.fetch.mock.restore();
  mock.method(global, "fetch", async () => new Response(JSON.stringify({ data: { items: { nodes: [{}], pageInfo: { hasNextPage: true, endCursor: "same" } } } })));
  await assert.rejects(service.fetchAllPages(shop, "test-token", "query {}", d => d.items, { config }), /could not advance/);
  await assert.rejects(service.fetchAllPages(shop, "test-token", "query {}", d => d.items, { config, maxNodes: 1 }), /pilot sync limit/);
});

test("token exchange requests renewable tokens and never follows external redirects", async () => {
  mock.method(global, "fetch", async (url, options) => {
    assert.equal(url, `https://${shop}/admin/oauth/access_token`);
    assert.equal(options.body.get("expiring"), "1"); assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ access_token: "test-a", refresh_token: "test-r", scope: scopes.join(","), expires_in: 86400 }));
  });
  const tokens = await service.exchangeToken(shop, { code: "test-code", expiring: "1" }, config);
  assert.equal(tokens.accessToken, "test-a");
});

test("money normalization uses exact pennies and refuses other currencies or malformed amounts", () => {
  assert.equal(sync.amountMinor({ amount: "119.49", currencyCode: "GBP" }), 11949);
  for (const amount of ["-1", "NaN", "Infinity", "1e3", "1.234", "", 10]) assert.throws(() => sync.amountMinor({ amount, currencyCode: "GBP" }));
  assert.throws(() => sync.amountMinor({ amount: "10.00", currencyCode: "USD" }));
});

test("identity reconciliation preserves CSV profiles and rejects ambiguous or foreign store matches", () => {
  const row = { id: "gid://shopify/Customer/1", email: "ada@example.com" };
  assert.equal(sync.makeIdentityPlan([{ _id: "a", email: " ADA@example.com " }], [row], "email", "shopifyCustomerId", shop)[0].existingId, "a");
  assert.throws(() => sync.makeIdentityPlan([{ _id: "a", email: row.email }, { _id: "b", email: row.email }], [row], "email", "shopifyCustomerId", shop));
  assert.throws(() => sync.makeIdentityPlan([{ _id: "a", email: row.email, shopifyCustomerId: row.id, shopifyStoreDomain: "other.myshopify.com" }], [row], "email", "shopifyCustomerId", shop));
});

test("schema persists Shopify identities and permits anonymous links only for Shopify purchases", async () => {
  assert.ok(Customer.schema.path("shopifyCustomerId")); assert.ok(Product.schema.path("shopifyProductId"));
  assert.equal(Customer.schema.options.autoIndex, false); assert.equal(Product.schema.options.autoIndex, false);
  const merchantId = new mongoose.Types.ObjectId();
  const event = new Event({ merchantId, source: "shopify", type: "purchase", customerId: null, productId: null });
  await event.validate();
  const invalid = new Event({ merchantId, type: "purchase", customerId: null, productId: null });
  await assert.rejects(invalid.validate());
  const customer = new Customer({ merchantId, skinType: null, concern: null }); await customer.validate();
});

test("reference audit accepts explicit anonymous Shopify links and still rejects forged or cross-tenant references", () => {
  const owner = new mongoose.Types.ObjectId(); const other = new mongoose.Types.ObjectId(); const id = new mongoose.Types.ObjectId();
  const row = { merchantId: owner, customerId: null, source: "shopify", type: "purchase", shopifyStoreDomain: shop,
    shopifyOrderId: "gid://shopify/Order/1", shopifyLineItemId: "gid://shopify/LineItem/1", dedupeKey: "a".repeat(64) };
  const checks = [{ from: "customers", field: "customerId", key: "invalid", tenantScoped: true }];
  const indexes = { customers: new Map([[id.toHexString(), other.toHexString()]]) };
  assert.equal(countInvalidReferences([row], checks, indexes).invalid, 0);
  assert.equal(countInvalidReferences([{ ...row, source: "csv" }], checks, indexes).invalid, 1);
  assert.equal(countInvalidReferences([{ ...row, customerId: id }], checks, indexes).invalid, 1);
});

test("pilot initialization refuses demo databases, non-empty targets and standalone servers before creating indexes", async () => {
  let writes = 0;
  function target(name, document, replica = true) {
    return { databaseName: name, command: async () => replica ? { setName: "test" } : {},
      listCollections: () => ({ toArray: async () => [{ name: "customers" }] }),
      collection: () => ({ findOne: async () => document, createIndexes: async () => { writes += 1; } }),
      createCollection: async () => { writes += 1; } };
  }
  await assert.rejects(initializePilotDatabase(target("dermaInsightDB", null), [Customer], true), /NEW_EMPTY_TARGET_REQUIRED/);
  await assert.rejects(initializePilotDatabase(target("derma_insight_shopify_test_a", {}), [Customer], true), /TARGET_NOT_EMPTY/);
  await assert.rejects(initializePilotDatabase(target("derma_insight_shopify_test_a", null, false), [Customer], true), /TRANSACTION_TARGET_REQUIRED/);
  assert.equal(writes, 0);
  assert.equal((await initializePilotDatabase(target("derma_insight_shopify_test_a", null), [Customer], true)).status, "INITIALIZED");
  assert.equal(writes, 1);
});

module.exports = { signedCallback };
