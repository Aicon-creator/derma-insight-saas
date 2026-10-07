requireAuth();

let currentRange = 30;
let revenueChartInstance = null;

function formatCurrency(value) {
  return `£${Number(value || 0).toFixed(2)}`;
}

function setText(elementId, value) {
  const element = document.getElementById(elementId);

  if (element) {
    element.textContent = value;
  }
}

function renderEmptyState(containerId, message) {
  const container = document.getElementById(containerId);

  if (!container) return;

  container.innerHTML = `<p class="empty-text">${message}</p>`;
}

async function loadOverview() {
  try {
    const data = await apiRequest(`/api/analytics/overview?days=${currentRange}`);
    const summary = data.summary || {};

    showNewMerchantState(summary);

    setText("totalCustomers", Number(summary.totalCustomers || 0));
    setText("totalProducts", Number(summary.totalProducts || 0));
    setText("totalRevenue", formatCurrency(summary.totalRevenue || 0));
    setText("conversionRate", `${Number(summary.conversionRate || 0).toFixed(1)}%`);
  } catch (error) {
    console.error("OVERVIEW ERROR:", error);
    setText("totalCustomers", "0");
    setText("totalProducts", "0");
    setText("totalRevenue", formatCurrency(0));
    setText("conversionRate", "0.0%");
  }
}

