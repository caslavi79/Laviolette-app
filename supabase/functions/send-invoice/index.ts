// send-invoice
//
// Send an invoice document to the client and stamp invoices.sent_date. Called
// automatically by contract-sign after a contract is signed (so the client
// receives their invoice immediately on signing, before any ACH charge fires).
// May also be called manually.
//
// Behavior:
//   - Looks up invoice + client + brand + project
//   - Skips silently if invoice.sent_date is already set (idempotent re-call safe)
//   - Skips silently if client has no billing_email (logs warning)
//   - Builds branded invoice HTML with line items, total, due date, payment method
//   - Sends via Resend to clients.billing_email + BCC Case
//   - UPDATE invoices.sent_date = today on success
//   - Persists to notification_failures on Resend failure (retryable from /notifications)
//
// Auth:
//   - ?key=<REMINDERS_SECRET> in URL (same pattern as cron-invoked endpoints)
//
// Input (JSON body):
//   { "invoice_id": "<uuid>" }
//
// Returns:
//   200 { ok: true, sent_to: "...", invoice_number: "..." }
//   200 { ok: true, skipped: "already_sent" | "no_email" }
//   400/500 { ok: false, error: "..." }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')
const REMINDERS_SECRET = Deno.env.get('REMINDERS_SECRET') || ''
const BRAND_NAME = Deno.env.get('BRAND_NAME') || 'Laviolette LLC'
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const BRAND_REPLY_TO = Deno.env.get('BRAND_REPLY_TO') || 'case.laviolette@gmail.com'
const CASE_NOTIFY_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'

const BRAND_INK = '#12100D'
const BRAND_CREAM = '#F4F0E8'
const BRAND_ACCENT = '#B8845A'

