// generate-monthly-recaps
// Cron-triggered. Runs on the 1st of each month at 08:00 CT.
// For every active retainer project, aggregates the previous month's
// work_log entries and inserts a `monthly_recaps` row with status='draft'.
// Idempotent via the UNIQUE(project_id, month) constraint — re-runs are
// no-ops. Emits an HQ alert to Case when drafts are ready.
//
// Auth: same `?key=<REMINDERS_SECRET>` query-param pattern as
// send-reminders / fire-day-reminder / generate-daily-rounds. Cron URLs
// include the key; public callers don't.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendClientEmail } from '../_shared/client-emails.ts'
import {
  buildRecapSummary,
  buildRecapSubject,
  renderRecapHtml,
  renderDraftsReadyHtml,
  type WorkLogRow,
  type ServiceMeta,
} from '../_shared/recap-template.ts'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')
const REMINDERS_SECRET = env('REMINDERS_SECRET')
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const CASE_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'
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

const TZ = 'America/Chicago'

/** Returns the first-of-last-month in YYYY-MM-DD form, in CT.
 * Running on 2026-06-01 returns "2026-05-01". Running on any day in
 * June returns "2026-05-01". Makes manual invocation predictable. */
function lastMonthStartIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const y = Number(parts.find((p) => p.type === 'year')!.value)
  const m = Number(parts.find((p) => p.type === 'month')!.value)
  const lastY = m === 1 ? y - 1 : y
  const lastM = m === 1 ? 12 : m - 1
  return `${lastY}-${String(lastM).padStart(2, '0')}-01`
}

function firstOfNextMonth(monthIso: string): string {
  const [y, m] = monthIso.split('-').map(Number)
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return `${ny}-${String(nm).padStart(2, '0')}-01`
}

/** Convert a YYYY-MM-01 date (interpreted as midnight CT on that date)
 *  to the corresponding UTC ISO timestamp. Handles DST correctly:
 *  CT is UTC-5 during CDT (March→November) and UTC-6 during CST. We
 *  look up the actual offset at that instant via Intl rather than
 *  hardcoding -06:00, which was wrong for ~8 months of the year. */
function ctMidnightToUtcIso(monthIso: string): string {
  const [y, m, d] = monthIso.split('-').map(Number)
  // Step 1: guess that the UTC instant is that same wall-clock time. This
  // is wrong by exactly the CT offset — we'll correct in step 2.
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0))
  // Step 2: ask Intl what CT thought the wall-clock was at `guess`. The
  // delta tells us the offset at that moment (DST-aware).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(guess)
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const ctWall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  // Offset in minutes: how far ahead/behind CT is of UTC at this moment.
  const offsetMs = guess.getTime() - ctWall
  // Step 3: apply the offset. The UTC instant that equals midnight CT on
  // this date is `guess + offsetMs`.
  return new Date(guess.getTime() + offsetMs).toISOString()
}

/** Regenerate a single existing recap in place — used by the
 *  "Regenerate from log" button in the Recaps tab. Re-runs the
 *  aggregation for the recap's project+month, overwrites
 *  summary_json + html_body + subject if they still match the
 *  default. Leaves notes_internal + status untouched. Rejects if
 *  the recap is already sent. */
