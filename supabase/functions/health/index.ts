// health
// Lightweight observability endpoint. Returns:
//   - last run time + success status for each pg_cron job
//   - unresolved notification_failures count
//   - any cron job whose last run is older than its expected cadence (stale)
//
// Public GET (no auth). Safe to expose — leaks only job names + timestamps,
// no secrets or financial data. Useful for:
//   - Uptime monitors (curl + grep for "stale":[])
//   - Case's mental check ("is everything running?")
//   - CI / deployment pipelines

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Expected maximum gap between runs for each job. If last run is older than
// this, the job is flagged stale.
const MAX_GAP_HOURS: Record<string, number> = {
  laviolette_generate_daily_rounds: 25, // runs daily
  laviolette_auto_push_invoices: 25,
  laviolette_auto_push_invoices_retry: 25,
  laviolette_check_overdue: 25,
  laviolette_advance_contracts: 25,
  laviolette_send_reminders_am: 25,
  laviolette_retainer_invoices: 24 * 32, // runs monthly on the 1st
}

Deno.serve(async (_req: Request) => {
  const now = Date.now()
  // Query public.get_last_cron_runs() — SECURITY DEFINER function that reads
  // cron.job_run_details on our behalf. Returns last run per laviolette_* job.
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

  // A job is stale only if it HAS a last_run older than its max gap. Jobs that
  // have never run (null) are reported as "pending" — common for the first
  // ~24h after rescheduling. Only mark as stale once we have evidence of a
  // missed fire.
  const stale: Array<{ jobname: string; last_run: string; hours_ago: number }> = []
  const pending: string[] = []
  for (const row of cron) {
    const max = MAX_GAP_HOURS[row.jobname]
    if (!max) continue
    if (!row.last_run) {
      pending.push(row.jobname)
      continue
    }
    const lastRunMs = new Date(row.last_run).getTime()
    if (!Number.isFinite(lastRunMs)) continue
    const hoursAgo = (now - lastRunMs) / (1000 * 60 * 60)
    if (hoursAgo > max) {
      stale.push({ jobname: row.jobname, last_run: row.last_run, hours_ago: Math.round(hoursAgo * 10) / 10 })
    }
  }

  const { count: unresolvedFailures } = await admin
    .from('notification_failures')
    .select('id', { count: 'exact', head: true })
    .is('resolved_at', null)

  const { count: pendingInvoices } = await admin
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  const healthy = stale.length === 0 && (unresolvedFailures || 0) < 5

  return new Response(
    JSON.stringify({
      healthy,
      now: new Date().toISOString(),
      cron: cron.map((r) => ({
        jobname: r.jobname,
        last_run: r.last_run,
        last_status: r.last_status,
      })),
      stale,
      pending,
      unresolved_notification_failures: unresolvedFailures || 0,
      pending_invoices: pendingInvoices || 0,
    }, null, 2),
    { status: healthy ? 200 : 503, headers: { 'Content-Type': 'application/json' } }
  )
})
