// contract-sign
// Public endpoint used by the React /sign page.
//   GET  ?token=...  → returns contract JSON (marks status=sent→viewed)
//   POST             → body { token, signer_name, signature_data } stores signature
//
// Adapted from Sheepdog's reference. No JWT verification — public by design.

import Stripe from 'https://esm.sh/stripe@17?target=deno'
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

// Unified onboarding (feature-flagged, OFF by default). When "true" AND the
// signed contract is a buildout AND the project has no non-void invoices yet,
// the handler synthesizes an invoice + a Stripe Checkout session for bank-
// linking + fires ONE unified email via send-invoice (containing both the
// invoice document and the bank-link CTA). When "false" / unset / not a
// buildout / invoice already exists, behavior is bit-for-bit identical to
// pre-change (falls through to the existing send-invoice-for-pending loop).
const ENABLE_UNIFIED_ONBOARDING = Deno.env.get('ENABLE_UNIFIED_ONBOARDING') === 'true'
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || ''
const STRIPE_SUCCESS_URL = Deno.env.get('STRIPE_SUCCESS_URL') || 'https://app.laviolette.io/setup-success'
const STRIPE_CANCEL_URL = Deno.env.get('STRIPE_CANCEL_URL') || 'https://app.laviolette.io/setup-cancel'

// Cross-function fetch targets (hoisted from inline per-loop reads). Both
// branches of the post-sign send-invoice fan-out use these. REMINDERS_SECRET
// must be set as a Supabase secret; empty-string fallback would only match an
// empty-string callee env (fragile, but keeps Deno from throwing at module load
// during local smoke tests without the full env).
const FUNC_BASE = `${SUPABASE_URL}/functions/v1`
const REMINDERS_SECRET = Deno.env.get('REMINDERS_SECRET') || ''

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