async function loadTopProducts() {
  const container = document.getElementById("topProductsList");

  if (!container) return;

  // Initial loading state (skeleton)
  container.innerHTML = `<div class="product-controls">
      <input type="search" id="productSearch" placeholder="Search products by name" aria-label="Search products" />
      <select id="filterSkinType"><option value="">All skin types</option></select>
      <select id="filterConcern"><option value="">All concerns</option></select>
      <select id="sortProducts"><option value="revenue_desc">Revenue ↓</option><option value="revenue_asc">Revenue ↑</option><option value="purchases_desc">Purchases ↓</option><option value="purchases_asc">Purchases ↑</option><option value="views_desc">Views ↓</option><option value="views_asc">Views ↑</option><option value="conversion_desc">Conversion ↓</option><option value="conversion_asc">Conversion ↑</option></select>
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
          <div class="col conv">Conv %</div>
        </div>
        <div class="product-rows">
          ${Array.from({length:6}).map(()=>`<div class="product-skeleton-row">
            <div class="skeleton" style="width:60%"></div>
            <div class="skeleton" style="width:60%"></div>
            <div class="skeleton" style="width:60%"></div>
            <div class="skeleton" style="width:40%"></div>
            <div class="skeleton" style="width:40%"></div>
            <div class="skeleton" style="width:40%"></div>
            <div class="skeleton" style="width:50%"></div>
            <div class="skeleton" style="width:40%"></div>
          </div>`).join('')}
        </div>
      </div>
    </div>`;

  try {
    const data = await apiRequest(`/api/analytics/top-products?limit=20&days=${currentRange}`);
    const products = data.topProducts || data.recommendations || data.data || [];

    const wrapper = container.querySelector('.product-table-wrapper');

    if (!products || products.length === 0) {
      wrapper.innerHTML = `<div class="empty-text">No products available for the selected period.</div>`;
      return;
    }

    // Prepare filter options
    const skinTypes = [...new Set(products.map(p => p.skinType || 'all'))].filter(Boolean);
    const concerns = [...new Set(products.map(p => p.concern || 'none'))].filter(Boolean);

    const skinSelect = container.querySelector('#filterSkinType');
    const concernSelect = container.querySelector('#filterConcern');

    // Populate selects (preserve 'All' option)
    skinTypes.sort().forEach(st => {
      const opt = document.createElement('option'); opt.value = st; opt.textContent = st.charAt(0).toUpperCase() + st.slice(1); skinSelect.appendChild(opt);
    });
    concerns.sort().forEach(c => {
      const opt = document.createElement('option'); opt.value = c; opt.textContent = c.charAt(0).toUpperCase() + c.slice(1); concernSelect.appendChild(opt);
    });

    // Render the table container
    wrapper.innerHTML = `
      <div class="product-table-actions">
        <div class="product-count">Showing <strong>${products.length}</strong> products</div>
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
          <div class="col conv">Conv %</div>
        </div>
        <div class="product-rows"></div>
      </div>
    `;

    const rowsContainer = wrapper.querySelector('.product-rows');

    // Local state and render function
    let currentProducts = products.map(p => ({
      productId: p.productId || p._id,
      title: p.title || p.name || 'Untitled product',
      skinType: p.skinType || 'all',
      concern: p.concern || 'none',
      views: Number(p.views || 0),
      addToCart: Number(p.addToCart || 0),
      purchases: Number(p.purchases || 0),
      revenue: Number(p.revenue || 0),
      conversionRate: Number(p.conversionRate || 0),
      raw: p,
    }));

    function renderProducts(list) {
      if (!list || list.length === 0) {
        rowsContainer.innerHTML = `<div class="empty-text">No products match your filters.</div>`;
        return;
      }

      rowsContainer.innerHTML = list
        .map((p, idx) => `
          <div class="product-row product-row--body" tabindex="0" role="button" aria-pressed="false" data-index="${idx}" data-product-id="${p.productId}">
            <div class="col name"><strong>${escapeHtml(p.title)}</strong></div>
            <div class="col skin">${escapeHtml(p.skinType)}</div>
            <div class="col concern">${escapeHtml(p.concern)}</div>
            <div class="col views">${p.views}</div>
            <div class="col addtocart">${p.addToCart}</div>
            <div class="col purchases">${p.purchases}</div>
            <div class="col revenue">${formatCurrency(p.revenue)}</div>
            <div class="col conv">${p.conversionRate}%</div>
          </div>
        `)
        .join('');

     // attach click & keyboard handlers for detail
      rowsContainer.querySelectorAll('.product-row--body').forEach(el => {
        el.addEventListener('click', () => {
          const idx = Number(el.getAttribute('data-index'));
          openProductDetail(list[idx]);
        });
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const idx = Number(el.getAttribute('data-index'));
            openProductDetail(list[idx]);
          }
        });
      });
    }

    // search / filter / sort handlers
    const searchInput = container.querySelector('#productSearch');
    const sortSelect = container.querySelector('#sortProducts');

    function applyFiltersAndRender() {
      const q = searchInput.value.trim().toLowerCase();
      const skin = skinSelect.value;
      const concern = concernSelect.value;
      const sort = sortSelect.value;

      let filtered = currentProducts.slice();
      if (q) {
        filtered = filtered.filter(p => p.title.toLowerCase().includes(q));
      }
      if (skin) filtered = filtered.filter(p => (p.skinType||'').toLowerCase() === skin.toLowerCase());
      if (concern) filtered = filtered.filter(p => (p.concern||'').toLowerCase() === concern.toLowerCase());

      // sorting
      const [field, dir] = sort.split('_');
      filtered.sort((a,b)=>{
        const av = a[field] || 0;
        const bv = b[field] || 0;
        return dir === 'asc' ? (av - bv) : (bv - av);
      });

      renderProducts(filtered);
      const countEl = container.querySelector('.product-count strong');
      if (countEl) countEl.textContent = String(filtered.length);
    }

    // attach events
    [searchInput, skinSelect, concernSelect, sortSelect].forEach(el=>{
      el.addEventListener('input', debounce(applyFiltersAndRender, 250));
      el.addEventListener('change', applyFiltersAndRender);
    });

    // initial render
    applyFiltersAndRender();

  } catch (error) {
    console.error('TOP PRODUCTS ERROR:', error);
    container.querySelector('.product-table-wrapper').innerHTML = `<div class="empty-text">Failed to load top products.</div>`;
  }
}

