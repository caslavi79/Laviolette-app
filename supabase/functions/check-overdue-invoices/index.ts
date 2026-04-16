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

  // Transition pending/sent → overdue (sent invoices that pass due_date
  // without being paid should also be flagged — fixes the sent→pending gap)
  const { data: flipped, error: e1 } = await admin
    .from('invoices')
    .update({ status: 'overdue', updated_at: new Date().toISOString() })
    .in('status', ['pending', 'sent'])
    .lt('due_date', today)
    .select('id')

  // Late-fee flag for overdue invoices past 5 business days
  const { data: feeFlagged, error: e2 } = await admin
    .from('invoices')
    .update({ late_fee_applied: true, updated_at: new Date().toISOString() })
    .eq('status', 'overdue')
    .eq('late_fee_applied', false)
    .lt('due_date', fiveBD)
    .select('id')

  return new Response(JSON.stringify({
    ok: !e1 && !e2,
    flipped_to_overdue: (flipped || []).length,
    late_fee_flagged: (feeFlagged || []).length,
    errors: [e1?.message, e2?.message].filter(Boolean),
  }), { headers: { 'Content-Type': 'application/json' } })
})
