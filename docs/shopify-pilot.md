# Shopify connection and manual sync

This is a standalone, merchant-authorized integration. It reads customers,
products and recent orders; it never changes the Shopify store. The integration
stays disabled until deployment configuration is complete. Existing demo records
do not need merging: keep the current demo database and backup, and use a clean
pilot/test database for the new source identity constraints.

## Operator setup

1. Create a Shopify app in the Dev Dashboard and a development store for the
   first acceptance run. Configure it as non-embedded/standalone, using the
   authorization code grant. Select a suitable distribution method deliberately:
   custom distribution supports one production store or stores in one Plus
   organization, as well as development stores. Public distribution has separate
   review/privacy requirements; this release does not claim App Store readiness.
2. Request only `read_customers,read_products,read_orders`. Configure access to the
   protected customer fields actually used (name/email). Check the current
   Shopify access requirements for the chosen distribution method. Do not treat
   a successful install as proof that customer/order data is accessible.
3. Set the app URL to the deployed app and the allowed redirect URL exactly to
   `https://derma-insight-saas.onrender.com/api/shopify/callback`.
4. Configure the signed `app/uninstalled` subscription, using API version
   `2026-07`, to `https://derma-insight-saas.onrender.com/api/shopify/webhooks/app-uninstalled`.
   Deploy/release that app configuration in Shopify, then verify delivery with a
   development-store uninstall. Signed app configuration can alternatively be
   managed through Shopify CLI. Automatic order webhooks are not used: sync is
   initiated by the merchant in Settings.
5. Create an empty, isolated replica-set database with credentials restricted to
   that database. Example name: `derma_insight_shopify_test_20261018`. Store only
   its `MONGO_URI` in a private local env file, with file permissions `600`.
   The URI's database path must match the command's database argument.

```bash
npm run --silent db:init-pilot -- \
  --database derma_insight_shopify_test_20261018 \
  --env-file private-ops/shopify-test.env \
  --confirm-empty
```

The initializer rejects `dermaInsightDB`, any other unapproved database-name
prefix, standalone MongoDB, and every target containing any documents. It only
creates collections/indexes on that new empty target. It never updates/deletes
documents or drops collections. Run it before directing the app at the new
database or registering accounts there. If initialization fails partway, keep
the target empty and retry; it is not ready merely because collections exist.
Customer/Product automatic index creation is disabled to avoid attempting new
unique indexes on dirty demo data during deployment.

6. In the app's deployment environment set:

| Variable | Value |
| --- | --- |
| `MONGO_URI` | The privately configured clean test/pilot target |
| `SHOPIFY_API_KEY` | Shopify app client ID |
| `SHOPIFY_API_SECRET` | Shopify app client secret |
| `SHOPIFY_REDIRECT_URI` | Exact allowed callback URL above |
| `SHOPIFY_API_VERSION` | `2026-07` |
| `SHOPIFY_SCOPES` | `read_customers,read_products,read_orders` |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | Independent 32-byte random key encoded as base64 |
| `SHOPIFY_INCLUDE_TEST_ORDERS` | `true` for development-store acceptance; `false` before a real pilot |
| `SHOPIFY_ENABLED` | `true` after the other configuration and database setup |

Generate the encryption key **locally**, enter it directly into the deployment's
secret environment settings, and keep a secure recovery copy. Never paste it or
any credentials in chat, commits, screenshots or support logs. Changing this key
without re-encrypting existing tokens requires merchants to reconnect. Existing
plaintext Shopify tokens are not used and are removed on reconnect/disconnect.
Regular backups and recovery must also cover the separately held encryption key.

With missing/invalid configuration, connect/callback/sync return controlled
`503` responses. Authenticated status and local disconnect stay available.
Correct unique indexes and transaction support are checked before connection
or sync; constraints are not created automatically on an existing database.

## Merchant workflow

Sign up/log in, open **Settings → Shopify connection**, enter the store's
`myshopify.com` address, and choose **Connect Shopify**. Approve permissions on
Shopify. The callback returns to Settings; choose **Sync store data**. The result
shows profile/catalog counts and added/updated/unchanged/retired purchase lines.
Open Overview and select the window containing the test orders.

One Derma Insight account is pinned to one Shopify store, even after disconnect,
so historical data cannot silently mix between stores. Reconnect the same store
to renew access. Disconnect removes stored credentials and stops future sync;
imported records remain. Uninstall in Shopify to revoke the app's permissions
there. The signed uninstall notification clears local credentials too.

