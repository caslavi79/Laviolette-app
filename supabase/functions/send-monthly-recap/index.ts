// send-monthly-recap
// Bearer-authenticated. Sends an approved or draft monthly_recaps row
// to the client's contact email. Flips status='sent' and captures
// sent_at + sent_to_email. Idempotent: a second call after status='sent'
// returns 409.
//
// Auth: Authorization: Bearer <user access token> — must resolve to
// a real Supabase auth user (Case). Same pattern as retry-notification.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendClientEmail } from '../_shared/client-emails.ts'
import { sanitizeHtmlForSend } from '../_shared/recap-template.ts'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const BRAND_REPLY_TO = Deno.env.get('BRAND_REPLY_TO') || 'case.laviolette@gmail.com'
const CASE_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'

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

  // Auth
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401, corsHeaders)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'Unauthorized' }, 401, corsHeaders)

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const body = await req.json().catch(() => ({}))
  const { recap_id, override_email } = body as { recap_id?: string; override_email?: string }
  if (!recap_id) return json({ error: 'recap_id required' }, 400, corsHeaders)

  // 1. Load recap + its project → brand → client → contact chain.
  const { data: recap, error: loadErr } = await admin
    .from('monthly_recaps')
    .select(`
      id, project_id, brand_id, month, status, subject, html_body, summary_json,
      brands (
        id, name,
        clients ( id, contact_id, contacts ( id, name, email ) )
      )
    `)
    .eq('id', recap_id)
    .maybeSingle()
  if (loadErr) return json({ error: `load failed: ${loadErr.message}` }, 500, corsHeaders)
  if (!recap) return json({ error: 'recap not found' }, 404, corsHeaders)

  // 2. Status guard — only draft + approved are sendable. Second call
  //    after a successful send hits this branch.
  if (recap.status === 'sent') return json({ error: 'already sent', sent_at: (recap as any).sent_at || null }, 409, corsHeaders)
  if (recap.status === 'skipped') return json({ error: 'recap is skipped' }, 409, corsHeaders)
  if (!['draft', 'approved'].includes(recap.status)) return json({ error: `invalid status: ${recap.status}` }, 409, corsHeaders)

  // 3. Resolve recipient email. When override_email is supplied, the
  //    real client is NEVER contacted — overrides are Case-facing tests,
  //    used to preview the real send pipeline before committing.
  let recipient: string | null = null
  let recipientName: string | null = null
  const contact = (recap as any).brands?.clients?.contacts
  const resolvedClientEmail: string | null = contact?.email || null
  const isOverride = !!(override_email && String(override_email).trim())
  if (isOverride) {
    if (!/^\S+@\S+\.\S+$/.test(String(override_email).trim())) {
      return json({ error: 'invalid override_email' }, 400, corsHeaders)
    }
    recipient = String(override_email).trim()
  } else {
    recipient = resolvedClientEmail
    recipientName = contact?.name || null
  }
  if (!recipient) return json({ error: 'no email on file for this brand’s contact' }, 409, corsHeaders)

  // 4. Atomic claim: flip draft/approved → 'sent' BEFORE calling Resend
  //    only after we have a successful send. Order: send first, then DB.
  //    If Resend succeeds but DB write fails we have a "sent but untracked"
  //    state — we log and return 200 with a warning rather than 500,
  //    because refusing to acknowledge successful sends leaves Case
  //    confused and may cause him to retry (double-send).
  const subject = recap.subject
  const html = sanitizeHtmlForSend(recap.html_body)
  const from = `Case Laviolette <${BRAND_FROM_EMAIL}>`

  // Skip self-BCC when Case is both the sender (override) and the recipient —
  // would otherwise put the same email in his inbox twice. Audit 2026-04-22
  // A6 LOW.
  const selfBcc = recipient.toLowerCase() === CASE_EMAIL.toLowerCase()
  const res = await sendClientEmail({
    apiKey: RESEND_API_KEY,
    from,
    replyTo: BRAND_REPLY_TO,
    to: recipient,
    bcc: selfBcc ? undefined : [CASE_EMAIL],
    subject,
    html,
    context: `send-monthly-recap:${recap.id}`,
  })

  if (!res.ok) {
    // Persist failure to DLQ for retry via /notifications UI; do NOT
    // flip status — caller can retry.
    await admin.from('notification_failures').insert({
      kind: 'client',
      context: `send-monthly-recap:${recap.id}`,
      subject,
      to_email: recipient,
      error: res.error,
      payload: { from, reply_to: BRAND_REPLY_TO, html, bcc: [CASE_EMAIL] },
    }).then(() => {}).catch((e) => {
      console.error(`[send-monthly-recap] DLQ insert failed: ${(e as Error).message}`)
    })
    return json({ ok: false, error: res.error }, 500, corsHeaders)
  }

  // Override sends are TESTS: do NOT flip the recap status. Log an
  // audit row into notification_failures (kind='internal' since the
  // table's kind CHECK constraint doesn't include a dedicated audit
  // value). Pre-resolved so it doesn't surface as an unresolved alert.
  if (isOverride) {
    await admin.from('notification_failures').insert({
      kind: 'internal',
      context: `recap-test-send:${recap.id}`,
      subject,
      to_email: recipient,
      error: 'test_send_audit',
      payload: {
        was_override: true,
        override_email: recipient,
        real_client_email: resolvedClientEmail,
        resend_id: res.id,
        recap_id: recap.id,
        from,
        bcc: [CASE_EMAIL],
      },
      resolved_at: new Date().toISOString(),
      resolution: 'dismissed',
    }).then(() => {}).catch((e) => {
      console.error(`[send-monthly-recap] audit insert failed: ${(e as Error).message}`)
    })
    return json({
      ok: true,
      was_override: true,
      recipient,
      resend_id: res.id,
      note: 'Test send — recap status unchanged.',
    }, 200, corsHeaders)
  }

  const { error: updErr } = await admin
    .from('monthly_recaps')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      sent_to_email: recipient,
      approved_at: (recap as any).approved_at || new Date().toISOString(),
    })
    .eq('id', recap.id)
  if (updErr) {
    console.error(`[send-monthly-recap] email sent but DB update failed: ${updErr.message}`)
    return json({ ok: true, warning: 'sent but DB update failed', recipient, resend_id: res.id }, 200, corsHeaders)
  }

  return json({ ok: true, was_override: false, recipient, recipient_name: recipientName, resend_id: res.id }, 200, corsHeaders)
})
