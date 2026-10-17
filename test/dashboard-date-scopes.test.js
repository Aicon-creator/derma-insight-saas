const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/dashboard.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/dashboard.html"), "utf8");

function element() {
  const classes = new Set();
  return { value: "", textContent: "", innerHTML: "", style: {}, attributes: {}, handlers: {},
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name), toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild() {}, querySelectorAll() { return []; }, getContext() { return {}; } };
}

function harness() {
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], element()]));
  const controls = Object.fromEntries([".product-table-wrapper", "#filterSkinType", "#filterConcern", "#productSearch", "#sortProducts", ".product-rows"].map((key) => [key, element()]));
  controls["#sortProducts"].value = "revenue_desc";
  controls[".product-table-wrapper"].querySelector = (key) => controls[key];
  nodes.topProductsList.querySelector = (key) => controls[key];
  const main = element();
  const pending = [];
  const charts = [];
  const context = vm.createContext({
    console: { error() {} }, requireAuth() {}, setTimeout, clearTimeout,
    document: { getElementById: (id) => nodes[id] || null, querySelector: () => main,
      addEventListener() {}, createElement: () => element() },
    apiRequest(endpoint) {
      return new Promise((resolve, reject) => pending.push({ endpoint, resolve, reject }));
    },
    Chart: function (canvas, config) {
      this.config = config;
      this.destroy = () => { this.destroyed = true; };
      charts.push(this);
    }
  });
  vm.runInContext(source, context);
  const start = (days) => {
    vm.runInContext(`currentRange = ${days}`, context);
    return context.loadDashboardData();
  };
  const snapshot = () => JSON.stringify({
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { text: node.textContent, html: node.innerHTML, style: node.style }])),
    chartData: charts.filter((chart) => !chart.destroyed).map((chart) => chart.config.data),
    status: main.attributes
  });
  return { context, nodes, controls, main, pending, charts, start, snapshot };
}

function payload(endpoint, value, empty = false) {
  const period = { startAt: "2026-10-10T12:00:00Z", endAt: "2026-10-17T12:00:00Z" };
  if (endpoint.includes("/overview")) return {
    period, summary: { totalCustomers: value, totalProducts: value, totalRevenue: value,
      totalViews: value, totalAddToCart: value, totalPurchases: value },
    coverage: { eventsInSelectedPeriod: value,
      earliestEventAt: "2026-05-16T12:00:00Z", latestEventAt: "2026-10-14T12:00:00Z",
      selectedPeriodEarliestEventAt: empty ? null : "2026-10-12T12:00:00Z",
      selectedPeriodLatestEventAt: empty ? null : "2026-10-14T12:00:00Z" }
  };
  if (endpoint.includes("top-products")) return { topProducts: [] };
  if (endpoint.includes("/popular")) return { recommendations: empty ? [] : [{ title: `${value}-day pick`, revenue: value }] };
  if (endpoint.includes("/segments")) return { summary: { repeatBuyers: value, activeCustomers: value } };
  return { data: [{ date: "2026-10-14", revenue: value, purchases: value }] };
}

for (const oldOutcome of ["success", "failure"]) {
  test(`late ${oldOutcome} responses from the previous range cannot overwrite any current panel`, async () => {
    const h = harness();
    const oldRequest = h.start(30);
    const currentRequest = h.start(7);
    assert.equal(h.nodes.totalRevenue.textContent, "—", "Old metrics must be cleared while loading");
    assert.equal(h.main.attributes["aria-busy"], "true");
    const old = h.pending.slice(0, 5);
    const latest = h.pending.slice(5);
    assert.equal(latest.length, 5);
    assert.ok(latest.every((item) => /(?:days|inactiveDays)=7(?:&|$)/.test(item.endpoint)));
    latest.forEach((item) => item.resolve(payload(item.endpoint, 7)));
    await currentRequest;
    assert.equal(h.nodes.totalRevenue.textContent, "£7.00");
    assert.equal(h.nodes.repeatBuyerInsight.textContent, "7");
    assert.match(h.nodes.recommendationsList.innerHTML, /7-day pick/);
    assert.match(h.nodes.coverageSelectedEventRange.textContent, /12 Oct 2026 to 14 Oct 2026/);
    assert.match(h.nodes.coverageEventRange.textContent, /16 May 2026/);
    assert.match(h.nodes.coverageSelectedWindow.textContent, /12:00.*UTC/);
    assert.equal(h.main.attributes["aria-busy"], "false");
    const currentState = h.snapshot();
    old.forEach((item) => oldOutcome === "success" ? item.resolve(payload(item.endpoint, 30)) : item.reject(new Error("Old request failed")));
    await oldRequest;
    assert.equal(h.snapshot(), currentState);
  });
}

