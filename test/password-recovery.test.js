const assert = require("node:assert/strict");
const { test, before, after, beforeEach, afterEach, mock } = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Merchant = require("../models/Merchant");
const recovery = require("../services/passwordRecovery");
const { requestResetLimiter, completeResetLimiter } = require("../middleware/passwordRecoveryRateLimiter");
const previous = Object.fromEntries(["JWT_SECRET", "PASSWORD_RESET_ENABLED", "PASSWORD_RESET_APP_ORIGIN", "PASSWORD_RESET_FROM", "RESEND_API_KEY"].map(key => [key, process.env[key]]));
const nativeFetch = global.fetch.bind(global);
const firstId = "507f1f77bcf86cd799439011";
const secondId = "507f1f77bcf86cd799439012";
const oldPassword = "isolated-original-password";
const oldHash = bcrypt.hashSync(oldPassword, 10);
const fakeConfig = { PASSWORD_RESET_ENABLED: "true", PASSWORD_RESET_APP_ORIGIN: "https://pilot.example.com",
  PASSWORD_RESET_FROM: "accounts@auth.example.com", RESEND_API_KEY: "re_isolated_recovery_test_key" };
mongoose.set("bufferCommands", false);

const app = express(); app.use(express.json());
app.use("/api/merchants/auth", require("../routes/merchantAuthRoutes"));
app.use("/api/merchants", require("../routes/merchantRoutes"));
app.use(require("../middleware/errorHandler"));
let server, base, records, deliveries, writes, findWork, beforeWrite, deliveryWork;

function matches(record, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === "$and") return expected.every(value => matches(record, value));
    if (field === "$or") return expected.some(value => matches(record, value));
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === "$exists") return (record[field] !== undefined) === value;
        if (operator === "$gt") return record[field] > value;
        if (operator === "$lte") return record[field] <= value;
        throw new Error(`Unexpected fixture operator ${operator}`);
      });
    }
    return String(record[field]) === String(expected);
  });
}

function query(work) {
  return { select() { return this; }, limit() { return this; },
    lean() { return Promise.resolve().then(work); }, then(resolve, reject) { return Promise.resolve().then(work).then(resolve, reject); } };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  Object.assign(process.env, fakeConfig, { JWT_SECRET: "isolated-recovery-session-secret" });
  records = [firstId, secondId].map((_id, index) => ({ _id, email: `owner${index}@example.com`, businessName: `Business ${index}`,
    ownerName: `Owner ${index}`, password: oldHash, sessionVersion: 0, platformType: "custom", subscriptionTier: "free" }));
  deliveries = []; writes = []; beforeWrite = null;
  findWork = filter => records.filter(record => matches(record, filter)).slice(0, 2).map(record => ({ ...record }));
  deliveryWork = async () => new Response(JSON.stringify({ id: "isolated-provider-message" }), { status: 200, headers: { "Content-Type": "application/json" } });
  mock.method(console, "warn", () => {}); mock.method(console, "error", () => {});
  mock.method(mongoose, "connect", () => { throw new Error("No database connection in recovery HTTP unit tests"); });
  mock.method(Merchant, "find", filter => query(() => findWork(filter)));
  mock.method(Merchant, "findById", id => query(() => records.find(record => record._id === String(id)) || null));
  mock.method(Merchant, "findOne", filter => query(() => records.find(record => matches(record, filter)) || null));
  mock.method(Merchant, "findOneAndUpdate", (filter, update, options) => query(() => {
    beforeWrite?.(filter, update);
    writes.push({ filter, update, options });
    const record = records.find(item => matches(item, filter));
    if (!record) return null;
    Object.assign(record, update.$set || {});
    for (const [field, value] of Object.entries(update.$inc || {})) record[field] = (record[field] || 0) + value;
    for (const field of Object.keys(update.$unset || {})) delete record[field];
    return { ...record };
  }));
  mock.method(global, "fetch", async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails", "No other external request is permitted");
    assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
    deliveries.push({ options, payload: JSON.parse(options.body) });
    return deliveryWork();
  });
  await requestResetLimiter.resetKey("127.0.0.1"); await completeResetLimiter.resetKey("127.0.0.1");
});

afterEach(async () => { await recovery.waitForBackgroundJobs(); mock.restoreAll(); });
after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

