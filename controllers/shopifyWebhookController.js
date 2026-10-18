const crypto = require("node:crypto");
const Merchant = require("../models/Merchant");
const { getShopifyConfig, normalizeShop, equalSecret } = require("../services/shopifyService");

// Mounted before express.json: Shopify signs the exact request bytes.
async function appUninstalled(req, res) {
  res.set("Cache-Control", "no-store");
  const secret = getShopifyConfig().clientSecret;
  if (!secret) return res.status(503).json({ message: "Shopify webhook verification is not configured." });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ message: "Invalid webhook body." });
  const expected = crypto.createHmac("sha256", secret).update(req.body).digest("base64");
  if (!equalSecret(expected, req.get("X-Shopify-Hmac-Sha256"))) return res.status(401).json({ message: "Invalid webhook signature." });
  try {
    const body = JSON.parse(req.body.toString("utf8"));
    const shop = normalizeShop(req.get("X-Shopify-Shop-Domain"));
    if (req.get("X-Shopify-Topic") !== "app/uninstalled" || body.myshopify_domain !== shop) {
      return res.status(400).json({ message: "Invalid uninstall notification." });
    }
    await Merchant.updateMany({ shopifyStoreDomain: shop }, {
      $set: { shopifyConnectionState: "disconnected" },
      $unset: { shopifyTokenCiphertext: 1, shopifyAccessToken: 1, shopifyPendingStateHash: 1,
        shopifyPendingShop: 1, shopifyPendingExpiresAt: 1, shopifyLeaseId: 1, shopifyLeaseUntil: 1 }
    }, { maxTimeMS: 10000 });
    return res.status(200).json({ received: true });
  } catch {
    // Retryable storage failures must not be acknowledged as processed.
    return res.status(503).json({ message: "Uninstall processing is temporarily unavailable." });
  }
}

module.exports = { appUninstalled };
