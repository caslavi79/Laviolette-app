// generate-retainer-invoices
// Runs on the 1st of every month (via pg_cron). For each active
// retainer project, creates a draft invoice for that month if one
// doesn't already exist. Idempotent on (project_id, period_month).
//
// Does NOT call Stripe — that's the create-stripe-invoice function
// that Case calls manually (or a follow-up cron) once he reviews.

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
  const year = now.getFullYear()
  const month = now.getMonth()
  const monthStart = new Date(year, month, 1).toISOString().slice(0, 10)
  const monthEnd = new Date(year, month + 1, 0).toISOString().slice(0, 10)
  const monthLabel = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  // Load active retainer projects with brand + client
  const { data: projects } = await admin
    .from('projects')
    .select('id, name, total_fee, brand_id, type, status, brands(id, name, client_id)')
    .eq('type', 'retainer')
    .eq('status', 'active')
    .not('total_fee', 'is', null)

  if (!projects || projects.length === 0) {
    return new Response(JSON.stringify({ ok: true, created: 0, reason: 'No active retainers' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const created: string[] = []
  const skipped: string[] = []

  for (const p of projects) {
    const clientId = p.brands?.client_id
    if (!clientId) { skipped.push(`${p.name} (no client)`); continue }

    // Check if an invoice already exists for this project for this month
    const { data: existing } = await admin
      .from('invoices')
      .select('id')
      .eq('project_id', p.id)
      .gte('due_date', monthStart)
      .lte('due_date', monthEnd)
      .limit(1)
    if (existing && existing.length > 0) { skipped.push(`${p.name} (already invoiced)`); continue }

    const { data: seq } = await admin.rpc('next_invoice_number')
    const invoice_number = typeof seq === 'string' ? seq : `LV-${year}-001`
    const description = `${p.brands?.name || p.name} Retainer — ${monthLabel}`
    const fee = parseFloat(p.total_fee) || 0

    const { data: inserted, error } = await admin
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
        due_date: monthStart,
      })
      .select('id, invoice_number')
      .single()
    if (error) { skipped.push(`${p.name} (error: ${error.message})`); continue }
    if (inserted) created.push(inserted.invoice_number)
  }

  return new Response(JSON.stringify({ ok: true, month: monthLabel, created, skipped }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
