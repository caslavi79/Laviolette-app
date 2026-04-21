// run-pipeline-test
//
// One-shot validation: fires a $1 off-session ACH PaymentIntent against each
// client with bank_info_on_file=true, then emails Case a per-PM summary.
//
// "Initiated successfully" here means Stripe accepted the PI and returned
// status='processing' (ACH submitted to network). Settlement still takes
// 1-3 business days; this only proves the pipeline is wired correctly.
//
// Test PIs are tagged with metadata.test=pipeline_validation so they're
// easy to find + refund from the Stripe Dashboard. They are NOT tied to
// any invoice row (no metadata.laviolette_invoice_id), so the standard
// payment_intent.succeeded webhook will be a no-op for these (the handler
// requires laviolette_invoice_id to flip an invoice).
//
// Auth: ?key=<REMINDERS_SECRET> in URL (same pattern as other cron-invoked
// endpoints). Idempotency is NOT enforced — run twice, fire twice. Don't
// schedule it more than once.

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
const RESEND_API_KEY = env('RESEND_API_KEY')
const REMINDERS_SECRET = Deno.env.get('REMINDERS_SECRET') || ''
const BRAND_NAME = Deno.env.get('BRAND_NAME') || 'Laviolette LLC'
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const BRAND_REPLY_TO = Deno.env.get('BRAND_REPLY_TO') || 'case.laviolette@gmail.com'
const CASE_NOTIFY_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'

const stripe = new Stripe(STRIPE_SECRET_KEY)

// Brand palette (matches buildInternalNotification dark aesthetic)
const INK_BG = '#12100D'
const INK_TEXT = '#F4F0E8'
const INK_ACCENT = '#B8845A'
const INK_SUCCESS = '#7ab894'
const INK_FAIL = '#d47561'

