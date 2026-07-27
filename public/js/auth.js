function saveMerchantToken(token) {
  localStorage.removeItem("merchantToken");
  localStorage.setItem("merchantToken", token);
}

function getMerchantToken() {
  return localStorage.getItem("merchantToken");
}

function logoutMerchant() {
  localStorage.removeItem("merchantToken");
  localStorage.removeItem("merchantData");

  window.location.replace("./index.html");
}

function requireAuth() {
  const token = getMerchantToken();

  if (!token) {
    window.location.href = "/index.html";
  }
}