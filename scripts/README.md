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

*(Will be added in Phase 1.)* One-time bootstrap to create `case.laviolette@gmail.com` in Supabase Auth using the service role key. Case resets the password via Supabase dashboard after first login.
