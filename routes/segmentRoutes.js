const express = require("express");
const router = express.Router();

const merchantAuthMiddleware = require("../middleware/merchantAuthMiddleware");

const protectMerchant =
  merchantAuthMiddleware.protectMerchant ||
  merchantAuthMiddleware.protect ||
  merchantAuthMiddleware;

const { getCustomerSegments } = require("../controllers/segmentController");

router.get("/", protectMerchant, getCustomerSegments);

module.exports = router;