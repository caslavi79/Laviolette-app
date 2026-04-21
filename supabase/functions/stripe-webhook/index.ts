// stripe-webhook
// Listens for Stripe events and reconciles our DB.
// No auth — Stripe signs requests with a webhook secret.
//
// Handles:
//   - payment_intent.succeeded     → mark our row paid (primary since 2026-04-16 — we charge via PaymentIntent, not Stripe Invoice)
//   - payment_intent.payment_failed → flag overdue + append failure note
//   - payment_intent.processing    → log only (ACH initiated, clearing)
//   - payment_intent.canceled      → return invoice to pending, clear PI ref so it can be re-pushed
//   - charge.dispute.created       → CRITICAL: notify Case of chargeback with evidence deadline
//   - charge.refunded              → flip invoice to void/paid based on full/partial refund
//   - invoice.paid                 → legacy: mark our row paid (for any Stripe Invoice already in-flight from the old flow)
//   - invoice.payment_failed       → legacy: flag overdue (same reason)
//   - checkout.session.completed   → mark bank_info_on_file=true on setup completions,
//                                    set customer's default payment method (with fallback alert)
//   - setup_intent.succeeded       → mark bank_info_on_file=true + ensure default PM (double-safety)
//   - setup_intent.setup_failed    → notify Case with failure details
//   - checkout.session.expired     → notify Case on abandoned bank-link setup
//
// Idempotency: each event.id is recorded in stripe_events_processed on first touch
// so Stripe retries (same event.id) are no-ops. DB update errors throw so Stripe
// retries rather than silently losing state.

import Stripe from 'https://esm.sh/stripe@17?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  sendClientEmail,
  buildReceiptEmail,
  buildPaymentFailedEmail,
  buildInternalNotification,
} from '../_shared/client-emails.ts'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY')
const STRIPE_WEBHOOK_SECRET = env('STRIPE_WEBHOOK_SECRET')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_NAME = Deno.env.get('BRAND_NAME') || 'Laviolette LLC'
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const BRAND_REPLY_TO = Deno.env.get('BRAND_REPLY_TO') || 'case.laviolette@gmail.com'
const CASE_NOTIFY_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'
const APP_URL = Deno.env.get('APP_URL') || 'https://app.laviolette.io'

async function notifyCase(
  subject: string,
  html: string,
  context: string,
): Promise<void> {
  const from = `Laviolette HQ <${BRAND_FROM_EMAIL}>`
  const res = await sendClientEmail({
    apiKey: RESEND_API_KEY,
    from,
    to: CASE_NOTIFY_EMAIL,
    subject,
    html,
    context,
  })
  if (!res.ok) {
    console.error(`[${context}] internal notification failed: ${res.error}`)
    // Persist to the dead-letter queue so Case has visibility (Resend outage,
    // bad address, rate-limit). Best-effort — swallow any insert error.
    try {
      await admin.from('notification_failures').insert({
        kind: 'internal',
        context,
        subject,
        to_email: CASE_NOTIFY_EMAIL,
        error: res.error,
        payload: { from, html },
      })
    } catch (e) {
      console.error(`[${context}] failed to persist notification failure: ${(e as Error).message}`)
    }
  }
}

/**
 * Attach the customer's us_bank_account PM as their default for invoice payments.
 * Returns true if a default was set (or was already set correctly). Returns false and
 * emails Case a 'default_pm_missing' alert if no bank PM is attached to the customer
 * OR if the Stripe API call fails — either case means auto-charge will break until resolved.
 */
async function ensureDefaultPaymentMethod(
  customerId: string,
  clientName: string,
  context: string,
): Promise<boolean> {
  try {
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'us_bank_account' })
    if (!pms.data || pms.data.length === 0) {
      console.error(`[${context}] no us_bank_account PM attached to ${customerId}`)
      const caseNotif = buildInternalNotification({
        kind: 'default_pm_missing',
        clientName,
        stripeCustomerId: customerId,
        appUrl: APP_URL,
      })
      await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:pm-missing:${customerId}`)
      return false
    }
    // Pick the most recently attached bank PM (Stripe's list order is insertion
    // time but not guaranteed stable; sort explicitly to avoid picking a stale
    // PM if the customer has linked multiple banks).
    const sorted = [...pms.data].sort((a, b) => (b.created || 0) - (a.created || 0))
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: sorted[0].id },
    })
    return true
  } catch (err) {
    console.error(`[${context}] failed to set default PM for ${customerId}: ${(err as Error).message}`)
    const caseNotif = buildInternalNotification({
      kind: 'default_pm_missing',
      clientName,
      stripeCustomerId: customerId,
      appUrl: APP_URL,
    })
    await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:pm-missing:${customerId}`)
    return false
  }
}

