const PHASES = new Set([
  "arguments", "configuration", "client_initialization", "connect", "database_access",
  "list_collections", "count_documents", "read_indexes", "scan_identities",
  "check_identities", "scan_references", "check_references", "review_duplicates", "fingerprint_documents", "build_manifest", "output"
]);
const COLLECTIONS = new Set(["merchants", "customers", "products", "events"]);
const ERROR_TYPES = new Set([
  "MongoServerError", "MongoServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError",
  "MongoOperationTimeoutError", "MongoParseError", "MongoInvalidArgumentError", "MongoAPIError",
  "MongoNotConnectedError", "MongoServerClosedError", "MongoTopologyClosedError",
  "TypeError", "ReferenceError", "RangeError", "SyntaxError"
]);

function safeStage(phase, collection) {
  return {
    phase: PHASES.has(phase) ? phase : "unknown",
    ...(collection == null ? {} : { collection: COLLECTIONS.has(collection) ? collection : "other" })
  };
}

// Server selection errors often wrap the useful DNS/TLS/auth error in a server
// description. Inspect only a bounded set of causes; never serialize an error.
function errorChain(error) {
  const queue = [error];
  const seen = new Set();
  const errors = [];
  while (queue.length && errors.length < 32) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    errors.push(current);
    for (const child of [current.cause, current.reason, current.error]) {
      if (child && queue.length < 32) queue.push(child);
    }
    if (current.servers instanceof Map) {
      for (const server of current.servers.values()) {
        if (queue.length >= 32) break;
        queue.push(server);
      }
    }
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 8));
  }
  return errors;
}

function databaseDiagnostic(error, stage = {}) {
  const errors = errorChain(error);
  const names = errors.map((item) => item.name);
  const codes = errors.map((item) => item.code);
  const errorType = names.find((name) => ERROR_TYPES.has(name));
  const databaseCode = codes.find((code) => Number.isInteger(code) && code >= 0 && code <= 2147483647);
  const details = {
    ...safeStage(stage.phase, stage.collection), connected: stage.connected === true,
    ...(errorType ? { errorType } : {}), ...(databaseCode == null ? {} : { databaseCode })
  };
  let code = "DATABASE_CHECK_FAILED";
  let message = "The read-only check could not complete. Report this safe JSON to the maintainer; keep raw errors and connection settings private.";
  if (codes.includes(18)) {
    code = "AUTHENTICATION_FAILED";
    message = "MongoDB rejected authentication. Check the database user, password encoding and authSource locally; do not share credentials.";
  } else if (codes.includes(13)) {
    code = "READ_PERMISSION_DENIED";
    message = "MongoDB denied a read operation. Check the user's read access to the selected database and its index metadata.";
  } else if (codes.some((value) => ["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(value))) {
    code = "DNS_LOOKUP_FAILED";
    message = "The MongoDB host could not be resolved. Check the configured host and local DNS/network access.";
  } else if (codes.some((value) => typeof value === "string" && (
    /^(ERR_TLS_|ERR_SSL_)/.test(value) || ["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(value)))) {
    code = "TLS_CONNECTION_FAILED";
    message = "MongoDB could not establish a verified TLS connection. Check the system clock, certificate trust and network proxy locally; keep certificate verification enabled.";
  } else if (codes.includes(50) || codes.includes(262) || names.includes("MongoOperationTimeoutError")) {
    code = "DATABASE_OPERATION_TIMED_OUT";
    message = "The database operation exceeded its time limit. Check availability and read performance for the reported phase before retrying.";
  } else if (details.phase === "arguments") {
    code = "INVALID_ARGUMENTS";
    message = "The command arguments are invalid. Run with --help; do not put a connection URI in command arguments.";
  } else if (details.phase === "configuration" && codes.some((value) => ["EACCES", "EPERM", "ENOENT"].includes(value))) {
    code = "ENV_FILE_UNREADABLE";
    message = "The local environment file could not be read. Check its path and your account's file permissions locally.";
  } else if (names.some((name) => ["MongoParseError", "MongoInvalidArgumentError"].includes(name)) &&
    ["configuration", "client_initialization", "connect"].includes(details.phase)) {
    code = "CONNECTION_CONFIGURATION_INVALID";
    message = "The MongoDB driver rejected the local connection configuration. Check URI syntax and supported options without sharing the URI.";
  } else if (names.some((name) => ["MongoServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError",
    "MongoNotConnectedError", "MongoServerClosedError", "MongoTopologyClosedError"].includes(name)) ||
    codes.some((value) => ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(value))) {
    code = "DATABASE_UNREACHABLE";
    message = "A usable MongoDB connection could not be established or retained. Check database availability, your current IP allowlist and local network access; this does not identify which one failed.";
  } else if (names.some((name) => ["TypeError", "ReferenceError", "RangeError", "SyntaxError", "MongoInvalidArgumentError"].includes(name))) {
    code = "CHECK_IMPLEMENTATION_ERROR";
    message = "The check encountered a script or driver-argument error. Report this safe JSON to the maintainer; do not change database data or access rules to work around it.";
  } else if (names.includes("MongoServerError")) {
    code = "DATABASE_COMMAND_FAILED";
    message = "MongoDB rejected a command. The safe phase and numeric database code can be used to investigate without exposing the raw error.";
  }
  return { code, message, ...details };
}

module.exports = { safeStage, databaseDiagnostic };
