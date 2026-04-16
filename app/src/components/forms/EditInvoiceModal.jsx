import { useState, useEffect } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'
import { fmtMoneyShort } from '../../lib/format'

const STATUS_OPTS = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'void', label: 'Void' },
]

const blankLine = () => ({ description: '', amount: '' })

export default function EditInvoiceModal({ invoice, clients, brands, projects, onClose, onSaved }) {
  const isNew = !invoice?.id
  const [form, setForm] = useState({
    client_id: invoice?.client_id || '',
    brand_id: invoice?.brand_id || '',
    project_id: invoice?.project_id || '',
    invoice_number: invoice?.invoice_number || '',
    description: invoice?.description || '',
    line_items: invoice?.line_items?.length > 0 ? invoice.line_items : [blankLine()],
    tax: invoice?.tax ?? 0,
    status: invoice?.status || 'draft',
    due_date: invoice?.due_date || new Date().toISOString().slice(0, 10),
    notes: invoice?.notes || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))
  const setLine = (idx, key) => (v) => setForm((f) => {
    const next = [...f.line_items]
    next[idx] = { ...next[idx], [key]: v }
    return { ...f, line_items: next }
  })
  const addLine = () => setForm((f) => ({ ...f, line_items: [...f.line_items, blankLine()] }))
  const removeLine = (idx) => setForm((f) => ({ ...f, line_items: f.line_items.filter((_, i) => i !== idx) }))

  // Pre-fetch next invoice number for new invoices
  useEffect(() => {
    if (!isNew || form.invoice_number) return
    supabase.rpc('next_invoice_number').then(({ data }) => {
      if (data) setForm((f) => ({ ...f, invoice_number: data }))
    })
  }, [isNew])  // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-generate a description when project changes
  useEffect(() => {
    if (!isNew || form.description) return
    if (!form.project_id) return
    const p = projects.find((p) => p.id === form.project_id)
    if (!p) return
    const monthLabel = new Date(form.due_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const desc = p.type === 'retainer' ? `${p.brands?.name || p.name} Retainer — ${monthLabel}` : `${p.brands?.name || p.name} Buildout`
    setForm((f) => ({ ...f, description: desc, brand_id: p.brand_id || f.brand_id, client_id: p.brands?.client_id || f.client_id }))
    if (form.line_items.length === 1 && !form.line_items[0].description) {
      setForm((f) => ({ ...f, line_items: [{ description: desc, amount: String(p.total_fee ?? '') }] }))
    }
  }, [form.project_id])  // eslint-disable-line react-hooks/exhaustive-deps

  const subtotal = form.line_items.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0)
  const total = subtotal + (parseFloat(form.tax) || 0)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.client_id) { setErr('Pick a client.'); return }
    if (!form.invoice_number.trim()) { setErr('Invoice number required.'); return }
    if (!form.due_date) { setErr('Due date required.'); return }
    if (form.line_items.length === 0 || form.line_items.every((l) => !l.description)) {
      setErr('At least one line item required.'); return
    }
    setBusy(true)
    const clean = form.line_items
      .filter((l) => l.description || l.amount)
      .map((l) => ({ description: l.description, amount: parseFloat(l.amount) || 0 }))
    const payload = {
      client_id: form.client_id,
      brand_id: form.brand_id || null,
      project_id: form.project_id || null,
      invoice_number: form.invoice_number.trim(),
      description: form.description.trim() || null,
      line_items: clean,
      subtotal,
      tax: parseFloat(form.tax) || 0,
      total,
      status: form.status,
      due_date: form.due_date,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase.from('invoices').insert(payload).select().single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        const { data, error } = await supabase.from('invoices').update(payload).eq('id', invoice.id).select().single()
        if (error) throw error
        onSaved(data, 'updated')
      }
      onClose()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this invoice? This cannot be undone.')) return
    setBusy(true); setErr('')
    try {
      const { error } = await supabase.from('invoices').delete().eq('id', invoice.id)
      if (error) throw error
      onSaved({ id: invoice.id }, 'deleted')
      onClose()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  const clientOpts = [{ value: '', label: 'Pick a client…' }, ...clients.map((c) => ({ value: c.id, label: c.legal_name || c.name }))]
  const brandOpts = [{ value: '', label: '—' }, ...brands.filter((b) => !form.client_id || b.client_id === form.client_id).map((b) => ({ value: b.id, label: b.name }))]
  const projectOpts = [{ value: '', label: '—' }, ...projects.filter((p) => {
    if (form.brand_id) return p.brand_id === form.brand_id
    if (form.client_id) return p.brands?.client_id === form.client_id
    return true
  }).map((p) => ({ value: p.id, label: `${p.name} (${p.type})` }))]

  return (
    <Modal onClose={onClose} title={isNew ? 'Create invoice' : `Edit ${invoice.invoice_number}`} width="large">
      <form onSubmit={handleSubmit} className="form-grid">
        <TextField id="invoice_number" label="Invoice #" value={form.invoice_number} onChange={set('invoice_number')} required />
        <SelectField id="status" label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTS} />
        <SelectField id="client_id" label="Client" span="full" value={form.client_id} onChange={set('client_id')} options={clientOpts} />
        <SelectField id="brand_id" label="Brand (optional)" value={form.brand_id} onChange={set('brand_id')} options={brandOpts} />
        <SelectField id="project_id" label="Project (optional)" value={form.project_id} onChange={set('project_id')} options={projectOpts} />
        <TextField id="description" label="Description" span="full" value={form.description} onChange={set('description')} placeholder='"Citrus and Salt Retainer — May 2026"' />
        <div className="field field--span-full">
          <label>Line items</label>
          <div className="line-items">
            {form.line_items.map((l, idx) => (
              <div key={idx} className="line-item">
                <input
                  type="text"
                  placeholder="Description"
                  value={l.description}
                  onChange={(e) => setLine(idx, 'description')(e.target.value)}
                />
                <input
                  type="number"
                  step="0.01"
                  placeholder="Amount"
                  value={l.amount}
                  onChange={(e) => setLine(idx, 'amount')(e.target.value)}
                />
                <button type="button" className="btn btn-danger-link" onClick={() => removeLine(idx)}>×</button>
              </div>
            ))}
            <button type="button" className="btn btn-link" onClick={addLine}>+ Add line</button>
          </div>
        </div>
        <TextField id="due_date" type="date" label="Due date" required value={form.due_date} onChange={set('due_date')} />
        <TextField id="tax" type="number" step="0.01" label="Tax ($)" value={form.tax} onChange={set('tax')} />
        <div className="field field--span-full">
          <label>Totals</label>
          <div className="invoice-totals">
            <span>Subtotal: <strong>{fmtMoneyShort(subtotal)}</strong></span>
            <span>Tax: <strong>{fmtMoneyShort(parseFloat(form.tax) || 0)}</strong></span>
            <span>Total: <strong>{fmtMoneyShort(total)}</strong></span>
          </div>
        </div>
        <TextareaField id="notes" label="Notes" value={form.notes} onChange={set('notes')} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Create invoice' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