// helpers for product UI
function escapeHtml(str){
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function debounce(fn, wait){
  let t;
  return function(...args){
    clearTimeout(t);
    t = setTimeout(()=>fn.apply(this,args), wait);
  }
}

function openProductDetail(product){
  // lightweight drawer
  const existing = document.getElementById('productDetailDrawer');
  if (existing) existing.remove();

  // mark activating row as pressed
  const activatingRow = document.querySelector(`[data-product-id="${product.productId}"]`);
  if(activatingRow) activatingRow.setAttribute('aria-pressed','true');

  const drawer = document.createElement('div');
  drawer.id = 'productDetailDrawer';
  drawer.className = 'product-detail-drawer';
  drawer.innerHTML = `
    <div class="drawer-backdrop" role="dialog" aria-modal="true">
      <div class="drawer-panel">
        <button class="drawer-close" aria-label="Close">×</button>
        <div class="drawer-content">
          <h3>${escapeHtml(product.title)}</h3>
          <div class="drawer-grid">
            <div><strong>Skin type</strong><div>${escapeHtml(product.skinType)}</div></div>
            <div><strong>Concern</strong><div>${escapeHtml(product.concern)}</div></div>
            <div><strong>Views</strong><div>${product.views}</div></div>
            <div><strong>Add to cart</strong><div>${product.addToCart}</div></div>
            <div><strong>Purchases</strong><div>${product.purchases}</div></div>
            <div><strong>Revenue</strong><div>${formatCurrency(product.revenue)}</div></div>
            <div><strong>Conversion</strong><div>${product.conversionRate}%</div></div>
          </div>
          <p class="muted">Data shown is for the selected period (${product.raw?.periodDays || ''}).</p>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(drawer);
  const closeBtn = drawer.querySelector('.drawer-close');

  function closeDrawer(){
    const row = activatingRow;
    drawer.remove();
    if(row) {
      row.setAttribute('aria-pressed','false');
      row.focus();
    }
    document.removeEventListener('keydown', escHandler);
  }

  closeBtn.addEventListener('click', closeDrawer);
  drawer.querySelector('.drawer-backdrop').addEventListener('click', (e)=>{
    if (e.target === drawer.querySelector('.drawer-backdrop')) closeDrawer();
  });

  function escHandler(e){ if(e.key === 'Escape') closeDrawer(); }
  document.addEventListener('keydown', escHandler);

  // move focus to close button for accessibility
  closeBtn.focus();
}
async function loadRecommendations() {
  const container = document.getElementById("recommendationsList");

  try {
    const data = await apiRequest(`/api/recommendations/popular?limit=5&days=${currentRange}`);
    const recommendations = data.recommendations || data.data || data.items || (Array.isArray(data) ? data : []);

    if (!recommendations || recommendations.length === 0) {
      renderEmptyState("recommendationsList", "No recommendations yet. Connect more data to unlock tailored product suggestions.");
      return;
    }

    container.innerHTML = recommendations
      .slice(0, 5)
      .map((item) => {
        const title = item.title || item.name || item.productName || item.product?.title || item.product?.name || "Untitled product";
        const reason = item.recommendationReason || item.reason || item.description || "Recommended based on customer demand and product activity.";
        const score = item.score || item.totalScore || item.views || item.purchases || item.count || null;

        return `
          <div class="recommendation-item">
            <div class="primary">
              <h4>${title}</h4>
              <p>${reason}</p>
              ${score ? `<small>Performance score: ${score}</small>` : ""}
            </div>
            <span class="badge">Top pick</span>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    console.error("RECOMMENDATIONS ERROR:", error);
    renderEmptyState("recommendationsList", "Recommendations are temporarily unavailable. Please try again in a moment.");
  }
}

