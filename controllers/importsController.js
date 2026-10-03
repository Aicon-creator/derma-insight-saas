const { parse } = require("csv-parse/sync");

const Customer = require("../models/Customer");
const Product = require("../models/Product");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const MAX_DATA_ROWS = 1000;
const PREVIEW_ROW_LIMIT = 10;
const HEADER_ROW_NUMBER = 1;
const CUSTOMER_IMPORT_DATA_TYPE = "customers";
const PRODUCT_IMPORT_DATA_TYPE = "products";
const IMPORTABLE_DATA_TYPES = new Set([CUSTOMER_IMPORT_DATA_TYPE, PRODUCT_IMPORT_DATA_TYPE]);
const REQUIRED_COLUMNS_BY_TYPE = {
  customers: ["email", "first name", "last name", "skin type", "concern"],
  products: ["name", "category", "price"],
  events: ["event type", "customer email", "product name", "created at", "amount"]
};
const EVENT_TYPES = new Set(["view", "add_to_cart", "purchase"]);
const CUSTOMER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CUSTOMER_FIELD_LIMITS = {
  email: 254,
  "first name": 100,
  "last name": 100,
  "skin type": 32,
  concern: 64
};
const CUSTOMER_SKIN_TYPES = (Customer.schema.path("skinType")?.enumValues || []).map((value) =>
  String(value).trim().toLowerCase()
);
const CUSTOMER_CONCERNS = (Customer.schema.path("concern")?.enumValues || []).map((value) =>
  String(value).trim().toLowerCase()
);
const PRODUCT_CATEGORIES = (Product.schema.path("category")?.enumValues || []).map((value) =>
  String(value).trim().toLowerCase()
);
const PRODUCT_TITLE_MAX_LENGTH = Product.schema.path("title")?.options?.maxlength;
const PRODUCT_HANDLE_MAX_LENGTH = Product.schema.path("handle")?.options?.maxlength;
const PRODUCT_PRICE_MIN = Product.schema.path("price")?.options?.min;
const PRODUCT_IMPORT_MIN_PRICE = Number.isFinite(PRODUCT_PRICE_MIN)
  ? Math.max(0, PRODUCT_PRICE_MIN)
  : 0;

const normalizeHeader = (value) => String(value || "").trim().toLowerCase();
const normalizeValue = (value) => (typeof value === "string" ? value.trim() : value);
const normalizeText = (value) => String(normalizeValue(value) ?? "");
const normalizeEmail = (value) => normalizeText(value).toLowerCase();
const normalizeEnumValue = (value) => normalizeText(value).toLowerCase();
const normalizeEventType = (value) => normalizeEnumValue(value).replace(/\s+/g, "_");
const normalizeProductHandle = (value) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

const isEmpty = (value) => {
  const normalized = normalizeValue(value);
  return normalized === undefined || normalized === null || normalized === "";
};

function ensureAuthenticatedMerchant(req) {
  if (!req.merchant?._id) {
    throw new AppError("Merchant not authenticated", 401);
  }
}

function getRequestedDataType(rawDataType) {
  return String(rawDataType || "").trim().toLowerCase();
}

function assertSupportedPreviewDataType(dataType) {
  if (!dataType || !REQUIRED_COLUMNS_BY_TYPE[dataType]) {
    throw new AppError(
      'Invalid dataType. Supported values are "customers", "products", "events".',
      400
    );
  }
}

function assertImportDataType(dataType) {
  if (!IMPORTABLE_DATA_TYPES.has(dataType)) {
    throw new AppError(
      'Unsupported import dataType. Only "customers" and "products" can be imported at this stage.',
      400
    );
  }
}

function assertFilePresent(file) {
  if (!file) {
    throw new AppError('CSV file is required. Submit using multipart field name "file".', 400);
  }

  if (!file.buffer || file.size === 0) {
    throw new AppError("Uploaded file is empty.", 400);
  }
}

function findDuplicateHeaders(headers) {
  const seen = new Set();
  const duplicates = [];

  headers.forEach((header) => {
    if (!seen.has(header)) {
      seen.add(header);
      return;
    }

    duplicates.push(header);
  });

  return duplicates;
}

