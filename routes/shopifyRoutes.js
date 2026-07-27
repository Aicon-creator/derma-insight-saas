// routes/shopifyRoutes.js
const express = require("express");
const router = express.Router();
const protectMerchant = require("../middleware/merchantAuthMiddleware");
const { connectShopify, shopifyCallback, syncShopifyData } = require("../controllers/shopifyController");

router.get("/connect", protectMerchant, connectShopify);
router.get("/callback", shopifyCallback);
router.post("/sync", protectMerchant, syncShopifyData);

module.exports = router;