const express = require("express");
const router = express.Router();

const {
  registerMerchant,
  loginMerchant,
} = require("../controllers/merchantAuthController");

router.post("/register", registerMerchant);
router.post("/login", loginMerchant);

module.exports = router;