import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fmtDate, fmtMoneyShort, daysUntil, COLORS } from '../lib/format'

/* Map of retainer_service keywords → platform list.
 * Used as a fallback when a brand has active retainers but no daily_rounds
 * have been generated yet for today. */
function platformsFromService(service) {
  const set = new Set()
  const text = `${service.name || ''} ${service.description || ''}`.toLowerCase()
  const plats = service.platforms || []
  plats.forEach((p) => set.add(p))
  if (/instagram|ig\b|social/.test(text)) set.add('instagram')
  if (/facebook|fb\b|social/.test(text)) set.add('facebook')
  if (/google\s*business|gbp|review/.test(text)) set.add('gbp')
  return [...set]
}

const PLATFORM_LABELS = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  gbp: 'Google Business',
  yelp: 'Yelp',
  apple_maps: 'Apple Maps',
}

function todayISO() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function nowDow() {
  return new Date().getDay()
}

export default function Today() {
  const [loading, setLoading] = useState(true)
  const [schedule, setSchedule] = useState([])         // today's schedule entries
  const [rounds, setRounds] = useState([])             // today's daily_rounds rows
  const [retainerBrands, setRetainerBrands] = useState([]) // brands with active retainers
  const [missedYesterday, setMissedYesterday] = useState(0)
  const [weekTasks, setWeekTasks] = useState([])       // this week's retainer_tasks for today's brand
  const [deliverables, setDeliverables] = useState([]) // in-progress deliverables for today's brand
  const [alerts, setAlerts] = useState([])
  const [err, setErr] = useState('')
  const saveTimers = useRef({})

  const today = todayISO()

  const loadAll = useCallback(async () => {
    setErr('')
    try {
      // 1. Today's schedule — overrides first, fall back to template for today's DoW
      const [ovrRes, tplRes] = await Promise.all([
        supabase
          .from('schedule_overrides')
          .select('id, time_block, label, brand_id, brands(id, name, color)')
          .eq('date', today),
        supabase
          .from('schedule_template')
          .select('id, time_block, label, brand_id, sort_order, brands(id, name, color)')
          .eq('day_of_week', nowDow())
          .order('sort_order'),
      ])
      if (ovrRes.error) throw ovrRes.error
      if (tplRes.error) throw tplRes.error
      const todaysSchedule = (ovrRes.data && ovrRes.data.length > 0) ? ovrRes.data : (tplRes.data || [])

      // 2. Today's daily rounds
      const { data: drData, error: drErr } = await supabase
        .from('daily_rounds')
        .select('id, platform, status, checked_at, response_count, notes, brand_id, brands(id, name, color, instagram_url, facebook_url, gbp_url)')
        .eq('date', today)
        .order('brand_id')
      if (drErr) throw drErr

      // 3. Brands with at least one active retainer (for empty-rounds fallback)
      const { data: retProjects, error: retErr } = await supabase
        .from('projects')
        .select('id, brand_id, type, status, brands(id, name, color, instagram_url, facebook_url, gbp_url), retainer_services(id, name, description, cadence, active, platforms)')
        .eq('type', 'retainer')
        .eq('status', 'active')
      if (retErr) throw retErr

      // Collapse by brand
      const byBrand = new Map()
      for (const p of retProjects || []) {
        if (!p.brands) continue
        const b = p.brands
        const platforms = new Set()
        for (const s of p.retainer_services || []) {
          if (!s.active) continue
          for (const pl of platformsFromService(s)) platforms.add(pl)
        }
        // If the brand has social URLs but no services declared them, still include instagram/facebook
        if (b.instagram_url && platforms.size === 0) platforms.add('instagram')
        if (b.facebook_url && platforms.size === 0) platforms.add('facebook')
        if (b.gbp_url) platforms.add('gbp')
        byBrand.set(b.id, { brand: b, platforms: [...platforms] })
      }
      const retainerBrandList = [...byBrand.values()]

      // 4. Yesterday's missed rounds
      const yesterdayDate = new Date()
      yesterdayDate.setDate(yesterdayDate.getDate() - 1)
      const ystr = yesterdayDate.toISOString().slice(0, 10)
      const { count: missedCount } = await supabase
        .from('daily_rounds')
        .select('id', { count: 'exact', head: true })
        .eq('date', ystr)
        .eq('status', 'pending')

      // 5. Determine today's primary brand(s) from the schedule
      const todayBrandIds = todaysSchedule.map((s) => s.brand_id).filter(Boolean)

      // 6. This week's retainer_tasks for today's brands
      let wkTasks = []
      if (todayBrandIds.length > 0) {
        // Week starts Monday locally (ISO week). For simple calc use date_trunc('week') equivalent.
        const now = new Date()
        const dow = now.getDay() || 7 // Sunday=0 → 7
        const monday = new Date(now); monday.setDate(now.getDate() - (dow - 1))
        const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
        const startStr = monday.toISOString().slice(0, 10)
        const endStr = sunday.toISOString().slice(0, 10)
        const { data: wkRows } = await supabase
          .from('retainer_tasks')
          .select('id, title, period_type, period_start, period_end, assigned_date, status, completed_at, brand_id')
          .in('brand_id', todayBrandIds)
          .gte('period_start', startStr)
          .lte('period_end', endStr)
          .order('assigned_date', { nullsFirst: false })
        wkTasks = wkRows || []
      }

      // 7. In-progress/not-started deliverables for today's brands (buildouts)
      let delvs = []
      if (todayBrandIds.length > 0) {
        const { data: delvRows } = await supabase
          .from('deliverables')
          .select('id, number, name, status, notes, projects!inner(id, name, type, status, brand_id)')
          .eq('projects.type', 'buildout')
          .eq('projects.status', 'active')
          .in('projects.brand_id', todayBrandIds)
          .neq('status', 'complete')
          .order('number')
        delvs = delvRows || []
      }

      // 8. Alerts
      const alertRows = []
      const { data: invs } = await supabase
        .from('invoices')
        .select('id, invoice_number, description, total, due_date, status, client_id, clients(name)')
      const nowDate = new Date(); nowDate.setHours(0, 0, 0, 0)
      for (const inv of (invs || [])) {
        if (['paid', 'void', 'draft'].includes(inv.status)) continue
        const du = daysUntil(inv.due_date)
        if (inv.status === 'overdue' || (inv.status === 'pending' && du !== null && du < 0)) {
          alertRows.push({
            color: COLORS.red,
            label: 'OVERDUE',
            text: `${fmtMoneyShort(inv.total)} · ${inv.clients?.name || 'Unknown'} · ${inv.invoice_number}`,
            sub: du !== null ? `${Math.abs(du)} day${Math.abs(du) === 1 ? '' : 's'} overdue` : '',
            link: '/money',
          })
        } else if (inv.status === 'pending' && du !== null && du <= 7) {
          alertRows.push({
            color: COLORS.amber,
            label: 'DUE SOON',
            text: `${fmtMoneyShort(inv.total)} · ${inv.clients?.name || 'Unknown'}`,
            sub: du === 0 ? 'due today' : `due in ${du} day${du === 1 ? '' : 's'}`,
            link: '/money',
          })
        }
      }

      const { data: contracts } = await supabase
        .from('contracts')
        .select('id, name, status, end_date, renewal_notice_days')
        .in('status', ['active', 'signed'])
      for (const c of (contracts || [])) {
        if (!c.end_date) continue
        const du = daysUntil(c.end_date)
        if (du !== null && du >= 0 && du <= (c.renewal_notice_days ?? 30)) {
          alertRows.push({
            color: COLORS.amber,
            label: 'EXPIRING',
            text: c.name,
            sub: du === 0 ? 'expires today' : `${du} day${du === 1 ? '' : 's'} left`,
            link: '/contracts',
          })
        }
      }

      if (missedCount && missedCount > 0) {
        alertRows.push({
          color: COLORS.red,
          label: 'MISSED',
          text: `${missedCount} daily round${missedCount === 1 ? '' : 's'} missed yesterday`,
          sub: '',
          link: null,
        })
      }

      setSchedule(todaysSchedule)
      setRounds(drData || [])
      setRetainerBrands(retainerBrandList)
      setMissedYesterday(missedCount || 0)
      setWeekTasks(wkTasks)
      setDeliverables(delvs)
      setAlerts(alertRows)
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [today])

  useEffect(() => { loadAll() }, [loadAll])

  /* Optimistically toggle a round's checked state + persist.
   * If no round row exists yet (fallback path), insert one. */
  const toggleRound = async (brandId, platform, currentRow) => {
    const optimisticId = currentRow?.id || `tmp-${brandId}-${platform}`
    const nextStatus = currentRow?.status === 'checked' ? 'pending' : 'checked'

    // Update UI first
    setRounds((prev) => {
      const idx = prev.findIndex((r) => r.id === optimisticId || (r.brand_id === brandId && r.platform === platform))
      if (idx === -1) {
        return [
          ...prev,
          {
            id: optimisticId,
            brand_id: brandId,
            platform,
            status: nextStatus,
            checked_at: nextStatus === 'checked' ? new Date().toISOString() : null,
            brands: retainerBrands.find((rb) => rb.brand.id === brandId)?.brand,
          },
        ]
      }
      const next = [...prev]
      next[idx] = { ...next[idx], status: nextStatus, checked_at: nextStatus === 'checked' ? new Date().toISOString() : null }
      return next
    })

    // Debounced persist
    clearTimeout(saveTimers.current[optimisticId])
    saveTimers.current[optimisticId] = setTimeout(async () => {
      if (currentRow?.id) {
        // Update existing row
        await supabase
          .from('daily_rounds')
          .update({
            status: nextStatus,
            checked_at: nextStatus === 'checked' ? new Date().toISOString() : null,
          })
          .eq('id', currentRow.id)
      } else {
        // Upsert new row for today
        const { data } = await supabase
          .from('daily_rounds')
          .upsert(
            {
              date: today,
              brand_id: brandId,
              platform,
              status: nextStatus,
              checked_at: nextStatus === 'checked' ? new Date().toISOString() : null,
            },
            { onConflict: 'date,brand_id,platform' }
          )
          .select('id, platform, status, checked_at, response_count, notes, brand_id, brands(id, name, color, instagram_url, facebook_url, gbp_url)')
          .single()
        if (data) {
          setRounds((prev) => prev.map((r) => (r.id === optimisticId ? data : r)))
        }
      }
    }, 250)
  }

  if (loading) return <div className="loading">Loading today…</div>

  // Decide today's brand(s) for the header/work panel.
  const primaryBrands = schedule
    .filter((s) => s.brand_id && s.brands)
    .map((s) => ({ ...s.brands, time_block: s.time_block, label: s.label }))
  const isFlex = schedule.length > 0 && schedule.every((s) => !s.brand_id)
  const hasSchedule = schedule.length > 0

  // Build rounds matrix: one row per retainer brand with its platforms
  const roundsByBrand = new Map()
  for (const b of retainerBrands) {
    roundsByBrand.set(b.brand.id, { brand: b.brand, platforms: b.platforms, items: {} })
  }
  for (const r of rounds) {
    if (!roundsByBrand.has(r.brand_id)) {
      roundsByBrand.set(r.brand_id, { brand: r.brands, platforms: [r.platform], items: {} })
    }
    const row = roundsByBrand.get(r.brand_id)
    row.items[r.platform] = r
    if (!row.platforms.includes(r.platform)) row.platforms.push(r.platform)
  }
  const roundRows = [...roundsByBrand.values()]

  // Check if all rounds are done
  const allRoundsDone = roundRows.length > 0 && roundRows.every((row) =>
    row.platforms.every((p) => row.items[p]?.status === 'checked')
  )
  const lastCheckTime = [...rounds].filter((r) => r.checked_at).sort((a, b) => (b.checked_at || '').localeCompare(a.checked_at || ''))[0]?.checked_at

  const accentColor = primaryBrands[0]?.color || 'var(--copper)'

  return (
    <div className="today">
      {/* Header */}
      <div className="today-header" style={{ borderLeftColor: accentColor }}>
        <div className="today-header-date">{fmtDate(today, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <div className="today-header-main">
          {primaryBrands.length === 0 && !hasSchedule && (
            <>
              <h1>No schedule set for today</h1>
              <p><Link to="/schedule">Assign today</Link> or take a flex day.</p>
            </>
          )}
          {primaryBrands.length === 0 && isFlex && (
            <>
              <h1>Flex Day</h1>
              <p>No primary brand. Catch up on buildouts, leads, or admin.</p>
            </>
          )}
          {primaryBrands.length > 0 && (
            <>
              <h1>
                Today: {primaryBrands.map((b) => b.name).join(' → ')}
              </h1>
              <p>{primaryBrands.map((b) => `${b.name}${b.time_block === 'all_day' ? '' : ` (${b.time_block})`}`).join(' · ')}</p>
            </>
          )}
        </div>
      </div>

      {err && <div className="login-error" style={{ marginBottom: 16 }}>{err}</div>}

      {/* Daily rounds */}
      <section className="rounds-panel">
        <div className="panel-header">
          <span className="eyebrow">Daily Rounds</span>
          {allRoundsDone && lastCheckTime && (
            <span className="panel-header-sub" style={{ color: COLORS.green }}>
              ✓ Complete · {fmtDate(lastCheckTime, { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          {missedYesterday > 0 && (
            <span className="panel-header-sub" style={{ color: COLORS.red }}>
              {missedYesterday} missed yesterday
            </span>
          )}
        </div>
        {roundRows.length === 0 ? (
          <div className="empty-state">
            <p>No active retainers yet. Add a brand with a retainer project to start daily rounds.</p>
            <Link to="/contacts" className="cta-link">Add a contact →</Link>
          </div>
        ) : (
          <div className="rounds-list">
            {roundRows.map((row) => {
              const brandDone = row.platforms.every((p) => row.items[p]?.status === 'checked')
              return (
                <div key={row.brand.id} className={`rounds-brand ${brandDone ? 'is-done' : ''}`}>
                  <div className="rounds-brand-name" style={{ color: row.brand.color || 'inherit' }}>
                    <span>{row.brand.name}</span>
                    <span className="rounds-brand-links">
                      {row.brand.instagram_url && <a href={row.brand.instagram_url} target="_blank" rel="noreferrer">IG</a>}
                      {row.brand.facebook_url && <a href={row.brand.facebook_url} target="_blank" rel="noreferrer">FB</a>}
                      {row.brand.gbp_url && <a href={row.brand.gbp_url} target="_blank" rel="noreferrer">GBP</a>}
                    </span>
                  </div>
                  <div className="rounds-checks">
                    {row.platforms.map((p) => {
                      const item = row.items[p]
                      const checked = item?.status === 'checked'
                      return (
                        <button
                          key={p}
                          className={`round-btn ${checked ? 'checked' : ''}`}
                          onClick={() => toggleRound(row.brand.id, p, item)}
                          aria-pressed={checked}
                        >
                          <span className="round-btn-box">{checked ? '✓' : ''}</span>
                          <span className="round-btn-label">{PLATFORM_LABELS[p] || p}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Today's work */}
      {(weekTasks.length > 0 || deliverables.length > 0) && (
        <section className="work-panel">
          <div className="panel-header">
            <span className="eyebrow">Today's Work</span>
            <Link to="/projects" className="panel-header-link">All projects →</Link>
          </div>
          {weekTasks.length > 0 && (
            <div className="work-subsection">
              <div className="work-subsection-label">This Week</div>
              <ul className="work-list">
                {weekTasks.map((t) => (
                  <li key={t.id} className={t.status === 'complete' ? 'done' : ''}>
                    <span className="work-check">{t.status === 'complete' ? '✓' : '○'}</span>
                    <span className="work-title">{t.title}</span>
                    {t.assigned_date && <span className="work-meta">{fmtDate(t.assigned_date, { weekday: 'short' })}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {deliverables.length > 0 && (
            <div className="work-subsection">
              <div className="work-subsection-label">Buildout · {deliverables[0].projects?.name}</div>
              <ul className="work-list">
                {deliverables.slice(0, 6).map((d) => (
                  <li key={d.id} className={d.status === 'in_progress' ? 'active' : ''}>
                    <span className="work-check">{d.status === 'in_progress' ? '→' : '○'}</span>
                    <span className="work-title">#{d.number} {d.name}</span>
                  </li>
                ))}
              </ul>
              {deliverables.length > 6 && (
                <Link to="/projects" className="work-more">+ {deliverables.length - 6} more →</Link>
              )}
            </div>
          )}
        </section>
      )}

      {/* Alerts */}
      {alerts.length > 0 && (
        <section className="alerts-bar">
          {alerts.map((a, i) => {
            const content = (
              <>
                <span className="alert-dot" style={{ background: a.color }} />
                <span className="alert-label" style={{ color: a.color }}>{a.label}</span>
                <span className="alert-text">{a.text}</span>
                {a.sub && <span className="alert-sub">{a.sub}</span>}
              </>
            )
            return a.link ? (
              <Link key={i} to={a.link} className="alert-row">{content}</Link>
            ) : (
              <div key={i} className="alert-row">{content}</div>
            )
          })}
        </section>
      )}
    </div>
  )
}
