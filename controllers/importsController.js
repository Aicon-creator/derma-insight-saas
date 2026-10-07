const { parse } = require("csv-parse/sync");
const crypto = require("crypto");

const Customer = require("../models/Customer");
const Event = require("../models/Event");
const Product = require("../models/Product");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");

const MAX_DATA_ROWS = 1000;
const PREVIEW_ROW_LIMIT = 10;
const HEADER_ROW_NUMBER = 1;
const CUSTOMER_IMPORT_DATA_TYPE = "customers";
const PRODUCT_IMPORT_DATA_TYPE = "products";
const EVENT_IMPORT_DATA_TYPE = "events";
const IMPORTABLE_DATA_TYPES = new Set([
  CUSTOMER_IMPORT_DATA_TYPE,
  PRODUCT_IMPORT_DATA_TYPE,
  EVENT_IMPORT_DATA_TYPE
]);
const REQUIRED_COLUMNS_BY_TYPE = {
  customers: ["email", "first name", "last name", "skin type", "concern"],
  products: ["name", "category", "price"],
  events: ["event type", "customer email", "product name", "occurred at", "amount"]
};
const EVENT_TYPES = new Set(Event.schema.path("type")?.enumValues || ["view", "add_to_cart", "purchase"]);
const EVENT_ALLOWED_CURRENCIES = new Set(["GBP"]);
const STRICT_ISO_8601_WITH_TIMEZONE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const EVENT_FUTURE_DRIFT_MS = 5 * 60 * 1000;
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
const EVENT_SOURCE_EVENT_ID_MAX_LENGTH = Event.schema.path("sourceEventId")?.options?.maxlength;
const EVENT_SESSION_ID_MAX_LENGTH = Event.schema.path("sessionId")?.options?.maxlength;

const normalizeHeader = (value) => String(value || "").trim().toLowerCase();
const normalizeValue = (value) => (typeof value === "string" ? value.trim() : value);
const normalizeText = (value) => String(normalizeValue(value) ?? "");
const normalizeEmail = (value) => normalizeText(value).toLowerCase();
const normalizeEnumValue = (value) => normalizeText(value).toLowerCase();
const normalizeEventType = (value) => normalizeEnumValue(value).replace(/[\s-]+/g, "_");
const normalizeCurrency = (value) => normalizeText(value).toUpperCase();
const normalizeEventId = (value) => normalizeText(value).toLowerCase();
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

function parseEventTimestamp(value) {
  const timestamp = normalizeText(value);
  const matches = timestamp.match(STRICT_ISO_8601_WITH_TIMEZONE_PATTERN);

  if (!matches) {
    return null;
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    millisecondText = "0",
    timezoneToken,
    offsetSign,
    offsetHoursText = "00",
    offsetMinutesText = "00"
  ] = matches;

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(millisecondText.padEnd(3, "0"));
  const offsetHours = Number(offsetHoursText);
  const offsetMinutes = Number(offsetMinutesText);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59 ||
    millisecond < 0 ||
    millisecond > 999 ||
    offsetHours < 0 ||
    offsetHours > 23 ||
    offsetMinutes < 0 ||
    offsetMinutes > 59
  ) {
    return null;
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (day > daysInMonth) {
    return null;
  }

  const offsetDirection = timezoneToken === "Z" ? 1 : offsetSign === "+" ? 1 : -1;
  const offsetMillis = offsetDirection * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMillis;
  const parsedDate = new Date(utcMillis);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  const localMillisAtOffset = utcMillis + offsetMillis;
  const localAtOffsetDate = new Date(localMillisAtOffset);

  if (
    localAtOffsetDate.getUTCFullYear() !== year ||
    localAtOffsetDate.getUTCMonth() + 1 !== month ||
    localAtOffsetDate.getUTCDate() !== day ||
    localAtOffsetDate.getUTCHours() !== hour ||
    localAtOffsetDate.getUTCMinutes() !== minute ||
    localAtOffsetDate.getUTCSeconds() !== second ||
    localAtOffsetDate.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  return parsedDate;
}

function formatNumberForDedupe(value) {
  return Number(value).toString();
}

function hashDedupeKey(...segments) {
  return crypto.createHash("sha256").update(segments.join("|")).digest("hex");
}

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
      'Unsupported import dataType. Only "customers", "products", and "events" can be imported at this stage.',
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
      if (dataType === EVENT_IMPORT_DATA_TYPE && column === "amount") {
        return;
      }

      if (isEmpty(row[column])) {
        errors.push({
          row: rowNumber,
          column,
          message: `Missing value for required column "${column}"`
        });
      }
    });

  });

  if (dataType === CUSTOMER_IMPORT_DATA_TYPE) {
    errors.push(...validateCustomerRows(rows));
  } else if (dataType === PRODUCT_IMPORT_DATA_TYPE) {
    errors.push(...validateProductRows(rows));
  } else if (dataType === EVENT_IMPORT_DATA_TYPE) {
    errors.push(...validateEventRows(rows));
  }

  return errors;
}

