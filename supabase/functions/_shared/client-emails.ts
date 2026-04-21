// Client-facing email helpers. Used by auto-push-invoices (invoice sent) and
// stripe-webhook (paid receipt) to notify the client's billing_email about
// ACH charges. Thin wrapper over Resend's REST API — no SDK.
//
// Emails use a light brand-aligned style (dark on cream) because clients
// expect a conventional-looking receipt in their inbox, not Case's dark
// internal-dashboard aesthetic.

const BRAND_INK = '#12100D'
const BRAND_CREAM = '#F4F0E8'
const BRAND_ACCENT = '#B8845A'

export type EmailResult = { ok: true; id: string } | { ok: false; error: string }

// Internal color palette — dark aesthetic mirroring the send-reminders
// digest, since these emails go to Case, not clients.
const INK_DARK_BG = '#12100D'
const INK_LIGHT_TEXT = '#F4F0E8'
const INK_ACCENT = '#B8845A'
const INK_SUCCESS = '#7ab894'
const INK_FAIL = '#d47561'

/**
 * Send an email via Resend. Returns {ok: false, error} on failure — callers
 * should log and continue rather than throw, since a failed notification
 * should never revert a successful charge/DB update.
 */
export async function sendClientEmail(params: {
  apiKey: string
  from: string
  replyTo?: string
  to: string
  bcc?: string | string[]
  subject: string
  html: string
  context: string
}): Promise<EmailResult> {
  try {
    const bccList = params.bcc
      ? (Array.isArray(params.bcc) ? params.bcc : [params.bcc]).filter(Boolean)
      : []
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: params.from,
        ...(params.replyTo ? { reply_to: [params.replyTo] } : {}),
        to: [params.to],
        ...(bccList.length > 0 ? { bcc: bccList } : {}),
        subject: params.subject,
        html: params.html,
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      console.error(`[${params.context}] Resend failed: ${res.status} ${errText}`)
      return { ok: false, error: `${res.status}: ${errText}` }
    }
    const body = (await res.json()) as { id?: string }
    return { ok: true, id: body.id || '' }
  } catch (e) {
    console.error(`[${params.context}] Resend threw: ${(e as Error).message}`)
    return { ok: false, error: (e as Error).message }
  }
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function fmtMoney(n: number | string | null | undefined): string {
  if (n == null) return '$0.00'
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (!isFinite(v)) return '$0.00'
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Format a YYYY-MM-DD string as "May 1, 2026" (no timezone conversion). */
function fmtDate(iso: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

type InternalNotification =
  | {
      kind: 'payment_succeeded'
      clientName: string
      brandName: string
      invoiceNumber: string
      amount: number | string
      paidDate: string
      appUrl: string
    }
  | {
      kind: 'payment_failed'
      clientName: string
      brandName: string
      invoiceNumber: string
      amount: number | string
      reason: string | null
      appUrl: string
    }
  | {
      kind: 'bank_linked'
      clientName: string
      stripeCustomerId: string
      appUrl: string
    }
  | {
      kind: 'setup_failed'
      clientName: string | null
      stripeCustomerId: string
      reason: string | null
      appUrl: string
    }
  | {
      kind: 'dispute_created'
      clientName: string
      brandName: string
      invoiceNumber: string | null
      amount: number | string
      reason: string | null
      dueBy: string | null
      appUrl: string
    }
  | {
      kind: 'refunded'
      clientName: string
      brandName: string
      invoiceNumber: string | null
      amount: number | string
      appUrl: string
    }
  | {
      kind: 'payment_canceled'
      clientName: string
      brandName: string
      invoiceNumber: string | null
      amount: number | string
      reason: string | null
      appUrl: string
    }
  | {
      kind: 'checkout_abandoned'
      clientName: string | null
      stripeCustomerId: string
      appUrl: string
    }
  | {
      kind: 'default_pm_missing'
      clientName: string
      stripeCustomerId: string
      appUrl: string
    }
  | {
      kind: 'auto_push_blocked'
      date: string
      blocked: Array<{ invoice_number: string; client_name: string; amount: number | string; reason: string }>
      appUrl: string
    }
  | {
      kind: 'auto_push_errors'
      date: string
      errors: Array<{ invoice_number: string; error: string }>
      appUrl: string
    }
  | {
      kind: 'bank_disconnected'
      clientName: string
      stripeCustomerId: string
      reason: string
      appUrl: string
    }
  | {
      kind: 'fire_day_reminder'
      date: string
      eligible: Array<{ invoice_id: string; invoice_number: string; client_name: string; brand_name: string; amount: number | string; due_date: string }>
      blocked: Array<{ invoice_number: string; client_name: string; amount: number | string; reason: string }>
      appUrl: string
    }

/**
 * Internal status email to Case. Sent by stripe-webhook alongside the
 * client-facing emails so Case knows in real time when money moves.
 */
export function buildInternalNotification(d: InternalNotification): { subject: string; html: string } {
  let badgeLabel: string
  let badgeColor: string
  let subject: string
  let headline: string
  let rows: Array<[string, string]>

  switch (d.kind) {
    case 'payment_succeeded':
      badgeLabel = 'PAID'
      badgeColor = INK_SUCCESS
      subject = `✓ Paid: ${d.clientName} — ${fmtMoney(d.amount)} — ${d.invoiceNumber}`
      headline = `${d.clientName} paid ${fmtMoney(d.amount)} for ${d.brandName}.`
      rows = [
        ['Invoice', d.invoiceNumber],
        ['Amount', fmtMoney(d.amount)],
        ['Paid', fmtDate(d.paidDate)],
        ['Method', 'ACH debit'],
      ]
      break
    case 'payment_failed':
      badgeLabel = 'FAILED'
      badgeColor = INK_FAIL
      subject = `⚠ Failed: ${d.clientName} — ${fmtMoney(d.amount)} — ${d.invoiceNumber}`
      headline = `${d.clientName}'s ACH debit for ${d.brandName} didn't clear.`
      rows = [
        ['Invoice', d.invoiceNumber],
        ['Amount', fmtMoney(d.amount)],
        ...(d.reason ? [['Reason', d.reason] as [string, string]] : []),
        ['Next step', 'Client was auto-emailed. Follow up if no reply.'],
      ]
      break
    case 'bank_linked':
      badgeLabel = 'CONNECTED'
      badgeColor = INK_SUCCESS
      subject = `✓ Bank linked: ${d.clientName} is ready for ACH`
      headline = `${d.clientName} completed the bank-connection flow. Next auto-push cron will charge any due invoices.`
      rows = [
        ['Client', d.clientName],
        ['Stripe customer', d.stripeCustomerId],
      ]
      break
    case 'setup_failed':
      badgeLabel = 'SETUP FAILED'
      badgeColor = INK_FAIL
      subject = `⚠ Bank setup failed: ${d.clientName || d.stripeCustomerId}`
      headline = `${d.clientName || 'A client'} tried to connect a bank but Stripe rejected it.`
      rows = [
        ['Client', d.clientName || '(unknown)'],
        ['Stripe customer', d.stripeCustomerId],
        ...(d.reason ? [['Reason', d.reason] as [string, string]] : []),
        ['Next step', 'Re-send a fresh setup link via `npm run stripe-setup`.'],
      ]
      break
    case 'dispute_created':
      badgeLabel = 'DISPUTE'
      badgeColor = INK_FAIL
      subject = `🚨 DISPUTE: ${d.clientName} — ${fmtMoney(d.amount)}${d.invoiceNumber ? ` — ${d.invoiceNumber}` : ''}`
      headline = `${d.clientName} disputed a ${fmtMoney(d.amount)} charge for ${d.brandName}. Respond ASAP.`
      rows = [
        ...(d.invoiceNumber ? [['Invoice', d.invoiceNumber] as [string, string]] : []),
        ['Amount', fmtMoney(d.amount)],
        ...(d.reason ? [['Reason', d.reason] as [string, string]] : []),
        ...(d.dueBy ? [['Evidence due by', fmtDate(d.dueBy)] as [string, string]] : []),
        ['Next step', 'Log into Stripe Dashboard → Disputes and submit evidence before the deadline.'],
      ]
      break
    case 'refunded':
      badgeLabel = 'REFUNDED'
      badgeColor = INK_FAIL
      subject = `↩ Refund issued: ${d.clientName} — ${fmtMoney(d.amount)}${d.invoiceNumber ? ` — ${d.invoiceNumber}` : ''}`
      headline = `A ${fmtMoney(d.amount)} refund was issued to ${d.clientName} for ${d.brandName}.`
      rows = [
        ...(d.invoiceNumber ? [['Invoice', d.invoiceNumber] as [string, string]] : []),
        ['Amount refunded', fmtMoney(d.amount)],
        ['Next step', 'Invoice marked as refunded. Revenue + tax export updated automatically.'],
      ]
      break
    case 'payment_canceled':
      badgeLabel = 'CANCELED'
      badgeColor = INK_FAIL
      subject = `⊘ Payment canceled: ${d.clientName} — ${fmtMoney(d.amount)}${d.invoiceNumber ? ` — ${d.invoiceNumber}` : ''}`
      headline = `A PaymentIntent for ${d.clientName} / ${d.brandName} was canceled before settling.`
      rows = [
        ...(d.invoiceNumber ? [['Invoice', d.invoiceNumber] as [string, string]] : []),
        ['Amount', fmtMoney(d.amount)],
        ...(d.reason ? [['Reason', d.reason] as [string, string]] : []),
        ['Next step', 'Invoice returned to pending. Re-push via Money tab when ready.'],
      ]
      break
    case 'checkout_abandoned':
      badgeLabel = 'ABANDONED'
      badgeColor = '#c9a14a'
      subject = `⏱ Bank-link abandoned: ${d.clientName || d.stripeCustomerId}`
      headline = `${d.clientName || 'A client'} received a bank-link but never completed setup. The link has expired.`
      rows = [
        ['Client', d.clientName || '(unknown)'],
        ['Stripe customer', d.stripeCustomerId],
        ['Next step', 'Re-send a fresh setup link via `npm run stripe-setup`.'],
      ]
      break
    case 'default_pm_missing':
      badgeLabel = 'PM MISSING'
      badgeColor = INK_FAIL
      subject = `⚠ Bank attached but default-PM not set: ${d.clientName}`
      headline = `${d.clientName} completed bank setup, but Stripe did not return a usable us_bank_account payment method. Auto-charge will fail until resolved.`
      rows = [
        ['Client', d.clientName],
        ['Stripe customer', d.stripeCustomerId],
        ['Next step', 'Check Stripe Dashboard → Customer → Payment methods. Re-send setup link if needed.'],
      ]
      break
    case 'auto_push_blocked': {
      badgeLabel = 'ACTION NEEDED'
      badgeColor = INK_FAIL
      const n = d.blocked.length
      subject = `⚠ Auto-push blocked: ${n} invoice${n === 1 ? '' : 's'} could not charge (${d.date})`
      headline = `${n} invoice${n === 1 ? ' is' : 's are'} eligible to fire today but the client${n === 1 ? ' has' : 's have'} no bank on file. Case action needed.`
      rows = [
        ...d.blocked.map((b) => [b.invoice_number + ' · ' + b.client_name, fmtMoney(b.amount) + ' · ' + b.reason] as [string, string]),
        ['Next step', 'Send bank-link (npm run stripe-setup …) or check Contacts page.'],
      ]
      break
    }
    case 'auto_push_errors': {
      badgeLabel = 'ERRORS'
      badgeColor = INK_FAIL
      const n = d.errors.length
      subject = `⚠ Auto-push had ${n} error${n === 1 ? '' : 's'} (${d.date})`
      headline = `Auto-push run completed but ${n} invoice${n === 1 ? '' : 's'} failed. Check Notifications + Stripe Dashboard.`
      rows = [
        ...d.errors.map((e) => [e.invoice_number, e.error.slice(0, 120)] as [string, string]),
        ['Next step', 'Review errors in Supabase function logs. Re-run once root cause fixed.'],
      ]
      break
    }
    case 'bank_disconnected':
      badgeLabel = 'BANK DISCONNECTED'
      badgeColor = INK_FAIL
      subject = `⚠ Bank disconnected: ${d.clientName}`
      headline = `${d.clientName}'s bank on file is no longer usable. Auto-push will skip their invoices until they reconnect.`
      rows = [
        ['Client', d.clientName],
        ['Stripe customer', d.stripeCustomerId],
        ['Reason', d.reason],
        ['Next step', 'Re-send a bank setup link via `npm run stripe-setup`. Their bank_info_on_file flag has been flipped to false.'],
      ]
      break
    case 'fire_day_reminder': {
      badgeLabel = 'FIRE DAY'
      badgeColor = INK_ACCENT
      const nEligible = d.eligible.length
      const nBlocked = d.blocked.length
      const totalAmount = d.eligible.reduce((s, inv) => {
        const v = typeof inv.amount === 'string' ? parseFloat(inv.amount) : inv.amount
        return s + (Number.isFinite(v) ? v : 0)
      }, 0)
      subject = nBlocked > 0
        ? `🔔 Fire day: ${nEligible} charge${nEligible === 1 ? '' : 's'} ready + ${nBlocked} blocked — ${d.date}`
        : `🔔 Fire day: ${nEligible} charge${nEligible === 1 ? '' : 's'} ready — ${fmtMoney(totalAmount)} total`
      headline = nEligible > 0
        ? `${nEligible} invoice${nEligible === 1 ? ' is' : 's are'} eligible to fire today (${fmtMoney(totalAmount)} total). Click "Fire now" on each — or let auto-push handle it at 4:05 PM CT as a safety net.`
        : `No invoices eligible to fire today — only blocked invoices need attention.`
      // Build the eligible-invoice table with per-row Fire-now button
      const eligibleRowsHtml = d.eligible.map((inv) => `
        <tr>
          <td style="padding: 10px 14px; border-bottom: 1px solid rgba(244,240,232,0.08); color: ${INK_LIGHT_TEXT};">
            <strong style="font-family: ui-monospace, Menlo, monospace;">${esc(inv.invoice_number)}</strong><br>
            <span style="color: rgba(244,240,232,0.55); font-size: 12px;">${esc(inv.client_name)} · ${esc(inv.brand_name)}</span>
          </td>
          <td style="padding: 10px 14px; border-bottom: 1px solid rgba(244,240,232,0.08); color: ${INK_LIGHT_TEXT}; text-align: right; font-weight: 600;">
            ${fmtMoney(inv.amount)}<br>
            <span style="color: rgba(244,240,232,0.55); font-size: 11px; font-weight: 400;">due ${fmtDate(inv.due_date)}</span>
          </td>
          <td style="padding: 10px 14px; border-bottom: 1px solid rgba(244,240,232,0.08); text-align: right;">
            <a href="${esc(d.appUrl)}/money?tab=invoices&highlight=${esc(inv.invoice_id)}" style="display: inline-block; padding: 6px 14px; background: ${INK_ACCENT}; color: #12100D; text-decoration: none; border-radius: 3px; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;">Fire now</a>
          </td>
        </tr>`).join('')
      const blockedRowsHtml = d.blocked.map((b) => `
        <tr>
          <td style="padding: 8px 14px; border-bottom: 1px solid rgba(212,117,97,0.15); color: ${INK_LIGHT_TEXT};">
            <strong style="font-family: ui-monospace, Menlo, monospace;">${esc(b.invoice_number)}</strong><br>
            <span style="color: rgba(244,240,232,0.55); font-size: 12px;">${esc(b.client_name)}</span>
          </td>
          <td style="padding: 8px 14px; border-bottom: 1px solid rgba(212,117,97,0.15); color: ${INK_FAIL}; text-align: right;">
            ${fmtMoney(b.amount)}<br>
            <span style="font-size: 11px;">${esc(b.reason)}</span>
          </td>
        </tr>`).join('')
      // Override the default rows layout — use a richer multi-section body.
      const customHtml = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 28px 22px; color: ${INK_LIGHT_TEXT}; background: ${INK_DARK_BG};">
  <p style="margin: 0 0 18px; font-size: 13px; letter-spacing: 2px; color: ${INK_ACCENT}; text-transform: uppercase;">Laviolette HQ · ${esc(d.date)}</p>
  <p style="margin: 0 0 14px; font-size: 14px; line-height: 1.55;">
    <span style="display: inline-block; padding: 3px 10px; border-radius: 3px; background: ${badgeColor}; color: #12100D; font-size: 11px; letter-spacing: 1px; font-weight: 700; vertical-align: middle; margin-right: 8px;">${badgeLabel}</span>
    ${esc(headline)}
  </p>
  ${nEligible > 0 ? `
  <p style="margin: 20px 0 8px; font-size: 12px; letter-spacing: 1.5px; color: rgba(244,240,232,0.55); text-transform: uppercase;">Ready to charge (${nEligible})</p>
  <table style="width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.02); border: 1px solid rgba(244,240,232,0.1); font-size: 13px;">
    ${eligibleRowsHtml}
  </table>` : ''}
  ${nBlocked > 0 ? `
  <p style="margin: 24px 0 8px; font-size: 12px; letter-spacing: 1.5px; color: ${INK_FAIL}; text-transform: uppercase;">Blocked — needs action (${nBlocked})</p>
  <table style="width: 100%; border-collapse: collapse; background: rgba(212,117,97,0.04); border: 1px solid ${INK_FAIL}; font-size: 13px;">
    ${blockedRowsHtml}
  </table>
  <p style="margin: 12px 0 0; font-size: 12px; color: rgba(244,240,232,0.55); line-height: 1.5;">Send bank-link or resolve before 4:05 PM CT. Auto-push will skip these.</p>` : ''}
  <p style="margin: 28px 0 0; font-size: 12px; color: rgba(244,240,232,0.55); line-height: 1.5;">
    Auto-push fires at 4:05 PM CT (with retry at 5:05 PM). Any invoice you don't fire manually will be charged automatically — this reminder is the safety belt, not a requirement.
  </p>
  <p style="margin: 24px 0 0; font-size: 12px;">
    <a href="${esc(d.appUrl)}/money" style="color: ${INK_ACCENT}; text-decoration: none;">Open Money tab →</a>
  </p>
</div>`.trim()
      return { subject, html: customHtml }
    }
  }

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr>
          <td style="padding: 10px 14px; border-bottom: 1px solid rgba(244,240,232,0.08); color: rgba(244,240,232,0.55); width: 35%;">${esc(k)}</td>
          <td style="padding: 10px 14px; border-bottom: 1px solid rgba(244,240,232,0.08); color: ${INK_LIGHT_TEXT};">${esc(v)}</td>
        </tr>`
    )
    .join('\n')

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 28px 22px; color: ${INK_LIGHT_TEXT}; background: ${INK_DARK_BG};">
  <p style="margin: 0 0 18px; font-size: 13px; letter-spacing: 2px; color: ${INK_ACCENT}; text-transform: uppercase;">Laviolette HQ</p>
  <p style="margin: 0 0 14px; font-size: 14px; line-height: 1.55;">
    <span style="display: inline-block; padding: 3px 10px; border-radius: 3px; background: ${badgeColor}; color: #12100D; font-size: 11px; letter-spacing: 1px; font-weight: 700; vertical-align: middle; margin-right: 8px;">${badgeLabel}</span>
    ${esc(headline)}
  </p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0; background: rgba(255,255,255,0.02); border: 1px solid rgba(244,240,232,0.1); font-size: 13px;">
    ${rowsHtml}
  </table>
  <p style="margin: 24px 0 0; font-size: 12px;">
    <a href="${esc(d.appUrl)}/money" style="color: ${INK_ACCENT}; text-decoration: none;">Open Money →</a>
  </p>
</div>`.trim()
  return { subject, html }
}

type FailedPaymentEmailData = {
  clientName: string
  brandName: string
  invoiceNumber: string
  description: string
  amount: number | string
  dueDate: string    // YYYY-MM-DD
  failureReason?: string | null  // Stripe's pi.last_payment_error.message if available
}

/**
 * HTML for the "your ACH payment didn't clear" notification. Sent by
 * stripe-webhook on payment_intent.payment_failed.
 *
 * ACH failures do NOT auto-retry (Stripe requires manual re-initiation for
 * most decline codes like insufficient_funds / account_closed), so the copy
 * asks the client to reply rather than promising an automatic retry.
 */
export function buildPaymentFailedEmail(d: FailedPaymentEmailData): { subject: string; html: string } {
  const subject = `Payment failed: Invoice ${d.invoiceNumber} — ${fmtMoney(d.amount)}`
  const reasonBlock = d.failureReason
    ? `<p style="margin: 0 0 16px; font-size: 14px; color: rgba(18,16,13,0.75); background: #fdf4f0; padding: 12px 16px; border-left: 3px solid #c0513b; line-height: 1.5;"><strong>Reason:</strong> ${esc(d.failureReason)}</p>`
    : ''
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: ${BRAND_INK}; background: ${BRAND_CREAM};">
  <p style="margin: 0 0 16px; font-size: 15px;">Hi ${esc(d.clientName)},</p>
  <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.55;">
    <span style="display: inline-block; padding: 3px 10px; border-radius: 3px; background: #c0513b; color: #ffffff; font-size: 11px; letter-spacing: 1px; font-weight: 600; vertical-align: middle; margin-right: 8px;">FAILED</span>
    Heads up &mdash; your ACH payment for <strong>${esc(d.brandName)}</strong> didn't clear.
  </p>
  ${reasonBlock}
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #ffffff; border: 1px solid rgba(18,16,13,0.12); font-size: 14px;">
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); color: rgba(18,16,13,0.65);">Invoice</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); text-align: right; font-family: ui-monospace, Menlo, monospace;"><strong>${esc(d.invoiceNumber)}</strong></td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); color: rgba(18,16,13,0.65);">Description</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); text-align: right;">${esc(d.description)}</td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); color: rgba(18,16,13,0.65);">Amount owed</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); text-align: right; font-weight: 600;">${fmtMoney(d.amount)}</td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; color: rgba(18,16,13,0.65);">Due date</td>
      <td style="padding: 12px 16px; text-align: right;">${esc(fmtDate(d.dueDate))}</td>
    </tr>
  </table>
  <p style="margin: 16px 0; font-size: 14px; color: rgba(18,16,13,0.8); line-height: 1.55;"><strong>Just reply to this email</strong> and we'll sort it out. Common fixes: top up the account balance, or update bank info if the account changed. I'll re-initiate the charge as soon as we're squared away.</p>
  <p style="margin: 32px 0 0; padding-top: 16px; border-top: 1px solid rgba(18,16,13,0.12); font-size: 12px; color: rgba(18,16,13,0.55); line-height: 1.6;">
    <strong style="color: ${BRAND_ACCENT};">Case Laviolette</strong> &middot; Laviolette LLC<br>
    4201 Sun Spirit Dr, Austin, TX 78735 &middot; EIN 99-1461687
  </p>
</div>`.trim()
  return { subject, html }
}

type ReceiptEmailData = {
  clientName: string
  brandName: string
  invoiceNumber: string
  description: string
  amount: number | string
  paidDate: string  // YYYY-MM-DD
}

/**
 * HTML for the "payment received" receipt. Sent by stripe-webhook on
 * payment_intent.succeeded.
 */
export function buildReceiptEmail(d: ReceiptEmailData): { subject: string; html: string } {
  const subject = `Receipt: Invoice ${d.invoiceNumber} — ${fmtMoney(d.amount)} — PAID`
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: ${BRAND_INK}; background: ${BRAND_CREAM};">
  <p style="margin: 0 0 16px; font-size: 15px;">Hi ${esc(d.clientName)},</p>
  <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.55;">
    <span style="display: inline-block; padding: 3px 10px; border-radius: 3px; background: #2d8659; color: #ffffff; font-size: 11px; letter-spacing: 1px; font-weight: 600; vertical-align: middle; margin-right: 8px;">PAID</span>
    Payment received for <strong>${esc(d.brandName)}</strong>. Thanks.
  </p>
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #ffffff; border: 1px solid rgba(18,16,13,0.12); font-size: 14px;">
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); color: rgba(18,16,13,0.65);">Invoice</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); text-align: right; font-family: ui-monospace, Menlo, monospace;"><strong>${esc(d.invoiceNumber)}</strong></td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); color: rgba(18,16,13,0.65);">Description</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); text-align: right;">${esc(d.description)}</td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); color: rgba(18,16,13,0.65);">Amount paid</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); text-align: right; font-weight: 600;">${fmtMoney(d.amount)}</td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); color: rgba(18,16,13,0.65);">Payment date</td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(18,16,13,0.08); text-align: right;">${esc(fmtDate(d.paidDate))}</td>
    </tr>
    <tr>
      <td style="padding: 12px 16px; color: rgba(18,16,13,0.65);">Method</td>
      <td style="padding: 12px 16px; text-align: right;">ACH debit</td>
    </tr>
  </table>
  <p style="margin: 32px 0 0; padding-top: 16px; border-top: 1px solid rgba(18,16,13,0.12); font-size: 12px; color: rgba(18,16,13,0.55); line-height: 1.6;">
    Thanks for your business.<br>
    <strong style="color: ${BRAND_ACCENT};">Case Laviolette</strong> &middot; Laviolette LLC<br>
    4201 Sun Spirit Dr, Austin, TX 78735 &middot; EIN 99-1461687
  </p>
</div>`.trim()
  return { subject, html }
}
