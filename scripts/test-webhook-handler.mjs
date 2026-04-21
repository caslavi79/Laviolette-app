#!/usr/bin/env node
// Fires Stripe-signed synthetic events at the deployed stripe-webhook edge function
// and verifies DB side effects via direct pg.
//
// Usage:
//   node --env-file-if-exists=.env.local scripts/test-webhook-handler.mjs

import crypto from 'node:crypto';
import pg from 'pg';

const WEBHOOK_URL = 'https://sukcufgjptllzucbneuj.supabase.co/functions/v1/stripe-webhook';
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET;
const REF = process.env.SUPABASE_PROJECT_REF;
const PW = process.env.SUPABASE_DB_PASSWORD;

if (!WHSEC || !REF || !PW) {
  console.error('Missing env. Need STRIPE_WEBHOOK_SECRET, SUPABASE_PROJECT_REF, SUPABASE_DB_PASSWORD');
  process.exit(1);
}

const TEST_CLIENT_ID = 'bb46f332-cc56-4985-91dd-ebc56ac79078';
const STRIPE_CUSTOMER_ID = 'cus_ULYbtx3b8kLDtB';
const REAL_TEST_INVOICE = '76ac6394-a9ac-417a-94cc-2ba333defc45';

const client = new pg.Client({
  host: `db.${REF}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password: PW,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  application_name: 'webhook-handler-test',
});
await client.connect();

function signAndHeader(rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${rawBody}`;
  const v1 = crypto.createHmac('sha256', WHSEC).update(signedPayload).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function fireEvent(eventObj) {
  const raw = JSON.stringify(eventObj);
  const sig = signAndHeader(raw);
  const resp = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': sig,
    },
    body: raw,
  });
  const text = await resp.text();
  return { status: resp.status, body: text, signature: sig };
}

