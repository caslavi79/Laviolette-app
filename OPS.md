# Laviolette — Ops Runbook

Everything you need to deploy, schedule, and operate this app. For detailed
architecture + decisions log, see [../HANDOFF.md](../HANDOFF.md). For contract
generation, see [../contract-playbook.md](../contract-playbook.md). For per-script
docs, see [scripts/README.md](scripts/README.md).

---

## Repos

| Repo | What | Where |
|---|---|---|
| `caslavi79/Laviolette-app` | Source code | you edit here |
| `caslavi79/Laviolette-app-deploy` | Built `dist/` only | GitHub Pages serves this |
| `caslavi79/Laviolette` | Marketing site | separate repo, `laviolette.io` |

Custom domain `app.laviolette.io` → DNS already points at GitHub Pages → points
at the deploy repo. Deploy pipeline: `app/` source → `vite build` → `dist/` →
`gh-pages` → deploy repo → GitHub Pages → `app.laviolette.io`. Live in ~45s.

---

## Day-to-day commands

```bash
# 1. Dev server (leave running in a terminal)
cd Laviolette-app/app
npm run dev
# → http://localhost:5180

# 2. Ship a frontend change
cd Laviolette-app/app
npm run deploy     # builds + pushes dist/ to the deploy repo → live in ~45s

# 3. Generate a Stripe bank link (before May 1: do this for Dustin's 2 clients)
cd Laviolette-app
npm run stripe-setup -- cus_UKmJZNKc8Bn9aZ "VBTX Group LLC"
npm run stripe-setup -- cus_ULBcilbNsoq0Kp "Velvet Leaf Lounge LLC"
# Returns 24h-valid Stripe Checkout URL for bank link. Text/email to client.

# 4. Apply new DB migration (idempotent — tracks what's applied in public._claude_migrations)
cd Laviolette-app
npm run apply-migrations

# 5. Full DB schema sanity check (read-only + live trigger smoke test)
cd Laviolette-app
npm run db:verify

# 6. Deploy all 14 edge functions in one pass
cd Laviolette-app
bash scripts/deploy-edge.sh

# 7. Deploy ONE edge function (faster than the whole batch)
npx supabase@latest functions deploy <function-name> --no-verify-jwt

# 8. Smoke-test the 5 cron edge functions (all idempotent no-ops when nothing to do)
SECRET=$(grep ^REMINDERS_SECRET= Laviolette-app/.env.local | cut -d= -f2-)
BASE="https://sukcufgjptllzucbneuj.supabase.co/functions/v1"
for FN in generate-daily-rounds check-overdue-invoices advance-contract-status auto-push-invoices generate-retainer-invoices; do
  echo "=== $FN ==="
  curl -sS -X POST "$BASE/$FN?key=$SECRET" -H "Content-Type: application/json" -d '{}' | python3 -m json.tool
done

# 9. Health check (cron staleness + DLQ count + pending invoices; 503 if unhealthy)
curl -sS https://sukcufgjptllzucbneuj.supabase.co/functions/v1/health | python3 -m json.tool

# 10. List edge function secrets (digests only — values redacted)
cd Laviolette-app
npx supabase@latest secrets list --project-ref sukcufgjptllzucbneuj

# 11. Check DNS propagation for Resend (all 4 records should return values)
for NAME in resend._domainkey.laviolette.io send.laviolette.io _dmarc.laviolette.io; do
  echo "=== $NAME ==="
  dig TXT "$NAME" +short | head -3
  [ "$NAME" = "send.laviolette.io" ] && dig MX "$NAME" +short | head -1
done

# 12. Confirm cron jobs are still scheduled + active
cd Laviolette-app
node --env-file=.env.local --input-type=module -e "
import pg from 'pg'
const c = new pg.Client({host:'db.'+process.env.SUPABASE_PROJECT_REF+'.supabase.co',port:5432,user:'postgres',password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}})
await c.connect()
const r = await c.query(\"SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'laviolette_%' ORDER BY jobname\")
console.table(r.rows); await c.end()
"

# 13. See open failed notifications (dead-letter queue)
cd Laviolette-app
node --env-file=.env.local --input-type=module -e "
import pg from 'pg'
const c = new pg.Client({host:'db.'+process.env.SUPABASE_PROJECT_REF+'.supabase.co',port:5432,user:'postgres',password:process.env.SUPABASE_DB_PASSWORD,database:'postgres',ssl:{rejectUnauthorized:false}})
await c.connect()
const r = await c.query(\"SELECT id, kind, context, subject, to_email, error, created_at FROM notification_failures WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 20\")
console.table(r.rows); await c.end()
"
# Or just open /notifications in the app.

# 14. Trigger a Stripe webhook event for testing
source ~/.zshrc   # Loads STRIPE_API_KEY from env
stripe trigger payment_intent.canceled
stripe trigger checkout.session.expired
# Check Supabase Dashboard → Functions → stripe-webhook logs for the handler output.

# 15. Update webhook event subscription (14 events as of 2026-04-17)
source ~/.zshrc
stripe webhook_endpoints update we_1TMvVWRzgnRnD0DtDCBU6iTE \
  --enabled-events checkout.session.completed --enabled-events setup_intent.succeeded \
  --enabled-events setup_intent.setup_failed --enabled-events checkout.session.expired \
  --enabled-events invoice.paid --enabled-events invoice.payment_failed \
  --enabled-events payment_intent.succeeded --enabled-events payment_intent.payment_failed \
  --enabled-events payment_intent.processing --enabled-events payment_intent.canceled \
  --enabled-events charge.dispute.created --enabled-events charge.refunded \
  --enabled-events mandate.updated --enabled-events payment_method.detached
```

