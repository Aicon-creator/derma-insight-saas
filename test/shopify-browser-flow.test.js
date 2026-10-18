const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/shopify.js"), "utf8");

function harness() {
  const ids = ["shopifyConnectForm", "shopifyShop", "shopifyConnectBtn", "shopifySyncBtn", "shopifyRefreshBtn",
    "shopifyDisconnectBtn", "shopifyStatus", "shopifyResult", "shopifyDataNote"];
  const nodes = Object.fromEntries(ids.map(id => [id, { textContent: "", value: "", disabled: false, handlers: {}, attributes: {},
    addEventListener(type, callback) { this.handlers[type] = callback; }, setAttribute(name, value) { this.attributes[name] = value; } }]));
  const requests = []; const navigations = [];
  const context = vm.createContext({ URL, Date, Number, encodeURIComponent, getMerchantToken: () => "isolated-browser-token",
    document: { getElementById: id => nodes[id] }, window: { location: { assign: value => navigations.push(value) } },
    apiRequest(endpoint, options) { return new Promise((resolve, reject) => requests.push({ endpoint, options, resolve, reject })); } });
  vm.runInContext(source, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { nodes, requests, navigations, settle,
    async status(value) { requests.at(-1).resolve({ configured: true, connected: false, syncStatus: "never", ...value }); await settle(); } };
}

test("Settings checks status and disables connections when the server is not configured", async () => {
  const h = harness(); assert.equal(h.nodes.shopifyConnectBtn.disabled, true);
  await h.status({ configured: false });
  assert.equal(h.nodes.shopifyConnectBtn.disabled, true); assert.equal(h.nodes.shopifySyncBtn.disabled, true);
  assert.match(h.nodes.shopifyStatus.textContent, /CSV imports are available/);
});

test("valid connection opens Shopify once and prevents duplicate submissions", async () => {
  const h = harness(); await h.status(); h.nodes.shopifyShop.value = "test-store.myshopify.com";
  const first = h.nodes.shopifyConnectForm.handlers.submit({ preventDefault() {} });
  await h.nodes.shopifyConnectForm.handlers.submit({ preventDefault() {} });
  assert.equal(h.requests.length, 2); assert.equal(h.nodes.shopifyConnectBtn.disabled, true);
  h.requests[1].resolve({ authorizeUrl: "https://test-store.myshopify.com/admin/oauth/authorize?state=test" });
  await first; assert.equal(h.navigations.length, 1);
});

test("failed connection keeps controls usable and refuses an unexpected redirect", async () => {
  const h = harness(); await h.status(); h.nodes.shopifyShop.value = "test-store";
  const action = h.nodes.shopifyConnectForm.handlers.submit({ preventDefault() {} });
  h.requests.at(-1).resolve({ authorizeUrl: "https://evil.example/authorize" }); await action;
  assert.equal(h.navigations.length, 0); assert.equal(h.nodes.shopifyConnectBtn.disabled, false);
  assert.match(h.nodes.shopifyResult.textContent, /Invalid Shopify authorization address/);
});

test("sync displays confirmed counts and refreshes status while double clicks make one request", async () => {
  const h = harness(); await h.status({ connected: true, shop: "test-store.myshopify.com" });
  assert.equal(h.nodes.shopifyShop.readOnly, true); assert.equal(h.nodes.shopifySyncBtn.disabled, false);
  const action = h.nodes.shopifySyncBtn.handlers.click(); await h.nodes.shopifySyncBtn.handlers.click();
  assert.equal(h.requests.filter(r => r.endpoint.endsWith("/sync")).length, 1);
  h.requests.at(-1).resolve({ summary: { ordersProcessed: 2, purchasesImported: 3 } });
  await h.settle(); assert.equal(h.requests.at(-1).endpoint, "/api/shopify/status");
  await h.status({ connected: true, shop: "test-store.myshopify.com", syncStatus: "complete" }); await action;
  assert.match(h.nodes.shopifyResult.textContent, /Sync complete.*2 orders checked: 3 purchase lines added/);
  assert.equal(h.nodes.shopifySyncBtn.disabled, false);
});

test("partial failure retains the explanation and confirmed earlier progress", async () => {
  const h = harness(); await h.status({ connected: true, shop: "test-store.myshopify.com" });
  const action = h.nodes.shopifySyncBtn.handlers.click();
  h.requests.at(-1).reject(Object.assign(new Error("Some records may already be saved; retry safely."), { responseData: { summary: { ordersProcessed: 1 } } }));
  await h.settle(); await h.status({ connected: true, syncStatus: "failed" }); await action;
  assert.match(h.nodes.shopifyResult.textContent, /Some records may already be saved.*1 orders checked/);
  assert.equal(h.nodes.shopifySyncBtn.disabled, false);
});

test("running/reconnect states prevent unsafe sync actions and disconnect remains available without configuration", async () => {
  const h = harness(); await h.status({ connected: true, syncStatus: "running" });
  assert.equal(h.nodes.shopifySyncBtn.disabled, true); assert.equal(h.nodes.shopifyDisconnectBtn.disabled, true);
  const refresh = h.nodes.shopifyRefreshBtn.handlers.click();
  await h.status({ connected: true, configured: false, reconnectRequired: true, syncStatus: "failed" }); await refresh;
  assert.equal(h.nodes.shopifySyncBtn.disabled, true); assert.equal(h.nodes.shopifyDisconnectBtn.disabled, false);
});

test("disconnect clears access through the API, refreshes status and explains retained imports", async () => {
  const h = harness(); await h.status({ connected: true, shop: "test-store.myshopify.com" });
  const action = h.nodes.shopifyDisconnectBtn.handlers.click();
  assert.equal(h.requests.at(-1).endpoint, "/api/shopify/disconnect");
  h.requests.at(-1).resolve({ message: "Disconnected. Imported records remain available." });
  await h.settle(); await h.status({ connected: false, shop: "test-store.myshopify.com" }); await action;
  assert.match(h.nodes.shopifyResult.textContent, /Imported records remain/);
  assert.equal(h.nodes.shopifySyncBtn.disabled, true);
});
