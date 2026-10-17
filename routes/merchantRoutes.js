const express = require("express");
const router = express.Router();

const merchantAuthMiddleware = require("../middleware/merchantAuthMiddleware");

const protectMerchant =
  merchantAuthMiddleware.protectMerchant ||
  merchantAuthMiddleware.protect ||
  merchantAuthMiddleware;

router.get("/profile", protectMerchant, (req, res) => {
  const merchant = req.merchant;
  res.set("Cache-Control", "no-store");
  res.json({
    message: "Merchant profile loaded",
    // An allowlist prevents current and future server-only fields from leaking.
    merchant: {
      _id: merchant._id,
      businessName: merchant.businessName,
      ownerName: merchant.ownerName,
      email: merchant.email,
      platformType: merchant.platformType,
      subscriptionTier: merchant.subscriptionTier
    }
  });
});

module.exports = router;
