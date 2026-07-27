const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true,
    },

    title: { type: String, required: true, trim: true },
    handle: { type: String, required: true, trim: true }, // url-friendly slug
    brand: { type: String, default: null },

    category: {
      type: String,
      enum: ["cleanser", "moisturizer", "serum", "sunscreen", "treatment", "toner", "mask", "other"],
      default: "other",
      index: true,
    },

    skinType: {
      type: String,
      enum: ["oily", "dry", "combination", "normal", "sensitive", "all"],
      default: "all",
      index: true,
    },

    concern: {
      type: String,
      enum: ["acne", "hyperpigmentation", "aging", "dullness", "texture", "hydration", "none"],
      default: "none",
      index: true,
    },

    price: { type: Number, default: 0 },
    currency: { type: String, default: "GBP" },

    imageUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Product || mongoose.model("Product", productSchema);