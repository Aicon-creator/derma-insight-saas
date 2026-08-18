const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Event = require("../models/Event");

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const slugify = (str) =>
  str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");

/* =========================
   Generate Test Customers
========================= */
const generateTestCustomers = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const count = Math.min(Number(req.body.count || 200), 2000);

    const skinTypes = ["oily", "dry", "combination", "normal", "sensitive"];
    const concerns = [
      "acne",
      "hyperpigmentation",
      "aging",
      "dullness",
      "texture",
      "hydration",
    ];

    const firstNames = [
      "Amelia", "Sophie", "Maya", "Olivia", "Isabella", "Charlotte", "Grace",
      "Chloe", "Emily", "Ava", "Mia", "Ella", "Lily", "Freya", "Poppy", "Ruby",
      "Daniel", "James", "Oliver", "Jack", "Harry", "Charlie", "Thomas",
      "George", "Noah", "Ethan", "Lucas", "Mason", "Leo", "Alfie", "Priya",
      "Aisha", "Zara", "Layla", "Nadia", "Wei", "Chen", "Ana", "Sofia",
      "Elena", "Marcus", "David", "Michael", "Ryan", "Joshua", "Ben",
      "Samuel", "Ibrahim", "Hannah", "Megan",
    ];

    const lastNames = [
      "Roberts", "Carter", "Johnson", "Hughes", "Smith", "Brown", "Taylor",
      "Wilson", "Evans", "Thomas", "Walker", "White", "Edwards", "Green",
      "Baker", "Hall", "Wright", "King", "Scott", "Adams", "Nelson",
      "Mitchell", "Turner", "Phillips", "Campbell", "Parker", "Collins",
      "Bell", "Murphy", "Cook", "Bailey", "Cooper", "Richardson", "Cox",
      "Howard", "Ward", "Peterson", "Gray", "Watson", "Brooks", "Kelly",
      "Sanders", "Price", "Bennett", "Foster", "Reid", "Hunt", "Shaw",
      "Ali", "Khan",
    ];

    const docs = Array.from({ length: count }).map((_, i) => {
      const firstName = pick(firstNames);
      const lastName = pick(lastNames);
      const emailTag = String(i + 1).padStart(3, "0");
      const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${emailTag}@example.com`;

      return {
        merchantId,
        firstName,
        lastName,
        email,
        skinType: pick(skinTypes),
        concern: pick(concerns),
        lastSeenAt: new Date(),
      };
    });

    await Customer.deleteMany({ merchantId });
    await Customer.insertMany(docs);

    return res.status(201).json({
      message: "Test customers generated",
      count,
    });
  } catch (error) {
    console.log("🔥 GENERATE CUSTOMERS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

/* =========================
   Generate Test Products
========================= */
const generateTestProducts = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const count = Math.min(Number(req.body.count || 30), 200);

    const categories = [
      "cleanser",
      "moisturizer",
      "serum",
      "sunscreen",
      "treatment",
      "toner",
      "mask",
      "other",
    ];

    const skinTypes = [
      "oily",
      "dry",
      "combination",
      "normal",
      "sensitive",
      "all",
    ];

    const concerns = [
      "acne",
      "hyperpigmentation",
      "aging",
      "dullness",
      "texture",
      "hydration",
      "none",
    ];

    const products = Array.from({ length: count }).map((_, i) => {
      const category = pick(categories);
      const skinType = pick(skinTypes);
      const concern = pick(concerns);

      const title = `${category.toUpperCase()} ${i + 1} (${skinType})`;

      return {
        merchantId,
        title,
        handle: slugify(title),
        brand: "Derma Insight Test",
        category,
        skinType,
        concern,
        price: Number((5 + Math.random() * 45).toFixed(2)),
        currency: "GBP",
        imageUrl: null,
        isActive: true,
      };
    });

    await Product.deleteMany({ merchantId });
    await Product.insertMany(products);

    return res.status(201).json({
      message: "Test products generated",
      count,
    });
  } catch (error) {
    console.log("🔥 GENERATE PRODUCTS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

/* =========================
   Generate Test Events
========================= */
const generateTestEvents = async (req, res) => {
  try {
    const merchantId = req.merchant._id;
    const count = Math.min(Number(req.body.count || 1500), 20000);

    const customers = await Customer.find({ merchantId }).select("_id");
    const products = await Product.find({ merchantId }).select("_id price currency");

    if (customers.length === 0 || products.length === 0) {
      return res.status(400).json({
        message: "Generate customers and products first",
      });
    }

    const requestedDaysBack = Math.min(Number(req.body.daysBack || 30), 90);
    const daysBack = 90;
    const now = Date.now();
    const docs = [];
    const randomInt = (min, max) =>
      Math.floor(Math.random() * (max - min + 1)) + min;

    const getCustomerBehavior = () => {
      const r = Math.random();
      if (r < 0.12) return "inactive";
      if (r < 0.22) return "lapsed-buyer";
      if (r < 0.40) return "repeat-buyer";
      if (r < 0.73) return "engaged";
      return "casual";
    };

    // Returns funnel conversion rates for each behavior type
    // { viewToCart: probability of add_to_cart given view, cartToPurchase: probability of purchase given view }
    const getFunnelConversionRates = (behavior) => {
      if (behavior === "inactive") {
        return { viewToCart: 0.0, cartToPurchase: 0.0 };
      }
      if (behavior === "lapsed-buyer") {
        return { viewToCart: 0.15, cartToPurchase: 0.35 };
      }
      if (behavior === "casual") {
        return { viewToCart: 0.25, cartToPurchase: 0.12 };
      }
      if (behavior === "engaged") {
        return { viewToCart: 0.40, cartToPurchase: 0.20 };
      }
      if (behavior === "repeat-buyer") {
        return { viewToCart: 0.50, cartToPurchase: 0.35 };
      }
      return { viewToCart: 0.20, cartToPurchase: 0.10 };
    };

    // Customers eligible for recent boost (not inactive/lapsed-buyer)
    const recentBoostPool = [];
    const purchaseBucketSummary = {
      range0to7: 0,
      range8to30: 0,
      range31to60: 0,
      range61to90: 0,
    };

    const incrementPurchaseBucket = (purchaseDaysBack) => {
      if (purchaseDaysBack <= 7) {
        purchaseBucketSummary.range0to7 += 1;
      } else if (purchaseDaysBack <= 30) {
        purchaseBucketSummary.range8to30 += 1;
      } else if (purchaseDaysBack <= 60) {
        purchaseBucketSummary.range31to60 += 1;
      } else if (purchaseDaysBack <= 90) {
        purchaseBucketSummary.range61to90 += 1;
      }
    };

    const createPurchaseFunnel = (customerId, product, purchaseDaysBack) => {
      const boundedPurchaseDaysBack = Math.max(
        0,
        Math.min(daysBack, purchaseDaysBack)
      );
      const cartDaysBack = Math.min(
        daysBack,
        boundedPurchaseDaysBack + randomInt(0, 2)
      );
      const viewDaysBack = Math.min(daysBack, cartDaysBack + randomInt(0, 2));

      const purchaseOccurredAt = new Date(
        now - boundedPurchaseDaysBack * 24 * 60 * 60 * 1000
      );
      const cartOccurredAt = new Date(
        now - cartDaysBack * 24 * 60 * 60 * 1000
      );
      const viewOccurredAt = new Date(
        now - viewDaysBack * 24 * 60 * 60 * 1000
      );

      docs.push({
        merchantId,
        customerId,
        productId: product._id,
        type: "view",
        quantity: 1,
        price: 0,
        currency: product.currency || "GBP",
        sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
        occurredAt: viewOccurredAt,
      });

      docs.push({
        merchantId,
        customerId,
        productId: product._id,
        type: "add_to_cart",
        quantity: 1,
        price: 0,
        currency: product.currency || "GBP",
        sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
        occurredAt: cartOccurredAt,
      });

      docs.push({
        merchantId,
        customerId,
        productId: product._id,
        type: "purchase",
        quantity: Math.random() < 0.85 ? 1 : 2,
        price: product.price,
        currency: product.currency || "GBP",
        sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
        occurredAt: purchaseOccurredAt,
      });

      incrementPurchaseBucket(boundedPurchaseDaysBack);
    };

    for (const customer of customers) {
      const behavior = getCustomerBehavior();
      const rates = getFunnelConversionRates(behavior);

      // Decide how many products this customer will view
      let viewCount = 0;
      if (behavior === "inactive") {
        viewCount = Math.floor(Math.random() * 2); // 0 or 1
      } else if (behavior === "lapsed-buyer") {
        viewCount = Math.floor(Math.random() * 3) + 2; // 2 to 4
      } else if (behavior === "casual") {
        viewCount = Math.floor(Math.random() * 5) + 2; // 2 to 6
      } else if (behavior === "engaged") {
        viewCount = Math.floor(Math.random() * 8) + 5; // 5 to 12
      } else if (behavior === "repeat-buyer") {
        viewCount = Math.floor(Math.random() * 10) + 7; // 7 to 16
      }

      // For repeat buyers, pick a few favorite products to bias toward
      const preferredProducts =
        behavior === "repeat-buyer"
          ? [...products].sort(() => 0.5 - Math.random()).slice(0, 3)
          : [];

      if (behavior !== "inactive" && behavior !== "lapsed-buyer") {
        recentBoostPool.push(customer);
      }

      // For each product this customer will view, create a funnel event chain
      for (let i = 0; i < viewCount; i++) {
        const product =
          behavior === "repeat-buyer" && preferredProducts.length > 0
            ? pick(preferredProducts)
            : pick(products);

        // Determine timestamps for this funnel: view -> add_to_cart -> purchase
        let viewDaysBack;
        if (behavior === "inactive") {
          viewDaysBack = Math.floor(Math.random() * 120) + 35; // 35 to 154 days ago
        } else if (behavior === "lapsed-buyer") {
          // Keep lapsed buyers mostly outside 30 days but often inside 90 days
          // so 30-day and 90-day analytics are meaningfully different in demo data.
          viewDaysBack =
            Math.random() < 0.72
              ? Math.floor(Math.random() * 55) + 35 // 35 to 89 days ago
              : Math.floor(Math.random() * 70) + 90; // 90 to 159 days ago
        } else {
          // Active customers: bias toward recent views (60% in last 7 days)
          viewDaysBack =
            Math.random() < 0.6
              ? Math.floor(Math.random() * 7)
              : Math.floor(Math.random() * daysBack);
        }

        const viewOccurredAt = new Date(now - viewDaysBack * 24 * 60 * 60 * 1000);

        // Always create a view event first
        docs.push({
          merchantId,
          customerId: customer._id,
          productId: product._id,
          type: "view",
          quantity: 1,
          price: 0,
          currency: product.currency || "GBP",
          sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
          occurredAt: viewOccurredAt,
        });

        // Decide if this view converts to add_to_cart
        if (Math.random() < rates.viewToCart) {
          const cartDaysBack = viewDaysBack - Math.floor(Math.random() * 2); // same day or 1 day later
          const cartOccurredAt = new Date(now - Math.max(0, cartDaysBack) * 24 * 60 * 60 * 1000);

          docs.push({
            merchantId,
            customerId: customer._id,
            productId: product._id,
            type: "add_to_cart",
            quantity: 1,
            price: 0,
            currency: product.currency || "GBP",
            sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
            occurredAt: cartOccurredAt,
          });

          // Decide if add_to_cart converts to purchase
          if (Math.random() < rates.cartToPurchase) {
            const purchaseDaysBack = cartDaysBack - Math.floor(Math.random() * 3); // within 3 days after cart
            const purchaseOccurredAt = new Date(
              now - Math.max(0, purchaseDaysBack) * 24 * 60 * 60 * 1000
            );

            docs.push({
              merchantId,
              customerId: customer._id,
              productId: product._id,
              type: "purchase",
              quantity: Math.random() < 0.85 ? 1 : 2,
              price: product.price,
              currency: product.currency || "GBP",
              sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
              occurredAt: purchaseOccurredAt,
            });
            incrementPurchaseBucket(Math.max(0, purchaseDaysBack));
          }
        }
      }
    }

    // Guarantee recent purchase activity for strong 7-day analytics
    const recentActiveCustomers = [...recentBoostPool]
      .sort(() => 0.5 - Math.random())
      .slice(0, Math.min(20, recentBoostPool.length));

    const recentProducts = [...products]
      .sort(() => 0.5 - Math.random())
      .slice(0, Math.min(10, products.length));

    for (const customer of recentActiveCustomers) {
      const guaranteedPurchaseCount = Math.floor(Math.random() * 2) + 1; // 1 to 2

      for (let i = 0; i < guaranteedPurchaseCount; i++) {
        const product = pick(recentProducts);
        const viewDaysBack = Math.floor(Math.random() * 7); // inside last 7 days
        const viewOccurredAt = new Date(now - viewDaysBack * 24 * 60 * 60 * 1000);

        createPurchaseFunnel(customer._id, product, viewDaysBack);
      }
    }

    const eligibleWindowCustomers =
      recentBoostPool.length > 0 ? recentBoostPool : customers;
    const purchaseWindowPlan = [
      { minPurchases: 18, dayMin: 0, dayMax: 7 },
      { minPurchases: 24, dayMin: 8, dayMax: 30 },
      { minPurchases: 16, dayMin: 31, dayMax: 60 },
      { minPurchases: 12, dayMin: 61, dayMax: 90 },
    ];

    for (const windowPlan of purchaseWindowPlan) {
      for (let i = 0; i < windowPlan.minPurchases; i++) {
        const customer = pick(eligibleWindowCustomers);
        const product = pick(products);
        const purchaseDaysBack = randomInt(windowPlan.dayMin, windowPlan.dayMax);
        createPurchaseFunnel(customer._id, product, purchaseDaysBack);
      }
    }

    await Event.deleteMany({ merchantId });
    await Event.insertMany(docs);

    return res.status(201).json({
      message: "Test events generated",
      count: docs.length,
      daysBack,
      requestedDaysBack,
      guaranteedRecentPurchasesForCustomers: recentActiveCustomers.length,
      purchaseBucketSummary,
    });
  } catch (error) {
    console.log("GENERATE EVENTS ERROR:", error);
    return res.status(500).json({ message: error.message });
  }
};

module.exports = {
  generateTestCustomers,
  generateTestProducts,
  generateTestEvents,
};