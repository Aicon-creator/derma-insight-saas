const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },

    firstName: { type: String, default: "Test" },
    lastName: { type: String, default: "Customer" },
    email: { type: String, default: null },

    skinType: {
      type: String,
      enum: ["oily", "dry", "combination", "normal", "sensitive"],
      default: "normal",
      index: true,
    },

    concern: {
      type: String,
      enum: ["acne", "hyperpigmentation", "aging", "dullness", "texture", "hydration"],
      default: "hydration",
      index: true,
    },

    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Customer || mongoose.model("Customer", customerSchema);