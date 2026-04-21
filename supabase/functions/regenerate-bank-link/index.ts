// regenerate-bank-link
// Mints a fresh Stripe Checkout (setup-mode) session for a pending invoice
// whose original bank_link_url has gone stale (Stripe sessions expire after
// 24 hours), then re-sends the invoice email via send-invoice so the client
// receives the new link.
//
// Stripe-first ordering: if the fresh session creation fails, the existing
// (stale) bank_link_url stays in place — we never overwrite it with null.
// The UI surfaces the Stripe error to the operator, who can retry.
//
// Auth: Bearer token (Case only). Same pattern as create-stripe-invoice.
//
// Input (JSON body):
//   { "invoice_id": "<uuid>" }
//
// Returns:
//   200 { success: true, bank_link_url, session_id, email_sent, sent_to, email_error }
//   400 { error: "..." }   validation failure (state mismatch, missing fields)
//   401 { error: "Unauthorized" }
//   404 { error: "Invoice not found" }
//   500 { error: "..." }   DB update failure after Stripe success (rare, recoverable)
//   502 { error: "..." }   Stripe failure — bank_link_url left untouched

import Stripe from 'https://esm.sh/stripe@17?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY')
const REMINDERS_SECRET = Deno.env.get('REMINDERS_SECRET') || ''
const STRIPE_SUCCESS_URL = Deno.env.get('STRIPE_SUCCESS_URL') || 'https://app.laviolette.io/setup-success'
const STRIPE_CANCEL_URL = Deno.env.get('STRIPE_CANCEL_URL') || 'https://app.laviolette.io/setup-cancel'

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
    // Auth: same Bearer pattern as create-stripe-invoice
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401, corsHeaders)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'Unauthorized' }, 401, corsHeaders)

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const body = await req.json().catch(() => ({}))
    const { invoice_id } = body as { invoice_id?: string }
    if (!invoice_id) return json({ error: 'invoice_id required' }, 400, corsHeaders)

    // Load invoice + related client
    const { data: inv, error: invErr } = await admin
      .from('invoices')
      .select(
        'id, invoice_number, status, bank_link_url, stripe_payment_intent_id, stripe_invoice_id, ' +
        'clients(stripe_customer_id, legal_name, name, billing_email)'
      )
      .eq('id', invoice_id)
      .single()
    if (invErr || !inv) {
      return json({ error: `Invoice not found: ${invErr?.message || 'no row'}` }, 404, corsHeaders)
    }

    // Validate invoice state. These mirror the UI gating on the button so any
    // out-of-band state drift (webhook raced the operator, PI canceled, etc.)
    // is surfaced cleanly instead of silently regenerating a link that can't
    // be used.
    if (!inv.bank_link_url) {
      return json({ error: 'This invoice has no bank-link to regenerate.' }, 400, corsHeaders)
    }
    if (inv.status !== 'pending') {
      return json({ error: `Invoice status is "${inv.status}" — bank-link regenerate only applies to pending invoices.` }, 400, corsHeaders)
    }
    if (inv.stripe_payment_intent_id) {
      return json({ error: 'Invoice is already charging (PaymentIntent attached). Cancel the PI first if you need to re-link the bank.' }, 400, corsHeaders)
    }
    if (inv.stripe_invoice_id) {
      return json({ error: 'Invoice was pushed via the legacy Stripe Invoice flow — not eligible for regenerate.' }, 400, corsHeaders)
    }
    const clientRow = inv.clients as {
      stripe_customer_id?: string | null
      legal_name?: string | null
      name?: string | null
      billing_email?: string | null
    } | null
    if (!clientRow?.stripe_customer_id) {
      return json({ error: 'Client has no Stripe customer ID. Set one on the Contacts page first.' }, 400, corsHeaders)
    }

    // Stripe FIRST. Per Case's design note: if this throws, the existing
    // (stale) bank_link_url stays in place. We never overwrite it with null.
    const clientDisplayName = clientRow.legal_name || clientRow.name || ''
    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.create({
        customer: clientRow.stripe_customer_id,
        mode: 'setup',
        payment_method_types: ['us_bank_account'],
        payment_method_options: {
          us_bank_account: {
            financial_connections: { permissions: ['payment_method'] },
            verification_method: 'instant',
          },
        },
        success_url: `${STRIPE_SUCCESS_URL}?client=${encodeURIComponent(clientDisplayName)}`,
        cancel_url: STRIPE_CANCEL_URL,
        metadata: {
          laviolette_invoice_id: inv.id,
          laviolette_regenerated: 'true',
        },
      })
    } catch (e) {
      const errMsg = (e as Error).message
      const stripeErr = e as { code?: string; type?: string; statusCode?: number }
      console.error(
        `[regenerate-bank-link] Stripe session creation failed. ` +
        `invoice=${inv.id} (${inv.invoice_number}) ` +
        `stripe_status=${stripeErr.statusCode ?? 'n/a'} ` +
        `stripe_code=${stripeErr.code || stripeErr.type || 'unknown'} ` +
        `msg=${errMsg.slice(0, 300)}`
      )
      return json({ error: `Stripe session creation failed: ${errMsg.slice(0, 300)}` }, 502, corsHeaders)
    }
    if (!session.url) {
      return json({ error: 'Stripe returned a session without a URL.' }, 502, corsHeaders)
    }

    // Overwrite bank_link_url with the fresh session URL. At this point the
    // stale-URL-preservation guarantee no longer applies (Stripe succeeded),
    // so the write is strictly additive.
    const { error: updErr } = await admin
      .from('invoices')
      .update({ bank_link_url: session.url, updated_at: new Date().toISOString() })
      .eq('id', inv.id)
    if (updErr) {
      // Edge case: Stripe session exists (session.id), new URL minted, but the DB
      // still points at the old URL. Not great but recoverable: Case retries and
      // the idempotent behavior handles it (new session generated, URL overwritten
      // next attempt). The previous session auto-expires in 24h.
      console.error(
        `[regenerate-bank-link] DB update failed after Stripe success. ` +
        `invoice=${inv.id} (${inv.invoice_number}) session=${session.id} msg=${updErr.message}`
      )
      return json({ error: `DB update failed after Stripe success: ${updErr.message}` }, 500, corsHeaders)
    }

    // Re-send invoice email with force=true so send-invoice bypasses its
    // sent_date idempotency guard. Await so the response can surface the
    // client's billing_email in the UI toast.
    let sendOk = false
    let sendErr: string | null = null
    let sentTo: string | null = null
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-invoice?key=${encodeURIComponent(REMINDERS_SECRET)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: inv.id, force: true }),
      })
      const payload = await resp.json().catch(() => ({})) as {
        ok?: boolean
        error?: string
        sent_to?: string
      }
      sendOk = resp.ok && payload.ok === true
      sentTo = payload.sent_to || clientRow.billing_email || null
      sendErr = sendOk ? null : (payload.error || `HTTP ${resp.status}`)
    } catch (e) {
      sendErr = (e as Error).message
    }

    // send-invoice already persists its own DLQ entry on Resend failure, so
    // we don't double-log here. Surface email_sent+email_error to the UI so
    // the toast can distinguish "link regenerated AND emailed" vs "link
    // regenerated but email failed — check /notifications".
    return json({
      success: true,
      bank_link_url: session.url,
      session_id: session.id,
      email_sent: sendOk,
      sent_to: sentTo,
      email_error: sendErr,
    }, 200, corsHeaders)
  } catch (err) {
    console.error('regenerate-bank-link error:', (err as Error).message)
    return json({ error: 'Internal error' }, 500, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0],
      'Content-Type': 'application/json',
    })
  }
})
