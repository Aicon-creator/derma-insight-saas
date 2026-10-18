const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: function () { return (this.source || this.getUpdate?.().$set?.source) !== "shopify"; },
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: function () { return (this.source || this.getUpdate?.().$set?.source) !== "shopify"; },
      index: true,
    },

    type: {
      type: String,
      enum: ["view", "add_to_cart", "purchase"],
      required: true,
      index: true,
    },

    quantity: { type: Number, default: 1 },
    price: { type: Number, default: 0 }, // snapshot at time of purchase
    currency: { type: String, default: "GBP" },

    sessionId: { type: String, default: null },
    sourceEventId: { type: String, trim: true, default: null },
    dedupeKey: { type: String, trim: true, default: null },
    source: { type: String, enum: ["csv", "shopify"], default: null },
    shopifyStoreDomain: { type: String, default: null },
    shopifyOrderId: { type: String, default: null },
    shopifyLineItemId: { type: String, default: null },
    occurredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

eventSchema.index(
  { merchantId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      dedupeKey: { $type: "string" }
    }
  }
);

module.exports = mongoose.models.Event || mongoose.model("Event", eventSchema);
