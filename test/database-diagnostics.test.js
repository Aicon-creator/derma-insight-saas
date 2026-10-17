const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MongoClient } = require("mongoose").mongo;
const { databaseDiagnostic, safeStage } = require("../scripts/lib/database-diagnostics");
const { runDatabaseCommand } = require("../scripts/lib/database-access");
const { auditDatabase } = require("../scripts/audit-database");
const { createManifest } = require("../scripts/database-manifest");

const privateText = "mongodb://reader:private-password@private-host.example/private-db private-customer@example.com";
const driverError = (name, code) => Object.assign(new Error(privateText), { name, code });

test("database diagnostics distinguish supported causes without using raw messages", async (t) => {
  const cases = [
    ["MongoServerError", 18, "connect", "AUTHENTICATION_FAILED"],
    ["MongoServerError", 13, "list_collections", "READ_PERMISSION_DENIED"],
    ["Error", "ENOTFOUND", "connect", "DNS_LOOKUP_FAILED"],
    ["Error", "EAI_AGAIN", "connect", "DNS_LOOKUP_FAILED"],
    ["Error", "CERT_HAS_EXPIRED", "connect", "TLS_CONNECTION_FAILED"],
    ["Error", "ERR_TLS_CERT_ALTNAME_INVALID", "connect", "TLS_CONNECTION_FAILED"],
    ["MongoServerError", 50, "check_references", "DATABASE_OPERATION_TIMED_OUT"],
    ["MongoOperationTimeoutError", undefined, "scan_identities", "DATABASE_OPERATION_TIMED_OUT"],
    ["Error", "EACCES", "configuration", "ENV_FILE_UNREADABLE"],
    ["MongoParseError", undefined, "client_initialization", "CONNECTION_CONFIGURATION_INVALID"],
    ["MongoServerSelectionError", undefined, "connect", "DATABASE_UNREACHABLE"],
    ["MongoNetworkError", "ECONNRESET", "read_indexes", "DATABASE_UNREACHABLE"],
    ["TypeError", undefined, "check_identities", "CHECK_IMPLEMENTATION_ERROR"],
    ["MongoInvalidArgumentError", undefined, "check_references", "CHECK_IMPLEMENTATION_ERROR"],
    ["MongoServerError", 8000, "list_collections", "DATABASE_COMMAND_FAILED"],
    ["Error", "PRIVATE_CODE", "arguments", "INVALID_ARGUMENTS"],
    ["PRIVATE_TYPE", "PRIVATE_CODE", "read_indexes", "DATABASE_CHECK_FAILED"]
  ];
  for (const [name, code, phase, expected] of cases) {
    await t.test(`${expected}: ${name}/${code ?? "no code"}`, () => {
      const report = databaseDiagnostic(driverError(name, code), { phase, connected: phase !== "connect" });
      assert.equal(report.code, expected);
      assert.equal(report.phase, phase);
      assert.doesNotMatch(JSON.stringify(report), /private-|PRIVATE_|mongodb:\/\//);
      if (Number.isInteger(code)) assert.equal(report.databaseCode, code);
      else assert.equal(report.databaseCode, undefined);
    });
  }
});

test("nested server-selection causes take precedence over the generic connection category", () => {
  const outer = driverError("MongoServerSelectionError");
  outer.reason = { servers: new Map([["private-host", { error: driverError("Error", "ENOTFOUND") }]]) };
  assert.equal(databaseDiagnostic(outer).code, "DNS_LOOKUP_FAILED");
  outer.reason.servers.set("private-host", { error: driverError("MongoServerError", 18) });
  const report = databaseDiagnostic(outer, { phase: "connect" });
  assert.equal(report.code, "AUTHENTICATION_FAILED");
  assert.equal(report.databaseCode, 18);
  assert.equal(report.errorType, "MongoServerSelectionError");
  assert.doesNotMatch(JSON.stringify(report), /private-|mongodb:\/\//);
  // Circular causes and unexpected code/name values cannot leak or loop forever.
  outer.reason = outer;
  outer.cause = outer;
  assert.equal(databaseDiagnostic(outer).code, "DATABASE_UNREACHABLE");
  const unknown = databaseDiagnostic(driverError(privateText, privateText), { phase: privateText, collection: privateText });
  assert.equal(unknown.phase, "unknown");
  assert.equal(unknown.collection, "other");
  assert.equal(unknown.errorType, undefined);
  assert.doesNotMatch(JSON.stringify(unknown), /private-|mongodb:\/\//);
});

async function failingAudit(t, { connectionError, db }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "derma-diagnostic-"));
  const file = path.join(dir, "target.env");
  fs.writeFileSync(file, "MONGO_URI=mongodb://reader:fake-secret@127.0.0.1:27017/source\n");
  const output = [];
  let closed = 0;
  t.mock.method(MongoClient.prototype, "connect", async function () {
    if (connectionError) throw connectionError;
    return this;
  });
  t.mock.method(MongoClient.prototype, "db", () => db);
  t.mock.method(MongoClient.prototype, "close", async () => { closed += 1; });
  t.mock.method(console, "log", (value) => output.push(value));
  const previousExitCode = process.exitCode;
  try {
    await runDatabaseCommand(auditDatabase, "usage", ["--database", "source", "--env-file", file]);
    assert.equal(process.exitCode, 1);
    assert.equal(closed, 1);
    assert.equal(output.length, 1);
    assert.doesNotMatch(output[0], /private-|fake-secret|127\.0\.0\.1|mongodb:\/\//);
    return JSON.parse(output[0]);
  } finally {
    process.exitCode = previousExitCode;
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI reports a failed connection accurately and closes the client", async (t) => {
  const report = await failingAudit(t, { connectionError: driverError("MongoServerSelectionError") });
  assert.equal(report.status, "ERROR");
  assert.equal(report.readOnly, true);
  assert.equal(report.connected, false);
  assert.equal(report.phase, "connect");
  assert.equal(report.code, "DATABASE_UNREACHABLE");
  assert.equal(report.collection, undefined);
});

test("CLI distinguishes read permission failure after connection from connection failure", async (t) => {
  const db = { listCollections() { return { async toArray() { throw driverError("MongoServerError", 13); } }; } };
  const report = await failingAudit(t, { db });
  assert.equal(report.connected, true);
  assert.equal(report.phase, "list_collections");
  assert.equal(report.code, "READ_PERMISSION_DENIED");
  assert.equal(report.databaseCode, 13);
});

test("CLI reports the exact collection read that fails without printing the error", async (t) => {
  const db = {
    listCollections() { return { toArray: async () => [{ name: "merchants" }] }; },
    collection() { return {
      countDocuments: async () => 1,
      listIndexes() { return { async toArray() { throw driverError("MongoServerError", 50); } }; }
    }; }
  };
  const report = await failingAudit(t, { db });
  assert.equal(report.connected, true);
  assert.equal(report.phase, "read_indexes");
  assert.equal(report.collection, "merchants");
  assert.equal(report.code, "DATABASE_OPERATION_TIMED_OUT");
});

test("CLI labels script failures separately instead of suggesting an access change", async (t) => {
  const db = { listCollections() { throw new TypeError(privateText); } };
  const report = await failingAudit(t, { db });
  assert.equal(report.connected, true);
  assert.equal(report.code, "CHECK_IMPLEMENTATION_ERROR");
  assert.equal(report.errorType, "TypeError");
  assert.equal(report.phase, "list_collections");
});

test("audit and recovery stages precede the read that can fail", async () => {
  const stages = [];
  const onStage = (phase, collection) => stages.push(safeStage(phase, collection));
  const db = {
    listCollections() { return { toArray: async () => [{ name: "customers", type: "collection" }] }; },
    collection() { return {
      countDocuments: async () => 0,
      listIndexes() { return { toArray: async () => [] }; },
      find() { throw new Error("controlled failure"); }
    }; }
  };
  await assert.rejects(auditDatabase(db, { onStage }), /controlled failure/);
  assert.deepEqual(stages.at(-1), { phase: "scan_identities", collection: "customers" });
  await assert.rejects(createManifest(db, { onStage, writesPaused: true }), /controlled failure/);
  assert.deepEqual(stages.at(-1), { phase: "fingerprint_documents", collection: "customers" });
});
