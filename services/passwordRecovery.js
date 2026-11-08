const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const Merchant = require("../models/Merchant");
const AppError = require("../utils/AppError");

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const TOKEN = /^[a-f0-9]{64}$/;
const MERCHANT_ID = /^[a-f0-9]{24}$/i;
const EXPIRY_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_PENDING_JOBS = 20;
const pendingJobs = new Set();
const GENERIC_REQUEST_MESSAGE = "If an account matches that email, a password-reset link will be sent. Check your inbox and spam folder. Please wait a minute before requesting another link.";
const INVALID_LINK_MESSAGE = "This password-reset link is invalid or expired. Please request a new link.";
const UNAVAILABLE_MESSAGE = "Password recovery is not available yet. Please contact your Derma Insight pilot contact for help.";

function configuration(env = process.env) {
  if (env.PASSWORD_RESET_ENABLED !== "true") return null;
  const key = env.RESEND_API_KEY;
  const from = env.PASSWORD_RESET_FROM;
  if (typeof key !== "string" || !/^re_[A-Za-z0-9_-]{8,500}$/.test(key) ||
      typeof from !== "string" || from.length > 254 || !EMAIL.test(from) || /[\r\n]/.test(from)) return null;
  try {
    const origin = new URL(env.PASSWORD_RESET_APP_ORIGIN);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    return { key, from, origin: origin.origin };
  } catch { return null; }
}

function requireConfiguration() {
  const config = configuration();
  if (!config) throw new AppError(UNAVAILABLE_MESSAGE, 503);
  return config;
}

function fields(body, permitted) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== permitted.length || Object.keys(body).some(key => !permitted.includes(key))) {
    throw new AppError("The recovery request has invalid fields.", 400);
  }
  return body;
}

function requestEmail(body) {
  const { email } = fields(body, ["email"]);
  if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email.trim())) {
    throw new AppError("Please enter a valid email address.", 400);
  }
  return email.trim().toLowerCase();
}

function resetDetails(body) {
  const { id, token, password } = fields(body, ["id", "token", "password"]);
  if (typeof id !== "string" || !MERCHANT_ID.test(id) || typeof token !== "string" || !TOKEN.test(token)) {
    throw new AppError(INVALID_LINK_MESSAGE, 400);
  }
  if (typeof password !== "string" || password.length < 8 || !password.trim() || Buffer.byteLength(password, "utf8") > 72) {
    throw new AppError("Use a password of at least 8 characters and at most 72 UTF-8 bytes.", 400);
  }
  return { id, token, password };
}

const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");

async function sendEmail(config, to, subject, text, idempotencyKey) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ from: `Derma Insight <${config.from}>`, to: [to], subject, text })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const result = await response.json();
    if (typeof result.id !== "string" || !result.id || result.id.length > 200) throw new Error();
  } catch {
    // Never propagate provider bodies, request headers, reset URLs or recipients.
    throw new Error("PASSWORD_RECOVERY_EMAIL_UNCONFIRMED");
  }
}

function queueBackground(work) {
  if (pendingJobs.size >= MAX_PENDING_JOBS) {
    console.warn("PASSWORD_RECOVERY_CAPACITY_REACHED");
    return;
  }
  const job = Promise.resolve().then(work).catch(() => {
    console.warn("PASSWORD_RECOVERY_BACKGROUND_UNCONFIRMED");
  }).finally(() => pendingJobs.delete(job));
  pendingJobs.add(job);
}

async function issueReset(email, config) {
  // Refuse ambiguous legacy identities instead of selecting an arbitrary owner.
  const matches = await Merchant.find({ email }).select("_id email sessionVersion").limit(2).lean();
  if (matches.length !== 1) return;
  const merchant = matches[0];
  const version = merchant.sessionVersion === undefined ? 0 : merchant.sessionVersion;
  if (!Number.isSafeInteger(version) || version < 0) return;
  const token = crypto.randomBytes(32).toString("hex");
  const hash = tokenHash(token);
  const now = Date.now();
  const versionFilter = version === 0 ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] } : { sessionVersion: version };
  const claimed = await Merchant.findOneAndUpdate({
    _id: merchant._id, email,
    $and: [versionFilter, { $or: [
      { passwordResetRequestedAt: { $exists: false } },
      { passwordResetRequestedAt: { $lte: new Date(now - COOLDOWN_MS) } }
    ] }]
  }, { $set: {
    passwordResetTokenHash: hash, passwordResetExpiresAt: new Date(now + EXPIRY_MS), passwordResetRequestedAt: new Date(now)
  } }, { new: true, runValidators: true }).select("_id email").lean();
  if (!claimed) return;
  // The secret is in a fragment, not a query string, so it is never sent in
  // HTTP URLs to Render, access logs or the reset page's stylesheet request.
  const link = `${config.origin}/reset-password.html#id=${claimed._id}&token=${token}`;
  await sendEmail(config, claimed.email, "Reset your Derma Insight password",
    `A password reset was requested for your Derma Insight account.\n\nUse this link within 15 minutes:\n${link}\n\nThe link works once. If you did not request this, you can ignore this email; your password has not changed.`,
    `password-reset-${hash}`);
}

function requestReset(email, config) {
  // Respond before account lookup/delivery. Known, unknown, cooling-down and
  // delivery-failure cases have identical HTTP bodies, status and code paths.
  // This is bounded in-process work, not a durable queue; operators must check
  // delivery and users may request another link after the cooldown on failure.
  queueBackground(() => issueReset(email, config));
}

async function completeReset({ id, token, password }) {
  const filter = { _id: id, passwordResetTokenHash: tokenHash(token), passwordResetExpiresAt: { $gt: new Date() } };
  let merchant;
  try {
    // Avoid bcrypt work for guessed/expired links; rate limiting also applies.
    const existing = await Merchant.findOne(filter).select("_id").lean();
    if (!existing) throw new AppError(INVALID_LINK_MESSAGE, 400);
    const passwordHash = await bcrypt.hash(password, 10);
    filter.passwordResetExpiresAt = { $gt: new Date() };
    // Consuming the proof, replacing the password and revoking old sessions
    // must be one atomic document update. Concurrent replays cannot both win.
    merchant = await Merchant.findOneAndUpdate(filter, {
      $set: { password: passwordHash }, $inc: { sessionVersion: 1 },
      $unset: { passwordResetTokenHash: "", passwordResetExpiresAt: "" }
    }, { new: true, runValidators: true }).select("_id email").lean();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("We could not confirm the password change. Try signing in with the new password; otherwise request a new reset link.", 503);
  }
  if (!merchant) throw new AppError(INVALID_LINK_MESSAGE, 400);
  return merchant;
}

function notifyPasswordChanged(merchant, config) {
  queueBackground(() => sendEmail(config, merchant.email, "Your Derma Insight password was changed",
    `Your Derma Insight password was changed. Existing sign-in sessions have been invalidated.\n\nIf this was not you, request a new password reset immediately at ${config.origin}/forgot-password.html and contact your pilot support contact.\n\nNo password is included in this email.`,
    `password-changed-${crypto.randomUUID()}`));
}

async function waitForBackgroundJobs() {
  // Also usable during an orderly process shutdown; never exposed over HTTP.
  while (pendingJobs.size) await Promise.all([...pendingJobs]);
}

module.exports = { configuration, requireConfiguration, requestEmail, resetDetails, tokenHash, requestReset, completeReset,
  notifyPasswordChanged, waitForBackgroundJobs, GENERIC_REQUEST_MESSAGE, INVALID_LINK_MESSAGE, EXPIRY_MS, COOLDOWN_MS };
