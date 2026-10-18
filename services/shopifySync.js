const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Merchant = require("../models/Merchant");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");
const ShopifyOrder = require("../models/ShopifyOrder");
const AppError = require("../utils/AppError");
const { fetchAllPages, shopifyGraphQL } = require("./shopifyService");

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const LINE_FIELDS = `id quantity currentQuantity product { id } priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }`;
const CUSTOMERS_QUERY = `query Customers($cursor: String) { customers(first: 100, after: $cursor) {
  ${PAGE_INFO} nodes { id firstName lastName email } } }`;
const PRODUCTS_QUERY = `query Products($cursor: String) { products(first: 100, after: $cursor) {
  ${PAGE_INFO} nodes { id title handle vendor productType status featuredImage { url }
  priceRangeV2 { minVariantPrice { amount currencyCode } } } } }`;
const ORDERS_QUERY = `query Orders($cursor: String, $query: String!) { orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
  ${PAGE_INFO} nodes { id createdAt updatedAt cancelledAt test displayFinancialStatus customer { id }
    lineItems(first: 100) { ${PAGE_INFO} nodes { ${LINE_FIELDS} } } } } }`;
const LINES_QUERY = `query OrderLines($cursor: String, $id: ID!) { order(id: $id) {
  updatedAt lineItems(first: 100, after: $cursor) { ${PAGE_INFO} nodes { ${LINE_FIELDS} } } } }`;

const normalized = value => String(value ?? "").trim().toLowerCase();
const sourceKey = (shop, id) => `${shop}|${id}`;
const eventKey = (merchantId, shop, lineId) => crypto.createHash("sha256")
  .update(`${merchantId}|shopify|${shop}|${lineId}`).digest("hex");
const categories = new Set(Product.schema.path("category").enumValues);

function requireGid(id, type) {
  if (typeof id !== "string" || !new RegExp(`^gid://shopify/${type}/[0-9]+$`).test(id)) {
    throw new AppError("Shopify returned an invalid source identity. No complete sync was confirmed.", 502);
  }
  return id;
}

function amountMinor(money) {
  if (money?.currencyCode !== "GBP" || typeof money.amount !== "string" || !/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(money.amount)) {
    throw new AppError("This pilot supports valid GBP amounts only. No currency conversion is performed.", 422);
  }
  const [whole, fraction = ""] = money.amount.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function sourceDate(value) {
  const date = new Date(value);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime()) || date > Date.now() + 300000) {
    throw new AppError("Shopify returned an invalid event date.", 502);
  }
  return date;
}

function mapOrder(order, includeTestOrders) {
  requireGid(order.id, "Order");
  const seen = new Set();
  if (!Array.isArray(order.lineItems?.nodes) || order.lineItems.pageInfo?.hasNextPage !== false ||
      typeof order.test !== "boolean" || typeof order.displayFinancialStatus !== "string") {
    throw new AppError("Shopify returned an incomplete order. No order changes were saved.", 502);
  }
  const active = !order.cancelledAt && ["PAID", "PARTIALLY_REFUNDED"].includes(order.displayFinancialStatus) &&
    (!order.test || includeTestOrders);
  const lines = order.lineItems.nodes.map(line => {
    requireGid(line.id, "LineItem");
    if (seen.has(line.id) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
        !Number.isSafeInteger(line.currentQuantity) || line.currentQuantity < 0 || line.currentQuantity > line.quantity) {
      throw new AppError("Shopify returned invalid or duplicate order lines.", 502);
    }
    seen.add(line.id);
    if (line.product) requireGid(line.product.id, "Product");
    return { id: line.id, productId: line.product?.id || null, originalQuantity: line.quantity,
      quantity: active ? line.currentQuantity : 0,
      netAmountMinor: active ? amountMinor(line.priceAfterAllDiscountsBeforeTaxesSet?.shopMoney) : 0 };
  });
  if (order.customer) requireGid(order.customer.id, "Customer");
  return { id: order.id, occurredAt: sourceDate(order.createdAt), sourceUpdatedAt: sourceDate(order.updatedAt),
    customerId: order.customer?.id || null, financialStatus: order.displayFinancialStatus,
    cancelled: Boolean(order.cancelledAt), test: order.test, currency: "GBP", lines };
}

function uniqueNodes(nodes, type) {
  const seen = new Set();
  for (const node of nodes) {
    requireGid(node.id, type);
    if (seen.has(node.id)) throw new AppError("Shopify returned duplicate source identities. Retry the sync.", 502);
    seen.add(node.id);
  }
}

