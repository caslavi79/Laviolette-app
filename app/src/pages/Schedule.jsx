import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtDate } from '../lib/format'
import EditScheduleBlockModal from '../components/forms/EditScheduleBlockModal'

/* Schedule v2 — agenda-style rendering.
 *
 * Data model (migration 20260424000001):
 *   schedule_template:  day_of_week + start_time + end_time + brand + label + notes
 *   schedule_overrides: date + start_time + end_time + kind + brand + label + notes
 *     kind ∈ { 'focus' | 'event' | 'blackout' }
 *
 * Overlay semantics (replaces the old "override replaces entire day"):
 *   - Template blocks for the day's day_of_week ALWAYS render.
 *   - Overrides OVERLAY on top of the template.
 *   - A blackout whose window FULLY COVERS a template block hides that
 *     template block for the specific date (no double-booking visual).
 *   - A focus/event override whose window PARTIALLY overlaps a template
 *     block is shown on top; the template block renders with the
 *     `dimmedByOverride` flag (50% opacity in CSS).
 *   - Overrides render on top of template visually regardless of kind.
 */

const DAYS = [
  { dow: 1, short: 'Mon', long: 'Monday' },
  { dow: 2, short: 'Tue', long: 'Tuesday' },
  { dow: 3, short: 'Wed', long: 'Wednesday' },
  { dow: 4, short: 'Thu', long: 'Thursday' },
  { dow: 5, short: 'Fri', long: 'Friday' },
  { dow: 6, short: 'Sat', long: 'Saturday' },
  { dow: 0, short: 'Sun', long: 'Sunday' },
]

// Agenda timeline: default working hours window. Blocks outside this
// range still render, but we pin the hour grid to 08:00-18:00 and
// clip overflow (content stays visible — sticks at the edges).
const HOUR_MIN = 8
const HOUR_MAX = 18
const ROW_HEIGHT_PX = 48  // per hour

const KIND_BADGE = {
  focus:    { label: 'focus',    color: 'var(--copper)' },
  event:    { label: 'event',    color: 'var(--ivory)'  },
  blackout: { label: 'day off',  color: 'var(--text-lo)' },
}

function startOfWeek(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  const dow = x.getDay() || 7 // Sun=0→7
  x.setDate(x.getDate() - (dow - 1))
  return x
}
function addDays(d, n) { const x = new Date(d); x.setDate(d.getDate() + n); return x }
function toISO(d) { return d.toISOString().slice(0, 10) }

/* Parse a "HH:MM:SS" or "HH:MM" string into {h, m, totalMin}.
 * Postgres `time` may return either; be permissive. */
