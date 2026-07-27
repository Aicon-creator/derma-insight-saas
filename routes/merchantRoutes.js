const express = require("express");
const router = express.Router();

const merchantAuthMiddleware = require("../middleware/merchantAuthMiddleware");

const protectMerchant =
  merchantAuthMiddleware.protectMerchant ||
  merchantAuthMiddleware.protect ||
  merchantAuthMiddleware;

router.get("/profile", protectMerchant, (req, res) => {
  res.json({
    message: "Merchant profile loaded",
    merchant: req.merchant
  });
});

module.exports = router;