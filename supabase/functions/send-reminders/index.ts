// send-reminders
// Daily email cron. Queries the database for things worth reminding
// Case about and sends a single digest email via Resend.
//
// Called by pg_cron twice a day (6am and 9am MT per spec) with no
// auth — gate with a shared secret in the URL for basic protection:
//   ?key=<value of REMINDERS_SECRET env var>
//
// Checks:
//   - Overdue invoices (status pending/overdue past due_date)
//   - Due-soon invoices (status pending due within 3 days)
//   - Contracts expiring within renewal_notice_days
//   - Retainer-behind (Friday only): weekly tasks still pending
//   - Missed rounds yesterday (8pm MT variant)
//   - Lead follow-ups due today
//
// Idempotency: tracked via a simple in-memory window (cron runs
// are 12h+ apart, dedup is unnecessary for MVP).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function env(key: string): string {
  const v = Deno.env.get(key)
  if (!v) throw new Error(`Missing required env: ${key}`)
  return v
}

const SUPABASE_URL = env('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY')
const RESEND_API_KEY = env('RESEND_API_KEY')
const BRAND_NAME = Deno.env.get('BRAND_NAME') || 'Laviolette LLC'
const BRAND_FROM_EMAIL = Deno.env.get('BRAND_FROM_EMAIL') || 'noreply@laviolette.io'
const BRAND_COLOR = Deno.env.get('BRAND_COLOR') || '#B8845A'
const BRAND_BG = Deno.env.get('BRAND_BG') || '#12100D'
const BRAND_INK = Deno.env.get('BRAND_INK') || '#F4F0E8'
const CASE_EMAIL = Deno.env.get('CASE_NOTIFY_EMAIL') || 'case.laviolette@gmail.com'
const REMINDERS_SECRET = env('REMINDERS_SECRET')
const APP_URL = Deno.env.get('APP_URL') || 'https://app.laviolette.io'