async function loadRepeatBuyers() {
  const container = document.getElementById("repeatBuyersList");

  try {
    const data = await apiRequest(`/api/customers/repeat-buyers?days=${currentRange}`);
    const customers = data.customers || data.data || [];

    if (!customers.length) {
      renderEmptyState("repeatBuyersList", "No repeat buyers found for this period.");
      return;
    }

    container.innerHTML = customers
      .slice(0, 5)
      .map((customer) => {
        const firstName = customer.firstName || "";
        const lastName = customer.lastName || "";
        const name = `${firstName} ${lastName}`.trim() || "Unnamed customer";

        return `
          <div class="list-item">
            <div class="primary">
              <h4>${name}</h4>
              <p>${customer.email || "No email available"}</p>
            </div>
            <small>Repeat</small>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    console.error("REPEAT BUYERS ERROR:", error);
    renderEmptyState("repeatBuyersList", "Repeat buyer data is unavailable right now.");
  }
}

async function loadInactiveUsers() {
  const container = document.getElementById("inactiveUsersList");

  try {
    const data = await apiRequest(`/api/customers/inactive?days=${currentRange}`);
    const customers = data.inactiveCustomers || data.customers || data.data || [];

    if (!customers.length) {
      renderEmptyState("inactiveUsersList", "No inactive customers found for this period.");
      return;
    }

    container.innerHTML = customers
      .slice(0, 5)
      .map((customer) => {
        const firstName = customer.firstName || "";
        const lastName = customer.lastName || "";
        const name = `${firstName} ${lastName}`.trim() || "Unnamed customer";

        return `
          <div class="list-item">
            <div class="primary">
              <h4>${name}</h4>
              <p>${customer.email || "No email available"}</p>
            </div>
            <small>Inactive</small>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    console.error("INACTIVE USERS ERROR:", error);
    renderEmptyState("inactiveUsersList", "Inactive customer insights are temporarily unavailable.");
  }
}

async function loadRevenueChart() {
  const canvas = document.getElementById("revenueChart");
  const chartEmptyState = document.getElementById("chartEmptyState");

  try {
    const response = await apiRequest(`/api/analytics/revenue-over-time?days=${currentRange}`);
    const data = response.data || [];

    if (!canvas) {
      console.error("revenueChart canvas not found");
      return;
    }

    if (!data.length) {
      canvas.style.display = "none";
      chartEmptyState?.classList.remove("hidden");
      if (revenueChartInstance) {
        revenueChartInstance.destroy();
        revenueChartInstance = null;
      }
      return;
    }

    canvas.style.display = "block";
    chartEmptyState?.classList.add("hidden");

    const labels = data.map((item) => item._id || item.date || "Period");
    const values = data.map((item) => Number(item.revenue || 0));

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
            tension: 0.32,
            pointRadius: 3,
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
              label: (context) => `£${Number(context.parsed.y || 0).toFixed(2)}`,
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
            },
          },
          y: {
            beginAtZero: false,
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
    console.error("REVENUE CHART ERROR:", error);
    canvas.style.display = "none";
    chartEmptyState?.classList.remove("hidden");
    chartEmptyState.textContent = "Revenue data is unavailable for the selected timeframe.";
  }
}

async function loadInsights() {
  try {
    const productResponse = await apiRequest(`/api/analytics/top-products?days=${currentRange}`);
    const topProducts = productResponse.topProducts || productResponse.data || productResponse.products || (Array.isArray(productResponse) ? productResponse : []);

    const topProduct = topProducts[0];
    setText(
      "topProductInsight",
      topProduct ? topProduct.name || topProduct.title || topProduct._id || "Unavailable" : "No data"
    );

    const skinResponse = await apiRequest(`/api/analytics/skin-type?days=${currentRange}`);
    const skinTypes = skinResponse.skinTypeInsights || skinResponse.skinTypes || skinResponse.data || skinResponse.analytics || (Array.isArray(skinResponse) ? skinResponse : []);

    const topSkinType = skinTypes[0];
    setText(
      "topSkinTypeInsight",
      topSkinType ? topSkinType.skinType || topSkinType._id || topSkinType.name || "Unavailable" : "No data"
    );

    const revenueResponse = await apiRequest(`/api/analytics/revenue-over-time?days=7`);
    const revenueData = revenueResponse.data || [];
    const total = revenueData.reduce((sum, item) => sum + Number(item.revenue || 0), 0);
    setText("revenueInsight", formatCurrency(total));

    const repeatResponse = await apiRequest(`/api/customers/repeat-buyers?days=${currentRange}`);
    const repeatBuyers = repeatResponse.customers || repeatResponse.data || (Array.isArray(repeatResponse) ? repeatResponse : []);
    setText("repeatBuyerInsight", String(repeatBuyers.length));
  } catch (error) {
    console.error("INSIGHTS ERROR:", error);
    setText("topProductInsight", "No data");
    setText("topSkinTypeInsight", "No data");
    setText("revenueInsight", formatCurrency(0));
    setText("repeatBuyerInsight", "0");
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

    dateRangeSelect.addEventListener("change", (event) => {
      currentRange = Number(event.target.value);
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
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
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
        daysBack: 30,
      });

      window.location.reload();
    } catch (error) {
      console.error(error);
      alert(error.message || "Could not generate demo data.");
      generateDemoDataBtn.disabled = false;
      generateDemoDataBtn.textContent = "Explore Demo Data";
    }
  });
}
