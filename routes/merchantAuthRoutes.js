const express = require("express");
const router = express.Router();

const {
  registerMerchant,
  loginMerchant,
} = require("../controllers/merchantAuthController");
const { recoveryStatus, forgotPassword, resetPassword } = require("../controllers/passwordRecoveryController");
const { requestResetLimiter, completeResetLimiter } = require("../middleware/passwordRecoveryRateLimiter");

router.post("/register", registerMerchant);
router.post("/login", loginMerchant);
router.use(["/password-recovery", "/forgot-password", "/reset-password"], (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  next();
});
router.get("/password-recovery", recoveryStatus);
router.post("/forgot-password", requestResetLimiter, forgotPassword);
router.post("/reset-password", completeResetLimiter, resetPassword);

module.exports = router;
