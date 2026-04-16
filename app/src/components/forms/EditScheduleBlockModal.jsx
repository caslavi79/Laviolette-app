import { useState } from 'react'
import Modal from '../Modal'
import { SelectField, TextField } from '../Field'
import { supabase } from '../../lib/supabase'

const BLOCK_OPTS = [
  { value: 'all_day',   label: 'All day' },
  { value: 'morning',   label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
]
const DOW_OPTS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
]

/* Handles both schedule_template (recurring, keyed by day_of_week)
 * and schedule_overrides (specific date) in a single modal. */
export default function EditScheduleBlockModal({
  kind,       // 'template' | 'override'
  block,      // existing row (edit) or null (new)
  brands,
  defaultDow, // for new template entries
  defaultDate,// for new override entries
  onClose,
  onSaved,
}) {
  const isNew = !block?.id
  const isTemplate = kind === 'template'

  const [form, setForm] = useState({
    day_of_week: block?.day_of_week ?? (defaultDow ?? 1),
    date: block?.date || defaultDate || new Date().toISOString().slice(0, 10),
    time_block: block?.time_block || 'all_day',
    brand_id: block?.brand_id || '',
    label: block?.label || '',
    reason: block?.reason || '',
  })
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      if (isTemplate) {
        const payload = {
          day_of_week: parseInt(form.day_of_week, 10),
          time_block: form.time_block,
          brand_id: form.brand_id || null,
          label: form.label.trim() || null,
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
          time_block: form.time_block,
          brand_id: form.brand_id || null,
          label: form.label.trim() || null,
          reason: form.reason.trim() || null,
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
    { value: '', label: '— Flex / Off / Admin' },
    ...brands.map((b) => ({ value: b.id, label: b.name })),
  ]

  return (
    <Modal onClose={onClose} title={`${isNew ? 'Add' : 'Edit'} ${isTemplate ? 'weekly block' : 'date override'}`} width="small">
      <form onSubmit={handleSubmit} className="form-grid">
        {isTemplate ? (
          <SelectField id="day_of_week" label="Day of week" value={form.day_of_week} onChange={set('day_of_week')} options={DOW_OPTS} />
        ) : (
          <TextField id="date" type="date" label="Date" required value={form.date} onChange={set('date')} />
        )}
        <SelectField id="time_block" label="Time block" value={form.time_block} onChange={set('time_block')} options={BLOCK_OPTS} />
        <SelectField id="brand_id" label="Brand" span="full" value={form.brand_id} onChange={set('brand_id')} options={brandOptions} />
        <TextField id="label" label={form.brand_id ? 'Label (optional)' : 'Label'} span="full" value={form.label} onChange={set('label')} placeholder={form.brand_id ? '' : '"Flex", "Admin", "Off"'} />
        {!isTemplate && (
          <TextField id="reason" label="Reason" span="full" value={form.reason} onChange={set('reason')} placeholder='"Sheepdog deadline", "Taking day off"' />
        )}
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
