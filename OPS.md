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

# 6. Deploy all 19 production edge functions in one pass (excludes run-pipeline-test)
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

## Current state (as of 2026-04-22)

- ✅ **Database** — **34 migrations applied** (full list + tracking in
  `public._claude_migrations`). 2026-04-22 adds:
  `20260423000001_work_log_sessions` (session_id + started_at +
  ended_at on `work_log` — backing Log Work v2 session-grouped UI),
  `20260424000001_schedule_flexible_times` (replaces rigid
  `time_block` enum with `start_time` + `end_time` on both schedule
  tables, adds `kind` enum {focus|event|blackout} on overrides,
  adds `updated_at` trigger to overrides). RLS on every table.
  Direct-pg connection on port 5432 (pooler 6543 broken — use direct).
- ✅ **Log Work v2.1** — minimalist modal: brand + session window
  + notes (primary, required) + optional link. One row per save
  with `service_id=NULL`; `title` auto-derives from the first line
  of notes (satisfies the NOT NULL CHECK without a separate field).
  The multi-select task checkboxes from initial v2 were stripped
  per Case's feedback ("the selections make me have to read and
  consider which category vs just selecting the company and
  writing quickly what i did for the last 4 hours"). ActivityTab
  is flat chronological — no service filter pills, no per-service
  grouping, single-line sessions don't expand (nothing to reveal).
  Session_id column still populated so future retroactive tagging
  stays possible without a migration. Shipped across commits
  `232f1db` (v2) → `ce43ef8` (v2.1 form strip) → `2e79e80`
  (ActivityTab flat).
- ✅ **Schedule v2 (agenda)** — `/schedule` replaced the rigid
  7×3 grid (AM/PM/all-day cells per brand) with a vertical timeline
  agenda. Flexible time ranges, overlay semantics for exceptions.
  `kind` taxonomy: `focus` (deep-work block for a brand),
  `event` (one-off meeting), `blackout` (day off; hides
  overlapping template blocks). Clarified UI copy: "override day"
  → "exception" / specific kind. Full rewrite of Schedule.jsx +
  EditScheduleBlockModal.jsx. Mobile: stacked-day accordion.
  Shipped 2026-04-22 commit `30e6117`.
- 🔴 **Auto-charge FLAGGED OFF** as of 2026-04-21 (commit `64dd603`).
  `ENABLE_AUTO_CHARGE=false` on Supabase secrets. Both
  `laviolette_auto_push_invoices` + `_retry` cron jobs deactivated via
  `cron.alter_job(jobid, active := false)` — they stay defined but
  don't fire. Charges happen ONLY when Case clicks "Charge via ACH"
  on an invoice row in the Money tab. Re-enable: `npx supabase secrets
  set ENABLE_AUTO_CHARGE=true …` AND `SELECT cron.alter_job(jobid,
  active := true) FROM cron.job WHERE jobname LIKE '%auto_push%'`.
- ✅ **Project lifecycle** — `project_status` enum now has a first-class
  `scheduled` value between `draft` and `active` (added 2026-04-22,
  migration `20260422000003`). Signed-but-not-yet-started engagements
  (start_date in the future) live here. State machine:
  `draft → scheduled (sign + start_date > today) | active (sign + start_date <= today) → active (via cron on start_date) → paused|complete|cancelled`.
  Advance handled daily by `advance-contract-status` at 05:05 CT.
- ✅ **Auth** — `case.laviolette@gmail.com` exists in Supabase Auth.
  Forgot-password uses Supabase's default email provider (SendGrid).
- ✅ **Frontend** — live at https://app.laviolette.io. **8
  authenticated screens**: Today, Schedule, Contacts, Projects, Money,
  Contracts, Notifications, **Incidents** (health history table,
  added 2026-04-21). Plus 3 public routes: /sign, /setup-success,
  /setup-cancel.
