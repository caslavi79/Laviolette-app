import { useEffect, useState } from 'react'
import Modal from '../Modal'
import { SelectField, TextField } from '../Field'
import { supabase } from '../../lib/supabase'

const DOW_OPTS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
]

const KIND_OPTS = [
  { value: 'focus',    label: 'Focus block',    desc: 'Deep-work window for a specific brand' },
  { value: 'event',    label: 'One-off event',  desc: 'Meeting, appointment, anything time-bound' },
  { value: 'blackout', label: 'Day off',        desc: 'Hide recurring blocks for this window' },
]

// Quick-pick buttons next to each time input. Clicking writes the value.
const START_PRESETS = [
  { label: 'Now',  compute: () => {
    const d = new Date(); const m = d.getMinutes(); d.setMinutes(m - (m % 15), 0, 0)
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }},
  { label: '9am',  value: '09:00' },
  { label: 'Noon', value: '12:00' },
  { label: '1pm',  value: '13:00' },
  { label: '5pm',  value: '17:00' },
]
const END_PRESETS = [
  { label: '+1hr', computeFromStart: (s) => bumpTime(s, 60) },
  { label: '+2hr', computeFromStart: (s) => bumpTime(s, 120) },
  { label: '+3hr', computeFromStart: (s) => bumpTime(s, 180) },
  { label: 'End of day', value: '17:00' },
]

function bumpTime(hhmm, addMin) {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  const total = (h * 60 + m) + addMin
  const clamped = Math.min(total, 23 * 60 + 59)
  const nh = Math.floor(clamped / 60)
  const nm = clamped % 60
  return `${String(nh).padStart(2,'0')}:${String(nm).padStart(2,'0')}`
}

function toHHMM(t) {
  if (!t) return ''
  // Postgres `time` may return "HH:MM:SS" or "HH:MM" — normalize.
  return String(t).slice(0, 5)
}

/* Schedule v2 modal. Handles both schedule_template (recurring) and
 * schedule_overrides (per-date) in a single form. Override mode adds
 * a kind picker (focus/event/blackout) that drives brand visibility +
 * time-range defaults. */
