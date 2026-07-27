requireAuth();

let currentRange = 30;
let revenueChartInstance = null;

document.getElementById("logoutBtn").addEventListener("click", () => {
  logoutMerchant();
});

async function loadOverview() {
  try {
    const data = await apiRequest(`/api/analytics/overview?days=${currentRange}`);
    console.log("OVERVIEW RESPONSE:", data);

    const summary = data.summary;

    showNewMerchantState(summary);

    document.getElementById("totalCustomers").textContent = summary.totalCustomers;
    document.getElementById("totalProducts").textContent = summary.totalProducts;
    document.getElementById("totalRevenue").textContent =
      "£" + Number(summary.totalRevenue || 0).toFixed(2);
    document.getElementById("conversionRate").textContent =
      Number(summary.conversionRate || 0) + "%";
  } catch (error) {
    console.error("OVERVIEW ERROR:", error);
  }
}

async function loadTopProducts() {
  try {
    const data = await apiRequest(`/api/analytics/top-products?days=${currentRange}`);
    const container = document.getElementById("topProductsList");

    if (!data.topProducts || data.topProducts.length === 0) {
      container.innerHTML = "<p>No product performance data found.</p>";
      return;
    }

    container.innerHTML = data.topProducts
      .map(
        (product) => `
          <div class="list-item">
            <h4>${product.title}</h4>
            <p>Purchases: ${product.purchases} | Revenue: £${product.revenue}</p>
          </div>
        `
      )
      .join("");
  } catch (error) {
    console.error("TOP PRODUCTS ERROR:", error);
    document.getElementById("topProductsList").innerHTML =
      "<p>Failed to load top products.</p>";
  }
}

async function loadRecommendations() {
  const container = document.getElementById("recommendationsList");

  try {
    container.innerHTML = "<p>Loading recommendations...</p>";

    const data = await apiRequest(
      `/api/recommendations/popular?limit=5&days=${currentRange}`
    );
    console.log("POPULAR RECOMMENDATIONS RESPONSE:", data);

    const recommendations =
      data.recommendations ||
      data.data ||
      data.items ||
      (Array.isArray(data) ? data : []);

    if (!recommendations || recommendations.length === 0) {
      container.innerHTML = "<p>No recommendations found.</p>";
      return;
    }

    container.innerHTML = recommendations
      .map((item) => {
        const title =
          item.title ||
          item.name ||
          item.productName ||
          item.product?.title ||
          item.product?.name ||
          "Untitled Product";

        const reason =
          item.recommendationReason ||
          item.reason ||
          item.description ||
          "Recommended based on popularity.";

        const score =
          item.score ||
          item.totalScore ||
          item.views ||
          item.purchases ||
          item.count ||
          null;

        return `
          <div class="list-item">
            <h4>${title}</h4>
            <p>${reason}</p>
            ${score ? `<small>Score: ${score}</small>` : ""}
          </div>
        `;
      })
      .join("");
  } catch (error) {
    console.error("RECOMMENDATIONS ERROR:", error);
    container.innerHTML = "<p>Failed to load recommendations.</p>";
  }
}

async function loadRepeatBuyers() {
  const container = document.getElementById("repeatBuyersList");

  try {
    const data = await apiRequest(`/api/customers/repeat-buyers?days=${currentRange}`);
    console.log("REPEAT BUYERS:", data);

    const customers = data.customers || data.data || [];

    if (!customers.length) {
      container.innerHTML = "<p>No repeat buyers found.</p>";
      return;
    }

    container.innerHTML = customers
      .slice(0, 5)
      .map(
        (c) => `
        <div class="list-item">
          <h4>${c.firstName} ${c.lastName}</h4>
          <p>${c.email}</p>
        </div>
      `
      )
      .join("");
  } catch (error) {
    console.error(error);
    container.innerHTML = "<p>Failed to load repeat buyers.</p>";
  }
}

async function loadInactiveUsers() {
  const container = document.getElementById("inactiveUsersList");

  try {
    const data = await apiRequest(`/api/customers/inactive?days=${currentRange}`);
    console.log("INACTIVE USERS:", data);

    const customers =
      data.inactiveCustomers ||
      data.customers ||
      data.data ||
      [];

    if (!customers.length) {
      container.innerHTML = "<p>No inactive users found.</p>";
      return;
    }

    container.innerHTML = customers
      .slice(0, 5)
      .map(
        (c) => `
        <div class="list-item">
          <h4>${c.firstName || ""} ${c.lastName || ""}</h4>
          <p>${c.email || "No email available"}</p>
        </div>
      `
      )
      .join("");
  } catch (error) {
    console.error(error);
    container.innerHTML = "<p>Failed to load inactive users.</p>";
  }
}

