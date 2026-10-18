const mongoose = require("mongoose");

// The current source snapshot preserves order/line identities when a refund or
// removal retires a derived purchase Event. No addresses or payment details.
const schema = new mongoose.Schema({
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: "Merchant", required: true },
  shopifyStoreDomain: { type: String, required: true },
  shopifyOrderId: { type: String, required: true },
  occurredAt: { type: Date, required: true },
  sourceUpdatedAt: { type: Date, required: true },
  financialStatus: { type: String, required: true },
  cancelled: { type: Boolean, required: true },
  test: { type: Boolean, required: true },
  currency: { type: String, enum: ["GBP"], required: true },
  lines: [{ _id: false, id: String, originalQuantity: Number, quantity: Number, netAmountMinor: Number }]
}, { timestamps: true, autoCreate: false, autoIndex: false });
schema.index({ merchantId: 1, shopifyStoreDomain: 1, shopifyOrderId: 1 }, { unique: true });

module.exports = mongoose.models.ShopifyOrder || mongoose.model("ShopifyOrder", schema);
