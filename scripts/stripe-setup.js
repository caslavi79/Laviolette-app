#!/usr/bin/env node

/**
 * stripe-setup.js
 *
 * Generates a Stripe Checkout URL for collecting a client's ACH bank account
 * information without charging. Uses Stripe's setup mode + Financial
 * Connections with instant-only verification (no micro-deposits).
 *
 * Reads STRIPE_SECRET_KEY from the environment. The npm script wrapper passes
 * --env-file-if-exists=.env.local so you don't have to prefix the key every
 * time during local work.
 *
 * Usage:
 *   npm run stripe-setup -- <customer_id> "<client_name>"
 *   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-setup.js <customer_id> "<client_name>"
 *
 * Example:
 *   npm run stripe-setup -- cus_UKmJZNKc8Bn9aZ "VBTX Group LLC"
 *
 * Docs: https://docs.stripe.com/payments/ach-direct-debit/set-up-payment?payment-ui=checkout
 */

import Stripe from 'stripe';

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error('Error: STRIPE_SECRET_KEY environment variable is required.');
  console.error('Set it in .env.local or prefix the command inline.');
  console.error('Find your keys at: https://dashboard.stripe.com/apikeys');
  process.exit(1);
}

const customerId = process.argv[2];
const clientName = process.argv[3] || 'Client';

if (!customerId || !customerId.startsWith('cus_')) {
  console.error('Usage: npm run stripe-setup -- <customer_id> "<client_name>"');
  console.error('Example: npm run stripe-setup -- cus_UKmJZNKc8Bn9aZ "VBTX Group LLC"');
  console.error('');
  console.error('The customer_id must start with "cus_".');
  process.exit(1);
}

const stripe = new Stripe(secretKey);

try {
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'setup',
    payment_method_types: ['us_bank_account'],
    payment_method_options: {
      us_bank_account: {
        financial_connections: {
          permissions: ['payment_method'],
        },
        verification_method: 'instant',
      },
    },
    success_url: `https://laviolette.io/setup-success?client=${encodeURIComponent(clientName)}`,
    cancel_url: 'https://laviolette.io/setup-cancel',
  });

  const expiresAt = new Date(session.expires_at * 1000);

  console.log('');
  console.log(`\u2713 Bank connection link created for ${clientName}`);
  console.log(`  Customer ID: ${customerId}`);
  console.log(`  Session ID:  ${session.id}`);
  console.log(`  Expires:     ${expiresAt.toLocaleString()}  (24h from now)`);
  console.log('');
  console.log('Send this link to the client:');
  console.log(session.url);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Text or email the link to the contact for ${clientName}.`);
  console.log(`  2. Client logs into their bank via Stripe Financial Connections.`);
  console.log(`  3. Verify in Stripe Dashboard \u2192 Customers \u2192 ${clientName} \u2192 Payment methods.`);
  console.log(`  4. Once app is live, toggle "bank_info_on_file = true" on the client record.`);
  console.log('');
} catch (error) {
  console.error('');
  console.error(`Stripe error: ${error.message}`);
  if (error.type === 'StripeInvalidRequestError') {
    console.error('Check that the customer ID is correct and your API key is valid.');
  }
  if (error.type === 'StripeAuthenticationError') {
    console.error('Your STRIPE_SECRET_KEY appears invalid. Regenerate at');
    console.error('https://dashboard.stripe.com/apikeys and update .env.local.');
  }
  process.exit(1);
}
