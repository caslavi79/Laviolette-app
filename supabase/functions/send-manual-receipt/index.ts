// send-manual-receipt
// Fires a paid-receipt email to the client AND an HQ alert to Case when an
// invoice is manually marked paid via MarkPaidModal. Parity with the automatic
// Stripe webhook flow (payment_intent.succeeded) so wire/check/Zelle payments
// also generate a client-facing receipt + operator-visibility alert.
//
// Auth: Bearer token (Case's session). Body: { invoice_id: uuid }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  sendClientEmail,
  buildReceiptEmail,
  buildInternalNotification,
} from '../_shared/client-emails.ts'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_NAME = Deno.env.get('BRAND_NAME') || 'Laviolette LLC'
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const BRAND_REPLY_TO = Deno.env.get('BRAND_REPLY_TO') || 'case.laviolette@gmail.com'
const CASE_NOTIFY_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'
const APP_URL = Deno.env.get('APP_URL') || 'https://app.laviolette.io'

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

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401, corsHeaders)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401, corsHeaders)

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const body = await req.json().catch(() => ({}))
  const { invoice_id } = body
  if (!invoice_id) return json({ error: 'invoice_id required' }, 400, corsHeaders)

  const { data: inv, error } = await admin
    .from('invoices')
    .select('id, invoice_number, total, description, paid_date, payment_method, clients(legal_name, name, billing_email), brands(name)')
    .eq('id', invoice_id)
    .single()
  if (error || !inv) return json({ error: 'Invoice not found' }, 404, corsHeaders)

  const row = inv as {
    id: string; invoice_number: string; total: number | string; description: string | null;
    paid_date: string; payment_method: string | null;
    clients?: { legal_name?: string; name?: string; billing_email?: string | null } | null;
    brands?: { name?: string | null } | null
  }

  const clientName = row.clients?.legal_name || row.clients?.name || 'there'
  const brandName = row.brands?.name || row.clients?.legal_name || row.clients?.name || 'your account'
  const toEmail = row.clients?.billing_email
  const persistFailure = async (kind: 'client' | 'internal', context: string, subject: string, to: string, error: string, html: string, from: string, replyTo?: string) => {
    try {
      await admin.from('notification_failures').insert({
        kind, context, subject, to_email: to, error, payload: { from, reply_to: replyTo, html },
      })
    } catch (e) {
      console.error(`[${context}] failed to persist: ${(e as Error).message}`)
    }
  }

  // Client-facing receipt
  let clientEmailSent = false
  if (toEmail) {
    const { subject, html } = buildReceiptEmail({
      clientName, brandName,
      invoiceNumber: row.invoice_number,
      description: row.description || '',
      amount: row.total,
      paidDate: row.paid_date,
    })
    const from = `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`
    const res = await sendClientEmail({
      apiKey: RESEND_API_KEY, from, replyTo: BRAND_REPLY_TO,
      to: toEmail, bcc: [CASE_NOTIFY_EMAIL],
      subject, html, context: `send-manual-receipt:${row.invoice_number}`,
    })
    if (!res.ok) {
      await persistFailure('client', `send-manual-receipt:${row.invoice_number}`, subject, toEmail, res.error, html, from, BRAND_REPLY_TO)
    } else {
      clientEmailSent = true
    }
  }

  // Internal HQ alert
  const caseNotif = buildInternalNotification({
    kind: 'payment_succeeded',
    clientName: row.clients?.legal_name || row.clients?.name || 'Unknown client',
    brandName,
    invoiceNumber: row.invoice_number,
    amount: row.total,
    paidDate: row.paid_date,
    appUrl: APP_URL,
  })
  const hqFrom = `Laviolette HQ <${BRAND_FROM_EMAIL}>`
  const hqRes = await sendClientEmail({
    apiKey: RESEND_API_KEY, from: hqFrom,
    to: CASE_NOTIFY_EMAIL, subject: caseNotif.subject, html: caseNotif.html,
    context: `send-manual-receipt:notify-case:${row.invoice_number}`,
  })
  if (!hqRes.ok) {
    await persistFailure('internal', `send-manual-receipt:notify-case:${row.invoice_number}`, caseNotif.subject, CASE_NOTIFY_EMAIL, hqRes.error, caseNotif.html, hqFrom)
  }

  return json({ ok: true, client_email_sent: clientEmailSent, case_alert_sent: hqRes.ok }, 200, corsHeaders)
})
