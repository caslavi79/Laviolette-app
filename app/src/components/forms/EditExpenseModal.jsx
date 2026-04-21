import { useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const CATEGORY_OPTS = [
  { value: 'software',     label: 'Software (Line 18)' },
  { value: 'domains',      label: 'Domains (Line 27a)' },
  { value: 'hosting',      label: 'Hosting (Line 27a)' },
  { value: 'meals',        label: 'Meals (Line 24b, 50%)' },
  { value: 'home_office',  label: 'Home Office (Line 30, 33%)' },
  { value: 'equipment',    label: 'Equipment (Line 13)' },
  { value: 'phone',        label: 'Phone (Line 25)' },
  { value: 'supplies',     label: 'Supplies (Line 22)' },
  { value: 'travel',       label: 'Travel (Line 24a)' },
  { value: 'professional', label: 'Professional (Line 17)' },
  { value: 'marketing',    label: 'Marketing (Line 8)' },
  { value: 'other',        label: 'Other (Line 27a)' },
]

const DEFAULT_DEDUCTION = {
  meals: 50,
  home_office: 33,
  phone: 100,
}

export default function EditExpenseModal({ expense, clients, brands, onClose, onSaved }) {
  const isNew = !expense?.id
  const [form, setForm] = useState({
    date: expense?.date || new Date().toISOString().slice(0, 10),
    amount: expense?.amount ?? '',
    description: expense?.description || '',
    vendor: expense?.vendor || '',
    category: expense?.category || 'software',
    subcategory: expense?.subcategory || '',
    tax_deductible: expense?.tax_deductible ?? true,
    deduction_percentage: expense?.deduction_percentage ?? 100,
    client_id: expense?.client_id || '',
    brand_id: expense?.brand_id || '',
    is_recurring: expense?.is_recurring ?? false,
    recurring_day: expense?.recurring_day ?? '',
    notes: expense?.notes || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k) => (v) => setForm((f) => {
    const next = { ...f, [k]: v }
    if (k === 'category' && DEFAULT_DEDUCTION[v] != null && !expense?.id) {
      next.deduction_percentage = DEFAULT_DEDUCTION[v]
    }
    return next
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.description.trim()) { setErr('Description required.'); return }
    if (!form.amount) { setErr('Amount required.'); return }
    const amt = parseFloat(form.amount)
    if (!Number.isFinite(amt) || amt <= 0) { setErr('Amount must be a positive number.'); return }
    setBusy(true)
    const payload = {
      date: form.date,
      amount: parseFloat(form.amount),
      description: form.description.trim(),
      vendor: form.vendor.trim() || null,
      category: form.category,
      subcategory: form.subcategory.trim() || null,
      tax_deductible: !!form.tax_deductible,
      deduction_percentage: parseInt(form.deduction_percentage, 10) || 100,
      client_id: form.client_id || null,
      brand_id: form.brand_id || null,
      is_recurring: !!form.is_recurring,
      recurring_day: form.is_recurring ? (parseInt(form.recurring_day, 10) || parseInt(form.date.slice(8, 10), 10)) : null,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase.from('expenses').insert(payload).select().single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        const { data, error } = await supabase.from('expenses').update(payload).eq('id', expense.id).select().single()
        if (error) throw error
        onSaved(data, 'updated')
      }
      onClose()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this expense?')) return
    setBusy(true); setErr('')
    try {
      const { error } = await supabase.from('expenses').delete().eq('id', expense.id)
      if (error) throw error
      onSaved({ id: expense.id }, 'deleted')
      onClose()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  const clientOpts = [{ value: '', label: '— not client-specific' }, ...clients.map((c) => ({ value: c.id, label: c.legal_name || c.name }))]
  const brandOpts = [{ value: '', label: '—' }, ...brands.filter((b) => !form.client_id || b.client_id === form.client_id).map((b) => ({ value: b.id, label: b.name }))]

  return (
    <Modal onClose={onClose} title={isNew ? 'Add expense' : `Edit ${expense.description}`} width="medium">
      <form onSubmit={handleSubmit} className="form-grid">
        <TextField id="amount" type="number" step="0.01" min="0" label="Amount ($)" required autoFocus value={form.amount} onChange={set('amount')} inputMode="decimal" />
        <TextField id="date" type="date" label="Date" required value={form.date} onChange={set('date')} />
        <TextField id="description" label="Description" span="full" required value={form.description} onChange={set('description')} placeholder='"Claude Pro subscription", "Client dinner — Dustin"' />
        <TextField id="vendor" label="Vendor" value={form.vendor} onChange={set('vendor')} placeholder="Anthropic, GoDaddy, etc." />
        <SelectField id="category" label="Category" value={form.category} onChange={set('category')} options={CATEGORY_OPTS} />
        <TextField id="subcategory" label="Subcategory" value={form.subcategory} onChange={set('subcategory')} />
        <TextField id="deduction_percentage" type="number" min="0" max="100" label="Deduction %" value={form.deduction_percentage} onChange={set('deduction_percentage')} hint="Meals=50, home office=33, most=100" />
        <SelectField id="client_id" label="For client (optional)" value={form.client_id} onChange={set('client_id')} options={clientOpts} />
        <SelectField id="brand_id" label="For brand (optional)" value={form.brand_id} onChange={set('brand_id')} options={brandOpts} />
        <div className="field field--checkbox">
          <label htmlFor="tax_deductible">
            <input id="tax_deductible" type="checkbox" checked={form.tax_deductible} onChange={(e) => set('tax_deductible')(e.target.checked)} />
            <span>Tax deductible</span>
          </label>
        </div>
        <div className="field field--checkbox">
          <label htmlFor="is_recurring">
            <input id="is_recurring" type="checkbox" checked={form.is_recurring} onChange={(e) => set('is_recurring')(e.target.checked)} />
            <span>Recurring monthly</span>
          </label>
        </div>
        {form.is_recurring && (
          <TextField id="recurring_day" type="number" min="1" max="31" label="Recurs on day (1–31)" value={form.recurring_day} onChange={set('recurring_day')} hint="Defaults to the date's day-of-month." />
        )}
        <TextareaField id="notes" label="Notes" value={form.notes} onChange={set('notes')} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add expense' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
