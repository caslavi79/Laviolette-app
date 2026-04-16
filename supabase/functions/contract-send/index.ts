// contract-send
// Posts a Resend email to the signer with a branded signing link.
// Requires authenticated user (Bearer token). Ported from Sheepdog
// reference app, adapted for Laviolette's contracts schema (name
// instead of title, no staff/template_name coupling).

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
const BRAND_BG = Deno.env.get('BRAND_BG') || '#12100D'
const BRAND_INK = Deno.env.get('BRAND_INK') || '#F4F0E8'
const BRAND_LOGO_URL = Deno.env.get('BRAND_LOGO_URL') || ''
const SIGNING_BASE_URL = Deno.env.get('SIGNING_BASE_URL') || 'https://app.laviolette.io/sign'

const ALLOWED_ORIGINS = [
  'https://app.laviolette.io',
  'https://laviolette.io',
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

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  const corsHeaders = cors(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ success: false, error: 'Authorization required' }, 401, corsHeaders)
    }
    const { data: { user } } = await supabase.auth.getUser(authHeader.slice(7))
    if (!user) return json({ success: false, error: 'Invalid or expired token' }, 401, corsHeaders)

    const { contract_id } = await req.json()
    if (!contract_id) return json({ success: false, error: 'contract_id required' }, 400, corsHeaders)

    const { data: contract, error } = await supabase
      .from('contracts')
      .select('*, clients(name, legal_name)')
      .eq('id', contract_id)
      .single()

    if (error || !contract) return json({ success: false, error: 'Contract not found' }, 404, corsHeaders)
    if (!contract.signer_email) return json({ success: false, error: 'No signer email set' }, 400, corsHeaders)
    if (!contract.filled_html) return json({ success: false, error: 'Contract has no content. Fill it in before sending.' }, 400, corsHeaders)
    if (contract.status === 'signed' || contract.status === 'active') {
      return json({ success: false, error: 'Contract is already signed.' }, 400, corsHeaders)
    }

    const signingUrl = `${SIGNING_BASE_URL}?token=${contract.sign_token}`
    const title = contract.name || 'Contract'
    const legalName = contract.clients?.legal_name || contract.clients?.name || BRAND_NAME

    const emailHtml = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:${BRAND_BG};color:${BRAND_INK};padding:32px 28px;">
  <div style="padding-bottom:20px;border-bottom:1px solid rgba(244,240,232,0.1);margin-bottom:28px;display:flex;align-items:center;gap:12px;">
    ${BRAND_LOGO_URL ? `<img src="${BRAND_LOGO_URL}" alt="" style="width:36px;height:36px;border-radius:6px;">` : ''}
    <span style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;letter-spacing:0.08em;">
      <span style="color:${BRAND_INK};">La</span><span style="color:${BRAND_COLOR};font-weight:500;">v</span><span style="color:${BRAND_INK};">iolette</span>
    </span>
  </div>
  <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:28px;color:${BRAND_INK};margin-bottom:16px;line-height:1.2;">Contract ready for your signature</h2>
  <p style="line-height:1.65;color:${BRAND_INK};opacity:0.86;margin-bottom:12px;">
    ${esc(legalName)} has a contract for your review: <strong style="color:${BRAND_INK};font-weight:500;">${esc(title)}</strong>.
  </p>
  <p style="line-height:1.65;color:${BRAND_INK};opacity:0.86;margin-bottom:28px;">
    Click below to review the full contract and provide your electronic signature.
  </p>
  <div style="margin:28px 0;">
    <a href="${signingUrl}" style="display:inline-block;background:${BRAND_COLOR};color:${BRAND_BG};text-decoration:none;padding:14px 28px;border-radius:4px;font-family:'Barlow Condensed',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">
      Review &amp; Sign
    </a>
  </div>
  <p style="color:rgba(244,240,232,0.42);font-size:12px;line-height:1.5;">
    If the button doesn't work, copy and paste this link into your browser:<br>
    <a href="${signingUrl}" style="color:${BRAND_COLOR};word-break:break-all;">${signingUrl}</a>
  </p>
  <p style="color:rgba(244,240,232,0.42);font-size:11px;margin-top:28px;padding-top:16px;border-top:1px solid rgba(244,240,232,0.08);letter-spacing:1px;">
    From ${esc(BRAND_NAME)}. Questions? Reply to this email.
  </p>
</div>`

    // Update status FIRST so it's marked sent even if email delivery is slow
    await supabase
      .from('contracts')
      .update({ status: 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', contract.id)

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`,
        to: [contract.signer_email],
        reply_to: BRAND_REPLY_TO || undefined,
        subject: `Contract for your review: ${title}`,
        html: emailHtml,
      }),
    })
    const emailResult = await emailRes.json()
    if (!emailRes.ok) {
      console.error('Resend error:', JSON.stringify(emailResult))
      return json({ success: false, error: 'Failed to send email', details: emailResult }, 500, corsHeaders)
    }

    return json({ success: true, signing_url: signingUrl, email: emailResult }, 200, corsHeaders)
  } catch (err) {
    console.error('contract-send error:', err)
    return json({ success: false, error: String((err as Error).message || err) }, 500, corsHeaders)
  }
})
