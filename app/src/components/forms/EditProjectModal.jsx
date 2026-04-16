import { useState, useEffect } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const STATUS_OPTS = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
]
const TYPE_OPTS = [
  { value: 'buildout', label: 'Buildout (fixed scope)' },
  { value: 'retainer', label: 'Retainer (monthly)' },
]
const PAYMENT_OPTS = [
  { value: '', label: '—' },
  { value: 'due_at_signing', label: 'Due at signing' },
  { value: 'split_60_40', label: 'Split 60/40' },
  { value: 'split_50_50', label: 'Split 50/50' },
  { value: 'monthly_recurring_ach', label: 'Monthly ACH (retainer)' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_15', label: 'Net 15' },
]

export default function EditProjectModal({ project, brands, defaultBrandId, onClose, onSaved }) {
  const isNew = !project?.id
  const [form, setForm] = useState({
    brand_id: project?.brand_id || defaultBrandId || '',
    name: project?.name || '',
    type: project?.type || 'buildout',
    status: project?.status || 'draft',
    total_fee: project?.total_fee ?? '',
    payment_structure: project?.payment_structure || '',
    start_date: project?.start_date || '',
    end_date: project?.end_date || '',
    timeline: project?.timeline || '',
    intro_term_end: project?.intro_term_end || '',
    notes: project?.notes || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  // Auto-suggest project name based on brand + type
  useEffect(() => {
    if (!isNew) return
    if (form.name) return
    const brand = brands.find((b) => b.id === form.brand_id)
    if (brand) set('name')(`${brand.name} ${form.type === 'retainer' ? 'Retainer' : 'Buildout'}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.brand_id, form.type])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.brand_id) { setErr('Pick a brand.'); return }
    if (!form.name.trim()) { setErr('Project name required.'); return }
    setBusy(true)
    const payload = {
      brand_id: form.brand_id,
      name: form.name.trim(),
      type: form.type,
      status: form.status,
      total_fee: form.total_fee === '' ? null : parseFloat(form.total_fee),
      payment_structure: form.payment_structure || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      timeline: form.timeline.trim() || null,
      intro_term_end: form.intro_term_end || null,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase.from('projects').insert(payload).select().single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        const { data, error } = await supabase.from('projects').update(payload).eq('id', project.id).select().single()
        if (error) throw error
        onSaved(data, 'updated')
      }
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this project? Deliverables, services, and tasks will cascade.')) return
    setErr(''); setBusy(true)
    try {
      const { error } = await supabase.from('projects').delete().eq('id', project.id)
      if (error) throw error
      onSaved({ id: project.id }, 'deleted')
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const brandOptions = brands.map((b) => ({ value: b.id, label: b.label || b.name }))

  return (
    <Modal onClose={onClose} title={isNew ? 'New project' : `Edit ${project.name}`} width="medium">
      <form onSubmit={handleSubmit} className="form-grid">
        <SelectField id="brand_id" label="Brand" span="full" value={form.brand_id} onChange={set('brand_id')} options={brandOptions} placeholder="Pick a brand…" />
        <SelectField id="type" label="Type" value={form.type} onChange={set('type')} options={TYPE_OPTS} />
        <SelectField id="status" label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTS} />
        <TextField id="name" label="Project name" span="full" required value={form.name} onChange={set('name')} />
        <TextField id="total_fee" type="number" step="0.01" label={form.type === 'retainer' ? 'Monthly rate ($)' : 'Total fee ($)'} value={form.total_fee} onChange={set('total_fee')} />
        <SelectField id="payment_structure" label="Payment structure" value={form.payment_structure} onChange={set('payment_structure')} options={PAYMENT_OPTS.slice(1)} placeholder="—" />
        <TextField id="start_date" type="date" label="Start date" value={form.start_date} onChange={set('start_date')} />
        {form.type === 'buildout' ? (
          <TextField id="end_date" type="date" label="Target end date" value={form.end_date} onChange={set('end_date')} hint="Reference only — no penalty if it slips." />
        ) : (
          <TextField id="intro_term_end" type="date" label="Intro-term end" value={form.intro_term_end} onChange={set('intro_term_end')} hint="When the intro rate lock expires. Alert fires 30 days before." />
        )}
        <TextField id="timeline" label="Timeline (readable)" span="full" value={form.timeline} onChange={set('timeline')} placeholder='"2 weeks" or "3-month intro term"' />
        <TextareaField id="notes" label="Notes / context" value={form.notes} onChange={set('notes')} rows={4} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Create project' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