- ✅ **Stripe CLI** — `scripts/stripe-setup.js` + static redirect pages
  live at `laviolette.io/setup-success` and `laviolette.io/setup-cancel`.
  CLI installed globally via `brew install stripe/stripe-cli/stripe`;
  `STRIPE_API_KEY=sk_live_...` exported in `~/.zshrc`.
- ✅ **Edge functions** — **20 directories total** in
  `supabase/functions/`: 19 production (deployed via
  `scripts/deploy-edge.sh`) + `run-pipeline-test` (manual ops tool,
  intentionally excluded). Unified onboarding flag
  `ENABLE_UNIFIED_ONBOARDING` is **ON** on Supabase secrets (flipped
  from `false` 2026-04-21 after OFF→ON→Regenerate end-to-end test on
  a disposable buildout contract). 10-agent audit closed with 20 fixes
  shipped across 3 rounds (2026-04-21).
- ✅ **Stripe webhook** — live endpoint `we_1TMvVWRzgnRnD0DtDCBU6iTE`
  at `…/functions/v1/stripe-webhook`, subscribed to **14 events**.
  See "Stripe webhook" section below for the full list + behaviors.
- 🟡 **Cron jobs** — **9 jobs defined, 7 active** after the
  2026-04-21 auto-charge kill-switch deactivated
  `laviolette_auto_push_invoices` + `_retry`. `/health` filters
  `active=false` jobs from the stale-cron list (migration
  `20260422000005`) so those two don't false-flag staleness.
  Re-activate with `cron.alter_job(jobid, active := true)` if
  flipping `ENABLE_AUTO_CHARGE=true`. Schedule is Central Time to
  match clients in Austin, TX.
- ✅ **External monitoring (UptimeRobot)** — LIVE since 2026-04-21,
  free tier, 5-minute interval. Pings
  `https://sukcufgjptllzucbneuj.supabase.co/functions/v1/health`.
  Alerts to `case.laviolette@gmail.com` (verified end-to-end with a
  test alert). Public status page:
  <https://stats.uptimerobot.com/muAd17CfnU>. Setup guide:
  `docs/MONITORING_SETUP.md`. Runbook: `INCIDENTS.md`.
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
- ✅ **Lead tracking unified on `lead_details`** (2026-04-21
  cleanup, migration `20260421000001`). The five thin columns that
  were added to `contacts` in 2026-04-20 (`stage`, `lead_source`,
  `last_contacted_at`, `next_touch_at`, `lead_notes`) were
  backfilled into `lead_details` and dropped. `v_stale_leads` now
  reads from `lead_details.last_contact_date` /
  `lead_details.next_follow_up` / `lead_details.stage`. Contacts +
  EditContactModal + Today stale widget all rewired. `contacts.status`
  (party_status enum) stays as-is — it's orthogonal.
- ✅ **Invoice "processing" UI pseudo-status** (2026-04-21 extended,
  commit `c444014`). Money.jsx now derives a 3-state display
  (`pending` / `processing` / `paid`) from the tuple
  `(invoice.status, stripe_payment_intent_id, stripe_invoice_id)`.
  `processing` = status='pending' AND PI attached. Copper badge,
  system-state message replaces raw `inv.notes` on expand when a
  charge is in flight (Nicole and Viktoriia were showing a stale
  pre-charge "auto-push will fire" note post-charge, reading as a
  duplicate-charge threat). Pure UI derivation — DB enum untouched,
  edge functions untouched. See commit `c444014` for full derivation
  logic.
