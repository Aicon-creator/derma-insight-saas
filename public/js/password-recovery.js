(function () {
  const mode = document.body.dataset.recoveryMode;
  const form = document.getElementById("recoveryForm");
  const fields = document.getElementById("recoveryFields");
  const submit = document.getElementById("recoverySubmit");
  const status = document.getElementById("recoveryStatus");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const confirmation = document.getElementById("confirmPassword");
  const invalidLink = "This password-reset link is invalid or expired. Please request a new link.";
  const unavailable = "Password recovery is not available yet. Please contact your Derma Insight pilot contact for help.";
  let ready = false;
  let busy = false;
  let completed = false;
  let proof = null;

  if (mode === "reset") {
    try {
      const params = new URLSearchParams(window.location.hash.slice(1));
      // Remove the secret from address/history before making any API requests.
      window.history.replaceState(null, "", window.location.pathname);
      const id = params.get("id");
      const token = params.get("token");
      if (params.getAll("id").length === 1 && params.getAll("token").length === 1 &&
          /^[a-f0-9]{24}$/i.test(id || "") && /^[a-f0-9]{64}$/.test(token || "")) proof = { id, token };
    } catch { /* Fail closed when the link cannot be safely read/cleared. */ }
  }

  function setBusy(value) {
    busy = value;
    fields.disabled = value || !ready || completed;
    submit.disabled = fields.disabled;
    form.setAttribute("aria-busy", String(value));
    submit.textContent = completed ? "Password changed" : value ? "Please wait…" : mode === "reset" ? "Change password" : "Send reset link";
  }

  async function api(path, body) {
    const response = await fetch(`/api/merchants/auth/${path}`, {
      method: body ? "POST" : "GET", credentials: "omit", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(15000),
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error("Recovery request was not confirmed"), { status: response.status });
    return data;
  }

  async function initialize() {
    if (mode === "reset" && !proof) {
      status.textContent = invalidLink; setBusy(false); return;
    }
    setBusy(true);
    try {
      const result = await api("password-recovery");
      ready = result.available === true;
      status.textContent = ready ? mode === "reset" ? "Enter and confirm your new password." : "Enter the email address used for your merchant account." : unavailable;
    } catch {
      status.textContent = "We could not check password recovery. Please refresh this page and try again.";
    } finally { setBusy(false); }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !ready || completed) return;
    let body;
    if (mode === "request") {
      const value = email.value.trim().toLowerCase();
      if (value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) {
        status.textContent = "Please enter a valid email address."; return;
      }
      body = { email: value };
    } else {
      if (!proof) { status.textContent = invalidLink; ready = false; setBusy(false); return; }
      if (password.value.length < 8 || !password.value.trim() || new TextEncoder().encode(password.value).length > 72) {
        status.textContent = "Use a password of at least 8 characters and at most 72 UTF-8 bytes."; return;
      }
      if (password.value !== confirmation.value) {
        status.textContent = "Passwords do not match."; return;
      }
      body = { ...proof, password: password.value };
    }
    setBusy(true);
    status.textContent = "Please wait…";
    try {
      await api(mode === "reset" ? "reset-password" : "forgot-password", body);
      if (mode === "reset") {
        completed = true; proof = null;
        password.value = confirmation.value = "";
        try { localStorage.removeItem("merchantToken"); localStorage.removeItem("merchantData"); } catch { /* Server success is still success. */ }
        status.textContent = "Password changed. Please sign in with your new password.";
      } else {
        status.textContent = "If an account matches that email, a password-reset link will be sent. Check your inbox and spam folder. Please wait a minute before requesting another link.";
      }
    } catch (error) {
      if (error.status === 429) {
        status.textContent = "Too many recovery attempts. Please wait 15 minutes before trying again and request a new link if needed.";
        ready = false;
      } else if (mode === "reset") {
        status.textContent = error.status === 400 ? invalidLink : "We could not confirm the password change. Try signing in with the new password; otherwise request a new reset link.";
        ready = false; proof = null;
      } else {
        status.textContent = error.status === 503 ? unavailable : "We could not confirm your request. Check your inbox before trying again.";
      }
      if (mode === "reset") password.value = confirmation.value = "";
    } finally { setBusy(false); }
  });
  void initialize();
})();
