const mongoose = require("mongoose");

const importBatchSchema = new mongoose.Schema(
  {
    merchantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Merchant",
      required: true,
      index: true
    },
    dataType: {
      type: String,
      enum: ["customers", "products", "events"],
      required: true,
      index: true
    },
    originalFileName: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      enum: ["previewed", "validated", "imported", "failed"],
      default: "previewed",
      index: true
    },
    totalRows: {
      type: Number,
      default: 0
    },
    previewRows: {
      type: Number,
      default: 0
    },
    validationErrorCount: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.ImportBatch || mongoose.model("ImportBatch", importBatchSchema);
