import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtDate } from '../lib/format'
import EditScheduleBlockModal from '../components/forms/EditScheduleBlockModal'

const DAYS = [
  { dow: 1, short: 'Mon', long: 'Monday' },
  { dow: 2, short: 'Tue', long: 'Tuesday' },
  { dow: 3, short: 'Wed', long: 'Wednesday' },
  { dow: 4, short: 'Thu', long: 'Thursday' },
  { dow: 5, short: 'Fri', long: 'Friday' },
  { dow: 6, short: 'Sat', long: 'Saturday' },
  { dow: 0, short: 'Sun', long: 'Sunday' },
]
const BLOCKS = ['morning', 'afternoon', 'all_day']
const BLOCK_LABELS = { morning: 'AM', afternoon: 'PM', all_day: 'All day' }

function startOfWeek(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  const dow = x.getDay() || 7 // Sun=0→7
  x.setDate(x.getDate() - (dow - 1))
  return x
}
function addDays(d, n) { const x = new Date(d); x.setDate(d.getDate() + n); return x }
function toISO(d) { return d.toISOString().slice(0, 10) }

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
      supabase.from('schedule_template').select('id, day_of_week, time_block, brand_id, label, sort_order, brands(id, name, color)').order('day_of_week').order('sort_order'),
      supabase.from('schedule_overrides').select('id, date, time_block, brand_id, label, reason, brands(id, name, color)').gte('date', weekStartIso).lte('date', weekEndIso).order('date'),
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

  // Build a lookup: key = `${dow}:${block}` or `${dateISO}:${block}`
  const tplMap = useMemo(() => {
    const m = new Map()
    for (const t of template) m.set(`${t.day_of_week}:${t.time_block}`, t)
    return m
  }, [template])

  const ovrMap = useMemo(() => {
    const m = new Map()
    for (const o of overrides) m.set(`${o.date}:${o.time_block}`, o)
    return m
  }, [overrides])

  /* For a given week-day column, find the "resolved" blocks — overrides
   * replace the template entirely for that date. */
  function resolvedBlocks(day) {
    const dateIso = toISO(day.date)
    // If any override exists for this date, overrides fully replace template for that date.
    const hasOverride = BLOCKS.some((b) => ovrMap.has(`${dateIso}:${b}`))
    const items = []
    for (const b of BLOCKS) {
      const ovr = ovrMap.get(`${dateIso}:${b}`)
      if (ovr) items.push({ kind: 'override', block: b, data: ovr })
      else if (!hasOverride) {
        const tpl = tplMap.get(`${day.dow}:${b}`)
        if (tpl) items.push({ kind: 'template', block: b, data: tpl })
      }
    }
    return items
  }

  return (
    <div className="schedule-page">
      <div className="page-header">
        <span className="eyebrow">Schedule</span>
        <h1>Weekly Template &amp; Overrides</h1>
        <p>The template repeats forever. Overrides replace a specific date.</p>
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

      {err && <div className="login-error" style={{marginBottom:16}}>{err}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <div className="week-grid">
          {weekDates.map((d) => {
            const items = resolvedBlocks(d)
            const isToday = toISO(d.date) === todayIso
            return (
              <div key={d.dow} className={`week-col ${isToday ? 'today' : ''}`}>
                <div className="week-col-head">
                  <div className="week-col-dow">{d.short}</div>
                  <div className="week-col-date">{fmtDate(toISO(d.date), { month: 'short', day: 'numeric' })}</div>
                </div>
                <div className="week-col-body">
                  {items.length === 0 ? (
                    <button
                      className="schedule-cell schedule-cell--empty"
                      onClick={() => setModal({ kind: 'template', defaultDow: d.dow })}
                    >
                      <span className="schedule-cell-hint">+ Set</span>
                    </button>
                  ) : (
                    items.map((it) => (
                      <ScheduleCell
                        key={`${it.kind}:${it.block}:${it.data.id}`}
                        item={it}
                        onClick={() => setModal({
                          kind: it.kind,
                          block: it.data,
                        })}
                      />
                    ))
                  )}
                  <button
                    className="schedule-cell schedule-cell--add"
                    onClick={() => setModal({
                      kind: 'override',
                      defaultDate: toISO(d.date),
                    })}
                  >
                    + Override date
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Template summary — flat list */}
      <div className="template-summary">
        <div className="panel-header">
          <span className="eyebrow">Weekly template (recurring)</span>
          <button className="btn btn-link" onClick={() => setModal({ kind: 'template' })}>+ Add template block</button>
        </div>
        {template.length === 0 ? (
          <div className="empty-state" style={{ padding: 20 }}>
            <p>No weekly template yet. Click any day above to start.</p>
          </div>
        ) : (
          <ul className="template-list">
            {template.map((t) => {
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
                  <span className="template-block">{BLOCK_LABELS[t.time_block]}</span>
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
          onClose={() => setModal(null)}
          onSaved={() => load()}
        />
      )}
    </div>
  )
}

function ScheduleCell({ item, onClick }) {
  const { block, data, kind } = item
  const color = data.brands?.color || 'var(--copper)'
  const isFlex = !data.brand_id
  return (
    <button className={`schedule-cell ${kind === 'override' ? 'is-override' : ''} ${isFlex ? 'is-flex' : ''}`}
      onClick={onClick}
      style={{ borderLeftColor: color }}
    >
      <span className="schedule-cell-block">{BLOCK_LABELS[block]}</span>
      <span className="schedule-cell-brand" style={{ color }}>
        {data.brands?.name || data.label || 'Flex'}
      </span>
      {kind === 'override' && <span className="schedule-cell-override">Override</span>}
    </button>
  )
}
