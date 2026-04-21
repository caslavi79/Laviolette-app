// fire-day-reminder
// Daily 9 AM CT cron (Mon-Fri). Emails Case a heads-up with:
//   - invoices whose computeFireDate(due_date) == today and are ready to charge
//     (each row has a "Fire now" deep-link to /money?tab=invoices&highlight=<id>)
//   - invoices that SHOULD fire today but are blocked (client has no bank on file,
//     or no Stripe customer) so Case can follow up before the auto-push cutoff
//
// Design rationale: Case wanted a human-in-the-loop pattern without losing the
// auto-push safety net. This function is the morning heads-up. He can click
// "Fire now" to manually charge any invoice, OR do nothing and let auto-push
// run at 4:05 PM CT. Any invoice he already manually fires has a
// stripe_payment_intent_id set, so auto-push skips it (the claim predicate
// requires NULL). Both paths converge to the same webhook + receipt flow.
//
// Silent on quiet days: if no eligible or blocked invoices match, the function
// returns 200 without sending an email. Cron runs every weekday but only emails
// when there's something actionable — preventing fatigue / inbox noise.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  sendClientEmail,
  buildInternalNotification,
} from '../_shared/client-emails.ts'
import {
  todayCentral,
  computeFireDate,
} from '../_shared/business-days.ts'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const SECRET = env('REMINDERS_SECRET')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const CASE_NOTIFY_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'
const APP_URL = Deno.env.get('APP_URL') || 'https://app.laviolette.io'

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (SECRET && url.searchParams.get('key') !== SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  const today = todayCentral()

  // Load ALL candidate draft/pending invoices that haven't been charged, with
  // enough joined info to render the email + build the deep-links. The query
  // intentionally doesn't filter on bank_info_on_file — we want BOTH the
  // eligible AND the blocked ones so Case sees the whole picture.
  const { data: candidates, error } = await admin
    .from('invoices')
    .select(
      'id, invoice_number, total, due_date, ' +
      'clients(legal_name, name, stripe_customer_id, bank_info_on_file), ' +
      'brands(name)'
    )
    .in('status', ['draft', 'pending'])
    .is('stripe_payment_intent_id', null)
    .is('stripe_invoice_id', null)

  if (error) {
    console.error('fire-day-reminder: load failed:', error.message)
    return new Response(JSON.stringify({ ok: false, error: 'load failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }

  type CandidateRow = {
    id: string
    invoice_number: string
    total: number | string
    due_date: string
    clients?: { legal_name?: string; name?: string; stripe_customer_id?: string | null; bank_info_on_file?: boolean } | null
    brands?: { name?: string | null } | null
  }

  const eligible: Array<{ invoice_id: string; invoice_number: string; client_name: string; brand_name: string; amount: number | string; due_date: string }> = []
  const blocked: Array<{ invoice_number: string; client_name: string; amount: number | string; reason: string }> = []

  for (const inv of (candidates || []) as CandidateRow[]) {
    let fireDate: string
    try {
      fireDate = computeFireDate(inv.due_date).fireDate
    } catch {
      continue
    }
    // Only care about invoices whose fire date is TODAY. An invoice due May 3
    // won't fire for days — skip so we don't spam Case with "here's what's
    // happening next week".
    if (fireDate !== today) continue

    const clientName = inv.clients?.legal_name || inv.clients?.name || 'Unknown client'
    const brandName = inv.brands?.name || inv.clients?.legal_name || inv.clients?.name || 'your account'
    const hasCustomer = !!inv.clients?.stripe_customer_id
    const hasBank = !!inv.clients?.bank_info_on_file

    if (hasCustomer && hasBank) {
      eligible.push({
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        client_name: clientName,
        brand_name: brandName,
        amount: inv.total,
        due_date: inv.due_date,
      })
    } else {
      blocked.push({
        invoice_number: inv.invoice_number,
        client_name: clientName,
        amount: inv.total,
        reason: !hasCustomer ? 'no Stripe customer — add customer first' : 'no bank on file — send setup link',
      })
    }
  }

  // Quiet-day behavior: no email if nothing actionable. The cron still ran
  // (visible in cron.job_run_details / /health) so Case has observability.
  if (eligible.length === 0 && blocked.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, date: today, eligible: 0, blocked: 0, reason: 'no fires today — silent' }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }

  const { subject, html } = buildInternalNotification({
    kind: 'fire_day_reminder',
    date: today,
    eligible,
    blocked,
    appUrl: APP_URL,
  })

  const from = `Laviolette HQ <${BRAND_FROM_EMAIL}>`
  const emailRes = await sendClientEmail({
    apiKey: RESEND_API_KEY,
    from,
    to: CASE_NOTIFY_EMAIL,
    subject,
    html,
    context: `fire-day-reminder:${today}`,
  })
  if (!emailRes.ok) {
    console.error(`[fire-day-reminder] email failed: ${emailRes.error}`)
    try {
      await admin.from('notification_failures').insert({
        kind: 'internal',
        context: `fire-day-reminder:${today}`,
        subject,
        to_email: CASE_NOTIFY_EMAIL,
        error: emailRes.error,
        payload: { from, html },
      })
    } catch (e) {
      console.error(`[fire-day-reminder] failed to persist: ${(e as Error).message}`)
    }
  }

  return new Response(
    JSON.stringify({
      ok: emailRes.ok,
      date: today,
      eligible: eligible.length,
      blocked: blocked.length,
      email_sent: emailRes.ok,
      resend_id: emailRes.ok ? emailRes.id : null,
    }),
    { status: emailRes.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } }
  )
})
