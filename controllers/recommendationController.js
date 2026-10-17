const Event = require("../models/Event");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const mongoose = require("mongoose");

function toRoundedRate(numerator, denominator) {
  if (denominator <= 0) {
    return 0;
  }

  return Number(((numerator / denominator) * 100).toFixed(2));
}

function describePopularRecommendation(product) {
  if (Number(product.revenue || 0) > 0 && Number(product.purchases || 0) > 0) {
    if (product.isTopRevenueProduct) {
      return "Highest revenue in the selected period.";
    }

    if (Number(product.conversionRate || 0) >= 60) {
      return "Strong purchase activity after product views in the selected period.";
    }

    return "Strong purchase activity in the selected period with revenue already proven.";
  }

  if (Number(product.addToCart || 0) > Number(product.purchases || 0)) {
    return "Growing interest with cart activity that has room to convert into more purchases.";
  }

  if (Number(product.views || 0) > 0 && Number(product.purchases || 0) === 0) {
    return "Frequently viewed in the selected period, but purchases have not followed through yet.";
  }

  return "Strong recent engagement across customer interactions for this product.";
}

const getPopularRecommendations = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const limit = Math.min(Number(req.query.limit || 5), 20);
    const days = Number(req.query.days || 30);

    const dateFilter =
      days > 0
        ? {
            occurredAt: {
              $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
            },
          }
        : {};

    const popularProducts = await Event.aggregate([
      {
        $match: {
          merchantId,
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: {
            productId: "$productId",
            customerId: "$customerId",
          },
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
          viewed: {
            $max: { $cond: [{ $eq: ["$type", "view"] }, 1, 0] },
          },
          purchased: {
            $max: { $cond: [{ $eq: ["$type", "purchase"] }, 1, 0] },
          },
        },
      },
      {
        $group: {
          _id: "$_id.productId",
          views: { $sum: "$views" },
          addToCart: { $sum: "$addToCart" },
          purchases: { $sum: "$purchases" },
          revenue: { $sum: "$revenue" },
          uniqueViewers: { $sum: "$viewed" },
          uniquePurchasingViewers: {
            $sum: {
              $cond: [
                { $and: [{ $gt: ["$viewed", 0] }, { $gt: ["$purchased", 0] }] },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $addFields: {
          score: {
            $add: [
              { $multiply: ["$purchases", 5] },
              { $multiply: ["$addToCart", 2] },
              "$views",
            ],
          },
        },
      },
      { $sort: { score: -1, revenue: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      {
        $project: {
          _id: 0,
          productId: "$_id",
          title: "$product.title",
          category: "$product.category",
          skinType: "$product.skinType",
          concern: "$product.concern",
          price: "$product.price",
          views: 1,
          addToCart: 1,
          purchases: 1,
          revenue: { $round: ["$revenue", 2] },
          score: 1,
          uniqueViewers: 1,
          uniquePurchasingViewers: 1,
        },
      },
    ]);

    const maxRevenue = Math.max(
      0,
      ...popularProducts.map((product) => Number(product.revenue || 0))
    );
    const recommendations = popularProducts.map((product) => {
      const conversionRate = toRoundedRate(
        product.uniquePurchasingViewers || 0,
        product.uniqueViewers || 0
      );

      return {
        ...product,
        conversionRate,
        recommendationReason: describePopularRecommendation({
          ...product,
          conversionRate,
          isTopRevenueProduct:
            maxRevenue > 0 && Number(product.revenue || 0) === maxRevenue,
        }),
      };
    });

    return res.json({
      periodDays: days,
      recommendations,
    });
  } catch (error) {
    console.error("POPULAR RECOMMENDATIONS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

const getAlsoViewedRecommendations = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const { productId } = req.params;
    const limit = Math.min(Number(req.query.limit || 5), 20);
    const days = Number(req.query.days || 30);

    const dateFilter =
      days > 0
        ? {
            occurredAt: {
              $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
            },
          }
        : {};

    const targetViewEvents = await Event.find({
      merchantId,
      productId,
      type: "view",
      ...dateFilter,
    }).select("customerId");

    const customerIds = [
      ...new Set(targetViewEvents.map((e) => e.customerId.toString())),
    ];

    if (customerIds.length === 0) {
      return res.json({
        periodDays: days,
        recommendations: [],
        message: "No view history found for this product in the selected period",
      });
    }

    const recommendations = await Event.aggregate([
      {
        $match: {
          merchantId,
          type: "view",
          ...dateFilter,
          customerId: {
            $in: customerIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
          productId: { $ne: new mongoose.Types.ObjectId(productId) },
        },
      },
      {
        $group: {
          _id: "$productId",
          alsoViewedCount: { $sum: 1 },
        },
      },
      { $sort: { alsoViewedCount: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      {
        $project: {
          _id: 0,
          productId: "$_id",
          title: "$product.title",
          category: "$product.category",
          skinType: "$product.skinType",
          concern: "$product.concern",
          price: "$product.price",
          alsoViewedCount: 1,
          recommendationReason:
            "Frequently viewed by customers who viewed this product.",
        },
      },
    ]);

    return res.json({
      periodDays: days,
      recommendations,
    });
  } catch (error) {
    console.error("ALSO VIEWED RECOMMENDATIONS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

const getAlsoBoughtRecommendations = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const { productId } = req.params;
    const limit = Math.min(Number(req.query.limit || 5), 20);
    const days = Number(req.query.days || 30);

    const dateFilter =
      days > 0
        ? {
            occurredAt: {
              $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
            },
          }
        : {};

    const targetPurchaseEvents = await Event.find({
      merchantId,
      productId,
      type: "purchase",
      ...dateFilter,
    }).select("customerId");

    const customerIds = [
      ...new Set(targetPurchaseEvents.map((e) => e.customerId.toString())),
    ];

    if (customerIds.length === 0) {
      return res.json({
        periodDays: days,
        recommendations: [],
        message:
          "No purchase history found for this product in the selected period",
      });
    }

    const recommendations = await Event.aggregate([
      {
        $match: {
          merchantId,
          type: "purchase",
          ...dateFilter,
          customerId: {
            $in: customerIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
          productId: { $ne: new mongoose.Types.ObjectId(productId) },
        },
      },
      {
        $group: {
          _id: "$productId",
          alsoBoughtCount: { $sum: 1 },
          revenue: {
            $sum: { $multiply: ["$price", "$quantity"] },
          },
        },
      },
      { $sort: { alsoBoughtCount: -1, revenue: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      {
        $project: {
          _id: 0,
          productId: "$_id",
          title: "$product.title",
          category: "$product.category",
          skinType: "$product.skinType",
          concern: "$product.concern",
          price: "$product.price",
          alsoBoughtCount: 1,
          revenue: { $round: ["$revenue", 2] },
          recommendationReason:
            "Frequently purchased by customers who also bought this product.",
        },
      },
    ]);

    return res.json({
      periodDays: days,
      recommendations,
    });
  } catch (error) {
    console.error("ALSO BOUGHT RECOMMENDATIONS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

const getRecommendationsForCustomer = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const { customerId } = req.params;
    const limit = Math.min(Number(req.query.limit || 5), 20);

    const customer = await Customer.findOne({
      _id: customerId,
      merchantId,
    });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Find products already purchased by this customer
    const purchasedEvents = await Event.find({
      merchantId,
      customerId,
      type: "purchase",
    }).select("productId");

    const purchasedProductIds = [
      ...new Set(purchasedEvents.map((e) => e.productId.toString())),
    ];

    const recommendations = await Event.aggregate([
      {
        $match: {
          merchantId,
          productId: {
            $nin: purchasedProductIds.map(
              (id) => new mongoose.Types.ObjectId(id)
            ),
          },
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "productId",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      {
        $match: {
          $or: [
            { "product.skinType": customer.skinType },
            { "product.skinType": "all" },
            { "product.concern": customer.concern },
          ],
        },
      },
      {
        $group: {
          _id: "$productId",
          title: { $first: "$product.title" },
          category: { $first: "$product.category" },
          skinType: { $first: "$product.skinType" },
          concern: { $first: "$product.concern" },
          price: { $first: "$product.price" },
          purchases: {
            $sum: {
              $cond: [{ $eq: ["$type", "purchase"] }, 1, 0],
            },
          },
          views: {
            $sum: {
              $cond: [{ $eq: ["$type", "view"] }, 1, 0],
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
        $addFields: {
          score: {
            $add: [
              { $multiply: ["$purchases", 5] },
              "$views",
              {
                $cond: [{ $eq: ["$skinType", customer.skinType] }, 10, 0],
              },
              {
                $cond: [{ $eq: ["$concern", customer.concern] }, 10, 0],
              },
            ],
          },
        },
      },
      { $sort: { score: -1, revenue: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          productId: "$_id",
          title: 1,
          category: 1,
          skinType: 1,
          concern: 1,
          price: 1,
          purchases: 1,
          views: 1,
          revenue: { $round: ["$revenue", 2] },
          score: 1,
          recommendationReason: {
            $concat: [
              "Recommended for ",
              customer.skinType,
              " skin with focus on ",
              customer.concern,
              ".",
            ],
          },
        },
      },
    ]);

    return res.json({
      customer: {
        _id: customer._id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        skinType: customer.skinType,
        concern: customer.concern,
      },
      recommendations,
    });
  } catch (error) {
    console.error("CUSTOMER RECOMMENDATIONS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getPopularRecommendations,
  getAlsoViewedRecommendations,
  getAlsoBoughtRecommendations,
  getRecommendationsForCustomer,
};