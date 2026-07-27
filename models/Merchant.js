const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const merchantSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email"],
    },
    password: { type: String, required: true, minlength: 6 },

    platformType: { type: String, enum: ["custom", "shopify"], default: "custom" },
    shopifyStoreDomain: { type: String, default: null },
    shopifyAccessToken: { type: String, default: null },

    subscriptionTier: { type: String, default: "free" },
  },
  { timestamps: true }
);

merchantSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);

});

module.exports = mongoose.models.Merchant || mongoose.model("Merchant", merchantSchema);