function esc(s: unknown): string {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#039;' }[c]!))
}
function fmtMoney(n: number | string | null | undefined): string {
  if (n == null) return '$0.00'
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (!isFinite(v)) return '$0.00'
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtDate(iso: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('T')[0].split('-').map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

type LineItem = { name: string; qty?: number; rate?: number; amount: number | string }

function buildInvoiceEmail(d: {
  clientName: string
  brandName: string
  invoiceNumber: string
  description: string
  total: number | string
  dueDate: string
  lineItems: LineItem[]
  paymentMethod: string
  bankLinkUrl?: string | null
}): { subject: string; html: string } {
  const subject = `Invoice ${d.invoiceNumber} — ${d.brandName} — ${fmtMoney(d.total)}`

  // Layout note: aggressive Gmail-trim defense — EVERYTHING (header, intro, metadata,
  // items, total, closing, signature) is inside ONE table with no surrounding card,
  // no body background color, and no closing <p> elements. Gmail's "show trimmed
  // content" auto-collapse fires when it detects a signature-like break (cream-bg card
  // + closing paragraphs after the data table). One single table = no seam to fragment on.
  const lineItemsTableRows = d.lineItems.length > 0
    ? d.lineItems.map((li) => `<tr><td style="padding:10px 14px;border-bottom:1px solid rgba(18,16,13,0.06);font-size:13px;color:rgba(18,16,13,0.85)">${esc(li.name)}</td><td style="padding:10px 14px;border-bottom:1px solid rgba(18,16,13,0.06);font-size:13px;color:rgba(18,16,13,0.7);text-align:right;font-variant-numeric:tabular-nums">${fmtMoney(li.amount)}</td></tr>`).join('')
    : `<tr><td colspan="2" style="padding:14px;font-style:italic;color:rgba(18,16,13,0.55);text-align:center;font-size:13px">${esc(d.description)}</td></tr>`

  // Unified-onboarding CTA block. Rendered only when the invoice has a
  // bank_link_url (i.e. was synthesized by the unified flow under
  // ENABLE_UNIFIED_ONBOARDING). Retainer invoices + pre-existing invoices
  // pass bankLinkUrl=null/undefined → this evaluates to empty string → no
  // layout change. Stays inside the single <table> to preserve the Gmail-
  // trim defense.
  const ctaBlock = d.bankLinkUrl
    ? `<tr><td colspan="2" style="padding:24px 20px 4px;background:rgba(184,132,90,0.04);border-top:1px solid rgba(18,16,13,0.08)"><div style="font-family:'Barlow Condensed',Arial,sans-serif;font-size:11px;letter-spacing:2px;color:${BRAND_ACCENT};text-transform:uppercase;margin-bottom:4px">Action required</div><div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:400;color:${BRAND_INK};line-height:1.2">Link your bank to pay</div></td></tr><tr><td colspan="2" style="padding:10px 20px 16px;background:rgba(184,132,90,0.04);font-size:14px;line-height:1.55;color:${BRAND_INK}">Click the button below to securely link your bank account via Stripe. Once linked, payment will be initiated on <strong>${esc(fmtDate(d.dueDate))}</strong>. Takes about 60 seconds.</td></tr><tr><td colspan="2" style="padding:0 20px 20px;background:rgba(184,132,90,0.04);text-align:center"><a href="${esc(d.bankLinkUrl)}" style="display:inline-block;padding:12px 32px;background:${BRAND_ACCENT};color:#12100D;text-decoration:none;border-radius:4px;font-family:'Barlow Condensed',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase">Link your bank</a></td></tr><tr><td colspan="2" style="padding:0 20px 20px;background:rgba(184,132,90,0.04);font-size:11px;color:rgba(18,16,13,0.55);line-height:1.55;text-align:center">This link is valid for 24 hours. If it expires, reply to this email and we'll send a fresh one.</td></tr>`
    : ''

  const html = `<table role="presentation" style="width:100%;max-width:580px;margin:0 auto;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;color:${BRAND_INK};background:#fff;border:1px solid rgba(18,16,13,0.12)"><tr><td style="padding:24px 20px 8px"><div style="font-family:'Barlow Condensed',Arial,sans-serif;font-size:11px;letter-spacing:2px;color:${BRAND_ACCENT};text-transform:uppercase;margin-bottom:4px">Invoice</div><div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:400;color:${BRAND_INK};line-height:1.15">${esc(d.invoiceNumber)}</div></td><td style="padding:24px 20px 8px;text-align:right;vertical-align:bottom"><div style="font-family:'Barlow Condensed',Arial,sans-serif;font-size:11px;letter-spacing:1.5px;color:rgba(18,16,13,0.5);text-transform:uppercase;margin-bottom:2px">Total Due</div><div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;color:${BRAND_INK};font-variant-numeric:tabular-nums">${fmtMoney(d.total)}</div></td></tr><tr><td colspan="2" style="padding:8px 20px 0;font-size:14px;line-height:1.55;color:${BRAND_INK}">Hi ${esc(d.clientName)},</td></tr><tr><td colspan="2" style="padding:10px 20px 18px;font-size:14px;line-height:1.55;color:${BRAND_INK}">Thanks for signing. Here's your invoice for the engagement. The full amount will be debited via ACH from the bank account you linked. If you haven't yet linked your bank, please do that now. If you have, you don't need to do anything else.</td></tr><tr><td style="padding:8px 20px;color:rgba(18,16,13,0.55);font-size:12px;background:rgba(184,132,90,0.04);border-top:1px solid rgba(18,16,13,0.08);width:40%">Invoice number</td><td style="padding:8px 20px;color:${BRAND_INK};font-family:ui-monospace,Menlo,monospace;font-size:12px;background:rgba(184,132,90,0.04);border-top:1px solid rgba(18,16,13,0.08)">${esc(d.invoiceNumber)}</td></tr><tr><td style="padding:8px 20px;color:rgba(18,16,13,0.55);font-size:12px;background:rgba(184,132,90,0.04)">Brand</td><td style="padding:8px 20px;color:${BRAND_INK};font-size:12px;background:rgba(184,132,90,0.04)">${esc(d.brandName)}</td></tr><tr><td style="padding:8px 20px;color:rgba(18,16,13,0.55);font-size:12px;background:rgba(184,132,90,0.04)">Due date</td><td style="padding:8px 20px;color:${BRAND_INK};font-size:12px;background:rgba(184,132,90,0.04)">${esc(fmtDate(d.dueDate))}</td></tr><tr><td style="padding:8px 20px;color:rgba(18,16,13,0.55);font-size:12px;background:rgba(184,132,90,0.04);border-bottom:1px solid rgba(18,16,13,0.08)">Payment method</td><td style="padding:8px 20px;color:${BRAND_INK};font-size:12px;background:rgba(184,132,90,0.04);border-bottom:1px solid rgba(18,16,13,0.08)">${esc(d.paymentMethod)}</td></tr><tr><td style="padding:14px 20px 8px;font-family:'Barlow Condensed',Arial,sans-serif;font-size:11px;letter-spacing:1.5px;color:rgba(18,16,13,0.55);text-transform:uppercase">Item</td><td style="padding:14px 20px 8px;text-align:right;font-family:'Barlow Condensed',Arial,sans-serif;font-size:11px;letter-spacing:1.5px;color:rgba(18,16,13,0.55);text-transform:uppercase">Amount</td></tr>${lineItemsTableRows}<tr><td style="padding:14px 20px;font-weight:600;border-top:2px solid ${BRAND_INK};color:${BRAND_INK};font-size:14px">Total Due</td><td style="padding:14px 20px;text-align:right;font-weight:700;font-size:16px;border-top:2px solid ${BRAND_INK};color:${BRAND_INK};font-variant-numeric:tabular-nums">${fmtMoney(d.total)}</td></tr>${ctaBlock}<tr><td colspan="2" style="padding:14px 20px 6px;font-size:12px;color:rgba(18,16,13,0.65);line-height:1.55">A receipt will follow once the ACH clears (typically 3 to 5 business days). Questions? Reply to this email.</td></tr><tr><td colspan="2" style="padding:6px 20px 20px;font-size:11px;color:rgba(18,16,13,0.5);line-height:1.55"><strong style="color:${BRAND_ACCENT};font-weight:600">Case Laviolette</strong> &middot; Laviolette LLC &middot; 4201 Sun Spirit Dr, Austin, TX 78735 &middot; EIN 99-1461687</td></tr></table>`

  return { subject, html }
}

function paymentMethodLabel(enumValue: string | null | undefined): string {
  switch ((enumValue || '').toLowerCase()) {
    case 'stripe_ach': return 'Automatic ACH bank debit'
    case 'zelle': return 'Zelle'
    case 'check': return 'Check'
    case 'cash': return 'Cash'
    default: return 'Bank ACH debit'
  }
}

Deno.serve(async (req: Request) => {
  // Auth via ?key=
  const url = new URL(req.url)
  const key = url.searchParams.get('key') || ''
  if (REMINDERS_SECRET && key !== REMINDERS_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'POST only' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    })
  }

  let body: { invoice_id?: string; force?: boolean } = {}
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!body.invoice_id) {
    return new Response(JSON.stringify({ ok: false, error: 'invoice_id required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }
  // `force` bypasses the idempotency guard so regenerate-bank-link can re-send
  // the invoice email with a fresh bank_link_url. sent_date still gets re-stamped
  // to today at the end of the send, reflecting the latest send attempt.
  const force = body.force === true

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Fetch invoice + related
  const { data: inv, error: invErr } = await admin
    .from('invoices')
    .select('*, clients(id, name, legal_name, billing_email, payment_method), brands(name)')
    .eq('id', body.invoice_id)
    .single()

  if (invErr || !inv) {
    return new Response(JSON.stringify({ ok: false, error: `Invoice not found: ${invErr?.message || 'no row'}` }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Idempotency: skip if already sent. `force` bypasses this so
  // regenerate-bank-link can re-send after minting a fresh bank_link_url.
  if (inv.sent_date && !force) {
    return new Response(JSON.stringify({ ok: true, skipped: 'already_sent', sent_date: inv.sent_date, invoice_number: inv.invoice_number }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }

  const toEmail: string | null = inv.clients?.billing_email
  if (!toEmail) {
    console.warn(`[send-invoice] invoice ${inv.invoice_number} has no billing_email on client; skipping`)
    return new Response(JSON.stringify({ ok: true, skipped: 'no_email', invoice_number: inv.invoice_number }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }

  const lineItems: LineItem[] = Array.isArray(inv.line_items)
    ? inv.line_items as LineItem[]
    : []
  const clientName = inv.clients?.legal_name || inv.clients?.name || 'there'
  const brandName = (inv.brands as { name?: string } | undefined)?.name || clientName
  const paymentLabel = paymentMethodLabel(inv.payment_method || inv.clients?.payment_method)

  const { subject, html } = buildInvoiceEmail({
    clientName,
    brandName,
    invoiceNumber: inv.invoice_number || '(no number)',
    description: inv.description || 'Engagement services',
    total: inv.total,
    dueDate: inv.due_date,
    lineItems,
    paymentMethod: paymentLabel,
    bankLinkUrl: inv.bank_link_url,
  })

  // Send via Resend
  let sendOk = false
  let sendErr: string | null = null
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`,
        to: [toEmail],
        bcc: [CASE_NOTIFY_EMAIL],
        reply_to: [BRAND_REPLY_TO],
        subject,
        html,
      }),
    })
    if (!res.ok) {
      sendErr = `${res.status}: ${(await res.text()).slice(0, 500)}`
    } else {
      sendOk = true
    }
  } catch (e) {
    sendErr = (e as Error).message
  }

  if (!sendOk) {
    // Persist to DLQ so it shows up in /notifications and can be retried
    try {
      await admin.from('notification_failures').insert({
        kind: 'client',
        context: `send-invoice:${inv.invoice_number}`,
        subject,
        to_email: toEmail,
        error: sendErr || 'unknown send failure',
        payload: { from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`, reply_to: BRAND_REPLY_TO, html },
      })
    } catch (e) {
      console.error(`[send-invoice] DLQ persist failed: ${(e as Error).message}`)
    }
    return new Response(JSON.stringify({ ok: false, error: sendErr, invoice_number: inv.invoice_number }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Stamp sent_date. Normal path: atomic (only if still null) to defend
  // against two concurrent first-sends. Force path: unconditional update so
  // the column reflects the most-recent send (used by regenerate-bank-link).
  const today = new Date().toISOString().slice(0, 10)
  const stampQuery = admin
    .from('invoices')
    .update({ sent_date: today, updated_at: new Date().toISOString() })
    .eq('id', inv.id)
  const { data: stamped, error: updErr } = await (force ? stampQuery.select('id') : stampQuery.is('sent_date', null).select('id'))

  if (updErr) {
    console.error(`[send-invoice] stamp sent_date failed for ${inv.invoice_number}: ${updErr.message}`)
    // Email already sent — don't fail the response. Log for manual reconciliation.
  } else if (!force && (!stamped || stamped.length === 0)) {
    console.warn(`[send-invoice] sent_date already set on ${inv.invoice_number} when we tried to stamp; concurrent call?`)
  }

  return new Response(JSON.stringify({
    ok: true,
    sent_to: toEmail,
    invoice_number: inv.invoice_number,
    total: inv.total,
  }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
})