function validateEventRows(rows) {
  const errors = [];
  const nowWithDrift = Date.now() + EVENT_FUTURE_DRIFT_MS;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const normalizedEventType = normalizeEventType(row["event type"]);
    const normalizedEmail = normalizeEmail(row["customer email"]);
    const productName = normalizeText(row["product name"]);
    const normalizedProductHandle = normalizeProductHandle(productName);
    const parsedTimestamp = parseEventTimestamp(row["occurred at"]);
    const normalizedAmount = normalizeText(row.amount);
    const normalizedQuantity = normalizeText(row.quantity);
    const normalizedCurrency = normalizeCurrency(row.currency || "GBP");
    const normalizedSessionId = normalizeText(row["session id"]);
    const normalizedSourceEventId = normalizeText(row["event id"]);

    if (!isEmpty(row["event type"]) && !EVENT_TYPES.has(normalizedEventType)) {
      errors.push({
        row: rowNumber,
        column: "event type",
        message: 'Event type must be one of: "view", "add_to_cart", "purchase"'
      });
    }

    if (!isEmpty(row["customer email"])) {
      if (normalizedEmail.length > CUSTOMER_FIELD_LIMITS.email) {
        errors.push({
          row: rowNumber,
          column: "customer email",
          message: `Customer email must be ${CUSTOMER_FIELD_LIMITS.email} characters or fewer`
        });
      } else if (!CUSTOMER_EMAIL_PATTERN.test(normalizedEmail)) {
        errors.push({
          row: rowNumber,
          column: "customer email",
          message: "Customer email must be a valid email address"
        });
      }
    }

    if (!isEmpty(row["product name"]) && !normalizedProductHandle) {
      errors.push({
        row: rowNumber,
        column: "product name",
        message: "Product name must include letters or numbers"
      });
    }

    if (!isEmpty(row["occurred at"])) {
      if (!parsedTimestamp) {
        errors.push({
          row: rowNumber,
          column: "occurred at",
          message: "Occurred at must be a valid ISO-8601 timestamp with timezone"
        });
      } else if (parsedTimestamp.getTime() > nowWithDrift) {
        errors.push({
          row: rowNumber,
          column: "occurred at",
          message: "Occurred at cannot be more than five minutes in the future"
        });
      }
    }

    const numericAmount = Number(normalizedAmount);

    if (normalizedEventType === "purchase") {
      if (isEmpty(row.amount)) {
        errors.push({
          row: rowNumber,
          column: "amount",
          message: 'Amount is required for "purchase" events'
        });
      } else if (!Number.isFinite(numericAmount)) {
        errors.push({
          row: rowNumber,
          column: "amount",
          message: "Amount must be a finite number"
        });
      } else if (numericAmount < 0) {
        errors.push({
          row: rowNumber,
          column: "amount",
          message: "Amount must be greater than or equal to 0"
        });
      }
    } else if (normalizedEventType === "view" || normalizedEventType === "add_to_cart") {
      if (!isEmpty(row.amount)) {
        if (!Number.isFinite(numericAmount)) {
          errors.push({
            row: rowNumber,
            column: "amount",
            message: "Amount must be a finite number"
          });
        } else if (numericAmount !== 0) {
          errors.push({
            row: rowNumber,
            column: "amount",
            message: `Amount must be blank or 0 for "${normalizedEventType}" events`
          });
        }
      }
    } else if (!isEmpty(row.amount) && !Number.isFinite(numericAmount)) {
      errors.push({
        row: rowNumber,
        column: "amount",
        message: "Amount must be a finite number"
      });
    }

    if (!isEmpty(row.quantity)) {
      const numericQuantity = Number(normalizedQuantity);

      if (!Number.isFinite(numericQuantity) || !Number.isInteger(numericQuantity)) {
        errors.push({
          row: rowNumber,
          column: "quantity",
          message: "Quantity must be an integer"
        });
      } else if (numericQuantity <= 0) {
        errors.push({
          row: rowNumber,
          column: "quantity",
          message: "Quantity must be greater than 0"
        });
      }
    }

    if (!isEmpty(row.currency) && !EVENT_ALLOWED_CURRENCIES.has(normalizedCurrency)) {
      errors.push({
        row: rowNumber,
        column: "currency",
        message: "Currency must be GBP for this import"
      });
    }

    if (
      Number.isFinite(EVENT_SESSION_ID_MAX_LENGTH) &&
      normalizedSessionId.length > EVENT_SESSION_ID_MAX_LENGTH
    ) {
      errors.push({
        row: rowNumber,
        column: "session id",
        message: `Session id must be ${EVENT_SESSION_ID_MAX_LENGTH} characters or fewer`
      });
    }

    if (
      Number.isFinite(EVENT_SOURCE_EVENT_ID_MAX_LENGTH) &&
      normalizedSourceEventId.length > EVENT_SOURCE_EVENT_ID_MAX_LENGTH
    ) {
      errors.push({
        row: rowNumber,
        column: "event id",
        message: `Event id must be ${EVENT_SOURCE_EVENT_ID_MAX_LENGTH} characters or fewer`
      });
    }
  });

  return errors;
}