const stripe = new Stripe(STRIPE_SECRET_KEY)
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Helper: throw on Supabase error so Stripe retries rather than silently losing state.
function must<T>(res: { data: T; error: { message: string } | null }, context: string): T {
  if (res.error) {
    throw new Error(`${context}: ${res.error.message}`)
  }
  return res.data
}

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

  // --- Idempotency guard ---
  // Insert event.id. If already present (23505 unique_violation), skip handling.
  const { error: idemErr } = await admin
    .from('stripe_events_processed')
    .insert({
      event_id: event.id,
      event_type: event.type,
      livemode: event.livemode ?? true,
    })
  if (idemErr) {
    // 23505 = Postgres unique_violation. That means we've already processed this event.id.
    // Everything else we treat as a hard error so Stripe retries.
    if ((idemErr as { code?: string }).code === '23505') {
      return new Response(JSON.stringify({ received: true, duplicate: true, event_id: event.id }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    console.error('Failed to record event for idempotency:', idemErr)
    return new Response(JSON.stringify({ error: 'idempotency insert failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // --- Event handling ---
  try {
    switch (event.type) {
      // -----------------------------------------------------------------
      // PRIMARY FLOW (2026-04-16+): We charge via PaymentIntent, not Stripe
      // Invoice, to avoid the 0.5% Billing fee. These are the events that
      // actually matter for our DB reconciliation.
      // -----------------------------------------------------------------
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent
        const metaId = pi.metadata?.laviolette_invoice_id
        if (!metaId) {
          // PI not from our flow (could be Stripe Dashboard-initiated). Log and skip.
          console.log(`[payment_intent.succeeded] no laviolette_invoice_id metadata on ${pi.id}, skipping DB update`)
          break
        }
        // Read current state so we can detect + preserve a manual `partially_paid`
        // mark (Case marked a partial payment before Stripe's webhook arrived) and
        // avoid pointless re-writes if status is already `paid`.
        const { data: current } = await admin
          .from('invoices')
          .select('status, paid_amount, notes')
          .eq('id', metaId)
          .maybeSingle()
        const priorStatus = current?.status
        const partialReconcileNote =
          priorStatus === 'partially_paid' && current?.paid_amount != null
            ? `Stripe payment_intent.succeeded received for full amount. Prior manual partially_paid amount (${current.paid_amount}) preserved in paid_amount for audit.`
            : null
        const combinedNotes = partialReconcileNote
          ? ((current?.notes || '').trim()
              ? `${(current?.notes || '').trim()}\n\n${new Date().toISOString()}: ${partialReconcileNote}`
              : `${new Date().toISOString()}: ${partialReconcileNote}`)
          : current?.notes
        const patch = {
          status: 'paid' as const,
          paid_date: new Date().toISOString().slice(0, 10),
          payment_method: 'stripe_ach' as const,
          stripe_payment_intent_id: pi.id,
          updated_at: new Date().toISOString(),
          ...(partialReconcileNote ? { notes: combinedNotes } : {}),
        }
        const res = await admin
          .from('invoices')
          .update(patch)
          .eq('id', metaId)
          .select(
            'id, invoice_number, total, description, paid_date, ' +
            'clients(billing_email, legal_name, name), ' +
            'brands(name)'
          )
        must(res, 'invoices update (payment_intent.succeeded)')
        if (!res.data || res.data.length === 0) {
          console.warn(`[payment_intent.succeeded] no matching invoice row for id=${metaId}, pi=${pi.id}`)
          break
        }

        // Send paid receipt to the client. Non-blocking — any failure is logged
        // but must not throw (would cause Stripe to retry the whole webhook and
        // double-send the receipt on next attempt since the DB update already committed).
        const invRow = res.data[0] as {
          invoice_number: string
          total: number | string
          description: string | null
          paid_date: string
          clients?: { billing_email?: string | null; legal_name?: string | null; name?: string | null } | null
          brands?: { name?: string | null } | null
        }
        const toEmail = invRow.clients?.billing_email
        if (!toEmail) {
          console.warn(`[payment_intent.succeeded] ${invRow.invoice_number}: no billing_email — skipping receipt email`)
          break
        }
        const { subject, html } = buildReceiptEmail({
          clientName: invRow.clients?.legal_name || invRow.clients?.name || 'there',
          brandName: invRow.brands?.name || invRow.clients?.legal_name || invRow.clients?.name || 'your account',
          invoiceNumber: invRow.invoice_number,
          description: invRow.description || '',
          amount: invRow.total,
          paidDate: invRow.paid_date,
        })
        const emailRes = await sendClientEmail({
          apiKey: RESEND_API_KEY,
          from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`,
          replyTo: BRAND_REPLY_TO,
          to: toEmail,
          bcc: CASE_NOTIFY_EMAIL,
          subject,
          html,
          context: `stripe-webhook:receipt:${invRow.invoice_number}`,
        })
        if (!emailRes.ok) {
          console.error(`[payment_intent.succeeded] receipt email failed for ${invRow.invoice_number}: ${emailRes.error}`)
          try {
            await admin.from('notification_failures').insert({
              kind: 'client', context: `stripe-webhook:receipt:${invRow.invoice_number}`,
              subject, to_email: toEmail, error: emailRes.error,
              payload: { from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`, reply_to: BRAND_REPLY_TO, html },
            })
          } catch (e) { console.error(`failed to persist: ${(e as Error).message}`) }
        }

        // Internal notification to Case
        const caseNotif = buildInternalNotification({
          kind: 'payment_succeeded',
          clientName: invRow.clients?.legal_name || invRow.clients?.name || 'Unknown client',
          brandName: invRow.brands?.name || 'your account',
          invoiceNumber: invRow.invoice_number,
          amount: invRow.total,
          paidDate: invRow.paid_date,
          appUrl: APP_URL,
        })
        await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:paid:${invRow.invoice_number}`)
        break
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent
        const metaId = pi.metadata?.laviolette_invoice_id
        if (!metaId) {
          console.log(`[payment_intent.payment_failed] no laviolette_invoice_id metadata on ${pi.id}, skipping DB update`)
          break
        }
        const failureMessage = pi.last_payment_error?.message || null
        const failureNote = failureMessage ? `ACH payment failed: ${failureMessage}` : 'ACH payment failed'
        // Append to existing notes instead of overwriting
        const { data: existing } = await admin
          .from('invoices')
          .select('notes')
          .eq('id', metaId)
          .maybeSingle()
        const priorNotes = (existing?.notes || '').trim()
        const combinedNotes = priorNotes
          ? `${priorNotes}\n\n${new Date().toISOString()}: ${failureNote}`
          : failureNote
        const patch = {
          status: 'overdue' as const,
          notes: combinedNotes,
          stripe_payment_intent_id: pi.id,
          updated_at: new Date().toISOString(),
        }
        const res = await admin
          .from('invoices')
          .update(patch)
          .eq('id', metaId)
          .select(
            'id, invoice_number, total, description, due_date, ' +
            'clients(billing_email, legal_name, name), ' +
            'brands(name)'
          )
        must(res, 'invoices update (payment_intent.payment_failed)')
        if (!res.data || res.data.length === 0) {
          console.warn(`[payment_intent.payment_failed] no matching invoice row for id=${metaId}, pi=${pi.id}`)
          break
        }

        // Send failure notification to client. Non-blocking — if email fails,
        // Case still has the DB flag + Stripe dashboard as backstops.
        const invRow = res.data[0] as {
          invoice_number: string
          total: number | string
          description: string | null
          due_date: string
          clients?: { billing_email?: string | null; legal_name?: string | null; name?: string | null } | null
          brands?: { name?: string | null } | null
        }
        const toEmail = invRow.clients?.billing_email
        if (!toEmail) {
          console.warn(`[payment_intent.payment_failed] ${invRow.invoice_number}: no billing_email — skipping failure email`)
          break
        }
        const { subject, html } = buildPaymentFailedEmail({
          clientName: invRow.clients?.legal_name || invRow.clients?.name || 'there',
          brandName: invRow.brands?.name || invRow.clients?.legal_name || invRow.clients?.name || 'your account',
          invoiceNumber: invRow.invoice_number,
          description: invRow.description || '',
          amount: invRow.total,
          dueDate: invRow.due_date,
          failureReason: failureMessage,
        })
        const emailRes = await sendClientEmail({
          apiKey: RESEND_API_KEY,
          from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`,
          replyTo: BRAND_REPLY_TO,
          to: toEmail,
          bcc: CASE_NOTIFY_EMAIL,
          subject,
          html,
          context: `stripe-webhook:failed:${invRow.invoice_number}`,
        })
        if (!emailRes.ok) {
          console.error(`[payment_intent.payment_failed] failure email failed for ${invRow.invoice_number}: ${emailRes.error}`)
          try {
            await admin.from('notification_failures').insert({
              kind: 'client', context: `stripe-webhook:failed:${invRow.invoice_number}`,
              subject, to_email: toEmail, error: emailRes.error,
              payload: { from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`, reply_to: BRAND_REPLY_TO, html },
            })
          } catch (e) { console.error(`failed to persist: ${(e as Error).message}`) }
        }

        // Internal notification to Case
        const caseNotif = buildInternalNotification({
          kind: 'payment_failed',
          clientName: invRow.clients?.legal_name || invRow.clients?.name || 'Unknown client',
          brandName: invRow.brands?.name || 'your account',
          invoiceNumber: invRow.invoice_number,
          amount: invRow.total,
          reason: failureMessage,
          appUrl: APP_URL,
        })
        await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:failed:${invRow.invoice_number}`)
        break
      }
      case 'payment_intent.processing': {
        // ACH has been initiated and is clearing. No DB action needed (row is already 'pending').
        const pi = event.data.object as Stripe.PaymentIntent
        console.log(`[payment_intent.processing] ${pi.id} metadata=${JSON.stringify(pi.metadata || {})}`)
        break
      }
      case 'payment_intent.canceled': {
        // PI was canceled before settlement (e.g. via Stripe Dashboard or our own
        // double-charge cancellation). Return the invoice to pending/draft so it can be re-pushed.
        const pi = event.data.object as Stripe.PaymentIntent
        const metaId = pi.metadata?.laviolette_invoice_id
        if (!metaId) {
          console.log(`[payment_intent.canceled] no laviolette_invoice_id metadata on ${pi.id}, skipping`)
          break
        }
        const cancelReason = pi.cancellation_reason || pi.last_payment_error?.message || null
        const note = cancelReason ? `PaymentIntent canceled: ${cancelReason}` : 'PaymentIntent canceled'
        const { data: existing } = await admin
          .from('invoices')
          .select('notes, invoice_number, total, description, clients(legal_name, name), brands(name)')
          .eq('id', metaId)
          .maybeSingle()
        const priorNotes = (existing?.notes || '').trim()
        const combinedNotes = priorNotes
          ? `${priorNotes}\n\n${new Date().toISOString()}: ${note}`
          : note
        // Clear stripe_payment_intent_id so auto-push can re-pick this invoice on the next run
        const res = await admin
          .from('invoices')
          .update({
            status: 'pending' as const,
            stripe_payment_intent_id: null,
            notes: combinedNotes,
            updated_at: new Date().toISOString(),
          })
          .eq('id', metaId)
          .select('id, invoice_number')
        must(res, 'invoices update (payment_intent.canceled)')
        if (!res.data || res.data.length === 0) {
          console.warn(`[payment_intent.canceled] no matching invoice row for id=${metaId}, pi=${pi.id}`)
          break
        }
        const row = existing as {
          invoice_number?: string
          total?: number | string
          clients?: { legal_name?: string | null; name?: string | null } | null
          brands?: { name?: string | null } | null
        } | null
        const caseNotif = buildInternalNotification({
          kind: 'payment_canceled',
          clientName: row?.clients?.legal_name || row?.clients?.name || 'Unknown client',
          brandName: row?.brands?.name || 'your account',
          invoiceNumber: row?.invoice_number || null,
          amount: row?.total ?? 0,
          reason: cancelReason,
          appUrl: APP_URL,
        })
        await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:pi-canceled:${pi.id}`)
        break
      }
      case 'charge.dispute.created': {
        // Chargeback / dispute filed by the customer. CRITICAL — evidence must be
        // submitted via Stripe Dashboard before the due_by deadline (typically 7-10 days).
        const dispute = event.data.object as Stripe.Dispute
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id
        const piId = typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : (dispute.payment_intent as Stripe.PaymentIntent | null)?.id
        // Try to locate our invoice via PI
        let invRow: {
          invoice_number?: string
          clients?: { legal_name?: string | null; name?: string | null } | null
          brands?: { name?: string | null } | null
        } | null = null
        if (piId) {
          const { data } = await admin
            .from('invoices')
            .select('invoice_number, clients(legal_name, name), brands(name)')
            .eq('stripe_payment_intent_id', piId)
            .maybeSingle()
          invRow = data as typeof invRow
        }
        console.error('[charge.dispute.created]', JSON.stringify({
          dispute_id: dispute.id,
          charge_id: chargeId,
          payment_intent: piId,
          amount: dispute.amount,
          reason: dispute.reason,
          status: dispute.status,
          due_by: dispute.evidence_details?.due_by,
          invoice: invRow?.invoice_number || null,
        }))
        const caseNotif = buildInternalNotification({
          kind: 'dispute_created',
          clientName: invRow?.clients?.legal_name || invRow?.clients?.name || 'Unknown client',
          brandName: invRow?.brands?.name || 'your account',
          invoiceNumber: invRow?.invoice_number || null,
          amount: (dispute.amount || 0) / 100,
          reason: dispute.reason || null,
          dueBy: dispute.evidence_details?.due_by
            ? new Date(dispute.evidence_details.due_by * 1000).toISOString().slice(0, 10)
            : null,
          appUrl: APP_URL,
        })
        await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:dispute:${dispute.id}`)
        break
      }
      case 'charge.refunded': {
        // Refund issued (full or partial). Update our DB so revenue/tax reports stay accurate.
        const charge = event.data.object as Stripe.Charge
        const piId = typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : (charge.payment_intent as Stripe.PaymentIntent | null)?.id
        const refundedAmount = (charge.amount_refunded || 0) / 100
        const fullyRefunded = charge.amount_refunded === charge.amount
        if (!piId) {
          console.warn('[charge.refunded] charge has no payment_intent; cannot locate invoice')
          break
        }
        const { data: existing } = await admin
          .from('invoices')
          .select('id, invoice_number, status, notes, total, clients(legal_name, name), brands(name)')
          .eq('stripe_payment_intent_id', piId)
          .maybeSingle()
        if (!existing) {
          console.warn(`[charge.refunded] no matching invoice for pi=${piId}`)
          break
        }
        const row = existing as {
          id: string
          invoice_number: string
          notes: string | null
          total: number | string
          clients?: { legal_name?: string | null; name?: string | null } | null
          brands?: { name?: string | null } | null
        }
        const note = fullyRefunded
          ? `Refunded in full: ${charge.id}`
          : `Partial refund of ${refundedAmount}: ${charge.id}`
        const priorNotes = (row.notes || '').trim()
        const combinedNotes = priorNotes
          ? `${priorNotes}\n\n${new Date().toISOString()}: ${note}`
          : note
        // Status transition rules to avoid flipping void→paid on a late partial refund:
        // - current=void: stay void (already fully refunded; any subsequent refund is a duplicate or smaller)
        // - current=paid and fullyRefunded: transition to void
        // - current=paid and !fullyRefunded: stay paid (just append note)
        // - current=pending/overdue: mirrors above for unusual pre-settlement refund cases
        const currentStatus = (row as { status?: string }).status
        const nextStatus =
          currentStatus === 'void'
            ? 'void' as const
            : fullyRefunded
              ? 'void' as const
              : (currentStatus === 'paid' ? 'paid' as const : 'paid' as const)
        const res = await admin
          .from('invoices')
          .update({
            status: nextStatus,
            notes: combinedNotes,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
          .select('id')
        must(res, 'invoices update (charge.refunded)')
        const caseNotif = buildInternalNotification({
          kind: 'refunded',
          clientName: row.clients?.legal_name || row.clients?.name || 'Unknown client',
          brandName: row.brands?.name || 'your account',
          invoiceNumber: row.invoice_number,
          amount: refundedAmount,
          appUrl: APP_URL,
        })
        await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:refund:${charge.id}`)
        break
      }

      // -----------------------------------------------------------------
      // LEGACY: Stripe Invoice events. Still handled for any in-flight Stripe
      // Invoices from before the PaymentIntent migration (e.g. the $1 test
      // invoice in_1TMvlFRzgnRnD0Dtt2re9s8w). Will be deprecated once those settle.
      // -----------------------------------------------------------------
      case 'invoice.paid': {
        const stripeInv = event.data.object as Stripe.Invoice
        const metaId = stripeInv.metadata?.laviolette_invoice_id
        const patch = {
          status: 'paid' as const,
          paid_date: new Date(
            stripeInv.status_transitions?.paid_at
              ? stripeInv.status_transitions.paid_at * 1000
              : Date.now()
          ).toISOString().slice(0, 10),
          payment_method: 'stripe_ach' as const,
          stripe_invoice_id: stripeInv.id,
          stripe_payment_intent_id: (stripeInv.payment_intent as string) || null,
          updated_at: new Date().toISOString(),
        }
        const q = admin.from('invoices').update(patch)
        const res = await (metaId ? q.eq('id', metaId) : q.eq('stripe_invoice_id', stripeInv.id)).select('id')
        must(res, 'invoices update (paid)')
        if (!res.data || res.data.length === 0) {
          // Event arrived for an invoice we don't have in our DB. Log and move on —
          // the event_id is already recorded so we won't retry this forever.
          console.warn(
            `[invoice.paid] no matching invoice row. metadata.laviolette_invoice_id=${metaId}, stripe_invoice_id=${stripeInv.id}`
          )
        }
        break
      }
      case 'invoice.payment_failed': {
        const stripeInv = event.data.object as Stripe.Invoice
        const metaId = stripeInv.metadata?.laviolette_invoice_id
        const failureNote = stripeInv.last_payment_error?.message
          ? `Stripe payment failed: ${stripeInv.last_payment_error.message}`
          : 'Stripe payment failed'
        // Append to existing notes instead of overwriting — preserves any prior context.
        const whereCol = metaId ? 'id' : 'stripe_invoice_id'
        const whereVal = metaId || stripeInv.id
        const { data: existing } = await admin
          .from('invoices')
          .select('notes')
          .eq(whereCol, whereVal)
          .maybeSingle()
        const priorNotes = (existing?.notes || '').trim()
        const combinedNotes = priorNotes
          ? `${priorNotes}\n\n${new Date().toISOString()}: ${failureNote}`
          : failureNote
        const patch = {
          status: 'overdue' as const,
          updated_at: new Date().toISOString(),
          notes: combinedNotes,
        }
        const q = admin.from('invoices').update(patch)
        const res = await (metaId ? q.eq('id', metaId) : q.eq('stripe_invoice_id', stripeInv.id)).select('id')
        must(res, 'invoices update (payment_failed)')
        if (!res.data || res.data.length === 0) {
          console.warn(
            `[invoice.payment_failed] no matching invoice row. metadata.laviolette_invoice_id=${metaId}, stripe_invoice_id=${stripeInv.id}`
          )
        }
        break
      }
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.mode === 'setup' && session.customer) {
          const customerId = typeof session.customer === 'string' ? session.customer : session.customer.id

          // Flip our DB flag + fetch client name for the notification
          const res = await admin
            .from('clients')
            .update({
              bank_info_on_file: true,
              updated_at: new Date().toISOString(),
            })
            .eq('stripe_customer_id', customerId)
            .select('id, legal_name, name')
          must(res, 'clients update (checkout.session.completed)')
          if (!res.data || res.data.length === 0) {
            console.warn(
              `[checkout.session.completed] no matching client row for stripe_customer_id=${customerId}`
            )
          }
          const clientRow = res.data?.[0] as { legal_name?: string | null; name?: string | null } | undefined

          // Also set the attached bank as the customer's default PM (so future invoices auto-charge).
          // This MUST succeed or the client can't be auto-charged — flag Case loudly if it fails.
          const pmOk = await ensureDefaultPaymentMethod(
            customerId,
            clientRow?.legal_name || clientRow?.name || customerId,
            'checkout.session.completed',
          )
          if (!pmOk) {
            // Fall through — the bank_info_on_file flag is already set; the default-PM
            // missing notification was sent inside ensureDefaultPaymentMethod. Don't
            // also send the generic bank_linked email (would be confusing).
            break
          }

          // Internal notification to Case
          const caseNotif = buildInternalNotification({
            kind: 'bank_linked',
            clientName: clientRow?.legal_name || clientRow?.name || customerId,
            stripeCustomerId: customerId,
            appUrl: APP_URL,
          })
          await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:bank-linked:${customerId}`)
        }
        break
      }
      case 'setup_intent.succeeded': {
        const si = event.data.object as Stripe.SetupIntent
        if (si.customer) {
          const customerId = typeof si.customer === 'string' ? si.customer : si.customer.id
          const res = await admin
            .from('clients')
            .update({
              bank_info_on_file: true,
              updated_at: new Date().toISOString(),
            })
            .eq('stripe_customer_id', customerId)
            .select('id, legal_name, name')
          must(res, 'clients update (setup_intent.succeeded)')
          if (!res.data || res.data.length === 0) {
            console.warn(`[setup_intent.succeeded] no matching client row for ${customerId}`)
            break
          }
          const clientRow = res.data[0] as { legal_name?: string | null; name?: string | null }
          // Also ensure default PM is set (double-safety if checkout.session.completed
          // didn't arrive or didn't have the bank attached yet).
          await ensureDefaultPaymentMethod(
            customerId,
            clientRow.legal_name || clientRow.name || customerId,
            'setup_intent.succeeded',
          )
        }
        break
      }
      case 'setup_intent.setup_failed': {
        const si = event.data.object as Stripe.SetupIntent
        const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id || 'unknown'
        const lastErr = si.last_setup_error
        console.error('[setup_intent.setup_failed]', JSON.stringify({
          customer: customerId,
          setup_intent: si.id,
          error_code: lastErr?.code,
          error_type: lastErr?.type,
          error_message: lastErr?.message,
          decline_code: lastErr?.decline_code,
          payment_method: lastErr?.payment_method?.id,
        }))

        // Internal notification to Case
        let clientName: string | null = null
        if (customerId !== 'unknown') {
          const { data: cli } = await admin
            .from('clients')
            .select('legal_name, name')
            .eq('stripe_customer_id', customerId)
            .maybeSingle()
          clientName = cli?.legal_name || cli?.name || null
        }
        const caseNotif = buildInternalNotification({
          kind: 'setup_failed',
          clientName,
          stripeCustomerId: customerId,
          reason: lastErr?.message || null,
          appUrl: APP_URL,
        })
        await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:setup-failed:${customerId}`)
        break
      }
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || 'unknown'
        console.warn('[checkout.session.expired]', JSON.stringify({
          session_id: session.id,
          mode: session.mode,
          customer: customerId,
          created: new Date(session.created * 1000).toISOString(),
          expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
        }))
        // Only alert Case for setup-mode sessions (bank-link abandonment) — payment-mode
        // expirations aren't used in this app's flow.
        if (session.mode === 'setup' && customerId !== 'unknown') {
          let clientName: string | null = null
          const { data: cli } = await admin
            .from('clients')
            .select('legal_name, name')
            .eq('stripe_customer_id', customerId)
            .maybeSingle()
          clientName = cli?.legal_name || cli?.name || null
          const caseNotif = buildInternalNotification({
            kind: 'checkout_abandoned',
            clientName,
            stripeCustomerId: customerId,
            appUrl: APP_URL,
          })
          await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:abandoned:${session.id}`)
        }
        break
      }
      case 'mandate.updated': {
        // ACH mandate status changed. If inactive/revoked, the client revoked
        // authorization. Flip our DB flag and alert Case so he can follow up.
        const mandate = event.data.object as Stripe.Mandate
        const customerId = typeof (mandate.customer_acceptance as unknown) === 'string'
          ? (mandate.customer_acceptance as unknown as string)
          : null
        // Mandate → PM → customer. Get the PM, then find our client by customer.
        const pmId = typeof mandate.payment_method === 'string'
          ? mandate.payment_method
          : (mandate.payment_method as Stripe.PaymentMethod | null)?.id
        if (!pmId) {
          console.log(`[mandate.updated] no payment_method on ${mandate.id}, skipping`)
          break
        }
        // Only act on mandates that are no longer active (revoked, inactive).
        const isInactive = mandate.status === 'inactive' || mandate.status === 'pending'
        if (!isInactive) {
          console.log(`[mandate.updated] status=${mandate.status}, no action needed`)
          break
        }
        // Look up the PM to find its customer
        let pmCustomerId: string | null = null
        try {
          const pm = await stripe.paymentMethods.retrieve(pmId)
          pmCustomerId = typeof pm.customer === 'string' ? pm.customer : pm.customer?.id || null
        } catch (e) {
          console.error(`[mandate.updated] failed to retrieve PM ${pmId}: ${(e as Error).message}`)
          break
        }
        if (!pmCustomerId) {
          console.log(`[mandate.updated] PM ${pmId} has no customer, skipping`)
          break
        }
        const { data: cli } = await admin
          .from('clients')
          .select('id, legal_name, name')
          .eq('stripe_customer_id', pmCustomerId)
          .maybeSingle()
        if (!cli) {
          console.warn(`[mandate.updated] no client for stripe_customer_id=${pmCustomerId}`)
          break
        }
        // Flip bank_info_on_file=false so auto-push skips this client until they reconnect
        await admin
          .from('clients')
          .update({ bank_info_on_file: false, updated_at: new Date().toISOString() })
          .eq('id', cli.id)
        const caseNotif = buildInternalNotification({
          kind: 'bank_disconnected',
          clientName: cli.legal_name || cli.name || pmCustomerId,
          stripeCustomerId: pmCustomerId,
          reason: `Mandate status: ${mandate.status} (client revoked ACH authorization or bank changed state)`,
          appUrl: APP_URL,
        })
        await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:mandate-inactive:${mandate.id}`)
        break
      }
      case 'payment_method.detached': {
        // A payment method was removed from a customer (via Stripe Dashboard, API,
        // or the client's own bank disconnecting). If it was the customer's
        // default PM for us_bank_account, their auto-push will fail next run.
        const pm = event.data.object as Stripe.PaymentMethod
        if (pm.type !== 'us_bank_account') {
          console.log(`[payment_method.detached] type=${pm.type}, not ACH, skipping`)
          break
        }
        // PaymentMethod.detached means pm.customer is null now. We need to find
        // which customer it USED to belong to. The event includes
        // previous_attributes.customer in the raw event data.
        const prev = (event.data as unknown as { previous_attributes?: { customer?: string } }).previous_attributes
        const prevCustomerId = prev?.customer
        if (!prevCustomerId) {
          console.log(`[payment_method.detached] no previous customer on ${pm.id}, skipping`)
          break
        }
        const { data: cli } = await admin
          .from('clients')
          .select('id, legal_name, name')
          .eq('stripe_customer_id', prevCustomerId)
          .maybeSingle()
        if (!cli) {
          console.warn(`[payment_method.detached] no client for stripe_customer_id=${prevCustomerId}`)
          break
        }
        // Check if the customer still has ANOTHER us_bank_account PM attached.
        // If yes, update default to that one. If no, flip bank_info_on_file=false.
        const remaining = await stripe.paymentMethods.list({ customer: prevCustomerId, type: 'us_bank_account' })
        if (remaining.data && remaining.data.length > 0) {
          const sorted = [...remaining.data].sort((a, b) => (b.created || 0) - (a.created || 0))
          await stripe.customers.update(prevCustomerId, {
            invoice_settings: { default_payment_method: sorted[0].id },
          })
          console.log(`[payment_method.detached] fell back to newer PM ${sorted[0].id} on ${prevCustomerId}`)
        } else {
          await admin
            .from('clients')
            .update({ bank_info_on_file: false, updated_at: new Date().toISOString() })
            .eq('id', cli.id)
          const caseNotif = buildInternalNotification({
            kind: 'bank_disconnected',
            clientName: cli.legal_name || cli.name || prevCustomerId,
            stripeCustomerId: prevCustomerId,
            reason: `Bank PM ${pm.id} was detached and no other bank is on file`,
            appUrl: APP_URL,
          })
          await notifyCase(caseNotif.subject, caseNotif.html, `stripe-webhook:notify-case:pm-detached:${pm.id}`)
        }
        break
      }
      default:
        // Log and ignore
        console.log(`[stripe-webhook] ignored event type: ${event.type}`)
        break
    }
    return new Response(JSON.stringify({ received: true, event_id: event.id }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    // Delete the idempotency row so Stripe's retry can re-process this event.
    // If we don't, the retry will be a "duplicate" no-op and we'd miss the event forever.
    await admin.from('stripe_events_processed').delete().eq('event_id', event.id)
    console.error('stripe-webhook handler error:', err)
    return new Response(
      JSON.stringify({ error: String((err as Error).message || err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
