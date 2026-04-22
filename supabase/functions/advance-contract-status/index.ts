// advance-contract-status
// Runs daily at 05:05 CT. Advances date-driven lifecycle states:
//   contracts.signed  → contracts.active   when effective_date <= today
//   contracts.active  → contracts.expired  when end_date < today AND auto_renew=false
//   projects.scheduled → projects.active   when start_date <= today (since
//                                           the 'scheduled' value was added
//                                           2026-04-22, migration 20260422000003)
//
// All three transitions are date-driven, atomic, idempotent (predicate
// guards on current status), and never reverse themselves. A failure on
// any one does not affect the others — each runs independently.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { todayCentral } from '../_shared/business-days.ts'

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
  if (SECRET && url.searchParams.get('key') !== SECRET) return new Response('Unauthorized', { status: 401 })

  const today = todayCentral()

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

  // projects.scheduled → projects.active when start_date <= today.
  // Idempotent: predicate status='scheduled' only matches scheduled rows,
  // so re-runs no-op for already-advanced projects. start_date IS NOT NULL
  // guard defends against schema drift; in practice scheduled is only set
  // by contract-sign when start_date is non-null and future.
  const { data: projectsActivated } = await admin
    .from('projects')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('status', 'scheduled')
    .lte('start_date', today)
    .not('start_date', 'is', null)
    .select('id')

  return new Response(JSON.stringify({
    ok: true,
    activated: (activated || []).length,
    expired: (expired || []).length,
    projects_activated: (projectsActivated || []).length,
  }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
