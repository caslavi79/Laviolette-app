import { useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const STATUS_OPTS = [
  { value: 'lead', label: 'Lead' },
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past' },
]
const PAYMENT_OPTS = [
  { value: 'stripe_ach', label: 'Stripe ACH' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'check', label: 'Check' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
]

export default function EditClientModal({ contactId, client, onClose, onSaved }) {
  const isNew = !client?.id
  const [form, setForm] = useState({
    name: client?.name || '',
    legal_name: client?.legal_name || '',
    billing_email: client?.billing_email || '',
    billing_address: client?.billing_address || '',
    ein: client?.ein || '',
    payment_method: client?.payment_method || 'stripe_ach',
    stripe_customer_id: client?.stripe_customer_id || '',
    bank_info_on_file: client?.bank_info_on_file || false,
    status: client?.status || 'active',
    notes: client?.notes || '',
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
      legal_name: form.legal_name.trim() || null,
      billing_email: form.billing_email.trim() || null,
      billing_address: form.billing_address.trim() || null,
      ein: form.ein.trim() || null,
      payment_method: form.payment_method,
      stripe_customer_id: form.stripe_customer_id.trim() || null,
      bank_info_on_file: !!form.bank_info_on_file,
      status: form.status,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase
          .from('clients')
          .insert({ ...payload, contact_id: contactId })
          .select()
          .single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        const { data, error } = await supabase
          .from('clients')
          .update(payload)
          .eq('id', client.id)
          .select()
          .single()
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
    if (!window.confirm('Delete this client? This cannot be undone. (Only works if no brands/invoices/contracts.)')) return
    setErr(''); setBusy(true)
    try {
      const { error } = await supabase.from('clients').delete().eq('id', client.id)
      if (error) throw error
      onSaved({ id: client.id }, 'deleted')
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
      title={isNew ? 'Add client (LLC / business)' : `Edit ${client.name}`}
      width="medium"
    >
      <form onSubmit={handleSubmit} className="form-grid">
        <TextField id="name" label="Display name" span="full" required value={form.name} onChange={set('name')} placeholder="VBTX Group" autoFocus />
        <TextField id="legal_name" label="Legal name" span="full" value={form.legal_name} onChange={set('legal_name')} placeholder="VBTX Group LLC" />
        <TextField id="billing_email" type="email" label="Billing email" value={form.billing_email} onChange={set('billing_email')} />
        <TextField id="ein" label="EIN" value={form.ein} onChange={set('ein')} />
        <TextField id="billing_address" label="Billing address" span="full" value={form.billing_address} onChange={set('billing_address')} />
        <SelectField id="payment_method" label="Payment method" value={form.payment_method} onChange={set('payment_method')} options={PAYMENT_OPTS} />
        <SelectField id="status" label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTS} />
        <TextField id="stripe_customer_id" label="Stripe customer ID" span="full" value={form.stripe_customer_id} onChange={set('stripe_customer_id')} placeholder="cus_..." hint="Create the customer in Stripe first, then paste the ID here." />
        <div className="field field--span-full field--checkbox">
          <label htmlFor="bank_info_on_file">
            <input
              id="bank_info_on_file"
              type="checkbox"
              checked={!!form.bank_info_on_file}
              onChange={(e) => set('bank_info_on_file')(e.target.checked)}
            />
            <span>Bank info on file in Stripe (ACH connected)</span>
          </label>
        </div>
        <TextareaField id="notes" label="Notes" value={form.notes} onChange={set('notes')} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add client' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
