// create-stripe-invoice
// DEPRECATED NAME — kept for backward compatibility with the Money.jsx "Charge via ACH"
// button. The function now creates a Stripe PaymentIntent directly (not a Stripe Invoice)
// to avoid Stripe Billing's 0.5% per-invoice fee. Only the base ACH fee (0.8% cap $5) applies.
//
// Flow: take our invoice row → create off-session PaymentIntent on the customer's default
// us_bank_account PM → confirm → store pi_* in our row → status=pending → wait for webhook.
//
// Auth-gated (Bearer token from logged-in user). Requires client.stripe_customer_id AND
// a default payment method on the customer (set by stripe-webhook after bank setup).

import Stripe from 'https://esm.sh/stripe@17?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  sendClientEmail,
  buildInvoiceChargingEmail,
} from '../_shared/client-emails.ts'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_NAME = Deno.env.get('BRAND_NAME') || 'Laviolette LLC'
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const BRAND_REPLY_TO = Deno.env.get('BRAND_REPLY_TO') || 'case.laviolette@gmail.com'
const CASE_NOTIFY_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'

const stripe = new Stripe(STRIPE_SECRET_KEY)

const ALLOWED_ORIGINS = [
  'https://app.laviolette.io',
  'http://localhost:5180',
  'http://localhost:5173',
]
function cors(req: Request) {
  const origin = req.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  }
}
function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  const corsHeaders = cors(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401, corsHeaders)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'Unauthorized' }, 401, corsHeaders)

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const body = await req.json()
    const { invoice_id } = body
    if (!invoice_id) return json({ error: 'invoice_id required' }, 400, corsHeaders)

    const { data: inv, error } = await admin
      .from('invoices')
      .select('*, clients(id, name, legal_name, billing_email, stripe_customer_id, bank_info_on_file), brands(name)')
      .eq('id', invoice_id)
      .single()
    if (error || !inv) return json({ error: 'Invoice not found' }, 404, corsHeaders)
    if (inv.stripe_payment_intent_id) return json({ error: 'Invoice already has a PaymentIntent' }, 400, corsHeaders)
    if (inv.stripe_invoice_id) return json({ error: 'Invoice was already pushed via legacy Stripe Invoice flow — no need to charge again' }, 400, corsHeaders)
    const customerId = inv.clients?.stripe_customer_id
    if (!customerId) return json({ error: 'Client has no Stripe customer ID. Set it on the Contacts page first.' }, 400, corsHeaders)

    // Get the customer's default payment method (set by webhook after bank setup)
    const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer
    const defaultPM = customer.invoice_settings?.default_payment_method as string | undefined
    if (!defaultPM) {
      return json({
        error: 'Client has no default payment method on Stripe. Have them submit bank info via the setup link first.',
      }, 400, corsHeaders)
    }

    const amountCents = Math.round((parseFloat(String(inv.total)) || 0) * 100)
    if (amountCents <= 0) {
      return json({ error: 'Invoice total must be positive.' }, 400, corsHeaders)
    }

    // Build a human-readable statement descriptor (keeps ACH trail tidy for the client).
    // Stripe's us_bank_account charges show in the client's bank statement as
    // "LAVIOLETTE LLC" (from account name) plus this suffix.
    const descSuffix = (inv.invoice_number || 'INVOICE').slice(0, 22) // max 22 chars per Stripe

    // ATOMIC CLAIM: lock the invoice before hitting Stripe so a concurrent cron
    // run (auto-push-invoices) or a double-click on this button can't create a
    // second PI for the same invoice. Conditional UPDATE only succeeds if both
    // stripe_payment_intent_id AND stripe_invoice_id are NULL.
    const claimToken = `CLAIMING:${crypto.randomUUID()}`
    const { data: claimed, error: claimErr } = await admin
      .from('invoices')
      .update({ stripe_payment_intent_id: claimToken, updated_at: new Date().toISOString() })
      .eq('id', inv.id)
      .is('stripe_payment_intent_id', null)
      .is('stripe_invoice_id', null)
      .select('id')
      .maybeSingle()
    if (claimErr) return json({ error: `claim failed: ${claimErr.message}` }, 500, corsHeaders)
    if (!claimed) {
      return json({ error: 'Another process is already charging this invoice — try again in a moment.' }, 409, corsHeaders)
    }

    // Create + confirm the PaymentIntent in one call. off_session=true signals "customer is not
    // actively completing the payment; use the saved mandate/PM."
    let pi: Stripe.PaymentIntent
    try {
      pi = await stripe.paymentIntents.create({
        customer: customerId,
        payment_method: defaultPM,
        amount: amountCents,
        currency: 'usd',
        confirm: true,
        off_session: true,
        payment_method_types: ['us_bank_account'],
        description: inv.description || undefined,
        statement_descriptor_suffix: descSuffix,
        metadata: {
          laviolette_invoice_id: inv.id,
          laviolette_invoice_number: inv.invoice_number || '',
        },
      })
    } catch (e) {
      // Stripe rejected — release the claim so a future retry can proceed.
      const { error: relErr } = await admin
        .from('invoices')
        .update({ stripe_payment_intent_id: null })
        .eq('id', inv.id)
        .eq('stripe_payment_intent_id', claimToken)
      if (relErr) {
        console.error(
          `[create-stripe-invoice] CRITICAL: Stripe failed AND claim release failed for invoice ${inv.id}. Manual intervention required. err=${relErr.message}`
        )
      }
      throw e
    }

    // Replace the claim marker with the real PI ID. Predicate ensures we only overwrite
    // our own claim, so a webhook-written PI ID (rare race) isn't clobbered.
    const { data: updated, error: updErr } = await admin.from('invoices').update({
      stripe_payment_intent_id: pi.id,
      status: 'pending',
      sent_date: new Date().toISOString().slice(0, 10),
      updated_at: new Date().toISOString(),
    }).eq('id', inv.id).eq('stripe_payment_intent_id', claimToken).select('id')
    if (updErr || !updated || updated.length === 0) {
      // Either DB errored or the predicate didn't match. The latter happens when
      // a webhook for pi.id beat us to writing the real PI ID. Verify and recover.
      const { data: current } = await admin
        .from('invoices')
        .select('stripe_payment_intent_id')
        .eq('id', inv.id)
        .maybeSingle()
      if (current?.stripe_payment_intent_id === pi.id) {
        console.warn(
          `[create-stripe-invoice] Webhook wrote PI ${pi.id} before our replace-sentinel update. Treating as success.`
        )
        // Fall through to success response below.
      } else {
        console.error(
          `[create-stripe-invoice] ORPHAN RISK: PI ${pi.id} created for invoice ${inv.id} but sentinel-replace did not match. Current=${current?.stripe_payment_intent_id || 'null'}. err=${updErr?.message || 'predicate mismatch'}`
        )
        return json({ error: 'PI created but DB update failed — check logs' }, 500, corsHeaders)
      }
    }

    // Send invoice-charging email to the client so they see a debit coming.
    // Non-blocking — email failure doesn't reverse the Stripe charge. Persists
    // to notification_failures on failure so Case can retry/dismiss in-app.
    const toEmail = inv.clients?.billing_email as string | null | undefined
    if (!toEmail) {
      console.warn(`[create-stripe-invoice] no billing_email on client for ${inv.invoice_number}; skipping invoice-charging email`)
    } else {
      const brandName = (inv.brands as { name?: string } | undefined)?.name
        || inv.clients?.legal_name || inv.clients?.name || 'your account'
      const clientName = inv.clients?.legal_name || inv.clients?.name || 'there'
      const { subject: emailSubject, html: emailHtml } = buildInvoiceChargingEmail({
        clientName,
        brandName,
        invoiceNumber: inv.invoice_number,
        description: inv.description || '',
        amount: inv.total,
        dueDate: inv.due_date,
        fireDate: new Date().toISOString().slice(0, 10),
      })
      const emailRes = await sendClientEmail({
        apiKey: RESEND_API_KEY,
        from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`,
        replyTo: BRAND_REPLY_TO,
        to: toEmail,
        bcc: CASE_NOTIFY_EMAIL,
        subject: emailSubject,
        html: emailHtml,
        context: `create-stripe-invoice:${inv.invoice_number}`,
      })
      if (!emailRes.ok) {
        console.error(`[create-stripe-invoice] invoice-charging email failed for ${inv.invoice_number}: ${emailRes.error}`)
        try {
          await admin.from('notification_failures').insert({
            kind: 'client', context: `create-stripe-invoice:${inv.invoice_number}`,
            subject: emailSubject, to_email: toEmail, error: emailRes.error,
            payload: { from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`, reply_to: BRAND_REPLY_TO, html: emailHtml },
          })
        } catch (e) {
          console.error(`[create-stripe-invoice] failed to persist email failure: ${(e as Error).message}`)
        }
      }
    }

    return json({
      success: true,
      stripe_payment_intent_id: pi.id,
      status: pi.status,  // 'processing' expected for ACH
      amount: pi.amount / 100,
      next_action: pi.next_action?.type || null,
    }, 200, corsHeaders)
  } catch (err) {
    const sErr = err as Stripe.errors.StripeError
    console.error('create-stripe-invoice error:', sErr.message, sErr.code)
    // Surface Stripe errors meaningfully
    if (sErr.type === 'StripeCardError' || sErr.type === 'StripeInvalidRequestError') {
      return json({ error: sErr.message, code: sErr.code }, 400, {
        'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
        'Content-Type': 'application/json',
      })
    }
    return json({ error: 'Internal error' }, 500, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
      'Content-Type': 'application/json',
    })
  }
})