export default function EditScheduleBlockModal({
  kind: mode,           // 'template' | 'override' | 'focus' | 'event' | 'blackout'
                        // (agenda-view passes the specific override kind; we
                        //  normalize to 'override' internally and preselect kind)
  block,                // existing row (edit) or null (new)
  brands,
  defaultDow,           // for new template entries
  defaultDate,          // for new override entries
  defaultStart,         // for new override entries — prefilled from agenda click
  defaultEnd,           // for new override entries — prefilled from agenda click
  onClose,
  onSaved,
}) {
  const isNew = !block?.id
  const isTemplate = mode === 'template'

  // Normalize incoming `kind` prop: if the caller passed a specific kind
  // (focus/event/blackout), the modal is opening in override mode with
  // that kind preselected. Fallback: new overrides default to 'event'.
  const initialKind = block?.kind
    || (mode === 'focus' || mode === 'event' || mode === 'blackout' ? mode : 'event')

  const [form, setForm] = useState({
    day_of_week: block?.day_of_week ?? (defaultDow ?? 1),
    date: block?.date || defaultDate || new Date().toISOString().slice(0, 10),
    kind: initialKind,
    start_time: toHHMM(block?.start_time) || defaultStart || '09:00',
    end_time: toHHMM(block?.end_time) || defaultEnd || '12:00',
    brand_id: block?.brand_id || '',
    label: block?.label || '',
    notes: block?.notes || block?.reason || '',
  })
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // When kind flips to blackout, auto-fill the window to all-day — the
  // default blackout intent is "I'm out today." Operator can still
  // shrink it to, say, 09:00-12:00 if only the morning is off.
  useEffect(() => {
    if (isTemplate) return
    if (form.kind === 'blackout' && isNew) {
      setForm((f) => ({ ...f, start_time: '00:00', end_time: '23:59' }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.kind, isTemplate, isNew])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    // Time-window sanity. Both UI and DB enforce end > start.
    if (!form.start_time || !form.end_time) { setErr('Start and end times are required.'); return }
    if (form.end_time <= form.start_time) { setErr('End time must be after start time.'); return }
    // Override-specific checks.
    if (!isTemplate) {
      if (form.kind === 'blackout' && !form.label.trim() && !form.notes.trim()) {
        setErr('Blackouts need a label or notes so you remember what the day is for.')
        return
      }
      if (form.kind === 'event' && !form.label.trim() && !form.brand_id) {
        setErr('An event needs a label or a brand.')
        return
      }
      if (form.kind === 'focus' && !form.brand_id) {
        setErr('A focus block needs a brand.')
        return
      }
    }
    setBusy(true)
    try {
      if (isTemplate) {
        const payload = {
          day_of_week: parseInt(form.day_of_week, 10),
          start_time: form.start_time,
          end_time: form.end_time,
          brand_id: form.brand_id || null,
          label: form.label.trim() || null,
          notes: form.notes.trim() || null,
        }
        if (isNew) {
          const { data, error } = await supabase.from('schedule_template').insert(payload).select().single()
          if (error) throw error
          onSaved(data, 'created')
        } else {
          const { data, error } = await supabase.from('schedule_template').update(payload).eq('id', block.id).select().single()
          if (error) throw error
          onSaved(data, 'updated')
        }
      } else {
        const payload = {
          date: form.date,
          start_time: form.start_time,
          end_time: form.end_time,
          kind: form.kind,
          // focus blocks carry a brand; event blocks may or may not;
          // blackouts never carry one (if someone picks one anyway,
          // drop it — the `day off` semantic doesn't need a brand).
          brand_id: (form.kind === 'blackout') ? null : (form.brand_id || null),
          label: form.label.trim() || null,
          notes: form.notes.trim() || null,
          // Keep `reason` column in sync on save (column is kept in the
          // schema as a bridge until a follow-up migration drops it).
          reason: form.notes.trim() || null,
        }
        if (isNew) {
          const { data, error } = await supabase.from('schedule_overrides').insert(payload).select().single()
          if (error) throw error
          onSaved(data, 'created')
        } else {
          const { data, error } = await supabase.from('schedule_overrides').update(payload).eq('id', block.id).select().single()
          if (error) throw error
          onSaved(data, 'updated')
        }
      }
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this block?')) return
    setBusy(true); setErr('')
    try {
      const table = isTemplate ? 'schedule_template' : 'schedule_overrides'
      const { error } = await supabase.from(table).delete().eq('id', block.id)
      if (error) throw error
      onSaved({ id: block.id }, 'deleted')
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally { setBusy(false) }
  }

  const brandOptions = [
    { value: '', label: '— flex / off / admin' },
    ...brands.map((b) => ({ value: b.id, label: b.name })),
  ]
  const showBrand = isTemplate || form.kind === 'focus' || form.kind === 'event'

  const titleVerb = isNew ? 'Add' : 'Edit'
  const titleNoun = isTemplate
    ? 'recurring block'
    : form.kind === 'blackout' ? 'day off'
    : form.kind === 'focus' ? 'focus block'
    : 'event'

  return (
    <Modal onClose={onClose} title={`${titleVerb} ${titleNoun}`} width="small">
      <form onSubmit={handleSubmit} className="form-grid">
        {/* Override kind picker — segmented control. */}
        {!isTemplate && (
          <div className="field field--span-full">
            <label>Kind</label>
            <div className="kind-picker">
              {KIND_OPTS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  className={`kind-pick ${form.kind === k.value ? 'kind-pick--active' : ''}`}
                  onClick={() => set('kind')(k.value)}
                  aria-pressed={form.kind === k.value}
                >
                  <span className="kind-pick-label">{k.label}</span>
                  <span className="kind-pick-desc">{k.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Day of week (template) OR Date (override). */}
        {isTemplate ? (
          <SelectField
            id="day_of_week"
            label="Day of week"
            value={form.day_of_week}
            onChange={set('day_of_week')}
            options={DOW_OPTS}
            span="full"
          />
        ) : (
          <TextField
            id="date"
            type="date"
            label="Date"
            required
            value={form.date}
            onChange={set('date')}
            span="full"
          />
        )}

        {/* Start + end time with preset chips. */}
        <div className="field">
          <label htmlFor="start_time">Start</label>
          <input
            id="start_time"
            type="time"
            value={form.start_time}
            onChange={(e) => set('start_time')(e.target.value)}
          />
          <div className="time-presets">
            {START_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="btn-chip"
                onClick={() => set('start_time')(p.value ?? p.compute())}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="end_time">End</label>
          <input
            id="end_time"
            type="time"
            value={form.end_time}
            onChange={(e) => set('end_time')(e.target.value)}
          />
          <div className="time-presets">
            {END_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="btn-chip"
                onClick={() => set('end_time')(p.value ?? p.computeFromStart(form.start_time))}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Brand: shown for templates (any kind) and overrides where kind ≠ blackout. */}
        {showBrand && (
          <SelectField
            id="brand_id"
            label={isTemplate ? 'Brand (optional)' : (form.kind === 'focus' ? 'Brand' : 'Brand (optional)')}
            span="full"
            value={form.brand_id}
            onChange={set('brand_id')}
            options={brandOptions}
          />
        )}

        {/* Label: always shown. */}
        <TextField
          id="label"
          label={form.brand_id ? 'Label (optional)' : 'Label'}
          span="full"
          value={form.label}
          onChange={set('label')}
          placeholder={
            isTemplate ? (form.brand_id ? '' : '"Flex", "Admin", "Off"')
            : form.kind === 'blackout' ? '"Out of office"'
            : form.kind === 'event' ? '"Sheepdog review call"'
            : ''
          }
        />

        {/* Notes — always shown. Replaces the old `reason` as the primary
         * freetext field, but save logic writes to both columns so any
         * legacy reader still sees the value. */}
        <div className="field field--span-full">
          <label htmlFor="block_notes">Notes (optional)</label>
          <textarea
            id="block_notes"
            rows={2}
            maxLength={1000}
            value={form.notes}
            onChange={(e) => set('notes')(e.target.value)}
            placeholder={isTemplate ? 'e.g., "Weekly social posts + review replies"' : 'Why this day / what to prep'}
          />
        </div>

        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
