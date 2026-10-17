requireAuth();

function formatCurrency(value) {
  return `£${Number(value || 0).toFixed(2)}`;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString("en-GB");
}

function setText(elementId, value) {
  const element = document.getElementById(elementId);

  if (element) {
    element.textContent = value;
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

function formatUtcDate(dateValue) {
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
  });
}

function capitalizeWords(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatCountLabel(count, singular, plural = `${singular}s`) {
  const normalizedCount = Number(count || 0);
  return `${formatCount(normalizedCount)} ${normalizedCount === 1 ? singular : plural}`;
}

function renderSegmentBreakdown(containerId, segments) {
  const container = document.getElementById(containerId);

  if (!container) {
    return;
  }

  const entries = Object.entries(segments || {});

  if (!entries.length) {
    container.innerHTML = `<p class="empty-text">No segment data available yet.</p>`;
    return;
  }

  container.innerHTML = entries
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(
      ([label, count]) => `
        <div class="segment-row">
          <span>${escapeHtml(label)}</span>
          <strong>${formatCount(count)}</strong>
        </div>
      `
    )
    .join("");
}

function renderCustomerList(containerId, customers, emptyMessage, badgeLabel) {
  const container = document.getElementById(containerId);

  if (!container) {
    return;
  }

  if (!Array.isArray(customers) || customers.length === 0) {
    container.innerHTML = `<p class="empty-text">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  container.innerHTML = customers
    .slice(0, 8)
    .map((customer) => {
      const name = escapeHtml(customer.name || "Unnamed Customer");
      const email = escapeHtml(customer.email || "No email available");
      const skinType = escapeHtml(customer.skinType || "Unknown skin");
      const concern = escapeHtml(customer.concern || "Unknown concern");
      const lastActivity = formatUtcDate(customer.lastActivityAt);
      const metaParts = [
        `${skinType} · ${concern}`,
        customer.viewCount > 0 ? `${formatCount(customer.viewCount)} views` : null,
        customer.purchaseCount > 0
          ? `${formatCount(customer.purchaseCount)} purchase events`
          : null,
        lastActivity ? `Last activity ${lastActivity}` : null,
      ].filter(Boolean);

      return `
        <div class="customer-segment-card">
          <div class="primary">
            <h4>${name}</h4>
            <p>${email}</p>
            <p>${escapeHtml(metaParts.join(" · "))}</p>
          </div>

          <div class="customer-segment-meta">
            <span>${escapeHtml(badgeLabel)}</span>
            <strong>${formatCurrency(customer.totalSpent)}</strong>
          </div>
        </div>
      `;
    })
    .join("");
}

function getTopSegment(segments) {
  const entries = Object.entries(segments || {});

  if (!entries.length) {
    return null;
  }

  return entries.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
}

function getTopSegments(segments) {
  const entries = Object.entries(segments || {}).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  );

  if (!entries.length) {
    return [];
  }

  const highestCount = entries[0][1];
  return entries.filter((entry) => entry[1] === highestCount);
}

function percentOf(part, whole) {
  if (!whole) {
    return 0;
  }

  return Math.round((part / whole) * 100);
}

function tallyBy(customers, field) {
  return (customers || []).reduce((accumulator, customer) => {
    const key = customer[field] || "Unknown";
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function renderSegmentInsight(data) {
  const insightText = document.getElementById("segmentInsightText");

  if (!insightText) {
    return;
  }

  const summary = data.summary || {};
  const totalCustomers = Number(summary.totalCustomers || 0);
  const activeCustomers = Number(summary.activeCustomers || 0);
  const inactiveCustomers = Number(summary.inactiveCustomers || 0);
  const noActivityCustomers = Number(summary.noActivityCustomers || 0);
  const viewedNoPurchaseCustomers = Number(summary.viewedNoPurchaseCustomers || 0);
  const highValueCustomers = Number(summary.highValueCustomers || 0);
  const repeatBuyers = Number(summary.repeatBuyers || 0);
  const topSkinTypes = getTopSegments(data.skinTypeSegments);
  const topConcern = getTopSegment(data.concernSegments);

  if (!totalCustomers || !topSkinTypes.length || !topConcern) {
    insightText.textContent =
      "There is not enough customer data yet to generate reliable segment insights.";
    return;
  }

  const topSkinTypeLabel =
    topSkinTypes.length === 1
      ? `${capitalizeWords(topSkinTypes[0][0])} is your largest skin-type group`
      : `${topSkinTypes.map((entry) => capitalizeWords(entry[0])).join(" and ")} are your joint largest skin-type groups`;
  const topSkinTypeShare = percentOf(topSkinTypes[0][1], totalCustomers);

  const paragraphs = [
    `${topSkinTypeLabel} (${topSkinTypeShare}% of ${formatCount(totalCustomers)} customers each), while ${topConcern[0]} is the most common recorded concern.`,
    `${formatCountLabel(activeCustomers, "customer")} ${activeCustomers === 1 ? "is" : "are"} active inside the selected window, ${formatCountLabel(inactiveCustomers, "customer")} ${inactiveCustomers === 1 ? "has" : "have"} historical activity outside it, and ${formatCountLabel(noActivityCustomers, "customer")} ${noActivityCustomers === 1 ? "has" : "have"} no recorded event history yet.`,
  ];

  if (viewedNoPurchaseCustomers > 0) {
    paragraphs.push(
      viewedNoPurchaseCustomers === 1
        ? "1 customer has viewed products without purchasing, which may be your clearest conversion follow-up opportunity."
        : `${formatCount(viewedNoPurchaseCustomers)} customers have viewed products without purchasing, which may be your clearest conversion follow-up opportunity.`
    );
  }

  if (repeatBuyers > 0) {
    paragraphs.push(
      `${formatCountLabel(repeatBuyers, "customer")} ${repeatBuyers === 1 ? "qualifies" : "qualify"} as repeat ${repeatBuyers === 1 ? "buyer" : "buyers"} under the existing 2+ purchase-event definition.`
    );
  }

  if (highValueCustomers > 0) {
    const highValueSkinType = getTopSegment(tallyBy(data.highValueCustomers, "skinType"));

    if (highValueSkinType) {
      paragraphs.push(
        `${formatCountLabel(highValueCustomers, "customer")} ${highValueCustomers === 1 ? "sits" : "sit"} above the selected high-value threshold, led by ${capitalizeWords(highValueSkinType[0])} skin types.`
      );
    }
  }

  insightText.textContent = "";

  paragraphs.forEach((paragraph) => {
    const paragraphElement = document.createElement("p");
    paragraphElement.textContent = paragraph;
    insightText.appendChild(paragraphElement);
  });
}

async function loadSegments() {
  try {
    const inactiveDays = document.getElementById("inactiveDaysFilter")?.value || 30;
    const highValue = document.getElementById("highValueFilter")?.value || 100;

    const data = await apiRequest(
      `/api/segments?inactiveDays=${inactiveDays}&highValue=${highValue}`
    );
    const summary = data.summary || {};
    const filters = data.filters || {};
    const definitions = data.definitions || {};

    setText("segmentTotalCustomers", formatCount(summary.totalCustomers));
    setText("segmentActiveCustomers", formatCount(summary.activeCustomers));
    setText("segmentInactiveCustomers", formatCount(summary.inactiveCustomers));
    setText("segmentNoActivityCustomers", formatCount(summary.noActivityCustomers));
    setText(
      "segmentViewedNoPurchaseCustomers",
      formatCount(summary.viewedNoPurchaseCustomers)
    );
    setText("segmentRepeatBuyers", formatCount(summary.repeatBuyers));
    setText("segmentHighValueCustomers", formatCount(summary.highValueCustomers));
    setText(
      "segmentHighValueLabel",
      `Customers with recorded purchase revenue of ${formatCurrency(
        filters.highValueThreshold
      )}+`
    );
    setText(
      "segmentDefinitionText",
      definitions.overlapNotes ||
        "Activity buckets are mutually exclusive. Viewed-no-purchase, repeat-buyer, and high-value lists can overlap with them."
    );

    renderSegmentBreakdown("skinTypeSegmentsList", data.skinTypeSegments);
    renderSegmentBreakdown("concernSegmentsList", data.concernSegments);

    renderCustomerList(
      "activeCustomersList",
      data.activeCustomers,
      "No customers have recent recorded activity inside the selected window.",
      "Recent activity"
    );
    renderCustomerList(
      "repeatBuyersList",
      data.repeatBuyers,
      "No repeat buyers yet.",
      "2+ purchase events"
    );
    renderCustomerList(
      "viewedNoPurchaseCustomersList",
      data.viewedNoPurchaseCustomers,
      "No customers currently have views without purchases.",
      "Viewed only"
    );
    renderCustomerList(
      "highValueCustomersList",
      data.highValueCustomers,
      "No customers meet the selected high-value threshold yet.",
      `${formatCurrency(filters.highValueThreshold)}+`
    );
    renderCustomerList(
      "inactiveCustomersList",
      data.inactiveCustomers,
      "No historically active customers fall outside the selected window.",
      "Historical activity"
    );
    renderCustomerList(
      "noActivityCustomersList",
      data.noActivityCustomers,
      "Every customer has at least one recorded event.",
      "No event history"
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
  inactiveDaysFilter.addEventListener("change", loadSegments);
}

if (highValueFilter) {
  highValueFilter.addEventListener("change", loadSegments);
}

loadSegments();
