import { useRef, useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
import { supabase } from '../../lib/supabase'

const STATUS_OPTS = [
  { value: 'lead', label: 'Lead' },
  { value: 'active', label: 'Active' },
  { value: 'past', label: 'Past' },
]
const PREFERRED_OPTS = [
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'text', label: 'Text' },
]
// lead_stage enum values — order mirrors the pipeline progression.
const LEAD_STAGE_OPTS = [
  { value: 'initial_contact', label: 'Initial contact' },
  { value: 'discovery',       label: 'Discovery' },
  { value: 'quoted',          label: 'Quoted' },
  { value: 'negotiating',     label: 'Negotiating' },
  { value: 'ready_to_sign',   label: 'Ready to sign' },
  { value: 'lost',            label: 'Lost' },
]
const LEAD_SOURCE_OPTS = [
  { value: 'referral',      label: 'Referral' },
  { value: 'website_form',  label: 'Website form' },
  { value: 'cold_outreach', label: 'Cold outreach' },
  { value: 'instagram_dm',  label: 'Instagram DM' },
  { value: 'phone_call',    label: 'Phone call' },
  { value: 'other',         label: 'Other' },
]
const TEMPERATURE_OPTS = [
  { value: 'cold', label: 'Cold' },
  { value: 'warm', label: 'Warm' },
  { value: 'hot',  label: 'Hot' },
]

function leadDetailsOf(contact) {
  const arr = contact?.lead_details
  if (!arr) return null
  if (Array.isArray(arr)) return arr[0] || null
  return arr
}

function toDateInput(d) {
  if (!d) return ''
  return String(d).slice(0, 10)
}

function fmtStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function todayIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function EditContactModal({ contact, onClose, onSaved }) {
  const isNew = !contact?.id
  const existingLd = leadDetailsOf(contact)
  const hasExistingLd = !!existingLd

  const [form, setForm] = useState({
    name: contact?.name || '',
    email: contact?.email || '',
    phone: contact?.phone || '',
    preferred_contact: contact?.preferred_contact || '',
    status: contact?.status || 'lead',
    notes: contact?.notes || '',
  })

  // When existing lead_details exists OR the user opts into tracking,
  // `trackingLead` flips on. `lead` holds the editable lead_details
  // payload. Defaults pulled from the enum column defaults so new
  // conversions land in a sensible initial state.
  const [trackingLead, setTrackingLead] = useState(hasExistingLd)
  const [lead, setLead] = useState({
    stage:             existingLd?.stage             || 'initial_contact',
    source:            existingLd?.source            || '',
    referred_by:       existingLd?.referred_by       || '',
    temperature:       existingLd?.temperature       || 'warm',
    next_follow_up:    existingLd?.next_follow_up    || '',
    last_contact_date: existingLd?.last_contact_date || '',
    next_step:         existingLd?.next_step         || '',
    notes:             existingLd?.notes             || '',
    lost_reason:       existingLd?.lost_reason       || '',
  })
  const [touchNote, setTouchNote] = useState('')
  const [showLostReason, setShowLostReason] = useState(existingLd?.stage === 'lost')

  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // Synchronous double-click guard on "Log touch now". setState is
  // async + batched so a state flag doesn't block rapid clicks; a
  // useRef mutates synchronously inside the handler and does.
  const logTouchLocked = useRef(false)
  const [loggingTouch, setLoggingTouch] = useState(false)

  const set     = (key) => (value) => setForm((f) => ({ ...f, [key]: value }))
  const setLead_ = (key) => (value) => setLead((l) => ({ ...l, [key]: value }))

  const onStageChange = (value) => {
    setLead((l) => ({ ...l, stage: value }))
    if (value === 'lost') setShowLostReason(true)
  }

  const markAsLost = () => {
    setLead((l) => ({ ...l, stage: 'lost' }))
    setShowLostReason(true)
  }

  const logTouch = () => {
    if (logTouchLocked.current) return
    logTouchLocked.current = true
    setLoggingTouch(true)
    try {
      const now = new Date()
      setLead((l) => {
        const next = { ...l, last_contact_date: todayIso() }
        const trimmed = touchNote.trim()
        if (trimmed) {
          const line = `[${fmtStamp(now)}] ${trimmed}`
          next.notes = l.notes ? `${line}\n\n${l.notes}` : line
        }
        return next
      })
      setTouchNote('')
    } finally {
      // Release the guard after a short window so intentional
      // successive touches (multiple calls in a row) still work.
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
    if (trackingLead && lead.stage === 'lost' && !lead.lost_reason.trim()) {
      setErr('Lost reason is required when marking a lead as lost.'); return
    }

    setBusy(true)
    const contactPayload = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      preferred_contact: form.preferred_contact || null,
      status: form.status,
      notes: form.notes.trim() || null,
    }
    try {
      let row
      if (isNew) {
        const { data, error } = await supabase.from('contacts').insert(contactPayload).select().single()
        if (error) throw error
        row = data
      } else {
        const { data, error } = await supabase.from('contacts').update(contactPayload).eq('id', contact.id).select().single()
        if (error) throw error
        row = data
      }

      // Lead-details upsert: only when the user is tracking this
      // contact as a lead. If they never opted in + there's no
      // existing row, we skip — no empty placeholder rows.
      if (trackingLead) {
        const leadPayload = {
          contact_id: row.id,
          stage: lead.stage,
          source: lead.source || null,
          referred_by: lead.referred_by.trim() || null,
          temperature: lead.temperature,
          next_follow_up: lead.next_follow_up || null,
          last_contact_date: lead.last_contact_date || null,
          next_step: lead.next_step.trim() || null,
          notes: lead.notes.trim() || null,
          lost_reason: lead.stage === 'lost' ? (lead.lost_reason.trim() || null) : null,
        }
        const { error: ldErr } = await supabase
          .from('lead_details')
          .upsert(leadPayload, { onConflict: 'contact_id' })
        if (ldErr) throw ldErr
      }

      onSaved(row, isNew ? 'created' : 'updated')
      onClose()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    const msg = contact.status === 'active'
      ? 'DELETE an ACTIVE contact? Only proceeds if no clients are attached.'
      : 'Delete this contact? This cannot be undone. (Only works if no clients attached.)'
    if (!window.confirm(msg)) return
    setErr(''); setBusy(true)
    try {
      // lead_details has ON DELETE CASCADE, so the lead row is
      // cleaned up automatically by Postgres.
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
        <SelectField id="preferred_contact" label="Preferred contact" value={form.preferred_contact} onChange={set('preferred_contact')} options={PREFERRED_OPTS} placeholder="—" />
        <SelectField id="status" label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTS} />
        <TextareaField id="notes" label="Notes" value={form.notes} onChange={set('notes')} />

        <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="eyebrow">Lead pipeline</div>
          {!trackingLead && !hasExistingLd && (
            <button type="button" className="btn btn-secondary" onClick={() => setTrackingLead(true)}>
              Convert to lead
            </button>
          )}
          {trackingLead && lead.stage !== 'lost' && hasExistingLd && (
            <button type="button" className="btn btn-danger-link" onClick={markAsLost}>
              Mark as lost
            </button>
          )}
        </div>

        {trackingLead && (
          <>
            <SelectField id="stage" label="Stage" value={lead.stage} onChange={onStageChange} options={LEAD_STAGE_OPTS} />
            <SelectField id="source" label="Source" value={lead.source} onChange={setLead_('source')} options={LEAD_SOURCE_OPTS} placeholder="—" />
            <SelectField id="temperature" label="Temperature" value={lead.temperature} onChange={setLead_('temperature')} options={TEMPERATURE_OPTS} />
            <TextField id="referred_by" label="Referred by" value={lead.referred_by} onChange={setLead_('referred_by')} placeholder="Name of the person who referred them" />
            <TextField id="next_follow_up" type="date" label="Next follow-up" value={toDateInput(lead.next_follow_up)} onChange={setLead_('next_follow_up')} />
            <TextField id="last_contact_date" type="date" label="Last contact date" value={toDateInput(lead.last_contact_date)} onChange={setLead_('last_contact_date')} />
            <TextareaField id="next_step" label="Next step" value={lead.next_step} onChange={setLead_('next_step')} rows={2} />

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

            <TextareaField id="lead_notes" label="Lead notes" value={lead.notes} onChange={setLead_('notes')} rows={4} />

            {(lead.stage === 'lost' || showLostReason) && (
              <TextareaField
                id="lost_reason"
                label="Lost reason"
                value={lead.lost_reason}
                onChange={setLead_('lost_reason')}
                rows={2}
                placeholder="Why did this lead fall through? (stored for future reference)"
              />
            )}
          </>
        )}

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
