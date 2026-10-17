// Keep destructive demo tools and the unfinished Shopify flow out of production.
// There is deliberately no environment flag that can bypass these guards.
const blockInProduction = (message, statusCode) => (req, res, next) => {
  if (process.env.NODE_ENV === "production") {
    res.set("Cache-Control", "no-store");
    return res.status(statusCode).json({ message });
  }

  return next();
};

const blockProductionDemo = blockInProduction(
  "Demo data generation is unavailable in production.",
  403
);

const blockProductionShopify = blockInProduction(
  "Shopify connections and sync are temporarily unavailable while we complete the secure integration.",
  503
);

module.exports = { blockProductionDemo, blockProductionShopify };
