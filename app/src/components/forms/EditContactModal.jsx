import { useRef, useState } from 'react'
import Modal from '../Modal'
import { Field, TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const STATUS_OPTS = [
  { value: 'lead', label: 'Lead' },
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past' },
]
const STAGE_OPTS = [
  { value: 'lead',     label: 'Lead' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'active',   label: 'Active' },
  { value: 'past',     label: 'Past' },
  { value: 'dead',     label: 'Dead' },
]
const PREFERRED_OPTS = [
  { value: '', label: '—' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'text', label: 'Text' },
]

function toDateInput(ts) {
  if (!ts) return ''
  // ts can be timestamptz (ISO with time) or date (YYYY-MM-DD)
  return String(ts).slice(0, 10)
}

function fmtStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function EditContactModal({ contact, onClose, onSaved }) {
  const isNew = !contact?.id
  const initialStage = contact?.stage || 'lead'
  const [form, setForm] = useState({
    name: contact?.name || '',
    email: contact?.email || '',
    phone: contact?.phone || '',
    preferred_contact: contact?.preferred_contact || '',
    status: contact?.status || 'lead',
    notes: contact?.notes || '',
    stage: initialStage,
    lead_source: contact?.lead_source || '',
    last_contacted_at: contact?.last_contacted_at || null,
    next_touch_at: contact?.next_touch_at || '',
    lead_notes: contact?.lead_notes || '',
  })
  const [touchNote, setTouchNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // Synchronous double-click guard on "Log touch now". State-based
  // guard doesn't work — React batches setState, so rapid clicks all
  // see `loggingTouch=false` before the first setState commits, and
  // all fire. useRef mutates synchronously within the handler, so the
  // second click reads the already-true value and early-returns.
  // loggingTouch state is kept purely to drive the visible button
  // label change ("Log touch now" → "Logged ✓") during the debounce.
  const logTouchLocked = useRef(false)
  const [loggingTouch, setLoggingTouch] = useState(false)

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))

  const logTouch = () => {
    if (logTouchLocked.current) return
    logTouchLocked.current = true
    setLoggingTouch(true)
    try {
      const now = new Date()
      setForm((f) => {
        const next = { ...f, last_contacted_at: now.toISOString() }
        const trimmed = touchNote.trim()
        if (trimmed) {
          const line = `[${fmtStamp(now)}] ${trimmed}`
          next.lead_notes = f.lead_notes ? `${line}\n\n${f.lead_notes}` : line
        }
        return next
      })
      setTouchNote('')
    } finally {
      // Release the guard after a short interval so intentional
      // successive touches (e.g. multiple phone calls in a row) still
      // work, but within a single mis-tap window they collapse.
      setTimeout(() => {
        logTouchLocked.current = false
        setLoggingTouch(false)
      }, 400)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!form.name.trim()) { setErr('Name is required.'); return }

    // Soft warn when the stage doesn't match the relational reality.
    if (form.stage === 'active' && !isNew) {
      const { count } = await supabase
        .from('clients')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', contact.id)
      if ((count || 0) === 0) {
        if (!window.confirm('Stage is "active" but this contact has no clients attached. Save anyway?')) return
      }
    }
    if (!isNew && contact.stage === 'active' && form.stage === 'lead') {
      if (!window.confirm('Moving an active contact back to "lead". Save anyway?')) return
    }

    setBusy(true)
    const payload = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      preferred_contact: form.preferred_contact || null,
      status: form.status,
      notes: form.notes.trim() || null,
      stage: form.stage,
      lead_source: form.lead_source.trim() || null,
      last_contacted_at: form.last_contacted_at || null,
      next_touch_at: form.next_touch_at || null,
      lead_notes: form.lead_notes.trim() || null,
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
    const msg = contact.stage === 'active'
      ? 'DELETE an ACTIVE contact? This contact is flagged as an active engagement. Only proceeds if no clients are attached.'
      : 'Delete this contact? This cannot be undone. (Only works if no clients attached.)'
    if (!window.confirm(msg)) return
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

        <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 16 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Lead status</div>
        </div>

        <SelectField id="stage" label="Stage" value={form.stage} onChange={set('stage')} options={STAGE_OPTS} />
        <TextField id="lead_source" label="Lead source" value={form.lead_source} onChange={set('lead_source')} placeholder='e.g. "referral — Dustin"' />
        <TextField id="next_touch_at" type="date" label="Next touch" value={toDateInput(form.next_touch_at)} onChange={set('next_touch_at')} />
        <Field id="last_touched" label="Last touch">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span style={{ color: 'var(--text-md)' }}>
              {form.last_contacted_at ? new Date(form.last_contacted_at).toLocaleString() : '—'}
            </span>
          </div>
        </Field>

        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="text"
            value={touchNote}
            onChange={(e) => setTouchNote(e.target.value)}
            placeholder="Optional: what was the touch? (texted, called, emailed…)"
            style={{ flex: 1, padding: '8px 10px', background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--ivory)', fontSize: 13 }}
          />
          <button type="button" className="btn btn-secondary" onClick={logTouch} disabled={busy || loggingTouch}>
            {loggingTouch ? 'Logged ✓' : 'Log touch now'}
          </button>
        </div>

        <TextareaField id="lead_notes" label="Lead notes" value={form.lead_notes} onChange={set('lead_notes')} rows={4} />

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
