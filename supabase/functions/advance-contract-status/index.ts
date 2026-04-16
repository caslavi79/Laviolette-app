// advance-contract-status
// Runs daily. signed → active when effective_date arrives.
// active → expired when end_date < today AND auto_renew=false.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}
const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const SECRET = Deno.env.get('REMINDERS_SECRET') || ''

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function todayMT(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (SECRET && url.searchParams.get('key') !== SECRET) return new Response('Unauthorized', { status: 401 })

  const today = todayMT()

  const { data: activated } = await admin
    .from('contracts')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('status', 'signed')
    .lte('effective_date', today)
    .select('id')

  const { data: expired } = await admin
    .from('contracts')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('status', 'active')
    .eq('auto_renew', false)
    .lt('end_date', today)
    .not('end_date', 'is', null)
    .select('id')

  return new Response(JSON.stringify({ ok: true, activated: (activated || []).length, expired: (expired || []).length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
