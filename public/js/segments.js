requireAuth();

function formatCurrency(value) {
  return "£" + Number(value || 0).toFixed(2);
}

function setText(elementId, value) {
  const element = document.getElementById(elementId);

  if (element) {
    element.textContent = value;
  }
}

function renderSegmentBreakdown(containerId, segments) {
  const container = document.getElementById(containerId);

  if (!container) return;

  const entries = Object.entries(segments || {});

  if (entries.length === 0) {
    container.innerHTML = `<p class="empty-text">No segment data available yet.</p>`;
    return;
  }

  container.innerHTML = entries
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => {
      return `
        <div class="segment-row">
          <span>${label}</span>
          <strong>${count}</strong>
        </div>
      `;
    })
    .join("");
}

function renderCustomerList(containerId, customers, emptyMessage) {
  const container = document.getElementById(containerId);

  if (!container) return;

  if (!customers || customers.length === 0) {
    container.innerHTML = `<p class="empty-text">${emptyMessage}</p>`;
    return;
  }

  container.innerHTML = customers
    .slice(0, 8)
    .map((customer) => {
      return `
        <div class="customer-segment-card">
          <div>
            <h4>${customer.name || "Unnamed Customer"}</h4>
            <p>${customer.email || "No email available"}</p>
          </div>

          <div class="customer-segment-meta">
            <span>${customer.skinType || "Unknown"}</span>
            <span>${customer.concern || "Unknown"}</span>
            <strong>${formatCurrency(customer.totalSpent)}</strong>
          </div>
        </div>
      `;
    })
    .join("");
}

function getTopSegment(segments) {
  const entries = Object.entries(segments || {});

  if (entries.length === 0) return null;

  return entries.sort((a, b) => b[1] - a[1])[0];
}

function tallyBy(customers, field) {
  const counts = {};

  (customers || []).forEach((customer) => {
    const key = customer[field] || "Unknown";
    counts[key] = (counts[key] || 0) + 1;
  });

  return counts;
}

function percentOf(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function renderSegmentInsight(data) {
  const insightText = document.getElementById("segmentInsightText");

  if (!insightText) return;

  const totalCustomers = data.summary?.totalCustomers || 0;
  const inactiveCustomers = data.summary?.inactiveCustomers || 0;
  const highValueCustomers = data.summary?.highValueCustomers || 0;
  const noPurchaseLeads = data.summary?.noPurchaseLeads || 0;

  const topSkinType = getTopSegment(data.skinTypeSegments);
  const topConcern = getTopSegment(data.concernSegments);

  if (!topSkinType || !topConcern || totalCustomers === 0) {
    insightText.textContent =
      "There is not enough customer data yet to generate segment insights.";
    return;
  }

  const sentences = [];

  sentences.push(
    `${topSkinType[0]} skin is your largest customer group (${percentOf(topSkinType[1], totalCustomers)}% of ${totalCustomers}), and ${topConcern[0]} is the most common concern overall.`
  );

  const topHvSkin = getTopSegment(tallyBy(data.highValueCustomers, "skinType"));
  const topHvConcern = getTopSegment(tallyBy(data.highValueCustomers, "concern"));

  if (highValueCustomers > 0 && topHvSkin && topHvConcern) {
    if (topHvSkin[0] !== topSkinType[0]) {
      sentences.push(
        `Your ${highValueCustomers} high-value customers actually skew ${topHvSkin[0]} rather than ${topSkinType[0]}, with ${topHvConcern[0]} as their leading concern — worth tailoring premium offers around that combination.`
      );
    } else {
      sentences.push(
        `Your highest-value customers are also mostly ${topHvSkin[0]} skin with ${topHvConcern[0]} concerns, so your biggest segment and your top spenders line up.`
      );
    }
  }

  if (inactiveCustomers > 0) {
    const topInactiveConcern = getTopSegment(tallyBy(data.inactiveCustomers, "concern"));
    const concernPhrase = topInactiveConcern
      ? `, most commonly around ${topInactiveConcern[0]}`
      : "";

    sentences.push(
      `${inactiveCustomers} customers (${percentOf(inactiveCustomers, totalCustomers)}%) have gone quiet${concernPhrase} — a re-engagement campaign could win some of them back.`
    );
  }

  if (noPurchaseLeads > 0) {
    sentences.push(
      `${noPurchaseLeads} more have browsed but never purchased, which is your clearest first-order opportunity.`
    );
  }

  insightText.textContent = sentences.join(" ");
}

async function loadSegments() {
  try {
    const inactiveDays =
      document.getElementById("inactiveDaysFilter")?.value || 30;

    const highValue =
      document.getElementById("highValueFilter")?.value || 100;

    console.log("SEGMENT FILTERS:", {
      inactiveDays,
      highValue
    });

    const data = await apiRequest(
      `/api/segments?inactiveDays=${inactiveDays}&highValue=${highValue}`
    );

    console.log("SEGMENT RESPONSE:", data);

    const summary = data.summary || {};

    setText("segmentTotalCustomers", summary.totalCustomers || 0);
    setText("segmentRepeatBuyers", summary.repeatBuyers || 0);
    setText("segmentInactiveCustomers", summary.inactiveCustomers || 0);
    setText("segmentHighValueCustomers", summary.highValueCustomers || 0);
    setText("segmentNoPurchaseLeads", summary.noPurchaseLeads || 0);

    renderSegmentBreakdown("skinTypeSegmentsList", data.skinTypeSegments);
    renderSegmentBreakdown("concernSegmentsList", data.concernSegments);

    renderCustomerList(
      "repeatBuyersList",
      data.repeatBuyers,
      "No repeat buyers yet."
    );

    renderCustomerList(
      "highValueCustomersList",
      data.highValueCustomers,
      "No high value customers yet."
    );

    renderCustomerList(
      "inactiveCustomersList",
      data.inactiveCustomers,
      "No inactive customers found."
    );

    renderCustomerList(
      "noPurchaseLeadsList",
      data.noPurchaseLeads,
      "No leads yet — every customer has purchased at least once."
    );

    renderSegmentInsight(data);
  } catch (error) {
    console.error("SEGMENTS PAGE ERROR:", error);
    alert(error.message || "Failed to load customer segments.");
  }
}

const inactiveDaysFilter = document.getElementById("inactiveDaysFilter");
const highValueFilter = document.getElementById("highValueFilter");

if (inactiveDaysFilter) {
  inactiveDaysFilter.addEventListener("change", () => {
    console.log("Inactive days changed:", inactiveDaysFilter.value);
    loadSegments();
  });
}

if (highValueFilter) {
  highValueFilter.addEventListener("change", () => {
    console.log("High value changed:", highValueFilter.value);
    loadSegments();
  });
}

loadSegments();