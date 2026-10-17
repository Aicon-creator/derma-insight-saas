const express = require("express");
const router = express.Router();
const { blockProductionDemo } = require("../middleware/productionGuards");

// Run before authentication or controllers so no demo database work can begin.
router.use(blockProductionDemo);

const protectMerchant = require("../middleware/merchantAuthMiddleware");

const {
  generateTestCustomers,
  generateTestProducts,
  generateTestEvents
} = require("../controllers/simController");

router.post("/customers", protectMerchant, generateTestCustomers);
router.post("/products", protectMerchant, generateTestProducts);
router.post("/events", protectMerchant, generateTestEvents);

module.exports = router;
