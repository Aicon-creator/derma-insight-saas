const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/imports.js"), "utf8");

function harness() {
  const ids = ["csvPreviewForm", "dataType", "csvFile", "previewBtn", "confirmImportBtn", "confirmImportHint", "previewMeta", "importMeta", "previewRows", "previewErrors"];
  const nodes = Object.fromEntries(ids.map(id => [id, { value: "", textContent: "", innerHTML: "", disabled: false, files: [], handlers: {}, attributes: {},
    addEventListener(type, callback) { this.handlers[type] = callback; }, setAttribute(name, value) { this.attributes[name] = value; } }]));
  nodes.dataType.value = "customers";
  const requests = [];
  vm.runInNewContext(source, { requireAuth() {}, document: { getElementById: id => nodes[id] },
    FormData: class { constructor() { this.fields = {}; } append(key, value) { this.fields[key] = value; } },
    apiRequest(endpoint, options) { return new Promise((resolve, reject) => requests.push({ endpoint, options, resolve, reject })); } });
  return { nodes, requests,
    select(type, file = { name: `${type}.csv` }) { nodes.dataType.value = type; nodes.csvFile.files = [file]; nodes.csvFile.handlers.change(); return file; },
    preview() { return nodes.csvPreviewForm.handlers.submit({ preventDefault() {} }); },
    confirm() { return nodes.confirmImportBtn.handlers.click(); },
    async ready(type = "customers") {
      this.select(type); const action = this.preview();
      requests.at(-1).resolve({ totalRows: 1, previewRows: [{ email: "test@example.com" }], errors: [] }); await action;
    } };
}

test("a preview is required, double submits send one request and valid preview enables confirm", async () => {
  const h = harness(); assert.equal(h.nodes.confirmImportBtn.disabled, true);
  h.select("customers"); const first = h.preview(); await h.preview();
  assert.equal(h.requests.length, 1); assert.equal(h.nodes.previewBtn.disabled, true);
  h.requests[0].resolve({ totalRows: 12, previewRows: [], errors: [] }); await first;
  assert.equal(h.nodes.confirmImportBtn.disabled, false); assert.match(h.nodes.previewMeta.textContent, /12 rows found/);
  assert.equal(h.nodes.csvPreviewForm.attributes["aria-busy"], "false");
});

test("changing the selection while preview is pending discards both stale success and stale failure", async () => {
  for (const failed of [false, true]) {
    const h = harness(); const file = h.select("customers"); const pending = h.preview();
    h.select("products"); h.select("customers", file);
    if (failed) h.requests[0].reject(new Error("Old preview error"));
    else h.requests[0].resolve({ totalRows: 1, previewRows: [{ email: "old@example.com" }], errors: [] });
    await pending;
    assert.equal(h.nodes.confirmImportBtn.disabled, true); assert.equal(h.nodes.previewRows.innerHTML, "");
    assert.equal(h.nodes.previewMeta.textContent, ""); assert.equal(h.nodes.previewBtn.disabled, false);
    const fresh = h.preview(); h.requests[1].resolve({ totalRows: 1, previewRows: [], errors: [] }); await fresh;
    assert.equal(h.nodes.confirmImportBtn.disabled, false);
  }
});

test("validation errors keep confirm disabled and render untrusted CSV content safely", async () => {
  const h = harness(); h.select("events"); const pending = h.preview();
  h.requests[0].resolve({ totalRows: 1, previewRows: [{ email: "<img src=x onerror=alert(1)>" }],
    errors: [{ row: 2, column: "email", message: "Invalid <script> email" }] }); await pending;
  assert.equal(h.nodes.confirmImportBtn.disabled, true);
  assert.match(h.nodes.previewRows.innerHTML, /&lt;img/); assert.doesNotMatch(h.nodes.previewRows.innerHTML, /<img/);
  assert.match(h.nodes.previewErrors.innerHTML, /&lt;script&gt;/);
});

for (const type of ["customers", "products", "events"]) {
  test(`${type}: import locks controls, ignores repeated submissions and requires fresh preview`, async () => {
    const h = harness(); await h.ready(type);
    const file = h.nodes.csvFile.files[0]; const action = h.confirm();
    assert.equal(h.nodes.csvFile.disabled, true); assert.equal(h.nodes.dataType.disabled, true);
    assert.equal(h.nodes.previewBtn.disabled, true); assert.equal(h.nodes.confirmImportBtn.disabled, true);
    await h.confirm(); await h.preview(); assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].options.body.fields.file, file);
    assert.equal(h.requests[1].options.body.fields.dataType, type);
    h.requests[1].resolve({ importedCount: 1, skippedCount: 0 }); await action;
    assert.match(h.nodes.importMeta.textContent, new RegExp(`1 ${type.slice(0, -1)} imported`));
    assert.equal(h.nodes.csvFile.disabled, false); assert.equal(h.nodes.previewBtn.disabled, false);
    assert.equal(h.nodes.confirmImportBtn.disabled, true); assert.match(h.nodes.confirmImportHint.textContent, /Preview the file again/);
  });
}

test("a programmatic selection change during import cannot misreport a committed success as failure", async () => {
  const h = harness(); await h.ready("customers"); const importing = h.confirm();
  h.select("products"); h.requests[1].resolve({ importedCount: 1, skippedCount: 0 }); await importing;
  assert.equal(h.nodes.importMeta.textContent, "1 customer imported.");
  assert.equal(h.nodes.confirmImportBtn.disabled, true); assert.equal(h.requests.length, 2);
});

test("partial failure keeps structured row errors and confirmed progress while allowing a fresh preview", async () => {
  const h = harness(); await h.ready(); const importing = h.confirm();
  h.requests[1].reject(Object.assign(new Error("Some writes are unconfirmed. Preview again before retrying."), {
    responseData: { importedCount: 1, unconfirmedCount: 1, errors: [{ row: 3, column: "email", message: "Write was not confirmed" }] }
  })); await importing;
  assert.match(h.nodes.importMeta.textContent, /writes are unconfirmed/);
  assert.match(h.nodes.previewErrors.innerHTML, /Row 3.*email.*Write was not confirmed/);
  assert.equal(h.nodes.confirmImportBtn.disabled, true); assert.equal(h.nodes.csvFile.disabled, false);
  const preview = h.preview(); h.requests[2].resolve({ totalRows: 2, previewRows: [], errors: [] }); await preview;
  const retry = h.confirm(); h.requests[3].resolve({ importedCount: 0, skippedCount: 2 }); await retry;
  assert.match(h.nodes.importMeta.textContent, /2 existing customers were skipped/);
});