// Verify the provided signature_data is actually a PNG, not an arbitrary
// base64-string-shaped blob. Canvas on the /sign page always produces PNGs;
// this catches malformed/spoofed input before it's baked into filled_html.
// Checks the first 8 bytes against the PNG magic signature: 89 50 4E 47 0D 0A 1A 0A.
function isPngDataUrl(signatureData: string): boolean {
  const base64 = signatureData.replace(/^data:image\/(png|x-png);base64,/i, '')
  try {
    // Decode just enough to read the 8-byte magic header (base64 packs 3 bytes per 4 chars)
    const prefix = atob(base64.slice(0, 12))
    if (prefix.length < 8) return false
    return (
      prefix.charCodeAt(0) === 0x89 &&
      prefix.charCodeAt(1) === 0x50 &&
      prefix.charCodeAt(2) === 0x4E &&
      prefix.charCodeAt(3) === 0x47 &&
      prefix.charCodeAt(4) === 0x0D &&
      prefix.charCodeAt(5) === 0x0A &&
      prefix.charCodeAt(6) === 0x1A &&
      prefix.charCodeAt(7) === 0x0A
    )
  } catch {
    return false
  }
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

  // Signing links expire 30 days after the contract was sent. Reduces the
  // window where a stolen/leaked URL can be used; reasonable buffer for
  // clients who take a few weeks to review before signing.
  const TOKEN_TTL_DAYS = 30
  const isExpired = (sentAt: string | null | undefined): boolean => {
    if (!sentAt) return false // never sent → draft still, treat as unexpired
    const sent = new Date(sentAt).getTime()
    if (!Number.isFinite(sent)) return false
    return Date.now() - sent > TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  }

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
    if (isExpired(contract.sent_at) && contract.status !== 'signed' && contract.status !== 'active') {
      return json({ success: false, error: 'This signing link has expired. Ask Case for a fresh link.' }, 410, corsHeaders)
    }

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
    if (isExpired(contract.sent_at)) {
      return json({ success: false, error: 'This signing link has expired. Ask Case for a fresh link.' }, 410, corsHeaders)
    }

    const { signer_name, signature_data } = body
    if (typeof signer_name !== 'string' || signer_name.trim().length === 0 || signer_name.length > 200) {
      return json({ success: false, error: 'Signer name required (under 200 chars).' }, 400, corsHeaders)
    }
    if (typeof signature_data !== 'string' || signature_data.length < 100 || signature_data.length > 500_000) {
      return json({ success: false, error: 'Signature image required.' }, 400, corsHeaders)
    }
    if (!isPngDataUrl(signature_data)) {
      return json({ success: false, error: 'Signature image must be a PNG.' }, 400, corsHeaders)
    }

    const signerIp =
      req.headers.get('x-real-ip') ||
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown'

    // Bake the signer's actual signature image + date + ESIGN note into filled_html
    // so the signed contract renders fully-executed (both provider and client sigs
    // visible) when anyone revisits the /sign URL. Without this, signature_data
    // stays in a separate column and the HTML still shows the blank client block.
    const signedDateLong = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    const signedAt = new Date().toISOString()
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const clientSigHtml = `<!-- client-sig-block -->
<div class="sig-block">
  <p style="font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:1px;">CLIENT</p>
  <div style="margin:16px 0 2px;"><img src="${signature_data}" alt="Client signature" style="max-width:300px; max-height:100px; display:block;" /></div>
  <div class="sig-underline"></div>
  <p class="sig-name">${escHtml(signer_name.trim())}</p>
  <p>On behalf of ${escHtml(contract.brands?.name || contract.clients?.legal_name || contract.clients?.name || '')}</p>
  <p>Signing Date: ${signedDateLong}</p>
  <p class="sig-provider-note">Signed electronically by ${escHtml(signer_name.trim())} under the U.S. ESIGN Act and UETA. IP: ${escHtml(signerIp)} · ${signedAt}</p>
  <p>Email for Notices: ${escHtml(contract.signer_email || contract.clients?.billing_email || '')}</p>
</div>
<!-- /client-sig-block -->`.trim()

    // Surgical replacement: swap the blank CLIENT sig block with the filled-in one.
    // Primary match: HTML comment markers added to the templates (stable across
    // any style/class/whitespace drift). Fallback: the original class-based regex
    // for any draft contract generated before the markers were introduced. If
    // neither matches, fall through to the unmodified filled_html (defensive —
    // we never corrupt the contract; the signature_data column still holds the
    // captured image for audit).
    const markerRegex = /<!-- client-sig-block -->[\s\S]*?<!-- \/client-sig-block -->/
    const legacyClassRegex =
      /<div class="sig-block">\s*<p style="font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:1px;">CLIENT<\/p>[\s\S]*?Signing Date: _______________[\s\S]*?<\/div>/
    const originalHtml: string = contract.filled_html || ''
    const signedHtml = markerRegex.test(originalHtml)
      ? originalHtml.replace(markerRegex, clientSigHtml)
      : legacyClassRegex.test(originalHtml)
        ? originalHtml.replace(legacyClassRegex, clientSigHtml)
        : originalHtml

    // Atomic: only sign if still in a signable state
    const { data: updated, error: updErr } = await supabase
      .from('contracts')
      .update({
        status: 'signed',
        signer_name: signer_name.trim(),
        signature_data,
        filled_html: signedHtml,
        signed_at: signedAt,
        signer_ip: signerIp,
        signing_date: new Date().toISOString().slice(0, 10),
        updated_at: signedAt,
      })
      .eq('id', contract.id)
      .in('status', ['draft', 'sent'])
      .select('id')

    if (updErr) return json({ success: false, error: 'Failed to save signature.' }, 500, corsHeaders)
    if (!updated || updated.length === 0) {
      return json({ success: false, error: 'Contract was signed by someone else just now.' }, 409, corsHeaders)
    }

    // Advance the linked project on successful sign.
    //   draft → active    when start_date <= today (or null)
    //   draft → scheduled when start_date >  today  (signed-but-not-started)
    //
    // The scheduled-state cron (`advance-contract-status`) flips
    // scheduled → active daily once start_date arrives. Both transitions
    // guarded by `status='draft'` so pre-existing active/paused/
    // complete/cancelled projects are never re-bounced. A failure here
    // doesn't reverse the signature — the sign commit is already
    // permanent; this is lifecycle bookkeeping. Operator can correct
    // manually via the Projects page if needed.
    // Hoist today-in-CT once — reused by primary + every related project below.
    // Use CT to match the cron pipeline. Audit 2026-04-22 A3/A4 MEDIUM:
    // `new Date().toISOString()` returns UTC, so a contract signed at
    // 22:00 CT on day N-1 for a project with start_date=N would route
    // directly to 'active' (skipping 'scheduled') because the UTC date
    // was already N. `advance-contract-status` + `generate-retainer-invoices`
    // both compute today via America/Chicago; this aligns with them.
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())

    // Advance a single project out of 'draft' based on its start_date.
    // Returns void — all failures logged + swallowed (sign is already
    // committed; lifecycle bookkeeping never reverses the signature).
    const advanceProject = async (projectId: string, label: string) => {
      const { data: proj, error: projReadErr } = await supabase
        .from('projects')
        .select('start_date')
        .eq('id', projectId)
        .maybeSingle()
      if (projReadErr) {
        console.warn(`[contract-sign] ${label} read failed for ${projectId}: ${projReadErr.message}`)
        return
      }
      if (!proj) {
        // Defensive: a uuid in related_project_ids that no longer resolves
        // (deleted project, corrupt backfill). The DB-side trigger prevents
        // this on write, but we still log + skip so a drift doesn't crash sign.
        console.warn(`[contract-sign] ${label} ${projectId} not found — skipping advance`)
        return
      }
      const startDate = proj.start_date ?? null
      const nextStatus = (!startDate || String(startDate).slice(0, 10) <= todayStr) ? 'active' : 'scheduled'
      const { error: projErr } = await supabase
        .from('projects')
        .update({ status: nextStatus, updated_at: signedAt })
        .eq('id', projectId)
        .eq('status', 'draft')
      if (projErr) {
        console.warn(`[contract-sign] ${label} advance failed for ${projectId}: ${projErr.message}`)
      }
    }

    // Advance the primary project.
    if (contract.project_id) {
      await advanceProject(contract.project_id, 'primary project')
    }

    // Hybrid contracts: advance each additional linked project. Added
    // 2026-04-24 for hybrid buildout+retainer contracts (Madyson et al.)
    // where a single sign event needs to move >1 project out of draft.
    // Invoice synthesis for retainers is NOT triggered here — retainer
    // invoices are owned by the generate-retainer-invoices cron, which
    // wakes once per month on cycle_day. Firing an invoice here would
    // double-bill on the first cycle.
    const relatedIds: string[] = Array.isArray(contract.related_project_ids)
      ? contract.related_project_ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : []
    for (const relatedId of relatedIds) {
      if (relatedId === contract.project_id) continue // belt-and-suspenders, trigger already forbids this
      await advanceProject(relatedId, 'related project')
    }

    // Confirmation emails — fire-and-forget. Includes the signing URL so the
    // signer can revisit the page anytime to view + download a PDF of the
    // fully-executed contract (required for ESIGN §101(d) record retention).
    const title = contract.name || 'Contract'
    const legalName = contract.clients?.legal_name || contract.clients?.name || BRAND_NAME
    const SIGNING_BASE_URL = Deno.env.get('SIGNING_BASE_URL') || 'https://app.laviolette.io/sign'
    const signedViewUrl = `${SIGNING_BASE_URL}?token=${postToken}`
    const confirmHtml = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:#12100D;color:#F4F0E8;padding:32px 28px;">
  <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:28px;color:#F4F0E8;margin-bottom:16px;">Contract signed</h2>
  <p style="line-height:1.65;opacity:0.86;">This confirms that <strong style="color:${BRAND_COLOR};font-weight:500;">${esc(signer_name)}</strong> has signed <strong>${esc(title)}</strong> on behalf of <strong>${esc(legalName)}</strong>.</p>
  <p style="margin:24px 0;"><a href="${signedViewUrl}" style="display:inline-block;background:${BRAND_COLOR};color:#12100D;text-decoration:none;padding:12px 24px;border-radius:4px;font-family:'Barlow Condensed',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">View &amp; download signed copy</a></p>
  <p style="color:rgba(244,240,232,0.55);font-size:12px;line-height:1.55;">Save the fully-executed agreement as a PDF via your browser's print-to-PDF option once the signed page loads. This link keeps working — bookmark it for your records.</p>
  <p style="color:rgba(244,240,232,0.42);font-size:12px;margin-top:20px;">Signed at ${new Date().toLocaleString('en-US')} from IP ${esc(signerIp)}.</p>
  <p style="color:rgba(244,240,232,0.42);font-size:11px;margin-top:16px;padding-top:16px;border-top:1px solid rgba(244,240,232,0.1);letter-spacing:1px;">From ${esc(BRAND_NAME)}.</p>