function parseCsvBuffer(buffer) {
  const csvText = buffer.toString("utf8");
  let normalizedHeaders = [];

  try {
    const rows = parse(csvText, {
      columns(headers) {
        normalizedHeaders = Array.isArray(headers) ? headers.map(normalizeHeader) : [];
        const duplicateHeaders = findDuplicateHeaders(normalizedHeaders);

        if (duplicateHeaders.length > 0) {
          const duplicateLabel = duplicateHeaders[0] || "(blank header)";
          throw new AppError(`Duplicate CSV header "${duplicateLabel}" detected.`, 400);
        }

        return normalizedHeaders;
      },
      skip_empty_lines: true,
      trim: true,
      bom: true
    });

    return {
      rows,
      headers: normalizedHeaders
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(`Unable to parse CSV: ${error.message}`, 400);
  }
}

function validateCustomerRows(rows) {
  const errors = [];
  const seenEmailsByRow = new Map();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const normalizedEmail = normalizeEmail(row.email);
    const firstName = normalizeText(row["first name"]);
    const lastName = normalizeText(row["last name"]);
    const skinType = normalizeEnumValue(row["skin type"]);
    const concern = normalizeEnumValue(row.concern);

    if (!isEmpty(row.email)) {
      if (normalizedEmail.length > CUSTOMER_FIELD_LIMITS.email) {
        errors.push({
          row: rowNumber,
          column: "email",
          message: `Email must be ${CUSTOMER_FIELD_LIMITS.email} characters or fewer`
        });
      } else if (!CUSTOMER_EMAIL_PATTERN.test(normalizedEmail)) {
        errors.push({
          row: rowNumber,
          column: "email",
          message: "Email must be a valid email address"
        });
      }

      if (seenEmailsByRow.has(normalizedEmail)) {
        errors.push({
          row: rowNumber,
          column: "email",
          message: `Duplicate email also appears on row ${seenEmailsByRow.get(normalizedEmail)}`
        });
      } else {
        seenEmailsByRow.set(normalizedEmail, rowNumber);
      }
    }

    if (!isEmpty(row["first name"]) && firstName.length > CUSTOMER_FIELD_LIMITS["first name"]) {
      errors.push({
        row: rowNumber,
        column: "first name",
        message: `First name must be ${CUSTOMER_FIELD_LIMITS["first name"]} characters or fewer`
      });
    }

    if (!isEmpty(row["last name"]) && lastName.length > CUSTOMER_FIELD_LIMITS["last name"]) {
      errors.push({
        row: rowNumber,
        column: "last name",
        message: `Last name must be ${CUSTOMER_FIELD_LIMITS["last name"]} characters or fewer`
      });
    }

    if (!isEmpty(row["skin type"])) {
      if (skinType.length > CUSTOMER_FIELD_LIMITS["skin type"]) {
        errors.push({
          row: rowNumber,
          column: "skin type",
          message: `Skin type must be ${CUSTOMER_FIELD_LIMITS["skin type"]} characters or fewer`
        });
      } else if (CUSTOMER_SKIN_TYPES.length > 0 && !CUSTOMER_SKIN_TYPES.includes(skinType)) {
        errors.push({
          row: rowNumber,
          column: "skin type",
          message: `Skin type must be one of: ${CUSTOMER_SKIN_TYPES.join(", ")}`
        });
      }
    }

    if (!isEmpty(row.concern)) {
      if (concern.length > CUSTOMER_FIELD_LIMITS.concern) {
        errors.push({
          row: rowNumber,
          column: "concern",
          message: `Concern must be ${CUSTOMER_FIELD_LIMITS.concern} characters or fewer`
        });
      } else if (CUSTOMER_CONCERNS.length > 0 && !CUSTOMER_CONCERNS.includes(concern)) {
        errors.push({
          row: rowNumber,
          column: "concern",
          message: `Concern must be one of: ${CUSTOMER_CONCERNS.join(", ")}`
        });
      }
    }
  });

  return errors;
}

function validateProductRows(rows) {
  const errors = [];
  const seenHandlesByRow = new Map();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const productName = normalizeText(row.name);
    const normalizedCategory = normalizeEnumValue(row.category);
    const productHandle = normalizeProductHandle(row.name);

    if (!isEmpty(row.name)) {
      if (!productHandle) {
        errors.push({
          row: rowNumber,
          column: "name",
          message: "Product name must include letters or numbers"
        });
      } else {
        if (seenHandlesByRow.has(productHandle)) {
          errors.push({
            row: rowNumber,
            column: "name",
            message: `Duplicate product name also appears on row ${seenHandlesByRow.get(productHandle)}`
          });
        } else {
          seenHandlesByRow.set(productHandle, rowNumber);
        }
      }

      if (Number.isFinite(PRODUCT_TITLE_MAX_LENGTH) && productName.length > PRODUCT_TITLE_MAX_LENGTH) {
        errors.push({
          row: rowNumber,
          column: "name",
          message: `Name must be ${PRODUCT_TITLE_MAX_LENGTH} characters or fewer`
        });
      }

      if (Number.isFinite(PRODUCT_HANDLE_MAX_LENGTH) && productHandle.length > PRODUCT_HANDLE_MAX_LENGTH) {
        errors.push({
          row: rowNumber,
          column: "name",
          message: `Name creates a handle longer than ${PRODUCT_HANDLE_MAX_LENGTH} characters`
        });
      }
    }

    if (!isEmpty(row.category)) {
      if (PRODUCT_CATEGORIES.length > 0 && !PRODUCT_CATEGORIES.includes(normalizedCategory)) {
        errors.push({
          row: rowNumber,
          column: "category",
          message: `Category must be one of: ${PRODUCT_CATEGORIES.join(", ")}`
        });
      }
    }

    if (!isEmpty(row.price)) {
      const numericPrice = Number(row.price);

      if (!Number.isFinite(numericPrice)) {
        errors.push({
          row: rowNumber,
          column: "price",
          message: "Price must be a finite number"
        });
      } else if (numericPrice < PRODUCT_IMPORT_MIN_PRICE) {
        errors.push({
          row: rowNumber,
          column: "price",
          message: `Price must be at least ${PRODUCT_IMPORT_MIN_PRICE}`
        });
      }
    }
  });

  return errors;
}

