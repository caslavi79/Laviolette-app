// retry-notification
// Re-sends a failed notification from the notification_failures dead-letter queue.
// On success, marks the row resolved=now + resolution='retried'. On failure,
// updates the error field with the new attempt's error (so Case can see what
// changed) but leaves the row unresolved.
//
// Auth: Bearer token from logged-in user (Case). Body: { id: uuid }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendClientEmail } from '../_shared/client-emails.ts'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_REPLY_TO = Deno.env.get('BRAND_REPLY_TO') || 'case.laviolette@gmail.com'

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
  const { id } = body
  if (!id) return json({ error: 'id required' }, 400, corsHeaders)

  const { data: row, error: loadErr } = await admin
    .from('notification_failures')
    .select('*')
    .eq('id', id)
    .is('resolved_at', null)
    .maybeSingle()
  if (loadErr) return json({ error: `load failed: ${loadErr.message}` }, 500, corsHeaders)
  if (!row) return json({ error: 'notification not found or already resolved' }, 404, corsHeaders)

  const payload = (row.payload || {}) as { from?: string; reply_to?: string; html?: string }
  if (!payload.from || !payload.html || !row.to_email || !row.subject) {
    return json({ error: 'payload missing required fields (from/html/to/subject)' }, 400, corsHeaders)
  }

  const res = await sendClientEmail({
    apiKey: RESEND_API_KEY,
    from: payload.from,
    replyTo: payload.reply_to || BRAND_REPLY_TO,
    to: row.to_email,
    subject: row.subject,
    html: payload.html,
    context: `retry-notification:${row.id}`,
  })

  if (!res.ok) {
    // Retry failed too. Update the error field so Case sees the latest attempt.
    await admin
      .from('notification_failures')
      .update({ error: `retry failed: ${res.error}` })
      .eq('id', row.id)
    return json({ ok: false, error: res.error }, 500, corsHeaders)
  }

  const { error: updErr } = await admin
    .from('notification_failures')
    .update({ resolved_at: new Date().toISOString(), resolution: 'retried' })
    .eq('id', row.id)
  if (updErr) {
    console.error(`[retry-notification] email sent but DB update failed: ${updErr.message}`)
    return json({ ok: true, warning: 'sent but DB update failed' }, 200, corsHeaders)
  }
  return json({ ok: true, resend_id: res.id }, 200, corsHeaders)
})
