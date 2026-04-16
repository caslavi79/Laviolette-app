import { useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const STATUS_OPTS = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'complete', label: 'Complete' },
]

export default function EditDeliverableModal({ projectId, deliverable, nextNumber, onClose, onSaved }) {
  const isNew = !deliverable?.id
  const [form, setForm] = useState({
    number: deliverable?.number ?? nextNumber ?? 1,
    category: deliverable?.category || '',
    name: deliverable?.name || '',
    description: deliverable?.description || '',
    status: deliverable?.status || 'not_started',
    notes: deliverable?.notes || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.name.trim()) { setErr('Name required.'); return }
    if (!form.number) { setErr('Number required.'); return }
    setBusy(true)
    const payload = {
      number: parseInt(form.number, 10),
      category: form.category.trim() || null,
      name: form.name.trim(),
      description: form.description.trim() || null,
      status: form.status,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase
          .from('deliverables')
          .insert({ ...payload, project_id: projectId })
          .select()
          .single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        // Handle status transitions: set started_at / completed_at automatically
        const patch = { ...payload }
        if (payload.status === 'in_progress' && !deliverable.started_at) patch.started_at = new Date().toISOString()
        if (payload.status === 'complete' && !deliverable.completed_at) patch.completed_at = new Date().toISOString()
        if (payload.status !== 'complete' && deliverable.completed_at) patch.completed_at = null
        const { data, error } = await supabase.from('deliverables').update(patch).eq('id', deliverable.id).select().single()
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
    if (!window.confirm('Delete this deliverable?')) return
    setErr(''); setBusy(true)
    try {
      const { error } = await supabase.from('deliverables').delete().eq('id', deliverable.id)
      if (error) throw error
      onSaved({ id: deliverable.id }, 'deleted')
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally { setBusy(false) }
  }

  return (
    <Modal onClose={onClose} title={isNew ? 'Add deliverable' : `Edit #${deliverable.number} ${deliverable.name}`} width="medium">
      <form onSubmit={handleSubmit} className="form-grid">
        <TextField id="number" type="number" min="1" label="Number" value={form.number} onChange={set('number')} required />
        <SelectField id="status" label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTS} />
        <TextField id="category" label="Category" span="full" value={form.category} onChange={set('category')} placeholder='"Brand Architecture", "Google Business"…' />
        <TextField id="name" label="Name" span="full" required value={form.name} onChange={set('name')} autoFocus placeholder='"Color Palette", "Review QR Code"…' />
        <TextareaField id="description" label="Description" value={form.description} onChange={set('description')} />
        <TextareaField id="notes" label="Notes / work log" value={form.notes} onChange={set('notes')} rows={4} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add deliverable' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