</div>`

    // Send signer + Case confirmation emails. Each tracks its own success/failure
    // and persists to notification_failures on Resend error so Case has visibility
    // in the Notifications page (instead of lost Promise.allSettled rejections).
    const sendConfirm = async (params: {
      from: string; to: string; bcc?: string[]; replyTo?: string;
      subject: string; html: string; context: string;
    }) => {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: params.from,
            to: [params.to],
            ...(params.bcc?.length ? { bcc: params.bcc } : {}),
            reply_to: params.replyTo || undefined,
            subject: params.subject,
            html: params.html,
          }),
        })
        if (!res.ok) {
          const errText = await res.text()
          console.error(`[${params.context}] Resend failed: ${res.status} ${errText}`)
          await supabase.from('notification_failures').insert({
            kind: 'contract_sign_confirmation', context: params.context,
            subject: params.subject, to_email: params.to,
            error: `${res.status}: ${errText.slice(0, 500)}`,
            payload: { from: params.from, reply_to: params.replyTo, html: params.html },
          }).then(() => {}, (e) => console.error(`persist failed: ${(e as Error).message}`))
        }
      } catch (e) {
        console.error(`[${params.context}] send threw: ${(e as Error).message}`)
      }
    }
    // Fire both without awaiting the response (the POST to contract-sign returns
    // 200 immediately; emails complete async). Individual failures persist to DLQ.
    const confirmPromises: Promise<void>[] = []
    if (contract.signer_email) {
      confirmPromises.push(sendConfirm({
        from: `${BRAND_NAME} <${BRAND_FROM_EMAIL}>`,
        to: contract.signer_email,
        bcc: [CASE_NOTIFY],
        replyTo: BRAND_REPLY_TO,
        subject: `Signed: ${title}`,
        html: confirmHtml,
        context: `contract-sign:signer-confirm:${contract.id}`,
      }))
    }
    confirmPromises.push(sendConfirm({
      from: `${BRAND_NAME} Contracts <${BRAND_FROM_EMAIL}>`,
      to: CASE_NOTIFY,
      replyTo: contract.signer_email || BRAND_REPLY_TO,
      subject: `Contract signed: ${title} by ${signer_name}`,
      html: confirmHtml,
      context: `contract-sign:case-confirm:${contract.id}`,
    }))
    // Fire-and-forget but we're tracking failures in DLQ
    Promise.allSettled(confirmPromises)

    // Unified onboarding branch (feature-flagged, buildout-only). When the
    // flag is ON and this is a fresh buildout project (no non-void invoices
    // yet), synthesize the invoice + Stripe Checkout session for bank-linking
    // + fire a single send-invoice call that renders the bank-link CTA in the
    // same email as the invoice document. Replaces the existing "send-invoice
    // for pre-existing pending rows" loop when it fires successfully.
    let unifiedInvoiceId: string | null = null
    let unifiedBankLinkUrl: string | null = null
    let unifiedSkipExistingLoop = false

    if (ENABLE_UNIFIED_ONBOARDING && contract.type === 'buildout' && contract.project_id) {
      // Idempotency: any non-void invoice on this project means we've been
      // here before (or an operator pre-created one via the old path). Skip
      // synthesis and let the existing loop fire send-invoice for pending rows.
      const { count: existingCount, error: countErr } = await supabase
        .from('invoices')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', contract.project_id)
        .neq('status', 'void')
      if (countErr) {
        console.error(`[contract-sign:unified] idempotency check failed: ${countErr.message}`)
        // Don't fail the sign — fall through to existing loop as a conservative default.
      } else if (existingCount && existingCount > 0) {
        console.warn(`[contract-sign:unified] project ${contract.project_id} already has ${existingCount} non-void invoice(s); skipping synthesis, falling through.`)
      } else {
        // Synthesize. Structured as a nested async so each stage reports its
        // own failure context for the DLQ payload.
        type SynthResult =
          | { ok: true; invoice_id: string; invoice_number: string; bank_link_url: string }
          | { ok: false; error: string; stage: string }
        const synthesize = async (): Promise<SynthResult> => {
          if (!STRIPE_SECRET_KEY) {
            return { ok: false, error: 'STRIPE_SECRET_KEY not configured', stage: 'preflight' }
          }
          // Load the client for stripe_customer_id + display name
          const { data: clientRow, error: clientErr } = await supabase
            .from('clients')
            .select('stripe_customer_id, legal_name, name')
            .eq('id', contract.client_id)
            .single()
          if (clientErr || !clientRow) {
            return { ok: false, error: `Failed to load client: ${clientErr?.message || 'not found'}`, stage: 'client-load' }
          }
          if (!clientRow.stripe_customer_id) {
            return { ok: false, error: 'Client has no stripe_customer_id — set one on the Contacts page.', stage: 'client-preflight' }
          }
          // Contract must have a positive total_fee + a future-or-today due date
          const totalFee = parseFloat(String(contract.total_fee ?? 0))
          if (!(totalFee > 0)) {
            return { ok: false, error: `Contract total_fee must be positive (got ${contract.total_fee}).`, stage: 'contract-preflight' }
          }
          if (!contract.effective_date) {
            return { ok: false, error: 'Contract has no effective_date — cannot derive due_date for invoice.', stage: 'contract-preflight' }
          }
          // Stripe Checkout session FIRST so a failure leaves no orphan invoice
          const stripe = new Stripe(STRIPE_SECRET_KEY)
          const clientDisplayName = clientRow.legal_name || clientRow.name || ''
          // Compose success_url via URL API so it remains correct even if
          // STRIPE_SUCCESS_URL ever contains existing query params (naive
          // string concat with `?client=` would produce a malformed URL
          // with two `?` separators). Audit 2026-04-22 A2 LOW.
          const successUrl = new URL(STRIPE_SUCCESS_URL)
          successUrl.searchParams.set('client', clientDisplayName)
          let session: Stripe.Checkout.Session
          try {
            session = await stripe.checkout.sessions.create({
              customer: clientRow.stripe_customer_id,
              mode: 'setup',
              payment_method_types: ['us_bank_account'],
              payment_method_options: {
                us_bank_account: {
                  financial_connections: { permissions: ['payment_method'] },
                  verification_method: 'instant',
                },
              },
              success_url: successUrl.toString(),
              cancel_url: STRIPE_CANCEL_URL,
              metadata: {
                laviolette_contract_id: contract.id,
              },
            })
          } catch (e) {
            return { ok: false, error: `Stripe Checkout session creation failed: ${(e as Error).message}`, stage: 'stripe-checkout' }
          }
          if (!session.url) {
            return { ok: false, error: 'Stripe returned a session without a URL.', stage: 'stripe-checkout' }
          }
          // Allocate invoice number via the LV-YYYY-NNN RPC
          const { data: seq, error: seqErr } = await supabase.rpc('next_invoice_number')
          if (seqErr || typeof seq !== 'string') {
            return { ok: false, error: `Failed to allocate invoice number: ${seqErr?.message || 'unexpected return type'}`, stage: 'invoice-number' }
          }
          // Insert the invoice WITH bank_link_url already populated so the
          // send-invoice template always sees a consistent state — it either
          // has the URL or doesn't, never transiently-null during render.
          const { data: newInv, error: insErr } = await supabase
            .from('invoices')
            .insert({
              invoice_number: seq,
              project_id: contract.project_id,
              brand_id: contract.brand_id,
              client_id: contract.client_id,
              description: contract.name,
              line_items: [{ description: contract.name, amount: totalFee }],
              subtotal: totalFee,
              tax: 0,
              total: totalFee,
              status: 'pending',
              due_date: contract.effective_date,
              payment_method: 'stripe_ach',
              bank_link_url: session.url,
            })
            .select('id, invoice_number')
            .single()
          if (insErr || !newInv) {
            // Stripe session is already created — it orphans harmlessly in 24h.
            return { ok: false, error: `Invoice insert failed: ${insErr?.message || 'no row returned'}`, stage: 'invoice-insert' }
          }
          // Backfill the Stripe session metadata with invoice_id for audit trail.
          // Non-fatal: the webhook doesn't rely on this metadata — it uses
          // session.customer to find the client row. Best-effort only.
          //
          // Setup-mode caveat: the public Stripe API docs for
          // checkout.sessions.update don't explicitly enumerate which modes
          // accept metadata updates. Empirically metadata is a universal
          // Stripe primitive and this has worked in practice, but if Stripe
          // ever tightens setup-mode restrictions, we need enough context in
          // the log to correlate session ↔ invoice without re-querying Stripe.
          try {
            await stripe.checkout.sessions.update(session.id, {
              metadata: {
                laviolette_contract_id: contract.id,
                laviolette_invoice_id: newInv.id,
              },
            })
          } catch (e) {
            const errMsg = (e as Error).message
            const stripeErr = e as { code?: string; type?: string; statusCode?: number }
            const errCode = stripeErr.code || stripeErr.type || 'unknown'
            const statusCode = stripeErr.statusCode ?? 'n/a'
            console.error(
              `[contract-sign:unified] checkout.sessions.update metadata backfill failed (non-fatal). ` +
              `session=${session.id} invoice=${newInv.id} (${newInv.invoice_number}) ` +
              `contract=${contract.id} stripe_status=${statusCode} stripe_code=${errCode} ` +
              `msg=${errMsg.slice(0, 300)}`
            )
            // Soft DLQ so audit-trail gap is visible — resolved=dismissed
            // so it doesn't clutter the open-failures view. Audit 2026-04-22
            // A2 LOW.
            try {
              await supabase.from('notification_failures').insert({
                kind: 'internal',
                context: `contract-sign:metadata-backfill:${session.id}`,
                subject: `ℹ Stripe session metadata backfill failed (non-fatal)`,
                to_email: CASE_NOTIFY,
                error: errMsg.slice(0, 300),
                payload: {
                  contract_id: contract.id,
                  invoice_id: newInv.id,
                  invoice_number: newInv.invoice_number,
                  session_id: session.id,
                  stripe_status: statusCode,
                  stripe_code: errCode,
                  note: 'Session metadata only carries laviolette_contract_id; laviolette_invoice_id is missing. Webhook uses session.customer, so no runtime breakage — audit trail is degraded.',
                },
                resolved_at: new Date().toISOString(),
                resolution: 'dismissed',
              })
            } catch (persistErr) {
              console.error(`[contract-sign:unified] metadata-backfill DLQ insert failed: ${(persistErr as Error).message}`)
            }
          }
          // Fire send-invoice fire-and-forget. send-invoice is idempotent via
          // sent_date and persists its own DLQ entries on Resend failure, so
          // HTTP-level errors here never block the sign response. BUT pre-HTTP
          // failures (DNS, auth, Deno runtime) bypass the callee's DLQ — so
          // we persist our own DLQ row here as a safety net (audit 2026-04-23
          // M2). Without this the invoice sits with sent_date=null silently.
          fetch(`${FUNC_BASE}/send-invoice?key=${encodeURIComponent(REMINDERS_SECRET)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoice_id: newInv.id }),
          }).then(async (r) => {
            if (!r.ok) {
              const txt = await r.text()
              console.error(`[contract-sign:unified] send-invoice ${newInv.invoice_number} returned ${r.status}: ${txt.slice(0, 200)}`)
            } else {
              console.log(`[contract-sign:unified] send-invoice fired for ${newInv.invoice_number}`)
            }
          }).catch(async (e) => {
            const msg = (e as Error).message
            console.error(`[contract-sign:unified] send-invoice fetch failed: ${msg}`)
            try {
              await supabase.from('notification_failures').insert({
                kind: 'internal',
                context: `contract-sign:unified:send-invoice-dispatch-failure:${newInv.id}`,
                subject: `⚠ send-invoice dispatch failed (unified): ${newInv.invoice_number}`,
                to_email: CASE_NOTIFY,
                error: msg.slice(0, 500),
                payload: { invoice_id: newInv.id, invoice_number: newInv.invoice_number, branch: 'unified', error: msg.slice(0, 500) },
              })
            } catch (persistErr) {
              console.error(`[contract-sign:unified] DLQ persist for dispatch failure itself failed: ${(persistErr as Error).message}`)
            }
          })
          return { ok: true, invoice_id: newInv.id, invoice_number: newInv.invoice_number, bank_link_url: session.url }
        }
        const result = await synthesize()
        if (!result.ok) {
          // Contract is already signed — can't roll back. Log to DLQ so Case
          // gets an alert + has recovery context (project_id, contract_id,
          // failure stage). Manual recovery: `npm run stripe-setup` + create
          // invoice via the Money tab.
          await supabase.from('notification_failures').insert({
            kind: 'internal',
            context: `contract-sign:bank-link-failure:${contract.id}`,
            subject: `⚠ Unified onboarding failed (${result.stage}): ${contract.name}`,
            to_email: CASE_NOTIFY,
            error: result.error.slice(0, 500),
            payload: {
              contract_id: contract.id,
              project_id: contract.project_id,
              client_id: contract.client_id,
              stage: result.stage,
              error: result.error.slice(0, 500),
              note: 'Contract is signed. Synthesis failed AFTER sign commit. Manual recovery: npm run stripe-setup for bank-link, then create invoice via Money tab.',
            },
          }).then(() => {}, (e) => console.error(`[contract-sign:unified] DLQ persist failed: ${(e as Error).message}`))
          return json({
            success: false,
            error: 'Invoice synthesis failed after sign. Case has been alerted and will follow up.',
            contract_signed: true,
          }, 500, corsHeaders)
        }
        unifiedInvoiceId = result.invoice_id
        unifiedBankLinkUrl = result.bank_link_url
        unifiedSkipExistingLoop = true
      }
    }

    // Auto-send any pending invoices for this contract's project. The client
    // gets their invoice document immediately on signing — before any ACH
    // charge fires. send-invoice is idempotent (skips if sent_date already set)
    // and persists send failures to the DLQ on its own, so this fire-and-forget
    // is safe and non-blocking.
    //
    // Skipped when the unified onboarding branch above fired successfully —
    // it already invoked send-invoice for the newly-synthesized row, and
    // re-firing here would double-send the invoice email.
    if (contract.project_id && !unifiedSkipExistingLoop) {
      const { data: pendingInvoices } = await supabase
        .from('invoices')
        .select('id, invoice_number')
        .eq('project_id', contract.project_id)
        .eq('status', 'pending')
        .is('sent_date', null)
      if (pendingInvoices && pendingInvoices.length > 0) {
        // Module-scope FUNC_BASE + REMINDERS_SECRET (hoisted 2026-04-23).
        for (const inv of pendingInvoices) {
          fetch(`${FUNC_BASE}/send-invoice?key=${encodeURIComponent(REMINDERS_SECRET)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoice_id: inv.id }),
          }).then(async (r) => {
            if (!r.ok) {
              const txt = await r.text()
              console.error(`[contract-sign] send-invoice ${inv.invoice_number} returned ${r.status}: ${txt.slice(0, 200)}`)
            } else {
              console.log(`[contract-sign] send-invoice fired for ${inv.invoice_number}`)
            }
          }).catch(async (e) => {
            // Pre-HTTP failure — callee's DLQ doesn't catch this (audit 2026-04-23 M2).
            const msg = (e as Error).message
            console.error(`[contract-sign] send-invoice fetch failed for ${inv.invoice_number}: ${msg}`)
            try {
              await supabase.from('notification_failures').insert({
                kind: 'internal',
                context: `contract-sign:send-invoice-dispatch-failure:${inv.id}`,
                subject: `⚠ send-invoice dispatch failed: ${inv.invoice_number}`,
                to_email: CASE_NOTIFY,
                error: msg.slice(0, 500),
                payload: { invoice_id: inv.id, invoice_number: inv.invoice_number, branch: 'pending-loop', error: msg.slice(0, 500) },
              })
            } catch (persistErr) {
              console.error(`[contract-sign] DLQ persist for dispatch failure itself failed: ${(persistErr as Error).message}`)
            }
          })
        }
      }
    }

    return json({
      success: true,
      ...(unifiedInvoiceId ? { invoice_id: unifiedInvoiceId, bank_link_url: unifiedBankLinkUrl } : {}),
    }, 200, corsHeaders)
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders })
})
