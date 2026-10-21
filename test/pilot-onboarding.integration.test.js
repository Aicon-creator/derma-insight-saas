const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const Merchant = require("../models/Merchant");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");
const ShopifyOrder = require("../models/ShopifyOrder");
const { initializePilotDatabase } = require("../scripts/initialize-pilot-database");
const configuredUri = process.env.DI_TEST_MONGO_URI;

test("first merchant: registration, templates, three CSV imports, replays, date filters and tenant isolation", { skip: !configuredUri, timeout: 60000 }, async () => {
  // Never connect to a remote host or a real database. Use our own fresh test
  // namespace so this test cannot race the Shopify integration test in CI.
  assert.match(configuredUri, /^mongodb:\/\/127\.0\.0\.1:\d+\/derma_insight_shopify_test_[a-z0-9_]+(?:\?|$)/);
  const target = new URL(configuredUri); target.pathname += "_onboarding";
  const previous = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };
  process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "isolated-onboarding-jwt-secret";
  let server;
  try {
    await mongoose.connect(target.href, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    await initializePilotDatabase(mongoose.connection.db, [Merchant, Customer, Product, Event, ShopifyOrder], true);
    const app = require("../server"); server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(endpoint, { token, json, ...options } = {}) {
      const response = await fetch(base + endpoint, { ...options, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json ? { "Content-Type": "application/json" } : {})
      }, ...(json ? { body: JSON.stringify(json) } : {}) });
      return { status: response.status, body: await response.json() };
    }
    async function account(email) {
      const signup = await request("/api/merchants/auth/register", { method: "POST", json: {
        businessName: "Pilot Test", ownerName: "Test Owner", email, password: "isolated-pilot-password"
      } });
      assert.equal(signup.status, 201, JSON.stringify(signup.body));
      assert.ok(signup.body.token); assert.equal(signup.body.password, undefined);
      const login = await request("/api/merchants/auth/login", { method: "POST", json: { email, password: "isolated-pilot-password" } });
      assert.equal(login.status, 200, JSON.stringify(login.body)); assert.ok(login.body.token);
      return login.body.token;
    }
    const token = await account("first-pilot@example.com");
    const other = await account("second-pilot@example.com");
    assert.equal(await Customer.countDocuments(), 0); assert.equal(await Product.countDocuments(), 0);
    assert.equal(await Event.countDocuments(), 0, "Registration does not populate fake activity");
    const empty = await request("/api/analytics/overview?days=30", { token });
    assert.equal(empty.status, 200); assert.equal(empty.body.summary.totalRevenue, 0);
    assert.equal(empty.body.summary.totalCustomers, 0); assert.equal(empty.body.summary.conversionAvailable, false);
    assert.equal((await request("/api/analytics/overview?days=30")).status, 401);
    const dashboard = await (await fetch(base + "/dashboard.html")).text();
    assert.match(dashboard, /class="btn btn-primary" href="\.\/imports.html">Import CSV data/);
    assert.doesNotMatch(dashboard, /id="generateDemoDataBtn"/);
    const templates = {};
    for (const type of ["customers", "products", "events"]) {
      const response = await fetch(`${base}/templates/${type}.csv`); assert.equal(response.status, 200);
      templates[type] = await response.text();
      assert.equal(templates[type], fs.readFileSync(path.join(__dirname, `../public/templates/${type}.csv`), "utf8"));
      assert.equal(templates[type].trim().split(/\r?\n/).length, 1, "Templates contain no importable people or sales");
    }
    function csv(type, rows) { return templates[type].trimEnd() + "\n" + rows.map(row => row.join(",")).join("\n") + "\n"; }
    async function upload(type, contents, operation = "import", actor = token) {
      const body = new FormData(); body.append("dataType", type);
      body.append("file", new Blob([contents], { type: "text/csv" }), `${type}.csv`);
      return request(`/api/imports/csv/${operation}`, { method: "POST", token: actor, body });
    }
    const ago = days => new Date(Date.now() - days * 86400000).toISOString();
    const customers = csv("customers", [["ada@example.com", "Ada", "Stone", "oily", "acne"], ["ben@example.com", "Ben", "Reed", "dry", "hydration"]]);
    const products = csv("products", [["Serum", "serum", "29.99"], ["Cleanser", "cleanser", "18.50"]]);
    const events = csv("events", [
      ["view", "ada@example.com", "Serum", ago(2), "0", "pilot-1", "1", "GBP", ""],
      ["add_to_cart", "ada@example.com", "Serum", ago(2), "0", "pilot-2", "1", "GBP", ""],
      ["purchase", "ada@example.com", "Serum", ago(2), "29.99", "pilot-3", "2", "GBP", ""],
      ["view", "ben@example.com", "Cleanser", ago(2), "0", "pilot-4", "1", "GBP", ""],
      ["purchase", "ada@example.com", "Cleanser", ago(10), "18.50", "pilot-5", "1", "GBP", ""],
      ["purchase", "ben@example.com", "Cleanser", ago(40), "18.50", "pilot-6", "1", "GBP", ""]
    ]);
    const premature = await upload("events", events);
    assert.equal(premature.status, 400); assert.ok(premature.body.errors.length);
    assert.equal(await Event.countDocuments(), 0, "Unresolved references block all event writes");
    for (const [type, contents, count] of [["customers", customers, 2], ["products", products, 2], ["events", events, 6]]) {
      const preview = await upload(type, contents, "preview"); assert.equal(preview.status, 200);
      assert.equal(preview.body.totalRows, count); assert.equal(preview.body.errors.length, 0);
      assert.equal(preview.body.previewRows.length, count);
      const imported = await upload(type, contents); assert.equal(imported.status, 200, JSON.stringify(imported.body));
      assert.equal(imported.body.importedCount, count); assert.equal(imported.body.skippedCount, 0);
      const repeated = await upload(type, contents); assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
      assert.equal(repeated.body.importedCount, 0); assert.equal(repeated.body.skippedCount, count);
    }
    for (const [days, revenue, purchases, conversion] of [[7, 59.98, 1, 50], [30, 78.48, 2, 50], [90, 96.98, 3, 100]]) {
      const overview = await request(`/api/analytics/overview?days=${days}`, { token }); assert.equal(overview.status, 200);
      const summary = overview.body.summary;
      assert.equal(summary.totalCustomers, 2); assert.equal(summary.totalProducts, 2);
      assert.equal(summary.totalRevenue, revenue); assert.equal(summary.totalPurchases, purchases);
      assert.equal(summary.totalViews, 2); assert.equal(summary.totalAddToCart, 1);
      assert.equal(summary.conversionRate, conversion);
    }
    const top = await request("/api/analytics/top-products?days=30", { token });
    assert.equal(top.status, 200); assert.equal(top.body.topProducts[0].title, "Serum");
    assert.equal(top.body.topProducts[0].revenue, 59.98);
    const recommended = await request("/api/recommendations/popular?days=30", { token });
    assert.equal(recommended.status, 200); assert.equal(recommended.body.recommendations.length, 2);
    assert.equal(recommended.body.recommendations[0].title, "Serum");
    const segments = await request("/api/segments?inactiveDays=30", { token });
    assert.equal(segments.status, 200); assert.equal(segments.body.summary.repeatBuyers, 1);
    assert.equal(segments.body.summary.activeCustomers, 2);
    const isolated = await request("/api/analytics/overview?days=90", { token: other });
    assert.equal(isolated.status, 200); assert.equal(isolated.body.summary.totalCustomers, 0);
    assert.equal(isolated.body.summary.totalRevenue, 0);
    const foreignEvents = await upload("events", events, "import", other);
    assert.equal(foreignEvents.status, 400); assert.equal(await Event.countDocuments(), 6);
    assert.equal((await upload("customers", customers, "import", other)).body.importedCount, 2);
    assert.equal((await upload("products", products, "import", other)).body.importedCount, 2);
    assert.equal((await request("/api/analytics/overview?days=90", { token: other })).body.summary.totalRevenue, 0);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
