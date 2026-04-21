# Laviolette App

Personal business management app for Case Laviolette (Laviolette LLC).
Single-user SPA running at **[app.laviolette.io](https://app.laviolette.io)**.
Handles contacts, projects, scheduling, invoicing, contracts, and ACH
payments for a small consultancy.

## Stack

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React 19 + Vite + React Router 7 | Single-user SPA, hand-rolled CSS (no framework), mobile-first |
| Backend | Supabase | Postgres 17 + Auth + Storage + Edge Functions (Deno) |
| Scheduling | `pg_cron` + `pg_net` | 7 cron jobs fire HTTP POST to edge functions |
| Email | [Resend](https://resend.com) | Domain `laviolette.io` verified in us-east-1 |
| Payments | Stripe LIVE mode | ACH via PaymentIntent (not Stripe Billing — avoids 0.5% fee) |
| Deploy | `gh-pages` | Pushes `dist/` to `caslavi79/Laviolette-app-deploy`, GitHub Pages serves it |
| Hosting | GitHub Pages | Custom domain `app.laviolette.io` |

**Ops runbook:** [OPS.md](OPS.md). **Contract generation:** [../contract-playbook.md](../contract-playbook.md).

## Quick start (local dev)

```bash
cd app
npm install          # first time only
npm run dev          # http://localhost:5180
```

Sign in with `case.laviolette@gmail.com`. Reset password via Supabase Dashboard
→ Auth → Users if forgotten.

## Ship a frontend change

```bash
cd app
npm run deploy       # builds → pushes dist/ to caslavi79/Laviolette-app-deploy → live in ~45s
```

Build output is a single-page app with a `404.html` SPA fallback so deep links
like `/money` or `/sign?token=...` work on direct hit.

## Layout

```
Laviolette-app/
├── app/                        # React source (Vite)
│   ├── index.html              # <meta name="referrer"> + Google Fonts
│   ├── src/
│   │   ├── App.jsx             # Routes (10 pages) + per-page ErrorBoundary
│   │   ├── App.css             # All styles (one file, hand-rolled)
│   │   ├── main.jsx
│   │   ├── components/
│   │   │   ├── Layout.jsx      # Sidebar nav + alerts badge polling
│   │   │   ├── Modal.jsx       # Shared modal wrapper
│   │   │   ├── Field.jsx       # Form field helpers (TextField, SelectField, etc.)
│   │   │   ├── ProtectedRoute.jsx  # Auth gate (Supabase session)
│   │   │   ├── ErrorBoundary.jsx
│   │   │   └── forms/          # 12 Edit*Modal components for CRUD
│   │   ├── pages/
│   │   │   ├── Today.jsx       # Daily rounds + alerts
│   │   │   ├── Schedule.jsx    # Weekly template + overrides
│   │   │   ├── Contacts.jsx    # Contact → Client → Brand three-tier CRUD
│   │   │   ├── Projects.jsx    # Buildout + retainer projects
│   │   │   ├── Money.jsx       # Invoices / Revenue / Expenses
│   │   │   ├── Contracts.jsx   # List + detail + "Send for signing"
│   │   │   ├── Notifications.jsx   # Dead-letter queue UI (Retry / Dismiss)
│   │   │   ├── Login.jsx
│   │   │   ├── Sign.jsx        # PUBLIC signing page (Type/Draw + ESIGN consent)
│   │   │   ├── SetupSuccess.jsx    # Stripe redirect after bank link
│   │   │   └── SetupCancel.jsx
│   │   ├── templates/          # Contract HTML generators
│   │   │   ├── retainer.js
│   │   │   ├── buildout.js
│   │   │   └── index.js        # buildVariables()
│   │   └── lib/                # supabase.js, format.js, hooks.js
│   ├── public/CNAME            # app.laviolette.io
│   └── vite.config.js          # Port 5180
├── scripts/                    # Admin CLI tools
│   ├── stripe-setup.js         # Generate Stripe ACH bank-link URL for a client
│   ├── apply-migrations.mjs    # Idempotent pg migration runner
│   ├── create-auth-user.mjs    # Supabase Auth bootstrap
│   ├── verify-schema.mjs       # Read-only DB sanity check + trigger smoke test
│   ├── generate-contract.mjs   # Contract HTML generator (CLI)
│   ├── import-signed-contracts.mjs  # Import DocuSeal-signed PDFs
│   ├── test-webhook-handler.mjs     # Synthetic webhook payload tester
│   ├── deploy-edge.sh          # Deploy all 14 edge functions in one pass
│   └── README.md               # Per-script docs
├── supabase/
│   ├── migrations/             # 20 versioned SQL files (enums → tables → triggers →
│   │                           #   RLS → storage → contracts-signing → stripe idempotency
│   │                           #   → payment indexes → notification_failures → cron observability)
│   ├── functions/              # 15 Deno edge functions
│   │   ├── _shared/            # client-emails.ts, business-days.ts
│   │   ├── stripe-webhook/     # 14 Stripe events + idempotency + HQ alerts
│   │   ├── auto-push-invoices/ # Daily 4:05 PM CT ACH firing + atomic claim
│   │   ├── create-stripe-invoice/   # "Charge via ACH" button handler
│   │   ├── create-setup-session/    # Stripe Checkout bank-link (UI path)
│   │   ├── contract-send/      # Send contract for e-sign
│   │   ├── contract-sign/      # PUBLIC sign handler (GET + POST)
│   │   ├── generate-retainer-invoices/  # Monthly cron — creates next-month retainer invoices
│   │   ├── generate-daily-rounds/       # Daily cron — creates today's daily_rounds rows
│   │   ├── check-overdue-invoices/      # Daily cron — pending/sent → overdue
│   │   ├── advance-contract-status/     # Daily cron — signed → active on effective_date
│   │   ├── send-reminders/     # Daily digest email
│   │   ├── fire-day-reminder/  # Mon-Fri 9 AM CT — heads-up email with "Fire now" buttons
│   │   ├── retry-notification/ # Replay a failed Resend send from the DLQ
│   │   ├── send-manual-receipt/    # Fire receipt + HQ alert for MarkPaidModal wire/check payments
│   │   └── health/             # Public GET — cron status + DLQ count + pending invoices
│   └── sql/
│       └── cron-schedule.sql   # pg_cron setup (7 jobs, DST-corrected)
├── OPS.md                      # Day-to-day ops runbook
├── README.md                   # This file
└── package.json                # Root scripts (stripe-setup, db:verify, apply-migrations, generate-contract)
```

## Environment

Copy `.env.example` → `.env.local` and `app/.env.example` → `app/.env`, fill in
real values. Both `.env.local` and `app/.env` are gitignored.

| Variable | File | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | `app/.env` | Frontend Supabase client |
| `VITE_SUPABASE_ANON_KEY` | `app/.env` | Frontend (RLS-protected; safe to ship in bundle) |
| `SUPABASE_PROJECT_REF` | `.env.local` | All `scripts/*` (direct pg connection) |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local` | `scripts/*` admin operations |
| `SUPABASE_DB_PASSWORD` | `.env.local` | `apply-migrations` direct pg connection |
| `SUPABASE_ACCESS_TOKEN` | `.env.local` | `npx supabase` CLI (edge deploy, secrets) |
| `STRIPE_SECRET_KEY` | `.env.local` | `stripe-setup.js` + `test-webhook-handler.mjs` |
| `STRIPE_WEBHOOK_SECRET` | `.env.local` | Local signing-verification testing |
| `RESEND_API_KEY` | `.env.local` | Local email testing + preview scripts |
| `REMINDERS_SECRET` | `.env.local` | Cron-auth — hit `?key=<val>` on cron endpoints |

Edge function secrets live in Supabase Dashboard
([Settings → Functions](https://supabase.com/dashboard/project/sukcufgjptllzucbneuj/settings/functions)),
NOT in this repo. See [OPS.md](OPS.md) for the list (~16 secrets).

## Status (2026-04-17)

| Phase | State | Notes |
|---|---|---|
| 0. Repo + credentials | ✅ | All 3 repos, gh CLI auth, Stripe CLI live-mode |
| 0.5. Stripe CLI + static redirect pages | ✅ | Live on laviolette.io/setup-success + /setup-cancel |
| 1. DB schema | ✅ | 17 tables, 100% comments, 17 triggers, RLS everywhere |
| 2. Frontend scaffold + auth | ✅ | React 19 + Router 7 + Vite, per-page ErrorBoundary |
| 3.1 Today | ✅ | Daily rounds + alerts + week tasks + buildout deliverables |
| 3.2 Contacts/Clients/Brands | ✅ | Three-tier nested CRUD, billing-state pill with PI+Invoice checking |
| 3.3 Projects | ✅ | Buildouts + retainers, briefing markdown preview |
| 3.4 Schedule | ✅ | Weekly template + per-date overrides (color-coded by brand) |
| 3.5 Money | ✅ | Invoices + Revenue + Expenses, "Charge via ACH" button, string-slice YTD year math |
| 3.6 Contracts | ✅ | Editor + signing flow with typed cursive + auto-countersign + download PDF |
| 3.7 Notifications | ✅ | Dead-letter queue UI, Retry / Dismiss, auto-polled badge in sidebar |
| 4. Edge functions | ✅ | **15** deployed (10 original + retry-notification + send-manual-receipt + health + fire-day-reminder + send-reminders improvements) |
| 4.5. Stripe webhook | ✅ | **14 events** subscribed, idempotency table, HQ alerts via `notifyCase`, handlers for paid/failed/canceled/processing/dispute/refund/mandate/pm_detached |
| 4.6. Cron schedule | ✅ | **8 jobs** active, DST-corrected `1 6 UTC` past midnight CT in both seasons, fire-day-reminder at 9 AM CT weekdays |
| 4.11. Fire-day reminder | ✅ | 9 AM CT weekdays. Emails Case eligible + blocked invoices with "Fire now" deep-links. Manual-first + auto-push safety net pattern. |
| 4.7. Resend | ✅ | Domain verified, API key set, BCC on all client emails, DLQ on failures |
| 4.8. Dead-letter queue | ✅ | `notification_failures` table (RLS, CHECK constraints, partial index) + retry edge fn + UI |
| 4.9. Health endpoint | ✅ | `/functions/v1/health` → cron staleness + DLQ count, curl-able for external monitoring |
| 4.10. Contract flow | ✅ | Typed/Draw signature, ESIGN/UETA consent, auto-countersign, client sig baked into filled_html, download PDF |
| 5. Frontend deploy | ✅ | Live at app.laviolette.io |

**Next milestone: May 1, 2026 — first live billing cycle.** 4 invoices totaling
$4,700 auto-charge at 4:05 PM CT on April 30 against Dustin Batson's linked banks.

See [../HANDOFF.md](../HANDOFF.md) for the full session log + outstanding items.
