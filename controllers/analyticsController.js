const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");

const mongoose = require("mongoose");

function getMerchantId(req) {
  const merchantId =
    req.merchant?._id ||
    req.merchant?.id ||
    req.user?._id ||
    req.user?.id ||
    req.merchantId ||
    req.userId ||
    req.auth?.merchantId ||
    req.auth?.id;

  if (!merchantId) {
    throw new Error("Merchant not authenticated");
  }

  return mongoose.Types.ObjectId.isValid(String(merchantId))
    ? new mongoose.Types.ObjectId(merchantId)
    : merchantId;
}

const getOverviewAnalytics = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const days = Number(req.query.days || 30);

    const cutoffDate = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    );

    const matchStage = {
      merchantId,
      occurredAt: { $gte: cutoffDate },
    };

    // 🔥 ONE aggregation instead of multiple queries
    const stats = await Event.aggregate([
      {
        $match: matchStage,
      },
      {
        $group: {
          _id: null,
          totalEvents: { $sum: 1 },

          totalViews: {
            $sum: { $cond: [{ $eq: ["$type", "view"] }, 1, 0] },
          },

          totalAddToCart: {
            $sum: { $cond: [{ $eq: ["$type", "add_to_cart"] }, 1, 0] },
          },

          totalPurchases: {
            $sum: { $cond: [{ $eq: ["$type", "purchase"] }, 1, 0] },
          },

          totalRevenue: {
            $sum: {
              $cond: [
                { $eq: ["$type", "purchase"] },
                { $multiply: ["$price", "$quantity"] },
                0,
              ],
            },
          },
        },
      },
    ]);

    const result = stats[0] || {
      totalEvents: 0,
      totalViews: 0,
      totalAddToCart: 0,
      totalPurchases: 0,
      totalRevenue: 0,
    };

    // Static totals (still fine separately)
    const totalCustomers = await Customer.countDocuments({ merchantId });
    const totalProducts = await Product.countDocuments({ merchantId });

    const conversionRate =
      result.totalViews > 0
        ? Number(((result.totalPurchases / result.totalViews) * 100).toFixed(2))
        : 0;

    // 🔥 Keep your insights (good feature)
    const revenueLast7 = await Event.aggregate([
      {
        $match: {
          merchantId,
          type: "purchase",
          occurredAt: {
            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$price", "$quantity"] } },
        },
      },
    ]);

    const revenueLast30 = await Event.aggregate([
      {
        $match: {
          merchantId,
          type: "purchase",
          occurredAt: {
            $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$price", "$quantity"] } },
        },
      },
    ]);

    res.json({
      summary: {
        periodDays: days,
        totalCustomers,
        totalProducts,
        totalEvents: result.totalEvents,
        totalViews: result.totalViews,
        totalAddToCart: result.totalAddToCart,
        totalPurchases: result.totalPurchases,
        totalRevenue: Number(result.totalRevenue.toFixed(2)),
        conversionRate,

        revenueLast7Days:
          revenueLast7.length > 0
            ? Number(revenueLast7[0].total.toFixed(2))
            : 0,

        revenueLast30Days:
          revenueLast30.length > 0
            ? Number(revenueLast30[0].total.toFixed(2))
            : 0,
      },
    });
  } catch (error) {
    console.log("ANALYTICS ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

const getTopProducts = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const limit = Math.min(Number(req.query.limit || 5), 20);
    const days = Number(req.query.days || 30);

    const cutoffDate = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    );

    const pipeline = [
      {
        $match: {
          merchantId,
          occurredAt: { $gte: cutoffDate },
        },
      },
      {
        $group: {
          _id: {
            productId: "$productId",
            type: "$type",
          },
          count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$type", "purchase"] },
                { $multiply: ["$price", "$quantity"] },
                0,
              ],
            },
          },
        },
      },
      {
        $group: {
          _id: "$_id.productId",
          views: {
            $sum: {
              $cond: [{ $eq: ["$_id.type", "view"] }, "$count", 0],
            },
          },
          addToCart: {
            $sum: {
              $cond: [{ $eq: ["$_id.type", "add_to_cart"] }, "$count", 0],
            },
          },
          purchases: {
            $sum: {
              $cond: [{ $eq: ["$_id.type", "purchase"] }, "$count", 0],
            },
          },
          revenue: { $sum: "$revenue" },
        },
      },
      {
        $sort: {
          revenue: -1,
          purchases: -1,
          addToCart: -1,
          views: -1,
        },
      },
      { $limit: limit },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      {
        $unwind: {
          path: "$product",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $project: {
          _id: 0,
          productId: "$_id",
          title: "$product.title",
          category: "$product.category",
          skinType: "$product.skinType",
          concern: "$product.concern",
          views: 1,
          addToCart: 1,
          purchases: 1,
          revenue: { $round: ["$revenue", 2] },
          conversionRate: {
            $cond: [
              { $gt: ["$views", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$purchases", "$views"] },
                      100,
                    ],
                  },
                  2,
                ],
              },
              0,
            ],
          },
        },
      },
    ];

    const topProducts = await Event.aggregate(pipeline);

    return res.json({
      periodDays: days,
      topProducts,
    });
  } catch (error) {
    console.log("TOP PRODUCTS ANALYTICS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

const getSkinTypeAnalytics = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const days = Number(req.query.days || 30);

    const cutoffDate = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    );

    const pipeline = [
      {
        $match: {
          merchantId,
          occurredAt: { $gte: cutoffDate },
        },
      },
      {
        $lookup: {
          from: "customers",
          localField: "customerId",
          foreignField: "_id",
          as: "customer",
        },
      },
      {
        $unwind: {
          path: "$customer",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: "$customer.skinType",
          customerIds: { $addToSet: "$customerId" },

          views: {
            $sum: {
              $cond: [{ $eq: ["$type", "view"] }, 1, 0],
            },
          },

          addToCart: {
            $sum: {
              $cond: [{ $eq: ["$type", "add_to_cart"] }, 1, 0],
            },
          },

          purchases: {
            $sum: {
              $cond: [{ $eq: ["$type", "purchase"] }, 1, 0],
            },
          },

          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$type", "purchase"] },
                { $multiply: ["$price", "$quantity"] },
                0,
              ],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          skinType: {
            $ifNull: ["$_id", "unknown"],
          },
          customers: { $size: "$customerIds" },
          views: 1,
          addToCart: 1,
          purchases: 1,
          revenue: { $round: ["$revenue", 2] },
          conversionRate: {
            $cond: [
              { $gt: ["$views", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$purchases", "$views"] },
                      100,
                    ],
                  },
                  2,
                ],
              },
              0,
            ],
          },
        },
      },
      {
        $sort: {
          revenue: -1,
          purchases: -1,
          views: -1,
        },
      },
    ];

    const skinTypeInsights = await Event.aggregate(pipeline);

    return res.json({
      periodDays: days,
      skinTypeInsights,
    });
  } catch (error) {
    console.log("SKIN TYPE ANALYTICS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

const getConcernAnalytics = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const days = Number(req.query.days || 30);

    const cutoffDate = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    );

    const pipeline = [
      {
        $match: {
          merchantId,
          occurredAt: { $gte: cutoffDate },
        },
      },
      {
        $lookup: {
          from: "customers",
          localField: "customerId",
          foreignField: "_id",
          as: "customer",
        },
      },
      {
        $unwind: {
          path: "$customer",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: "$customer.concern",
          customerIds: { $addToSet: "$customerId" },

          views: {
            $sum: {
              $cond: [{ $eq: ["$type", "view"] }, 1, 0],
            },
          },

          addToCart: {
            $sum: {
              $cond: [{ $eq: ["$type", "add_to_cart"] }, 1, 0],
            },
          },

          purchases: {
            $sum: {
              $cond: [{ $eq: ["$type", "purchase"] }, 1, 0],
            },
          },

          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$type", "purchase"] },
                { $multiply: ["$price", "$quantity"] },
                0,
              ],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          concern: {
            $ifNull: ["$_id", "unknown"],
          },
          customers: { $size: "$customerIds" },
          views: 1,
          addToCart: 1,
          purchases: 1,
          revenue: { $round: ["$revenue", 2] },
          conversionRate: {
            $cond: [
              { $gt: ["$views", 0] },
              {
                $round: [
                  {
                    $multiply: [
                      { $divide: ["$purchases", "$views"] },
                      100,
                    ],
                  },
                  2,
                ],
              },
              0,
            ],
          },
        },
      },
      {
        $sort: {
          revenue: -1,
          purchases: -1,
          views: -1,
        },
      },
    ];

    const concernInsights = await Event.aggregate(pipeline);

    return res.json({
      periodDays: days,
      concernInsights,
    });
  } catch (error) {
    console.log("CONCERN ANALYTICS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

// GET /api/analytics/revenue-over-time
const getRevenueOverTime = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const days = Number(req.query.days || 30);

    const cutoffDate = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000
    );

    const data = await Event.aggregate([
      {
        $match: {
          merchantId,
          type: "purchase",
          occurredAt: { $gte: cutoffDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$occurredAt",
            },
          },
          revenue: {
            $sum: {
              $multiply: ["$price", "$quantity"],
            },
          },
          purchases: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 1,
          revenue: { $round: ["$revenue", 2] },
          purchases: 1,
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      periodDays: days,
      data,
    });
  } catch (error) {
    console.log("REVENUE OVER TIME ERROR:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getOverviewAnalytics,
  getTopProducts,
  getSkinTypeAnalytics,
  getConcernAnalytics,
  getRevenueOverTime,
};