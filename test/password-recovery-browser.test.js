const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/password-recovery.js"), "utf8");
const id = "507f1f77bcf86cd799439011";
const token = "a".repeat(64);
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ mode = "request", hash = `#id=${id}&token=${token}`, storageFailure = false } = {}) {
  const nodes = Object.fromEntries(["recoveryForm", "recoveryFields", "recoverySubmit", "recoveryStatus", "email", "password", "confirmPassword"].map(key => [key, {
    value: "", textContent: "", disabled: false, attributes: {}, handlers: {},
    addEventListener(type, callback) { this.handlers[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    set innerHTML(value) { throw new Error("Recovery must never render HTML from responses"); }
  }]));
  const storage = new Map([["merchantToken", "old-browser-session"], ["merchantData", "old-browser-profile"]]);
  const requests = [];
  const actions = [];
  const location = { hash, pathname: mode === "reset" ? "/reset-password.html" : "/forgot-password.html" };
  const context = {
    document: { body: { dataset: { recoveryMode: mode } }, getElementById: key => nodes[key] },
    window: { location, history: { replaceState(state, title, url) { actions.push({ type: "clear-link", url }); location.hash = ""; } } },
    localStorage: {
      getItem() { throw new Error("Recovery must not read browser credentials"); },
      setItem() { throw new Error("Recovery must not persist tokens or passwords"); },
      removeItem(key) { if (storageFailure) throw new Error("Storage unavailable"); storage.delete(key); }
    },
    URLSearchParams, AbortSignal, TextEncoder,
    fetch(url, options) {
      actions.push({ type: "request", url });
      return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
    }
  };
  vm.runInNewContext(source, context);
  return { nodes, requests, actions, location, storage,
    submit() { return nodes.recoveryForm.handlers.submit({ preventDefault() {} }); },
    respond(data, status = 200) { requests.at(-1).resolve({ status, ok: status >= 200 && status < 300, json: async () => data }); },
    async ready(available = true) { this.respond({ available }); await flush(); }
  };
}

test("recovery starts locked, enables only after configured status, and never sends a stored bearer token", async () => {
  const h = harness();
  assert.equal(h.nodes.recoveryFields.disabled, true); await h.submit(); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/merchants/auth/password-recovery");
  assert.equal(h.requests[0].options.credentials, "omit"); assert.equal(h.requests[0].options.cache, "no-store");
  assert.equal(h.requests[0].options.headers, undefined);
  await h.ready(); assert.equal(h.nodes.recoveryFields.disabled, false); assert.equal(h.nodes.recoveryForm.attributes["aria-busy"], "false");
});

test("disabled or failed configuration checks leave recovery unavailable rather than claiming email support", async () => {
  for (const failure of ["disabled", "network", "incomplete"]) {
    const h = harness();
    if (failure === "network") h.requests[0].reject(new Error("Network unavailable"));
    else h.respond(failure === "disabled" ? { available: false } : {});
    await flush(); await h.submit();
    assert.equal(h.nodes.recoveryFields.disabled, true); assert.equal(h.requests.length, 1);
    assert.doesNotMatch(h.nodes.recoveryStatus.textContent, /email sent|link sent/i);
  }
});

test("forgot-password validates email, sends one normalized request and keeps its success message conditional", async () => {
  const h = harness(); await h.ready();
  h.nodes.email.value = "bad"; await h.submit(); assert.equal(h.requests.length, 1);
  h.nodes.email.value = "  OWNER@EXAMPLE.COM  "; const pending = h.submit(); await h.submit();
  assert.equal(h.requests.length, 2); assert.equal(h.nodes.recoveryFields.disabled, true);
  assert.equal(h.requests[1].url, "/api/merchants/auth/forgot-password");
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { email: "owner@example.com" });
  assert.deepEqual(Object.keys(h.requests[1].options.headers), ["Content-Type"]);
  assert.doesNotMatch(h.nodes.recoveryStatus.textContent, /will be sent/);
  h.respond({ message: "ignored response with no account identity" }, 202); await pending;
  assert.match(h.nodes.recoveryStatus.textContent, /^If an account matches/);
  assert.equal(h.nodes.recoveryFields.disabled, false);
});

test("reset proof is removed from the URL before any API request and is never placed in browser storage", async () => {
  const h = harness({ mode: "reset" });
  assert.equal(h.actions[0].type, "clear-link"); assert.equal(h.actions[0].url, "/reset-password.html");
  assert.equal(h.actions[1].type, "request"); assert.equal(h.location.hash, "");
  await h.ready(); assert.equal(h.nodes.recoveryFields.disabled, false);
  assert.equal(h.storage.get("merchantToken"), "old-browser-session");
});

test("missing, malformed and duplicate reset proofs keep the form locked without an API call", async () => {
  for (const hash of ["", "#token=bad", `#id=${id}&token=${token}&token=${token}`, `#id=${id}&id=${id}&token=${token}`, `#id=invalid&token=${token}`]) {
    const h = harness({ mode: "reset", hash }); await h.submit();
    assert.equal(h.requests.length, 0); assert.equal(h.nodes.recoveryFields.disabled, true); assert.equal(h.location.hash, "");
    assert.match(h.nodes.recoveryStatus.textContent, /invalid or expired/);
  }
});

test("reset requires matching passwords and applies the byte limit before sending a secret", async () => {
  const h = harness({ mode: "reset" }); await h.ready();
  for (const [password, confirm] of [["short", "short"], ["valid-password", "different-password"], ["😀".repeat(20), "😀".repeat(20)]]) {
    h.nodes.password.value = password; h.nodes.confirmPassword.value = confirm; await h.submit(); assert.equal(h.requests.length, 1);
  }
  h.nodes.password.value = h.nodes.confirmPassword.value = "safe-new-password";
  const pending = h.submit(); await h.submit(); assert.equal(h.requests.length, 2);
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { id, token, password: "safe-new-password" });
  h.respond({ message: "Password changed" }); await pending;
  assert.equal(h.nodes.password.value, ""); assert.equal(h.nodes.confirmPassword.value, ""); assert.equal(h.storage.size, 0);
  assert.equal(h.nodes.recoveryFields.disabled, true); assert.match(h.nodes.recoveryStatus.textContent, /sign in with your new password/i);
  assert.equal(h.location.pathname, "/reset-password.html", "No automatic login or untrusted redirect");
  await h.submit(); assert.equal(h.requests.length, 2);
});

