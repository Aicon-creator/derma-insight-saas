const { parse } = require("csv-parse/sync");

const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const REQUIRED_COLUMNS_BY_TYPE = {
  customers: ["email", "first name", "last name", "skin type", "concern"],
  products: ["name", "category", "price"],
  events: ["event type", "customer email", "product name", "created at", "amount"]
};

const EVENT_TYPES = new Set(["view", "add_to_cart", "purchase"]);

const normalizeValue = (value) => (typeof value === "string" ? value.trim() : value);

const isEmpty = (value) => {
  const normalized = normalizeValue(value);
  return normalized === undefined || normalized === null || normalized === "";
};

const parseCsvBuffer = (buffer) => {
  const csvText = buffer.toString("utf8");

  return parse(csvText, {
    columns: (headers) =>
      Array.isArray(headers)
        ? headers.map((header) => String(header || "").trim().toLowerCase())
        : [],
    skip_empty_lines: true,
    trim: true,
    bom: true
  });
};

const normalizeEventType = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

const validateRows = (dataType, rows) => {
  const errors = [];
  const requiredColumns = REQUIRED_COLUMNS_BY_TYPE[dataType];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    requiredColumns.forEach((column) => {
      if (isEmpty(row[column])) {
        errors.push({
          row: rowNumber,
          column,
          message: `Missing value for required column "${column}"`
        });
      }
    });

    if (dataType === "products" && !isEmpty(row.price) && Number.isNaN(Number(row.price))) {
      errors.push({
        row: rowNumber,
        column: "price",
        message: "Price must be a valid number"
      });
    }

    if (dataType === "events") {
      if (!isEmpty(row.amount) && Number.isNaN(Number(row.amount))) {
        errors.push({
          row: rowNumber,
          column: "amount",
          message: "Amount must be a valid number"
        });
      }

      if (!isEmpty(row["event type"]) && !EVENT_TYPES.has(normalizeEventType(row["event type"]))) {
        errors.push({
          row: rowNumber,
          column: "event type",
          message: 'Event type must be one of: "view", "add_to_cart", "purchase"'
        });
      }

      if (!isEmpty(row["created at"]) && Number.isNaN(Date.parse(String(row["created at"])))) {
        errors.push({
          row: rowNumber,
          column: "created at",
          message: "Created at must be a valid date"
        });
      }
    }
  });

  return errors;
};

const previewCsvImport = asyncHandler(async (req, res) => {
  const dataType = String(req.body.dataType || "").trim().toLowerCase();
  const file = req.file;

  if (!req.merchant?._id) {
    throw new AppError("Merchant not authenticated", 401);
  }

  if (!dataType || !REQUIRED_COLUMNS_BY_TYPE[dataType]) {
    throw new AppError(
      'Invalid dataType. Supported values are "customers", "products", "events".',
      400
    );
  }

  if (!file) {
    throw new AppError('CSV file is required. Submit using multipart field name "file".', 400);
  }

  if (!file.buffer || file.size === 0) {
    throw new AppError("Uploaded file is empty.", 400);
  }

  let parsedRows;
  try {
    parsedRows = parseCsvBuffer(file.buffer);
  } catch (error) {
    throw new AppError(`Unable to parse CSV: ${error.message}`, 400);
  }

  if (parsedRows.length === 0) {
    throw new AppError("CSV has no data rows.", 400);
  }

  const requiredColumns = REQUIRED_COLUMNS_BY_TYPE[dataType];
  const parsedColumns = Object.keys(parsedRows[0] || {});
  const missingColumns = requiredColumns.filter(
    (column) => !parsedColumns.includes(column)
  );

  const errors = [];

  if (missingColumns.length > 0) {
    missingColumns.forEach((column) => {
      errors.push({
        row: 1,
        column,
        message: `Missing required column "${column}" in CSV header`
      });
    });
  }

  errors.push(...validateRows(dataType, parsedRows));

  return res.status(200).json({
    message: "CSV preview generated",
    dataType,
    fileName: file.originalname,
    totalRows: parsedRows.length,
    previewRows: parsedRows.slice(0, 10),
    errors
  });
});

module.exports = {
  previewCsvImport
};
