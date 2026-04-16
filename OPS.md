# Laviolette — Ops Runbook

Everything you need to deploy, schedule, and operate this app.

---

## Repos

| Repo | What | Where |
|---|---|---|
| `caslavi79/Laviolette-app` | Source code | you edit here |
| `caslavi79/Laviolette-app-deploy` | Built `dist/` only | GitHub Pages serves this |
| `caslavi79/Laviolette` | Marketing site | separate, unchanged |

Custom domain `app.laviolette.io` → DNS already points at GitHub Pages → points at the deploy repo.

---

## Day-to-day commands

```bash
# 1. Start the dev server (in a terminal, leave running)
cd Laviolette-app/app
npm run dev
# → http://localhost:5180

# 2. Ship a frontend change
cd Laviolette-app/app
npm run deploy     # builds + pushes dist/ to the deploy repo → live in ~45s

# 3. Generate a Stripe bank link (before edge functions are deployed)
cd Laviolette-app
npm run stripe-setup -- cus_UKmJZNKc8Bn9aZ "VBTX Group LLC"
npm run stripe-setup -- cus_ULBcilbNsoq0Kp "Velvet Leaf Lounge LLC"

# 4. Create the Supabase auth user (already done; run if re-provisioning)
npm run create-auth-user

# 5. Apply DB migrations (idempotent — tracks what's applied)
npm run apply-migrations

# 6. Verify DB schema end-to-end
npm run db:verify
```

---

## Current state (what's live)

- ✅ **Database** — all 16 tables, 20 enums, 13 indexes, 17 triggers,
  100% COMMENT coverage, RLS on, 4 storage buckets, invoice-number
  sequence. Direct-pg connection works.
- ✅ **Auth** — `case.laviolette@gmail.com` exists in Supabase Auth.
  Change the temporary password via Supabase Dashboard → Auth → Users.
- ✅ **Frontend** — live at https://app.laviolette.io (after first
  deploy propagates). 6 screens: Today, Schedule, Contacts,
  Projects, Money, Contracts. Plus public /sign, /setup-success,
  /setup-cancel.
- ✅ **Stripe CLI** — `scripts/stripe-setup.js` + redirect pages
  live on `laviolette.io/setup-success` and `…/setup-cancel`.
- 🟡 **Edge functions** — **code is ready but NOT deployed yet.**
  See next section.

---

## Edge functions: what you need to do

Ten functions are written under `supabase/functions/*`. Before they
work in production you need to:

### 1. Resolve Supabase CLI auth

Your `supabase` CLI is currently logged into an account that doesn't
have access to project `sukcufgjptllzucbneuj`. Either:

- **Option A (simplest):** Run `supabase logout` then `supabase login`
  with the email that owns the project. Then `supabase link
  --project-ref sukcufgjptllzucbneuj`.
- **Option B:** Add your current CLI account as a member of the
  Supabase organization that owns the project (Supabase Dashboard
  → Project Settings → Team).

### 2. Enable two Postgres extensions

In Supabase Dashboard → Database → Extensions, enable:
- `pg_cron` (for scheduled jobs)
- `pg_net` (for function invocations from cron)

### 3. Set secrets

Generate the Resend API key first (see below). Then paste into
Supabase Dashboard → Edge Functions → Secrets (or via CLI):

```bash
npx supabase secrets set \
  RESEND_API_KEY=re_xxx \
  STRIPE_SECRET_KEY=sk_live_xxx \
  STRIPE_WEBHOOK_SECRET=whsec_xxx \
  BRAND_NAME="Laviolette LLC" \
  BRAND_FROM_EMAIL=noreply@laviolette.io \
  BRAND_REPLY_TO=case.laviolette@gmail.com \
  BRAND_COLOR=#B8845A \
  BRAND_BG=#12100D \
  BRAND_INK=#F4F0E8 \
  BRAND_LOGO_URL=https://laviolette.io/favicon.png \
  SIGNING_BASE_URL=https://app.laviolette.io/sign \
  STRIPE_SUCCESS_URL=https://app.laviolette.io/setup-success \
  STRIPE_CANCEL_URL=https://app.laviolette.io/setup-cancel \
  CASE_NOTIFY_EMAIL=case.laviolette@gmail.com \
  APP_URL=https://app.laviolette.io \
  REMINDERS_SECRET=$(openssl rand -hex 32) \
  --project-ref sukcufgjptllzucbneuj
```

