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

## deploy-edge.sh

Deploys all 10 Supabase Edge Functions with `--no-verify-jwt` (required — several are public or invoked by cron). See [OPS.md](../OPS.md) for prerequisites (Supabase CLI auth, secrets, pg_cron/pg_net extensions).

```bash
bash scripts/deploy-edge.sh
```
