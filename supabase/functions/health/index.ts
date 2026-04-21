// health
// Public observability endpoint. Returns 200 JSON when every laviolette_*
// cron is within its max-gap AND unresolved DLQ count is under threshold;
// 503 otherwise. Every invocation is logged fire-and-forget to the
// health_checks table for time-series visibility in the app.
//
// Consumed by:
//   - UptimeRobot (5-min polls — see docs/MONITORING_SETUP.md)
//   - Manual curl / deployment scripts
//   - The Today "System health" widget + /incidents route (via the same
//     log table, not this endpoint directly)
//
// Design notes:
//   - Stays public. Leaks job names + timestamps only, no secrets.
//   - The response body is intentionally actionable — the "message" field
//     is what shows up in the UptimeRobot alert email subject preview.
//   - health_checks insert is awaited so the row is durable by the time we
//     return, but wrapped in try/catch so a logging failure NEVER turns a
//     healthy status into 503.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const DEPLOY_SHA = (Deno.env.get('DEPLOY_SHA') || 'unknown').slice(0, 7)

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Expected maximum gap between runs per job. If last_run is older than
// this, the job is flagged stale. Each value is the realistic worst-case
// gap + 1h buffer for cron drift + Supabase platform jitter. Thresholds
// were tuned to avoid false-paging on federal-holiday weekends and Feb
// month boundaries.
const MAX_GAP_HOURS: Record<string, number> = {
  // Daily: 24h cadence + 1h buffer. Max realistic gap is 25h on DST drift.
  laviolette_generate_daily_rounds: 25,
  laviolette_auto_push_invoices: 25,
  laviolette_auto_push_invoices_retry: 25,
  laviolette_check_overdue: 25,
  laviolette_advance_contracts: 25,
  laviolette_send_reminders_am: 25,

  // Weekday-only (Mon-Fri). Worst case is Fri → Tue when Monday is a
  // federal holiday (MLK, Presidents Day, Memorial Day, Independence Day
  // observance, Labor Day, Columbus Day, Veterans Day observance,
  // Thanksgiving+day-after, Christmas Eve/Day observance, New Year's).
  // Fri 14:00 → Tue 14:00 = 96h exact. +1h buffer = 97h.
  laviolette_fire_day_reminder: 97,

  // Monthly jobs: fire on the 1st. The longest inter-run gap is Feb 1 →
  // Mar 1 in a non-leap year (28 days = 672h) or Jan 1 → Feb 1 (31 days
  // = 744h). Largest any month can span is 31 days. Use 31 days + 24h
  // buffer to cover DST/platform jitter without triggering mid-Feb.
  laviolette_retainer_invoices: 24 * 32,       // 768h
  laviolette_generate_monthly_recaps: 24 * 32, // 768h
}

const DLQ_THRESHOLD = 5

function detectSource(req: Request): string {
  const ua = (req.headers.get('User-Agent') || '').toLowerCase()
  if (ua.includes('uptimerobot')) return 'uptimerobot'
  // Self-pings from our own cron/scripts don't have a signature distinct
  // from curl. We over-return 'manual' rather than guess.
  return 'manual'
}

function fmtHoursAgo(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 24) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

function buildMessage(stale: Array<{ jobname: string; hours_ago: number }>, dlq: number): string {
  const parts: string[] = []
  if (stale.length === 0 && dlq < DLQ_THRESHOLD) {
    return 'All systems green.'
  }
  if (stale.length === 1) {
    const s = stale[0]
    parts.push(`Stale: ${s.jobname} last ran ${fmtHoursAgo(s.hours_ago)} ago.`)
  } else if (stale.length > 1) {
    const summary = stale
      .map((s) => `${s.jobname.replace(/^laviolette_/, '')} (${fmtHoursAgo(s.hours_ago)})`)
      .join(', ')
    parts.push(`${stale.length} stale crons: ${summary}.`)
  }
  if (dlq >= DLQ_THRESHOLD) {
    parts.push(`${dlq} unresolved notification failure${dlq === 1 ? '' : 's'}.`)
  } else if (dlq > 0 && stale.length === 0) {
    // Non-critical but still worth surfacing — doesn't flip healthy flag.
    parts.push(`${dlq} unresolved notification failure${dlq === 1 ? '' : 's'} (under threshold).`)
  }
  return parts.join(' | ')
}

Deno.serve(async (req: Request) => {
  const t0 = performance.now()
  const source = detectSource(req)

  const { data: cronRows, error: cronErr } = await admin.rpc('get_last_cron_runs')
  if (cronErr) {
    console.error('health: get_last_cron_runs failed:', cronErr.message)
  }
  const cron = (cronRows || []) as Array<{
    jobname: string
    last_run: string | null
    last_status: string | null
    last_return_message: string | null
  }>

  const stale: Array<{ jobname: string; last_run: string; hours_ago: number }> = []
  const pending: string[] = []
  const nowMs = Date.now()
  for (const row of cron) {
    const max = MAX_GAP_HOURS[row.jobname]
    if (!max) continue
    if (!row.last_run) {
      pending.push(row.jobname)
      continue
    }
    const lastRunMs = new Date(row.last_run).getTime()
    if (!Number.isFinite(lastRunMs)) continue
    const hoursAgo = (nowMs - lastRunMs) / (1000 * 60 * 60)
    if (hoursAgo > max) {
      stale.push({
        jobname: row.jobname,
        last_run: row.last_run,
        hours_ago: Math.round(hoursAgo * 10) / 10,
      })
    }
  }

  const { count: unresolvedFailures } = await admin
    .from('notification_failures')
    .select('id', { count: 'exact', head: true })
    .is('resolved_at', null)

  const dlq = unresolvedFailures || 0
  const healthy = stale.length === 0 && dlq < DLQ_THRESHOLD
  const http_status = healthy ? 200 : 503
  const message = buildMessage(stale, dlq)
  const checkedAt = new Date().toISOString()
  const response_ms = Math.round(performance.now() - t0)

  // Log the probe to health_checks. Awaited so the row is durable by
  // the time we return (at 5-min UptimeRobot cadence the ~100ms insert
  // is negligible and having the row committed simplifies debugging),
  // but error-guarded — a logging failure never propagates to the
  // response or flips a healthy 200 into a 503.
  try {
    await admin.from('health_checks').insert({
      checked_at: checkedAt,
      http_status,
      healthy,
      stale_crons: stale,
      unresolved_dlq_count: dlq,
      response_ms,
      source,
    })
  } catch (e) {
    console.error('health: health_checks insert failed:', (e as Error).message)
  }

  return new Response(
    JSON.stringify({
      ok: healthy,
      checked_at: checkedAt,
      stale_crons: stale,
      unresolved_dlq_count: dlq,
      deploy_sha: DEPLOY_SHA,
      message,
      response_ms,
      // Legacy fields kept so pre-existing consumers (uptime curls that
      // check "healthy": true) don't break.
      healthy,
      cron: cron.map((r) => ({
        jobname: r.jobname,
        last_run: r.last_run,
        last_status: r.last_status,
      })),
      pending,
      unresolved_notification_failures: dlq,
    }, null, 2),
    { status: http_status, headers: { 'Content-Type': 'application/json' } },
  )
})
