import { useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const METHOD_OPTS = [
  { value: 'stripe_ach', label: 'Stripe ACH' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'check', label: 'Check' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
]

export default function MarkPaidModal({ invoice, onClose, onSaved }) {
  const total = parseFloat(invoice.total) || 0
  const [form, setForm] = useState({
    amount: String(total),
    date: new Date().toISOString().slice(0, 10),
    method: invoice.payment_method || 'stripe_ach',
    note: '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    const paid = parseFloat(form.amount) || 0
    if (paid <= 0) { setErr('Amount must be positive.'); return }
    setBusy(true)
    const isFull = paid >= total - 0.005
    const patch = {
      payment_method: form.method,
      paid_date: form.date,
      status: isFull ? 'paid' : 'partially_paid',
      paid_amount: isFull ? null : paid,
      notes: form.note ? ((invoice.notes ? invoice.notes + '\n— ' : '') + `Payment ${form.date}: $${paid} via ${form.method}. ${form.note}`) : invoice.notes,
    }
    try {
      const { data, error } = await supabase.from('invoices').update(patch).eq('id', invoice.id).select().single()
      if (error) throw error
      onSaved(data, 'updated')
      onClose()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  return (
    <Modal onClose={onClose} title={`Mark ${invoice.invoice_number} paid`} width="small">
      <form onSubmit={handleSubmit} className="form-grid">
        <TextField id="amount" type="number" step="0.01" label="Amount received" value={form.amount} onChange={set('amount')} required hint={`Invoice total: $${total.toFixed(2)}`} />
        <TextField id="date" type="date" label="Date received" value={form.date} onChange={set('date')} required />
        <SelectField id="method" label="Method" span="full" value={form.method} onChange={set('method')} options={METHOD_OPTS} />
        <TextareaField id="note" label="Note (optional)" value={form.note} onChange={set('note')} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Mark paid'}</button>
        </div>
      </form>
    </Modal>
  )
}