function buildEventDedupeKey(eventRow, merchantId) {
  const merchantIdValue = String(merchantId);

  if (eventRow.sourceEventId) {
    return hashDedupeKey(merchantIdValue, "csv", normalizeEventId(eventRow.sourceEventId));
  }

  return hashDedupeKey(
    merchantIdValue,
    eventRow.type,
    String(eventRow.customerId),
    String(eventRow.productId),
    eventRow.occurredAt.toISOString(),
    formatNumberForDedupe(eventRow.price),
    String(eventRow.quantity),
    eventRow.currency,
    eventRow.sessionId || ""
  );
}

function hasRowErrors(errors, rowNumber) {
  return errors.some((error) => error.row === rowNumber);
}

function normalizeEventRow(row) {
  const normalizedEventType = normalizeEventType(row["event type"]);
  const normalizedEmail = normalizeEmail(row["customer email"]);
  const normalizedProductHandle = normalizeProductHandle(row["product name"]);
  const occurredAt = parseEventTimestamp(row["occurred at"]);
  const numericAmount = isEmpty(row.amount) ? 0 : Number(row.amount);
  const numericQuantity = isEmpty(row.quantity) ? 1 : Number(row.quantity);
  const currency = normalizeCurrency(row.currency || "GBP") || "GBP";
  const sessionId = isEmpty(row["session id"]) ? null : normalizeText(row["session id"]);
  const sourceEventId = isEmpty(row["event id"]) ? null : normalizeText(row["event id"]);

  return {
    type: normalizedEventType,
    customerEmail: normalizedEmail,
    productHandle: normalizedProductHandle,
    occurredAt,
    price: numericAmount,
    quantity: numericQuantity,
    currency,
    sessionId,
    sourceEventId
  };
}

