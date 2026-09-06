requireAuth();

const csvPreviewForm = document.getElementById("csvPreviewForm");
const previewBtn = document.getElementById("previewBtn");
const previewMeta = document.getElementById("previewMeta");
const previewRows = document.getElementById("previewRows");
const previewErrors = document.getElementById("previewErrors");

function setMeta(message, tone = "neutral") {
  previewMeta.className = `imports-meta imports-meta-${tone}`;
  previewMeta.textContent = message;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRows(rows) {
  if (!rows || rows.length === 0) {
    previewRows.innerHTML = `<p class="empty-text">No rows available in preview.</p>`;
    return;
  }

  const headers = Object.keys(rows[0]);
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const bodyHtml = rows
    .map((row) => {
      const cells = headers
        .map((header) => `<td>${escapeHtml(row[header])}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  previewRows.innerHTML = `
    <div class="imports-table-wrap">
      <table class="imports-table">
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>
  `;
}

function renderErrors(errors) {
  if (!errors || errors.length === 0) {
    previewErrors.innerHTML = `<p class="imports-success">No validation errors found.</p>`;
    return;
  }

  previewErrors.innerHTML = `
    <h3>Validation errors</h3>
    <ul class="imports-errors-list">
      ${errors
        .map(
          (error) =>
            `<li><strong>Row ${escapeHtml(error.row)}</strong> · ${escapeHtml(
              error.column
            )}: ${escapeHtml(error.message)}</li>`
        )
        .join("")}
    </ul>
  `;
}

csvPreviewForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const fileInput = document.getElementById("csvFile");
  const dataType = document.getElementById("dataType").value;
  const file = fileInput.files && fileInput.files[0];

  if (!file) {
    setMeta("Please choose a CSV file before previewing.", "error");
    return;
  }

  const formData = new FormData();
  formData.append("dataType", dataType);
  formData.append("file", file);

  previewBtn.disabled = true;
  previewBtn.textContent = "Previewing...";
  previewRows.innerHTML = "";
  previewErrors.innerHTML = "";
  setMeta("Uploading and validating CSV...", "neutral");

  try {
    const response = await apiRequest("/api/imports/csv/preview", {
      method: "POST",
      body: formData
    });

    setMeta(
      `Preview ready: ${response.totalRows || 0} rows found, showing up to 10.`,
      "success"
    );
    renderRows(response.previewRows || []);
    renderErrors(response.errors || []);
  } catch (error) {
    setMeta(error.message || "CSV preview failed.", "error");
    previewRows.innerHTML = "";
    previewErrors.innerHTML = "";
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = "Preview CSV";
  }
});
