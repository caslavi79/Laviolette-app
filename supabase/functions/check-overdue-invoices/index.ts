// check-overdue-invoices
// Runs daily at 6am MT. Transitions pending invoices past due_date
// into 'overdue'. Applies the $100 late-fee flag after 5 business days.
//
// This function only flags; it never sends emails by itself — the
// send-reminders digest picks overdue rows up and includes them.

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

function todayMT(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function businessDaysAgo(n: number): string {
  const d = new Date()
  let days = 0
  while (days < n) {
    d.setDate(d.getDate() - 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) days++
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (SECRET && url.searchParams.get('key') !== SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  const today = todayMT()
  const fiveBD = businessDaysAgo(5)

  // Identify candidate invoices for the overdue-transition, scoped to
  // projects that are still billable. Cancelled/complete project
  // invoices shouldn't flip to 'overdue' — the work ended; flagging
  // them overdue would imply Case is chasing payment on engagements
  // that never ran to term. They'd need a void instead.
  const { data: overdueCandidates, error: e0 } = await admin
    .from('invoices')
    .select('id, projects(status)')
    .in('status', ['pending', 'sent'])
    .lt('due_date', today)
  const overdueIds = (overdueCandidates || [])
    .filter((r: any) => !['cancelled','complete'].includes(r.projects?.status))
    .map((r: any) => r.id)

  const { data: flipped, error: e1 } = overdueIds.length === 0
    ? { data: [], error: null }
    : await admin
        .from('invoices')
        .update({ status: 'overdue', updated_at: new Date().toISOString() })
        .in('id', overdueIds)
        .select('id')

  // Same guard for the 5-business-day late-fee flag.
  const { data: feeCandidates, error: e0b } = await admin
    .from('invoices')
    .select('id, projects(status)')
    .eq('status', 'overdue')
    .eq('late_fee_applied', false)
    .lt('due_date', fiveBD)
  const feeIds = (feeCandidates || [])
    .filter((r: any) => !['cancelled','complete'].includes(r.projects?.status))
    .map((r: any) => r.id)

  const { data: feeFlagged, error: e2 } = feeIds.length === 0
    ? { data: [], error: null }
    : await admin
        .from('invoices')
        .update({ late_fee_applied: true, updated_at: new Date().toISOString() })
        .in('id', feeIds)
        .select('id')

  if (e0) console.error('check-overdue-invoices overdue candidate read error:', e0.message)
  if (e0b) console.error('check-overdue-invoices late-fee candidate read error:', e0b.message)

  if (e1) console.error('check-overdue-invoices overdue transition error:', e1.message)
  if (e2) console.error('check-overdue-invoices late fee flag error:', e2.message)

  return new Response(JSON.stringify({
    ok: !e1 && !e2,
    flipped_to_overdue: (flipped || []).length,
    late_fee_flagged: (feeFlagged || []).length,
    errors: [e1 ? 'overdue-transition-failed' : null, e2 ? 'late-fee-flag-failed' : null].filter(Boolean),
  }), { headers: { 'Content-Type': 'application/json' } })
})
