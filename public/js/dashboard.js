requireAuth();

let currentRange = 30;
let revenueChartInstance = null;
let dashboardRequestId = 0;

const overviewValueIds = [
  "totalCustomers", "totalProducts", "totalRevenue", "conversionRate",
  "activityViews", "activityAddToCart", "activityPurchases", "activityCustomers",
  "activityRevenue", "averagePurchaseValueInsight", "topSkinTypeInsight",
  "coverageTotalCustomers", "coverageCustomersWithActivity", "coverageCustomersWithoutActivity",
  "coverageTotalProducts", "coverageProductsWithActivity", "coverageProductsWithoutActivity",
  "coverageEventsInPeriod", "coverageEventRange", "coverageSelectedEventRange", "coverageSelectedWindow"
];
const customerValueIds = [
  "repeatBuyerInsight", "activeCustomersCount", "inactiveCustomersCount",
  "noActivityCustomersCount", "viewedNoPurchaseCustomersCount"
];

function isCurrentDashboardRequest(request) {
  return request.id === dashboardRequestId;
}

function setValues(ids, value) {
  ids.forEach((id) => setText(id, value));
}

function recordPanelFailure(request, section) {
  request.failedSections.push(section);
}

const newMerchantState = document.getElementById("newMerchantState");

function formatCurrency(value) {
  return `£${Number(value || 0).toFixed(2)}`;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString("en-GB");
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatViewerRate(item) {
  return item.conversionAvailable === false ? "Not available" : formatPercent(item.conversionRate);
}

function capitalizeWords(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function setText(elementId, value) {
  const element = document.getElementById(elementId);

  if (element) {
    element.textContent = value;
    element.classList.toggle("is-unavailable", value === "Unavailable");
  }
}

function escapeHtml(value) {
  if (value == null) {
    return "";
  }

  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderEmptyState(containerId, message) {
  const container = document.getElementById(containerId);

  if (!container) {
    return;
  }

  container.innerHTML = `<p class="empty-text">${escapeHtml(message)}</p>`;
}

function formatUtcDate(dateValue, options) {
  if (!dateValue) {
    return null;
  }

  const parsed = new Date(dateValue);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...options,
  });
}

function formatChartLabel(dateValue) {
  return (
    formatUtcDate(dateValue, {
      day: "numeric",
      month: "short",
    }) || dateValue
  );
}

function formatCoverageRange(earliestEventAt, latestEventAt, emptyMessage = "No recorded events yet") {
  const earliest = formatUtcDate(earliestEventAt);
  const latest = formatUtcDate(latestEventAt);

  if (!earliest || !latest) {
    return emptyMessage;
  }

  return `${earliest} to ${latest}`;
}

function formatSelectedWindow(period) {
  const format = (value) => {
    const date = new Date(value);
    return !value || Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-GB", {
      timeZone: "UTC", day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
  };
  const start = format(period?.startAt);
  const end = format(period?.endAt);
  return start && end ? `${start} to ${end} UTC` : "Window dates unavailable";
}

function formatTopSkinType(topSkinTypes) {
  if (!Array.isArray(topSkinTypes) || topSkinTypes.length === 0) {
    return {
      value: "No data",
      caption: "Customer base · all time",
    };
  }

  const normalized = topSkinTypes.map((entry) => ({
    skinType: capitalizeWords(entry.skinType || "Unknown"),
    percentage: Number(entry.percentage || 0),
  }));

  if (normalized.length === 1) {
    const [winner] = normalized;

    return {
      value: `${winner.skinType} — ${winner.percentage}%`,
      caption: "Customer base · all time",
    };
  }

  if (normalized.length === 2) {
    const labels = normalized.map((entry) => entry.skinType).join(" & ");

    return {
      value: `${labels} — ${normalized[0].percentage}% each`,
      caption: "Customer base · all time tie",
    };
  }

  return {
    value: `${normalized.length}-way tie — ${normalized[0].percentage}% each`,
    caption: normalized.map((entry) => `${entry.skinType} ${entry.percentage}%`).join(" · "),
  };
}

function customerDisplayName(customer) {
  const fullName = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
  return customer.name || fullName || "Unnamed customer";
}

function describeCustomerMeta(customer) {
  const parts = [];

  if (customer.email) {
    parts.push(customer.email);
  }

  if (customer.lastActivityAt) {
    const formatted = formatUtcDate(customer.lastActivityAt);
    if (formatted) {
      parts.push(`Last activity ${formatted}`);
    }
  }

  if (customer.viewCount > 0 && customer.purchaseCount === 0) {
    parts.push(`${formatCount(customer.viewCount)} views, no purchases`);
  }

  if (customer.purchaseCount >= 2) {
    parts.push(`${formatCount(customer.purchaseCount)} orders / separate purchases`);
  }

  if (Number(customer.totalSpent || 0) > 0) {
    parts.push(`Spent ${formatCurrency(customer.totalSpent)}`);
  }

  return parts.join(" · ") || "No additional activity details";
}

function renderCustomerList(containerId, customers, emptyMessage, badgeLabel) {
  const container = document.getElementById(containerId);

  if (!container) {
    return;
  }

  if (!Array.isArray(customers) || customers.length === 0) {
    renderEmptyState(containerId, emptyMessage);
    return;
  }

  container.innerHTML = customers
    .slice(0, 5)
    .map((customer) => {
      const metaLabel = [customer.skinType || "Unknown skin", customer.concern || "Unknown concern"]
        .filter(Boolean)
        .join(" · ");

      return `
        <div class="list-item">
          <div class="primary">
            <h4>${escapeHtml(customerDisplayName(customer))}</h4>
            <p>${escapeHtml(describeCustomerMeta(customer))}</p>
          </div>
          <small>${escapeHtml(badgeLabel || metaLabel || "Customer")}</small>
        </div>
      `;
    })
    .join("");
}

function showNewMerchantState(summary) {
  const hasNoData =
    Number(summary.totalCustomers || 0) === 0 &&
    Number(summary.totalProducts || 0) === 0 &&
    Number(summary.totalEvents || 0) === 0;

  if (newMerchantState) {
    newMerchantState.classList.toggle("hidden", !hasNoData);
  }
}

function openProductDetail(product) {
  const existing = document.getElementById("productDetailDrawer");
  if (existing) {
    existing.remove();
  }

  const activatingRow = document.querySelector(
    `[data-product-id="${escapeHtml(product.productId)}"]`
  );
  if (activatingRow) {
    activatingRow.setAttribute("aria-pressed", "true");
  }

  const drawer = document.createElement("div");
  drawer.id = "productDetailDrawer";
  drawer.className = "product-detail-drawer";
  drawer.innerHTML = `
    <div class="drawer-backdrop" role="dialog" aria-modal="true" aria-labelledby="productDrawerTitle">
      <div class="drawer-panel">
        <button class="drawer-close" aria-label="Close">×</button>
        <div class="drawer-content">
          <h3 id="productDrawerTitle">${escapeHtml(product.title)}</h3>
          <div class="drawer-grid">
            <div><strong>Skin type</strong><div>${escapeHtml(product.skinType)}</div></div>
            <div><strong>Concern</strong><div>${escapeHtml(product.concern)}</div></div>
            <div><strong>Views</strong><div>${formatCount(product.views)}</div></div>
            <div><strong>Add to cart</strong><div>${formatCount(product.addToCart)}</div></div>
            <div><strong>Purchases</strong><div>${formatCount(product.purchases)}</div></div>
            <div><strong>Revenue</strong><div>${formatCurrency(product.revenue)}</div></div>
            <div><strong>Viewer-to-buyer rate</strong><div>${formatViewerRate(product)}</div></div>
          </div>
          <p class="muted">Selected period only. Viewer-to-buyer rate uses unique purchasers divided by unique viewers.</p>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(drawer);
  const closeBtn = drawer.querySelector(".drawer-close");

  function closeDrawer() {
    drawer.remove();
    if (activatingRow) {
      activatingRow.setAttribute("aria-pressed", "false");
      activatingRow.focus();
    }
    document.removeEventListener("keydown", escHandler);
  }

  function escHandler(event) {
    if (event.key === "Escape") {
      closeDrawer();
    }
  }

  closeBtn.addEventListener("click", closeDrawer);
  drawer.querySelector(".drawer-backdrop").addEventListener("click", (event) => {
    if (event.target === drawer.querySelector(".drawer-backdrop")) {
      closeDrawer();
    }
  });
  document.addEventListener("keydown", escHandler);
  closeBtn.focus();
}

function debounce(fn, wait) {
  let timeoutId;

  return function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), wait);
  };
}

async function loadOverview(request) {
  try {
    const data = await apiRequest(`/api/analytics/overview?days=${request.days}`);
    if (!isCurrentDashboardRequest(request)) return;
    const summary = data.summary || {};
    const coverage = data.coverage || {};
    const topSkinType = formatTopSkinType(summary.topSkinTypes);
    const uniqueViewers = Number(summary.uniqueViewers || 0);
    const uniquePurchasingViewers = Number(summary.uniquePurchasingViewers || 0);
    const conversionSupportingText =
      uniqueViewers > 0
        ? `${formatCount(uniquePurchasingViewers)} of ${formatCount(uniqueViewers)} unique viewers purchased`
        : "No unique viewers in the selected period";

    showNewMerchantState(summary);

    setText("totalCustomers", formatCount(summary.totalCustomers));
    setText("totalProducts", formatCount(summary.totalProducts));
    setText("totalRevenue", formatCurrency(summary.totalRevenue));
    setText("conversionRate", formatViewerRate(summary));
    const unlinkedNote = (summary.guestPurchaseLines || summary.unknownProductPurchaseLines)
      ? ` ${formatCount(summary.guestPurchaseLines)} guest purchase lines and ${formatCount(summary.unknownProductPurchaseLines)} lines without a current product record are included in revenue; they cannot populate every customer/product insight.` : "";
    setText("dashboardSourceNote", (summary.sourceNote || "Revenue reflects the purchase amounts in your imported events.") + unlinkedNote);
    setText(
      "conversionRateCaption",
      `Selected period · ${conversionSupportingText}`
    );
    setText(
      "activityHelperText",
      `Counts reflect recorded event activity for the selected range. Conversion rate = ${summary.conversionDefinition || "unique viewers who also purchased divided by unique viewers in the selected period."}`
    );

    setText("activityViews", formatCount(summary.totalViews));
    setText("activityAddToCart", formatCount(summary.totalAddToCart));
    setText("activityPurchases", formatCount(summary.totalPurchases));
    setText("activityCustomers", formatCount(summary.customersWithActivityInPeriod));
    setText("activityRevenue", formatCurrency(summary.totalRevenue));

    setText("averagePurchaseValueInsight", formatCurrency(summary.averagePurchaseValue));
    setText("topSkinTypeInsight", topSkinType.value);
    setText("topSkinTypeCaption", topSkinType.caption);

    setText("coverageTotalCustomers", formatCount(coverage.totalCustomers));
    setText("coverageCustomersWithActivity", formatCount(coverage.customersWithActivity));
    setText(
      "coverageCustomersWithoutActivity",
      formatCount(coverage.customersWithoutActivity)
    );
    setText("coverageTotalProducts", formatCount(coverage.totalProducts));
    setText("coverageProductsWithActivity", formatCount(coverage.productsWithActivity));
    setText(
      "coverageProductsWithoutActivity",
      formatCount(coverage.productsWithoutActivity)
    );
    setText("coverageEventsInPeriod", formatCount(coverage.eventsInSelectedPeriod));
    setText("coverageSelectedWindow", formatSelectedWindow(data.period));
    setText(
      "coverageSelectedEventRange",
      formatCoverageRange(
        coverage.selectedPeriodEarliestEventAt,
        coverage.selectedPeriodLatestEventAt,
        "No recorded events in this window"
      )
    );
    setText(
      "coverageEventRange",
      formatCoverageRange(coverage.earliestEventAt, coverage.latestEventAt)
    );

    setText(
      "chartHelperText",
      `Daily purchase revenue for the selected rolling ${request.days}-day window. Dates without purchases stay visible at £0 and days are grouped by UTC date.`
    );

    return data;
  } catch (error) {
    if (!isCurrentDashboardRequest(request)) return;
    recordPanelFailure(request, "Overview");
    console.error("OVERVIEW ERROR:", error);

    setValues(overviewValueIds, "Unavailable");
    setText("conversionRateCaption", "Could not load selected-period metrics.");
    setText("activityHelperText", "Activity data could not be loaded. Retry the dashboard.");

    return null;
  }
}

async function loadTopProducts(request) {
  const container = document.getElementById("topProductsList");

  if (!container) {
    return;
  }

  container.innerHTML = `<div class="product-controls">
      <input type="search" id="productSearch" placeholder="Search products by name" aria-label="Search products" />
      <select id="filterSkinType"><option value="">All skin types</option></select>
      <select id="filterConcern"><option value="">All concerns</option></select>
      <select id="sortProducts">
        <option value="revenue_desc">Revenue ↓</option>
        <option value="revenue_asc">Revenue ↑</option>
        <option value="purchases_desc">Purchases ↓</option>
        <option value="purchases_asc">Purchases ↑</option>
        <option value="views_desc">Views ↓</option>
        <option value="views_asc">Views ↑</option>
        <option value="conversion_desc">Viewer-to-buyer rate ↓</option>
        <option value="conversion_asc">Viewer-to-buyer rate ↑</option>
      </select>
    </div>
    <div class="product-table-wrapper">
      <div class="product-table">
        <div class="product-row product-row--head">
          <div class="col name">Product</div>
          <div class="col skin">Skin</div>
          <div class="col concern">Concern</div>
          <div class="col views">Views</div>
          <div class="col addtocart">Add to cart</div>
          <div class="col purchases">Purchases</div>
          <div class="col revenue">Revenue</div>
          <div class="col conv">Buyer rate</div>
        </div>
        <div class="product-rows">
          ${Array.from({ length: 6 })
            .map(
              () => `<div class="product-skeleton-row">
                <div class="skeleton" style="width:60%"></div>
                <div class="skeleton" style="width:60%"></div>
                <div class="skeleton" style="width:60%"></div>
                <div class="skeleton" style="width:40%"></div>
                <div class="skeleton" style="width:40%"></div>
                <div class="skeleton" style="width:40%"></div>
                <div class="skeleton" style="width:50%"></div>
                <div class="skeleton" style="width:40%"></div>
              </div>`
            )
            .join("")}
        </div>
      </div>
    </div>`;

  try {
    const data = await apiRequest(`/api/analytics/top-products?limit=20&days=${request.days}`);
    if (!isCurrentDashboardRequest(request)) return;
    const products = data.topProducts || [];
    const wrapper = container.querySelector(".product-table-wrapper");

    setText(
      "topProductInsight",
      products[0]?.title
        ? `${products[0].title} — ${formatCurrency(products[0].revenue)}`
        : "No data"
    );

    if (!products.length) {
      wrapper.innerHTML = `<div class="empty-text">No product activity is available for the selected period.</div>`;
      return;
    }

    const skinSelect = container.querySelector("#filterSkinType");
    const concernSelect = container.querySelector("#filterConcern");
    const searchInput = container.querySelector("#productSearch");
    const sortSelect = container.querySelector("#sortProducts");
    const rows = products.map((product) => ({
      productId: product.productId || product._id,
      title: product.title || "Untitled product",
      skinType: product.skinType || "Unknown",
      concern: product.concern || "Unknown",
      views: Number(product.views || 0),
      addToCart: Number(product.addToCart || 0),
      purchases: Number(product.purchases || 0),
      revenue: Number(product.revenue || 0),
      conversionRate: Number(product.conversionRate || 0),
      conversionAvailable: product.conversionAvailable,
    }));

    [...new Set(rows.map((item) => item.skinType))]
      .sort((a, b) => a.localeCompare(b))
      .forEach((skinType) => {
        const option = document.createElement("option");
        option.value = skinType;
        option.textContent = skinType;
        skinSelect.appendChild(option);
      });

    [...new Set(rows.map((item) => item.concern))]
      .sort((a, b) => a.localeCompare(b))
      .forEach((concern) => {
        const option = document.createElement("option");
        option.value = concern;
        option.textContent = concern;
        concernSelect.appendChild(option);
      });

    wrapper.innerHTML = `
      <div class="product-table-actions">
        <div class="product-count">Showing <strong>${rows.length}</strong> products</div>
      </div>
      <div class="product-table">
        <div class="product-row product-row--head">
          <div class="col name">Product</div>
          <div class="col skin">Skin</div>
          <div class="col concern">Concern</div>
          <div class="col views">Views</div>
          <div class="col addtocart">Add to cart</div>
          <div class="col purchases">Purchases</div>
          <div class="col revenue">Revenue</div>
          <div class="col conv">Buyer rate</div>
        </div>
        <div class="product-rows"></div>
      </div>
    `;

    const rowsContainer = wrapper.querySelector(".product-rows");

    function renderProducts(list) {
      if (!list.length) {
        rowsContainer.innerHTML = `<div class="empty-text">No products match your filters.</div>`;
        return;
      }

      rowsContainer.innerHTML = list
        .map(
          (product, index) => `
            <div class="product-row product-row--body" tabindex="0" role="button" aria-pressed="false" data-index="${index}" data-product-id="${escapeHtml(product.productId)}">
              <div class="col name"><strong>${escapeHtml(product.title)}</strong></div>
              <div class="col skin">${escapeHtml(product.skinType)}</div>
              <div class="col concern">${escapeHtml(product.concern)}</div>
              <div class="col views">${formatCount(product.views)}</div>
              <div class="col addtocart">${formatCount(product.addToCart)}</div>
              <div class="col purchases">${formatCount(product.purchases)}</div>
              <div class="col revenue">${formatCurrency(product.revenue)}</div>
              <div class="col conv">${formatViewerRate(product)}</div>
            </div>
          `
        )
        .join("");

      rowsContainer.querySelectorAll(".product-row--body").forEach((element) => {
        element.addEventListener("click", () => {
          const index = Number(element.getAttribute("data-index"));
          openProductDetail(list[index]);
        });
        element.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const index = Number(element.getAttribute("data-index"));
            openProductDetail(list[index]);
          }
        });
      });
    }

    function applyFiltersAndRender() {
      const query = searchInput.value.trim().toLowerCase();
      const skinType = skinSelect.value;
      const concern = concernSelect.value;
      const sort = sortSelect.value;

      let filtered = rows.slice();

      if (query) {
        filtered = filtered.filter((product) =>
          product.title.toLowerCase().includes(query)
        );
      }

      if (skinType) {
        filtered = filtered.filter((product) => product.skinType === skinType);
      }

      if (concern) {
        filtered = filtered.filter((product) => product.concern === concern);
      }

      const [field, direction] = sort.split("_");
      const sortField = field === "conversion" ? "conversionRate" : field;
      filtered.sort((a, b) => {
        const multiplier = direction === "asc" ? 1 : -1;
        const left = Number(a[sortField] || 0);
        const right = Number(b[sortField] || 0);

        if (left !== right) {
          return (left - right) * multiplier;
        }

        return a.title.localeCompare(b.title);
      });

      renderProducts(filtered);
    }

    searchInput.addEventListener("input", debounce(applyFiltersAndRender, 120));
    skinSelect.addEventListener("change", applyFiltersAndRender);
    concernSelect.addEventListener("change", applyFiltersAndRender);
    sortSelect.addEventListener("change", applyFiltersAndRender);

    applyFiltersAndRender();
  } catch (error) {
    if (!isCurrentDashboardRequest(request)) return;
    recordPanelFailure(request, "Product performance");
    console.error("TOP PRODUCTS ERROR:", error);
    setText("topProductInsight", "Unavailable");
    container.querySelector(".product-table-wrapper").innerHTML =
      `<div class="empty-text">Failed to load product performance.</div>`;
  }
}

async function loadRecommendations(request) {
  const container = document.getElementById("recommendationsList");

  if (!container) {
    return;
  }

  try {
    const data = await apiRequest(`/api/recommendations/popular?limit=5&days=${request.days}`);
    if (!isCurrentDashboardRequest(request)) return;
    const recommendations = data.recommendations || [];

    if (!recommendations.length) {
      renderEmptyState(
        "recommendationsList",
        "Not enough purchase or browsing activity exists in this period to surface product recommendations yet."
      );
      return;
    }

    container.innerHTML = recommendations
      .map((item) => `
        <div class="recommendation-item">
          <div class="primary">
            <h4>${escapeHtml(item.title || "Untitled product")}</h4>
            <p>${escapeHtml(item.recommendationReason || "Recent product activity suggests this product deserves attention.")}</p>
            <div class="recommendation-metrics" aria-label="Recommendation evidence">
              <span>Views ${formatCount(item.views)}</span>
              <span>Add to cart ${formatCount(item.addToCart)}</span>
              <span>Purchases ${formatCount(item.purchases)}</span>
              <span>Revenue ${formatCurrency(item.revenue)}</span>
              <span>Viewer-to-buyer rate ${formatViewerRate(item)}</span>
            </div>
          </div>
          <span class="badge recommendation-badge">Selected period</span>
        </div>
      `)
      .join("");
  } catch (error) {
    if (!isCurrentDashboardRequest(request)) return;
    recordPanelFailure(request, "Recommendations");
    console.error("RECOMMENDATIONS ERROR:", error);
    renderEmptyState(
      "recommendationsList",
      "Recommendations are temporarily unavailable. Please try again in a moment."
    );
  }
}

async function loadCustomerIntelligence(request) {
  try {
    const data = await apiRequest(
      `/api/segments?inactiveDays=${request.days}&highValue=100`
    );
    if (!isCurrentDashboardRequest(request)) return;
    const summary = data.summary || {};
    const definitions = data.definitions || {};

    setText("repeatBuyerInsight", formatCount(summary.repeatBuyers));
    setText("activeCustomersCount", formatCount(summary.activeCustomers));
    setText("inactiveCustomersCount", formatCount(summary.inactiveCustomers));
    setText("noActivityCustomersCount", formatCount(summary.noActivityCustomers));
    setText(
      "viewedNoPurchaseCustomersCount",
      formatCount(summary.viewedNoPurchaseCustomers)
    );
    setText(
      "customerIntelligenceHelper",
      definitions.overlapNotes ||
        "Activity status buckets are mutually exclusive. Viewed-no-purchase, repeat buyer, and high-value signals can overlap with them."
    );

    renderCustomerList(
      "repeatBuyersList",
      data.repeatBuyers,
      "No repeat buyers are recorded yet.",
      "2+ Shopify orders or separate CSV purchases"
    );
    renderCustomerList(
      "inactiveUsersList",
      data.inactiveCustomers,
      "No customers have historical activity outside the selected window.",
      "Historical activity"
    );
    renderCustomerList(
      "noActivityCustomersList",
      data.noActivityCustomers,
      "Every customer has recorded activity already.",
      "No event history"
    );
  } catch (error) {
    if (!isCurrentDashboardRequest(request)) return;
    recordPanelFailure(request, "Customer intelligence");
    console.error("CUSTOMER INTELLIGENCE ERROR:", error);
    setValues(customerValueIds, "Unavailable");
    renderEmptyState("repeatBuyersList", "Repeat buyer insights are unavailable right now.");
    renderEmptyState(
      "inactiveUsersList",
      "Inactive customer insights are unavailable right now."
    );
    renderEmptyState(
      "noActivityCustomersList",
      "No-activity customer insights are unavailable right now."
    );
  }
}

function getTickStep(days) {
  if (days <= 7) {
    return 1;
  }

  if (days <= 30) {
    return 4;
  }

  return 10;
}

async function loadRevenueChart(request) {
  const canvas = document.getElementById("revenueChart");
  const chartEmptyState = document.getElementById("chartEmptyState");

  if (!canvas) {
    return;
  }

  try {
    const response = await apiRequest(`/api/analytics/revenue-over-time?days=${request.days}`);
    if (!isCurrentDashboardRequest(request)) return;
    const data = response.data || [];
    const hasRevenue = data.some((entry) => Number(entry.revenue || 0) > 0);

    if (!hasRevenue) {
      canvas.style.display = "none";
      if (revenueChartInstance) {
        revenueChartInstance.destroy();
        revenueChartInstance = null;
      }

      if (chartEmptyState) {
        chartEmptyState.textContent =
          "No purchase revenue is available for the selected timeframe yet.";
        chartEmptyState.classList.remove("hidden");
      }
      return;
    }

    canvas.style.display = "block";
    chartEmptyState?.classList.add("hidden");

    const labels = data.map((entry) => formatChartLabel(entry.date || entry._id));
    const rawDates = data.map((entry) => entry.date || entry._id);
    const values = data.map((entry) => Number(entry.revenue || 0));
    const purchases = data.map((entry) => Number(entry.purchases || 0));
    const tickStep = getTickStep(request.days);

    if (revenueChartInstance) {
      revenueChartInstance.destroy();
    }

    revenueChartInstance = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Revenue (£)",
            data: values,
            borderColor: "#1f7a8c",
            backgroundColor: "rgba(31, 122, 140, 0.14)",
            borderWidth: 3,
            tension: values.length === 1 ? 0 : 0.25,
            pointRadius: values.length === 1 ? 4 : 3,
            pointHoverRadius: 5,
            pointBackgroundColor: "#1f7a8c",
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: "index",
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                const index = items[0]?.dataIndex ?? 0;
                return formatUtcDate(rawDates[index]) || labels[index];
              },
              label: (context) => `Revenue: ${formatCurrency(context.parsed.y)}`,
              afterLabel: (context) =>
                `Purchase events: ${formatCount(purchases[context.dataIndex])}`,
            },
          },
        },
        scales: {
          x: {
            grid: {
              display: false,
            },
            ticks: {
              color: "#5c6d7d",
              autoSkip: false,
              maxRotation: 0,
              callback: (_, index) => {
                if (
                  index === 0 ||
                  index === labels.length - 1 ||
                  index % tickStep === 0
                ) {
                  return labels[index];
                }

                return "";
              },
            },
          },
          y: {
            beginAtZero: true,
            ticks: {
              callback: (value) => `£${Number(value).toFixed(0)}`,
              color: "#5c6d7d",
            },
            grid: {
              color: "rgba(148, 163, 184, 0.2)",
            },
          },
        },
      },
    });
  } catch (error) {
    if (!isCurrentDashboardRequest(request)) return;
    recordPanelFailure(request, "Revenue chart");
    console.error("REVENUE CHART ERROR:", error);
    canvas.style.display = "none";
    if (chartEmptyState) {
      chartEmptyState.textContent =
        "Revenue data is unavailable for the selected timeframe.";
      chartEmptyState.classList.remove("hidden");
    }
  }
}

async function loadDashboardData() {
  const request = { id: ++dashboardRequestId, days: currentRange, failedSections: [] };
  const retryButton = document.getElementById("retryDashboardBtn");
  const dashboard = document.querySelector("main.main-content");
  dashboard?.setAttribute("aria-busy", "true");
  retryButton?.classList.add("hidden");
  setText("dashboardStatus", `Loading the last ${request.days} days…`);
  setValues(overviewValueIds, "—");
  setValues(customerValueIds, "—");
  setText("topProductInsight", "Loading…");
  setText("conversionRateCaption", "Loading selected-period metrics…");
  setText("activityHelperText", "Loading activity for the selected period…");
  setText("topSkinTypeCaption", "Customer base · all time");
  newMerchantState?.classList.add("hidden");
  for (const id of ["recommendationsList", "repeatBuyersList", "inactiveUsersList", "noActivityCustomersList"]) {
    renderEmptyState(id, "Loading…");
  }
  if (revenueChartInstance) {
    revenueChartInstance.destroy();
    revenueChartInstance = null;
  }
  const canvas = document.getElementById("revenueChart");
  if (canvas) canvas.style.display = "none";
  setText("chartEmptyState", "Loading revenue for the selected period…");
  document.getElementById("chartEmptyState")?.classList.remove("hidden");
  setText("chartHelperText", `Daily purchase revenue for the selected rolling ${request.days}-day window. Days are grouped by UTC date.`);

  await Promise.all([
    loadOverview(request),
    loadTopProducts(request),
    loadRecommendations(request),
    loadCustomerIntelligence(request),
    loadRevenueChart(request),
  ]);

  if (!isCurrentDashboardRequest(request)) return;
  dashboard?.setAttribute("aria-busy", "false");
  if (request.failedSections.length) {
    setText("dashboardStatus", `Some data could not be loaded: ${request.failedSections.join(", ")}. Retry to refresh the last ${request.days} days.`);
    retryButton?.classList.remove("hidden");
  } else {
    setText("dashboardStatus", `Showing the last ${request.days} days. All-history metrics are labelled separately.`);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("retryDashboardBtn")?.addEventListener("click", loadDashboardData);
  const dateRangeSelect = document.getElementById("dateRange");

  if (dateRangeSelect) {
    currentRange = Number(dateRangeSelect.value || 30);
    dateRangeSelect.addEventListener("change", (event) => {
      currentRange = Number(event.target.value || 30);
      loadDashboardData();
    });
  }

  loadDashboardData();
});