---

## Current state (as of 2026-04-17)

- ✅ **Database** — 17 tables, 100% COMMENT coverage, RLS on every table,
  20 migrations applied. Direct-pg connection on port 5432 (pooler 6543
  is broken — use direct). Migration 16 added `stripe_events_processed`
  (idempotency). Migration 18 added `notification_failures` (DLQ).
  Migration 19 added `public.get_last_cron_runs()` (SECURITY DEFINER
  function for the health endpoint).
- ✅ **Auth** — `case.laviolette@gmail.com` exists in Supabase Auth.
  Forgot-password uses Supabase's default email provider (SendGrid).
- ✅ **Frontend** — live at https://app.laviolette.io. **7 authenticated
  screens**: Today, Schedule, Contacts, Projects, Money, Contracts,
  **Notifications** (DLQ UI, added 2026-04-16). Plus 3 public routes:
  /sign (contract signing), /setup-success, /setup-cancel.
- ✅ **Stripe CLI** — `scripts/stripe-setup.js` + static redirect pages
  live at `laviolette.io/setup-success` and `laviolette.io/setup-cancel`.
  CLI installed globally via `brew install stripe/stripe-cli/stripe`;
  `STRIPE_API_KEY=sk_live_...` exported in `~/.zshrc`.
- ✅ **Edge functions** — **17 deployed** (14 original + `fire-day-reminder` 2026-04-17 +
  `run-pipeline-test` 2026-04-19 + `send-invoice` 2026-04-20):
  `stripe-webhook`, `auto-push-invoices`, `create-stripe-invoice`,
  `create-setup-session`, `contract-send`, `contract-sign`, `generate-retainer-invoices`,
  `generate-daily-rounds`, `check-overdue-invoices`, `advance-contract-status`,
  `send-reminders`, `retry-notification`, `send-manual-receipt`, `health`,
  `fire-day-reminder`, `run-pipeline-test`, `send-invoice`.
- ✅ **Stripe webhook** — live endpoint `we_1TMvVWRzgnRnD0DtDCBU6iTE`
  at `…/functions/v1/stripe-webhook`, subscribed to **14 events**.
  See "Stripe webhook" section below for the full list + behaviors.
- ✅ **Cron jobs** — **7 jobs** scheduled + active. DST-corrected on
  2026-04-17 (`1 5 UTC` → `1 6 UTC` for jobs that must fire past midnight
  CT in both seasons). Schedule is Central Time to match clients in
  Austin, TX.
- ✅ **Resend** — domain `laviolette.io` verified 2026-04-16. API key
  `RESEND_API_KEY` in `.env.local` + Supabase secret. All client emails
  BCC `case.laviolette@gmail.com`. Failures persist to
  `notification_failures` (visible in /notifications).
- ✅ **Contract flow** — typed cursive OR drawn signature, auto-countersigned
  provider side on generation, ESIGN/UETA consent language, client signature
  baked into `filled_html` on sign, 30-day token TTL, iframe-sandboxed
  rendering, "Download signed copy (PDF)" via browser print-to-PDF.
- ✅ **SPF state verified 2026-04-17** — earlier "delete _spfm duplicate"
  note was stale. Live DNS (via `dig TXT send.laviolette.io` +
  `dig TXT dc-fd741b8612._spfm.send.laviolette.io`) shows two valid SPF
  records on two DIFFERENT subdomains, which is legal. Do NOT delete
  either. Both contain `v=spf1 include:amazonses.com ~all`.
