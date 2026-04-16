// create-stripe-invoice
// Takes our invoice row, creates a Stripe invoice + invoice items,
// finalizes, and (optionally) sends. Stores back the stripe_invoice_id
// and transitions our row to status='sent'.
//
// Auth-gated. Requires client.stripe_customer_id.

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
    const { invoice_id, auto_send = true } = body
    if (!invoice_id) return json({ error: 'invoice_id required' }, 400, corsHeaders)

    const { data: inv, error } = await admin
      .from('invoices')
      .select('*, clients(id, name, legal_name, billing_email, stripe_customer_id, bank_info_on_file)')
      .eq('id', invoice_id)
      .single()
    if (error || !inv) return json({ error: 'Invoice not found' }, 404, corsHeaders)
    if (inv.stripe_invoice_id) return json({ error: 'Invoice already has a Stripe ID' }, 400, corsHeaders)
    const customerId = inv.clients?.stripe_customer_id
    if (!customerId) return json({ error: 'Client has no Stripe customer ID. Set it on the Contacts page first.' }, 400, corsHeaders)

    // Create invoice items
    const items = Array.isArray(inv.line_items) && inv.line_items.length > 0
      ? inv.line_items
      : [{ description: inv.description || 'Services', amount: inv.total }]

    for (const li of items) {
      const amountCents = Math.round((parseFloat(li.amount) || 0) * 100)
      if (amountCents <= 0) continue
      await stripe.invoiceItems.create({
        customer: customerId,
        amount: amountCents,
        currency: 'usd',
        description: li.description || inv.description || 'Services',
      })
    }

    const stripeInvoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: Math.max(1, Math.ceil((new Date(inv.due_date + 'T12:00:00').getTime() - Date.now()) / 86_400_000)),
      auto_advance: false,
      payment_settings: {
        payment_method_types: ['us_bank_account', 'card'],
      },
      metadata: {
        laviolette_invoice_id: inv.id,
        laviolette_invoice_number: inv.invoice_number || '',
      },
      description: inv.description || undefined,
    })

    await stripe.invoices.finalizeInvoice(stripeInvoice.id)
    let sentInvoice = stripeInvoice
    if (auto_send) {
      sentInvoice = await stripe.invoices.sendInvoice(stripeInvoice.id)
    }

    await admin.from('invoices').update({
      stripe_invoice_id: sentInvoice.id,
      status: 'sent',
      sent_date: new Date().toISOString().slice(0, 10),
      updated_at: new Date().toISOString(),
    }).eq('id', inv.id)

    return json({ success: true, stripe_invoice_id: sentInvoice.id, hosted_invoice_url: sentInvoice.hosted_invoice_url, invoice_pdf: sentInvoice.invoice_pdf }, 200, corsHeaders)
  } catch (err) {
    console.error('create-stripe-invoice error:', err)
    return json({ error: String((err as Error).message || err) }, 500, corsHeaders)
  }
})