async function request(path, { method = "POST", body, token } = {}) {
  const response = await nativeFetch(base + path, { method, headers: {
    ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const forgot = email => request("/api/merchants/auth/forgot-password", { body: { email } });
const reset = body => request("/api/merchants/auth/reset-password", { body });
function proof(delivery = deliveries[0]) {
  const link = new URL(delivery.payload.text.match(/https:\/\/[^\s]+/)[0]);
  const params = new URLSearchParams(link.hash.slice(1));
  return { id: params.get("id"), token: params.get("token"), link };
}
async function issued(email = "owner0@example.com") {
  const result = await forgot(email); await recovery.waitForBackgroundJobs();
  assert.equal(result.status, 202); return proof(deliveries.at(-1));
}
const session = (id = firstId, version) => jwt.sign({ id, ...(version === undefined ? {} : { sv: version }) }, process.env.JWT_SECRET, { expiresIn: "1h" });
const profile = token => request("/api/merchants/profile", { method: "GET", token });

test("configuration fails closed and cannot take its reset origin or sender from request input", () => {
  assert.deepEqual(recovery.configuration(fakeConfig), { key: fakeConfig.RESEND_API_KEY, from: fakeConfig.PASSWORD_RESET_FROM, origin: fakeConfig.PASSWORD_RESET_APP_ORIGIN });
  for (const values of [{ PASSWORD_RESET_ENABLED: "false" }, { RESEND_API_KEY: "" }, { PASSWORD_RESET_FROM: "a@example.com\r\nBcc:attacker@example.com" },
    { PASSWORD_RESET_APP_ORIGIN: "http://pilot.example.com" }, { PASSWORD_RESET_APP_ORIGIN: "https://user:password@pilot.example.com" },
    { PASSWORD_RESET_APP_ORIGIN: "https://pilot.example.com/path" }, { PASSWORD_RESET_APP_ORIGIN: "https://pilot.example.com/?token=secret" }]) {
    assert.equal(recovery.configuration({ ...fakeConfig, ...values }), null);
  }
  assert.equal(recovery.configuration({}), null);
});

test("disabled recovery exposes no configuration, queries no account and sends no email", async () => {
  process.env.PASSWORD_RESET_ENABLED = "false";
  const status = await request("/api/merchants/auth/password-recovery", { method: "GET" });
  assert.deepEqual(status.body, { available: false }); assert.equal(status.headers.get("cache-control"), "no-store");
  const existing = await forgot("owner0@example.com"); const missing = await forgot("missing@example.com");
  assert.equal(existing.status, 503); assert.deepEqual(existing.body, missing.body);
  assert.equal((await reset({ id: firstId, token: "a".repeat(64), password: "valid-new-password" })).status, 503);
  assert.equal(Merchant.find.mock.callCount(), 0); assert.equal(writes.length, 0); assert.equal(deliveries.length, 0);
});

test("known and unknown emails receive identical generic responses; only a token hash and bounded expiry are stored", async () => {
  const known = await forgot("  OWNER0@EXAMPLE.COM  "); const unknown = await forgot("missing@example.com");
  await recovery.waitForBackgroundJobs();
  assert.equal(known.status, 202); assert.deepEqual(known.body, unknown.body);
  assert.equal(known.headers.get("cache-control"), "no-store"); assert.equal(known.headers.get("referrer-policy"), "no-referrer");
  assert.equal(deliveries.length, 1); assert.deepEqual(deliveries[0].payload.to, ["owner0@example.com"]);
  const data = proof(); assert.equal(data.link.origin, fakeConfig.PASSWORD_RESET_APP_ORIGIN); assert.equal(data.link.search, "");
  assert.equal(data.id, firstId); assert.match(data.token, /^[a-f0-9]{64}$/);
  assert.equal(records[0].passwordResetTokenHash, recovery.tokenHash(data.token));
  assert.notEqual(records[0].passwordResetTokenHash, data.token);
  assert.equal(+records[0].passwordResetExpiresAt - +records[0].passwordResetRequestedAt, recovery.EXPIRY_MS);
  assert.equal(records[0].password, oldHash); assert.equal(records[0].sessionVersion, 0);
  assert.doesNotMatch(JSON.stringify(known.body), /owner0|token|hash|https|re_isolated/);
});

test("the generic response does not wait for an account lookup or provider response", async () => {
  let release;
  let timeout;
  findWork = () => new Promise(resolve => { release = resolve; });
  try {
    const result = await Promise.race([forgot("owner0@example.com"), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Response waited for lookup")), 1500); })]);
    assert.equal(result.status, 202); assert.equal(deliveries.length, 0);
  } finally { clearTimeout(timeout); release?.([]); }
  await recovery.waitForBackgroundJobs();
});

test("background recovery work has a fixed capacity instead of an unbounded email queue", async () => {
  const release = [];
  findWork = () => new Promise(resolve => release.push(resolve));
  for (let index = 0; index < 21; index++) recovery.requestReset("missing@example.com", recovery.configuration());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(release.length, 20); assert.equal(console.warn.mock.calls[0].arguments[0], "PASSWORD_RECOVERY_CAPACITY_REACHED");
  for (const done of release) done([]);
  await recovery.waitForBackgroundJobs(); assert.equal(deliveries.length, 0);
});

test("concurrent requests honor the persisted account cooldown; a later request replaces the old link", async () => {
  const responses = await Promise.all([forgot("owner0@example.com"), forgot("owner0@example.com")]);
  await recovery.waitForBackgroundJobs();
  assert.ok(responses.every(result => result.status === 202)); assert.equal(deliveries.length, 1);
  const first = proof(); records[0].passwordResetRequestedAt = new Date(Date.now() - recovery.COOLDOWN_MS - 1);
  const second = await issued(); assert.equal(deliveries.length, 2); assert.notEqual(first.token, second.token);
  assert.equal((await reset({ id: first.id, token: first.token, password: "must-not-change" })).status, 400);
  assert.equal(records[0].password, oldHash);
});

test("ambiguous email identities and stale pre-reset lookups cannot issue a link", async () => {
  records.push({ ...records[0], _id: "507f1f77bcf86cd799439013" });
  await forgot("owner0@example.com"); await recovery.waitForBackgroundJobs();
  assert.equal(deliveries.length, 0); assert.equal(writes.length, 0);
  records.pop(); beforeWrite = () => { records[0].sessionVersion += 1; beforeWrite = null; };
  await forgot("owner0@example.com"); await recovery.waitForBackgroundJobs();
  assert.equal(deliveries.length, 0); assert.equal(records[0].passwordResetTokenHash, undefined);
});

test("provider and database failures keep the generic response and only fixed non-sensitive warning codes", async () => {
  deliveryWork = async () => new Response("private upstream data and secret credentials", { status: 503 });
  const first = await forgot("owner0@example.com"); await recovery.waitForBackgroundJobs();
  assert.equal(first.status, 202); assert.equal(console.warn.mock.calls[0].arguments[0], "PASSWORD_RECOVERY_BACKGROUND_UNCONFIRMED");
  const log = JSON.stringify(console.warn.mock.calls.map(call => call.arguments));
  assert.doesNotMatch(log, /private|credentials|owner0|https|re_isolated/);
  findWork = () => { throw new Error("private database details"); };
  const second = await forgot("missing@example.com"); await recovery.waitForBackgroundJobs();
  assert.deepEqual(first.body, second.body);
  assert.doesNotMatch(JSON.stringify(console.warn.mock.calls.map(call => call.arguments)), /private database/);
});

test("a valid reset is atomic and single-use, revokes legacy/version-zero sessions and leaves the other account untouched", async () => {
  delete records[0].sessionVersion;
  const legacy = session(); const versioned = session(firstId, 0); const otherSession = session(secondId, 0);
  assert.equal((await profile(legacy)).status, 200); assert.equal((await profile(versioned)).status, 200);
  const data = await issued(); const otherBefore = JSON.stringify(records[1]);
  const result = await reset({ id: data.id, token: data.token, password: "new-isolated-password" });
  await recovery.waitForBackgroundJobs();
  assert.equal(result.status, 200); assert.deepEqual(result.body, { message: "Password changed. Please sign in with your new password." });
  assert.equal(records[0].passwordResetTokenHash, undefined); assert.equal(records[0].passwordResetExpiresAt, undefined);
  assert.equal(records[0].sessionVersion, 1); assert.ok(await bcrypt.compare("new-isolated-password", records[0].password));
  assert.notEqual(records[0].password, "new-isolated-password"); assert.equal(JSON.stringify(records[1]), otherBefore);
  const update = writes.find(item => item.update.$set.password);
  assert.deepEqual(update.update.$inc, { sessionVersion: 1 }); assert.ok(update.update.$unset.passwordResetTokenHash !== undefined);
  assert.equal((await profile(legacy)).status, 401); assert.equal((await profile(versioned)).status, 401);
  assert.equal((await profile(otherSession)).status, 200);
  assert.equal((await reset({ id: data.id, token: data.token, password: "replay-password" })).status, 400);
  const oldLogin = await request("/api/merchants/auth/login", { body: { email: records[0].email, password: oldPassword } });
  const fresh = await request("/api/merchants/auth/login", { body: { email: records[0].email, password: "new-isolated-password" } });
  assert.equal(oldLogin.status, 400); assert.equal(fresh.status, 200);
  assert.equal(jwt.verify(fresh.body.token, process.env.JWT_SECRET).sv, 1); assert.equal((await profile(fresh.body.token)).status, 200);
  assert.equal(deliveries.length, 2); assert.match(deliveries[1].payload.subject, /was changed/);
  assert.ok(!deliveries[1].payload.text.includes(data.token)); assert.ok(!deliveries[1].payload.text.includes("new-isolated-password"));
});

test("a token cannot reset a different merchant, and expired or guessed links do not perform bcrypt/write work", async () => {
  const data = await issued(); const afterIssue = writes.length;
  assert.equal((await reset({ id: secondId, token: data.token, password: "other-account-password" })).status, 400);
  assert.equal((await reset({ id: firstId, token: "f".repeat(64), password: "guessed-link-password" })).status, 400);
  records[0].passwordResetExpiresAt = new Date(Date.now() - 1);
  assert.equal((await reset({ id: firstId, token: data.token, password: "expired-link-password" })).status, 400);
  assert.equal(writes.length, afterIssue); assert.equal(records[0].password, oldHash); assert.equal(records[1].password, oldHash);
});

test("concurrent reset replays yield exactly one successful password update", async () => {
  const data = await issued();
  const results = await Promise.all(["concurrent-password-one", "concurrent-password-two"].map(password => reset({ id: data.id, token: data.token, password })));
  await recovery.waitForBackgroundJobs(); assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal(records[0].sessionVersion, 1); assert.equal(deliveries.length, 2);
});

test("expiry is rechecked after password hashing, not only at the initial token lookup", async () => {
  const data = await issued();
  const hash = bcrypt.hash;
  mock.method(bcrypt, "hash", async (...args) => {
    const result = await hash(...args); records[0].passwordResetExpiresAt = new Date(Date.now() - 1); return result;
  });
  assert.equal((await reset({ id: data.id, token: data.token, password: "too-late-password" })).status, 400);
  assert.equal(records[0].password, oldHash); assert.equal(records[0].sessionVersion, 0);
});

test("an unconfirmed write returns a safe 503, not a claim that the original password remains", async () => {
  const data = await issued();
  Merchant.findOneAndUpdate.mock.restore();
  mock.method(Merchant, "findOneAndUpdate", (filter, update) => query(() => {
    const record = records.find(item => matches(item, filter));
    Object.assign(record, update.$set); record.sessionVersion += 1;
    for (const field of Object.keys(update.$unset)) delete record[field];
    throw new Error("private database URI and password");
  }));
  const result = await reset({ id: data.id, token: data.token, password: "unconfirmed-password" });
  assert.equal(result.status, 503); assert.match(result.body.message, /could not confirm.*signing in/);
  assert.doesNotMatch(JSON.stringify(result.body), /private database|URI/);
  assert.ok(await bcrypt.compare("unconfirmed-password", records[0].password));
  assert.equal((await profile(session(firstId, 0))).status, 401, "An acknowledged-lost write may still have revoked old sessions");
});

test("input validation rejects object injection, unknown fields and bcrypt-truncating passwords", () => {
  for (const body of [undefined, null, [], {}, { email: { $ne: "" } }, { email: "bad" }, { email: "x@example.com", merchantId: secondId }]) {
    assert.throws(() => recovery.requestEmail(body), error => error.statusCode === 400);
  }
  const valid = { id: firstId, token: "a".repeat(64), password: "valid-password" };
  for (const values of [{ id: { $ne: "" } }, { token: "short" }, { password: "short" }, { password: " ".repeat(8) },
    { password: "x".repeat(73) }, { password: "😀".repeat(20) }, { password: {} }, { merchantId: secondId }]) {
    assert.throws(() => recovery.resetDetails({ ...valid, ...values }), error => error.statusCode === 400);
  }
  assert.equal(recovery.resetDetails({ ...valid, password: "x".repeat(72) }).password.length, 72);
});

test("request and completion endpoints enforce independent IP rate limits", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await forgot("missing@example.com")).status, 202);
  const limited = await forgot("missing@example.com"); assert.equal(limited.status, 429); assert.ok(limited.headers.get("retry-after"));
  for (let i = 0; i < 10; i++) assert.equal((await reset({ id: firstId, token: "a".repeat(64), password: "valid-password" })).status, 400);
  assert.equal((await reset({ id: firstId, token: "a".repeat(64), password: "valid-password" })).status, 429);
  assert.equal(records[0].password, oldHash);
});

test("recovery state is private, session claims are checked, and no account-deleting TTL index is introduced", async () => {
  for (const field of ["passwordResetTokenHash", "passwordResetExpiresAt", "passwordResetRequestedAt"]) assert.equal(Merchant.schema.path(field).options.select, false);
  assert.ok(Merchant.schema.indexes().every(([, options]) => options.expireAfterSeconds === undefined));
  const data = await issued(); const current = await profile(session(firstId, 0));
  assert.doesNotMatch(JSON.stringify(current.body), /passwordReset|sessionVersion/); assert.ok(!JSON.stringify(current.body).includes(data.token));
  for (const version of [-1, "0", 1.5, 1]) assert.equal((await profile(session(firstId, version))).status, 401);
});