function makeEvent(type, object) {
  return {
    id: 'evt_test_' + crypto.randomBytes(8).toString('hex'),
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

async function getClientBank() {
  const r = await client.query(
    `SELECT bank_info_on_file, updated_at FROM clients WHERE id = $1`,
    [TEST_CLIENT_ID],
  );
  return r.rows[0];
}

async function getInvoice(id) {
  const r = await client.query(
    `SELECT id, status, paid_date, payment_method, stripe_invoice_id, stripe_payment_intent_id, notes, updated_at
     FROM invoices WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function getInvoiceByStripeId(sid) {
  const r = await client.query(
    `SELECT id, status, paid_date, payment_method, stripe_invoice_id, notes, updated_at
     FROM invoices WHERE stripe_invoice_id = $1`,
    [sid],
  );
  return r.rows[0];
}

const results = [];
function record({ name, sig, status, body, before, after, pass, effect }) {
  results.push({ name, sig, status, body, before, after, pass, effect });
}

function hdr(s) {
  console.log('\n' + '='.repeat(70));
  console.log(s);
  console.log('='.repeat(70));
}

// -----------------------------------------------------------------
// TEST 1: checkout.session.completed
// -----------------------------------------------------------------
hdr('TEST 1 — checkout.session.completed');
{
  const before = await getClientBank();
  console.log('BEFORE client.bank_info_on_file:', before);

  const session = {
    id: 'cs_test_' + crypto.randomBytes(8).toString('hex'),
    object: 'checkout.session',
    mode: 'setup',
    customer: STRIPE_CUSTOMER_ID,
    setup_intent: 'seti_test_' + crypto.randomBytes(6).toString('hex'),
    status: 'complete',
    created: Math.floor(Date.now() / 1000),
    metadata: {},
  };
  const event = makeEvent('checkout.session.completed', session);
  const { status, body, signature } = await fireEvent(event);
  console.log('Stripe-Signature:', signature);
  console.log('Response:', status, body);

  await new Promise(r => setTimeout(r, 700));
  const after = await getClientBank();
  console.log('AFTER client.bank_info_on_file:', after);

  const pass = status === 200 && after.bank_info_on_file === true;
  record({
    name: 'checkout.session.completed',
    sig: signature,
    status, body,
    before, after,
    pass,
    effect: before.bank_info_on_file === after.bank_info_on_file
      ? 'no change (idempotent)'
      : `bank_info_on_file: ${before.bank_info_on_file} -> ${after.bank_info_on_file}`,
  });
}

// -----------------------------------------------------------------
// TEST 2: setup_intent.succeeded
// -----------------------------------------------------------------
hdr('TEST 2 — setup_intent.succeeded');
{
  const before = await getClientBank();
  console.log('BEFORE client.bank_info_on_file:', before);

  const si = {
    id: 'seti_test_' + crypto.randomBytes(8).toString('hex'),
    object: 'setup_intent',
    status: 'succeeded',
    customer: STRIPE_CUSTOMER_ID,
    payment_method: 'pm_test_' + crypto.randomBytes(6).toString('hex'),
    usage: 'off_session',
  };
  const event = makeEvent('setup_intent.succeeded', si);
  const { status, body, signature } = await fireEvent(event);
  console.log('Stripe-Signature:', signature);
  console.log('Response:', status, body);

  await new Promise(r => setTimeout(r, 700));
  const after = await getClientBank();
  console.log('AFTER client.bank_info_on_file:', after);

  const pass = status === 200 && after.bank_info_on_file === true;
  record({
    name: 'setup_intent.succeeded',
    sig: signature,
    status, body,
    before, after,
    pass,
    effect: `bank_info_on_file stays true (updated_at touched: ${before.updated_at?.toISOString?.() !== after.updated_at?.toISOString?.()})`,
  });
}

// -----------------------------------------------------------------
// TEST 3: setup_intent.setup_failed
// -----------------------------------------------------------------
hdr('TEST 3 — setup_intent.setup_failed');
{
  const before = await getClientBank();
  console.log('BEFORE client.bank_info_on_file:', before);

  const si = {
    id: 'seti_test_' + crypto.randomBytes(8).toString('hex'),
    object: 'setup_intent',
    status: 'requires_payment_method',
    customer: STRIPE_CUSTOMER_ID,
    last_setup_error: {
      code: 'payment_method_microdeposit_verification_amounts_mismatch',
      type: 'invalid_request_error',
      message: 'The amounts provided do not match the amounts that were sent to the bank account.',
      decline_code: null,
      payment_method: { id: 'pm_test_fail', object: 'payment_method' },
    },
  };
  const event = makeEvent('setup_intent.setup_failed', si);
  const { status, body, signature } = await fireEvent(event);
  console.log('Stripe-Signature:', signature);
  console.log('Response:', status, body);

  await new Promise(r => setTimeout(r, 500));
  const after = await getClientBank();

  const pass = status === 200;
  record({
    name: 'setup_intent.setup_failed',
    sig: signature,
    status, body,
    before, after,
    pass,
    effect: 'log-only, no DB change expected',
  });
}

// -----------------------------------------------------------------
// TEST 4: checkout.session.expired
// -----------------------------------------------------------------
hdr('TEST 4 — checkout.session.expired');
{
  const before = await getClientBank();

  const session = {
    id: 'cs_test_' + crypto.randomBytes(8).toString('hex'),
    object: 'checkout.session',
    mode: 'setup',
    customer: STRIPE_CUSTOMER_ID,
    status: 'expired',
    created: Math.floor(Date.now() / 1000) - 86400,
    expires_at: Math.floor(Date.now() / 1000),
    metadata: {},
  };
  const event = makeEvent('checkout.session.expired', session);
  const { status, body, signature } = await fireEvent(event);
  console.log('Stripe-Signature:', signature);
  console.log('Response:', status, body);

  await new Promise(r => setTimeout(r, 500));
  const after = await getClientBank();

  const pass = status === 200;
  record({
    name: 'checkout.session.expired',
    sig: signature,
    status, body,
    before, after,
    pass,
    effect: 'log-only, no DB change expected',
  });
}

// -----------------------------------------------------------------
// Helper: create a throwaway test invoice row
// -----------------------------------------------------------------
async function createTestInvoice({ invoiceNumber, stripeInvoiceId, amount }) {
  const r = await client.query(
    `INSERT INTO invoices
       (client_id, invoice_number, line_items, total, tax, status, due_date, stripe_invoice_id, notes)
     VALUES ($1, $2, '[]'::jsonb, $3, 0, 'pending', CURRENT_DATE + 30, $4, $5)
     RETURNING id, status, paid_date, payment_method, stripe_invoice_id, notes`,
    [
      TEST_CLIENT_ID,
      invoiceNumber,
      amount,
      stripeInvoiceId,
      'TEST — webhook handler verification',
    ],
  );
  return r.rows[0];
}

const createdIds = [];

// -----------------------------------------------------------------
// TEST 5: invoice.paid — fresh test invoice
// -----------------------------------------------------------------
hdr('TEST 5 — invoice.paid');
let test5InvoiceId;
{
  const stamp = Date.now().toString().slice(-6);
  const fresh = await createTestInvoice({
    invoiceNumber: `TEST-WHK-PAID-${stamp}`,
    stripeInvoiceId: `in_test_paidhandler_${stamp}`,
    amount: 1,
  });
  test5InvoiceId = fresh.id;
  createdIds.push(fresh.id);
  console.log('Created test invoice:', fresh);

  const before = await getInvoice(test5InvoiceId);
  console.log('BEFORE:', before);

  const inv = {
    id: fresh.stripe_invoice_id,
    object: 'invoice',
    status: 'paid',
    customer: STRIPE_CUSTOMER_ID,
    payment_intent: 'pi_test_' + crypto.randomBytes(6).toString('hex'),
    metadata: { laviolette_invoice_id: test5InvoiceId },
    status_transitions: {
      paid_at: Math.floor(Date.now() / 1000),
      finalized_at: Math.floor(Date.now() / 1000),
    },
    amount_paid: 100,
    total: 100,
  };
  const event = makeEvent('invoice.paid', inv);
  const { status, body, signature } = await fireEvent(event);
  console.log('Stripe-Signature:', signature);
  console.log('Response:', status, body);

  await new Promise(r => setTimeout(r, 1000));
  const after = await getInvoice(test5InvoiceId);
  console.log('AFTER:', after);

  const pass =
    status === 200 &&
    after.status === 'paid' &&
    after.payment_method === 'stripe_ach' &&
    after.paid_date !== null;
  record({
    name: 'invoice.paid',
    sig: signature,
    status, body,
    before, after,
    pass,
    effect: `status ${before.status} -> ${after.status}, payment_method=${after.payment_method}, paid_date=${after.paid_date}`,
  });
}

// -----------------------------------------------------------------
// TEST 6: invoice.payment_failed — fresh test invoice
// -----------------------------------------------------------------
hdr('TEST 6 — invoice.payment_failed');
let test6InvoiceId;
{
  const stamp = Date.now().toString().slice(-6);
  const fresh = await createTestInvoice({
    invoiceNumber: `TEST-WHK-FAIL-${stamp}`,
    stripeInvoiceId: `in_test_failhandler_${stamp}`,
    amount: 1,
  });
  test6InvoiceId = fresh.id;
  createdIds.push(fresh.id);
  console.log('Created test invoice:', fresh);

  const before = await getInvoice(test6InvoiceId);
  console.log('BEFORE:', before);

  const inv = {
    id: fresh.stripe_invoice_id,
    object: 'invoice',
    status: 'open',
    customer: STRIPE_CUSTOMER_ID,
    metadata: { laviolette_invoice_id: test6InvoiceId },
    last_payment_error: {
      code: 'payment_intent_payment_attempt_failed',
      type: 'invalid_request_error',
      message: 'ACH debit returned: insufficient funds (R01).',
    },
    amount_due: 100,
    total: 100,
  };
  const event = makeEvent('invoice.payment_failed', inv);
  const { status, body, signature } = await fireEvent(event);
  console.log('Stripe-Signature:', signature);
  console.log('Response:', status, body);

  await new Promise(r => setTimeout(r, 1000));
  const after = await getInvoice(test6InvoiceId);
  console.log('AFTER:', after);

  const pass =
    status === 200 &&
    after.status === 'overdue' &&
    (after.notes || '').toLowerCase().includes('stripe payment failed');
  record({
    name: 'invoice.payment_failed',
    sig: signature,
    status, body,
    before, after,
    pass,
    effect: `status ${before.status} -> ${after.status}, notes="${after.notes}"`,
  });
}

// -----------------------------------------------------------------
// Confirm real invoice A untouched
// -----------------------------------------------------------------
hdr('SAFETY CHECK — real test invoice A unchanged?');
{
  const real = await getInvoice(REAL_TEST_INVOICE);
  console.log('Real test invoice A:', real);
  if (real.status !== 'pending') {
    console.error('!!! UNEXPECTED: real test invoice A is no longer pending !!!');
  } else {
    console.log('OK: real test invoice A still pending.');
  }
}

// -----------------------------------------------------------------
// Cleanup: delete the two fresh test rows we created
// -----------------------------------------------------------------
hdr('CLEANUP — deleting fresh test invoices');
for (const id of createdIds) {
  const r = await client.query(
    `DELETE FROM invoices WHERE id = $1 AND notes = $2 RETURNING id, invoice_number, status`,
    [id, 'TEST — webhook handler verification'],
  );
  // notes may have been overwritten on failed test; fall back to plain id match if guard-delete missed
  if (r.rowCount === 0) {
    const r2 = await client.query(
      `DELETE FROM invoices WHERE id = $1 AND invoice_number LIKE 'TEST-WHK-%' RETURNING id, invoice_number, status`,
      [id],
    );
    console.log('Deleted (loose match):', r2.rows[0] || 'NOT FOUND');
  } else {
    console.log('Deleted:', r.rows[0]);
  }
}

// Confirm neither row remains
const remaining = await client.query(
  `SELECT id, invoice_number FROM invoices WHERE id = ANY($1::uuid[])`,
  [createdIds],
);
console.log('Remaining test rows (should be 0):', remaining.rowCount);

// Final real invoice A state
const realFinal = await getInvoice(REAL_TEST_INVOICE);
console.log('FINAL real test invoice A:', realFinal);

// -----------------------------------------------------------------
// Summary
// -----------------------------------------------------------------
hdr('SUMMARY');
console.log(
  '| # | Test                          | Sig | Resp | Effect                                                 | Pass |',
);
console.log(
  '|---|-------------------------------|-----|------|--------------------------------------------------------|------|',
);
results.forEach((r, i) => {
  const sigOk = r.status !== 400 ? 'valid' : 'INVALID';
  console.log(
    `| ${i + 1} | ${r.name.padEnd(29)} | ${sigOk.padEnd(3)} | ${String(r.status).padEnd(4)} | ${String(r.effect).slice(0, 54).padEnd(54)} | ${r.pass ? 'PASS' : 'FAIL'} |`,
  );
});

await client.end();
console.log('\nDone.');
