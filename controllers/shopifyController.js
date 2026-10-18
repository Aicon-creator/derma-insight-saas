const crypto = require("node:crypto");
const Merchant = require("../models/Merchant");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const shopify = require("../services/shopifyService");
const sync = require("../services/shopifySync");

const COOKIE = "di_shopify_oauth";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const noLease = () => ({ $or: [{ shopifyLeaseUntil: { $exists: false } }, { shopifyLeaseUntil: null }, { shopifyLeaseUntil: { $lte: new Date() } }] });
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/shopify/callback", maxAge: 600000 });
const signedCookie = (state, secret) => `${state}.${crypto.createHmac("sha256", secret).update(`cookie:${state}`).digest("hex")}`;

function safeStatus(merchant, configured) {
  const busy = merchant.shopifyLeaseUntil && new Date(merchant.shopifyLeaseUntil) > new Date();
  return {
    configured, connected: merchant.shopifyConnectionState === "connected",
    shop: merchant.shopifyStoreDomain || null, connectedAt: merchant.shopifyConnectedAt || null,
    lastSyncAt: merchant.shopifyLastSyncAt || null,
    syncStatus: busy ? "running" : merchant.shopifyLastSyncStatus === "running" ? "interrupted" : merchant.shopifyLastSyncStatus || "never",
    summary: safeSummary(merchant.shopifyLastSyncSummary),
    reconnectRequired: merchant.shopifyConnectionState === "reconnect_required",
    historyDays: 60,
    includeTestOrders: shopify.getShopifyConfig().includeTestOrders,
    dataNote: "Manual sync imports the last 60 days of orders. Sales use GBP merchandise amounts after discounts and refunded/removed units, excluding tax, shipping and general order adjustments. Browsing and cart tracking are not imported."
  };
}

function safeSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const fields = ["customersProcessed", "productsProcessed", "ordersProcessed", "purchasesImported", "purchasesUpdated", "purchasesUnchanged", "purchasesRetired", "guestPurchaseLines", "unknownProductLines", "excludedTestOrders", "excludedUnpaidOrCancelledOrders", "historyDays"];
  return Object.fromEntries(fields.filter(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0).map(key => [key, summary[key]]));
}

const getShopifyStatus = asyncHandler(async (req, res) => {
  const merchant = await Merchant.findById(req.merchant._id).select("shopifyStoreDomain shopifyConnectionState shopifyConnectedAt shopifyLastSyncAt shopifyLastSyncStatus shopifyLastSyncSummary +shopifyLeaseUntil");
  if (!merchant) throw new AppError("Merchant not found.", 404);
  res.json(safeStatus(merchant, shopify.getShopifyConfig().configured));
});

const connectShopify = asyncHandler(async (req, res) => {
  const config = shopify.requireShopifyConfig();
  const shop = shopify.normalizeShop(req.query.shop);
  await sync.assertDatabaseReady();
  const state = crypto.randomBytes(32).toString("hex");
  const merchant = await Merchant.findOneAndUpdate({ _id: req.merchant._id,
    $and: [noLease(), { $or: [{ shopifyStoreDomain: null }, { shopifyStoreDomain: shop }] }] },
  { $set: { shopifyPendingStateHash: hash(state), shopifyPendingShop: shop,
    shopifyPendingExpiresAt: new Date(Date.now() + 600000) } }, { new: true, runValidators: true, maxTimeMS: 10000 });
  if (!merchant) throw new AppError("A sync is running, or this account belongs to another store. Use the original store or a separate account.", 409);
  res.cookie(COOKIE, signedCookie(state, config.clientSecret), cookieOptions());
  res.json({ authorizeUrl: shopify.buildAuthorizeUrl(shop, state, config) });
});

