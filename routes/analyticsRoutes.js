const express = require("express");
const router = express.Router();

const merchantAuthMiddleware = require("../middleware/merchantAuthMiddleware");

const protectMerchant =
  merchantAuthMiddleware.protectMerchant ||
  merchantAuthMiddleware.protect ||
  merchantAuthMiddleware;

const {
  getOverviewAnalytics,
  getTopProducts,
  getSkinTypeAnalytics,
  getConcernAnalytics,
  getRevenueOverTime
} = require("../controllers/analyticsController");

router.get("/overview", protectMerchant, getOverviewAnalytics);
router.get("/top-products", protectMerchant, getTopProducts);
router.get("/skin-type", protectMerchant, getSkinTypeAnalytics);
router.get("/concern", protectMerchant, getConcernAnalytics);
router.get("/revenue-over-time", protectMerchant, getRevenueOverTime);

module.exports = router;