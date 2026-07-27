// services/shopifyService.js
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

function buildAuthorizeUrl(shop, state) {
  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_API_KEY,
    scope: process.env.SHOPIFY_SCOPES,
    redirect_uri: process.env.SHOPIFY_REDIRECT_URI,
    state,
  });
  return `https://${shop}.myshopify.com/admin/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(shop, code) {
  const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`Shopify token exchange failed: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function shopifyGraphQL(shop, accessToken, query, variables = {}) {
  const response = await fetch(
    `https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const body = await response.json();

  if (body.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
  }

  return body.data;
}

// Shopify pages every list response — this walks every page of a given
// query and hands back one flat array, regardless of how many customers,
// products, or orders the store actually has.
async function fetchAllPages(shop, accessToken, query, extractConnection) {
  let cursor = null;
  let hasNextPage = true;
  const allNodes = [];

  while (hasNextPage) {
    const data = await shopifyGraphQL(shop, accessToken, query, { cursor });
    const connection = extractConnection(data);
    allNodes.push(...connection.edges.map((edge) => edge.node));
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return allNodes;
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  shopifyGraphQL,
  fetchAllPages,
};