# scripts/

Standalone Node scripts for admin tasks outside the React app.

## stripe-setup.js

Generates a Stripe Checkout URL that lets a client connect their bank account for ACH payments — no charge, no micro-deposits. Uses Stripe's setup mode + Financial Connections with instant-only verification.

### Prerequisites

- `STRIPE_SECRET_KEY` set in `.env.local` (or exported in shell).
- The target client has an existing Stripe Customer object — create one in the Stripe Dashboard → Customers before running this.

### Usage

```bash
# Via npm (reads .env.local automatically)
npm run stripe-setup -- <customer_id> "<client_name>"

# Direct invocation
STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-setup.js <customer_id> "<client_name>"
```

### Existing Stripe customers

| Client | Customer ID | Bank needs to cover |
|---|---|---|
| VBTX Group LLC | `cus_UKmJZNKc8Bn9aZ` | Citrus and Salt retainer ($1,200/mo), Vice Bar retainer ($1,200/mo), Citrus and Salt buildout ($1,100 one-time) |
| Velvet Leaf Lounge LLC | `cus_ULBcilbNsoq0Kp` | Third bar retainer ($1,200/mo) |

### Examples

```bash
# Generate link for VBTX Group (covers Citrus and Salt + Vice Bar)
npm run stripe-setup -- cus_UKmJZNKc8Bn9aZ "VBTX Group LLC"

# Generate link for Velvet Leaf Lounge (third bar)
npm run stripe-setup -- cus_ULBcilbNsoq0Kp "Velvet Leaf Lounge LLC"
```

### What happens after the client clicks

1. Stripe Checkout opens, client logs into their bank through Stripe Financial Connections.
2. Bank account is saved as a PaymentMethod on the Stripe Customer.
3. Client is redirected to `https://laviolette.io/setup-success?client=<name>`.
4. Case verifies in Stripe Dashboard → Customers → [name] → Payment methods.
5. Case sets the new bank as the default payment method (⋯ → "Set as default").
6. Case can now create subscriptions with "Automatically charge a payment method on file".

### Gotchas

- Link expires in 24 hours. Re-run the script to issue a new one.
- `verification_method: 'instant'` forces instant login only — no micro-deposit fallback. If the client's bank doesn't support instant verification, they'll see an error. Most major US banks are fine.
- Financial Connections has separate pricing from ACH transaction fees. Check <https://stripe.com/financial-connections#pricing> before heavy use.
- Do NOT check `STRIPE_SECRET_KEY` into git. It lives in `.env.local` only.

## create-auth-user.mjs

One-time bootstrap to create `case.laviolette@gmail.com` in Supabase Auth using the service role key. On success, prints a temporary password **once** — record it immediately. Reset the password via Supabase Dashboard → Auth → Users.

```bash
npm run create-auth-user
```

## apply-migrations.mjs

Applies every `.sql` file in `supabase/migrations/` to the Postgres DB via a direct connection on port 5432 (pooler fallback on port 6543). Tracks applied migrations in `public._claude_migrations`, so re-runs are idempotent.

```bash
npm run apply-migrations              # apply all new migrations
npm run apply-migrations -- --dry-run # show the plan without touching the DB
npm run apply-migrations -- --pooler  # force pooler connection
```

Each migration runs inside a transaction — if any statement fails the whole file rolls back.

## verify-schema.mjs

Read-only sanity check that the schema is in good shape. Reports:

- Every `public.*` table with column count and whether it has a `COMMENT`
- Column-comment coverage (should be 100%)
- All enum types
- All `idx_*` indexes
- All triggers + functions
- RLS status + policy count per table
- Storage buckets
- A handful of spec-reference queries (should all return rows or succeed)
- A live trigger smoke test that creates a throwaway contact → client → brand → project → deliverable, verifies the `briefing_md` auto-regen + `auto_complete_project` triggers fire, and rolls back

```bash
npm run db:verify
```

## generate-contract.mjs

