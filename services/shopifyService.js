const crypto = require("node:crypto");
const AppError = require("../utils/AppError");

const REQUIRED_SCOPES = ["read_customers", "read_products", "read_orders"];
const TEMPORARY_MESSAGE = "Shopify is unavailable until the store connection is configured.";

function getShopifyConfig() {
  const key = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY || "";
  const clientId = process.env.SHOPIFY_API_KEY || "";
  const clientSecret = process.env.SHOPIFY_API_SECRET || "";
  let redirect;
  try { redirect = new URL(process.env.SHOPIFY_REDIRECT_URI); } catch { /* unconfigured */ }
  const local = redirect && ["localhost", "127.0.0.1"].includes(redirect.hostname);
  const validRedirect = redirect && !redirect.username && !redirect.password && !redirect.search && !redirect.hash &&
    redirect.pathname === "/api/shopify/callback" &&
    (redirect.protocol === "https:" || (process.env.NODE_ENV !== "production" && local && redirect.protocol === "http:"));
  const validKey = /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, "base64").length === 32;
  const version = process.env.SHOPIFY_API_VERSION || "2026-07";
  const scopes = (process.env.SHOPIFY_SCOPES || REQUIRED_SCOPES.join(",")).split(",").map(s => s.trim()).filter(Boolean);
  const configured = process.env.SHOPIFY_ENABLED === "true" && Boolean(clientId && clientSecret && validRedirect && validKey) &&
    /^20\d{2}-(01|04|07|10)$/.test(version) && REQUIRED_SCOPES.every(s => scopes.includes(s)) &&
    scopes.every(s => [...REQUIRED_SCOPES, "read_all_orders"].includes(s));
  return { configured, clientId, clientSecret, redirectUri: redirect?.href, origin: redirect?.origin,
    version, scopes, encryptionKey: validKey ? Buffer.from(key, "base64") : null,
    includeTestOrders: process.env.SHOPIFY_INCLUDE_TEST_ORDERS === "true" };
}

function requireShopifyConfig() {
  const config = getShopifyConfig();
  if (!config.configured) throw new AppError(TEMPORARY_MESSAGE, 503);
  return config;
}

function normalizeShop(value) {
  if (typeof value !== "string" || value.length > 120) throw new AppError("Enter your store's myshopify.com address.", 400);
  let shop = value.trim().toLowerCase();
  if (/^https:\/\//.test(shop)) {
    let url;
    try { url = new URL(shop); } catch { throw new AppError("Invalid Shopify store address.", 400); }
    if (url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
      throw new AppError("Use only the store's myshopify.com address.", 400);
    }
    shop = url.hostname;
  }
  if (/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/.test(shop)) shop += ".myshopify.com";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop)) {
    throw new AppError("Use a valid myshopify.com store address.", 400);
  }
  return shop;
}

function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function validateCallback(originalUrl, secret, now = Date.now()) {
  const params = new URL(originalUrl, "https://callback.invalid").searchParams;
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length || entries.length > 12) {
    throw new AppError("Invalid Shopify callback. Start the connection again.", 400);
  }
  const query = Object.fromEntries(entries);
  const message = entries.filter(([key]) => key !== "hmac").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(query.hmac || "") || !equalSecret(digest, query.hmac)) {
    throw new AppError("Shopify callback verification failed. Start the connection again.", 403);
  }
  const timestamp = Number(query.timestamp);
  if (!/^\d+$/.test(query.timestamp || "") || !Number.isSafeInteger(timestamp) ||
      timestamp * 1000 < now - 10 * 60000 || timestamp * 1000 > now + 60000 ||
      !/^[a-f0-9]{64}$/.test(query.state || "") || typeof query.code !== "string" || !query.code || query.code.length > 2048) {
    throw new AppError("Shopify connection expired or is invalid. Start it again.", 403);
  }
  const shop = normalizeShop(query.shop);
  if (shop !== query.shop) throw new AppError("Invalid Shopify callback store.", 400);
  return { shop, code: query.code, state: query.state };
}

