const express = require("express");
const router = express.Router();

const protectMerchant  = require("../middleware/merchantAuthMiddleware");
const {
  getCustomers,
  getCustomerSegments,
  getRepeatBuyers,
  getHighValueCustomers,
  getInactiveCustomers,
} = require("../controllers/customerController");

router.get("/", protectMerchant, getCustomers);
router.get("/segments", protectMerchant, getCustomerSegments);
router.get("/repeat-buyers", protectMerchant, getRepeatBuyers);
router.get("/high-value", protectMerchant, getHighValueCustomers);
router.get("/inactive", protectMerchant, getInactiveCustomers);

module.exports = router;