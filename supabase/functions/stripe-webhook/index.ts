// stripe-webhook
// Listens for Stripe events and reconciles our invoices table.
// No auth — Stripe signs requests with a webhook secret.
//
// Handles:
//   - invoice.paid                 → mark our row paid
//   - invoice.payment_failed       → flag overdue-style note
//   - checkout.session.completed   → mark bank_info_on_file=true on setup completions
//   - setup_intent.succeeded       → same as above (double-safety)
//
// Configure STRIPE_WEBHOOK_SECRET in Supabase Edge Function secrets
// and point Stripe dashboard → Webhooks at this function URL.

import Stripe from 'https://esm.sh/stripe@17?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY')
const STRIPE_WEBHOOK_SECRET = env('STRIPE_WEBHOOK_SECRET')

const stripe = new Stripe(STRIPE_SECRET_KEY)
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const signature = req.headers.get('stripe-signature')
  if (!signature) return new Response('Missing signature', { status: 400 })

  const rawBody = await req.text()

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature verification failed:', (err as Error).message)
    return new Response('Invalid signature', { status: 400 })
  }

  try {
    switch (event.type) {
      case 'invoice.paid': {
        const stripeInv = event.data.object as Stripe.Invoice
        const metaId = stripeInv.metadata?.laviolette_invoice_id
        let q = admin.from('invoices').update({
          status: 'paid',
          paid_date: new Date(stripeInv.status_transitions?.paid_at ? stripeInv.status_transitions.paid_at * 1000 : Date.now()).toISOString().slice(0, 10),
          payment_method: 'stripe_ach',
          stripe_invoice_id: stripeInv.id,
          stripe_payment_intent_id: (stripeInv.payment_intent as string) || null,
          updated_at: new Date().toISOString(),
        })
        q = metaId ? q.eq('id', metaId) : q.eq('stripe_invoice_id', stripeInv.id)
        await q
        break
      }
      case 'invoice.payment_failed': {
        const stripeInv = event.data.object as Stripe.Invoice
        const metaId = stripeInv.metadata?.laviolette_invoice_id
        const patch = {
          status: 'overdue' as const,
          updated_at: new Date().toISOString(),
          notes: (stripeInv.last_payment_error?.message ? `Stripe payment failed: ${stripeInv.last_payment_error.message}` : 'Stripe payment failed'),
        }
        let q = admin.from('invoices').update(patch)
        q = metaId ? q.eq('id', metaId) : q.eq('stripe_invoice_id', stripeInv.id)
        await q
        break
      }
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.mode === 'setup' && session.customer) {
          const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id
          await admin.from('clients').update({
            bank_info_on_file: true,
            updated_at: new Date().toISOString(),
          }).eq('stripe_customer_id', customerId)

          // Also set the new payment method as the customer default
          const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'us_bank_account' })
          if (pms.data.length > 0) {
            await stripe.customers.update(customerId, {
              invoice_settings: { default_payment_method: pms.data[0].id },
            })
          }
        }
        break
      }
      case 'setup_intent.succeeded': {
        const si = event.data.object as Stripe.SetupIntent
        if (si.customer) {
          const customerId = typeof si.customer === 'string' ? si.customer : si.customer.id
          await admin.from('clients').update({
            bank_info_on_file: true,
            updated_at: new Date().toISOString(),
          }).eq('stripe_customer_id', customerId)
        }
        break
      }
      default:
        // Log and ignore
        break
    }
    return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('stripe-webhook handler error:', err)
    return new Response(JSON.stringify({ error: String((err as Error).message || err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
