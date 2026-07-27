const loginForm = document.getElementById("loginForm");
const messageEl = document.getElementById("message");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  messageEl.textContent = "";

  const email = document
    .getElementById("email")
    .value
    .trim()
    .toLowerCase();

  const password = document.getElementById("password").value;

  if (!email || !password) {
    messageEl.textContent = "Please enter your email and password.";
    return;
  }

  try {
    localStorage.removeItem("merchantToken");
    localStorage.removeItem("merchantData");

    const data = await apiRequest("/api/merchants/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email,
        password
      })
    });

    if (!data.token) {
      throw new Error("Login succeeded, but no authentication token was returned.");
    }

    saveMerchantToken(data.token);
    localStorage.setItem("merchantData", JSON.stringify(data));

    window.location.href = "./dashboard.html";
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    messageEl.textContent =
      error.message || "Login failed. Please check your credentials.";
  }
});