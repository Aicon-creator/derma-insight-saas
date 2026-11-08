const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/settings.js"), "utf8");
const layoutSource = fs.readFileSync(path.join(__dirname, "../public/js/layout.js"), "utf8");
const profile = { _id: "507f1f77bcf86cd799439011", businessName: "Pilot Business", ownerName: "Pilot Owner", email: "owner@example.com", platformType: "custom", subscriptionTier: "free" };
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness({ token = "first-account-token", failCache = false } = {}) {
  const ids = ["settingsForm", "settingsFields", "businessName", "ownerName", "merchantEmail", "saveSettings", "reloadSettings", "settingsStatus", "merchantName", "merchantAvatar"];
  const nodes = Object.fromEntries(ids.map(id => [id, {
    value: "", textContent: "", disabled: false, handlers: {}, attributes: {},
    addEventListener(type, callback) { this.handlers[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); }, contains(value) { return this.values.has(value); } }
  }]));
  nodes.reloadSettings.classList.add("hidden");
  const cache = new Map([["merchantData", JSON.stringify({ businessName: "Stale local business", logoDataUrl: "untrusted-old-logo" })]]);
  const windowHandlers = {};
  const requests = [];
  const events = [];
  const context = {
    requireAuth() {}, getMerchantToken: () => token,
    document: { getElementById: id => nodes[id], addEventListener() {} },
    localStorage: { getItem: key => cache.get(key), setItem(key, value) { if (failCache) throw new Error("Storage quota exceeded"); cache.set(key, value); } },
    window: {
      matchMedia: () => ({ matches: false }),
      addEventListener(type, callback) { windowHandlers[type] = callback; },
      dispatchEvent(event) { events.push(event); windowHandlers[event.type]?.(event); }
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    apiRequest(endpoint, options) { return new Promise((resolve, reject) => requests.push({ endpoint, options, resolve, reject })); }
  };
  vm.runInNewContext(layoutSource, context);
  vm.runInNewContext(source, context);
  return {
    nodes, cache, requests, events,
    setToken(value) { token = value; },
    submit() { return nodes.settingsForm.handlers.submit({ preventDefault() {} }); },
    reload() { return nodes.reloadSettings.handlers.click(); },
    async ready(data = profile) { requests.at(-1).resolve({ merchant: data }); await settle(); }
  };
}

test("settings loads from the server, never prefills from stale cache, and updates topbar using public fields", async () => {
  const h = harness();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].endpoint, "/api/merchants/profile");
  assert.equal(h.nodes.settingsFields.disabled, true); assert.equal(h.nodes.businessName.value, "");
  await h.submit(); assert.equal(h.requests.length, 1);
  await h.ready({ ...profile, password: "must-not-cache", futureSecret: "must-not-cache" });
  assert.equal(h.nodes.settingsFields.disabled, false); assert.equal(h.nodes.ownerName.value, profile.ownerName);
  assert.equal(h.nodes.merchantEmail.value, profile.email); assert.equal(h.nodes.merchantName.textContent, profile.businessName);
  assert.equal(h.nodes.merchantAvatar.textContent, "PB");
  assert.deepEqual(JSON.parse(h.cache.get("merchantData")), profile);
  assert.equal(h.nodes.settingsForm.attributes["aria-busy"], "false");
});

test("a failed or incomplete profile load locks the form until reload succeeds", async () => {
  for (const incomplete of [false, true]) {
    const h = harness();
    if (incomplete) h.requests[0].resolve({ merchant: { businessName: "Incomplete" } });
    else h.requests[0].reject(new Error("Network unavailable"));
    await settle();
    assert.equal(h.nodes.settingsFields.disabled, true); assert.equal(h.nodes.saveSettings.disabled, true);
    assert.equal(h.nodes.reloadSettings.classList.contains("hidden"), false);
    await h.submit(); assert.equal(h.requests.length, 1);
    const retry = h.reload(); await h.ready(); await retry;
    assert.equal(h.nodes.settingsFields.disabled, false); assert.equal(h.requests.length, 2);
  }
});

test("submit locks controls, ignores double-submit, and announces success only after the server confirms", async () => {
  const h = harness(); await h.ready();
  h.nodes.businessName.value = "  New name  "; h.nodes.ownerName.value = "  New owner  ";
  const saving = h.submit(); await h.submit(); await h.reload();
  assert.equal(h.requests.length, 2); assert.equal(h.nodes.settingsFields.disabled, true);
  assert.equal(h.nodes.saveSettings.disabled, true); assert.equal(h.nodes.settingsForm.attributes["aria-busy"], "true");
  assert.equal(h.requests[1].options.method, "PATCH");
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { businessName: "New name", ownerName: "New owner" });
  assert.equal(JSON.parse(h.cache.get("merchantData")).businessName, profile.businessName);
  assert.doesNotMatch(h.nodes.settingsStatus.textContent, /saved to/);
  h.requests[1].resolve({ merchant: { ...profile, businessName: "Server-confirmed name", ownerName: "New owner" } }); await saving;
  assert.equal(h.nodes.businessName.value, "Server-confirmed name"); assert.equal(h.nodes.merchantName.textContent, "Server-confirmed name");
  assert.match(h.nodes.settingsStatus.textContent, /saved to your account/); assert.equal(h.nodes.saveSettings.disabled, false);
});