async function regenerateOne(
  admin: ReturnType<typeof createClient>,
  recapId: string,
): Promise<{ ok: boolean; error?: string; status?: number; zero_activity?: boolean }> {
  const { data: recap, error: loadErr } = await admin
    .from('monthly_recaps')
    .select(`
      id, project_id, brand_id, month, status, subject, summary_json,
      brands ( id, name ),
      projects ( id, retainer_services ( id, name ) )
    `)
    .eq('id', recapId)
    .maybeSingle()
  if (loadErr) return { ok: false, error: loadErr.message, status: 500 }
  if (!recap) return { ok: false, error: 'recap not found', status: 404 }
  if (recap.status === 'sent') return { ok: false, error: 'cannot regenerate after send', status: 409 }

  const brand = (recap as any).brands
  const project = (recap as any).projects
  const monthIso = String(recap.month).slice(0, 10)
  const monthEndIso = firstOfNextMonth(monthIso)
  const services: ServiceMeta[] = ((project?.retainer_services) || []).map((s: any) => ({ id: s.id, name: s.name }))

  const serviceIds = services.map((s) => s.id)
  const monthStartUtc = ctMidnightToUtcIso(monthIso)
  const monthEndUtc = ctMidnightToUtcIso(monthEndIso)
  let q = admin
    .from('work_log')
    .select('id, title, notes, link_url, performed_at, service_id, count')
    .eq('brand_id', recap.brand_id)
    .gte('performed_at', monthStartUtc)
    .lt('performed_at', monthEndUtc)
    .order('performed_at', { ascending: false })
  if (serviceIds.length > 0) {
    q = q.or(`service_id.in.(${serviceIds.join(',')}),service_id.is.null`)
  } else {
    q = q.is('service_id', null)
  }
  const { data: rows, error: rowsErr } = await q
  if (rowsErr) return { ok: false, error: rowsErr.message, status: 500 }

  const summary = buildRecapSummary({
    brandName: brand.name,
    monthIso,
    rows: (rows || []) as WorkLogRow[],
    services,
  })
  const defaultSubject = buildRecapSubject(brand.name, summary.month_label)
  // Preserve a custom subject if Case edited it.
  const keepSubject = recap.subject && recap.subject !== defaultSubject
  const html_body = renderRecapHtml(summary)

  const { error: updErr } = await admin
    .from('monthly_recaps')
    .update({
      summary_json: summary,
      html_body,
      subject: keepSubject ? recap.subject : defaultSubject,
    })
    .eq('id', recap.id)
  if (updErr) return { ok: false, error: updErr.message, status: 500 }

  return { ok: true, zero_activity: summary.zero_activity }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = cors(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders })

  const url = new URL(req.url)
  const overwriteId = url.searchParams.get('overwrite_id')
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  // Two auth paths:
  //   1. Cron — `?key=<REMINDERS_SECRET>`. Used by pg_cron and manual backfills.
  //   2. Authenticated user — `Authorization: Bearer <token>`. Used ONLY for
  //      the overwrite_id path (Case clicking "Regenerate from log" in the UI),
  //      so we never need to expose the cron secret to the browser.
  const authHeader = req.headers.get('Authorization')
  const hasValidKey = url.searchParams.get('key') === REMINDERS_SECRET
  let hasValidBearer = false
  if (overwriteId && authHeader?.startsWith('Bearer ')) {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await userClient.auth.getUser()
    hasValidBearer = !!user
  }
  if (!hasValidKey && !hasValidBearer) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders })
  }

  // Single-recap regenerate path — overwrites an existing draft in place.
  if (overwriteId) {
    const r = await regenerateOne(supabase, overwriteId)
    if (!r.ok) return new Response(JSON.stringify({ ok: false, error: r.error }), { status: r.status || 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify({ ok: true, mode: 'regenerate', recap_id: overwriteId, zero_activity: r.zero_activity }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  // From here on this is the cron path (ran by pg_cron) — key is required.
  if (!hasValidKey) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

  // Allow ?month=YYYY-MM-DD override for manual re-runs / backfills.
  const overrideMonth = url.searchParams.get('month')
  const monthIso = overrideMonth && /^\d{4}-\d{2}-01$/.test(overrideMonth)
    ? overrideMonth
    : lastMonthStartIso()
  const monthEndIso = firstOfNextMonth(monthIso)

  // 1. Active retainer projects + their services + their brand.
  const { data: projects, error: projErr } = await supabase
    .from('projects')
    .select(`
      id, brand_id,
      brands ( id, name ),
      retainer_services ( id, name )
    `)
    .eq('type', 'retainer')
    .eq('status', 'active')

  if (projErr) {
    console.error(`[generate-monthly-recaps] project load failed: ${projErr.message}`)
    return Response.json({ ok: false, error: projErr.message }, { status: 500 })
  }

  const results: Array<{ project_id: string; brand_name: string; status: 'created' | 'skipped_exists' | 'error'; zero_activity: boolean; recap_id?: string; error?: string }> = []
  const newDrafts: Array<{ brand_name: string; month_iso: string; recap_id: string; project_id: string; zero_activity: boolean }> = []

  for (const p of projects || []) {
    const brand = (p as any).brands
    if (!brand) {
      results.push({ project_id: p.id, brand_name: '(unknown)', status: 'error', zero_activity: false, error: 'brand missing' })
      continue
    }

    // 2. Fetch work_log rows for this brand in the covered month.
    //    Only entries whose service belongs to this project (or NULL, "General").
    //    Boundaries use DST-aware CT midnight → UTC conversion (see
    //    ctMidnightToUtcIso) so entries near midnight on the 1st/31st
    //    during CDT periods land in the correct month.
    const serviceIds = ((p as any).retainer_services || []).map((s: any) => s.id) as string[]
    const monthStartUtc = ctMidnightToUtcIso(monthIso)
    const monthEndUtc = ctMidnightToUtcIso(monthEndIso)
    let q = supabase
      .from('work_log')
      .select('id, title, notes, link_url, performed_at, service_id, count')
      .eq('brand_id', brand.id)
      .gte('performed_at', monthStartUtc)
      .lt('performed_at', monthEndUtc)
      .order('performed_at', { ascending: false })
    if (serviceIds.length > 0) {
      q = q.or(`service_id.in.(${serviceIds.join(',')}),service_id.is.null`)
    } else {
      q = q.is('service_id', null)
    }
    const { data: rows, error: rowsErr } = await q
    if (rowsErr) {
      results.push({ project_id: p.id, brand_name: brand.name, status: 'error', zero_activity: false, error: rowsErr.message })
      continue
    }

    const services: ServiceMeta[] = ((p as any).retainer_services || []).map((s: any) => ({ id: s.id, name: s.name }))
    const summary = buildRecapSummary({
      brandName: brand.name,
      monthIso,
      rows: (rows || []) as WorkLogRow[],
      services,
    })
    const subject = buildRecapSubject(brand.name, summary.month_label)
    const html_body = renderRecapHtml(summary)

    // 3a. Zero-activity DLQ alert — written BEFORE the recap insert so
    //     re-invocations still get the audit even when the recap row
    //     already exists (skipped_exists path below). Deduped by exact
    //     context string: `monthly-recap:zero-activity:<project_id>:<monthIso>`.
    //     Future queries for "all zero-activity alerts in May" can use:
    //       WHERE context LIKE 'monthly-recap:zero-activity:%:2026-05-01'
    if (summary.zero_activity) {
      const zeroCtx = `monthly-recap:zero-activity:${p.id}:${monthIso}`
      const { count: existingAlertCount } = await supabase
        .from('notification_failures')
        .select('id', { count: 'exact', head: true })
        .eq('context', zeroCtx)
      if ((existingAlertCount || 0) === 0) {
        await supabase.from('notification_failures').insert({
          kind: 'internal',
          context: zeroCtx,
          subject: `No activity logged for ${brand.name} in ${summary.month_label}`,
          to_email: CASE_EMAIL,
          error: 'zero_activity',
          payload: {
            project_id: p.id,
            brand_name: brand.name,
            month: monthIso,
            hint: 'Review before send, or skip this month. Regenerate after logging late entries.',
          },
        }).then(() => {}).catch((e) => {
          console.error(`[generate-monthly-recaps] DLQ insert failed: ${(e as Error).message}`)
        })
      }
    }

    // 3b. Insert draft. UNIQUE (project_id, month) makes this idempotent.
    const { data: inserted, error: insErr } = await supabase
      .from('monthly_recaps')
      .insert({
        project_id: p.id,
        brand_id: brand.id,
        month: monthIso,
        status: 'draft',
        subject,
        html_body,
        summary_json: summary,
      })
      .select('id')
      .single()

    if (insErr) {
      // Unique violation → recap already exists for this project+month.
      if (insErr.code === '23505') {
        results.push({ project_id: p.id, brand_name: brand.name, status: 'skipped_exists', zero_activity: summary.zero_activity })
        continue
      }
      results.push({ project_id: p.id, brand_name: brand.name, status: 'error', zero_activity: summary.zero_activity, error: insErr.message })
      continue
    }

    results.push({ project_id: p.id, brand_name: brand.name, status: 'created', zero_activity: summary.zero_activity, recap_id: inserted.id })
    newDrafts.push({
      brand_name: brand.name,
      month_iso: monthIso,
      recap_id: inserted.id,
      project_id: p.id,
      zero_activity: summary.zero_activity,
    })

    // (Zero-activity DLQ alert already handled in 3a above — done there
    // so it fires even when this insert skips due to UNIQUE violation.)
  }

  // 5. Send a single HQ "N drafts ready" email, only if we created
  //    anything new this run.
  if (newDrafts.length > 0) {
    const monthLabel = new Date(`${monthIso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    const { html: alertHtml } = { html: renderDraftsReadyHtml({ draftCount: newDrafts.length, monthLabel, drafts: newDrafts, appUrl: APP_URL }) }
    const alertSubject = `${newDrafts.length} recap draft${newDrafts.length === 1 ? '' : 's'} ready — ${monthLabel}`
    const from = `Laviolette HQ <${BRAND_FROM_EMAIL}>`
    const emailRes = await sendClientEmail({
      apiKey: RESEND_API_KEY,
      from,
      to: CASE_EMAIL,
      subject: alertSubject,
      html: alertHtml,
      context: `generate-monthly-recaps:hq:${monthIso}`,
    })
    if (!emailRes.ok) {
      console.error(`[generate-monthly-recaps] HQ email failed: ${emailRes.error}`)
      await supabase.from('notification_failures').insert({
        kind: 'internal',
        context: `generate-monthly-recaps:hq:${monthIso}`,
        subject: alertSubject,
        to_email: CASE_EMAIL,
        error: emailRes.error,
        payload: { from, html: alertHtml },
      }).then(() => {}).catch((e) => {
        console.error(`[generate-monthly-recaps] DLQ insert failed: ${(e as Error).message}`)
      })
    }
  }

  return Response.json({
    ok: true,
    month: monthIso,
    created: results.filter((r) => r.status === 'created').length,
    skipped_existing: results.filter((r) => r.status === 'skipped_exists').length,
    errors: results.filter((r) => r.status === 'error').length,
    zero_activity: results.filter((r) => r.zero_activity).length,
    results,
  })
})
