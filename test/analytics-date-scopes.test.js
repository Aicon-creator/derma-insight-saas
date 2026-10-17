const assert = require("node:assert/strict");
const { test, beforeEach, afterEach, mock } = require("node:test");
const Event = require("../models/Event");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const analytics = require("../controllers/analyticsController");
const { getPopularRecommendations } = require("../controllers/recommendationController");
const { getCustomerSegments } = require("../controllers/segmentController");
const getAnalyticsWindow = require("../utils/analyticsWindow");

const now = Date.parse("2026-10-17T12:00:00.000Z");
const merchantId = "507f1f77bcf86cd799439011";
const day = 86400000;

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now });
  mock.method(console, "error", () => {});
});
afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

async function call(handler, query = {}) {
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await handler({ merchant: { _id: merchantId }, query }, response);
  return response;
}

test("default window is 30 rolling days ending now in UTC", () => {
  const period = getAnalyticsWindow();
  assert.equal(period.days, 30);
  assert.equal(period.timeZone, "UTC");
  assert.equal(period.endAt.getTime(), now);
  assert.equal(period.startAt.getTime(), now - 30 * day);
});

for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "1e9", "366", ["7", "30"], { days: "7" }]) {
  test(`invalid date range ${JSON.stringify(value)} returns 400 before querying data`, async () => {
    const rejectQuery = () => { throw new Error("Validation must run before database access"); };
    const query = mock.method(Event, "aggregate", rejectQuery);
    const customers = mock.method(Customer, "find", rejectQuery);
    const counts = mock.method(Customer, "countDocuments", rejectQuery);
    for (const handler of [...Object.values(analytics), getPopularRecommendations, getCustomerSegments]) {
      const response = await call(handler, { days: value, inactiveDays: value });
      assert.equal(response.statusCode, 400);
      assert.match(response.body.message, /whole number between 1 and 365/);
    }
    assert.equal(query.mock.callCount(), 0);
    assert.equal(customers.mock.callCount(), 0);
    assert.equal(counts.mock.callCount(), 0);
  });
}

const fixtures = [
  ["2026-05-16T12:00:00Z", "view", 0],
  ["2026-08-01T12:00:00Z", "view", 0],
  ["2026-09-20T12:00:00Z", "purchase", 30],
  ["2026-10-10T12:00:00Z", "view", 0],
  ["2026-10-12T12:00:00Z", "view", 0],
  ["2026-10-14T12:00:00Z", "purchase", 19.99]
].map(([date, type, price]) => ({ merchantId, occurredAt: new Date(date), type, price, quantity: 1, customerId: "c1", productId: "p1" }));
fixtures.push({ ...fixtures[5], merchantId: "another-merchant", price: 999 });

function fixtureRows(match, rows = fixtures) {
  return rows.filter((row) => row.merchantId === match.merchantId &&
    (!match.type || row.type === match.type) &&
    (!match.occurredAt?.$gte || row.occurredAt >= match.occurredAt.$gte) &&
    (!match.occurredAt?.$lte || row.occurredAt <= match.occurredAt.$lte));
}

function stubOverview(rows = fixtures) {
  mock.method(Customer, "countDocuments", async () => 2);
  mock.method(Product, "countDocuments", async () => 3);
  mock.method(Customer, "aggregate", async () => [{ _id: "dry", count: 2 }]);
  mock.method(Event, "distinct", async () => ["one-active-id"]);
  return mock.method(Event, "aggregate", async (pipeline) => {
    const match = pipeline[0].$match;
    assert.equal(match.merchantId, merchantId);
    const selected = fixtureRows(match, rows);
    const group = pipeline.find((stage) => stage.$group)?.$group;
    if (group.earliestEventAt) {
      const dates = selected.map((row) => row.occurredAt).sort((a, b) => a - b);
      return dates.length ? [{ earliestEventAt: dates[0], latestEventAt: dates.at(-1) }] : [];
    }
    if (pipeline.at(-1).$count) return selected.length ? [{ count: 1 }] : [];
    const totalRevenue = selected.filter((row) => row.type === "purchase")
      .reduce((sum, row) => sum + row.price * row.quantity, 0);
    if (group.total) return selected.length ? [{ total: totalRevenue }] : [];
    return selected.length ? [{ totalEvents: selected.length,
      totalViews: selected.filter((row) => row.type === "view").length, totalAddToCart: 0,
      totalPurchases: selected.filter((row) => row.type === "purchase").length,
      totalRevenue, uniqueViewers: 1, uniquePurchasingViewers: 1 }] : [];
  });
}