test("failed panels show unavailable rather than zero, and a retry can recover", async () => {
  const h = harness();
  const failed = h.start(7);
  h.pending.forEach((item) => item.reject(new Error("Network unavailable")));
  await failed;
  for (const id of ["totalCustomers", "totalRevenue", "conversionRate", "activityViews", "repeatBuyerInsight", "coverageEventsInPeriod"]) {
    assert.equal(h.nodes[id].textContent, "Unavailable");
  }
  assert.match(h.nodes.dashboardStatus.textContent, /Some data could not be loaded/);
  assert.equal(h.nodes.retryDashboardBtn.classList.contains("hidden"), false);
  assert.match(h.nodes.chartEmptyState.textContent, /unavailable/);

  const retried = h.start(7);
  h.pending.slice(5).forEach((item) => item.resolve(payload(item.endpoint, 12)));
  await retried;
  assert.equal(h.nodes.totalRevenue.textContent, "£12.00");
  assert.equal(h.nodes.retryDashboardBtn.classList.contains("hidden"), true);
  assert.match(h.nodes.dashboardStatus.textContent, /Showing the last 7 days/);
});

test("one failed panel does not discard successful panels", async () => {
  const h = harness();
  const request = h.start(30);
  h.pending.forEach((item) => item.endpoint.includes("/overview") ? item.reject(new Error("Overview failed")) : item.resolve(payload(item.endpoint, 30)));
  await request;
  assert.equal(h.nodes.totalRevenue.textContent, "Unavailable");
  assert.equal(h.nodes.repeatBuyerInsight.textContent, "30");
  assert.match(h.nodes.recommendationsList.innerHTML, /30-day pick/);
  assert.match(h.nodes.dashboardStatus.textContent, /Overview/);
});

test("a successful empty response shows real zeroes and an explicit empty selected range", async () => {
  const h = harness();
  const request = h.start(7);
  h.pending.forEach((item) => item.resolve(payload(item.endpoint, 0, true)));
  await request;
  assert.equal(h.nodes.totalRevenue.textContent, "£0.00");
  assert.equal(h.nodes.activityViews.textContent, "0");
  assert.equal(h.nodes.coverageSelectedEventRange.textContent, "No recorded events in this window");
  assert.match(h.nodes.coverageEventRange.textContent, /16 May 2026/);
  assert.match(h.nodes.chartEmptyState.textContent, /No purchase revenue/);
  assert.equal(h.nodes.retryDashboardBtn.classList.contains("hidden"), true);
});

test("product buyer-rate and revenue sorting still use the correct numeric fields", async () => {
  const h = harness();
  vm.runInContext("dashboardRequestId = 1", h.context);
  const request = h.context.loadTopProducts({ id: 1, days: 7, failedSections: [] });
  h.pending[0].resolve({ topProducts: [
    { productId: "p1", title: "A low", conversionRate: 10, revenue: 3 },
    { productId: "p2", title: "M middle", conversionRate: 60, revenue: 2 },
    { productId: "p3", title: "Z high", conversionRate: 90, revenue: 1 }
  ] });
  await request;
  const order = () => [...h.controls[".product-rows"].innerHTML.matchAll(/<strong>([^<]+)<\/strong>/g)].map((match) => match[1]);
  for (const [sort, expected] of [
    ["conversion_desc", ["Z high", "M middle", "A low"]],
    ["conversion_asc", ["A low", "M middle", "Z high"]],
    ["revenue_desc", ["A low", "M middle", "Z high"]]
  ]) {
    h.controls["#sortProducts"].value = sort;
    h.controls["#sortProducts"].handlers.change();
    assert.deepEqual(order(), expected);
  }
});
