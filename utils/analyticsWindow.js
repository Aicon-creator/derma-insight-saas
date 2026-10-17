const AppError = require("./AppError");

// Rolling elapsed days, grouped into UTC dates for charts. Bound the range to
// prevent invalid dates and unbounded daily-series allocation from query input.
function getAnalyticsWindow(value, parameter = "days") {
  const raw = value === undefined ? "30" : value;
  const days = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;

  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new AppError(`${parameter} must be a whole number between 1 and 365.`, 400);
  }

  const endAt = new Date();
  return {
    days,
    startAt: new Date(endAt.getTime() - days * 24 * 60 * 60 * 1000),
    endAt,
    timeZone: "UTC"
  };
}

module.exports = getAnalyticsWindow;
