const API_BASE_URL = window.location.origin;

async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem("merchantToken");
  const isFormDataBody =
    typeof FormData !== "undefined" && options.body instanceof FormData;

  const headers = {
    ...(options.body && !isFormDataBody ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;

  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers
    });
  } catch (error) {
    console.error("NETWORK ERROR:", error);

    throw new Error(
      "Unable to connect to Derma Insight. Please check your connection and try again."
    );
  }

  const contentType = response.headers.get("content-type") || "";

  let data = {};

  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    const text = await response.text();
    data = text ? { message: text } : {};
  }

  if (response.status === 401) {
    localStorage.removeItem("merchantToken");
    localStorage.removeItem("merchantData");

    const isAuthPage =
      window.location.pathname.endsWith("/index.html") ||
      window.location.pathname.endsWith("/signup.html") ||
      window.location.pathname === "/";

    if (!isAuthPage) {
      window.location.replace("./index.html");
    }

    const error = new Error(data.message || "Your session has expired. Please log in again.");
    error.status = response.status;
    error.responseData = data;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(
      data.message ||
      data.error ||
      `Request failed with status ${response.status}`
    );
    error.status = response.status;
    error.responseData = data;
    throw error;
  }

  return data;
}