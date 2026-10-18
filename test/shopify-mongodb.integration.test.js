const assert = require("node:assert/strict");
const { test, mock } = require("node:test");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Merchant = require("../models/Merchant");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");
const ShopifyOrder = require("../models/ShopifyOrder");
const { initializePilotDatabase } = require("../scripts/initialize-pilot-database");
const { sealTokens } = require("../services/shopifyService");
const uri = process.env.DI_TEST_MONGO_URI;

test("real replica-set MongoDB: CSV reconciliation, Shopify replay, revenue, repeat buyers and transaction rollback", { skip: !uri, timeout: 60000 }, async () => {
  // This test is incapable of connecting to a remote or production-named target.
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/derma_insight_shopify_test_[a-z0-9_]+(?:\?|$)/);
  const names = ["NODE_ENV", "JWT_SECRET", "SHOPIFY_ENABLED", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_TOKEN_ENCRYPTION_KEY", "SHOPIFY_REDIRECT_URI", "SHOPIFY_SCOPES", "SHOPIFY_INCLUDE_TEST_ORDERS"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const key = Buffer.alloc(32, 9);
  Object.assign(process.env, { NODE_ENV: "production", JWT_SECRET: "isolated-real-db-jwt", SHOPIFY_ENABLED: "true", SHOPIFY_API_KEY: "test-id",
    SHOPIFY_API_SECRET: "test-secret", SHOPIFY_TOKEN_ENCRYPTION_KEY: key.toString("base64"), SHOPIFY_REDIRECT_URI: "https://example.com/api/shopify/callback",
    SHOPIFY_SCOPES: "read_customers,read_products,read_orders", SHOPIFY_INCLUDE_TEST_ORDERS: "false" });
  const nativeFetch = global.fetch.bind(global);
  let server;
  try {
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    await initializePilotDatabase(mongoose.connection.db, [Merchant, Customer, Product, Event, ShopifyOrder], true);
    const app = require("../server");
    server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const shop = "integration-test.myshopify.com";
    const merchant = await Merchant.create({ businessName: "Isolated Shop", ownerName: "Isolated Owner", email: "owner@example.com", password: "isolated-test-password" });
    const token = jwt.sign({ id: String(merchant._id) }, process.env.JWT_SECRET);
    async function api(endpoint, options = {}) {
      const response = await nativeFetch(base + endpoint, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
      return { status: response.status, body: await response.json() };
    }
    async function csv(type, text) {
      const body = new FormData(); body.append("dataType", type); body.append("file", new Blob([text], { type: "text/csv" }), `${type}.csv`);
      const result = await api("/api/imports/csv/import", { method: "POST", body });
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
    }
    await csv("customers", "email,first name,last name,skin type,concern\nada@example.com,Ada,Stone,dry,hydration\n");
    await csv("products", "name,category,price\nSerum,serum,15.00\n");
    const originalCustomer = await Customer.findOne({ merchantId: merchant._id }).lean();
    const originalProduct = await Product.findOne({ merchantId: merchant._id }).lean();
    const date = new Date(Date.now() - 3600000).toISOString();
    function line(id, amount = "9.99") { return { id: `gid://shopify/LineItem/${id}`, quantity: 1, currentQuantity: 1, product: { id: "gid://shopify/Product/1" },
      priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount, currencyCode: "GBP" } } }; }
    const orders = [{ id: "gid://shopify/Order/1", createdAt: date, updatedAt: date, cancelledAt: null, test: false, displayFinancialStatus: "PAID",
      customer: { id: "gid://shopify/Customer/1" }, lineItems: { nodes: [line(1, "10.00"), line(2)], pageInfo: { hasNextPage: false } } }];
    await Merchant.updateOne({ _id: merchant._id }, { $set: { shopifyStoreDomain: shop, shopifyConnectionState: "connected",
      shopifyTokenCiphertext: sealTokens({ accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 86400000 }, merchant._id, shop, key) } });
    const page = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
    mock.method(global, "fetch", async (url, options) => {
      assert.equal(new URL(url).hostname, shop);
      const query = JSON.parse(options.body).query;
      const data = query.includes("ShopCurrency") ? { shop: { currencyCode: "GBP" } } : query.includes("query Customers") ?
        { customers: page([{ id: "gid://shopify/Customer/1", firstName: "Ada", lastName: "Stone", email: "ada@example.com" }]) } :
        query.includes("query Products") ? { products: page([{ id: "gid://shopify/Product/1", title: "Serum", handle: "serum", productType: "serum", status: "ACTIVE",
          priceRangeV2: { minVariantPrice: { amount: "15.00", currencyCode: "GBP" } } }]) } : { orders: page(orders) };
      return new Response(JSON.stringify({ data }));
    });
    const first = await api("/api/shopify/sync", { method: "POST" });
    assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.summary.purchasesImported, 2);
    assert.equal(await Customer.countDocuments(), 1); assert.equal(await Product.countDocuments(), 1);
    assert.equal(String((await Customer.findOne().lean())._id), String(originalCustomer._id));
    assert.equal((await Customer.findOne().lean()).skinType, "dry");
    assert.equal(String((await Product.findOne().lean())._id), String(originalProduct._id));
    const ids = (await Event.find().lean()).map(event => String(event._id)).sort();
    const repeated = await api("/api/shopify/sync", { method: "POST" });
    assert.equal(repeated.status, 200, JSON.stringify(repeated.body)); assert.equal(repeated.body.summary.purchasesUnchanged, 2);
    assert.deepEqual((await Event.find().lean()).map(event => String(event._id)).sort(), ids);
    let overview = (await api("/api/analytics/overview?days=30")).body;
    assert.equal(overview.summary.totalRevenue, 19.99); assert.equal(overview.summary.totalPurchases, 2);
    assert.equal(overview.summary.totalPurchaseOrders, 1); assert.equal(overview.summary.conversionAvailable, false);
    assert.equal((await api("/api/segments?inactiveDays=30")).body.summary.repeatBuyers, 0, "Two lines in one order do not make a repeat buyer");
    const eventsCsv = `event type,customer email,product name,occurred at,amount,event id\nview,ada@example.com,Serum,${date},0,view-1\npurchase,ada@example.com,Serum,${date},10.01,csv-purchase-1\n`;
    assert.equal((await csv("events", eventsCsv)).importedCount, 2);
    assert.equal((await csv("events", eventsCsv)).skippedCount, 2);
    overview = (await api("/api/analytics/overview?days=30")).body;
    assert.equal(overview.summary.totalRevenue, 30); assert.equal(overview.summary.totalPurchaseOrders, 2);
    assert.equal(overview.summary.averagePurchaseValue, 15); assert.equal(overview.summary.conversionAvailable, true);
    assert.equal((await api("/api/segments?inactiveDays=30")).body.summary.repeatBuyers, 1);
    orders.push({ ...orders[0], id: "gid://shopify/Order/2", lineItems: { nodes: [line(98), line(99)], pageInfo: { hasNextPage: false } } });
    const originalUpdate = Event.updateOne.bind(Event);
    mock.method(Event, "updateOne", (filter, update, options) => {
      if (update.$set.shopifyLineItemId === "gid://shopify/LineItem/99") throw new Error("isolated transaction failure");
      return originalUpdate(filter, update, options);
    });
    const failed = await api("/api/shopify/sync", { method: "POST" });
    assert.equal(failed.status, 503); assert.equal(failed.body.summary.ordersProcessed, 1);
    assert.equal(await Event.countDocuments({ shopifyOrderId: "gid://shopify/Order/2" }), 0);
    assert.equal(await ShopifyOrder.countDocuments({ shopifyOrderId: "gid://shopify/Order/2" }), 0);
    Event.updateOne.mock.restore();
    const retry = await api("/api/shopify/sync", { method: "POST" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(retry.body.summary.purchasesImported, 2);
    orders[1].customer = null; orders[1].lineItems.nodes[0].product = null;
    assert.equal((await api("/api/shopify/sync", { method: "POST" })).status, 200);
    const guest = await Event.findOne({ shopifyLineItemId: "gid://shopify/LineItem/98" }).lean();
    assert.equal(guest.customerId, null); assert.equal(guest.productId, null);
    assert.equal(await Customer.countDocuments(), 1, "Guest orders never create fake people");
    const final = (await api("/api/analytics/overview?days=30")).body;
    assert.equal(final.summary.guestPurchaseLines, 2); assert.equal(final.summary.unknownProductPurchaseLines, 1);
    orders[0].lineItems.nodes[0].product = null;
    assert.equal((await api("/api/shopify/sync", { method: "POST" })).status, 200);
    assert.equal((await api(`/api/recommendations/for-customer/${originalCustomer._id}`)).status, 200,
      "A known customer's deleted-product purchase must not crash recommendations");
  } finally {
    mock.restoreAll();
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