async function loadRevenueChart() {
  try {
    const response = await apiRequest(
      `/api/analytics/revenue-over-time?days=${currentRange}`
    );
    console.log("REVENUE OVER TIME:", response);

    const data = response.data || [];

    const labels = data.map((item) => item._id);
    const values = data.map((item) => item.revenue);

    const canvas = document.getElementById("revenueChart");
    if (!canvas) {
      console.error("revenueChart canvas not found");
      return;
    }

    const ctx = canvas.getContext("2d");

    if (revenueChartInstance) {
      revenueChartInstance.destroy();
    }

    revenueChartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Revenue (£)",
            data: values,
            borderWidth: 2,
            tension: 0.3,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
      },
    });
  } catch (error) {
    console.error("REVENUE CHART ERROR:", error);
  }
}

async function loadInsights() {
  try {
    const productResponse = await apiRequest(
      `/api/analytics/top-products?days=${currentRange}`
    );
    console.log("TOP PRODUCTS INSIGHT:", productResponse);

    const topProducts =
      productResponse.topProducts ||
      productResponse.data ||
      productResponse.products ||
      (Array.isArray(productResponse) ? productResponse : []);

    if (topProducts.length > 0) {
      const firstProduct = topProducts[0];
      document.getElementById("topProductInsight").innerText =
        firstProduct.name ||
        firstProduct.title ||
        firstProduct._id ||
        "Unavailable";
    } else {
      document.getElementById("topProductInsight").innerText = "No data";
    }

    const skinResponse = await apiRequest(
      `/api/analytics/skin-type?days=${currentRange}`
    );
    console.log("TOP SKIN TYPE INSIGHT:", skinResponse);

    const skinTypes =
      skinResponse.skinTypeInsights ||
      skinResponse.skinTypes ||
      skinResponse.data ||
      skinResponse.analytics ||
      (Array.isArray(skinResponse) ? skinResponse : []);

    if (skinTypes.length > 0) {
      const firstSkin = skinTypes[0];
      document.getElementById("topSkinTypeInsight").innerText =
        firstSkin.skinType ||
        firstSkin._id ||
        firstSkin.name ||
        "Unavailable";
    } else {
      document.getElementById("topSkinTypeInsight").innerText = "No data";
    }

    const revenueResponse = await apiRequest(`/api/analytics/revenue-over-time?days=7`);
    const revenueData = revenueResponse.data || [];

    const total = revenueData.reduce((sum, item) => sum + item.revenue, 0);
    document.getElementById("revenueInsight").innerText = `£${total.toFixed(2)}`;

    const repeatResponse = await apiRequest(
      `/api/customers/repeat-buyers?days=${currentRange}`
    );
    const repeatBuyers =
      repeatResponse.customers ||
      repeatResponse.data ||
      (Array.isArray(repeatResponse) ? repeatResponse : []);

    document.getElementById("repeatBuyerInsight").innerText = repeatBuyers.length;
  } catch (error) {
    console.error("INSIGHTS ERROR:", error);

    document.getElementById("topProductInsight").innerText = "Error";
    document.getElementById("topSkinTypeInsight").innerText = "Error";
  }
}

function loadDashboardData() {
  loadOverview();
  loadTopProducts();
  loadRecommendations();
  loadRepeatBuyers();
  loadInactiveUsers();
  loadRevenueChart();
  loadInsights();
}

document.addEventListener("DOMContentLoaded", () => {
  const dateRangeSelect = document.getElementById("dateRange");

  if (dateRangeSelect) {
    currentRange = Number(dateRangeSelect.value);

    dateRangeSelect.addEventListener("change", (e) => {
      currentRange = Number(e.target.value);
      loadDashboardData();
    });
  }

  loadDashboardData();
});

const newMerchantState = document.getElementById("newMerchantState");
const generateDemoDataBtn = document.getElementById("generateDemoDataBtn");

function showNewMerchantState(overview) {
  const hasNoData =
    Number(overview.totalCustomers || 0) === 0 &&
    Number(overview.totalProducts || 0) === 0 &&
    Number(overview.totalEvents || 0) === 0;

  if (newMerchantState) {
    newMerchantState.classList.toggle("hidden", !hasNoData);
  }
}

async function postSimulatorData(endpoint, body) {
  const token = localStorage.getItem("merchantToken");

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || data.error || "Failed to generate demo data.");
  }

  return data;
}

if (generateDemoDataBtn) {
  generateDemoDataBtn.addEventListener("click", async () => {
    try {
      generateDemoDataBtn.disabled = true;
      generateDemoDataBtn.textContent = "Generating demo data...";

      await postSimulatorData("/api/sim/customers", { count: 200 });
      await postSimulatorData("/api/sim/products", { count: 30 });
      await postSimulatorData("/api/sim/events", {
        count: 1500,
        daysBack: 30
      });

      window.location.reload();
    } catch (error) {
      console.error(error);
      alert(error.message || "Could not generate demo data.");
      generateDemoDataBtn.disabled = false;
      generateDemoDataBtn.textContent = "Generate Demo Data";
    }
  });
}