- ✅ **Cross-entity state-consistency sweep** (2026-04-21 extended,
  commits `f64c61d` / `b48bbb7` / `472caa7` / `aae3f52`). Three parallel
  read-only agents found 10 user-visible bugs where one display surface
  didn't react to state transitions in related tables (e.g. Today showed
  Nicole as "STALE LEAD · NEVER CONTACTED" after she signed + paid,
  Contracts showed "active" where operator expects "signed", Projects
  stayed at DRAFT after sign, invoice alerts fired despite PI attached,
  etc.). Fixes shipped in four batches:
  - **Batch A (`f64c61d`)** — UI-only render-time derivation across
    Today / Contracts / Contacts / Money / format.js. No DB or edge fn
    touch. 7 of 10 bugs resolved.
  - **Batch B (`b48bbb7`)** — migration `20260421000002` rewrites
    `v_stale_leads` to NOT EXISTS the contact's converted contracts
    (status NOT IN draft/sent). Nicole drops off the Today stale-lead
    alert automatically; no lead_details mutation needed.
  - **Batch C (`472caa7`)** — defensive read-filter tightening on
    `send-reminders` (lead-followup query), `auto-push-invoices`
    (charging loop), `fire-day-reminder` (morning HQ digest), and
    `check-overdue-invoices` (daily status flipper). Each now skips
    invoices on cancelled/complete projects. Zero new email-send code
    paths; purely suppression-only.
  - **Batch D (`aae3f52`)** — `contract-sign` now advances
    `projects.status` from `draft` to `active` on successful sign
    (conditional, predicate-guarded, non-blocking). One-time backfill
    flipped Nicole's + Viktoriia's project rows to active. No Stripe,
    invoice, or contract writes beyond the existing atomic sign commit.
- 🟡 **Viktoriia Jones onboarding complete 2026-04-21 extended.**
  Stripe customer `cus_UNTJyt4qyKv2Wm`, contract
  `f4283b8c-1292-458a-a64e-d9c60e2a4400` signed 18:00:19 UTC, invoice
  `LV-2026-006` ($1,700) auto-sent on sign, ACH fired 18:07 UTC via
  auto-push → PI `pi_3TOiitRzgnRnD0Dt0h8gGu0J` processing on Bank of
  America ****3777. Settlement ~Apr 23-24. Parallel state to Nicole's
  LV-2026-005 fired earlier today. Both will flip to PAID via
  `payment_intent.succeeded` webhook.

---

## Monitoring

- **UptimeRobot free tier** pings
  `https://sukcufgjptllzucbneuj.supabase.co/functions/v1/health`
  every 5 minutes with a 30-second timeout and a 2-failed-check
  confirmation window.
- Alert contact: `case.laviolette@gmail.com`. Gmail push
  notifications must be ON on your phone — the alert email IS the
  page. Setup per `docs/MONITORING_SETUP.md`.