test("invalid names are stopped before sending another request", async () => {
  for (const [field, value] of [["businessName", " "], ["businessName", "N".repeat(121)], ["ownerName", "O".repeat(101)], ["ownerName", "Test\nOwner"]]) {
    const h = harness(); await h.ready(); h.nodes[field].value = value; await h.submit();
    assert.equal(h.requests.length, 1); assert.match(h.nodes.settingsStatus.textContent, /Enter a business name/);
  }
});

test("unconfirmed saves require a fresh server reload and do not overwrite cache with unsaved values", async () => {
  for (const incomplete of [false, true]) {
    const h = harness(); await h.ready(); h.nodes.businessName.value = "Unsaved new value";
    const saving = h.submit();
    if (incomplete) h.requests[1].resolve({ message: "saved", merchant: {} });
    else h.requests[1].reject(new Error("Network unavailable"));
    await saving;
    assert.match(h.nodes.settingsStatus.textContent, /could not confirm/); assert.equal(h.nodes.settingsFields.disabled, true);
    assert.equal(JSON.parse(h.cache.get("merchantData")).businessName, profile.businessName);
    await h.submit(); assert.equal(h.requests.length, 2);
    const reloading = h.reload(); await h.ready({ ...profile, businessName: "Actually saved on server" }); await reloading;
    assert.equal(h.nodes.businessName.value, "Actually saved on server"); assert.equal(h.nodes.settingsFields.disabled, false);
  }
});

test("browser storage failure cannot turn a confirmed server save into a failure", async () => {
  const h = harness({ failCache: true }); await h.ready();
  h.nodes.businessName.value = "Stored on server";
  const saving = h.submit(); h.requests[1].resolve({ merchant: { ...profile, businessName: "Stored on server" } }); await saving;
  assert.match(h.nodes.settingsStatus.textContent, /saved to your account/);
  assert.equal(h.nodes.merchantName.textContent, "Stored on server"); assert.equal(h.nodes.settingsFields.disabled, false);
});

test("an account switch during load or save discards the previous account's response and locks editing", async () => {
  for (const duringSave of [false, true]) for (const failed of [false, true]) {
    const h = harness();
    let pending;
    if (duringSave) { await h.ready(); pending = h.submit(); }
    const beforeCache = h.cache.get("merchantData"); const beforeEvents = h.events.length;
    h.setToken("different-account-token");
    if (failed) h.requests.at(-1).reject(new Error("Old request failure"));
    else h.requests.at(-1).resolve({ merchant: { ...profile, businessName: "Old account response" } });
    await pending; await settle();
    assert.equal(h.nodes.businessName.value, ""); assert.equal(h.nodes.ownerName.value, ""); assert.equal(h.nodes.merchantEmail.value, "");
    assert.equal(h.cache.get("merchantData"), beforeCache); assert.equal(h.events.length, beforeEvents);
    assert.equal(h.nodes.settingsFields.disabled, true); assert.match(h.nodes.settingsStatus.textContent, /sign-in changed/);
    await h.submit(); assert.equal(h.requests.length, duringSave ? 2 : 1);
  }
});

test("signing out before submit sends no request, and names are rendered as text rather than markup", async () => {
  const h = harness(); await h.ready({ ...profile, businessName: "<img src=x onerror=alert(1)>" });
  assert.equal(h.nodes.merchantName.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(h.nodes.merchantName.innerHTML, undefined); assert.equal(h.nodes.merchantAvatar.innerHTML, undefined);
  h.setToken(null); await h.submit(); assert.equal(h.requests.length, 1); assert.equal(h.nodes.settingsFields.disabled, true);
  const unauthenticated = harness({ token: null }); assert.equal(unauthenticated.requests.length, 0);
});

test("settings markup advertises account persistence, labels every field, and preserves Shopify controls", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/settings.html"), "utf8");
  assert.match(html, /fieldset id="settingsFields" disabled/);
  for (const field of ["businessName", "ownerName", "merchantEmail"]) assert.match(html, new RegExp(`label for="${field}"`));
  assert.match(html, /id="merchantEmail"[^>]+readonly/); assert.match(html, /id="saveSettings" type="submit"/);
  assert.match(html, /id="settingsStatus" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /logoInput|logoPreview|saved locally|demo purposes/);
  for (const id of ["shopifyConnectForm", "shopifyConnectBtn", "shopifySyncBtn", "shopifyRefreshBtn", "shopifyDisconnectBtn"]) assert.ok(html.includes(`id="${id}"`));
});
