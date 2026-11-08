# Merchant password recovery

## Scope and safeguards

- Merchant accounts only; no changes to CSV identities, Shopify data or customer
  accounts. The existing login/register response fields are preserved.
- Reset requests return the same `202` message before looking up the account.
  Unknown/ambiguous emails, cooldowns, capacity and delivery failures do not
  reveal whether an account exists. Invalid input gets a controlled `400`.
- Each link has a random 256-bit token. Only its SHA-256 hash, expiry and request
  time are saved, on the merchant record. Links expire after 15 minutes.
- Only one live link exists per account. Requests have a persisted 60-second
  cooldown and a five-per-IP/15-minute limit. Completion has a ten-per-IP limit;
  the existing authentication limiter also remains in force.
- Email links use the explicitly configured HTTPS application origin, never
  request headers. The token is in a URL fragment, removed by the reset page
  before API access. Pages set `no-referrer` and load no third-party scripts.
- Completion rechecks the hash/expiry and atomically changes the password,
  consumes the link and increments `sessionVersion`. Only one concurrent replay
  can succeed. Older JWTs stop authenticating; the user must sign in normally.
- Existing accounts and JWTs without a session version mean zero until that
  account completes recovery. No bulk migration, TTL index or new collection is
  needed. A TTL index on these fields would wrongly delete merchant accounts.
- Passwords retain the current eight-character minimum. Reset passwords are
  bounded to bcrypt's 72 UTF-8 bytes so longer values cannot silently truncate.
- The API never returns reset tokens, hashes, passwords, recipient addresses or
  provider errors. Logs use fixed event codes only. A password-change notice
  contains no password or reset token.

## Deployment is opt-in

Keep `PASSWORD_RESET_ENABLED=false` until the operator has verified the sending
domain, configured secrets and approved an actual inbox acceptance test.
Registering a domain alone does not activate email delivery or move the website.

Set these in Render's secret/environment settings, never in Git or chat:

| Setting | Value |
| --- | --- |
| `PASSWORD_RESET_ENABLED` | `true` only for the approved activation/test |
| `PASSWORD_RESET_APP_ORIGIN` | `https://derma-insight-saas.onrender.com` (or the explicitly approved application origin) |
| `PASSWORD_RESET_FROM` | A plain email address on the verified sending domain, e.g. `accounts@auth.dermainsight.co.uk` |
| `RESEND_API_KEY` | A sending-only key for that domain |

1. Add `auth.dermainsight.co.uk` as a sending domain in the operator's Resend
   account. Add the exact DNS verification records Resend provides in the
   domain's Spaceship DNS settings. Do not change nameservers, delete existing
   records or replace root-domain receiving mail records to guess a setup.
2. Wait for the provider's verified status. Disable open/click tracking on the
   recovery sending domain. Keep the API key private and limited to sending.
3. Set the environment values above and deploy the reviewed checkpoint. Public
   recovery status must report `available: true` before an email is requested.
4. With approval, use an account whose inbox the operator controls. Verify the
   real email arrives, has the expected sender and opens the actual application.
   Do not paste its reset link or any verification codes into issue reports.
5. Change the password, check the notice email, sign in with the new password,
   verify the old password and old sign-in session fail, and verify link replay
   fails. Do not reset a pilot merchant's password as a deployment test.

No actual Resend account, domain verification, secret configuration or live
email sending is performed by repository tests.

## Operations and limitations

Email work runs after the generic response in this persistent Node web service,
with at most 20 pending jobs and a ten-second provider timeout. It is **not a
durable email queue**. A process restart during delivery can lose an email; a
user can request another link after the cooldown. Provider acceptance also does
not prove inbox delivery. Operators must monitor the provider delivery dashboard
and fixed `PASSWORD_RECOVERY_*` warning codes. Never enable protocol/body logging
or add recipients, raw tokens or reset URLs to logs.

If a password-change acknowledgement is lost, sign in with the new password to
check the outcome; otherwise request a fresh link. Do not assume no write happened
after a network error. If the sender/key/origin is missing or recovery is disabled,
status reports unavailable and requests cannot change account state.

The isolated CI test uses a guarded loopback-only temporary MongoDB namespace and
intercepts all provider traffic. Real delivery, operator support arrangements,
pilot database indexes and backup restoration remain separate acceptance gates.

Security references: [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html),
[Resend email API](https://resend.com/docs/api-reference/emails/send-email).