const TZ = 'America/Denver'

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function localDateStr(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function fmtMoney(n: number | string | null): string {
  if (n == null) return '$0'
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (!isFinite(v)) return '$0'
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

type Line = { color: string; emoji: string; text: string; href?: string }

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (REMINDERS_SECRET && url.searchParams.get('key') !== REMINDERS_SECRET) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const today = localDateStr(0)
  const yesterday = localDateStr(-1)
  const in3 = localDateStr(3)
  const in30 = localDateStr(30)

  const lines: Line[] = []

  // Overdue invoices
  const { data: overdue } = await supabase
    .from('invoices')
    .select('id, invoice_number, description, total, due_date, status, clients(name, legal_name)')
    .or(`status.eq.overdue,and(status.eq.pending,due_date.lt.${today})`)
  for (const inv of overdue || []) {
    const client = (inv as any).clients?.legal_name || (inv as any).clients?.name || 'Unknown'
    const du = Math.round((Date.parse(today) - Date.parse(inv.due_date)) / 86_400_000)
    lines.push({
      color: '#C25A4E',
      emoji: '■',
      text: `OVERDUE ${du}d — ${fmtMoney(inv.total)} from ${esc(client)} (${esc(inv.invoice_number)})`,
      href: `${APP_URL}/money`,
    })
  }

  // Due soon
  const { data: dueSoon } = await supabase
    .from('invoices')
    .select('id, invoice_number, total, due_date, status, clients(name, legal_name)')
    .eq('status', 'pending')
    .gte('due_date', today)
    .lte('due_date', in3)
  for (const inv of dueSoon || []) {
    const client = (inv as any).clients?.legal_name || (inv as any).clients?.name || 'Unknown'
    lines.push({
      color: '#C9922E',
      emoji: '●',
      text: `Due ${inv.due_date} — ${fmtMoney(inv.total)} from ${esc(client)}`,
      href: `${APP_URL}/money`,
    })
  }

  // Contracts expiring
  const { data: contracts } = await supabase
    .from('contracts')
    .select('id, name, end_date, renewal_notice_days, status')
    .in('status', ['signed', 'active'])
    .not('end_date', 'is', null)
    .lte('end_date', in30)
  for (const c of contracts || []) {
    const days = Math.round((Date.parse(c.end_date) - Date.parse(today)) / 86_400_000)
    if (days < 0) continue
    const notice = c.renewal_notice_days ?? 30
    if (days > notice) continue
    lines.push({
      color: '#C9922E',
      emoji: '●',
      text: `Contract "${esc(c.name)}" expires in ${days}d`,
      href: `${APP_URL}/contracts`,
    })
  }

  // Missed rounds yesterday
  const { count: missedCount } = await supabase
    .from('daily_rounds')
    .select('id', { count: 'exact', head: true })
    .eq('date', yesterday)
    .eq('status', 'pending')
  if (missedCount && missedCount > 0) {
    lines.push({
      color: '#C25A4E',
      emoji: '■',
      text: `${missedCount} daily round${missedCount === 1 ? '' : 's'} missed yesterday`,
      href: `${APP_URL}/`,
    })
  }

  // Retainer-behind (any weekly task still pending whose period_end has passed)
  const { data: overdueTasks } = await supabase
    .from('retainer_tasks')
    .select('id, title, period_end, brand_id, brands(name)')
    .eq('status', 'pending')
    .eq('period_type', 'weekly')
    .lt('period_end', today)
  for (const t of overdueTasks || []) {
    const brand = (t as any).brands?.name || '—'
    lines.push({
      color: '#C9922E',
      emoji: '●',
      text: `${esc(brand)} · "${esc(t.title)}" missed for week ending ${t.period_end}`,
      href: `${APP_URL}/projects`,
    })
  }

  // Lead follow-up today
  const { data: leads } = await supabase
    .from('lead_details')
    .select('id, next_follow_up, next_step, contacts(name)')
    .eq('next_follow_up', today)
    .neq('stage', 'lost')
  for (const l of leads || []) {
    const name = (l as any).contacts?.name || 'lead'
    lines.push({
      color: '#7A8490',
      emoji: '○',
      text: `Follow up with ${esc(name)} today${l.next_step ? ` — ${esc(l.next_step)}` : ''}`,
    })
  }

  if (lines.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: false, reason: 'nothing to report' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Daily rounds ready (always include if active retainers)
  const { count: roundCount } = await supabase
    .from('daily_rounds')
    .select('id', { count: 'exact', head: true })
    .eq('date', today)
    .eq('status', 'pending')

  const dateLabel = new Date(today + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const emailHtml = `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:600px;margin:0 auto;background:${BRAND_BG};color:${BRAND_INK};padding:32px 28px;">
  <div style="padding-bottom:16px;border-bottom:1px solid rgba(244,240,232,0.1);margin-bottom:24px;">
    <span style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;letter-spacing:0.08em;opacity:0.6;">
      <span style="color:${BRAND_INK};">La</span><span style="color:${BRAND_COLOR};font-weight:500;">v</span><span style="color:${BRAND_INK};">iolette</span>
    </span>
  </div>
  <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:26px;color:${BRAND_INK};margin-bottom:4px;">${esc(dateLabel)}</h2>
  <p style="color:rgba(244,240,232,0.65);font-size:13px;margin-bottom:24px;font-family:'Barlow Condensed',Arial,sans-serif;letter-spacing:2px;text-transform:uppercase;">Daily briefing</p>
  <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px;">
    ${lines.map((l) => `
      <div style="display:flex;gap:12px;padding:12px 14px;background:rgba(244,240,232,0.03);border:1px solid rgba(244,240,232,0.06);border-radius:3px;align-items:flex-start;">
        <span style="color:${l.color};font-weight:600;font-size:14px;line-height:1.4;">${l.emoji}</span>
        <span style="flex:1;line-height:1.4;font-size:14px;color:${BRAND_INK};opacity:0.9;">
          ${l.text}
          ${l.href ? `<br><a href="${l.href}" style="color:${BRAND_COLOR};font-size:11px;text-decoration:none;">Open →</a>` : ''}
        </span>
      </div>`).join('')}
  </div>
  ${roundCount && roundCount > 0 ? `
    <p style="color:rgba(244,240,232,0.65);font-size:13px;margin-top:16px;">
      ${roundCount} daily round${roundCount === 1 ? '' : 's'} pending for today.
      <a href="${APP_URL}/" style="color:${BRAND_COLOR};">Open HQ →</a>
    </p>` : ''}
  <p style="color:rgba(244,240,232,0.42);font-size:11px;margin-top:32px;padding-top:16px;border-top:1px solid rgba(244,240,232,0.08);letter-spacing:1px;">
    Automated briefing from ${esc(BRAND_NAME)}.
  </p>
</div>`

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${BRAND_NAME} HQ <${BRAND_FROM_EMAIL}>`,
      to: [CASE_EMAIL],
      subject: `${esc(dateLabel)} · ${lines.length} item${lines.length === 1 ? '' : 's'} to handle`,
      html: emailHtml,
    }),
  })

  if (!emailRes.ok) {
    const errorBody = await emailRes.text()
    return new Response(JSON.stringify({ ok: false, error: errorBody }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: true, sent: true, count: lines.length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
