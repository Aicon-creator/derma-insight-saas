(function () {
  const form = document.getElementById("shopifyConnectForm");
  if (!form || typeof getMerchantToken !== "function" || !getMerchantToken()) return;
  const shop = document.getElementById("shopifyShop");
  const connect = document.getElementById("shopifyConnectBtn");
  const sync = document.getElementById("shopifySyncBtn");
  const refresh = document.getElementById("shopifyRefreshBtn");
  const disconnect = document.getElementById("shopifyDisconnectBtn");
  const status = document.getElementById("shopifyStatus");
  const result = document.getElementById("shopifyResult");
  const note = document.getElementById("shopifyDataNote");
  let state = null;
  let busy = false;

  function controls() {
    const running = busy || state?.syncStatus === "running";
    form.setAttribute("aria-busy", String(running));
    connect.disabled = running || !state?.configured;
    sync.disabled = Boolean(running || !state?.configured || !state?.connected || state?.reconnectRequired);
    disconnect.disabled = Boolean(running || !state?.connected && !state?.reconnectRequired);
    refresh.disabled = busy;
    shop.disabled = running || !state?.configured;
    shop.readOnly = Boolean(state?.shop);
    connect.textContent = state?.shop ? "Reconnect Shopify" : "Connect Shopify";
  }

  function summaryText(summary) {
    if (!summary) return "";
    const n = key => Number.isSafeInteger(summary[key]) && summary[key] >= 0 ? summary[key].toLocaleString("en-GB") : "0";
    return `${n("customersProcessed")} customer profiles and ${n("productsProcessed")} products processed. ` +
      `${n("ordersProcessed")} orders checked: ${n("purchasesImported")} purchase lines added, ` +
      `${n("purchasesUpdated")} updated, ${n("purchasesUnchanged")} unchanged and ${n("purchasesRetired")} refunded/removed lines retired. ` +
      `${n("guestPurchaseLines")} guest purchase lines; ${n("unknownProductLines")} lines without a current product record.`;
  }

  async function loadStatus() {
    busy = true; controls();
    try {
      state = await apiRequest("/api/shopify/status");
      if (state.shop) shop.value = state.shop;
      status.textContent = !state.configured ? "Shopify setup is in progress. CSV imports are available." :
        state.reconnectRequired ? "Reconnect your store to restore Shopify access." :
        state.connected ? `Connected to ${state.shop}.` : "Connect your Shopify store to import its data.";
      if (state.syncStatus === "running") status.textContent += " A sync is running; refresh its status shortly.";
      if (["failed", "interrupted"].includes(state.syncStatus)) status.textContent += " The last sync did not finish. Some records may be saved; retry after checking the connection.";
      if (state.lastSyncAt) status.textContent += ` Last successful sync: ${new Date(state.lastSyncAt).toLocaleString("en-GB")}.`;
      if (state.dataNote) note.textContent = state.dataNote + (state.includeTestOrders ? " Shopify test orders are included in this environment." : " Shopify test orders are excluded.");
      if (state.summary) result.textContent = summaryText(state.summary);
    } catch (error) {
      state = null;
      status.textContent = error.message || "Connection status could not be loaded. Retry.";
    } finally { busy = false; controls(); }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || connect.disabled) return;
    busy = true; controls(); result.textContent = "Opening Shopify to approve the connection…";
    try {
      const data = await apiRequest(`/api/shopify/connect?shop=${encodeURIComponent(shop.value.trim())}`);
      const url = new URL(data.authorizeUrl);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".myshopify.com") || url.pathname !== "/admin/oauth/authorize") throw new Error("Invalid Shopify authorization address.");
      window.location.assign(url.href);
    } catch (error) { result.textContent = error.message; busy = false; controls(); }
  });

  sync.addEventListener("click", async () => {
    if (busy || sync.disabled) return;
    busy = true; controls(); result.textContent = "Syncing your store. Keep this page open while it completes…";
    let message;
    try {
      const data = await apiRequest("/api/shopify/sync", { method: "POST" });
      message = `Sync complete. ${summaryText(data.summary)}`;
    } catch (error) {
      message = `${error.message} ${summaryText(error.responseData?.summary)}`.trim();
    } finally {
      busy = false;
      await loadStatus();
      result.textContent = message;
    }
  });

  refresh.addEventListener("click", () => { if (!busy) loadStatus(); });
  disconnect.addEventListener("click", async () => {
    if (busy || disconnect.disabled) return;
    busy = true; controls();
    try {
      const data = await apiRequest("/api/shopify/disconnect", { method: "POST" });
      busy = false;
      await loadStatus();
      result.textContent = data.message;
    } catch (error) { result.textContent = error.message; }
    finally { busy = false; controls(); }
  });

  loadStatus();
})();