function validateRows(dataType, rows) {
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

  if (dataType === CUSTOMER_IMPORT_DATA_TYPE) {
    errors.push(...validateCustomerRows(rows));
  } else if (dataType === PRODUCT_IMPORT_DATA_TYPE) {
    errors.push(...validateProductRows(rows));
  }

  return errors;
}

function analyzeCsvUpload(req) {
  const dataType = getRequestedDataType(req.body.dataType);
  const file = req.file;

  ensureAuthenticatedMerchant(req);
  assertSupportedPreviewDataType(dataType);
  assertFilePresent(file);

  const { rows, headers } = parseCsvBuffer(file.buffer);

  if (rows.length === 0) {
    throw new AppError("CSV has no data rows.", 400);
  }

  if (rows.length > MAX_DATA_ROWS) {
    throw new AppError(`CSV exceeds the maximum of ${MAX_DATA_ROWS} data rows.`, 400);
  }

  const requiredColumns = REQUIRED_COLUMNS_BY_TYPE[dataType];
  const missingColumns = requiredColumns.filter((column) => !headers.includes(column));
  const errors = [];

  missingColumns.forEach((column) => {
    errors.push({
      row: HEADER_ROW_NUMBER,
      column,
      message: `Missing required column "${column}" in CSV header`
    });
  });

  errors.push(...validateRows(dataType, rows));

  return {
    dataType,
    fileName: file.originalname,
    totalRows: rows.length,
    previewRows: rows.slice(0, PREVIEW_ROW_LIMIT),
    rows,
    errors
  };
}

function getFailedCount(totalRows, errors) {
  if (!errors || errors.length === 0) {
    return 0;
  }

  if (errors.some((error) => error.row === HEADER_ROW_NUMBER)) {
    return totalRows;
  }

  return new Set(errors.map((error) => error.row)).size;
}

function mapCustomerRowToDocument(row, merchantId) {
  return {
    merchantId,
    email: normalizeEmail(row.email),
    firstName: normalizeText(row["first name"]),
    lastName: normalizeText(row["last name"]),
    skinType: normalizeEnumValue(row["skin type"]),
    concern: normalizeEnumValue(row.concern)
  };
}

function mapProductRowToDocument(row, merchantId) {
  return {
    merchantId,
    title: normalizeText(row.name),
    handle: normalizeProductHandle(row.name),
    category: normalizeEnumValue(row.category),
    price: Number(row.price)
  };
}

const previewCsvImport = asyncHandler(async (req, res) => {
  const preview = analyzeCsvUpload(req);

  return res.status(200).json({
    message: "CSV preview generated",
    dataType: preview.dataType,
    fileName: preview.fileName,
    totalRows: preview.totalRows,
    previewRows: preview.previewRows,
    errors: preview.errors
  });
});

