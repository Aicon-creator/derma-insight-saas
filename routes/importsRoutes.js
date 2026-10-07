const express = require("express");
const multer = require("multer");

const merchantAuthMiddleware = require("../middleware/merchantAuthMiddleware");
const { previewCsvImport, importCsvData } = require("../controllers/importsController");
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

function handleCsvUpload(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return next(new AppError("CSV file exceeds the 5 MB limit.", 413));
    }

    if (error instanceof multer.MulterError) {
      return next(new AppError("CSV upload failed.", 400));
    }

    return next(error);
  });
}

router.post("/csv/preview", protectMerchant, handleCsvUpload, previewCsvImport);
router.post("/csv/import", protectMerchant, handleCsvUpload, importCsvData);

module.exports = router;