type PerPmResult = {
  client_name: string
  stripe_customer_id: string
  pm_id: string | null
  bank_label: string | null
  ok: boolean
  pi_id: string | null
  pi_status: string | null
  error: string | null
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function buildSummaryEmail(results: PerPmResult[]): { subject: string; html: string } {
  const successCount = results.filter((r) => r.ok).length
  const failCount = results.length - successCount
  const allOk = failCount === 0
  const subject = allOk
    ? `✅ Pipeline test: ${successCount}/${results.length} initiated cleanly`
    : `⚠ Pipeline test: ${failCount} of ${results.length} FAILED`

  const headlineText = allOk
    ? `Each $1 ACH was accepted by Stripe and is now in 'processing'. The webhook → DB → email pipeline is wired correctly. Refund the $1 charges from the Stripe Dashboard once they settle (1-3 business days).`
    : `${failCount} of ${results.length} test charge${failCount === 1 ? '' : 's'} were rejected. See per-PM detail below — investigate before May 1.`

  const rowsHtml = results
    .map((r) => {
      const statusBadge = r.ok
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${INK_SUCCESS};color:#12100D;font-size:10px;letter-spacing:1px;font-weight:700">INITIATED</span>`
        : `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${INK_FAIL};color:#12100D;font-size:10px;letter-spacing:1px;font-weight:700">FAILED</span>`
      const piLink = r.pi_id
        ? `<a href="https://dashboard.stripe.com/payments/${esc(r.pi_id)}" style="color:${INK_ACCENT};text-decoration:none;font-family:ui-monospace,Menlo,monospace;font-size:11px">${esc(r.pi_id)}</a>`
        : `<span style="color:rgba(244,240,232,0.4);font-size:11px">(none created)</span>`
      const detail = r.ok
        ? `Stripe status: <code style="font-family:ui-monospace,Menlo,monospace;background:rgba(255,255,255,0.05);padding:1px 6px;border-radius:3px">${esc(r.pi_status || '')}</code>`
        : `<span style="color:${INK_FAIL}">${esc(r.error || 'unknown error')}</span>`
      return `
        <tr>
          <td style="padding:14px;border-bottom:1px solid rgba(244,240,232,0.08);color:${INK_TEXT};vertical-align:top">
            <strong>${esc(r.client_name)}</strong><br>
            <span style="color:rgba(244,240,232,0.5);font-size:11px;font-family:ui-monospace,Menlo,monospace">${esc(r.stripe_customer_id)}</span><br>
            ${r.bank_label ? `<span style="color:rgba(244,240,232,0.6);font-size:12px">${esc(r.bank_label)}</span>` : ''}
          </td>
          <td style="padding:14px;border-bottom:1px solid rgba(244,240,232,0.08);text-align:right;vertical-align:top">
            ${statusBadge}<br>
            <div style="margin-top:6px;font-size:12px;color:rgba(244,240,232,0.7);line-height:1.5">${detail}</div>
            <div style="margin-top:6px">${piLink}</div>
          </td>
        </tr>`
    })
    .join('')

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:${INK_TEXT};background:${INK_BG}">
  <p style="margin:0 0 18px;font-size:13px;letter-spacing:2px;color:${INK_ACCENT};text-transform:uppercase">Laviolette HQ · Pipeline Test</p>
  <p style="margin:0 0 14px;font-size:14px;line-height:1.6">${esc(headlineText)}</p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;background:rgba(255,255,255,0.02);border:1px solid rgba(244,240,232,0.1);font-size:13px">
    ${rowsHtml}
  </table>
  <p style="margin:24px 0 0;font-size:12px;color:rgba(244,240,232,0.55);line-height:1.6">
    Test PIs are tagged <code style="font-family:ui-monospace,Menlo,monospace;background:rgba(255,255,255,0.05);padding:1px 6px;border-radius:3px">metadata.test=pipeline_validation</code> in Stripe — search by that to find + refund.
    No invoice rows were touched.
  </p>
</div>`.trim()
  return { subject, html }
}

async function sendEmail(subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${BRAND_NAME} HQ <${BRAND_FROM_EMAIL}>`,
        reply_to: [BRAND_REPLY_TO],
        to: [CASE_NOTIFY_EMAIL],
        subject,
        html,
      }),
    })
    if (!res.ok) {
      return { ok: false, error: `${res.status}: ${await res.text()}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

Deno.serve(async (req: Request) => {
  // ?key= auth
  const url = new URL(req.url)
  const key = url.searchParams.get('key') || ''
  if (REMINDERS_SECRET && key !== REMINDERS_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Pull every client with bank_info_on_file=true and a stripe_customer_id.
  const { data: clients, error: cErr } = await admin
    .from('clients')
    .select('legal_name, name, stripe_customer_id, bank_info_on_file')
    .eq('bank_info_on_file', true)
    .not('stripe_customer_id', 'is', null)
    .order('legal_name')

  if (cErr) {
    const errMsg = `Failed to read clients: ${cErr.message}`
    await sendEmail('⚠ Pipeline test: pre-flight DB read failed', `<pre>${esc(errMsg)}</pre>`)
    return new Response(JSON.stringify({ error: errMsg }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  const results: PerPmResult[] = []

  for (const cl of clients || []) {
    const customerId = cl.stripe_customer_id as string
    const clientName = (cl.legal_name || cl.name || 'unknown') as string
    const result: PerPmResult = {
      client_name: clientName,
      stripe_customer_id: customerId,
      pm_id: null,
      bank_label: null,
      ok: false,
      pi_id: null,
      pi_status: null,
      error: null,
    }

    try {
      const customer = (await stripe.customers.retrieve(customerId)) as Stripe.Customer
      const defaultPM = customer.invoice_settings?.default_payment_method as string | undefined
      if (!defaultPM) {
        result.error = 'No default payment method set on Stripe customer.'
        results.push(result)
        continue
      }
      const pm = await stripe.paymentMethods.retrieve(defaultPM)
      result.pm_id = pm.id
      result.bank_label = pm.us_bank_account
        ? `${pm.us_bank_account.bank_name || 'bank'} ****${pm.us_bank_account.last4 || '?'}`
        : pm.type

      const pi = await stripe.paymentIntents.create({
        customer: customerId,
        payment_method: pm.id,
        amount: 100, // $1.00
        currency: 'usd',
        confirm: true,
        off_session: true,
        payment_method_types: ['us_bank_account'],
        description: 'Laviolette pipeline validation test ($1, refundable)',
        statement_descriptor_suffix: 'PIPELINE TEST',
        metadata: {
          test: 'pipeline_validation',
          fired_at: new Date().toISOString(),
          client_name: clientName,
        },
      })
      result.pi_id = pi.id
      result.pi_status = pi.status
      // ACH off-session typically returns 'processing'. Anything else is a yellow flag.
      result.ok = pi.status === 'processing'
      if (!result.ok) {
        result.error = `Unexpected initial status: ${pi.status}`
      }
    } catch (e) {
      const sErr = e as Stripe.errors.StripeError
      result.error = `${sErr.type || 'Error'}: ${sErr.message || String(e)}${sErr.code ? ` (code: ${sErr.code})` : ''}`
    }

    results.push(result)
  }

  // Build + send the summary email regardless of outcome
  const { subject, html } = buildSummaryEmail(results)
  const emailRes = await sendEmail(subject, html)

  return new Response(
    JSON.stringify({
      ok: true,
      tested: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      email_sent: emailRes.ok,
      email_error: emailRes.error || null,
      results,
    }, null, 2),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
})
