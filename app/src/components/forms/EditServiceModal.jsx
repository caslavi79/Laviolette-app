import { useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const CADENCE_OPTS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Bi-weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'ongoing', label: 'Ongoing (no cadence)' },
  { value: 'as_needed', label: 'As needed' },
]
const PLATFORM_OPTS = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'gbp', label: 'Google Business' },
  { value: 'yelp', label: 'Yelp' },
  { value: 'apple_maps', label: 'Apple Maps' },
]

export default function EditServiceModal({ projectId, service, nextNumber, onClose, onSaved }) {
  const isNew = !service?.id
  const [form, setForm] = useState({
    number: service?.number ?? nextNumber ?? 1,
    name: service?.name || '',
    description: service?.description || '',
    cadence: service?.cadence || 'weekly',
    quantity_per_period: service?.quantity_per_period ?? 1,
    sla_hours: service?.sla_hours ?? '',
    platforms: service?.platforms || [],
    active: service?.active ?? true,
    notes: service?.notes || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  const togglePlatform = (p) => {
    setForm((f) => ({
      ...f,
      platforms: f.platforms.includes(p) ? f.platforms.filter((x) => x !== p) : [...f.platforms, p],
    }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.name.trim()) { setErr('Name required.'); return }
    setBusy(true)
    const payload = {
      number: parseInt(form.number, 10),
      name: form.name.trim(),
      description: form.description.trim() || null,
      cadence: form.cadence,
      quantity_per_period: parseInt(form.quantity_per_period, 10) || 1,
      sla_hours: form.sla_hours === '' ? null : parseInt(form.sla_hours, 10),
      platforms: form.platforms,
      active: form.active,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase
          .from('retainer_services')
          .insert({ ...payload, project_id: projectId })
          .select()
          .single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        const { data, error } = await supabase.from('retainer_services').update(payload).eq('id', service.id).select().single()
        if (error) throw error
        onSaved(data, 'updated')
      }
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally { setBusy(false) }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this service? Generated tasks will cascade.')) return
    setErr(''); setBusy(true)
    try {
      const { error } = await supabase.from('retainer_services').delete().eq('id', service.id)
      if (error) throw error
      onSaved({ id: service.id }, 'deleted')
      onClose()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  return (
    <Modal onClose={onClose} title={isNew ? 'Add service' : `Edit #${service.number} ${service.name}`} width="medium">
      <form onSubmit={handleSubmit} className="form-grid">
        <TextField id="number" type="number" min="1" label="Number" value={form.number} onChange={set('number')} required />
        <SelectField id="cadence" label="Cadence" value={form.cadence} onChange={set('cadence')} options={CADENCE_OPTS} />
        <TextField id="name" label="Name" span="full" required value={form.name} onChange={set('name')} autoFocus placeholder='"Instagram & Facebook Content", "Review Management"…' />
        <TextareaField id="description" label="Description" value={form.description} onChange={set('description')} />
        <TextField id="quantity_per_period" type="number" min="0" label="Quantity / period" value={form.quantity_per_period} onChange={set('quantity_per_period')} hint='2 for "2 posts/week".' />
        <TextField id="sla_hours" type="number" min="0" label="SLA hours" value={form.sla_hours} onChange={set('sla_hours')} hint='"72" for 72-hour review response.' />
        <div className="field field--span-full">
          <label>Platforms</label>
          <div className="platform-chips">
            {PLATFORM_OPTS.map((p) => (
              <button
                type="button"
                key={p.value}
                className={`platform-chip ${form.platforms.includes(p.value) ? 'on' : ''}`}
                onClick={() => togglePlatform(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field field--span-full field--checkbox">
          <label htmlFor="active">
            <input id="active" type="checkbox" checked={form.active} onChange={(e) => set('active')(e.target.checked)} />
            <span>Active (generate recurring tasks)</span>
          </label>
        </div>
        <TextareaField id="notes" label="Notes" value={form.notes} onChange={set('notes')} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add service' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
