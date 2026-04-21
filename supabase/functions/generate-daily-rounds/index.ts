// generate-daily-rounds
// Runs daily at midnight CT (America/Chicago — Case's clients are in Austin, TX).
// For each brand with an active retainer, creates a daily_rounds row per
// platform (derived from its retainer services' platforms arrays +
// brand.*_url fallbacks) for today. Idempotent via UNIQUE (date, brand_id, platform).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}
const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const SECRET = env('REMINDERS_SECRET')

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (SECRET && url.searchParams.get('key') !== SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  const date = today()

  // Filter also by start_date — a retainer may be `status='active'` (set when
  // the contract is signed) but not yet in service (start_date in the future).
  // Without this check we'd spam daily_rounds rows before the engagement
  // begins, cluttering the Today page with tasks the client hasn't paid for yet.
  // Legacy retainers with NULL start_date are treated as already-running.
  const { data: projects } = await admin
    .from('projects')
    .select('id, brand_id, start_date, brands(id, name, instagram_url, facebook_url, gbp_url, yelp_url, apple_maps_url), retainer_services(name, description, platforms, active)')
    .eq('type', 'retainer')
    .eq('status', 'active')
    .or(`start_date.is.null,start_date.lte.${date}`)

  if (!projects || projects.length === 0) {
    return new Response(JSON.stringify({ ok: true, created: 0, reason: 'No active retainers in-service yet' }), { headers: { 'Content-Type': 'application/json' } })
  }

  const byBrand = new Map<string, { brand_id: string; platforms: Set<string> }>()
  for (const p of projects) {
    if (!p.brands) continue
    const entry = byBrand.get(p.brand_id) || { brand_id: p.brand_id, platforms: new Set<string>() }
    for (const s of p.retainer_services || []) {
      if (!s.active) continue
      for (const pl of (s.platforms || [])) entry.platforms.add(pl)
      const text = `${s.name} ${s.description || ''}`.toLowerCase()
      if (/instagram|ig\b|social/.test(text)) entry.platforms.add('instagram')
      if (/facebook|fb\b|social/.test(text)) entry.platforms.add('facebook')
      if (/google\s*business|gbp|review/.test(text)) entry.platforms.add('gbp')
    }
    if (p.brands.gbp_url) entry.platforms.add('gbp')
    byBrand.set(p.brand_id, entry)
  }

  const rows: { date: string; brand_id: string; platform: string }[] = []
  for (const { brand_id, platforms } of byBrand.values()) {
    for (const platform of platforms) rows.push({ date, brand_id, platform })
  }

  if (rows.length === 0) {
    return new Response(JSON.stringify({ ok: true, created: 0, reason: 'No platforms derived' }), { headers: { 'Content-Type': 'application/json' } })
  }

  // Upsert — avoids duplicate-key failures if already generated
  const { data, error } = await admin
    .from('daily_rounds')
    .upsert(rows, { onConflict: 'date,brand_id,platform', ignoreDuplicates: true })
    .select('id')

  if (error) {
    console.error('generate-daily-rounds error:', error)
    // Persist to dead-letter so the error is visible in the Notifications page
    // rather than buried in Supabase function logs Case never sees.
    try {
      await admin.from('notification_failures').insert({
        kind: 'internal',
        context: `generate-daily-rounds:${date}`,
        subject: `⚠ Daily-rounds generation failed for ${date}`,
        to_email: 'cron-self-report',
        error: error.message?.slice(0, 500) || 'Unknown error',
        payload: { date, rows_attempted: rows.length },
      })
    } catch (e) {
      console.error(`[generate-daily-rounds] failed to persist error report: ${(e as Error).message}`)
    }
    return new Response(JSON.stringify({ ok: false, error: 'Failed to generate rounds' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: true, date, rows_attempted: rows.length, rows_inserted: (data || []).length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