Generates a contract HTML from a project ID + related DB rows, inserts as
`status='draft'` in the `contracts` table. Auto-fills every variable the
templates need (party info, rates, dates, services/deliverables table,
provider's countersignature). Used directly by Case or invoked from
conversations with Claude Code.

```bash
# Basic: generate a contract for a project
npm run generate-contract -- <project-id>

# Override a section toggle (all toggles are whitelisted — unknown keys reject)
npm run generate-contract -- <project-id> --toggle remote_systems=false

# Override a whitelisted field (governing_state, governing_county, effective_date,
# intro_term_months, intro_term_end, payment_method, timeline)
npm run generate-contract -- <project-id> --set governing_state=Colorado --set governing_county="El Paso County"

# Dry run — prints what would be inserted without touching DB
npm run generate-contract -- <project-id> --dry-run
```

Non-negotiable legal clauses (§1 Binding, §4.1 Pre-Effective Termination,
§4.2/3 Termination Fees, §6.3 Liability Cap, §6.4 Indemnification, buildout §6.5
Buildout Fee Earned on Execution) are hardcoded — not toggleable. The provider
side auto-countersigns at generation time with "Case Laviolette" rendered in
Great Vibes cursive + today's date + ESIGN/UETA electronic-signature notation.

See [../../contract-playbook.md](../../contract-playbook.md) for the full
generation playbook.

## import-signed-contracts.mjs

One-time utility for importing externally-signed PDFs (e.g., DocuSeal output).
Scans `/Users/caselaviolette/Desktop/Laviolette/signed-contracts/`, uploads each
PDF to the `contracts` Supabase Storage bucket under `{client_id}/signed/`, and
creates a matching row in the `contracts` table with `status='signed'`.
Idempotent — skips files already imported.

```bash
npm run import-signed-contracts
```

Used once at project bootstrap for Dustin's 4 DocuSeal-signed contracts. Future
contracts use the native `contract-send` → `contract-sign` flow, which stores
the signature image inline in `filled_html` rather than uploading a PDF.

## test-webhook-handler.mjs

Synthesizes a Stripe-signed webhook payload and POSTs it at the local or
deployed `stripe-webhook` endpoint. Useful for testing handler logic without
triggering real Stripe events. Uses the `STRIPE_WEBHOOK_SECRET` from `.env.local`
to compute a valid signature.

```bash
# Test against deployed endpoint
node scripts/test-webhook-handler.mjs
```

Edit the script to change the event type + payload being sent. See comments
inside the file for examples.

## deploy-edge.sh

Deploys all **19 production** Supabase Edge Functions with `--no-verify-jwt`
(required — several are public like `contract-sign`, `health`, or invoked by
cron with their own `?key=` auth). `run-pipeline-test` is intentionally
excluded — it's a manual ops tool and should not auto-redeploy on every run.
See [OPS.md](../OPS.md) for prerequisites (Supabase CLI auth, secrets,
pg_cron/pg_net extensions).

```bash
bash scripts/deploy-edge.sh
```

Currently deploys (alphabetical, matches the FUNCTIONS array in
deploy-edge.sh exactly):
- `advance-contract-status` — Daily cron, `signed` → `active` on effective_date
- `auto-push-invoices` — Daily 4:05 PM CT + 5:05 PM retry. Atomic-claim ACH firing.
- `check-overdue-invoices` — Daily cron, `pending`/`sent` → `overdue` past due_date
- `contract-send` — Email contract signing link
- `contract-sign` — Public signing endpoint (GET + POST), 30-day TTL, embeds client sig into filled_html, auto-fires `send-invoice` on sign
- `create-setup-session` — Stripe Checkout bank-link URL generator
- `create-stripe-invoice` — "Charge via ACH" button handler (fires PI silently post-2e886c1; client already received the invoice at sign-time)
- `fire-day-reminder` — Mon-Fri 9 AM CT, heads-up to Case with "Fire now" deep-links
- `generate-daily-rounds` — Daily cron (America/Chicago), creates today's daily_rounds rows
- `generate-monthly-recaps` — Monthly cron on the 1st, builds retainer-client recap drafts
- `generate-retainer-invoices` — Monthly cron on the 1st, next-month retainer invoices
- `health` — Public GET, cron staleness + DLQ count + pending invoices + deploy_sha + response_ms
- `retry-notification` — Replay a failed Resend email from the DLQ
- `send-invoice` — Invoice document email fired by contract-sign (or manually by invoice_id), stamps `invoices.sent_date`
- `send-manual-receipt` — Parity for MarkPaidModal (wire/check payments)
- `send-monthly-recap` — Sends a draft/approved monthly recap to the client
- `send-reminders` — Daily morning digest email to Case
- `stripe-webhook` — 14-event handler with idempotency + HQ alerts

Individual redeploy:
```bash
npx supabase@latest functions deploy <function-name> --no-verify-jwt
```

## One-off operations log

Notable ad-hoc mutations (executed via inline node/pg scripts, not committed as
reusable scripts). Kept here so future operators can trace what happened without
digging through git history.

- **2026-04-21 late extended** — regenerated `filled_html` on draft contract
  `947f7169-af69-4b9b-93ef-8cebdf94916f` (Exodus 1414 Build-Out Services
  Agreement, Cody Welch) to include the `<!-- client-sig-block -->` markers
  from audit Round 3 M4. Predicate-guarded UPDATE (`status='draft'`);
  preserved `sign_token`, `sent_at`, signer fields, `field_values`,
  `created_at`, and every other column byte-for-byte. No downstream impact;
  the marker regex fallback in `contract-sign` would have handled the
  pre-marker HTML correctly at sign time anyway — this was fleet-consistency
  cleanup. Logged via commit that references this entry.