async function fetchSnapshot(shop, token, config, deadline) {
  const options = { config, deadline, maxNodes: 5000 };
  const data = await shopifyGraphQL(shop, token, "query ShopCurrency { shop { currencyCode } }", {}, options);
  if (data.shop?.currencyCode !== "GBP") throw new AppError("The pilot supports stores with GBP as their shop currency.", 422);
  const customers = await fetchAllPages(shop, token, CUSTOMERS_QUERY, d => d.customers, options);
  const products = await fetchAllPages(shop, token, PRODUCTS_QUERY, d => d.products, options);
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const orders = await fetchAllPages(shop, token, ORDERS_QUERY, d => d.orders,
    { ...options, variables: { query: `created_at:>=${since}` } });
  uniqueNodes(customers, "Customer"); uniqueNodes(products, "Product"); uniqueNodes(orders, "Order");
  let lineCount = 0;
  for (const order of orders) {
    if (order.lineItems?.pageInfo?.hasNextPage) {
      const lines = await fetchAllPages(shop, token, LINES_QUERY, d => {
        if (d.order?.updatedAt !== order.updatedAt) throw new AppError("An order changed during sync. Retry to read a consistent order.", 409);
        return d.order.lineItems;
      }, { ...options, maxNodes: 1000, variables: { id: order.id } });
      order.lineItems = { nodes: lines, pageInfo: { hasNextPage: false } };
    }
    lineCount += order.lineItems?.nodes?.length || 0;
    if (lineCount > 10000) throw new AppError("The store exceeds the pilot order-line limit. Contact support.", 422);
  }
  const customerRows = customers.map(c => {
    const email = c.email == null || c.email === "" ? null : normalized(c.email);
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new AppError("Shopify returned an invalid customer email.", 502);
    return { id: c.id, email, firstName: String(c.firstName || "").trim().slice(0, 150), lastName: String(c.lastName || "").trim().slice(0, 150) };
  });
  const productRows = products.map(p => {
    if (typeof p.title !== "string" || !p.title.trim() || typeof p.handle !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.handle)) {
      throw new AppError("Shopify returned an invalid product identity.", 502);
    }
    const category = normalized(p.productType);
    const image = p.featuredImage?.url || null;
    return { id: p.id, title: p.title.trim().slice(0, 500), handle: p.handle, brand: p.vendor || null,
      category: categories.has(category) ? category : "other", price: amountMinor(p.priceRangeV2?.minVariantPrice) / 100,
      currency: "GBP", imageUrl: typeof image === "string" && image.startsWith("https://") ? image : null,
      isActive: p.status === "ACTIVE" };
  });
  return { customers: customerRows, products: productRows,
    orders: orders.map(o => mapOrder(o, config.includeTestOrders)), since };
}

function hasIndex(indexes, key, field) {
  return indexes.some(index => index.unique === true && JSON.stringify(index.key) === JSON.stringify(key) &&
    (!index.collation || index.collation.locale === "simple") &&
    (field ? Object.keys(index.partialFilterExpression || {}).length === 1 &&
      Object.keys(index.partialFilterExpression[field] || {}).length === 1 &&
      ["string", 2].includes(index.partialFilterExpression[field]?.$type) : !index.partialFilterExpression));
}

async function assertDatabaseReady() {
  const checks = [
    [Customer, { merchantId: 1, email: 1 }, "email"],
    [Customer, { merchantId: 1, shopifyStoreDomain: 1, shopifyCustomerId: 1 }, "shopifyCustomerId"],
    [Product, { merchantId: 1, handle: 1 }, "handle"],
    [Product, { merchantId: 1, shopifyStoreDomain: 1, shopifyProductId: 1 }, "shopifyProductId"],
    [Event, { merchantId: 1, dedupeKey: 1 }, "dedupeKey"],
    [ShopifyOrder, { merchantId: 1, shopifyStoreDomain: 1, shopifyOrderId: 1 }]
  ];
  for (const [model, key, field] of checks) {
    let indexes;
    try { indexes = await model.collection.indexes(); } catch { indexes = []; }
    if (!hasIndex(indexes, key, field)) throw new AppError("Store syncing is not ready. Contact support to finish the database setup.", 409);
  }
  const hello = await mongoose.connection.db.command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw new AppError("Store syncing requires a database that supports transactions.", 409);
}

