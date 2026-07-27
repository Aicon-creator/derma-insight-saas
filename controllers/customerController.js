const Customer = require("../models/Customer");
const Event = require("../models/Event");

const getCustomers = async (req, res) => {
  try {
    const merchantId = req.merchant._id;

    const customers = await Customer.find({ merchantId })
      .select("-__v")
      .sort({ occurredAt: -1 });

    res.json({
      count: customers.length,
      customers,
    });
  } catch (error) {
    console.log("GET CUSTOMERS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

const getCustomerSegments = async (req, res) => {
  try {
    const merchantId = req.merchant._id;

    const bySkinType = await Customer.aggregate([
      { $match: { merchantId } },
      {
        $group: {
          _id: "$skinType",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      {
        $project: {
          _id: 0,
          skinType: "$_id",
          count: 1,
        },
      },
    ]);

    const byConcern = await Customer.aggregate([
      { $match: { merchantId } },
      {
        $group: {
          _id: "$concern",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      {
        $project: {
          _id: 0,
          concern: "$_id",
          count: 1,
        },
      },
    ]);

    res.json({
      segments: {
        bySkinType,
        byConcern,
      },
    });
  } catch (error) {
    console.log("GET CUSTOMER SEGMENTS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

const getRepeatBuyers = async (req, res) => {
  try {
    const merchantId = req.merchant._id;

    const repeatBuyers = await Event.aggregate([
      {
        $match: {
          merchantId,
          type: "purchase",
        },
      },
      {
        $group: {
          _id: "$customerId",
          purchaseCount: { $sum: 1 },
        },
      },
      {
        $match: {
          purchaseCount: { $gt: 1 },
        },
      },
    ]);

    const customerIds = repeatBuyers.map((r) => r._id);

    const customers = await Customer.find({
      _id: { $in: customerIds },
    }).select("-__v");

    res.json({
      count: customers.length,
      customers,
    });
  } catch (error) {
    console.log("GET REPEAT BUYERS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

const getHighValueCustomers = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const highValueCustomers = await Event.aggregate([
      {
        $match: {
          merchantId,
          type: "purchase",
        },
      },
      {
        $group: {
          _id: "$customerId",
          totalPurchases: { $sum: 1 },
          totalRevenue: {
            $sum: { $multiply: ["$price", "$quantity"] },
          },
        },
      },
      {
        $sort: {
          totalRevenue: -1,
          totalPurchases: -1,
        },
      },
      { $limit: limit },
      {
        $lookup: {
          from: "customers",
          localField: "_id",
          foreignField: "_id",
          as: "customer",
        },
      },
      { $unwind: "$customer" },
      {
        $project: {
          _id: 0,
          customerId: "$_id",
          firstName: "$customer.firstName",
          lastName: "$customer.lastName",
          email: "$customer.email",
          skinType: "$customer.skinType",
          concern: "$customer.concern",
          totalPurchases: 1,
          totalRevenue: { $round: ["$totalRevenue", 2] },
        },
      },
    ]);

    res.json({
      count: highValueCustomers.length,
      highValueCustomers,
    });
  } catch (error) {
    console.log("GET HIGH VALUE CUSTOMERS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

const getInactiveCustomers = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const days = Number(req.query.days || 30);
    const limit = Math.min(Number(req.query.limit || 20), 100);

    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Customers who made a purchase recently
    const recentPurchasers = await Event.distinct("customerId", {
      merchantId,
      type: "purchase",
      occurredAt: { $gte: cutoffDate },
    });

    // Customers who have NOT purchased recently
    const inactiveCustomers = await Customer.find({
      merchantId,
      _id: { $nin: recentPurchasers },
    })
      .select("-__v")
      .limit(limit);

    res.json({
      periodDays: days,
      count: inactiveCustomers.length,
      inactiveCustomers,
    });
  } catch (error) {
    console.log("GET INACTIVE CUSTOMERS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getCustomers,
  getCustomerSegments,
  getRepeatBuyers,
  getHighValueCustomers,
  getInactiveCustomers,
};