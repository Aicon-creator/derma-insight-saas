// Business profile settings: the server, not the browser cache, is authoritative.
(function () {
  requireAuth();
  const pageToken = getMerchantToken();
  if (!pageToken) return;

  const form = document.getElementById("settingsForm");
  const fields = document.getElementById("settingsFields");
  const businessName = document.getElementById("businessName");
  const ownerName = document.getElementById("ownerName");
  const email = document.getElementById("merchantEmail");
  const save = document.getElementById("saveSettings");
  const reload = document.getElementById("reloadSettings");
  const status = document.getElementById("settingsStatus");
  let busy = false;
  let loaded = false;

  function sameSession() {
    if (getMerchantToken() === pageToken) return true;
    loaded = false;
    businessName.value = ownerName.value = email.value = "";
    status.textContent = "Your sign-in changed. Refresh this page before editing the profile.";
    reload.classList.add("hidden");
    return false;
  }

  function setBusy(value) {
    busy = value;
    fields.disabled = value || !loaded;
    save.disabled = value || !loaded;
    reload.disabled = value;
    form.setAttribute("aria-busy", String(value));
    save.textContent = value && loaded ? "Saving…" : "Save profile";
  }

  function acceptProfile(data) {
    const profile = data && data.merchant;
    if (!profile || typeof profile._id !== "string" || !profile._id ||
        !["businessName", "ownerName", "email"].every(key => typeof profile[key] === "string" && profile[key].trim())) {
      throw new Error("The server returned an incomplete profile.");
    }
    businessName.value = profile.businessName;
    ownerName.value = profile.ownerName;
    email.value = profile.email;
    // Keep only public fields; never copy a token, arbitrary response keys or
    // the old browser-only logo into the shared profile cache.
    const publicProfile = {
      _id: profile._id, businessName: profile.businessName, ownerName: profile.ownerName,
      email: profile.email, platformType: profile.platformType, subscriptionTier: profile.subscriptionTier
    };
    try { localStorage.setItem("merchantData", JSON.stringify(publicProfile)); } catch { /* The server save still succeeded. */ }
    window.dispatchEvent(new CustomEvent("di:merchant-profile-updated", { detail: publicProfile }));
    loaded = true;
  }

  async function loadProfile() {
    if (busy) return;
    if (!sameSession()) { setBusy(false); return; }
    loaded = false;
    setBusy(true);
    status.textContent = "Loading your business profile…";
    reload.classList.add("hidden");
    try {
      const data = await apiRequest("/api/merchants/profile");
      if (!sameSession()) return;
      acceptProfile(data);
      status.textContent = "Your business profile is up to date.";
    } catch {
      if (!sameSession()) return;
      status.textContent = "Your profile could not be loaded. Reload it before making changes.";
      reload.classList.remove("hidden");
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !loaded) return;
    if (!sameSession()) { setBusy(false); return; }
    const updates = { businessName: businessName.value.trim(), ownerName: ownerName.value.trim() };
    if (!updates.businessName || updates.businessName.length > 120 || !updates.ownerName || updates.ownerName.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(updates.businessName + updates.ownerName)) {
      status.textContent = "Enter a business name (up to 120 characters) and owner name (up to 100 characters), with no control characters.";
      return;
    }
    setBusy(true);
    status.textContent = "Saving your business profile…";
    reload.classList.add("hidden");
    try {
      const data = await apiRequest("/api/merchants/profile", { method: "PATCH", body: JSON.stringify(updates) });
      if (!sameSession()) return;
      acceptProfile(data);
      status.textContent = "Business profile saved to your account.";
    } catch {
      if (!sameSession()) return;
      loaded = false;
      status.textContent = "We could not confirm your changes were saved. Reload your profile to check before trying again.";
      reload.classList.remove("hidden");
    } finally {
      setBusy(false);
    }
  });
  reload.addEventListener("click", loadProfile);
  void loadProfile();
})();