async function buildEventImportRows(rows, merchantId, existingErrors = []) {
  const errors = [];
  const normalizedRows = rows.map((row, index) => ({
    rowNumber: index + 2,
    ...normalizeEventRow(row)
  }));

  const validRows = normalizedRows.filter(
    (row) =>
      row.customerEmail &&
      row.productHandle &&
      row.occurredAt &&
      EVENT_TYPES.has(row.type) &&
      !hasRowErrors(existingErrors, row.rowNumber)
  );
  const uniqueEmails = [...new Set(validRows.map((row) => row.customerEmail))];
  const uniqueHandles = [...new Set(validRows.map((row) => row.productHandle))];

  const [customerLookupRows, productLookupRows] = await Promise.all([
    uniqueEmails.length > 0
      ? Customer.aggregate([
          {
            $match: {
              merchantId
            }
          },
          {
            $project: {
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
                $in: uniqueEmails
              }
            }
          },
          {
            $group: {
              _id: "$normalizedEmail",
              customerIds: {
                $push: "$_id"
              }
            }
          }
        ])
      : [],
    uniqueHandles.length > 0
      ? Product.aggregate([
          {
            $match: {
              merchantId
            }
          },
          {
            $project: {
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
                $in: uniqueHandles
              }
            }
          },
          {
            $group: {
              _id: "$normalizedHandle",
              productIds: {
                $push: "$_id"
              }
            }
          }
        ])
      : []
  ]);

  const customersByEmail = new Map(
    customerLookupRows.map((customer) => [customer._id, customer.customerIds || []])
  );
  const productsByHandle = new Map(
    productLookupRows.map((product) => [product._id, product.productIds || []])
  );

  const candidateEventRows = [];

  normalizedRows.forEach((row) => {
    if (hasRowErrors(existingErrors, row.rowNumber)) {
      return;
    }

    if (!row.customerEmail || !row.productHandle || !row.occurredAt || !EVENT_TYPES.has(row.type)) {
      return;
    }

    const customerMatches = customersByEmail.get(row.customerEmail) || [];
    const productMatches = productsByHandle.get(row.productHandle) || [];

    if (customerMatches.length === 0) {
      errors.push({
        row: row.rowNumber,
        column: "customer email",
        message: "Customer email does not match any customer for this merchant"
      });
      return;
    }

    if (customerMatches.length > 1) {
      errors.push({
        row: row.rowNumber,
        column: "customer email",
        message: "Customer email matches multiple customers for this merchant"
      });
      return;
    }

    if (productMatches.length === 0) {
      errors.push({
        row: row.rowNumber,
        column: "product name",
        message: "Product name does not match any product for this merchant"
      });
      return;
    }

    if (productMatches.length > 1) {
      errors.push({
        row: row.rowNumber,
        column: "product name",
        message: "Product name matches multiple products for this merchant"
      });
      return;
    }

    const eventRow = {
      merchantId,
      customerId: customerMatches[0],
      productId: productMatches[0],
      type: row.type,
      occurredAt: row.occurredAt,
      // Event revenue is calculated downstream as price * quantity.
      price: row.price,
      quantity: row.quantity,
      currency: row.currency,
      sessionId: row.sessionId,
      sourceEventId: row.sourceEventId
    };

    eventRow.dedupeKey = buildEventDedupeKey(eventRow, merchantId);
    candidateEventRows.push({
      rowNumber: row.rowNumber,
      eventRow
    });
  });

  const seenDedupeKeysByRow = new Map();

  candidateEventRows.forEach(({ rowNumber, eventRow }) => {
    if (seenDedupeKeysByRow.has(eventRow.dedupeKey)) {
      errors.push({
        row: rowNumber,
        column: "event id",
        message: `Duplicate event dedupe key also appears on row ${seenDedupeKeysByRow.get(eventRow.dedupeKey)}`
      });
      return;
    }

    seenDedupeKeysByRow.set(eventRow.dedupeKey, rowNumber);
  });

  return {
    errors,
    rows: candidateEventRows.map(({ eventRow }) => eventRow)
  };
}

