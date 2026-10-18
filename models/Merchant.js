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
    // Legacy plaintext values are never read by the connection workflow.
    shopifyAccessToken: { type: String, default: null, select: false },
    shopifyTokenCiphertext: { type: String, default: null, select: false },
    shopifyConnectionState: { type: String, enum: ["disconnected", "connected", "reconnect_required"], default: "disconnected" },
    shopifyConnectedAt: { type: Date, default: null },
    shopifyLastSyncAt: { type: Date, default: null },
    shopifyLastSyncStatus: { type: String, enum: ["never", "running", "complete", "failed"], default: "never" },
    shopifyLastSyncSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    shopifyPendingStateHash: { type: String, select: false },
    shopifyPendingShop: { type: String, select: false },
    shopifyPendingExpiresAt: { type: Date, select: false },
    shopifyLeaseId: { type: String, select: false },
    shopifyLeaseUntil: { type: Date, select: false },

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
