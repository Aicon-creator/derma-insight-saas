const rateLimit = require("express-rate-limit");

const options = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many recovery attempts. Please wait 15 minutes before trying again." }
};

const requestResetLimiter = rateLimit({ ...options, max: 5 });
const completeResetLimiter = rateLimit({ ...options, max: 10 });
module.exports = { requestResetLimiter, completeResetLimiter };
