// routes/shopifyRoutes.js
const express = require("express");
const router = express.Router();
const protectMerchant = require("../middleware/merchantAuthMiddleware");
const handlers = require("../controllers/shopifyController");
const { getShopifyConfig, TEMPORARY_MESSAGE } = require("../services/shopifyService");

router.use((req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  // The status and local disconnect controls always remain available.
  if (["/connect", "/callback", "/sync"].includes(req.path) && !getShopifyConfig().configured) {
    return res.status(503).json({ message: TEMPORARY_MESSAGE });
  }
  next();
});
router.get("/status", protectMerchant, handlers.getShopifyStatus);
router.get("/connect", protectMerchant, handlers.connectShopify);
router.get("/callback", handlers.shopifyCallback);
router.post("/sync", protectMerchant, handlers.syncShopifyData);
router.post("/disconnect", protectMerchant, handlers.disconnectShopify);

// Driver and upstream errors can include credentials and customer values.
router.use((error, req, res, next) => {
  const operational = error.isOperational === true;
  res.status(operational ? error.statusCode : 503).json({
    message: operational ? error.message : req.path === "/sync"
      ? "Shopify sync could not finish. Some records may already be saved; retry safely."
      : "Shopify could not complete the operation. Retry shortly.",
    ...(error.syncSummary ? { summary: error.syncSummary, complete: false } : {})
  });
});

module.exports = router;
