const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const Event = require("../models/Event");

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

    const inactiveDays = Number(req.query.inactiveDays) || 30;
    const highValueThreshold = Number(req.query.highValue) || 100;

    console.log("SEGMENT BACKEND FILTERS:", {
      inactiveDays,
      highValueThreshold
    });

    const customers = await Customer.find({
      merchantId: merchantObjectId
    }).lean();

    // Pull stats from ALL event types, not just purchases, so we can tell
    // "gone quiet" apart from "never engaged in the first place".
    const activityStats = await Event.aggregate([
      {
        $match: {
          merchantId: merchantObjectId
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

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);

    const skinTypeSegments = {};
    const concernSegments = {};
    const repeatBuyers = [];
    const inactiveCustomers = [];
    const highValueCustomers = [];
    const noPurchaseLeads = [];

    customers.forEach((customer) => {
      const customerId = String(customer._id);
      const stats = statsByCustomer.get(customerId);

      const skinType = customer.skinType || "Unknown";
      const concern = customer.concern || "Unknown";

      skinTypeSegments[skinType] = (skinTypeSegments[skinType] || 0) + 1;
      concernSegments[concern] = (concernSegments[concern] || 0) + 1;

      const lastActivityAt = stats?.lastActivityAt || null;

      const customerData = {
        id: customer._id,
        name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
        email: customer.email,
        skinType,
        concern,
        totalSpent: Number(stats?.totalSpent || 0),
        purchaseCount: Number(stats?.purchaseCount || 0),
        lastPurchaseAt: stats?.lastPurchaseAt || null,
        lastActivityAt,
        lastSeenAt: customer.lastSeenAt || null
      };

      if (customerData.purchaseCount >= 2) {
        repeatBuyers.push(customerData);
      }

      if (customerData.purchaseCount === 0) {
        noPurchaseLeads.push(customerData);
      }

      // Inactive = gone quiet, period — whether or not they ever bought.
      // No recorded activity at all also counts as inactive.
      const isStale = lastActivityAt
        ? new Date(lastActivityAt) < cutoffDate
        : true;

      if (isStale) {
        inactiveCustomers.push(customerData);
      }

      if (customerData.totalSpent >= highValueThreshold) {
        highValueCustomers.push(customerData);
      }
    });

    repeatBuyers.sort((a, b) => b.totalSpent - a.totalSpent);

    highValueCustomers.sort((a, b) => b.totalSpent - a.totalSpent);

    inactiveCustomers.sort((a, b) => {
      const dateA = a.lastActivityAt ? new Date(a.lastActivityAt) : new Date(0);
      const dateB = b.lastActivityAt ? new Date(b.lastActivityAt) : new Date(0);

      return dateA - dateB;
    });

    noPurchaseLeads.sort((a, b) => {
      const dateA = a.lastActivityAt ? new Date(a.lastActivityAt) : new Date(0);
      const dateB = b.lastActivityAt ? new Date(b.lastActivityAt) : new Date(0);

      return dateA - dateB;
    });

    res.json({
      filters: {
        inactiveDays,
        highValueThreshold
      },

      summary: {
        totalCustomers: customers.length,
        repeatBuyers: repeatBuyers.length,
        inactiveCustomers: inactiveCustomers.length,
        highValueCustomers: highValueCustomers.length,
        noPurchaseLeads: noPurchaseLeads.length
      },

      skinTypeSegments,
      concernSegments,
      repeatBuyers,
      inactiveCustomers,
      highValueCustomers,
      noPurchaseLeads
    });
  } catch (error) {
    console.error("SEGMENT ERROR:", error);

    res.status(500).json({
      message: "Failed to load customer segments"
    });
  }
};