async function importCustomers(importPreview, merchantId) {
  const customerDocuments = importPreview.rows.map((row) => mapCustomerRowToDocument(row, merchantId));
  const normalizedEmails = customerDocuments.map((customer) => customer.email);

  const existingCustomers = await Customer.aggregate([
    {
      $match: {
        merchantId
      }
    },
    {
      $project: {
        _id: 0,
        normalizedEmail: {
          $toLower: {
            $ifNull: ["$email", ""]
          }
        }
      }
    },
    {
      $match: {
        normalizedEmail: {
          $in: normalizedEmails
        }
      }
    }
  ]);

  const existingEmailSet = new Set(
    existingCustomers.map((customer) => customer.normalizedEmail).filter(Boolean)
  );
  const newCustomers = customerDocuments.filter((customer) => !existingEmailSet.has(customer.email));
  const initiallySkippedCount = customerDocuments.length - newCustomers.length;

  if (newCustomers.length === 0) {
    return {
      statusCode: 200,
      body: {
        message: "No new customers were imported.",
        dataType: importPreview.dataType,
        fileName: importPreview.fileName,
        totalRows: importPreview.totalRows,
        importedCount: 0,
        skippedCount: importPreview.totalRows,
        failedCount: 0,
        errors: []
      }
    };
  }

  const operations = newCustomers.map((customer) => ({
    updateOne: {
      filter: {
        merchantId,
        email: customer.email
      },
      update: {
        $setOnInsert: customer
      },
      upsert: true
    }
  }));

  let bulkResult;

  try {
    bulkResult = await Customer.bulkWrite(operations, {
      ordered: true
    });
  } catch (error) {
    console.error("CUSTOMER IMPORT ERROR:", error.message);
    throw new AppError("Customer import failed. Please try again.", 500);
  }

  const importedCount = Number(bulkResult.upsertedCount || 0);
  const skippedCount = initiallySkippedCount + (newCustomers.length - importedCount);

  return {
    statusCode: 200,
    body: {
      message: importedCount > 0 ? "Customer import complete." : "No new customers were imported.",
      dataType: importPreview.dataType,
      fileName: importPreview.fileName,
      totalRows: importPreview.totalRows,
      importedCount,
      skippedCount,
      failedCount: 0,
      errors: []
    }
  };
}

async function importProducts(importPreview, merchantId) {
  const productDocuments = importPreview.rows.map((row) => mapProductRowToDocument(row, merchantId));
  const normalizedHandles = productDocuments.map((product) => product.handle);

  const existingProducts = await Product.aggregate([
    {
      $match: {
        merchantId
      }
    },
    {
      $project: {
        _id: 0,
        normalizedHandle: {
          $toLower: {
            $ifNull: ["$handle", ""]
          }
        }
      }
    },
    {
      $match: {
        normalizedHandle: {
          $in: normalizedHandles
        }
      }
    }
  ]);

  const existingHandleSet = new Set(
    existingProducts.map((product) => product.normalizedHandle).filter(Boolean)
  );
  const newProducts = productDocuments.filter((product) => !existingHandleSet.has(product.handle));
  const initiallySkippedCount = productDocuments.length - newProducts.length;

  if (newProducts.length === 0) {
    return {
      statusCode: 200,
      body: {
        message: "No new products were imported.",
        dataType: importPreview.dataType,
        fileName: importPreview.fileName,
        totalRows: importPreview.totalRows,
        importedCount: 0,
        skippedCount: importPreview.totalRows,
        failedCount: 0,
        errors: []
      }
    };
  }

  const operations = newProducts.map((product) => ({
    updateOne: {
      filter: {
        merchantId,
        handle: product.handle
      },
      update: {
        $setOnInsert: product
      },
      upsert: true
    }
  }));

  let bulkResult;

  try {
    bulkResult = await Product.bulkWrite(operations, {
      ordered: true
    });
  } catch (error) {
    throw new AppError("Product import failed. Please try again.", 500);
  }

  const importedCount = Number(bulkResult.upsertedCount || 0);
  const skippedCount = initiallySkippedCount + (newProducts.length - importedCount);

  return {
    statusCode: 200,
    body: {
      message: importedCount > 0 ? "Product import complete." : "No new products were imported.",
      dataType: importPreview.dataType,
      fileName: importPreview.fileName,
      totalRows: importPreview.totalRows,
      importedCount,
      skippedCount,
      failedCount: 0,
      errors: []
    }
  };
}

const importCsvData = asyncHandler(async (req, res) => {
  const importPreview = analyzeCsvUpload(req);

  assertImportDataType(importPreview.dataType);

  if (importPreview.errors.length > 0) {
    return res.status(400).json({
      message: "Import blocked. Fix the validation errors and preview the file again.",
      dataType: importPreview.dataType,
      totalRows: importPreview.totalRows,
      importedCount: 0,
      skippedCount: 0,
      failedCount: getFailedCount(importPreview.totalRows, importPreview.errors),
      errors: importPreview.errors
    });
  }

  const merchantId = req.merchant._id;
  if (importPreview.dataType === CUSTOMER_IMPORT_DATA_TYPE) {
    const result = await importCustomers(importPreview, merchantId);
    return res.status(result.statusCode).json(result.body);
  }

  if (importPreview.dataType === PRODUCT_IMPORT_DATA_TYPE) {
    const result = await importProducts(importPreview, merchantId);
    return res.status(result.statusCode).json(result.body);
  }

  throw new AppError(
    'Unsupported import dataType. Only "customers" and "products" can be imported at this stage.',
    400
  );
});

module.exports = {
  previewCsvImport,
  importCsvData
};