test("a browser storage failure does not turn a confirmed password change into a failure", async () => {
  const h = harness({ mode: "reset", storageFailure: true }); await h.ready();
  h.nodes.password.value = h.nodes.confirmPassword.value = "safe-new-password";
  const pending = h.submit(); h.respond({}); await pending;
  assert.match(h.nodes.recoveryStatus.textContent, /^Password changed/); assert.equal(h.nodes.recoveryFields.disabled, true);
});

test("invalid links and uncertain outcomes clear entered secrets and never echo untrusted errors", async () => {
  for (const status of [400, 503, null]) {
    const h = harness({ mode: "reset" }); await h.ready();
    h.nodes.password.value = h.nodes.confirmPassword.value = "safe-new-password";
    const pending = h.submit();
    if (status === null) h.requests[1].reject(new Error("private upstream message <script>"));
    else h.respond({ message: "private upstream message <script>" }, status);
    await pending;
    assert.equal(h.nodes.password.value, ""); assert.equal(h.nodes.confirmPassword.value, "");
    assert.equal(h.nodes.recoveryFields.disabled, true); assert.doesNotMatch(h.nodes.recoveryStatus.textContent, /private|<script>/);
    assert.match(h.nodes.recoveryStatus.textContent, status === 400 ? /invalid or expired/ : /could not confirm.*signing in/);
    await h.submit(); assert.equal(h.requests.length, 2);
  }
});

test("rate-limit and delivery-configuration failures do not promise a reset email", async () => {
  for (const status of [429, 503]) {
    const h = harness(); await h.ready(); h.nodes.email.value = "owner@example.com";
    const pending = h.submit(); h.respond({ message: "ignored" }, status); await pending;
    assert.doesNotMatch(h.nodes.recoveryStatus.textContent, /email sent|link sent/i);
    assert.match(h.nodes.recoveryStatus.textContent, status === 429 ? /15 minutes/ : /not available/);
    if (status === 429) { await h.submit(); assert.equal(h.requests.length, 2); }
  }
});

test("recovery pages have labelled controls, no-referrer metadata, fixed navigation and no third-party scripts", () => {
  for (const name of ["forgot-password", "reset-password"]) {
    const html = fs.readFileSync(path.join(__dirname, `../public/${name}.html`), "utf8");
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.match(html, /fieldset id="recoveryFields" disabled/);
    assert.match(html, /id="recoveryStatus"[^>]+role="status" aria-live="polite"/);
    assert.match(html, /href="\.\/index.html"/); assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    for (const field of name === "forgot-password" ? ["email"] : ["password", "confirmPassword"]) assert.ok(html.includes(`label for="${field}"`));
  }
  assert.match(fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"), /href="\.\/forgot-password.html"/);
});
