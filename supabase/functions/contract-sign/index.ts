// contract-sign
// Public endpoint used by the React /sign page.
//   GET  ?token=...  → returns contract JSON (marks status=sent→viewed)
//   POST             → body { token, signer_name, signature_data } stores signature
//
// Adapted from Sheepdog's reference. No JWT verification — public by design.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_NAME = Deno.env.get('BRAND_NAME') || 'Laviolette LLC'
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const BRAND_REPLY_TO = Deno.env.get('BRAND_REPLY_TO') || 'case.laviolette@gmail.com'
const BRAND_COLOR = (Deno.env.get('BRAND_COLOR') || '#B8845A').replace(/[^#0-9A-Fa-f]/g, '').slice(0, 7) || '#B8845A'
const CASE_NOTIFY = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'

const ALLOWED_ORIGINS = [
  'https://app.laviolette.io',
  'https://laviolette.io',
  'http://localhost:5180',
  'http://localhost:5173',
]

function cors(req: Request) {
  const origin = req.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  const corsHeaders = cors(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders })

  const url = new URL(req.url)
  const token = url.searchParams.get('token') || (req.method === 'POST' ? undefined : null)
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Load contract
  let contract
  if (req.method === 'GET') {
    if (!token) return json({ success: false, error: 'Missing token' }, 400, corsHeaders)
    const { data, error } = await supabase
      .from('contracts')
      .select('*, clients(name, legal_name), brands(name)')
      .eq('sign_token', token)
      .single()
    if (error || !data) return json({ success: false, error: 'Contract not found or link expired' }, 404, corsHeaders)
    contract = data

    if (contract.status === 'sent') {
      await supabase.from('contracts').update({ updated_at: new Date().toISOString() }).eq('id', contract.id)
    }

    // Strip full-document wrappers from filled_html so it renders inside our page
    let content = contract.filled_html || ''
    content = content
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<html[^>]*>/gi, '').replace(/<\/html>/gi, '')
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<body[^>]*>/gi, '').replace(/<\/body>/gi, '')
      .trim()

    return json({
      success: true,
      contract: {
        id: contract.id,
        name: contract.name,
        status: contract.status,
        filled_html: content,
        signer_name: contract.signer_name,
        signed_at: contract.signed_at,
        client_name: contract.clients?.legal_name || contract.clients?.name || BRAND_NAME,
        brand_name: contract.brands?.name || null,
      },
    }, 200, corsHeaders)
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const postToken = body.token || token
    if (!postToken) return json({ success: false, error: 'Missing token' }, 400, corsHeaders)

    const { data: c, error } = await supabase
      .from('contracts')
      .select('*, clients(name, legal_name)')
      .eq('sign_token', postToken)
      .single()
    if (error || !c) return json({ success: false, error: 'Contract not found' }, 404, corsHeaders)
    contract = c

    if (contract.status === 'signed' || contract.status === 'active' || contract.status === 'terminated') {
      return json({ success: false, error: 'Contract is not in a signable state.' }, 400, corsHeaders)
    }

    const { signer_name, signature_data } = body
    if (typeof signer_name !== 'string' || signer_name.trim().length === 0 || signer_name.length > 200) {
      return json({ success: false, error: 'Signer name required (under 200 chars).' }, 400, corsHeaders)
    }
    if (typeof signature_data !== 'string' || signature_data.length < 100 || signature_data.length > 500_000) {
      return json({ success: false, error: 'Signature image required.' }, 400, corsHeaders)
    }

    const signerIp =
      req.headers.get('x-real-ip') ||
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown'

    // Atomic: only sign if still in a signable state
    const { data: updated, error: updErr } = await supabase
      .from('contracts')
      .update({
        status: 'signed',
        signer_name: signer_name.trim(),
        signature_data,
        signed_at: new Date().toISOString(),
        signer_ip: signerIp,
        signing_date: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      })
      .eq('id', contract.id)
      .in('status', ['draft', 'sent'])
      .select('id')

    if (updErr) return json({ success: false, error: 'Failed to save signature.' }, 500, corsHeaders)
    if (!updated || updated.length === 0) {
      return json({ success: false, error: 'Contract was signed by someone else just now.' }, 409, corsHeaders)
    }

    // Confirmation emails — fire-and-forget
    const title = contract.name || 'Contract'
    const legalName = contract.clients?.legal_name || contract.clients?.name || BRAND_NAME
    const confirmHtml = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:#12100D;color:#F4F0E8;padding:32px 28px;">
  <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:28px;color:#F4F0E8;margin-bottom:16px;">Contract signed</h2>
  <p style="line-height:1.65;opacity:0.86;">This confirms that <strong style="color:${BRAND_COLOR};font-weight:500;">${esc(signer_name)}</strong> has signed <strong>${esc(title)}</strong> on behalf of <strong>${esc(legalName)}</strong>.</p>
  <p style="color:rgba(244,240,232,0.42);font-size:12px;margin-top:20px;">Signed at ${new Date().toLocaleString('en-US')} from IP ${esc(signerIp)}.</p>
  <p style="color:rgba(244,240,232,0.42);font-size:11px;margin-top:16px;padding-top:16px;border-top:1px solid rgba(244,240,232,0.1);letter-spacing:1px;">From ${esc(BRAND_NAME)}.</p>
</div>`

    const emails: Promise<Response>[] = []
    if (contract.signer_email) {
      emails.push(fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`,
          to: [contract.signer_email],
          reply_to: BRAND_REPLY_TO || undefined,
          subject: `Signed: ${title}`,
          html: confirmHtml,
        }),
      }))
    }
    emails.push(fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${BRAND_NAME} Contracts <${BRAND_FROM_EMAIL}>`,
        to: [CASE_NOTIFY],
        reply_to: contract.signer_email || BRAND_REPLY_TO,
        subject: `Contract signed: ${title} by ${signer_name}`,
        html: confirmHtml,
      }),
    }))
    Promise.allSettled(emails).then((results) => {
      results.forEach((r, i) => { if (r.status === 'rejected') console.error(`Email ${i} failed:`, r.reason) })
    })

    return json({ success: true }, 200, corsHeaders)
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders })
})
