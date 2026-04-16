import { useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const STATUS_OPTS = [
  { value: 'lead', label: 'Lead' },
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past' },
]
const PREFERRED_OPTS = [
  { value: '', label: '—' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'text', label: 'Text' },
]

export default function EditContactModal({ contact, onClose, onSaved }) {
  const isNew = !contact?.id
  const [form, setForm] = useState({
    name: contact?.name || '',
    email: contact?.email || '',
    phone: contact?.phone || '',
    preferred_contact: contact?.preferred_contact || '',
    status: contact?.status || 'lead',
    notes: contact?.notes || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.name.trim()) { setErr('Name is required.'); return }
    setBusy(true)
    const payload = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      preferred_contact: form.preferred_contact || null,
      status: form.status,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase.from('contacts').insert(payload).select().single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        const { data, error } = await supabase.from('contacts').update(payload).eq('id', contact.id).select().single()
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
    if (!window.confirm('Delete this contact? This cannot be undone. (Only works if no clients attached.)')) return
    setErr(''); setBusy(true)
    try {
      const { error } = await supabase.from('contacts').delete().eq('id', contact.id)
      if (error) throw error
      onSaved({ id: contact.id }, 'deleted')
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={isNew ? 'Add contact' : `Edit ${contact.name}`}
      width="medium"
    >
      <form onSubmit={handleSubmit} className="form-grid">
        <TextField id="name" label="Name" span="full" required value={form.name} onChange={set('name')} autoFocus />
        <TextField id="email" type="email" label="Email" value={form.email} onChange={set('email')} />
        <TextField id="phone" label="Phone" value={form.phone} onChange={set('phone')} placeholder="(512) 555-1234" />
        <SelectField id="preferred_contact" label="Preferred contact" value={form.preferred_contact} onChange={set('preferred_contact')} options={PREFERRED_OPTS.slice(1)} placeholder="—" />
        <SelectField id="status" label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTS} />
        <TextareaField id="notes" label="Notes" value={form.notes} onChange={set('notes')} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