## Data contract and limits

- Only GBP shop currency is supported. Shop-currency amounts are used even if a
  customer paid in another presentment currency. No exchange rates are inferred.
- Each sync explicitly requests orders created in the last 60 days. It does not
  advertise complete all-time order coverage, even if more access is granted.
  Old imported data is a prior snapshot; changes outside the accessible window
  are not automatically refreshed. There is no automatic/scheduled sync.
- Up to 5,000 customers/products/orders, 1,000 lines per order and 10,000 lines in
  one snapshot are supported, within an 80-second processing budget. Pagination,
  repeated cursors, rate limits, timeouts and partial GraphQL errors are checked.
  A cap/error is never called a complete sync.
- A paid order line uses `priceAfterAllDiscountsBeforeTaxesSet.shopMoney` as its
  exact net merchandise total in pennies and `currentQuantity` for retained
  units. `Event.price` is that total divided by quantity, rather than the catalog
  or undiscounted unit price. Revenue sums `price × quantity` and rounds at the
  displayed total. General order-level cash adjustments without line changes,
  shipping, taxes, fees, costs and profit are outside this merchandise measure.
- Pending/authorized/partially paid and cancelled orders do not generate paid
  purchase Events. Full refunds and removed lines retire only confirmed derived
  lines in the same merchant/store/order. The current source order/line snapshot
  is retained in `shopifyorders`; it is not a full historical order audit log.
- An order update and its derived Event changes are one MongoDB transaction.
  Source line IDs and a unique merchant-scoped dedupe key keep replay stable.
  Retries do not delete/reinsert unchanged purchases. Earlier completed profile,
  catalog or order work can remain after a later failure; errors say so and keep
  confirmed counters. Unknown transaction outcomes are not called zero writes.
- Existing CSV customers/products can be matched by a unique normalized
  email/handle. Skin profiles are preserved. Ambiguous identities fail rather
  than choosing a profile. Shopify supplies no skin type/concern; new customers
  have unknown (`null`) values instead of invented classifications.
- Guest purchases and lines for deleted/custom products retain their revenue
  with explicit null references, without inventing customers/products. These
  lines are reported separately and cannot populate every customer/product
  insight. The integrity audit recognizes only source-tagged purchase records
  with valid Shopify metadata; cross-merchant non-null references still fail.
- Repeat-buyer and average purchase/order calculations count one Shopify order
  once across its lines. CSV purchase rows lack an order ID, so each remains a
  separate recorded purchase. Activity purchase counts still count Event lines.
- Order import does not create browsing/cart events. Viewer-to-buyer rates show
  **Not available** when no unique viewers are recorded. Storefront tracking and
  its privacy requirements are a separate capability.

## Acceptance before a real merchant connects

1. Invalid host, callback HMAC, expired state, missing browser cookie and replayed
   callback all fail before token exchange. Status/profile responses expose no
   access/refresh tokens, encryption material or OAuth state.
2. Connect a development store with an approved scope grant. Verify success
   redirect, token renewal, reconnect, local disconnect and signed uninstall.
3. Create a discounted test order with multiple lines. Sync twice. Reconcile net
   merchandise values, unchanged Event IDs/counts, order-based repeat buyers,
   and date-window results. Confirm test-order inclusion is visibly identified.
4. Test a partial line refund, removed line, cancellation, guest order and custom
   product line. Confirm only the intended order changes and verify totals.
5. Test pagination (including >100 lines), permissions denied, throttling,
   connection failure, concurrent sync and a retry after partial progress.
6. Regression-test all three CSV paths and cross-merchant access. Verify installed
   indexes on the clean target and rehearse backup restoration before pilot data.
7. Review the onboarding/support, data retention/export/deletion process and the
   chosen Shopify distribution requirements before handling real customer data.

`npm test` runs isolated HTTP, cryptographic, model and DOM workflow tests. With
`DI_TEST_MONGO_URI` set to a fresh loopback-only test database, it additionally
runs real MongoDB index/transaction and CSV/Shopify reconciliation acceptance.
CI starts a single-node MongoDB 8 replica set and runs this on Node 22 and 24.
These tests use simulated Shopify responses; an actual app/store install and
successful data-access grant are still required for external acceptance.

## Primary references

- [Standalone authorization and callback validation](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps)
- [Offline token expiry and renewal](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Line-item net amounts and retained quantity](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/LineItem)
- [Raw-body webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
- [Distribution choices](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)
- [Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)
