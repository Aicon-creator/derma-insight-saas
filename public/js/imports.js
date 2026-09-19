requireAuth();

const csvPreviewForm = document.getElementById("csvPreviewForm");
const dataTypeInput = document.getElementById("dataType");
const fileInput = document.getElementById("csvFile");
const previewBtn = document.getElementById("previewBtn");
const confirmImportBtn = document.getElementById("confirmImportBtn");
const confirmImportHint = document.getElementById("confirmImportHint");
const previewMeta = document.getElementById("previewMeta");
const importMeta = document.getElementById("importMeta");
const previewRows = document.getElementById("previewRows");
const previewErrors = document.getElementById("previewErrors");
const IMPORTABLE_DATA_TYPE = "customers";
let previewState = null;
let importInFlight = false;
let importRequiresFreshPreview = false;

function pluralize(count, singular, plural = `${singular}s`) {
  return Number(count) === 1 ? singular : plural;
}

function formatRowCount(count) {
  return `${count} ${pluralize(count, "row")} found`;
}

function setMeta(message, tone = "neutral") {
  previewMeta.className = `imports-meta imports-meta-${tone}`;
  previewMeta.textContent = message;
}

function setImportMeta(message, tone = "neutral") {
  importMeta.className = message
    ? `imports-meta imports-meta-${tone}`
    : "imports-meta";
  importMeta.textContent = message;
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

function getSelectedFile() {
  return fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
}

function resetPreviewEligibility(options = {}) {
  const { preserveImportMessage = false, requireFreshPreview = false } = options;
  previewState = null;
  importRequiresFreshPreview = requireFreshPreview;

  if (!preserveImportMessage) {
    setImportMeta("");
  }

  updateConfirmImportState();
}

function selectionMatchesPreview() {
  const selectedFile = getSelectedFile();

  return Boolean(
    previewState &&
      selectedFile &&
      selectedFile === previewState.file &&
      dataTypeInput.value === previewState.dataType
  );
}

function formatImportSummary(result) {
  const importedCount = Number(result.importedCount || 0);
  const skippedCount = Number(result.skippedCount || 0);

  if (importedCount === 0) {
    return `No new customers were imported; ${skippedCount} existing ${pluralize(
      skippedCount,
      "customer"
    )} ${skippedCount === 1 ? "was" : "were"} skipped.`;
  }

  if (skippedCount === 0) {
    return `${importedCount} ${pluralize(importedCount, "customer")} imported.`;
  }

  return `${importedCount} ${pluralize(
    importedCount,
    "customer"
  )} imported and ${skippedCount} existing ${pluralize(skippedCount, "customer")} skipped.`;
}

function updateConfirmImportState() {
  const selectedFile = getSelectedFile();
  const selectedDataType = dataTypeInput.value;

  confirmImportBtn.disabled = true;

  if (importInFlight) {
    confirmImportHint.textContent = "Importing customers...";
    return;
  }

  if (selectedDataType !== IMPORTABLE_DATA_TYPE) {
    confirmImportHint.textContent =
      "Preview is available for this data type. Confirm Import for products and events is coming in a later stage.";
    return;
  }

  if (!selectedFile) {
    confirmImportHint.textContent = "Choose a customer CSV file to preview.";
    return;
  }

  if (importRequiresFreshPreview) {
    confirmImportHint.textContent =
      "Import complete. Preview the file again before confirming another import.";
    return;
  }

  if (!previewState) {
    confirmImportHint.textContent = "Preview a valid customer CSV to enable Confirm Import.";
    return;
  }

  if (!selectionMatchesPreview()) {
    confirmImportHint.textContent =
      "The selected file or data type changed. Preview again before confirming import.";
    return;
  }

  if (previewState.totalRows < 1 || previewState.hasErrors) {
    confirmImportHint.textContent = "Import blocked. Fix the validation errors and preview the file again.";
    return;
  }

  confirmImportBtn.disabled = false;
  confirmImportHint.textContent = "Ready to import this customer CSV.";
}

csvPreviewForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const dataType = dataTypeInput.value;
  const file = getSelectedFile();

  if (!file) {
    resetPreviewEligibility();
    setMeta("Please choose a CSV file before previewing.", "error");
    return;
  }

  resetPreviewEligibility();

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

    const previewErrorsList = Array.isArray(response.errors) ? response.errors : [];
    const totalRows = Number(response.totalRows || 0);

    setMeta(
      `Preview ready: ${formatRowCount(totalRows)}, showing up to 10.`,
      "success"
    );
    renderRows(response.previewRows || []);
    renderErrors(previewErrorsList);

    previewState = {
      dataType,
      file,
      totalRows,
      hasErrors: previewErrorsList.length > 0
    };
    importRequiresFreshPreview = false;
    updateConfirmImportState();
  } catch (error) {
    resetPreviewEligibility();
    setMeta(error.message || "CSV preview failed.", "error");
    previewRows.innerHTML = "";
    previewErrors.innerHTML = "";
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = "Preview CSV";
  }
});

fileInput.addEventListener("change", () => {
  resetPreviewEligibility();
});

dataTypeInput.addEventListener("change", () => {
  resetPreviewEligibility();
});

confirmImportBtn.addEventListener("click", async () => {
  if (confirmImportBtn.disabled || importInFlight || !previewState || !selectionMatchesPreview()) {
    return;
  }

  importInFlight = true;
  confirmImportBtn.disabled = true;
  confirmImportBtn.textContent = "Importing...";
  setImportMeta("Importing customers...", "neutral");
  updateConfirmImportState();

  const formData = new FormData();
  formData.append("dataType", previewState.dataType);
  formData.append("file", previewState.file);

  try {
    const response = await apiRequest("/api/imports/csv/import", {
      method: "POST",
      body: formData
    });

    setImportMeta(formatImportSummary(response), "success");
    resetPreviewEligibility({
      preserveImportMessage: true,
      requireFreshPreview: true
    });
  } catch (error) {
    const importErrors =
      error && error.responseData && Array.isArray(error.responseData.errors)
        ? error.responseData.errors
        : [];

    setImportMeta(error.message || "Customer import failed.", "error");
    if (importErrors.length > 0) {
      renderErrors(importErrors);
    }
    resetPreviewEligibility({
      preserveImportMessage: true
    });
  } finally {
    importInFlight = false;
    confirmImportBtn.textContent = "Confirm Import";
    updateConfirmImportState();
  }
});

updateConfirmImportState();
