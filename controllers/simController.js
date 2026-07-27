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

    const daysBack = Math.min(Number(req.body.daysBack || 30), 90);
    const now = Date.now();
    const docs = [];

    const getCustomerBehavior = () => {
      const r = Math.random();
      if (r < 0.12) return "inactive";
      if (r < 0.22) return "lapsed-buyer";
      if (r < 0.40) return "repeat-buyer";
      if (r < 0.73) return "engaged";
      return "casual";
    };

    const pickEventTypeByBehavior = (behavior) => {
      const r = Math.random();

      if (behavior === "inactive") {
        return "view";
      }

      if (behavior === "lapsed-buyer") {
        if (r < 0.35) return "view";
        if (r < 0.5) return "add_to_cart";
        return "purchase";
      }

      if (behavior === "casual") {
        if (r < 0.75) return "view";
        if (r < 0.93) return "add_to_cart";
        return "purchase";
      }

      if (behavior === "engaged") {
        if (r < 0.55) return "view";
        if (r < 0.82) return "add_to_cart";
        return "purchase";
      }

      if (behavior === "repeat-buyer") {
        if (r < 0.35) return "view";
        if (r < 0.60) return "add_to_cart";
        return "purchase";
      }

      return "view";
    };

    // Customers eligible for the "guaranteed recent activity" boost below.
    // Inactive and lapsed-buyer customers are deliberately left out so their
    // old timestamps stay old — otherwise this boost would randomly
    // undo the very thing the archetype is supposed to demonstrate.
    const recentBoostPool = [];

    for (const customer of customers) {
      const behavior = getCustomerBehavior();

      let eventCount = 0;

      if (behavior === "inactive") {
        eventCount = Math.floor(Math.random() * 2); // 0 or 1
      } else if (behavior === "lapsed-buyer") {
        eventCount = Math.floor(Math.random() * 3) + 2; // 2 to 4
      } else if (behavior === "casual") {
        eventCount = Math.floor(Math.random() * 4) + 1; // 1 to 4
      } else if (behavior === "engaged") {
        eventCount = Math.floor(Math.random() * 6) + 4; // 4 to 9
      } else if (behavior === "repeat-buyer") {
        eventCount = Math.floor(Math.random() * 8) + 6; // 6 to 13
      }

      const preferredProducts =
        behavior === "repeat-buyer"
          ? [...products].sort(() => 0.5 - Math.random()).slice(0, 3)
          : [];

      if (behavior !== "inactive" && behavior !== "lapsed-buyer") {
        recentBoostPool.push(customer);
      }

      for (let i = 0; i < eventCount; i++) {
        const product =
          behavior === "repeat-buyer"
            ? pick(preferredProducts)
            : pick(products);

        const type =
          behavior === "lapsed-buyer" && i === 0
            ? "purchase" // guarantee every lapsed buyer actually has a purchase on record
            : pickEventTypeByBehavior(behavior);

        let eventDaysBack;

        if (behavior === "inactive") {
          eventDaysBack = Math.floor(Math.random() * 120) + 35; // 35 to 154 days ago
        } else if (behavior === "lapsed-buyer") {
          eventDaysBack = Math.floor(Math.random() * 65) + 95; // 95 to 159 days ago
        } else if (type === "purchase") {
          eventDaysBack =
            Math.random() < 0.7
              ? Math.floor(Math.random() * 7) // 70% in last 7 days
              : Math.floor(Math.random() * daysBack);
        } else {
          eventDaysBack =
            Math.random() < 0.6
              ? Math.floor(Math.random() * 7) // 60% in last 7 days
              : Math.floor(Math.random() * daysBack);
        }

        const occurredAt = new Date(
          now - eventDaysBack * 24 * 60 * 60 * 1000
        );

        docs.push({
          merchantId,
          customerId: customer._id,
          productId: product._id,
          type,
          quantity: type === "purchase" ? (Math.random() < 0.85 ? 1 : 2) : 1,
          price: type === "purchase" ? product.price : 0,
          currency: product.currency || "GBP",
          sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
          occurredAt,
        });
      }
    }

    // Guarantee some recent purchase activity for strong 7-day analytics.
    // Pulled only from customers who aren't meant to look dormant.
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
        const eventDaysBack = Math.floor(Math.random() * 7); // always inside last 7 days
        const occurredAt = new Date(
          now - eventDaysBack * 24 * 60 * 60 * 1000
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
          occurredAt,
        });
      }
    }

    await Event.deleteMany({ merchantId });
    await Event.insertMany(docs);

    return res.status(201).json({
      message: "Test events generated",
      count: docs.length,
      daysBack,
      guaranteedRecentPurchasesForCustomers: recentActiveCustomers.length,
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