// controllers/shopifyController.js
const jwt = require("jsonwebtoken");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchAllPages,
} = require("../services/shopifyService");
const Merchant = require("../models/Merchant");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");

const connectShopify = asyncHandler(async (req, res) => {
  const { shop } = req.query;
  if (!shop) {
    throw new AppError("Missing shop parameter, e.g. ?shop=your-store", 400);
  }

  const state = jwt.sign(
    { merchantId: req.merchant._id },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );

  res.json({ authorizeUrl: buildAuthorizeUrl(shop, state) });
});

const shopifyCallback = asyncHandler(async (req, res) => {
  const { shop, code, state } = req.query;
  if (!shop || !code || !state) {
    throw new AppError("Missing shop, code, or state from Shopify redirect", 400);
  }

  const decoded = jwt.verify(state, process.env.JWT_SECRET);
  const accessToken = await exchangeCodeForToken(shop, code);

  await Merchant.findByIdAndUpdate(decoded.merchantId, {
    shopifyStoreDomain: shop,
    shopifyAccessToken: accessToken,
    platformType: "shopify",
  });

  res.send("Shopify store connected. You can close this tab.");
});

const CUSTOMERS_QUERY = `
  query GetCustomers($cursor: String) {
    customers(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node { id firstName lastName email updatedAt }
      }
    }
  }
`;

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          status
          featuredImage { url }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

const ORDERS_QUERY = `
  query GetOrders($cursor: String) {
    orders(first: 50, after: $cursor, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          customer { id }
          lineItems(first: 50) {
            edges {
              node {
                quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                product { id }
              }
            }
          }
        }
      }
    }
  }
`;

const CATEGORY_ENUM = ["cleanser", "moisturizer", "serum", "sunscreen", "treatment", "toner", "mask", "other"];

function mapProductType(shopifyProductType) {
  const normalized = (shopifyProductType || "").toLowerCase().trim();
  return CATEGORY_ENUM.includes(normalized) ? normalized : "other";
}

const syncShopifyData = asyncHandler(async (req, res) => {
  const merchant = req.merchant;

  if (!merchant.shopifyAccessToken || !merchant.shopifyStoreDomain) {
    throw new AppError("Connect a Shopify store before syncing", 400);
  }

  const shop = merchant.shopifyStoreDomain;
  const token = merchant.shopifyAccessToken;

  // --- Customers ---
  const shopifyCustomers = await fetchAllPages(shop, token, CUSTOMERS_QUERY, (data) => data.customers);

  let customersUpserted = 0;
  let customerErrors = 0;

  for (const c of shopifyCustomers) {
    try {
      await Customer.findOneAndUpdate(
        { merchantId: merchant._id, shopifyCustomerId: c.id },
        {
          $set: {
            merchantId: merchant._id,
            shopifyCustomerId: c.id,
            firstName: c.firstName || "Unknown",
            lastName: c.lastName || "",
            email: c.email || null,
            lastSeenAt: c.updatedAt ? new Date(c.updatedAt) : null,
          },
          // Only applied the first time this customer is created — a
          // resync should never overwrite a skinType/concern that's
          // since been collected some other way.
          $setOnInsert: { skinType: "unknown", concern: "unknown" },
        },
        { upsert: true, new: true }
      );
      customersUpserted++;
    } catch (err) {
      console.error(`Failed to sync Shopify customer ${c.id}:`, err.message);
      customerErrors++;
    }
  }

  // --- Products ---
  const shopifyProducts = await fetchAllPages(shop, token, PRODUCTS_QUERY, (data) => data.products);

  let productsUpserted = 0;
  let productErrors = 0;

  for (const p of shopifyProducts) {
    try {
      await Product.findOneAndUpdate(
        { merchantId: merchant._id, shopifyProductId: p.id },
        {
          $set: {
            merchantId: merchant._id,
            shopifyProductId: p.id,
            title: p.title,
            handle: p.handle,
            brand: p.vendor || null,
            category: mapProductType(p.productType),
            price: Number(p.priceRangeV2?.minVariantPrice?.amount || 0),
            currency: p.priceRangeV2?.minVariantPrice?.currencyCode || "GBP",
            imageUrl: p.featuredImage?.url || null,
            isActive: p.status === "ACTIVE",
          },
          $setOnInsert: { skinType: "all", concern: "none" },
        },
        { upsert: true, new: true }
      );
      productsUpserted++;
    } catch (err) {
      console.error(`Failed to sync Shopify product ${p.id}:`, err.message);
      productErrors++;
    }
  }

  // Build Shopify-ID → Mongo-_id lookup maps now that both collections
  // are current — orders reference Shopify's IDs, and events need ours.
  const customerLookup = new Map(
    (await Customer.find({ merchantId: merchant._id, shopifyCustomerId: { $ne: null } })
      .select("_id shopifyCustomerId")
      .lean()
    ).map((c) => [c.shopifyCustomerId, c._id])
  );

  const productLookup = new Map(
    (await Product.find({ merchantId: merchant._id, shopifyProductId: { $ne: null } })
      .select("_id shopifyProductId")
      .lean()
    ).map((p) => [p.shopifyProductId, p._id])
  );

  // --- Orders → purchase events ---
  const shopifyOrders = await fetchAllPages(shop, token, ORDERS_QUERY, (data) => data.orders);

  let eventsWritten = 0;
  let skippedLineItems = 0;
  let orderErrors = 0;

  for (const order of shopifyOrders) {
    try {
      const customerId = order.customer ? customerLookup.get(order.customer.id) : null;

      // Delete-then-reinsert per order keeps resyncing idempotent without
      // a second unique key per line item, and stays scoped to this one
      // order so it can never touch view/add_to_cart events later on.
      await Event.deleteMany({ merchantId: merchant._id, shopifyOrderId: order.id });

      const lineItemDocs = [];

      for (const edge of order.lineItems.edges) {
        const lineItem = edge.node;
        const productId = lineItem.product ? productLookup.get(lineItem.product.id) : null;

        if (!customerId || !productId) {
          skippedLineItems++;
          continue;
        }

        lineItemDocs.push({
          merchantId: merchant._id,
          customerId,
          productId,
          type: "purchase",
          quantity: lineItem.quantity || 1,
          price: Number(lineItem.originalUnitPriceSet?.shopMoney?.amount || 0),
          currency: lineItem.originalUnitPriceSet?.shopMoney?.currencyCode || "GBP",
          occurredAt: new Date(order.createdAt),
          shopifyOrderId: order.id,
        });
      }

      if (lineItemDocs.length > 0) {
        await Event.insertMany(lineItemDocs);
        eventsWritten += lineItemDocs.length;
      }
    } catch (err) {
      console.error(`Failed to sync Shopify order ${order.id}:`, err.message);
      orderErrors++;
    }
  }

  res.json({
    message: "Shopify sync complete",
    customersUpserted,
    customerErrors,
    productsUpserted,
    productErrors,
    ordersProcessed: shopifyOrders.length,
    eventsWritten,
    skippedLineItems,
    orderErrors,
  });
});

module.exports = { connectShopify, shopifyCallback, syncShopifyData };