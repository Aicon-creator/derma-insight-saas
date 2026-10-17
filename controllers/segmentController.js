const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const Event = require("../models/Event");
const getAnalyticsWindow = require("../utils/analyticsWindow");

exports.getCustomerSegments = async (req, res) => {
  try {
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
      return res.status(401).json({
        message: "Merchant not authenticated"
      });
    }

    const merchantObjectId = mongoose.Types.ObjectId.isValid(String(merchantId))
      ? new mongoose.Types.ObjectId(merchantId)
      : merchantId;

    const period = getAnalyticsWindow(req.query.inactiveDays, "inactiveDays");
    const inactiveDays = period.days;
    const highValueThreshold = Number(req.query.highValue) || 100;

    const customers = await Customer.find({
      merchantId: merchantObjectId
    }).lean();

    // Pull stats from ALL event types, not just purchases, so we can tell
    // "gone quiet" apart from "never engaged in the first place".
    const activityStats = await Event.aggregate([
      {
        $match: {
          merchantId: merchantObjectId,
          occurredAt: { $lte: period.endAt }
        }
      },
      {
        $group: {
          _id: "$customerId",
          lastActivityAt: { $max: "$occurredAt" },
          totalSpent: {
            $sum: {
              $cond: [
                { $eq: ["$type", "purchase"] },
                {
                  $multiply: [
                    { $ifNull: ["$price", 0] },
                    { $ifNull: ["$quantity", 1] }
                  ]
                },
                0
              ]
            }
          },
          purchaseCount: {
            $sum: { $cond: [{ $eq: ["$type", "purchase"] }, 1, 0] }
          },
          viewCount: {
            $sum: { $cond: [{ $eq: ["$type", "view"] }, 1, 0] }
          },
          addToCartCount: {
            $sum: { $cond: [{ $eq: ["$type", "add_to_cart"] }, 1, 0] }
          },
          lastPurchaseAt: {
            $max: {
              $cond: [{ $eq: ["$type", "purchase"] }, "$occurredAt", null]
            }
          }
        }
      }
    ]);

    const statsByCustomer = new Map(
      activityStats.map((item) => [String(item._id), item])
    );

    const cutoffDate = period.startAt;

    const skinTypeSegments = {};
    const concernSegments = {};
    const activeCustomers = [];
    const repeatBuyers = [];
    const inactiveCustomers = [];
    const noActivityCustomers = [];
    const viewedNoPurchaseCustomers = [];
    const highValueCustomers = [];

    customers.forEach((customer) => {
      const customerId = String(customer._id);
      const stats = statsByCustomer.get(customerId);

      const skinType = customer.skinType || "Unknown";
      const concern = customer.concern || "Unknown";

      skinTypeSegments[skinType] = (skinTypeSegments[skinType] || 0) + 1;
      concernSegments[concern] = (concernSegments[concern] || 0) + 1;

      const lastActivityAt = stats?.lastActivityAt || null;
      const purchaseCount = Number(stats?.purchaseCount || 0);
      const viewCount = Number(stats?.viewCount || 0);
      const addToCartCount = Number(stats?.addToCartCount || 0);
      const hasActivity = Boolean(lastActivityAt);
      const hasRecentActivity = hasActivity && new Date(lastActivityAt) >= cutoffDate;
      const activityStatus = hasActivity
        ? hasRecentActivity
          ? "active"
          : "inactive"
        : "no_activity";

      const customerData = {
        id: customer._id,
        name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
        email: customer.email,
        skinType,
        concern,
        totalSpent: Number(stats?.totalSpent || 0),
        purchaseCount,
        viewCount,
        addToCartCount,
        lastPurchaseAt: stats?.lastPurchaseAt || null,
        lastActivityAt,
        lastSeenAt: customer.lastSeenAt || null,
        activityStatus
      };

      if (activityStatus === "active") {
        activeCustomers.push(customerData);
      }

      if (customerData.purchaseCount >= 2) {
        repeatBuyers.push(customerData);
      }

      if (activityStatus === "no_activity") {
        noActivityCustomers.push(customerData);
      }

      if (activityStatus === "inactive") {
        inactiveCustomers.push(customerData);
      }

      if (customerData.viewCount > 0 && customerData.purchaseCount === 0) {
        viewedNoPurchaseCustomers.push(customerData);
      }

      if (customerData.totalSpent >= highValueThreshold) {
        highValueCustomers.push(customerData);
      }
    });

    activeCustomers.sort((a, b) => {
      const dateA = a.lastActivityAt ? new Date(a.lastActivityAt) : new Date(0);
      const dateB = b.lastActivityAt ? new Date(b.lastActivityAt) : new Date(0);

      return dateB - dateA;
    });
    repeatBuyers.sort((a, b) => b.totalSpent - a.totalSpent);
    highValueCustomers.sort((a, b) => b.totalSpent - a.totalSpent);
    inactiveCustomers.sort((a, b) => {
      const dateA = a.lastActivityAt ? new Date(a.lastActivityAt) : new Date(0);
      const dateB = b.lastActivityAt ? new Date(b.lastActivityAt) : new Date(0);

      return dateA - dateB;
    });
    noActivityCustomers.sort((a, b) => a.name.localeCompare(b.name));
    viewedNoPurchaseCustomers.sort((a, b) => {
      if (b.viewCount !== a.viewCount) {
        return b.viewCount - a.viewCount;
      }

      return a.name.localeCompare(b.name);
    });

    res.json({
      filters: {
        inactiveDays,
        highValueThreshold
      },
      definitions: {
        activeCustomers:
          "Customers with at least one event whose most recent activity falls within the selected activity window.",
        inactiveCustomers:
          "Customers with event history whose most recent activity falls outside the selected activity window.",
        noActivityCustomers:
          "Customers with no recorded event history yet.",
        viewedNoPurchaseCustomers:
          "Customers with at least one recorded view event and no recorded purchase events.",
        repeatBuyers: "Customers with two or more purchase events.",
        highValueCustomers:
          "Customers whose total recorded purchase revenue meets or exceeds the selected high-value threshold.",
        overlapNotes:
          "Active, inactive, and no activity yet are mutually exclusive activity buckets. Viewed no purchase, repeat buyers, and high value can overlap with them."
      },
      summary: {
        totalCustomers: customers.length,
        activeCustomers: activeCustomers.length,
        repeatBuyers: repeatBuyers.length,
        inactiveCustomers: inactiveCustomers.length,
        noActivityCustomers: noActivityCustomers.length,
        viewedNoPurchaseCustomers: viewedNoPurchaseCustomers.length,
        highValueCustomers: highValueCustomers.length,
        noPurchaseLeads: noActivityCustomers.length
      },
      skinTypeSegments,
      concernSegments,
      activeCustomers,
      repeatBuyers,
      inactiveCustomers,
      noActivityCustomers,
      viewedNoPurchaseCustomers,
      highValueCustomers,
      noPurchaseLeads: noActivityCustomers
    });
  } catch (error) {
    console.error("SEGMENT ERROR:", error);

    res.status(error.statusCode || 500).json({
      message: error.isOperational ? error.message : "Failed to load customer segments"
    });
  }
};