function makeIdentityPlan(existing, incoming, identityField, sourceField, shop) {
  const bySource = new Map();
  const byIdentity = new Map();
  for (const row of existing) {
    if (row[sourceField] && row.shopifyStoreDomain === shop) {
      if (bySource.has(row[sourceField])) throw new AppError("Existing store identities need review. No new sync was started.", 409);
      bySource.set(row[sourceField], row);
    }
    const identity = normalized(row[identityField]);
    if (identity) byIdentity.set(identity, [...(byIdentity.get(identity) || []), row]);
  }
  const incomingIdentities = new Set();
  return incoming.map(row => {
    const identity = normalized(row[identityField]);
    if (identity && incomingIdentities.has(identity)) throw new AppError("Shopify has conflicting customer or product identities. No new sync was started.", 409);
    if (identity) incomingIdentities.add(identity);
    const sourceMatch = bySource.get(row.id);
    const matches = identity ? byIdentity.get(identity) || [] : [];
    if (matches.length > 1 || matches.some(match => sourceMatch && String(match._id) !== String(sourceMatch._id))) {
      throw new AppError("Existing CSV and Shopify identities conflict. No new sync was started.", 409);
    }
    const existingRow = sourceMatch || matches[0];
    if (existingRow?.[sourceField] && (existingRow[sourceField] !== row.id || existingRow.shopifyStoreDomain !== shop)) {
      throw new AppError("Existing records belong to a different Shopify source. No new sync was started.", 409);
    }
    return { row, existingId: existingRow?._id || null };
  });
}