const shopifyCallback = asyncHandler(async (req, res) => {
  const config = shopify.requireShopifyConfig();
  const { shop, code, state } = shopify.validateCallback(req.originalUrl, config.clientSecret);
  let cookie;
  try {
    cookie = (req.headers.cookie || "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (cookie.length !== 1) throw new Error();
    cookie = decodeURIComponent(cookie[0].slice(COOKIE.length + 1));
  } catch { throw new AppError("Shopify browser verification failed. Start the connection again.", 403); }
  if (!shopify.equalSecret(cookie, signedCookie(state, config.clientSecret))) throw new AppError("Shopify browser verification failed. Start the connection again.", 403);
  const leaseId = crypto.randomBytes(24).toString("hex");
  const merchant = await Merchant.findOneAndUpdate({ shopifyPendingStateHash: hash(state), shopifyPendingShop: shop,
    shopifyPendingExpiresAt: { $gt: new Date() }, ...noLease() },
  { $set: { shopifyLeaseId: leaseId, shopifyLeaseUntil: new Date(Date.now() + 180000) },
    $unset: { shopifyPendingStateHash: 1, shopifyPendingShop: 1, shopifyPendingExpiresAt: 1 } },
  { new: true, maxTimeMS: 10000 });
  if (!merchant) throw new AppError("This connection request expired, was already used, or is busy. Start again.", 409);
  res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
  try {
    const tokens = await shopify.exchangeToken(shop, { code, expiring: "1" }, config);
    const updated = await Merchant.updateOne({ _id: merchant._id, shopifyLeaseId: leaseId }, {
      $set: { shopifyTokenCiphertext: shopify.sealTokens(tokens, merchant._id, shop, config.encryptionKey),
        shopifyStoreDomain: shop, shopifyConnectionState: "connected", shopifyConnectedAt: new Date(), platformType: "shopify" },
      $unset: { shopifyAccessToken: 1 }
    }, { runValidators: true, maxTimeMS: 10000 });
    if (updated.matchedCount !== 1) throw new AppError("The connection changed. Start Shopify connection again.", 409);
    res.redirect(303, "/settings.html?shopify=connected#shopify-connection");
  } finally {
    await Merchant.updateOne({ _id: merchant._id, shopifyLeaseId: leaseId }, { $unset: { shopifyLeaseId: 1, shopifyLeaseUntil: 1 } }, { maxTimeMS: 10000 }).catch(() => {});
  }
});

const syncShopifyData = asyncHandler(async (req, res) => {
  const config = shopify.requireShopifyConfig();
  await sync.assertDatabaseReady();
  const leaseId = crypto.randomBytes(24).toString("hex");
  const merchant = await Merchant.findOneAndUpdate({ _id: req.merchant._id, shopifyConnectionState: "connected", ...noLease() },
  { $set: { shopifyLeaseId: leaseId, shopifyLeaseUntil: new Date(Date.now() + 180000), shopifyLastSyncStatus: "running" } },
  { new: true, maxTimeMS: 10000 }).select("+shopifyTokenCiphertext");
  if (!merchant) throw new AppError("Connect Shopify first, or wait for the current sync to finish.", 409);
  const deadline = Date.now() + 80000;
  try {
    const shop = shopify.normalizeShop(merchant.shopifyStoreDomain);
    let tokens = shopify.openTokens(merchant.shopifyTokenCiphertext, merchant._id, shop, config.encryptionKey);
    if (tokens.expiresAt <= Date.now() + 120000) {
      if (!tokens.refreshToken || tokens.refreshExpiresAt && tokens.refreshExpiresAt <= Date.now()) throw new AppError("Shopify access expired. Reconnect the store.", 409);
      tokens = await shopify.exchangeToken(shop, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }, config, deadline);
      const saved = await Merchant.updateOne({ _id: merchant._id, shopifyLeaseId: leaseId, shopifyConnectionState: "connected" },
        { $set: { shopifyTokenCiphertext: shopify.sealTokens(tokens, merchant._id, shop, config.encryptionKey) } }, { maxTimeMS: 10000 });
      if (saved.matchedCount !== 1) throw new AppError("The store connection changed. Reconnect Shopify.", 409);
    }
    const snapshot = await sync.fetchSnapshot(shop, tokens.accessToken, config, deadline);
    snapshot.includeTestOrders = config.includeTestOrders;
    const summary = await sync.persistSnapshot(snapshot, merchant._id, shop, leaseId, deadline);
    const saved = await Merchant.updateOne({ _id: merchant._id, shopifyLeaseId: leaseId, shopifyConnectionState: "connected" },
      { $set: { shopifyLastSyncAt: new Date(), shopifyLastSyncStatus: "complete", shopifyLastSyncSummary: summary } }, { maxTimeMS: 10000 });
    if (saved.matchedCount !== 1) throw new AppError("The store connection changed before the sync could be confirmed.", 409);
    res.json({ message: "Shopify sync complete.", summary });
  } catch (error) {
    await Merchant.updateOne({ _id: merchant._id, shopifyLeaseId: leaseId }, { $set: {
      shopifyLastSyncStatus: "failed", shopifyLastSyncSummary: error.syncSummary || null
    } }, { maxTimeMS: 10000 }).catch(() => {});
    throw error;
  } finally {
    await Merchant.updateOne({ _id: merchant._id, shopifyLeaseId: leaseId }, { $unset: { shopifyLeaseId: 1, shopifyLeaseUntil: 1 } }, { maxTimeMS: 10000 }).catch(() => {});
  }
});

const disconnectShopify = asyncHandler(async (req, res) => {
  // Disconnect remains available when the integration flag/credentials change.
  const merchant = await Merchant.findOneAndUpdate({ _id: req.merchant._id, ...noLease() }, {
    $set: { shopifyConnectionState: "disconnected" },
    $unset: { shopifyTokenCiphertext: 1, shopifyAccessToken: 1, shopifyPendingStateHash: 1, shopifyPendingShop: 1, shopifyPendingExpiresAt: 1 }
  }, { new: true, maxTimeMS: 10000 });
  if (!merchant) throw new AppError("Wait for the current sync to finish before disconnecting.", 409);
  res.json({ message: "Disconnected. Imported records remain available. Uninstall the app in Shopify to remove its permissions there." });
});

module.exports = { getShopifyStatus, connectShopify, shopifyCallback, syncShopifyData, disconnectShopify, safeStatus, signedCookie, safeSummary };