- `/health` response includes `message` field that surfaces in the
  UptimeRobot alert subject preview and makes the alert actionable
  without opening the app (e.g. "Stale:
  laviolette_auto_push_invoices last ran 14h ago.").
- **`health_checks` retention:** no automatic cleanup in v1. UptimeRobot's
  5-min cadence produces ~288 rows/day = ~8.6k rows/month. At current pace,
  reaching 1M rows takes ~9.5 years, so no immediate action needed — but
  review row count annually (`SELECT COUNT(*) FROM public.health_checks`)
  and add a `public.prune_health_checks(older_than interval)` scheduled
  cron if the table crosses 500k rows. Audit 2026-04-22 A7 LOW — note
  added to prevent silent unbounded growth.
- Every `/health` probe is logged to `public.health_checks`
  (fire-and-forget; a logging failure never flips a healthy 200 →
  503). Time-series visible at `/incidents` (authenticated). Rolling
  7-day uptime on the Today screen's System Health widget.
- Incident response: `INCIDENTS.md` at repo root. Per-cron recovery
  commands, false-positive notes, Supabase-down playbook.
- **Public status page**: <https://stats.uptimerobot.com/muAd17CfnU>
  (read-only; link this on the marketing site if ever relevant).

---

## Edge functions

`supabase/functions/` holds 21 directories total: 19 deployable
production functions + `run-pipeline-test` (manual ops tool, excluded
from `deploy-edge.sh`) + `_shared/` (import-only helpers, not a
function). 20 are deployable; 19 ship in the main deploy loop.
Shared helpers in `_shared/`:
- `client-emails.ts` — email templates + `sendClientEmail` helper + 13
  internal notification kinds.
- `business-days.ts` — federal holiday + NACHA business-day math
  (used by auto-push fire-date calculation).
- `recap-template.ts` — monthly recap aggregator + cream/copper client-
  facing HTML + dark HQ drafts-ready HTML + `sanitizeHtmlForSend`
  allow-list (added 2026-04-21).

**Recap edge functions (added 2026-04-21):**

| Function | Trigger | Behavior |
|---|---|---|
| `generate-monthly-recaps` | pg_cron `?key=<secret>` on the 1st + optional bearer-auth `?overwrite_id=<id>` for UI-driven regenerate | For each active retainer project, aggregates previous month's `work_log` entries (DST-aware CT month boundaries via `ctMidnightToUtcIso`) and inserts a `monthly_recaps` row with status='draft'. UNIQUE(project_id, month) makes re-runs idempotent. Zero-activity retainers get a deduped DLQ audit alert. Fires one HQ "N drafts ready" email per run. |
| `send-monthly-recap` | Bearer token from the Recaps tab | Sends a draft/approved recap via Resend. BCC Case. 409 on already-sent. On success flips status='sent' + sent_at + sent_to_email. Optional `override_email` body field sends to a test address WITHOUT flipping status — logged as an audit row with context prefix `recap-test-send:<recap_id>` for queryability. |

**Health edge function (enhanced 2026-04-21):**

`/health` response now includes `ok`, `checked_at`, `stale_crons`,
`unresolved_dlq_count`, `deploy_sha` (from `DEPLOY_SHA` env, defaults
`unknown`), `message` (human-readable actionable string for alert
subject previews), and `response_ms`. Every probe fires-and-forgets
a row into `health_checks` (wrapped in try/catch — logging failures
never flip 200 → 503). User-Agent with `uptimerobot` substring marks
`source='uptimerobot'`. `MAX_GAP_HOURS` holiday-safe: weekday-only
`fire_day_reminder` is 97h (Fri → Tue gap on federal-holiday
Mondays).

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

8 cron-invoked endpoints (called by 9 jobs — `auto-push-invoices` has
primary + retry). All require `?key=<REMINDERS_SECRET>` in the URL.
Constant-time comparison would be ideal but `!==` is used (low-risk given key rotation).

**Active column:** 🟢 = active; 🔴 = deactivated via `cron.alter_job`
(handler may still return 200 `{disabled:true}` as a kill-switch —
see `auto-push-invoices`).

| Active | Job name | Cron (UTC) | CST / CDT | Endpoint |
|---|---|---|---|---|
| 🟢 | `laviolette_generate_daily_rounds` | `1 6 * * *` | 00:01 / 01:01 | POST `/generate-daily-rounds?key=` |
| 🟢 | `laviolette_fire_day_reminder` | `0 14 * * 1-5` | 08:00 / 09:00 Mon-Fri | POST `/fire-day-reminder?key=` |
| 🟢 | `laviolette_send_reminders_am` | `15 14 * * *` | 08:15 / 09:15 | POST `/send-reminders?key=` |
| 🟢 | `laviolette_check_overdue` | `0 11 * * *` | 05:00 / 06:00 | POST `/check-overdue-invoices?key=` |
| 🟢 | `laviolette_advance_contracts` | `5 11 * * *` | 05:05 / 06:05 | POST `/advance-contract-status?key=` |
| 🔴 | `laviolette_auto_push_invoices` | `5 21 * * *` | 15:05 / 16:05 | POST `/auto-push-invoices?key=` (disabled 2026-04-21, `ENABLE_AUTO_CHARGE=false`) |
| 🔴 | `laviolette_auto_push_invoices_retry` | `5 22 * * *` | 16:05 / 17:05 | POST `/auto-push-invoices?key=` (disabled 2026-04-21) |
| 🟢 | `laviolette_retainer_invoices` | `1 6 1 * *` | 00:01 / 01:01 on 1st | POST `/generate-retainer-invoices?key=` |
| 🟢 | `laviolette_generate_monthly_recaps` | `0 13 1 * *` | 08:00 / 07:00 on 1st | POST `/generate-monthly-recaps?key=` |

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

18 user-set secrets total (plus 4 Supabase-auto-provided: `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`). Set
via `npx supabase@latest secrets set NAME=value`. `DEPLOY_SHA` is now
wired in `scripts/deploy-edge.sh` to set automatically to `git rev-parse
--short HEAD` before each deploy — `/health.deploy_sha` reflects the
short SHA of the most recent deploy-edge.sh run.

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
| `DEPLOY_SHA` | Short SHA of the current deploy, surfaced in `/health` response body. Auto-set by `scripts/deploy-edge.sh` on each run (git short HEAD). Safe default `'unknown'` so missing secret doesn't crash. |
| `ENABLE_UNIFIED_ONBOARDING` | Feature flag for the unified onboarding flow. **Current value: `"true"`** (set 2026-04-21 after end-to-end test). `"true"` → `contract-sign` synthesizes invoice + bank-link on buildout sign. Any other value (including unset) → existing multi-step flow. See "Architecture: Unified onboarding flow" section. |
| `ENABLE_AUTO_CHARGE` | Kill-switch for `auto-push-invoices`. **Current value: `"false"`** (set 2026-04-21). `"true"` = cron + retry fire ACH pushes as before. Any other value (including unset, current `"false"`) = early-return no-op with `{disabled:true}` response. Paired belt-and-suspenders with `cron.alter_job active=false` on both `laviolette_auto_push_invoices*` jobs. To re-enable auto-charge: set `ENABLE_AUTO_CHARGE=true` AND `SELECT cron.alter_job(jobid, active := true) FROM cron.job WHERE jobname LIKE 'laviolette_auto_push%'`. |

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

## Architecture: Unified onboarding flow (feature-flagged, default OFF)

Added 2026-04-21. Replaces the pre-existing multi-step operator onboarding
for Variant C buildouts (operator pre-creates invoice → sends contract →
client signs → operator separately runs `stripe-setup` → client receives a
SECOND email with the bank-link URL) with a single atomic flow where
`contract-sign` synthesizes the invoice + mints a Stripe Checkout session
+ fires ONE email containing both the invoice document and the bank-link
CTA.

**Gate on all three:** flag `ENABLE_UNIFIED_ONBOARDING` is `"true"` AND
`contract.type === 'buildout'` AND the project has zero non-void invoices
yet. Any failure of those conditions → falls through to the existing
send-invoice-for-pending loop (bit-for-bit identical pre-change behavior).

### Feature flag

**Current state:** `ENABLE_UNIFIED_ONBOARDING=true` on Supabase secrets (set
2026-04-21 after the OFF→ON→Regenerate end-to-end test passed). Every new
buildout `contract-sign` invocation runs the unified branch.

| Setting | Value | Effect |
|---|---|---|
| Unset / empty / `"false"` | (rollback) | `contract-sign` never synthesizes an invoice. Existing flow. |
| `"true"` | **live** | `contract-sign` synthesizes invoice + bank-link + fires unified email on buildout signs. |

**Rollback (any time):**
```bash
npx supabase@latest secrets set ENABLE_UNIFIED_ONBOARDING=false \
  --project-ref sukcufgjptllzucbneuj
```

**Re-enable (if rolled back):**
```bash
npx supabase@latest secrets set ENABLE_UNIFIED_ONBOARDING=true \
  --project-ref sukcufgjptllzucbneuj
```

Edge functions pick up the new value on the next invocation (no redeploy
needed — Deno reads env at runtime). Existing Nicole / Viktoriia / Dustin
invoice rows are unaffected in either direction. Any buildout signed
under flag=ON keeps its synthesized invoice + bank-link URL through any
subsequent rollback — rollback only affects *future* signs.

### Validation record (2026-04-21)

Full end-to-end cycle against a disposable buildout contract with
`signer_email=caslavi79@gmail.com`:

- **OFF regression:** contract signed under flag=false → zero invoice
  synthesized, zero DLQ, LV-001..006 fingerprints unchanged, bare
  `{success:true}` response.
- **Flag flipped ON** via `supabase secrets set`.
- **ON validation:** second contract signed under flag=true → LV-2026-007
  synthesized with `bank_link_url` + `sent_date` stamped, Stripe session
  with both `laviolette_contract_id` + `laviolette_invoice_id` metadata
  (confirms `checkout.sessions.update` backfill works on setup-mode
  sessions), ONE email delivered with copper CTA button, response
  included `invoice_id` + `bank_link_url`.
- **Regenerate:** clicked "Regenerate bank-link" on LV-007 → fresh
  `cs_live_…` session minted, overwrote `bank_link_url`, fresh email
  delivered, old session stayed `status=open` (superseded but not
  instantly invalidated — harmless).
- **Cleanup:** all test rows DELETEd in single transaction. Stripe
  customer `cus_UNW150fcvgvWJn` kept as audit trail. LV-001..006
  fingerprints identical to the pre-test baseline.

**Phase 6 follow-up (2026-04-21, same day):** added a 6-step
"What to expect" numbered list to the CTA block in `send-invoice`'s
email template, motivated by Nicole + Dustin both missing the final
"Set Up Bank Account" click in Stripe Checkout. Step 5's warning
renders in copper to draw the eye. Re-validated by recreating the
disposable test scaffold (reused `cus_UNW150fcvgvWJn`), signing a
second test buildout, then clicking Regenerate — both emails delivered
with the updated copy, copper warning confirmed on mobile. Scoped
exclusively to the CTA block; retainer / null-`bank_link_url`
invoices render identically to pre-change. Shipped in commit
`d160e36 feat(email): add 6-step bank-link setup instructions to
unified invoice CTA`. Test scaffold cleaned up post-validation;
LV-001..006 fingerprints still identical to every prior snapshot.

### Flow through a unified buildout onboarding

```
Case: verbal agreement → opens Claude Code → "generate buildout contract for X"
  ↓
generate-contract.mjs inserts contracts row (status='draft', total_fee set, no invoice yet)
  ↓
Case: "Send for signing" button → contract-send fires Resend signing email
  ↓
Client: clicks /sign?token=..., signs
  ↓
contract-sign:
  a. Atomic UPDATE contracts → status='signed', sig baked into filled_html
  b. Project draft → active
  c. Signer + HQ confirmation emails (existing)
  d. UNIFIED BRANCH (flag ON + buildout + no invoice yet):
     1. Pre-flight: STRIPE_SECRET_KEY present, client.stripe_customer_id set,
        contract.total_fee > 0, contract.effective_date set
     2. stripe.checkout.sessions.create(mode=setup, us_bank_account, financial_connections instant)
        ← Stripe FIRST: failure leaves zero orphan invoice
     3. invoices INSERT with bank_link_url already populated (never transiently-null)
     4. Backfill Stripe session metadata with laviolette_invoice_id (non-fatal)
     5. fetch send-invoice?key=... { invoice_id } fire-and-forget
  e. If any step d fails: DLQ row 'contract-sign:bank-link-failure:<contract.id>',
     return 500 with contract_signed: true (contract stays signed; Case recovers manually)
  ↓
Client: receives ONE email with invoice metadata + line items + Total Due + CTA button
  ↓
Client: clicks "Link your bank" → Stripe Checkout setup (24h-valid session) → Financial Connections
  ↓
checkout.session.completed webhook → stripe-webhook sets bank_info_on_file=true, fires "✓ Bank linked" HQ alert
  ↓
Case (any time): Money tab → highlighted invoice → "Charge via ACH"
  OR auto-push-invoices on fire_date at 4:05 PM CT (existing path)
  ↓
payment_intent.succeeded webhook → invoice paid, receipt to client, ✓ Paid HQ alert
```

### Regenerate bank-link (stale-session recovery)

Stripe Checkout setup sessions expire after 24 hours. If the client doesn't
click the CTA within that window, Case can mint a fresh session + re-send
the invoice email without touching anything else on the invoice:

1. Money tab → pending invoice with `bank_link_url IS NOT NULL AND stripe_payment_intent_id IS NULL` → "Regenerate bank-link" button next to "Charge via ACH"
2. Click → `POST /functions/v1/regenerate-bank-link { invoice_id }`
3. Function validates state, creates fresh Stripe session (Stripe FIRST — failure leaves stale URL intact), UPDATEs `bank_link_url`, fires `send-invoice { invoice_id, force: true }` (force flag bypasses `sent_date` idempotency)
4. Toast: `✓ Fresh bank-link sent to <client billing_email>`

Gated in UI on: `bank_link_url IS NOT NULL AND status='pending' AND no PI AND no Stripe invoice`. Retainer invoices (no `bank_link_url`) never show the button.

### What this does NOT change

- Retainer invoices — `bank_link_url` stays NULL, send-invoice renders without CTA, auto-push fires on fire_date as today.
- Existing Dustin + Nicole + Viktoriia invoice rows — zero writes to any column on any of LV-2026-001..006.
- The monthly `generate-retainer-invoices` cron — untouched, never sets `bank_link_url`.
- `auto-push-invoices`, `check-overdue-invoices`, `fire-day-reminder`, `stripe-webhook` — no behavior change.
- `invoice_status` enum — no additions (the UI-only `processing` projection from `c444014` still handles in-flight ACH display).

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
- Lead pipeline UI full surface — Contacts + EditContactModal now
  read/write `lead_details` directly (2026-04-21 cleanup), but
  several richer fields remain unsurfaced: `scope_summary` +
  `deck_url` + `quoted_amount` + `quoted_recurring` + `lost_reason`
  are displayed read-only in the detail pane but not editable in the
  form. Deferred until Case needs them.
- Server-side PDF rendering for signed contracts (currently browser print-to-PDF works fine)
- Tax export CSV (Money page mentions it but no UI — defer until first year-end)

---

## Last known good state

| Metric | Value |
|---|---|
| Migrations applied | 34 (most recent: `20260424000001_schedule_flexible_times.sql` — replaces the rigid time_block enum with start_time/end_time on both schedule tables + adds kind taxonomy {focus|event|blackout} on overrides + updated_at trigger. Preceded by `20260423000001_work_log_sessions.sql` — adds session_id + started_at + ended_at for the Log Work v2 session-grouped flow). `_claude_migrations` row count matches filesystem. |
| Edge functions deployed | 19 production (in `deploy-edge.sh`) + `run-pipeline-test` manual = 20 deployable. Plus `_shared/` helpers (import-only, not a function) = 21 directories total. `deploy-edge.sh` pinned to `supabase@2.93.0`, now also sets `DEPLOY_SHA` secret before each deploy. |
| Webhook events subscribed | 14 |
| Cron jobs | 9 defined, **7 active** — `laviolette_auto_push_invoices` + `_retry` deactivated 2026-04-21 (auto-charge kill-switch). `/health` excludes `active=false` jobs from stale-cron alerts via migration 20260422000005 RPC update. |
| Unresolved `notification_failures` | 0 |
| Screens | 8 authenticated (Today, Schedule, Contacts, Projects, Money, Contracts, Notifications, Incidents) + 4 public (Sign, SetupSuccess, SetupCancel, Login) = 12 routes total |
| External monitoring | UptimeRobot LIVE 5-min on `/health`, alerts verified end-to-end (2026-04-21). Status page: <https://stats.uptimerobot.com/muAd17CfnU>. |
| Pending invoices | 6 — LV-2026-001..004 pending (Dustin, due May 1, no PI yet, fire_date 2026-04-30); LV-2026-005 + LV-2026-006 both pending + PI attached (Nicole/Viktoriia in-flight, render as PROCESSING in Money tab per `c444014`). |
| In-flight ACH | 2 — Nicole `pi_3TOhHzRzgnRnD0Dt0uGb2WtG` + Viktoriia `pi_3TOiitRzgnRnD0Dt0h8gGu0J`, both $1,700 Variant-C buildouts, both `status=processing` on Stripe as of 2026-04-21 end of session. Webhook will flip invoices → paid + send receipts on settlement (~Apr 23-24). |
| Stripe customers | 4 active real (VBTX `cus_UKmJZNKc8Bn9aZ`, Velvet Leaf `cus_ULBcilbNsoq0Kp`, Nicole James `cus_UNBgjM5C9n7gkX`, Viktoriia Jones `cus_UNTJyt4qyKv2Wm`) + 1 audit-trail test customer `cus_UNW150fcvgvWJn` (intentionally kept, flagged via `metadata.laviolette_test`). |
| DB clients | 5 (VBTX + Velvet Leaf = active/Dustin; Exodus 1414 = lead/Cody; Nicole James + Viktoriia Jones = lead, signed + in-flight). |
| Contracts | 7 — Dustin's 4 (3 retainers + 1 buildout) + Nicole + Viktoriia (both signed 2026-04-21, Variant C buildouts) + Exodus 1414 (draft buildout, marker-regenerated 2026-04-21). |
| Projects by status | 3 scheduled (Dustin's 3 retainers, start_date 2026-05-01) + 3 active (Citrus and Salt Buildout start_date=Apr 15, Nicole + Viktoriia buildouts start_date=today) + 1 draft (Exodus). Flip to active at 05:05 CT on each project's start_date via `advance-contract-status`. |
| Lead details rows | 3 (Cody Welch, Nicole James, Viktoriia Jones). Dustin correctly absent (customer, not lead). |
| Last frontend deploy | 2026-04-22 Log Work v2.1 (ActivityTab flat) + Schedule v2: `index-C456V7HU.js` / `index-B0TGVw_f.css` — current bundle folds in the stripped LogWorkModal (brand + window + notes + link), flat chronological ActivityTab (no service filter/grouping), agenda-style Schedule.jsx (vertical timeline, overlay semantics), EditScheduleBlockModal v2 (kind picker + native time inputs + preset chips + notes). |
| Last edge-function deploy | 2026-04-22 post-audit sweep: `check-overdue-invoices`, `send-reminders`, `stripe-webhook`, `contract-sign`, `generate-daily-rounds`, `auto-push-invoices`, `regenerate-bank-link`, `generate-monthly-recaps`, `send-monthly-recap`, `health` individually via `npx supabase@2.93.0 functions deploy <name> --no-verify-jwt`. Covers PI-null filters (C1), type=retainer gate, mandate.updated inactive-only, charge.refunded status table, payment_intent.succeeded paid_amount, post-commit side-effect try/catch, idempotency-cleanup DLQ, CT date routing, scheduled-status rounds, blocked-query project filter, DLQ payload error field, metadata-backfill soft DLQ, URL composition via new URL(), kill-switch log line, monthly-recaps context-prefix rename + destructure error, self-BCC skip, buildMessage prioritize DLQ, active-filter on stale_crons. Flags `ENABLE_UNIFIED_ONBOARDING=true` + `ENABLE_AUTO_CHARGE=false` on Supabase secrets. |
| Last DB cleanup | 2026-04-21 Phase 6 extended (deleted Phase 6 test scaffold in single transaction; kept Stripe customer `cus_UNW150fcvgvWJn` as audit trail). |
| Last DB repair | 2026-04-22 post-audit sweep: `UPDATE public._claude_migrations SET checksum='7a5ebe4f' WHERE version='20260422000004'` (Agent 10 CRITICAL — file hash on disk had drifted from the applied checksum, blocking future `apply-migrations.mjs` runs). Migration `20260422000005` then applied cleanly on top. |
| Unpushed local commits on `main` | Origin HEAD moves every batch; check `git log origin/main..HEAD --oneline` for live state. |
