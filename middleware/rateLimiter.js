// middleware/rateLimiter.js
const rateLimit = require("express-rate-limit");

const isProduction = process.env.NODE_ENV === "production";

const authLimiter = rateLimit({
  windowMs: isProduction ? 15 * 60 * 1000 : 5 * 60 * 1000,
  max: isProduction ? 20 : 400,
  message: { message: "Too many attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = authLimiter;