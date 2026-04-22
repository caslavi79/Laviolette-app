// generate-retainer-invoices
// Runs on the 1st of every month (via pg_cron). Generates draft invoices for
// the UPCOMING month (not the current one) so auto-push-invoices can fire on
// the business day BEFORE the due date per Case's charge-ahead spec.
// Example: runs May 1 → creates invoices with due_date=June 1 → auto-push fires
// May 29 (Fri before Mon June 1) → ACH lands in client's bank on June 1.
//
// Idempotent on (project_id, period_month) via the UNIQUE partial index
// invoices_project_period_month_unique.
//
// Does NOT call Stripe — the charge is initiated later by auto-push-invoices
// at 4:05 PM CT on the business day before the due date.

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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (SECRET && url.searchParams.get('key') !== SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  const now = new Date()
  // Generate for the UPCOMING month — running on the 1st creates NEXT month's
  // invoices so auto-push-invoices can fire on the business day BEFORE the due
  // date (per Case's 2026-04-16 spec). Constructed as YYYY-MM-01 strings
  // directly (not `new Date(...).toISOString()`) to avoid local-vs-UTC drift.
  const curMonth = now.getMonth()
  const targetYear = curMonth === 11 ? now.getFullYear() + 1 : now.getFullYear()
  const targetMonth = (curMonth + 1) % 12 // 0-indexed
  const monthStart = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-01`
  const dueDate = monthStart // contract: "due on the 1st"
  const monthLabel = new Date(Date.UTC(targetYear, targetMonth, 1)).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })

  // Load retainer projects eligible for next-month invoicing:
  //   - status='active': already in-service retainers (most months, all match here)
  //   - status='scheduled' AND start_date<=monthStart: a signed retainer whose
  //     start_date arrives no later than the target period's first day. Matters
  //     on the 1st of the month when generate-retainer-invoices (00:01 CT) runs
  //     BEFORE advance-contract-status (05:05 CT) flips scheduled→active;
  //     without this acceptance, Dustin's 3 May-1 retainers would miss their
  //     first June invoice generation on May 1 00:01.
  // Decoupled from cron-ordering by filtering on start_date instead of
  // counting on the advance-cron to have run first.
  const { data: projectsRaw, error: projectsErr } = await admin
    .from('projects')
    .select('id, name, total_fee, brand_id, type, status, start_date, brands(id, name, client_id)')
    .eq('type', 'retainer')
    .in('status', ['active', 'scheduled'])
    .not('total_fee', 'is', null)

  // Exclude scheduled retainers whose start_date is after the target period
  // start. A retainer starting June 15 wouldn't get billed for June 1; it'd
  // get billed for July 1 instead. Non-issue for Case's current 1st-of-month
  // retainers but defense-in-depth for any future mid-month starts. Active
  // retainers pass through unconditionally.
  const projects = (projectsRaw || []).filter((p: { status: string; start_date: string | null }) =>
    p.status === 'active' || (p.start_date != null && p.start_date <= monthStart)
  )

  if (projectsErr) {
    console.error('generate-retainer-invoices: failed to load projects:', projectsErr.message)
    return new Response(JSON.stringify({ ok: false, error: 'failed to load projects' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (projects.length === 0) {
    return new Response(JSON.stringify({ ok: true, created: 0, reason: 'No eligible retainers (active or scheduled-starting-by-target-month)' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const created: string[] = []
  const skipped: string[] = []
  const errors: { project: string; error: string }[] = []

  for (const p of projects) {
    const projectName = p.name
    const clientId = p.brands?.client_id
    if (!clientId) {
      skipped.push(`${projectName} (no client_id)`)
      continue
    }

    // Idempotency key = (project_id, period_month). The UNIQUE partial index
    // invoices_project_period_month_unique guarantees at most one per (project, period_month).
    const { data: existing } = await admin
      .from('invoices')
      .select('id, invoice_number')
      .eq('project_id', p.id)
      .eq('period_month', monthStart)
      .maybeSingle()

    if (existing) {
      skipped.push(`${projectName} (already has ${existing.invoice_number} for ${monthStart})`)
      continue
    }

    // Generate invoice number
    const { data: seq, error: seqErr } = await admin.rpc('next_invoice_number')
    if (seqErr) {
      errors.push({ project: projectName, error: `seq: ${seqErr.message}` })
      continue
    }
    const invoice_number = typeof seq === 'string' ? seq : `LV-${targetYear}-001`

    const description = `${p.brands?.name || p.name} Retainer — ${monthLabel}`
    const fee = parseFloat(String(p.total_fee)) || 0

    const { data: inserted, error: insErr } = await admin
      .from('invoices')
      .insert({
        client_id: clientId,
        brand_id: p.brand_id,
        project_id: p.id,
        invoice_number,
        description,
        line_items: [{ description, amount: fee }],
        subtotal: fee,
        tax: 0,
        total: fee,
        status: 'draft',
        due_date: dueDate,
        period_month: monthStart,
      })
      .select('id, invoice_number')
      .single()

    if (insErr) {
      // If the unique index tripped, treat as idempotent skip (race condition — another run beat us)
      if ((insErr as { code?: string }).code === '23505') {
        skipped.push(`${projectName} (race — duplicate for ${monthStart})`)
        continue
      }
      errors.push({ project: projectName, error: insErr.message })
      continue
    }
    if (inserted) created.push(inserted.invoice_number)
  }

  // Persist any errors to the dead-letter queue so Case sees them in the
  // Notifications page (cron response bodies are only visible in Supabase logs).
  if (errors.length > 0) {
    try {
      await admin.from('notification_failures').insert({
        kind: 'internal',
        context: `generate-retainer-invoices:${monthStart}`,
        subject: `⚠ Retainer invoice generation had ${errors.length} error${errors.length === 1 ? '' : 's'}`,
        to_email: 'cron-self-report',
        error: errors.map((e) => `${e.project}: ${e.error}`).join('\n').slice(0, 2000),
        payload: { month: monthLabel, period_month: monthStart, errors },
      })
    } catch (e) {
      console.error(`[generate-retainer-invoices] failed to persist error report: ${(e as Error).message}`)
    }
  }

  const status = errors.length > 0 ? 500 : 200
  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      month: monthLabel,
      period_month: monthStart,
      created,
      skipped,
      errors,
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  )
})
