const signupForm = document.getElementById("signupForm");
const signupBtn = document.getElementById("signupBtn");
const signupMessage = document.getElementById("signupMessage");

const API_BASE_URL = "http://localhost:5000";

function showMessage(message, type) {
  signupMessage.textContent = message;
  signupMessage.className = `message ${type}`;
}

signupForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  const businessName = document.getElementById("businessName").value.trim();
  const ownerName = document.getElementById("ownerName").value.trim();
  const email = document.getElementById("email").value.trim().toLowerCase();
  const platformType = document.getElementById("platformType").value;
  const password = document.getElementById("password").value;
  const confirmPassword = document.getElementById("confirmPassword").value;

  if (!businessName || !ownerName || !email || !password || !confirmPassword) {
    showMessage("Please fill in all fields.", "error");
    return;
  }

  if (password.length < 6) {
    showMessage("Password must be at least 6 characters.", "error");
    return;
  }

  if (password !== confirmPassword) {
    showMessage("Passwords do not match.", "error");
    return;
  }

  try {
    signupBtn.disabled = true;
    signupBtn.textContent = "Creating account...";
    showMessage("", "");

    const response = await fetch(`${API_BASE_URL}/api/merchants/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        businessName,
        ownerName,
        email,
        password,
        platformType
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || data.error || "Account creation failed.");
    }

    const token = data.token || data.merchantToken || data?.data?.token;

    if (token) {
      localStorage.setItem("merchantToken", token);
      showMessage("Account created successfully. Redirecting...", "success");

      setTimeout(() => {
        window.location.href = "./dashboard.html";
      }, 1000);
    } else {
      showMessage("Account created successfully. Please login.", "success");

      setTimeout(() => {
        window.location.href = "./index.html";
      }, 1000);
    }

  } catch (error) {
    console.error("Signup error:", error);
    showMessage(error.message || "Something went wrong. Please try again.", "error");
  } finally {
    signupBtn.disabled = false;
    signupBtn.textContent = "Create Account";
  }
});