for (const [days, count, earliest, revenue] of [
  [7, 3, "2026-10-10T12:00:00.000Z", 19.99],
  [30, 4, "2026-09-20T12:00:00.000Z", 49.99],
  [90, 5, "2026-08-01T12:00:00.000Z", 49.99]
]) {
  test(`${days}-day overview separates selected event dates from unchanged historical coverage`, async () => {
    stubOverview();
    const response = await call(analytics.getOverviewAnalytics, { days: String(days) });
    assert.equal(response.statusCode, 200);
    const { period, coverage, summary } = response.body;
    assert.equal(period.startAt.getTime(), now - days * day);
    assert.equal(period.endAt.getTime(), now);
    assert.equal(coverage.selectedPeriodEarliestEventAt.toISOString(), earliest);
    assert.equal(coverage.selectedPeriodLatestEventAt.toISOString(), "2026-10-14T12:00:00.000Z");
    assert.equal(coverage.earliestEventAt.toISOString(), "2026-05-16T12:00:00.000Z");
    assert.equal(coverage.eventsInSelectedPeriod, count);
    assert.equal(summary.totalRevenue, revenue);
    assert.equal(summary.totalCustomers, 2, "Inventory totals stay all time");
  });
}

test("a wider window can legitimately have the same observed event dates", async () => {
  stubOverview(fixtures.filter((row) => row.occurredAt >= new Date("2026-10-12T00:00:00Z")));
  const seven = (await call(analytics.getOverviewAnalytics, { days: "7" })).body;
  const thirty = (await call(analytics.getOverviewAnalytics, { days: "30" })).body;
  assert.notEqual(seven.period.startAt.getTime(), thirty.period.startAt.getTime());
  assert.equal(seven.coverage.selectedPeriodEarliestEventAt.getTime(), thirty.coverage.selectedPeriodEarliestEventAt.getTime());
});

test("empty selected window reports null event dates and genuine zero totals", async () => {
  stubOverview(fixtures.filter((row) => row.occurredAt < new Date("2026-10-01T00:00:00Z")));
  const { body, statusCode } = await call(analytics.getOverviewAnalytics, { days: "7" });
  assert.equal(statusCode, 200);
  assert.equal(body.coverage.selectedPeriodEarliestEventAt, null);
  assert.equal(body.coverage.selectedPeriodLatestEventAt, null);
  assert.equal(body.summary.totalEvents, 0);
  assert.equal(body.summary.totalRevenue, 0);
  assert.ok(body.coverage.earliestEventAt, "Historical coverage is retained");
});

for (const days of [1, 7, 30, 90, 365]) {
  test(`${days}-day revenue retains the first partial UTC date and excludes future events`, async () => {
    const cutoff = new Date(now - days * day);
    mock.method(Event, "aggregate", async (pipeline) => {
      assert.equal(pipeline[0].$match.merchantId, merchantId);
      assert.equal(pipeline[0].$match.occurredAt.$gte.getTime(), cutoff.getTime());
      assert.equal(pipeline[0].$match.occurredAt.$lte.getTime(), now);
      return [{ _id: cutoff.toISOString().slice(0, 10), revenue: 19.99, purchases: 1 }];
    });
    const { body } = await call(analytics.getRevenueOverTime, { days: String(days) });
    assert.equal(body.data.length, days + 1);
    assert.equal(body.data[0].date, cutoff.toISOString().slice(0, 10));
    assert.equal(body.data.at(-1).date, "2026-10-17");
    assert.equal(body.data.reduce((sum, row) => sum + row.revenue, 0), 19.99);
    assert.equal(body.data.filter((row) => row.revenue === 0).length, days);
  });
}

test("recommendation revenue superlative is limited to the displayed shortlist", async () => {
  mock.method(Event, "aggregate", async (pipeline) => {
    assert.equal(pipeline[0].$match.occurredAt.$gte.getTime(), now - 7 * day);
    assert.equal(pipeline[0].$match.occurredAt.$lte.getTime(), now);
    return [
      { title: "High engagement", revenue: 10, purchases: 1, uniqueViewers: 1, uniquePurchasingViewers: 1 },
      { title: "Shortlist revenue leader", revenue: 30, purchases: 1 }
    ];
  });
  const { body } = await call(getPopularRecommendations, { days: "7" });
  assert.equal(body.recommendations[1].recommendationReason, "Highest revenue among these recommendations.");
  assert.match(body.recommendations[0].recommendationReason, /viewers also purchased/);
  assert.doesNotMatch(JSON.stringify(body), /Highest revenue in the selected period|after product views/);
});
