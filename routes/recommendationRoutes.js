const express = require("express");
const router = express.Router();

const protectMerchant  = require("../middleware/merchantAuthMiddleware");
const {
  getPopularRecommendations,
  getAlsoViewedRecommendations,
  getAlsoBoughtRecommendations,
  getRecommendationsForCustomer,
} = require("../controllers/recommendationController");

router.get("/popular", protectMerchant, getPopularRecommendations);
router.get("/also-viewed/:productId", protectMerchant, getAlsoViewedRecommendations);
router.get("/also-bought/:productId", protectMerchant, getAlsoBoughtRecommendations);
router.get("/for-customer/:customerId", protectMerchant, getRecommendationsForCustomer);

module.exports = router;