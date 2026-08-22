const express = require("express");
const multer = require("multer");

const merchantAuthMiddleware = require("../middleware/merchantAuthMiddleware");
const { previewCsvImport } = require("../controllers/importsController");
const AppError = require("../utils/AppError");

const router = express.Router();

const protectMerchant =
  merchantAuthMiddleware.protectMerchant ||
  merchantAuthMiddleware.protect ||
  merchantAuthMiddleware;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter(req, file, cb) {
    const isCsvMimeType =
      file.mimetype === "text/csv" ||
      file.mimetype === "application/csv" ||
      file.mimetype === "application/vnd.ms-excel";

    const hasCsvExtension = String(file.originalname || "")
      .toLowerCase()
      .endsWith(".csv");

    if (!isCsvMimeType && !hasCsvExtension) {
      return cb(new AppError("Only CSV files are supported.", 400));
    }

    return cb(null, true);
  }
});

router.post("/csv/preview", protectMerchant, upload.single("file"), previewCsvImport);

module.exports = router;
