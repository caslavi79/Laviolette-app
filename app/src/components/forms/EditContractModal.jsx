import { useState, useEffect } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const TYPE_OPTS = [
  { value: 'buildout', label: 'Buildout' },
  { value: 'retainer', label: 'Retainer' },
]
const STATUS_OPTS = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent (waiting for signature)' },
  { value: 'signed', label: 'Signed' },
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'terminated', label: 'Terminated' },
]

export default function EditContractModal({ contract, clients, brands, projects, onClose, onSaved }) {
  const isNew = !contract?.id
  const [form, setForm] = useState({
    client_id: contract?.client_id || '',
    brand_id: contract?.brand_id || '',
    project_id: contract?.project_id || '',
    name: contract?.name || '',
    type: contract?.type || 'buildout',
    status: contract?.status || 'draft',
    effective_date: contract?.effective_date || '',
    signing_date: contract?.signing_date || '',
    end_date: contract?.end_date || '',
    monthly_rate: contract?.monthly_rate ?? '',
    total_fee: contract?.total_fee ?? '',
    termination_fee: contract?.termination_fee ?? '',
    payment_terms: contract?.payment_terms || '',
    auto_renew: contract?.auto_renew ?? false,
    renewal_notice_days: contract?.renewal_notice_days ?? 30,
    filled_html: contract?.filled_html || '',
    signer_name: contract?.signer_name || '',
    signer_email: contract?.signer_email || '',
    notes: contract?.notes || '',
  })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  // Auto-fill name + counter-fields from project
  useEffect(() => {
    if (!isNew || form.name) return
    if (!form.project_id) return
    const p = projects.find((p) => p.id === form.project_id)
    if (!p) return
    const nameSuffix = p.type === 'retainer' ? 'Retainer Agreement' : 'Build-Out Agreement'
    setForm((f) => ({
      ...f,
      name: `${p.brands?.name || p.name} ${nameSuffix}`,
      type: p.type,
      brand_id: p.brand_id,
      client_id: p.brands?.client_id || f.client_id,
      [p.type === 'retainer' ? 'monthly_rate' : 'total_fee']: p.total_fee ?? '',
    }))
  }, [form.project_id])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.client_id) { setErr('Pick a client.'); return }
    if (!form.name.trim()) { setErr('Contract name required.'); return }
    setBusy(true)
    const payload = {
      client_id: form.client_id,
      brand_id: form.brand_id || null,
      project_id: form.project_id || null,
      name: form.name.trim(),
      type: form.type,
      status: form.status,
      effective_date: form.effective_date || null,
      signing_date: form.signing_date || null,
      end_date: form.end_date || null,
      monthly_rate: form.monthly_rate === '' ? null : parseFloat(form.monthly_rate),
      total_fee: form.total_fee === '' ? null : parseFloat(form.total_fee),
      termination_fee: form.termination_fee === '' ? null : parseFloat(form.termination_fee),
      payment_terms: form.payment_terms.trim() || null,
      auto_renew: !!form.auto_renew,
      renewal_notice_days: parseInt(form.renewal_notice_days, 10) || 30,
      filled_html: form.filled_html.trim() || null,
      signer_name: form.signer_name.trim() || null,
      signer_email: form.signer_email.trim() || null,
      notes: form.notes.trim() || null,
    }
    try {
      if (isNew) {
        const { data, error } = await supabase.from('contracts').insert(payload).select().single()
        if (error) throw error
        onSaved(data, 'created')
      } else {
        const { data, error } = await supabase.from('contracts').update(payload).eq('id', contract.id).select().single()
        if (error) throw error
        onSaved(data, 'updated')
      }
      onClose()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  const handleDelete = async () => {
    if (!window.confirm('Delete this contract?')) return
    setBusy(true); setErr('')
    try {
      const { error } = await supabase.from('contracts').delete().eq('id', contract.id)
      if (error) throw error
      onSaved({ id: contract.id }, 'deleted')
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
    <Modal onClose={onClose} title={isNew ? 'New contract' : `Edit ${contract.name}`} width="large">
      <form onSubmit={handleSubmit} className="form-grid">
        <SelectField id="project_id" label="Project (pre-fills everything)" span="full" value={form.project_id} onChange={set('project_id')} options={projectOpts} placeholder="—" />
        <SelectField id="client_id" label="Client" value={form.client_id} onChange={set('client_id')} options={clientOpts} />
        <SelectField id="brand_id" label="Brand" value={form.brand_id} onChange={set('brand_id')} options={brandOpts} />
        <TextField id="name" label="Contract name" span="full" required value={form.name} onChange={set('name')} placeholder='"Citrus and Salt Build-Out Agreement"' />
        <SelectField id="type" label="Type" value={form.type} onChange={set('type')} options={TYPE_OPTS} />
        <SelectField id="status" label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTS} />
        <TextField id="effective_date" type="date" label="Effective date" value={form.effective_date} onChange={set('effective_date')} />
        <TextField id="end_date" type="date" label={form.type === 'retainer' ? 'Intro-term end' : 'Completion target'} value={form.end_date} onChange={set('end_date')} />
        {form.type === 'buildout' ? (
          <TextField id="total_fee" type="number" step="0.01" label="Total fee ($)" value={form.total_fee} onChange={set('total_fee')} />
        ) : (
          <TextField id="monthly_rate" type="number" step="0.01" label="Monthly rate ($)" value={form.monthly_rate} onChange={set('monthly_rate')} />
        )}
        <TextField id="termination_fee" type="number" step="0.01" label="Termination fee ($)" value={form.termination_fee} onChange={set('termination_fee')} />
        <TextField id="payment_terms" label="Payment terms" span="full" value={form.payment_terms} onChange={set('payment_terms')} placeholder='"Due at signing", "ACH on 1st of month"…' />
        {form.type === 'retainer' && (
          <>
            <div className="field field--checkbox">
              <label htmlFor="auto_renew">
                <input id="auto_renew" type="checkbox" checked={form.auto_renew} onChange={(e) => set('auto_renew')(e.target.checked)} />
                <span>Auto-renew after intro term</span>
              </label>
            </div>
            <TextField id="renewal_notice_days" type="number" min="0" label="Renewal alert (days before end)" value={form.renewal_notice_days} onChange={set('renewal_notice_days')} />
          </>
        )}
        <TextField id="signer_name" label="Signer name" value={form.signer_name} onChange={set('signer_name')} placeholder="Dustin Batson" />
        <TextField id="signer_email" type="email" label="Signer email" value={form.signer_email} onChange={set('signer_email')} />
        <TextField id="signing_date" type="date" label="Signing date" value={form.signing_date} onChange={set('signing_date')} />
        <TextareaField
          id="filled_html"
          label="Contract content (HTML or plain text)"
          value={form.filled_html}
          onChange={set('filled_html')}
          rows={10}
          span="full"
          placeholder="Paste the filled contract content here. This is what the client sees on the signing page."
        />
        <TextareaField id="notes" label="Internal notes" value={form.notes} onChange={set('notes')} />
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions">
          {!isNew && <button type="button" className="btn btn-danger-link" onClick={handleDelete} disabled={busy}>Delete</button>}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Create contract' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}