async function analyzeCsvUpload(req) {
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

  let eventImportRows = [];

  if (dataType === EVENT_IMPORT_DATA_TYPE) {
    const eventBuildResult = await buildEventImportRows(rows, req.merchant._id, errors);
    errors.push(...eventBuildResult.errors);
    eventImportRows = eventBuildResult.rows;
  }

  return {
    dataType,
    fileName: file.originalname,
    totalRows: rows.length,
    previewRows: rows.slice(0, PREVIEW_ROW_LIMIT),
    rows,
    errors,
    eventImportRows
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
  const preview = await analyzeCsvUpload(req);

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

function isDuplicateKeyError(error) {
  return Boolean(error && error.code === 11000);
}

async function updateCustomerLastSeenFromEvents(persistedEvents, merchantId) {
  if (persistedEvents.length === 0) {
    return;
  }

  const mostRecentEventByCustomerId = new Map();

  persistedEvents.forEach((eventRow) => {
    const customerId = String(eventRow.customerId);
    const currentDate = mostRecentEventByCustomerId.get(customerId);

    if (!currentDate || eventRow.occurredAt > currentDate) {
      mostRecentEventByCustomerId.set(customerId, eventRow.occurredAt);
    }
  });

  const operations = [...mostRecentEventByCustomerId.entries()].map(([customerId, occurredAt]) => ({
    updateOne: {
      filter: {
        _id: customerId,
        merchantId
      },
      update: {
        $max: {
          lastSeenAt: occurredAt
        }
      }
    }
  }));

  if (operations.length === 0) {
    return;
  }

  try {
    await Customer.bulkWrite(operations, {
      ordered: false
    });
  } catch (error) {
    throw new AppError("Event import succeeded but failed to update customer activity.", 500);
  }
}

async function fetchPersistedEventsForDedupeKeys(dedupeKeys, merchantId) {
  if (dedupeKeys.length === 0) {
    return [];
  }

  return Event.find(
    {
      merchantId,
      dedupeKey: {
        $in: dedupeKeys
      }
    },
    {
      _id: 0,
      customerId: 1,
      occurredAt: 1,
      dedupeKey: 1
    }
  ).lean();
}

async function importEvents(importPreview, merchantId) {
  const eventDocuments = importPreview.eventImportRows || [];
  const dedupeKeys = eventDocuments.map((eventDocument) => eventDocument.dedupeKey);

  const existingEvents = await Event.aggregate([
    {
      $match: {
        merchantId
      }
    },
    {
      $match: {
        dedupeKey: {
          $in: dedupeKeys
        }
      }
    },
    {
      $project: {
        _id: 0,
        dedupeKey: 1
      }
    }
  ]);

  const existingDedupeKeySet = new Set(
    existingEvents.map((eventDocument) => eventDocument.dedupeKey).filter(Boolean)
  );
  const newEvents = eventDocuments.filter(
    (eventDocument) => !existingDedupeKeySet.has(eventDocument.dedupeKey)
  );
  const initiallySkippedCount = eventDocuments.length - newEvents.length;

  if (newEvents.length === 0) {
    const persistedEvents = await fetchPersistedEventsForDedupeKeys(dedupeKeys, merchantId);
    await updateCustomerLastSeenFromEvents(persistedEvents, merchantId);

    return {
      statusCode: 200,
      body: {
        message: "No new events were imported.",
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

  let importedCount = 0;

  for (const eventDocument of newEvents) {
    try {
      const writeResult = await Event.updateOne(
        {
          merchantId,
          dedupeKey: eventDocument.dedupeKey
        },
        {
          $setOnInsert: eventDocument
        },
        {
          upsert: true
        }
      );

      if (Number(writeResult.upsertedCount || 0) > 0) {
        importedCount += 1;
      }
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        continue;
      }

      throw new AppError("Event import failed. Please try again.", 500);
    }
  }

  const skippedCount = initiallySkippedCount + (newEvents.length - importedCount);

  const persistedEvents = await fetchPersistedEventsForDedupeKeys(dedupeKeys, merchantId);
  await updateCustomerLastSeenFromEvents(persistedEvents, merchantId);

  return {
    statusCode: 200,
    body: {
      message: importedCount > 0 ? "Event import complete." : "No new events were imported.",
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
  const importPreview = await analyzeCsvUpload(req);

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

  if (importPreview.dataType === EVENT_IMPORT_DATA_TYPE) {
    const result = await importEvents(importPreview, merchantId);
    return res.status(result.statusCode).json(result.body);
  }

  throw new AppError(
    'Unsupported import dataType. Only "customers", "products", and "events" can be imported at this stage.',
    400
  );
});

module.exports = {
  previewCsvImport,
  importCsvData
};