Save the REMINDERS_SECRET output — you'll also paste it into Supabase
Vault (Dashboard → Project Settings → Vault → Secrets → Add, name
`REMINDERS_SECRET`) so the cron SQL can read it.

### 4. Deploy the functions

```bash
cd Laviolette-app
bash scripts/deploy-edge.sh
```

This deploys all 10 functions with `--no-verify-jwt` (required —
several are public or invoked by cron). Takes ~60 seconds.

### 5. Schedule the cron jobs

Open Supabase Dashboard → SQL Editor and paste the contents of
`supabase/sql/cron-schedule.sql`. Run. It creates 5 cron jobs:

| Job | Schedule (UTC / MT) |
|---|---|
| `laviolette_generate_daily_rounds` | 06:01 UTC / 00:01 MT daily |
| `laviolette_check_overdue` | 12:00 UTC / 06:00 MT daily |
| `laviolette_advance_contracts` | 12:05 UTC / 06:05 MT daily |
| `laviolette_send_reminders_am` | 15:15 UTC / 09:15 MT daily |
| `laviolette_retainer_invoices` | 06:01 UTC / 00:01 MT on 1st |

### 6. (One-time) Point Stripe webhooks at the function

Stripe Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://sukcufgjptllzucbneuj.supabase.co/functions/v1/stripe-webhook`
- Events: `invoice.paid`, `invoice.payment_failed`,
  `checkout.session.completed`, `setup_intent.succeeded`
- Copy the webhook signing secret and set it as `STRIPE_WEBHOOK_SECRET`
  in Supabase secrets (see step 3).

---

## Resend setup (one-time)

1. Sign up at resend.com (or use your existing account).
2. Add domain `laviolette.io`. Follow the DKIM/SPF DNS steps (GoDaddy → add TXT records).
3. Wait for verification (usually a few minutes).
4. Create an API key under Resend Dashboard → API Keys → Create.
   Give it full access to the verified domain only.
5. Paste the key into `RESEND_API_KEY` in Supabase secrets.

Test delivery after deploying:
```bash
curl -X POST "https://sukcufgjptllzucbneuj.supabase.co/functions/v1/send-reminders?key=$REMINDERS_SECRET"
```
(Returns JSON with `sent: true/false` and a count of items.)

---

## Env files (what's what)

| File | Committed? | Purpose |
|---|---|---|
| `.env.example` | ✅ | Placeholders — template |
| `.env.local` | ❌ | Real secrets for scripts/ — gitignored |
| `app/.env.example` | ✅ | Frontend template |
| `app/.env` | ❌ | Real Supabase URL + anon key for Vite dev — gitignored |

The anon key is safe to embed in the client bundle (RLS protects
the DB). Everything else stays out of the repo.

---

## Troubleshooting

**"Send Bank Connection Link" button in the app returns an error**
→ The `create-setup-session` edge function isn't deployed yet. The
UI falls back to showing the CLI command you can run locally
(`npm run stripe-setup -- cus_xxx "Client Name"`).

**"Send for signing" in Contracts returns an error**
→ The `contract-send` edge function isn't deployed yet. The UI
falls back to generating the signing URL and marking the contract
`sent` locally — you can copy/paste the URL to the client manually.

**Daily rounds don't auto-populate**
→ The `generate-daily-rounds` edge function isn't running on cron
yet. The Today screen infers platforms client-side as a fallback,
so you can still check items — they just aren't pre-created.

**I don't get reminder emails**
→ Either (a) no Resend key / domain not verified, or (b) no pg_cron
schedule installed, or (c) no items to report (check
`send-reminders` by hitting the URL manually with your
REMINDERS_SECRET).

**Stripe webhook isn't marking invoices paid**
→ Check Supabase function logs. Most likely: `STRIPE_WEBHOOK_SECRET`
mismatch between Stripe Dashboard and Supabase secrets.

**Need to re-run migrations**
→ `npm run apply-migrations` is idempotent. Already-applied files
are skipped. Modified files are blocked (create a new migration
for incremental changes).

---

## Phase 2 (future) — intentionally deferred

- Stripe subscriptions for retainers (currently: one-off invoices
  generated monthly by `generate-retainer-invoices`)
- Receipt OCR on expense upload
- Content calendar integration (Buffer/Later/Meta Business)
- PWA install on iPhone home screen
- Supabase Realtime for live-updating Today screen
- Client-facing invoice portal
- Lead pipeline UI (`lead_details` table exists but no screen was
  built — you said you don't need a CRM yet; the table costs nothing
  to leave in place until you do)
