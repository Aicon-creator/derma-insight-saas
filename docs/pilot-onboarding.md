# First merchant: CSV onboarding

Use this guide for a supervised pilot on the prepared pilot database. The
database setup and recovery checks are separate release prerequisites; a
successful import alone does not verify them. Existing demo data stays separate.

## Merchant steps

1. Create an account using the merchant's business name, owner name and email.
   Set a password of at least eight characters. Sign out and sign in once to
   confirm access before importing data.
2. Open **Import CSV data** on the empty dashboard, or **CSV Imports** in the
   sidebar. Download the customer, product and event templates. They contain
   headings only, so there are no example people or sales to accidentally import.
3. Fill the customer template with real source records. Every listed field is
   required. Check the accepted skin types and concerns in the import-page help.
   Preview, fix any reported rows, then choose **Confirm Import**. The preview
   checks the full file and displays at most ten rows.
4. Repeat for products. Use the product's name and category and a numeric price
   without a currency symbol. Keep a source copy of each file.
5. Import events last. The customer emails and product names must resolve to
   records in this merchant account. Keep the original event timestamps and
   include their timezone. Use source event IDs when available and keep them
   stable across exports. Upload at most 1,000 data rows and 5 MB per file; split
   larger exports into batches while preserving the source identities.
6. Open **View dashboard**. Select 7, 30 or 90 days containing the actual activity.
   Check customer/product totals, event counts, revenue, recommendations and
   customer segments against the source export. Data older than the available
   windows remains stored but is outside those selected-period metrics.
7. Preview and import the same files again. Existing records should be skipped,
   with no increase in counts or revenue. Record the observed result.

## What the numbers mean

- Customer and product totals describe the imported records. Those files alone
  do not create purchases, views, revenue or repeat buyers.
- Purchase revenue is the price paid per unit (`amount`) multiplied by quantity.
  Use the actual discounted selling price, rather than the current catalog
  price. This is revenue, not profit; product costs and margins are not imported.
- Quantity defaults to one. The event template includes optional quantity,
  currency and session columns. Only GBP is supported. For view/add-to-cart
  events, amount must be blank or zero; do not invent browsing events.
- A customer needs at least two recorded CSV purchase events to qualify as a
  repeat buyer. CSV rows have no order grouping, so one row is one recorded
  purchase event. Skin-profile segments come from the supplied customer values.
- Viewer-to-buyer rate needs recorded view activity. Without it the rate is
  unavailable. A larger date range does not create activity that is absent from
  the source. Recommendations depend on the imported product/activity signals.

## If an import needs attention

- Fix the reported row/column in the source file and preview it again. Changing
  the selected file or type invalidates its preview. File/type controls are
  locked while an import is running.
- Duplicate identities inside a file block validation. Existing customer and
  product imports are skipped rather than overwritten. Use the result counts
  to distinguish imported and skipped records.
- A failed request can follow partial database writes. Follow the displayed
  message; do not assume zero writes after a network/server failure. Re-preview
  the source file and reconcile the imported/skipped/unconfirmed counts before
  continuing. Do not change source event IDs simply to force a retry.
- When reporting a problem, include the page, action, data type, displayed error,
  expected result, observed counts and selected date range. Remove customer
  names/emails and credentials from screenshots and never send raw exports or
  database backups through the feedback channel.

## Operator acceptance

The isolated CI acceptance test exercises real registration/login, an empty
account, all three downloads, preview and confirm, dependency validation,
re-import, date-filtered revenue, recommendations, segments and a second
merchant's isolation. It runs on a fresh loopback-only test database, never the
deployed database. Browser-state tests cover selection changes, double submits,
loading controls, validation errors, partial failures and retry eligibility.

Before a pilot starts, also verify the actual pilot target's indexes, backups
and restoration, record a support contact, and agree the merchant's data
handling/retention process. Use a short supervised session, record discrepancies
against the source export, and fix only confirmed blockers before widening use.

Shopify connection remains a separate acceptance gate. This CSV journey does
not verify a real Shopify installation, permission grant, token renewal or sync.