function parseTime(s) {
  if (!s) return { h: 0, m: 0, totalMin: 0 }
  const [h, m] = String(s).split(':').map((n) => parseInt(n, 10) || 0)
  return { h, m, totalMin: h * 60 + m }
}
function fmtTime(s) {
  const { h, m } = parseTime(s)
  const hr12 = h % 12 === 0 ? 12 : h % 12
  const ampm = h < 12 ? 'AM' : 'PM'
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, '0')}${ampm}`
}
function fmtRange(start, end) {
  return `${fmtTime(start)} – ${fmtTime(end)}`
}

/* Block position + height inside the agenda-day body, in pixels.
 * Clamps to the visible hour window so overflow doesn't break layout. */
function blockStyle(startTime, endTime) {
  const startMin = parseTime(startTime).totalMin
  const endMin = parseTime(endTime).totalMin
  const winStart = HOUR_MIN * 60
  const winEnd = HOUR_MAX * 60
  const clipStart = Math.max(startMin, winStart)
  const clipEnd = Math.min(endMin, winEnd)
  const pxPerMin = ROW_HEIGHT_PX / 60
  return {
    top: Math.max(0, (clipStart - winStart) * pxPerMin),
    height: Math.max(12, (clipEnd - clipStart) * pxPerMin),
  }
}

export default function Schedule() {
  const [template, setTemplate] = useState([])
  const [overrides, setOverrides] = useState([])
  const [brands, setBrands] = useState([])
  const [weekStart, setWeekStart] = useState(startOfWeek())
  const [modal, setModal] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    const weekStartIso = toISO(weekStart)
    const weekEndIso = toISO(addDays(weekStart, 6))
    const [tplRes, ovrRes, brandRes] = await Promise.all([
      supabase.from('schedule_template')
        .select('id, day_of_week, start_time, end_time, brand_id, label, notes, sort_order, brands(id, name, color)')
        .order('day_of_week').order('start_time'),
      supabase.from('schedule_overrides')
        .select('id, date, start_time, end_time, brand_id, label, notes, reason, kind, brands(id, name, color)')
        .gte('date', weekStartIso).lte('date', weekEndIso)
        .order('date').order('start_time'),
      supabase.from('brands').select('id, name, color').order('name'),
    ])
    if (tplRes.error) { setErr(tplRes.error.message); setLoading(false); return }
    if (ovrRes.error) { setErr(ovrRes.error.message); setLoading(false); return }
    if (brandRes.error) { setErr(brandRes.error.message); setLoading(false); return }
    setTemplate(tplRes.data || [])
    setOverrides(ovrRes.data || [])
    setBrands(brandRes.data || [])
    setLoading(false)
  }, [weekStart])

  useEffect(() => { load() }, [load])

  const weekDates = useMemo(
    () => DAYS.map((d, i) => ({ ...d, date: addDays(weekStart, i) })),
    [weekStart]
  )

  const todayIso = toISO(new Date())

  const tplByDow = useMemo(() => {
    const m = new Map()
    for (const t of template) {
      if (!m.has(t.day_of_week)) m.set(t.day_of_week, [])
      m.get(t.day_of_week).push(t)
    }
    return m
  }, [template])

  const ovrByDate = useMemo(() => {
    const m = new Map()
    for (const o of overrides) {
      if (!m.has(o.date)) m.set(o.date, [])
      m.get(o.date).push(o)
    }
    return m
  }, [overrides])

  /* Resolve blocks for a given day with overlay semantics.
   * Returns { items: [...] } sorted by start_time, where each item is:
   *   { kind: 'template'|'focus'|'event'|'blackout', data, dimmed? }
   */
  function resolvedBlocks(day) {
    const dateIso = toISO(day.date)
    const dayOverrides = ovrByDate.get(dateIso) || []
    const dayTemplates = tplByDow.get(day.dow) || []
    const layers = dayOverrides.filter((o) => o.kind !== 'blackout')

    const out = []

    for (const t of dayTemplates) {
      const tStart = parseTime(t.start_time).totalMin
      const tEnd = parseTime(t.end_time).totalMin
      // Hide template if ANY override fully covers its window. Blackouts
      // hide-on-full per day-off semantics; focus/event overrides that
      // cover the same range replace the plan for that specific time, so
      // we hide the template too — otherwise both blocks render at the
      // identical absolute rectangle and the "RECURRING" + "event" badges
      // stack on top of each other (2026-04-22 fix).
      const fullyCovered = dayOverrides.some((o) => {
        const oStart = parseTime(o.start_time).totalMin
        const oEnd = parseTime(o.end_time).totalMin
        return oStart <= tStart && oEnd >= tEnd
      })
      if (fullyCovered) continue
      // Dim template if any non-blackout override partially overlaps.
      const dimmed = layers.some((o) => {
        const oStart = parseTime(o.start_time).totalMin
        const oEnd = parseTime(o.end_time).totalMin
        return !(oEnd <= tStart || oStart >= tEnd)
      })
      out.push({ kind: 'template', data: t, dimmed })
    }

    for (const o of dayOverrides) {
      out.push({ kind: o.kind || 'event', data: o })
    }

    // Render order = DOM order for absolute-positioned siblings without
    // z-index. Put templates first so overrides land on top visually on
    // partial overlap. Within each group, sort by start_time.
    out.sort((a, b) => {
      const aTpl = a.kind === 'template'
      const bTpl = b.kind === 'template'
      if (aTpl !== bTpl) return aTpl ? -1 : 1
      return parseTime(a.data.start_time).totalMin - parseTime(b.data.start_time).totalMin
    })
    return out
  }

  const totalBodyPx = (HOUR_MAX - HOUR_MIN) * ROW_HEIGHT_PX
  const hourRows = Array.from({ length: HOUR_MAX - HOUR_MIN }, (_, i) => HOUR_MIN + i)

  return (
    <div className="schedule-page">
      <div className="page-header">
        <span className="eyebrow">Schedule</span>
        <h1>Recurring schedule + exceptions</h1>
        <p>
          Your weekly pattern plus one-off events, focus blocks for a brand, or days
          off. Adding an exception doesn't touch the recurring pattern.
        </p>
      </div>

      <div className="week-nav">
        <button className="btn btn-secondary" onClick={() => setWeekStart((w) => addDays(w, -7))}>← Prev week</button>
        <div className="week-nav-label">
          {fmtDate(toISO(weekStart), { month: 'short', day: 'numeric' })}
          {' – '}
          {fmtDate(toISO(addDays(weekStart, 6)), { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>
        <button className="btn btn-secondary" onClick={() => setWeekStart(startOfWeek())}>This week</button>
        <button className="btn btn-secondary" onClick={() => setWeekStart((w) => addDays(w, 7))}>Next week →</button>
      </div>

      {err && <div className="login-error" style={{ marginBottom: 16 }}>{err}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <>
          {/* Desktop + tablet: agenda timeline grid. Mobile CSS swaps to
           * stacked day cards via .agenda-day display: block. */}
          <div className="agenda-grid" style={{ '--agenda-body-h': `${totalBodyPx}px`, '--agenda-row-h': `${ROW_HEIGHT_PX}px` }}>
            <div className="agenda-hours" aria-hidden="true">
              {hourRows.map((h) => (
                <div key={h} className="agenda-hour-label">
                  {h % 12 === 0 ? 12 : h % 12}
                  <span className="agenda-hour-ampm">{h < 12 ? 'AM' : 'PM'}</span>
                </div>
              ))}
            </div>
            {weekDates.map((d) => {
              const items = resolvedBlocks(d)
              const isToday = toISO(d.date) === todayIso
              return (
                <div key={d.dow} className={`agenda-day ${isToday ? 'agenda-day--today' : ''}`}>
                  <div className="agenda-day-head">
                    <div className="agenda-day-dow">{d.short}</div>
                    <div className="agenda-day-date">{fmtDate(toISO(d.date), { month: 'short', day: 'numeric' })}</div>
                  </div>
                  <div className="agenda-day-body">
                    {/* Background hour lines (aria-hidden). */}
                    <div className="agenda-day-grid" aria-hidden="true">
                      {hourRows.map((h, i) => (
                        <button
                          key={h}
                          type="button"
                          className="agenda-hour-row"
                          aria-label={`Add event on ${d.long} at ${h}:00`}
                          onClick={() => setModal({
                            kind: 'override',
                            defaultDate: toISO(d.date),
                            defaultStart: `${String(h).padStart(2, '0')}:00`,
                            defaultEnd: `${String(Math.min(h + 1, HOUR_MAX)).padStart(2, '0')}:00`,
                          })}
                          style={{ top: i * ROW_HEIGHT_PX, height: ROW_HEIGHT_PX }}
                        />
                      ))}
                    </div>
                    {items.length === 0 && (
                      <div className="agenda-day-empty">— no blocks —</div>
                    )}
                    {items.map((it) => {
                      const data = it.data
                      const color = data.brands?.color || 'var(--copper)'
                      const style = blockStyle(data.start_time, data.end_time)
                      const label = data.brands?.name || data.label || (it.kind === 'blackout' ? 'Off' : 'Event')
                      const badge = it.kind === 'template' ? { label: 'recurring', color: 'var(--text-lo)' } : KIND_BADGE[it.kind]
                      const className = [
                        'agenda-block',
                        `agenda-block--${it.kind}`,
                        it.dimmed ? 'agenda-block--dimmed' : '',
                      ].filter(Boolean).join(' ')
                      return (
                        <button
                          key={`${it.kind}:${data.id}`}
                          type="button"
                          className={className}
                          onClick={() => setModal({
                            kind: it.kind === 'template' ? 'template' : 'override',
                            block: data,
                          })}
                          style={{
                            ...style,
                            borderLeftColor: it.kind === 'blackout' ? 'var(--text-lo)' : color,
                          }}
                          title={`${fmtRange(data.start_time, data.end_time)} · ${label}${data.notes ? ` — ${data.notes}` : ''}`}
                        >
                          <span className="agenda-block-time">
                            {fmtRange(data.start_time, data.end_time)}
                          </span>
                          <span className="agenda-block-label" style={{ color: it.kind === 'blackout' ? 'var(--text-lo)' : color }}>
                            {label}
                          </span>
                          {badge && (
                            <span className="agenda-block-badge" style={{ color: badge.color }}>
                              {badge.label}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          <p className="agenda-hint">
            Click any empty hour to add a one-off event or focus block for that date.
            Click an existing block to edit. Blackouts hide overlapping recurring blocks.
          </p>
        </>
      )}

      {/* Recurring schedule — flat list */}
      <div className="template-summary">
        <div className="panel-header">
          <span className="eyebrow">Recurring schedule</span>
          <button className="btn btn-link" onClick={() => setModal({ kind: 'template' })}>+ Add recurring block</button>
        </div>
        {template.length === 0 ? (
          <div className="empty-state" style={{ padding: 20 }}>
            <p>No recurring schedule yet. Click any day above to start.</p>
          </div>
        ) : (
          <ul className="template-list">
            {[...template]
              .sort((a, b) =>
                (a.day_of_week === 0 ? 7 : a.day_of_week) - (b.day_of_week === 0 ? 7 : b.day_of_week)
                || parseTime(a.start_time).totalMin - parseTime(b.start_time).totalMin
              )
              .map((t) => {
                const day = DAYS.find((d) => d.dow === t.day_of_week)
                return (
                  <li
                    key={t.id}
                    className="template-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setModal({ kind: 'template', block: t })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setModal({ kind: 'template', block: t })
                      }
                    }}
                  >
                    <span className="template-dow">{day?.long}</span>
                    <span className="template-block">{fmtRange(t.start_time, t.end_time)}</span>
                    <span className="template-brand" style={{ color: t.brands?.color || 'var(--ivory)' }}>
                      {t.brands?.name || t.label || '— flex / off —'}
                    </span>
                    <span className="template-edit-hint">Edit</span>
                  </li>
                )
              })}
          </ul>
        )}
      </div>

      {modal && (
        <EditScheduleBlockModal
          kind={modal.kind}
          block={modal.block}
          brands={brands}
          defaultDow={modal.defaultDow}
          defaultDate={modal.defaultDate}
          defaultStart={modal.defaultStart}
          defaultEnd={modal.defaultEnd}
          onClose={() => setModal(null)}
          onSaved={() => load()}
        />
      )}
    </div>
  )
}
