const express = require("express");
const router = express.Router();

const merchantAuthMiddleware = require("../middleware/merchantAuthMiddleware");
const { getProfile, updateProfile } = require("../controllers/merchantProfileController");

const protectMerchant =
  merchantAuthMiddleware.protectMerchant ||
  merchantAuthMiddleware.protect ||
  merchantAuthMiddleware;

router.use("/profile", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/profile", protectMerchant, getProfile);
router.patch("/profile", protectMerchant, updateProfile);

module.exports = router;