async function persistSnapshot(snapshot, merchantId, shop, leaseId, deadline) {
  const summary = { customersProcessed: 0, productsProcessed: 0, ordersProcessed: 0,
    purchasesImported: 0, purchasesUpdated: 0, purchasesUnchanged: 0, purchasesRetired: 0,
    guestPurchaseLines: 0, unknownProductLines: 0, excludedTestOrders: 0, excludedUnpaidOrCancelledOrders: 0,
    historyDays: 60, currency: "GBP", orderWindowStart: snapshot.since };
  async function checkLease(session) {
    if (Date.now() >= deadline) throw new AppError("Sync reached its time limit. Some earlier records may be saved; retry safely.", 503);
    const query = Merchant.findOne({ _id: merchantId, shopifyStoreDomain: shop,
      shopifyConnectionState: "connected", shopifyLeaseId: leaseId, shopifyLeaseUntil: { $gt: new Date() } });
    if (session) query.session(session);
    if (!await query.select("_id")) throw new AppError("The store connection changed during sync. Retry after reconnecting.", 409);
  }
  try {
    const [customers, products] = await Promise.all([
      Customer.find({ merchantId }).select("_id email shopifyCustomerId shopifyStoreDomain").limit(100001).lean(),
      Product.find({ merchantId }).select("_id handle shopifyProductId shopifyStoreDomain").limit(100001).lean()
    ]);
    if (customers.length > 100000 || products.length > 100000) throw new AppError("This account needs a planned larger sync. Contact support.", 422);
    const customerPlan = makeIdentityPlan(customers, snapshot.customers, "email", "shopifyCustomerId", shop);
    const productPlan = makeIdentityPlan(products, snapshot.products, "handle", "shopifyProductId", shop);
    const customerIds = new Map(customers.filter(c => c.shopifyStoreDomain === shop && c.shopifyCustomerId).map(c => [c.shopifyCustomerId, c._id]));
    const productIds = new Map(products.filter(p => p.shopifyStoreDomain === shop && p.shopifyProductId).map(p => [p.shopifyProductId, p._id]));
    for (const { row, existingId } of customerPlan) {
      await checkLease();
      const { id, ...profile } = row;
      const set = { ...profile, shopifyCustomerId: id, shopifyStoreDomain: shop };
      const result = await Customer.findOneAndUpdate(existingId ? { _id: existingId, merchantId } :
        { merchantId, shopifyStoreDomain: shop, shopifyCustomerId: id },
      { $set: set, ...(existingId ? {} : { $setOnInsert: { merchantId, skinType: null, concern: null } }) },
      { upsert: !existingId, new: true, runValidators: true, maxTimeMS: 10000 });
      if (!result) throw new AppError("A customer changed during sync. Retry safely.", 409);
      customerIds.set(id, result._id); summary.customersProcessed += 1;
    }
    for (const { row, existingId } of productPlan) {
      await checkLease();
      const { id, ...catalog } = row;
      const result = await Product.findOneAndUpdate(existingId ? { _id: existingId, merchantId } :
        { merchantId, shopifyStoreDomain: shop, shopifyProductId: id },
      { $set: { ...catalog, shopifyProductId: id, shopifyStoreDomain: shop },
        ...(existingId ? {} : { $setOnInsert: { merchantId, skinType: "all", concern: "none" } }) },
      { upsert: !existingId, new: true, runValidators: true, maxTimeMS: 10000 });
      if (!result) throw new AppError("A product changed during sync. Retry safely.", 409);
      productIds.set(id, result._id); summary.productsProcessed += 1;
    }
    for (const order of snapshot.orders) {
      const counters = await mongoose.connection.transaction(async session => {
        await checkLease(session);
        const filter = { merchantId, shopifyStoreDomain: shop, shopifyOrderId: order.id };
        const existingOrder = await ShopifyOrder.findOne(filter).session(session).lean();
        if (existingOrder?.sourceUpdatedAt > order.sourceUpdatedAt) throw new AppError("An older order snapshot was rejected. Retry the sync.", 409);
        const activeKeys = [];
        const priorEvents = await Event.find({ ...filter, source: "shopify" }).session(session).lean();
        const priorByKey = new Map(priorEvents.map(event => [event.dedupeKey, event]));
        const counts = { purchasesImported: 0, purchasesUpdated: 0, purchasesUnchanged: 0,
          purchasesRetired: 0, guestPurchaseLines: 0, unknownProductLines: 0 };
        for (const line of order.lines.filter(line => line.quantity > 0)) {
          const dedupeKey = eventKey(merchantId, shop, line.id);
          activeKeys.push(dedupeKey);
          const customerId = order.customerId ? customerIds.get(order.customerId) || null : null;
          const productId = line.productId ? productIds.get(line.productId) || null : null;
          if (order.customerId && !customerId) throw new AppError("An order customer could not be resolved. No changes to that order were saved.", 409);
          if (line.productId && !productId) throw new AppError("An order product could not be resolved. No changes to that order were saved.", 409);
          if (!customerId) counts.guestPurchaseLines += 1;
          if (!productId) counts.unknownProductLines += 1;
          const values = {
            source: "shopify", ...filter, shopifyLineItemId: line.id, sourceEventId: line.id,
            type: "purchase", customerId, productId, quantity: line.quantity,
            price: line.netAmountMinor / 100 / line.quantity, currency: "GBP", occurredAt: order.occurredAt
          };
          const previous = priorByKey.get(dedupeKey);
          const unchanged = previous && Object.entries(values).every(([key, value]) =>
            key === "occurredAt" ? new Date(previous[key]).getTime() === value.getTime() : String(previous[key] ?? "") === String(value ?? ""));
          if (unchanged) counts.purchasesUnchanged += 1;
          else {
            const result = await Event.updateOne({ merchantId, dedupeKey, source: "shopify" }, { $set: values },
              { upsert: true, runValidators: true, session, maxTimeMS: 10000 });
            if (result.upsertedCount) counts.purchasesImported += 1;
            else counts.purchasesUpdated += 1;
          }
          if (customerId) await Customer.updateOne({ _id: customerId, merchantId }, { $max: { lastSeenAt: order.occurredAt } }, { session, timestamps: false, maxTimeMS: 10000 });
        }
        await ShopifyOrder.updateOne(filter, { $set: { ...filter, occurredAt: order.occurredAt,
          sourceUpdatedAt: order.sourceUpdatedAt, financialStatus: order.financialStatus, cancelled: order.cancelled,
          test: order.test, currency: "GBP", lines: order.lines.map(({ productId, ...line }) => line) } },
        { upsert: true, runValidators: true, session, maxTimeMS: 10000 });
        // Only confirmed removed/refunded lines from this exact source order are
        // retired. Other Shopify orders, CSV and browsing Events are untouched.
        const retired = await Event.deleteMany({ ...filter, source: "shopify", dedupeKey: { $nin: activeKeys } }, { session, maxTimeMS: 10000 });
        counts.purchasesRetired = retired.deletedCount;
        return counts;
      }, { maxCommitTimeMS: 5000, timeoutMS: 20000 });
      for (const [key, value] of Object.entries(counters)) summary[key] += value;
      summary.ordersProcessed += 1;
      if (order.test && !snapshot.includeTestOrders) summary.excludedTestOrders += 1;
      if (order.cancelled || !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.financialStatus)) summary.excludedUnpaidOrCancelledOrders += 1;
    }
    return summary;
  } catch (error) {
    // Preserve confirmed counters; a failed/unknown transaction is not a
    // successful sync, and retries use the same durable source identities.
    const safe = new AppError(error instanceof AppError ? error.message : "The sync could not finish. Some records may already be saved; retry safely.",
      error instanceof AppError ? error.statusCode : 503);
    safe.syncSummary = summary;
    throw safe;
  }
}

module.exports = { amountMinor, mapOrder, fetchSnapshot, persistSnapshot, assertDatabaseReady,
  hasIndex, makeIdentityPlan, eventKey, sourceKey };