function sealTokens(tokens, merchantId, shop, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${merchantId}|${shop}`));
  const payload = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), payload.toString("base64")].join(".");
}

function openTokens(value, merchantId, shop, key) {
  try {
    const [version, iv, tag, payload, extra] = String(value).split(".");
    if (version !== "v1" || extra || !iv || !tag || !payload) throw new Error();
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    cipher.setAAD(Buffer.from(`${merchantId}|${shop}`));
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    const tokens = JSON.parse(Buffer.concat([cipher.update(Buffer.from(payload, "base64")), cipher.final()]).toString("utf8"));
    if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken ||
        typeof tokens.refreshToken !== "string" || !tokens.refreshToken ||
        !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= 0 ||
        tokens.refreshExpiresAt != null && (!Number.isFinite(tokens.refreshExpiresAt) || tokens.refreshExpiresAt <= 0)) throw new Error();
    return tokens;
  } catch { throw new AppError("Reconnect Shopify to renew the store connection.", 409); }
}

async function shopifyFetch(url, options, deadline = Date.now() + 20000) {
  const remaining = deadline - Date.now();
  if (remaining < 100) throw new AppError("Shopify sync reached its time limit. Retry the sync.", 503);
  try {
    return await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(Math.min(20000, remaining)) });
  } catch { throw new AppError("Shopify could not be reached. Retry shortly.", 503); }
}

function parseTokenResponse(data, scopes, now = Date.now()) {
  const granted = typeof data.scope === "string" ? data.scope.split(",").map(s => s.trim()) : [];
  if (typeof data.access_token !== "string" || !data.access_token ||
      scopes.some(s => !granted.includes(s) && !(s.startsWith("read_") && granted.includes(s.replace("read_", "write_"))))) {
    throw new AppError("Shopify did not grant the required access. Reconnect with the requested permissions.", 409);
  }
  const expires = Number(data.expires_in);
  const refreshExpires = Number(data.refresh_token_expires_in);
  if (!Number.isFinite(expires) || expires <= 0 || typeof data.refresh_token !== "string" || !data.refresh_token) {
    throw new AppError("Shopify did not return a renewable offline token. Reconnect the app.", 409);
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token,
    expiresAt: now + expires * 1000, refreshExpiresAt: Number.isFinite(refreshExpires) && refreshExpires > 0 ? now + refreshExpires * 1000 : null,
    scopes: granted };
}

async function exchangeToken(shop, fields, config, deadline) {
  const response = await shopifyFetch(`https://${normalizeShop(shop)}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields })
  }, deadline);
  if (!response.ok) throw new AppError(response.status === 429 || response.status >= 500 ?
    "Shopify is busy. Retry shortly." : "Shopify access could not be renewed. Reconnect the store.",
    response.status === 429 || response.status >= 500 ? 503 : 409);
  let data;
  try { data = await response.json(); } catch { throw new AppError("Shopify returned an invalid token response.", 502); }
  return parseTokenResponse(data, config.scopes);
}

function buildAuthorizeUrl(shop, state, config = requireShopifyConfig()) {
  const params = new URLSearchParams({ client_id: config.clientId, scope: config.scopes.join(","), redirect_uri: config.redirectUri, state });
  return `https://${normalizeShop(shop)}/admin/oauth/authorize?${params}`;
}

async function shopifyGraphQL(shop, accessToken, query, variables = {}, options = {}) {
  const config = options.config || requireShopifyConfig();
  const deadline = options.deadline || Date.now() + 20000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await shopifyFetch(`https://${normalizeShop(shop)}/admin/api/${config.version}/graphql.json`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables })
    }, deadline);
    let body;
    try { body = await response.json(); } catch { throw new AppError("Shopify returned an invalid response.", 502); }
    const throttled = response.status === 429 || body.errors?.some(e => e.extensions?.code === "THROTTLED");
    if ((throttled || response.status >= 500) && attempt < 2) {
      const retrySeconds = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.min(retrySeconds * 1000, 3000) : (attempt + 1) * 500;
      if (Date.now() + delay >= deadline) throw new AppError("Shopify is busy. Retry the sync shortly.", 503);
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    if (response.status === 401) throw new AppError("Shopify access has expired or been revoked. Reconnect the store.", 409);
    if (response.status === 403 || body.errors?.some(e => e.extensions?.code === "ACCESS_DENIED")) {
      throw new AppError("Shopify denied data access. Check app permissions and protected customer data access.", 403);
    }
    if (!response.ok || body.errors || !body.data) throw new AppError("Shopify could not complete the data request. Retry shortly.", 502);
    return body.data;
  }
}

async function fetchAllPages(shop, token, query, extractConnection, options = {}) {
  const nodes = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const data = await shopifyGraphQL(shop, token, query, { ...options.variables, cursor }, options);
    const connection = extractConnection(data);
    if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
      throw new AppError("Shopify returned incomplete pagination data. No complete sync was confirmed.", 502);
    }
    nodes.push(...connection.nodes);
    if (nodes.length > (options.maxNodes || 5000)) throw new AppError("This store exceeds the pilot sync limit. Contact support for a larger import.", 422);
    if (!connection.pageInfo.hasNextPage) return nodes;
    const next = connection.pageInfo.endCursor;
    if (!next || seen.has(next)) throw new AppError("Shopify pagination could not advance. Retry the sync.", 502);
    seen.add(next);
    cursor = next;
  }
  throw new AppError("This store exceeds the pilot sync page limit.", 422);
}

module.exports = { REQUIRED_SCOPES, TEMPORARY_MESSAGE, getShopifyConfig, requireShopifyConfig, normalizeShop,
  equalSecret, validateCallback, sealTokens, openTokens, buildAuthorizeUrl, exchangeToken,
  shopifyGraphQL, fetchAllPages, parseTokenResponse };