- 🟡 **Stripe customer emails still default-ON** — toggle OFF at
  [dashboard.stripe.com/settings/emails](https://dashboard.stripe.com/settings/emails):
  Successful payment, Refund, Failed payment, Subscription, Customer update.
  Leave ACH mandate ON (NACHA requires written authorization record).
  All client email touchpoints come from our Resend pipeline.

---

## Edge functions

All 14 are in `supabase/functions/`. Shared helpers in `_shared/`
(`client-emails.ts` — email templates + `sendClientEmail` helper + 11 internal
notification kinds; `business-days.ts` — federal holiday + NACHA business-day math).

### Stripe webhook (`stripe-webhook`)

Endpoint `we_1TMvVWRzgnRnD0DtDCBU6iTE`, signed with `STRIPE_WEBHOOK_SECRET`
(stored in `.env.local` + Supabase secret). Idempotency via
`stripe_events_processed` unique index on `event_id`.

| Event | Handler behavior |
|---|---|
| `payment_intent.succeeded` | Flip invoice to `paid` (preserves `partially_paid` audit trail). Send receipt email to client (BCC Case). Fire HQ alert ("✓ Paid"). |
| `payment_intent.payment_failed` | Flip invoice to `overdue` + append failure note. Send failure email to client. Fire HQ alert ("⚠ Failed"). |
| `payment_intent.processing` | Log only. ACH initiated, clearing. No DB change. |
| `payment_intent.canceled` | Reset invoice to `pending`, clear `stripe_payment_intent_id` (so it can be re-pushed). Fire HQ alert ("⊘ Canceled"). |
| `charge.dispute.created` | **No DB mutation.** Fire HQ alert ("🚨 DISPUTE") with evidence due-by date. Respond via Stripe Dashboard. |
| `charge.refunded` | Flip to `void` if fully refunded (idempotent — won't flip void→paid). Stay `paid` if partial. Append note. Fire HQ alert ("↩ Refunded"). |
| `checkout.session.completed` | Mark `bank_info_on_file=true` on client. Call `ensureDefaultPaymentMethod()` (sorts PMs by `created DESC`, sets most recent). Fire HQ alert ("✓ Bank linked") — or "⚠ PM missing" if PM setup failed. |
| `setup_intent.succeeded` | Same as above (double-safety if checkout.session.completed didn't include PM). |
| `setup_intent.setup_failed` | Log + fire HQ alert ("⚠ Setup failed") with Stripe error code/message. |
| `checkout.session.expired` | For setup-mode sessions: fire HQ alert ("⏱ Abandoned") so Case knows to re-send. |
| `mandate.updated` | If status=inactive/pending (client revoked ACH auth): flip `bank_info_on_file=false` on client + fire HQ alert ("⚠ Bank disconnected"). |
| `payment_method.detached` | If PM was bank: check remaining us_bank_account PMs on customer. If any, set default to newest. Otherwise flip `bank_info_on_file=false` + fire HQ alert. |
| `invoice.paid` (LEGACY) | Only for in-flight Stripe Invoices from pre-PI migration. Same mark-paid logic. |
| `invoice.payment_failed` (LEGACY) | Same. |

**Error recovery**: on handler throw, the idempotency row is deleted so Stripe's
retry re-processes. Email-send failures log + persist to `notification_failures`
but do NOT throw (would cause Stripe to retry and double-send receipts).

### Cron endpoints

All 5 cron-invoked endpoints require `?key=<REMINDERS_SECRET>` in the URL.
Constant-time comparison would be ideal but `!==` is used (low-risk given key rotation).

| Job name | Cron (UTC) | CST / CDT | Endpoint |
|---|---|---|---|
| `laviolette_generate_daily_rounds` | `1 6 * * *` | 00:01 / 01:01 | POST `/generate-daily-rounds?key=` |
| `laviolette_fire_day_reminder` | `0 14 * * 1-5` | 08:00 / 09:00 Mon-Fri | POST `/fire-day-reminder?key=` |
| `laviolette_send_reminders_am` | `15 14 * * *` | 08:15 / 09:15 | POST `/send-reminders?key=` |
| `laviolette_check_overdue` | `0 11 * * *` | 05:00 / 06:00 | POST `/check-overdue-invoices?key=` |
| `laviolette_advance_contracts` | `5 11 * * *` | 05:05 / 06:05 | POST `/advance-contract-status?key=` |
| `laviolette_auto_push_invoices` | `5 21 * * *` | 15:05 / 16:05 | POST `/auto-push-invoices?key=` |
| `laviolette_auto_push_invoices_retry` | `5 22 * * *` | 16:05 / 17:05 | POST `/auto-push-invoices?key=` |
| `laviolette_retainer_invoices` | `1 6 1 * *` | 00:01 / 01:01 on 1st | POST `/generate-retainer-invoices?key=` |

`1 6 UTC` vs `1 5 UTC`: the former fires past midnight CT in BOTH CST winter
(00:01 local) and CDT summer (01:01 local). The prior `1 5 UTC` fired at 23:01
CST the *previous day*, producing off-by-one-day daily_rounds + wrong-month
retainer invoices. Fixed 2026-04-17.

### Send-invoice (`send-invoice`) — auto-fired on contract sign

Added 2026-04-20. Sends the client a branded invoice email (cream/copper, single-table
layout) the moment a contract is signed, before any ACH charge fires. Fills the gap in
the original architecture where clients only got an "invoice" email AT charge time —
which left them paying without an invoice document on file.

**Triggered by:**
- `contract-sign` after a successful sign — looks up pending invoices on the contract's
  `project_id` where `sent_date IS NULL`, fires `send-invoice` for each (fire-and-forget,
  failures logged to function logs, the auto-send doesn't block the sign response).
- Manually via `?key=$REMINDERS_SECRET` POST with `{ invoice_id }` — useful for resending
  or sending invoices not tied to a contract.

**Behavior:**
- Fetches invoice + client + brand + project from DB.
- Idempotency: skips silently if `invoices.sent_date` is already set.
- Skips silently if `clients.billing_email` is null (logs warning).
- Builds branded HTML email — single `<table>` layout with metadata + items + total +
  closing all inside one element (Gmail-trim-defense, see "Email rendering lessons" below).
- Sends via Resend to `clients.billing_email` + BCC `CASE_NOTIFY_EMAIL`.
- Stamps `invoices.sent_date = today` atomically (only-if-still-null predicate so
  concurrent calls don't double-send).
- On Resend failure: persists to `notification_failures` (visible at /notifications,
  retryable via `retry-notification`).

**Why it matters for the immediate-pay buildout flow** (Variant C in the contract
playbook): clients pay $X upfront on signing day. They sign the contract → bam, invoice
in their inbox immediately → bookkeeper has receipts before the ACH even fires. Closes
the "I didn't know I was being charged" gap that came up before this function existed.

### Architecture: contract-sign → send-invoice auto-flow

The contract-sign edge function was modified 2026-04-20 to auto-fire send-invoice after
a successful client signature. The full sequence:

```
1. Client clicks "I agree and sign" at /sign?token=...
2. contract-sign edge function:
   a. Atomic UPDATE contracts SET status='signed', signature_data=..., signed_at=now
   b. Sends 2 confirmation emails (signer + Case HQ) — fire-and-forget
   c. NEW: Queries invoices WHERE project_id = contract.project_id
      AND status='pending' AND sent_date IS NULL
   d. For each match: fire-and-forget POST to send-invoice?key=<secret>
      with { invoice_id } body
   e. Returns { success: true } to /sign page (client sees "Signed" UI immediately)
3. send-invoice (asynchronously, ~1-3 seconds later):
   - Builds + sends invoice email to client billing_email
   - Stamps sent_date
4. (Manually OR via auto-push) Charge fires against linked PM
5. Webhook → invoice paid + receipt + HQ alert
```

**Critical invariant:** the invoice row must EXIST in the DB before the contract is
sent for signing. If you create the contract but forget the invoice, the auto-fire
fires nothing (no-op, no error). Always create both as a unit per the contract playbook
"Onboarding Workflow" section.

### Email rendering lessons (Gmail trim + invoice format)

Two hard-won lessons from the Nicole James onboarding (2026-04-20):

**1. Gmail's "show trimmed content" auto-collapse** — Gmail decides which parts of an
email are "main" vs. "trimmed" based on heuristics that look for signature-like patterns:
- A separate `<table>` followed by closing `<p>` paragraphs reads as "data + signature"
  → Gmail collapses everything between the data and the signature.
- A wrapping `<div>` with a colored background (e.g. cream) reads as a "signature card"
  → similar collapse.
- `border-top: 1px solid` on the footer reads as a signature divider line → collapse.

**The fix:** put EVERYTHING (header, intro, metadata, items, total, closing copy,
signature) inside a single `<table>` with row colors for visual sectioning. No wrapping
`<div>` background, no separate `<p>` elements at the end, no border-top dividers.
Result: Gmail can't fragment because there's no second element to fragment around.

The `send-invoice` template implements this. Same defense pattern should apply to any
future client-facing email (receipts, charge confirmations, etc.) if Gmail starts
trimming them too.

**2. Invoice line items: SINGLE entry for fixed-fee buildouts.**
A fixed-fee engagement (e.g. $1,700 for an 8-deliverable website) should NOT be
itemized as 8 line items at $212.50 each. That:
- Invents per-deliverable pricing that wasn't in the contract or the deck
- Creates the impression of à-la-carte pricing when it's a fixed package
- Looks weirdly precise / suspicious

Always: ONE line item like `"Website Buildout — 8 deliverables, fixed fee, paid in full
at signing"` totaling $1,700. The deliverable detail lives in the contract's §8
Deliverable Schedule, not the invoice line items.

### Secrets (Supabase Dashboard → Functions → Secrets)

16 secrets total. Set via `npx supabase@latest secrets set NAME=value`:

| Secret | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe LIVE mode API key (`sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook signatures (`whsec_...`). Must match Stripe dashboard. |
| `RESEND_API_KEY` | Resend sending key (`re_...`) — restricted to Sending access |
| `REMINDERS_SECRET` | `?key=` auth for cron endpoints |
| `CASE_NOTIFY_EMAIL` | HQ alert destination (`case.laviolette@gmail.com`) |
| `APP_URL` | `https://app.laviolette.io` — embedded in email links |
| `SIGNING_BASE_URL` | `https://app.laviolette.io/sign` — contract signing URL base |
| `STRIPE_SUCCESS_URL` | Stripe Checkout redirect after bank setup success |
| `STRIPE_CANCEL_URL` | Stripe Checkout redirect after bank setup cancel |
| `BRAND_NAME` | `Laviolette LLC` — email sender name |
| `BRAND_FROM_EMAIL` | `noreply@laviolette.io` |
| `BRAND_REPLY_TO` | `case.laviolette@gmail.com` |
| `BRAND_COLOR` | `#B8845A` (copper) |
| `BRAND_BG` | `#12100D` (ink) |
| `BRAND_INK` | `#F4F0E8` (cream) |
| `BRAND_LOGO_URL` | Logo URL for email HTML (currently empty string) |

Plus auto-provided by Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`. These are always present in edge function env.

---

## Architecture: Fire-day reminder (human-in-the-loop + auto-push safety net)

Added 2026-04-17. Design pattern: **human-in-the-loop with automated fallback**.

### Flow through a typical fire day

1. **09:00 AM CT** (`0 14 UTC`, Mon-Fri): `fire-day-reminder` cron runs.
   - Queries `invoices` for draft/pending rows with no `stripe_payment_intent_id`
     / `stripe_invoice_id` where `computeFireDate(due_date) == today`.
   - Splits into two buckets:
     - **Eligible**: client has Stripe customer + bank_info_on_file → can charge now
     - **Blocked**: client missing one of those → needs Case action before 4:05 PM
   - If nothing in either bucket: returns 200 silently (no email).
   - If something: emails Case at `CASE_NOTIFY_EMAIL` with two tables. Each
     eligible row has a "Fire now" button deep-linking to
     `/money?tab=invoices&highlight=<id>`. The Money page scroll-and-flashes
     the row on page load.
2. **Case, any time between 9 AM and 4:05 PM**: clicks "Fire now" link (or
   manually opens Money tab). "Charge via ACH" button on the highlighted
   invoice atomically claims it + creates PaymentIntent. From this moment,
   `stripe_payment_intent_id` is set.
3. **4:05 PM CT** (`5 21 UTC`): `auto-push-invoices` runs. Its claim predicate
   requires `stripe_payment_intent_id IS NULL` — any invoice Case already
   fired gets skipped. Any invoice he didn't get to gets fired now as the
   safety net.
4. **5:05 PM CT** (`5 22 UTC`): retry pass. Same logic. Catches anything
   that errored on the 4:05 fire.
5. **Next 1-5 business days**: ACH settles → `payment_intent.succeeded`
   webhook → invoice flips to `paid` + receipt email to client (BCC Case) +
   HQ "✓ Paid" alert. Identical for manual-fired and auto-fired invoices.

### Key properties

- **No duplicate charges**: atomic claim pattern (Postgres row-level lock on
  `stripe_payment_intent_id IS NULL`) means manual + cron racing can't both
  create a PI for the same invoice.
- **Quiet days are silent**: reminder only emails when there's something
  actionable — no spam on days with no fires.
- **Blocked items surface early**: if Dustin hasn't linked a bank yet and
  today is the fire date, Case sees this at 9 AM, not at 4:05 PM when
  auto-push silently skips.
- **Weekends skipped**: cron restricted to Mon-Fri (`1-5` weekday field).
  ACH doesn't settle on weekends so fire dates never fall there; skipping
  avoids a useless email.
- **Operator peace of mind**: Case can choose hands-off (auto takes over)
  or hands-on (fire manually for each invoice) on any given cycle. Same
  code paths for both.

## Architecture: PaymentIntent flow (not Stripe Invoices)

As of 2026-04-16, the charge flow uses raw `stripe.paymentIntents.create()`,
NOT the Stripe Invoices API. **Reason**: Stripe Billing adds a 0.5% per-invoice
fee on top of the 0.8% ACH fee when `stripe.invoices.*` is used. On a $1,200
retainer, that's $6/month, $216/year across 3 retainers. Saved by the PI-only
flow (ACH fee only, capped at $5).

**The flow:**

1. **`generate-retainer-invoices`** — monthly cron on the 1st at 00:01 CT.
   Creates drafts for the UPCOMING month (due_date = 1st of next month), so
   auto-push has a live invoice to charge on the business day before.
   Idempotent on `(project_id, period_month)`.
2. **`auto-push-invoices`** — daily cron at 4:05 PM CT + retry at 5:05 PM CT.
   For each draft with `bank_info_on_file=true` and
   `computeFireDate(due_date) <= today`, runs the atomic-claim pattern:
   - Conditional UPDATE writes `stripe_payment_intent_id = 'CLAIMING:<uuid>'`
     only if field was NULL. If 0 rows: another process won the race; skip.
   - Creates off-session PaymentIntent, confirms immediately.
   - Replaces claim marker with real PI ID (with recovery logic for the rare
     webhook-wrote-first race).
   - Sends invoice-charging email to `clients.billing_email` (BCC Case).
3. **`stripe-webhook` on `payment_intent.succeeded`** — flips invoice to `paid`,
   sends paid-receipt to client (BCC Case), fires HQ alert to Case.

**Fail-safe design:**
- Email failures log + persist to DLQ but do NOT throw (prevents Stripe retry
  from double-sending receipts on an already-committed DB update).
- Partial-payment race: `payment_intent.succeeded` preserves `paid_amount` as
  an audit trail if Case manually marked partially_paid before the webhook.
- Blocked invoices (eligible-but-no-bank): `auto_push_blocked` HQ alert fires
  so Case knows before he wakes up expecting 4 charges and only sees 2.

---

## Resend (live)

Account: `case.laviolette@gmail.com` · Domain: `laviolette.io` verified in
us-east-1 (DKIM `resend._domainkey`, SPF TXT `send`, MX `send` priority 10,
DMARC `_dmarc` all live at GoDaddy).

**Email types going out:**

| Kind | Trigger | To | BCC |
|---|---|---|---|
| Invoice document (on contract sign) | send-invoice (auto-fired by contract-sign) | `clients.billing_email` | case.laviolette |
| Invoice-charging | auto-push-invoices on fire | `clients.billing_email` | case.laviolette |
| Invoice-charging (manual) | create-stripe-invoice (Money "Charge via ACH" button) | `clients.billing_email` | case.laviolette |
| Paid receipt | payment_intent.succeeded webhook | `clients.billing_email` | case.laviolette |
| Payment failed | payment_intent.payment_failed webhook | `clients.billing_email` | case.laviolette |
| Manual receipt | send-manual-receipt (MarkPaidModal wire/check) | `clients.billing_email` | case.laviolette |
| Contract for review | contract-send | `contract.signer_email` | case.laviolette |
| Contract signed confirmation (signer) | contract-sign | signer_email | case.laviolette |
| Contract signed confirmation (Case HQ) | contract-sign | CASE_NOTIFY_EMAIL | — |
| Fire-day reminder | fire-day-reminder cron (9 AM CT weekdays) | CASE_NOTIFY_EMAIL | — |
| Daily digest | send-reminders cron (9:15 AM CT daily) | CASE_NOTIFY_EMAIL | — |
| HQ alerts (internal) | notifyCase in webhook + functions | CASE_NOTIFY_EMAIL | — |

**HQ alert types (`buildInternalNotification` kinds) — 13 total:**

| Kind | Fired by | When |
|---|---|---|
| `payment_succeeded` | stripe-webhook + send-manual-receipt | PI settled or manual full mark-paid |
| `payment_failed` | stripe-webhook | payment_intent.payment_failed |
| `bank_linked` | stripe-webhook | checkout.session.completed setup-mode (default PM set successfully) |
| `setup_failed` | stripe-webhook | setup_intent.setup_failed |
| `dispute_created` | stripe-webhook | charge.dispute.created (🚨 with evidence due-by) |
| `refunded` | stripe-webhook | charge.refunded |
| `payment_canceled` | stripe-webhook | payment_intent.canceled |
| `checkout_abandoned` | stripe-webhook | checkout.session.expired setup-mode |
| `default_pm_missing` | stripe-webhook (ensureDefaultPaymentMethod) | Customer has no usable us_bank_account PM |
| `auto_push_blocked` | auto-push-invoices | Invoices eligible to fire but blocked (no bank) |
| `auto_push_errors` | auto-push-invoices | Any error in the fire loop |
| `bank_disconnected` | stripe-webhook | mandate.updated inactive OR payment_method.detached |
| `fire_day_reminder` | fire-day-reminder cron | Mon-Fri 9 AM CT with today's fires + blocked |

**If Resend key rotates:**
```bash
npx supabase@latest secrets set RESEND_API_KEY=re_xxx --project-ref sukcufgjptllzucbneuj
# Also update .env.local
```

---

## Env files

| File | Committed? | Purpose |
|---|---|---|
| `.env.example` | ✅ | Placeholders — template for scripts/ |
| `.env.local` | ❌ | Real secrets for scripts/ + local testing — gitignored |
| `app/.env.example` | ✅ | Frontend template |
| `app/.env` | ❌ | Real Supabase URL + anon key for Vite dev — gitignored |

The anon key is safe to embed in the client bundle (RLS protects the DB).
Everything else stays out of the repo. `HANDOFF.md` (workspace-root level)
also contains secrets and is gitignored both at workspace root AND defensively
in `Laviolette-app/.gitignore`.

---

## Troubleshooting

### Payment / webhook

**"Send Bank Connection Link" button returns an error**
→ `create-setup-session` IS deployed. Check Supabase function logs for the actual
error. Common causes: (a) `stripe_customer_id` invalid or deleted, (b)
`STRIPE_SECRET_KEY` rotated without updating the Supabase secret.
UI fallback: run `npm run stripe-setup -- cus_xxx "Client Name"` locally.

**Stripe webhook isn't marking invoices paid**
→ Check Stripe Dashboard → Developers → Webhooks → the endpoint → Events tab.
If 400 responses: `STRIPE_WEBHOOK_SECRET` mismatch between Stripe Dashboard
and Supabase secrets. Re-copy from dashboard and re-set.
If 500 responses: check Supabase function logs for the exception.

**Invoice stuck on `CLAIMING:<uuid>` in `stripe_payment_intent_id`**
→ Edge function crashed between Stripe call and DB update. Check Stripe for a
PI with `metadata.laviolette_invoice_id` matching the invoice ID. If PI exists
and status is processing/succeeded, manually set the DB to match:
```sql
UPDATE invoices SET stripe_payment_intent_id = 'pi_...', status = 'pending'
WHERE id = '...' AND stripe_payment_intent_id LIKE 'CLAIMING:%';
```
If no PI exists, clear the claim:
```sql
UPDATE invoices SET stripe_payment_intent_id = NULL
WHERE id = '...' AND stripe_payment_intent_id LIKE 'CLAIMING:%';
```

**Auto-push didn't fire when expected**
→ (1) Check cron is active: see command #12.
   (2) Check the invoice has `status IN ('draft','pending') AND stripe_payment_intent_id IS NULL AND stripe_invoice_id IS NULL`.
   (3) Check the client has `bank_info_on_file=true` AND `stripe_customer_id IS NOT NULL`.
   (4) If all above match, the blocked check should have fired an HQ alert.
   Check /notifications.

### Contracts

**"Send for signing" returns an error**
→ `contract-send` IS deployed and Resend is live. Check `notification_failures`
table for the actual error message (see command #13). Most common: invalid/missing
`signer_email` on the contract, or Resend rate-limit.

**Signing link returns "This signing link has expired"**
→ Tokens expire 30 days after `contracts.sent_at`. Re-send from the Contracts
page to generate a fresh link. The token in the email is the same as the one
in `contracts.sign_token` — the 30d TTL is enforced server-side.

**Signed contract doesn't show both signatures**
→ `contract-sign` is supposed to inject the client signature image into
`filled_html` at sign time. If it didn't (pre-2026-04-17 contracts), the
signature is still in `signature_data` column but not rendered in the HTML.
Contracts signed post-2026-04-17 render both sigs. For older contracts, ask
Claude Code to re-inject.

### Cron / scheduling

**Daily rounds don't auto-populate**
→ `laviolette_generate_daily_rounds` cron runs at 00:01 CT daily.
Verify active via command #12. If missing: re-apply `supabase/sql/cron-schedule.sql`.
Today screen has a client-side fallback that infers platforms from retainer
services if no `daily_rounds` rows exist — so the UI still works but the
schedule drift is a separate problem.

**No reminder emails arriving**
→ (a) Check `laviolette_send_reminders_am` is active.
   (b) Hit `/send-reminders?key=$REMINDERS_SECRET` manually — it returns
   `{ok:true, sent:false, count:0}` if nothing to report.
   (c) Check /notifications for any queued DLQ entries.

**Cron flagged stale in health endpoint**
→ `/health` marks a job stale if `last_run + MAX_GAP_HOURS` has passed. Common
causes: pg_cron extension disabled/reset, pg_net extension issue, Supabase
platform outage. Check `SELECT * FROM cron.job` and `SELECT * FROM cron.job_run_details
ORDER BY end_time DESC LIMIT 10`.

### Migrations

**Need to re-run migrations**
→ `npm run apply-migrations` is idempotent. Already-applied files are skipped
via `public._claude_migrations` tracking table. Modified files are blocked
(checksum mismatch) — create a NEW migration for incremental changes.

**Migration applies but fails on RLS policy conflict**
→ If re-applying an `ALTER POLICY` that already exists, the runner's transaction
rolls back. Create a new migration file with the idempotent form (`DROP POLICY
IF EXISTS ... ; CREATE POLICY ...`).

### Dead-letter queue

**"ALERTS · N" badge in sidebar**
→ Open `/notifications`. Each row shows the failure with Retry + Dismiss buttons.
Retry replays via `retry-notification` edge function using the stored payload.
Dismiss marks resolved without re-sending.

**Retry fails too**
→ The row's `error` column is updated to the new error. Check Resend's
dashboard or verify the `to_email` address is valid. If Resend is down, waiting
is the only option — the row stays in the queue.

### Fire-day reminder / deep-linking

**"No fires today — silent" response from fire-day-reminder**
→ Expected when no invoice has `computeFireDate(due_date) == today`. The cron
still ran (visible in `cron.job_run_details` and `/health`). Quiet-day
behavior: no email sent to Case, no spam on months with nothing due.

**Reminder email arrived but "Fire now" button goes to wrong invoice**
→ The URL contains `?highlight=<uuid>` which points to the invoice by ID. If
the highlighted row doesn't scroll into view, check browser console for JS
errors + verify the Money page loaded fully. 3s flash animation should pulse
copper when the row is located.

**Reminder email arrived but invoices are listed as Blocked**
→ Client is missing either `stripe_customer_id` or `bank_info_on_file=true`.
Send bank-link via `npm run stripe-setup -- <customer_id> "<name>"` or add
customer in Stripe Dashboard first. Auto-push at 4:05 PM will ALSO skip
these; they need resolution before the cutoff.

**"Bank-link abandoned" HQ alert for a client who already has bank on file**
→ That's a ghost alert from a previously-generated bank-link session that
went unused and hit its 24h expiration. Not a real abandonment. Check
`SELECT bank_info_on_file FROM clients WHERE stripe_customer_id = ...` to
confirm current state. Future improvement: filter out expired sessions whose
customer already has bank_info_on_file=true.

### Auth / frontend

**Forgot password**
→ Supabase Dashboard → Authentication → Users → Reset Password. Email goes
via Supabase's default provider (not Resend).

**Frontend doesn't reflect a DB change**
→ The app queries Supabase on mount via useEffect. Hit `F5` to refetch.
For cross-user real-time, Supabase Realtime is unwired (intentionally —
single-user app).

---

## Phase 2 (intentionally deferred)

- Stripe subscriptions for retainers (currently: monthly generator cron)
- Receipt OCR on expense upload
- Content calendar integration (Buffer/Later/Meta Business)
- PWA install on iPhone home screen (add service worker)
- Supabase Realtime for live-updating Today screen
- Client-facing invoice portal (view invoices, self-serve bank update)
- Lead pipeline UI (`lead_details` table exists but no screen — deferred pending Case's need)
- Server-side PDF rendering for signed contracts (currently browser print-to-PDF works fine)
- Tax export CSV (Money page mentions it but no UI — defer until first year-end)

---

## Last known good state

| Metric | Value |
|---|---|
| Migrations applied | 20 |
| Edge functions deployed | 17 (added `run-pipeline-test` 2026-04-19, `send-invoice` + modified `contract-sign` 2026-04-20) |
| Webhook events subscribed | 14 |
| Cron jobs active | 8 (added `laviolette_fire_day_reminder`) |
| Unresolved `notification_failures` | 0 |
| Pending invoices | 5 (4 Dustin May 1 + Nicole James LV-2026-005 due 2026-04-21) |
| Stripe customers | 3 active real (VBTX `cus_UKmJZNKc8Bn9aZ`, Velvet Leaf `cus_ULBcilbNsoq0Kp`, Nicole James `cus_UNBgjM5C9n7gkX`) |
| DB clients | 5 real (VBTX, Velvet Leaf, Exodus 1414 draft, Nicole James lead, Viktoriia Jones lead) |
| Contracts | 4 signed (Dustin) + 1 draft (Exodus) + 1 sent (Nicole, awaiting sign 2026-04-21) |
| In-flight $1 test debits on Ally ****4271 | 3, metadata cleared, settle ~Apr 20-22, refundable via Stripe Dashboard |
| Last frontend deploy | 2026-04-20 (Contracts page: Download (Print to PDF) button on draft contracts) |
| Last edge-function deploy | 2026-04-20 (`send-invoice` + modified `contract-sign` for auto-fire on sign) |
| Last DB cleanup | 2026-04-17 (all test records removed in one transaction) |
