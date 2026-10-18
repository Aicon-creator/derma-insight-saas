// Destructive demo generation can never be enabled in production.
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

module.exports = { blockProductionDemo };
