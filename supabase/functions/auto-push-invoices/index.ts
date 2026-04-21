// auto-push-invoices
// Runs daily at 4:05 PM CT. Finds invoices where today is the business-day-before
// their due_date AND the client is ready to charge, then initiates an ACH debit via
// Stripe PaymentIntent (NOT a Stripe Invoice — avoids the 0.5% Billing fee).
//
// Scheduling rule (per Case 2026-04-16):
//   Fire at 4:00 PM CT on the business day before the contractual pay date.
//   Rationale: (1) stays well within Stripe's 8pm CT same-day ACH submission cutoff,
//   (2) customer's bank shows the debit on the contractual pay date, (3) avoids
//   client seeing a pending debit during their typical morning banking check.
//   If pay date falls on a weekend/holiday, fire on the preceding business day and
//   log a warning that the debit will land the next business day AFTER the pay date.
//
// Retries: failures within the run are captured per-invoice (other invoices continue).
// The cron should be scheduled to retry within the afternoon by also running a
// secondary pass at 5:05 PM CT (see cron-schedule.sql).

import Stripe from 'https://esm.sh/stripe@17?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  todayCentral,
  computeFireDate,
} from '../_shared/business-days.ts'
import {
  sendClientEmail,
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
const SECRET = env('REMINDERS_SECRET')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const CASE_NOTIFY_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'
const APP_URL = Deno.env.get('APP_URL') || 'https://app.laviolette.io'

async function notifyCase(subject: string, html: string, context: string): Promise<void> {
  const from = `Laviolette HQ <${BRAND_FROM_EMAIL}>`
  const res = await sendClientEmail({
    apiKey: RESEND_API_KEY, from, to: CASE_NOTIFY_EMAIL, subject, html, context,
  })
  if (!res.ok) {
    console.error(`[${context}] notifyCase failed: ${res.error}`)
    try {
      await admin.from('notification_failures').insert({
        kind: 'internal', context, subject, to_email: CASE_NOTIFY_EMAIL, error: res.error,
        payload: { from, html },
      })
    } catch (e) {
      console.error(`[${context}] failed to persist: ${(e as Error).message}`)
    }
  }
}

const stripe = new Stripe(STRIPE_SECRET_KEY)
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

type InvoiceRow = {
  id: string
  invoice_number: string
  total: number | string
  due_date: string
  description?: string
  stripe_payment_intent_id?: string | null
  status: string
  client_id: string
  clients?: {
    id: string
    legal_name?: string
    name?: string
    stripe_customer_id?: string
    bank_info_on_file?: boolean
    billing_email?: string | null
  }
  brands?: {
    name?: string | null
  } | null
}

async function chargeOne(inv: InvoiceRow, customerId: string, defaultPM: string) {
  const amountCents = Math.round((parseFloat(String(inv.total)) || 0) * 100)
  if (amountCents <= 0) throw new Error(`non-positive amount on ${inv.invoice_number}`)

  // ATOMIC CLAIM: before calling Stripe, write a sentinel marker to
  // stripe_payment_intent_id using a conditional UPDATE. Postgres row-level
  // locking guarantees that only one process can succeed — a concurrent cron
  // run or "Charge via ACH" click will see 0 rows returned and abort. This
  // prevents the race where two processes each create a PI for the same invoice.
  const claimToken = `CLAIMING:${crypto.randomUUID()}`
  const { data: claimed, error: claimErr } = await admin
    .from('invoices')
    .update({ stripe_payment_intent_id: claimToken, updated_at: new Date().toISOString() })
    .eq('id', inv.id)
    .is('stripe_payment_intent_id', null)
    .is('stripe_invoice_id', null)
    .select('id')
    .maybeSingle()
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`)
  if (!claimed) {
    throw new Error('race: another process claimed this invoice')
  }

  const descSuffix = (inv.invoice_number || 'INVOICE').slice(0, 22)
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
        auto_pushed: 'true',
        fire_date: todayCentral(),
      },
    })
  } catch (e) {
    // Stripe call failed — release the claim so the next run can retry.
    const { error: relErr } = await admin
      .from('invoices')
      .update({ stripe_payment_intent_id: null })
      .eq('id', inv.id)
      .eq('stripe_payment_intent_id', claimToken)
    if (relErr) {
      console.error(
        `[auto-push-invoices] CRITICAL: Stripe failed AND claim release failed for invoice ${inv.id}. Manual intervention required. err=${relErr.message}`
      )
    }
    throw e
  }

  // Replace the sentinel with the real PI ID. The predicate guards against
  // accidentally overwriting a webhook-written value in the rare race where
  // a very fast webhook for pi.id somehow arrives before this write.
  const { data: updated, error: updErr } = await admin
    .from('invoices')
    .update({
      stripe_payment_intent_id: pi.id,
      status: 'pending',
      sent_date: new Date().toISOString().slice(0, 10),
      updated_at: new Date().toISOString(),
    })
    .eq('id', inv.id)
    .eq('stripe_payment_intent_id', claimToken)
    .select('id')
  if (updErr) {
    // DB error on the replace-sentinel step. Check if the webhook already
    // wrote the real PI ID (common in the race window) — if so, we're fine.
    const { data: current } = await admin
      .from('invoices')
      .select('stripe_payment_intent_id')
      .eq('id', inv.id)
      .maybeSingle()
    if (current?.stripe_payment_intent_id === pi.id) {
      console.warn(
        `[auto-push-invoices] DB update errored but webhook already wrote PI ${pi.id} for invoice ${inv.id}. Treating as success.`
      )
      return pi
    }
    console.error(
      `[auto-push-invoices] ORPHAN RISK: PI ${pi.id} created for invoice ${inv.id} but DB update failed: ${updErr.message}. Current stripe_payment_intent_id=${current?.stripe_payment_intent_id || 'unknown'}`
    )
    throw new Error(`DB update failed after PI create: ${updErr.message}`)
  }
  if (!updated || updated.length === 0) {
    // Predicate didn't match — the sentinel was overwritten between our claim
    // and this update. The only thing that could have done it is the webhook
    // for this exact PI. Verify and recover.
    const { data: current } = await admin
      .from('invoices')
      .select('stripe_payment_intent_id')
      .eq('id', inv.id)
      .maybeSingle()
    if (current?.stripe_payment_intent_id === pi.id) {
      console.warn(
        `[auto-push-invoices] Sentinel was replaced by webhook before our update ran. PI ${pi.id} for invoice ${inv.id} correctly recorded. Treating as success.`
      )
      return pi
    }
    console.error(
      `[auto-push-invoices] ORPHAN RISK: sentinel gone but current stripe_payment_intent_id=${current?.stripe_payment_intent_id || 'null'} ≠ ${pi.id}. Manual reconciliation required.`
    )
    throw new Error(`Orphan: sentinel vanished before we could replace it`)
  }

  return pi
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (SECRET && url.searchParams.get('key') !== SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  const today = todayCentral()

  // Load all not-yet-charged invoices with a client that has bank on file.
  // CRITICAL: both stripe_payment_intent_id AND stripe_invoice_id must be null.
  // Otherwise we'd double-charge invoices that were pushed via the legacy Stripe Invoice
  // flow (pre-2026-04-16). Once everything moves to PaymentIntents this check is still
  // correct — a row with either ID set has already been pushed.
  const { data: candidates, error } = await admin
    .from('invoices')
    .select(
      'id, invoice_number, total, due_date, description, stripe_payment_intent_id, stripe_invoice_id, status, client_id, brand_id, ' +
      'clients!inner(id, legal_name, name, stripe_customer_id, bank_info_on_file, billing_email), ' +
      'brands(name)'
    )
    .in('status', ['draft', 'pending'])
    .is('stripe_payment_intent_id', null)
    .is('stripe_invoice_id', null)
    .eq('clients.bank_info_on_file', true)
    .not('clients.stripe_customer_id', 'is', null)

  if (error) {
    console.error('auto-push-invoices: load failed:', error.message)
    return new Response(JSON.stringify({ ok: false, error: 'load failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!candidates || candidates.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, date: today, pushed: [], skipped: [], reason: 'no eligible invoices' }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }

  const pushed: Array<Record<string, unknown>> = []
  const skipped: Array<{ invoice_number: string; reason: string }> = []
  const errors: Array<{ invoice_number: string; error: string }> = []
  const warnings: Array<{ invoice_number: string; warning: string }> = []

  for (const inv of candidates as InvoiceRow[]) {
    const invNum = inv.invoice_number
    let fireInfo: ReturnType<typeof computeFireDate>
    try {
      fireInfo = computeFireDate(inv.due_date)
    } catch (e) {
      errors.push({ invoice_number: invNum, error: `fire-date calc failed: ${(e as Error).message}` })
      continue
    }

    // Fire if today is AT or AFTER the fire date. Handles late-submit scenarios:
    // e.g. client submits bank info on pay date morning — an invoice due May 1 with
    // fire_date=April 30 should still fire on May 1 (1 day late) rather than never.
    if (fireInfo.fireDate > today) {
      skipped.push({
        invoice_number: invNum,
        reason: `too early to fire (due=${inv.due_date}, fire=${fireInfo.fireDate}, today=${today})`,
      })
      continue
    }
    const isLate = fireInfo.fireDate < today
    if (isLate) {
      warnings.push({
        invoice_number: invNum,
        warning: `Firing late: fire_date was ${fireInfo.fireDate}, today is ${today}. ACH will land later than contractual pay date.`,
      })
    }

    if (!fireInfo.dueIsBusinessDay) {
      warnings.push({
        invoice_number: invNum,
        warning: `Due date ${inv.due_date} is a weekend/holiday. ACH will land ${fireInfo.actualLandDate}, not on the contractual pay date.`,
      })
    }

    const customerId = inv.clients?.stripe_customer_id
    if (!customerId) {
      skipped.push({ invoice_number: invNum, reason: 'no stripe_customer_id' })
      continue
    }

    // Need the customer's default PM — fetch from Stripe (source of truth, may be stale in our DB)
    let defaultPM: string | undefined
    try {
      const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer
      defaultPM = customer.invoice_settings?.default_payment_method as string | undefined
    } catch (e) {
      errors.push({ invoice_number: invNum, error: `customer retrieve failed: ${(e as Error).message}` })
      continue
    }
    if (!defaultPM) {
      skipped.push({ invoice_number: invNum, reason: 'customer has no default payment method (bank not set up via webhook)' })
      continue
    }

    try {
      const pi = await chargeOne(inv, customerId, defaultPM)
      pushed.push({
        invoice_number: invNum,
        payment_intent: pi.id,
        amount: (pi.amount || 0) / 100,
        status: pi.status,
        due_date: inv.due_date,
        fire_date: fireInfo.fireDate,
        expected_land_date: fireInfo.actualLandDate,
        due_is_business_day: fireInfo.dueIsBusinessDay,
      })
      // Charge fires silently. The client already received the invoice document
      // at contract-sign via send-invoice; an additional "charge starting" email
      // reads as a duplicate bill. They'll get the paid receipt on settlement
      // via the payment_intent.succeeded webhook.
    } catch (e) {
      errors.push({ invoice_number: invNum, error: (e as Error).message })
    }
  }

  // BLOCKED CHECK: separate query for invoices that SHOULD fire today but can't
  // (client has no bank on file yet). This is the "Dustin only linked 1 of 2 banks"
  // scenario — critical to catch before May 1. Alert Case via HQ email.
  const { data: blockedCandidates } = await admin
    .from('invoices')
    .select(
      'invoice_number, total, due_date, ' +
      'clients!inner(legal_name, name, bank_info_on_file, stripe_customer_id)'
    )
    .in('status', ['draft', 'pending'])
    .is('stripe_payment_intent_id', null)
    .is('stripe_invoice_id', null)
    .lte('due_date', today + 'T23:59:59') // due today or earlier
    .eq('clients.bank_info_on_file', false)
  const blocked: Array<{ invoice_number: string; client_name: string; amount: number | string; reason: string }> = []
  for (const b of (blockedCandidates || []) as Array<{
    invoice_number: string; total: number | string; due_date: string;
    clients?: { legal_name?: string; name?: string; stripe_customer_id?: string | null }
  }>) {
    let fireDate: string
    try {
      fireDate = computeFireDate(b.due_date).fireDate
    } catch {
      continue
    }
    if (fireDate > today) continue // not eligible yet
    const reason = b.clients?.stripe_customer_id
      ? 'bank not linked yet'
      : 'no Stripe customer — add customer first'
    blocked.push({
      invoice_number: b.invoice_number,
      client_name: b.clients?.legal_name || b.clients?.name || 'Unknown',
      amount: b.total,
      reason,
    })
  }
  if (blocked.length > 0) {
    const caseNotif = buildInternalNotification({
      kind: 'auto_push_blocked', date: today, blocked, appUrl: APP_URL,
    })
    await notifyCase(caseNotif.subject, caseNotif.html, `auto-push:blocked:${today}`)
  }

  // ERRORS SUMMARY: if any invoices errored during the fire loop, send Case one alert
  // so he sees them in his inbox without having to read the JSON response.
  if (errors.length > 0) {
    const caseNotif = buildInternalNotification({
      kind: 'auto_push_errors', date: today, errors, appUrl: APP_URL,
    })
    await notifyCase(caseNotif.subject, caseNotif.html, `auto-push:errors:${today}`)
  }

  const allOk = errors.length === 0
  return new Response(
    JSON.stringify({
      ok: allOk,
      date: today,
      pushed,
      skipped,
      warnings,
      errors,
      blocked,
    }),
    {
      status: allOk ? 200 : 207,
      headers: { 'Content-Type': 'application/json' },
    }
  )
})
