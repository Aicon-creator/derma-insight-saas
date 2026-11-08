const assert = require("node:assert/strict");
const { test, mock } = require("node:test");
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
const recovery = require("../services/passwordRecovery");
const nativeFetch = global.fetch.bind(global);

test("first merchant: registration, persistent profile, CSV imports, date filters, password recovery and tenant isolation", { skip: !configuredUri, timeout: 60000 }, async () => {
  // Never connect to a remote host or a real database. Use our own fresh test
  // namespace so this test cannot race the Shopify integration test in CI.
  assert.match(configuredUri, /^mongodb:\/\/127\.0\.0\.1:\d+\/derma_insight_shopify_test_[a-z0-9_]+(?:\?|$)/);
  const target = new URL(configuredUri); target.pathname += "_onboarding";
  const previous = Object.fromEntries(["NODE_ENV", "JWT_SECRET", "PASSWORD_RESET_ENABLED", "PASSWORD_RESET_APP_ORIGIN", "PASSWORD_RESET_FROM", "RESEND_API_KEY"].map(key => [key, process.env[key]]));
  process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "isolated-onboarding-jwt-secret";
  process.env.PASSWORD_RESET_ENABLED = "false";
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
    const initialProfile = await request("/api/merchants/profile", { token });
    assert.equal(initialProfile.status, 200); assert.equal(initialProfile.body.merchant.businessName, "Pilot Test");
    const changedProfile = await request("/api/merchants/profile", { method: "PATCH", token, json: {
      businessName: "  Saved Pilot Business  ", ownerName: "  Saved Pilot Owner  "
    } });
    assert.equal(changedProfile.status, 200, JSON.stringify(changedProfile.body));
    assert.equal(changedProfile.body.merchant.businessName, "Saved Pilot Business");
    assert.equal(changedProfile.body.merchant.ownerName, "Saved Pilot Owner");
    assert.equal(changedProfile.body.merchant.email, "first-pilot@example.com");
    assert.equal(changedProfile.body.merchant.password, undefined);
    const freshLogin = await request("/api/merchants/auth/login", { method: "POST", json: {
      email: "first-pilot@example.com", password: "isolated-pilot-password"
    } });
    assert.equal(freshLogin.status, 200); assert.equal(freshLogin.body.businessName, "Saved Pilot Business");
    assert.equal(freshLogin.body.ownerName, "Saved Pilot Owner", "A fresh login sees the server-saved profile; no browser storage is involved");
    const rereadProfile = await request("/api/merchants/profile", { token: freshLogin.body.token });
    assert.deepEqual(rereadProfile.body.merchant, changedProfile.body.merchant);
    assert.equal((await request("/api/merchants/profile", { token: other })).body.merchant.businessName, "Pilot Test");
    const forbidden = await request("/api/merchants/profile", { method: "PATCH", token, json: {
      businessName: "Must not save", merchantId: (await request("/api/merchants/profile", { token: other })).body.merchant._id,
      email: "different@example.com", password: "overwritten-password", subscriptionTier: "premium"
    } });
    assert.equal(forbidden.status, 400);
    assert.equal((await request("/api/merchants/profile", { token })).body.merchant.businessName, "Saved Pilot Business");
    assert.equal((await request("/api/merchants/profile", { method: "PATCH", json: { businessName: "Unauthorized" } })).status, 401);
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

    // Recovery uses this same disposable database and intercepts every email.
    // No provider credentials or live inbox are used for acceptance tests.
    const deliveries = [];
    mock.method(global, "fetch", async (url, options) => {
      if (url === "https://api.resend.com/emails") {
        deliveries.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ id: "isolated-message-id" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      assert.ok(String(url).startsWith(base + "/"), "Only this loopback server and intercepted email endpoint are permitted");
      return nativeFetch(url, options);
    });
    const statusBefore = await request("/api/merchants/auth/password-recovery");
    assert.deepEqual(statusBefore.body, { available: false });
    const blocked = await request("/api/merchants/auth/forgot-password", { method: "POST", json: { email: "first-pilot@example.com" } });
    assert.equal(blocked.status, 503); assert.equal(deliveries.length, 0);
    Object.assign(process.env, { PASSWORD_RESET_ENABLED: "true", PASSWORD_RESET_APP_ORIGIN: "https://pilot.example.com",
      PASSWORD_RESET_FROM: "accounts@auth.example.com", RESEND_API_KEY: "re_isolated_onboarding_test_key" });
    assert.deepEqual((await request("/api/merchants/auth/password-recovery")).body, { available: true });
    const unknown = await request("/api/merchants/auth/forgot-password", { method: "POST", json: { email: "missing@example.com" } });
    const known = await request("/api/merchants/auth/forgot-password", { method: "POST", json: { email: " FIRST-PILOT@EXAMPLE.COM " } });
    await recovery.waitForBackgroundJobs();
    assert.equal(known.status, 202); assert.deepEqual(known.body, unknown.body); assert.equal(deliveries.length, 1);
    function proof(message) {
      const link = new URL(message.text.match(/https:\/\/[^\s]+/)[0]);
      assert.equal(link.search, ""); assert.equal(link.origin, "https://pilot.example.com");
      const fields = new URLSearchParams(link.hash.slice(1));
      return { id: fields.get("id"), token: fields.get("token") };
    }
    const firstProof = proof(deliveries[0]);
    const stored = await Merchant.findById(firstProof.id).select("+passwordResetTokenHash +passwordResetExpiresAt").lean();
    assert.equal(stored.passwordResetTokenHash, recovery.tokenHash(firstProof.token));
    assert.notEqual(stored.passwordResetTokenHash, firstProof.token);
    const cooldown = await request("/api/merchants/auth/forgot-password", { method: "POST", json: { email: "first-pilot@example.com" } });
    await recovery.waitForBackgroundJobs(); assert.deepEqual(cooldown.body, known.body); assert.equal(deliveries.length, 1);
    await request("/api/merchants/auth/forgot-password", { method: "POST", json: { email: "second-pilot@example.com" } });
    await recovery.waitForBackgroundJobs(); assert.equal(deliveries.length, 2);
    const otherProof = proof(deliveries[1]);
    const otherBefore = await Merchant.findById(otherProof.id).select("+passwordResetTokenHash +passwordResetExpiresAt +passwordResetRequestedAt").lean();
    async function change(details, password) { return request("/api/merchants/auth/reset-password", { method: "POST", json: { ...details, password } }); }
    assert.equal((await change({ ...firstProof, id: otherProof.id }, "must-not-reset-other")).status, 400);
    await Merchant.updateOne({ _id: firstProof.id }, { $set: { passwordResetExpiresAt: new Date(Date.now() - 1) } });
    assert.equal((await change(firstProof, "must-not-use-expired")).status, 400);
    await Merchant.updateOne({ _id: firstProof.id }, { $set: { passwordResetExpiresAt: stored.passwordResetExpiresAt } });
    const candidates = ["new-pilot-password-one", "new-pilot-password-two"];
    const raced = await Promise.all(candidates.map(password => change(firstProof, password)));
    await recovery.waitForBackgroundJobs();
    assert.deepEqual(raced.map(result => result.status).sort(), [200, 400]);
    const winner = candidates[raced.findIndex(result => result.status === 200)];
    assert.equal((await change(firstProof, "must-not-replay-link")).status, 400);
    const consumed = await Merchant.findById(firstProof.id).select("+passwordResetTokenHash +passwordResetExpiresAt").lean();
    assert.equal(consumed.passwordResetTokenHash, undefined); assert.equal(consumed.passwordResetExpiresAt, undefined);
    assert.equal(consumed.sessionVersion, 1);
    assert.equal((await request("/api/merchants/profile", { token })).status, 401);
    assert.equal((await upload("customers", customers, "preview", token)).status, 401, "Old sessions cannot use CSV imports either");
    assert.equal((await request("/api/merchants/profile", { token: other })).status, 200);
    const otherAfter = await Merchant.findById(otherProof.id).select("+passwordResetTokenHash +passwordResetExpiresAt +passwordResetRequestedAt").lean();
    assert.deepEqual(otherAfter, otherBefore, "Recovery must not change the other merchant or consume their reset link");
    const oldLogin = await request("/api/merchants/auth/login", { method: "POST", json: { email: "first-pilot@example.com", password: "isolated-pilot-password" } });
    assert.equal(oldLogin.status, 400);
    const recovered = await request("/api/merchants/auth/login", { method: "POST", json: { email: "first-pilot@example.com", password: winner } });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    const restored = await request("/api/merchants/profile", { token: recovered.body.token });
    assert.equal(restored.status, 200); assert.equal(restored.body.merchant.businessName, "Saved Pilot Business");
    assert.equal((await request("/api/analytics/overview?days=90", { token: recovered.body.token })).body.summary.totalRevenue, 96.98);
    assert.equal(await Event.countDocuments(), 6); assert.equal(deliveries.length, 3);
    assert.match(deliveries[2].subject, /was changed/); assert.ok(!deliveries[2].text.includes(winner));
  } finally {
    await recovery.waitForBackgroundJobs(); mock.restoreAll();
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
