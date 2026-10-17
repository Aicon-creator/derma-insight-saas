const fs = require("node:fs");
const crypto = require("node:crypto");
const { parseArgs } = require("node:util");
const dotenv = require("dotenv");
const { MongoClient, BSON, ObjectId } = require("mongoose").mongo;
const { safeStage, databaseDiagnostic } = require("./database-diagnostics");

const MAX_DOCUMENTS = 100000;
const READ_OPTIONS = { maxTimeMS: 10000 };

class ReadinessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function connectionSettings(args, environment = process.env) {
  if (!args.database || !/^[a-zA-Z0-9_-]{1,63}$/.test(args.database)) {
    throw new ReadinessError("DATABASE_REQUIRED", "Supply the exact database name with --database.");
  }
  let uri;
  const envFile = args["env-file"] || ".env";
  if (fs.existsSync(envFile)) {
    uri = dotenv.parse(fs.readFileSync(envFile)).MONGO_URI;
  } else if (args["env-file"]) {
    throw new ReadinessError("ENV_FILE_MISSING", "The specified environment file does not exist.");
  } else {
    uri = environment.MONGO_URI;
  }
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri)) {
    throw new ReadinessError("MONGO_URI_MISSING", "Set MONGO_URI locally or provide --env-file. Do not paste credentials into chat.");
  }
  const encodedDatabase = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/)?.[1];
  let uriDatabase;
  try { uriDatabase = encodedDatabase ? decodeURIComponent(encodedDatabase) : null; }
  catch { throw new ReadinessError("URI_INVALID", "The connection configuration is invalid."); }
  if (uriDatabase && uriDatabase !== args.database) {
    throw new ReadinessError("DATABASE_MISMATCH", "The URI database and --database do not match. Check the target locally.");
  }
  return { uri, database: args.database };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(BSON.EJSON.serialize(value, { relaxed: false })));
}

function digest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function targetFingerprint(client, database) {
  const host = client.options.srvHost || client.options.hosts.map((item) => item.toString()).sort().join(",");
  return digest({ host: host.toLowerCase(), database });
}

function logicalIndexes(indexes) {
  return indexes.map(({ ns, v, background, ...index }) => ({
    ...index,
    // Compound-key order affects index behavior, unlike ordinary object order.
    key: Object.entries(index.key)
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function runDatabaseCommand(task, usage, argv = process.argv.slice(2)) {
  let client;
  let stage = { phase: "arguments", connected: false };
  const onStage = (phase, collection) => { stage = { ...safeStage(phase, collection), connected: stage.connected }; };
  try {
    const { values } = parseArgs({ args: argv, options: {
      database: { type: "string" }, "env-file": { type: "string" },
      "writes-paused": { type: "boolean", default: false }, help: { type: "boolean" }
    } });
    if (values.help) { console.log(usage); return; }
    onStage("configuration");
    const settings = connectionSettings(values);
    onStage("client_initialization");
    client = new MongoClient(settings.uri, {
      appName: "DermaInsightReadOnlyReadiness", serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000, socketTimeoutMS: 20000, retryWrites: false, readPreference: "primary"
    });
    onStage("connect");
    await client.connect();
    stage.connected = true;
    onStage("database_access");
    const report = await task(client.db(settings.database), {
      writesPaused: values["writes-paused"], targetFingerprint: targetFingerprint(client, settings.database), onStage
    });
    onStage("output");
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "ACTION_REQUIRED" ? 2 : 0;
  } catch (error) {
    // Driver/parse errors can contain credentials, hosts, paths or document values.
    // Never print their messages or stack traces.
    const safe = error instanceof ReadinessError;
    console.log(JSON.stringify({ status: "ERROR", readOnly: true,
      ...(safe ? { code: error.code, message: error.message, ...stage } : databaseDiagnostic(error, stage)) }, null, 2));
    process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

module.exports = { MAX_DOCUMENTS, READ_OPTIONS, ReadinessError, ObjectId, connectionSettings,
  canonicalJson, digest, targetFingerprint, logicalIndexes, runDatabaseCommand };
