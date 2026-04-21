import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fmtMoneyShort, fmtDate, badgeStyle, COLORS } from '../lib/format'
import EditContactModal from '../components/forms/EditContactModal'
import EditClientModal from '../components/forms/EditClientModal'
import EditBrandModal from '../components/forms/EditBrandModal'

/* --------- helpers --------- */

const STATUS_COLOR = {
  lead:   COLORS.amber,
  active: COLORS.green,
  past:   COLORS.slate,
}
// lead_stage enum → color. Neutral tan for early pipeline, copper for
// mid, amber-warm for ready-to-close, muted for terminal.
const LEAD_STAGE_COLOR = {
  initial_contact: '#9B8B73',
  discovery:       '#9B8B73',
  quoted:          COLORS.copper,
  negotiating:     COLORS.copper,
  ready_to_sign:   COLORS.amber,
  lost:            COLORS.steel,
}
const LEAD_STAGE_LABEL = {
  initial_contact: 'lead',
  discovery:       'discovery',
  quoted:          'quoted',
  negotiating:     'negotiating',
  ready_to_sign:   'ready to sign',
  lost:            'lost',
}
const BRAND_STATUS_COLOR = {
  active:     COLORS.green,
  paused:     COLORS.amber,
  offboarded: COLORS.slate,
}

// Pipeline stages = live leads. 'lost' is terminal; contacts.status
// handles active/past. Used to decide whether to surface lead_details
// vs. fall back to contacts.status for the pill.
const PIPELINE_STAGES = ['initial_contact','discovery','quoted','negotiating','ready_to_sign']

function leadDetailsOf(contact) {
  const arr = contact?.lead_details
  if (!arr) return null
  if (Array.isArray(arr)) return arr[0] || null
  return arr
}

function StatusPill({ status, map = STATUS_COLOR }) {
  const color = map[status] || COLORS.steel
  return <span style={badgeStyle(color)}>{status}</span>
}

// Renders lead_details.stage when present, falling back to
// contacts.status (party_status enum) when the contact has no
// lead_details row.
function StagePill({ contact }) {
  const ld = leadDetailsOf(contact)
  if (ld) {
    const color = LEAD_STAGE_COLOR[ld.stage] || COLORS.steel
    return <span style={badgeStyle(color)}>{LEAD_STAGE_LABEL[ld.stage] || ld.stage}</span>
  }
  const color = STATUS_COLOR[contact.status] || COLORS.steel
  return <span style={badgeStyle(color)}>{contact.status}</span>
}

function StaleBadge() {
  return (
    <span
      title="Stale — follow-up overdue"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginLeft: 6,
        fontFamily: 'var(--label)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '1.5px',
        textTransform: 'uppercase',
        color: COLORS.amber,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: COLORS.amber,
          display: 'inline-block',
        }}
      />
      stale
    </span>
  )
}

/**
 * Compute billing-state pill for a client based on current invoices + bank status.
 * Priority order: past-due → clearing → queued → bank-needed → current → inert.
 */
function clientBillingState(client, invoices) {
  const clientInvoices = (invoices || []).filter((i) => i.client_id === client.id)
  const overdue = clientInvoices.find((i) => i.status === 'overdue')
  // "Clearing" = we've pushed it to Stripe and ACH is in flight. Check BOTH PI and
  // legacy Stripe-invoice IDs, since the new flow uses PaymentIntent.
  const hasStripeRef = (i) => i.stripe_payment_intent_id || i.stripe_invoice_id
  const clearing = clientInvoices.filter((i) => i.status === 'pending' && hasStripeRef(i))
  const queued = clientInvoices.filter((i) =>
    (i.status === 'pending' || i.status === 'draft') && !hasStripeRef(i)
  )
  const totalOf = (arr) => arr.reduce((s, i) => s + (parseFloat(i.total) || 0), 0)
  const nextDate = (arr) => {
    const dates = arr.map((i) => i.due_date).filter(Boolean).sort()
    return dates[0] || null
  }
  const fmtShortDate = (d) => {
    if (!d) return '—'
    const [y, m, day] = String(d).split('T')[0].split('-').map(Number)
    return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  if (overdue) {
    const total = totalOf(clientInvoices.filter((i) => i.status === 'overdue'))
    return { label: `PAST DUE · ${fmtMoneyShort(total)}`, color: COLORS.red }
  }
  if (clearing.length > 0) {
    const total = totalOf(clearing)
    return { label: `ACH CLEARING · ${fmtMoneyShort(total)}`, color: COLORS.amber }
  }
  if (queued.length > 0 && !client.bank_info_on_file) {
    const total = totalOf(queued)
    return { label: `AWAITING BANK INFO · ${fmtMoneyShort(total)}`, color: COLORS.slate }
  }
  if (queued.length > 0 && client.bank_info_on_file) {
    const total = totalOf(queued)
    const date = nextDate(queued)
    return { label: `QUEUED · ${fmtMoneyShort(total)} on ${fmtShortDate(date)}`, color: COLORS.amber }
  }
  if (client.bank_info_on_file) {
    return { label: 'BANK READY', color: COLORS.green }
  }
  if (client.stripe_customer_id) {
    return { label: 'AWAITING BANK INFO', color: COLORS.slate }
  }
  return null // no label when nothing meaningful (new client, no setup yet)
}

function BillingStatePill({ state }) {
  if (!state) return null
  return <span style={{ ...badgeStyle(state.color), marginLeft: 6 }}>{state.label}</span>
}

/* --------- page --------- */

export default function Contacts() {
  const [params] = useSearchParams()
  const highlightId = params.get('highlight')
  const [contacts, setContacts] = useState([])
  const [staleIds, setStaleIds] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [stageFilter, setStageFilter] = useState('all')
  const [selectedContactId, setSelectedContactId] = useState(null)
  const [financials, setFinancials] = useState({ byClient: new Map(), byBrand: new Map(), allInvoices: [], workByBrand: new Map(), retainerProjectByBrand: new Map() })
  const [modalState, setModalState] = useState(null) // { kind, data }
  const [bankLink, setBankLink] = useState(null)     // { url, client_name } — populated by Send Bank Link
  const [bankBusy, setBankBusy] = useState(false)
  const [err, setErr] = useState('')

  const loadContacts = useCallback(async () => {
    setLoading(true)
    setErr('')
    const [contactsRes, staleRes] = await Promise.all([
      supabase
        .from('contacts')
        .select(`
          *,
          lead_details (*),
          clients (
            *,
            brands (*)
          )
        `)
        .order('name'),
      supabase.from('v_stale_leads').select('contact_id'),
    ])
    if (contactsRes.error) {
      setErr(contactsRes.error.message)
      setContacts([])
      setStaleIds(new Set())
      setLoading(false)
      return
    }
    setContacts(contactsRes.data || [])
    setStaleIds(new Set((staleRes.data || []).map((r) => r.contact_id)))
    setLoading(false)
  }, [])

  const loadFinancials = useCallback(async () => {
    // Pull invoice rows (full) + project totals per brand + recent work_log per brand.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString()
    const [invRes, projRes, workRes] = await Promise.all([
      supabase.from('invoices').select('id, client_id, total, paid_amount, status, due_date, stripe_invoice_id, stripe_payment_intent_id, invoice_number'),
      supabase.from('projects').select('id, brand_id, type, total_fee, status'),
      supabase
        .from('work_log')
        .select('id, brand_id, service_id, title, notes, link_url, performed_at, retainer_services (name)')
        .gte('performed_at', thirtyDaysAgo)
        .order('performed_at', { ascending: false })
        .limit(400),
    ])
    if (invRes.error) { setErr(invRes.error.message); return }
    if (projRes.error) { setErr(projRes.error.message); return }
    const allInvoices = invRes.data || []
    const byClient = new Map()
    for (const i of allInvoices) {
      const entry = byClient.get(i.client_id) || { paid: 0, outstanding: 0, recurring: 0 }
      const total = parseFloat(i.total) || 0
      if (i.status === 'paid') entry.paid += total
      else if (i.status === 'partially_paid') {
        entry.paid += parseFloat(i.paid_amount) || 0
        entry.outstanding += total - (parseFloat(i.paid_amount) || 0)
      } else if (i.status === 'pending' || i.status === 'overdue' || i.status === 'sent') {
        entry.outstanding += total
      }
      byClient.set(i.client_id, entry)
    }
    const byBrand = new Map()
    const retainerProjectByBrand = new Map()
    for (const p of projRes.data || []) {
      const entry = byBrand.get(p.brand_id) || { buildoutTotal: 0, retainerMonthly: 0 }
      if (p.type === 'retainer' && p.status === 'active') entry.retainerMonthly += parseFloat(p.total_fee) || 0
      if (p.type === 'buildout') entry.buildoutTotal += parseFloat(p.total_fee) || 0
      byBrand.set(p.brand_id, entry)
      if (p.type === 'retainer' && !retainerProjectByBrand.has(p.brand_id)) {
        retainerProjectByBrand.set(p.brand_id, p.id)
      }
    }
    const workByBrand = new Map()
    for (const w of workRes.data || []) {
      if (!workByBrand.has(w.brand_id)) workByBrand.set(w.brand_id, [])
      workByBrand.get(w.brand_id).push(w)
    }
    setFinancials({ byClient, byBrand, allInvoices, workByBrand, retainerProjectByBrand })
  }, [])

  useEffect(() => { loadContacts(); loadFinancials() }, [loadContacts, loadFinancials])

  // Deep-link support: /contacts?highlight=<contact_id> (from Today's stale-leads
  // widget) scrolls to + flashes + selects the target row. Reuses the copper-halo
  // pattern established on the Money page.
  useEffect(() => {
    if (!highlightId || loading || contacts.length === 0) return
    setSelectedContactId(highlightId)
    const el = document.querySelector(`[data-contact-id="${highlightId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('contact-row--flash')
    const t = setTimeout(() => el.classList.remove('contact-row--flash'), 3000)
    return () => clearTimeout(t)
  }, [highlightId, loading, contacts.length])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = contacts.filter((c) => {
      const ld = leadDetailsOf(c)
      const inPipeline = ld && PIPELINE_STAGES.includes(ld.stage)
      const isLost     = ld && ld.stage === 'lost'

      if (stageFilter === 'all' && isLost) return false
      if (stageFilter === 'leads'  && !inPipeline) return false
      if (stageFilter === 'active' && !(c.status === 'active' && !inPipeline)) return false
      if (stageFilter === 'past'   && c.status !== 'past') return false
      if (stageFilter === 'lost'   && !isLost) return false

      if (!q) return true
      const haystack = [
        c.name, c.email, c.phone,
        ld?.referred_by, ld?.notes, ld?.next_step, ld?.scope_summary,
        ...(c.clients || []).flatMap((cl) => [cl.name, cl.legal_name, cl.billing_email]),
        ...(c.clients || []).flatMap((cl) => (cl.brands || []).flatMap((b) => [b.name, b.instagram_handle])),
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
    // Stale first, then most-recently-contacted. Null last_contact_date sorts oldest.
    return [...filtered].sort((a, b) => {
      const aStale = staleIds.has(a.id) ? 1 : 0
      const bStale = staleIds.has(b.id) ? 1 : 0
      if (aStale !== bStale) return bStale - aStale
      const at = leadDetailsOf(a)?.last_contact_date || ''
      const bt = leadDetailsOf(b)?.last_contact_date || ''
      return bt.localeCompare(at)
    })
  }, [contacts, search, stageFilter, staleIds])

  const selected = visible.find((c) => c.id === selectedContactId) || contacts.find((c) => c.id === selectedContactId)

  const handleModalSaved = (row, action) => {
    // Re-fetch to keep join data simple; cheap because tree is small.
    loadContacts()
    loadFinancials()
    if (action === 'created' && modalState?.kind === 'contact') {
      setSelectedContactId(row.id)
    }
    if (action === 'deleted' && modalState?.kind === 'contact' && row.id === selectedContactId) {
      setSelectedContactId(null)
    }
  }

  const sendBankLink = async (client) => {
    setBankBusy(true); setBankLink(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) throw new Error('Not authenticated.')
      const url = import.meta.env.VITE_SUPABASE_URL
      const resp = await fetch(`${url}/functions/v1/create-setup-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          stripe_customer_id: client.stripe_customer_id,
          client_name: client.legal_name || client.name,
        }),
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text || `HTTP ${resp.status}`)
      }
      const payload = await resp.json()
      setBankLink({ url: payload.url, client_name: client.legal_name || client.name, client_id: client.id })
    } catch (e) {
      // Graceful fallback: edge fn not deployed yet. Point to the local CLI.
      setBankLink({
        error: e.message,
        client_id: client.id,
        fallbackHint: `Edge function not live yet. Until it is, generate a link locally:\n\n  npm run stripe-setup -- ${client.stripe_customer_id} "${client.legal_name || client.name}"`,
      })
    } finally {
      setBankBusy(false)
    }
  }

  return (
    <div className="contacts-page">
      <div className="page-header">
        <span className="eyebrow">Directory</span>
        <h1>Contacts, Clients &amp; Brands</h1>
        <p>One human can own many clients; one client can operate many brands.</p>
      </div>

      <div className="list-toolbar">
        <input
          type="search"
          placeholder="Search name, email, phone, brand…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="toolbar-search"
          aria-label="Search"
        />
        <div className="toolbar-filters">
          {[
            { key: 'all',    label: 'all' },
            { key: 'leads',  label: 'leads' },
            { key: 'active', label: 'active' },
            { key: 'past',   label: 'past' },
            { key: 'lost',   label: 'lost' },
          ].map((f) => (
            <button
              key={f.key}
              className={`filter-pill ${stageFilter === f.key ? 'active' : ''}`}
              onClick={() => setStageFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setModalState({ kind: 'contact' })}
        >
          + Add contact
        </button>
      </div>

      {err && <div className="login-error" style={{marginBottom:16}}>{err}</div>}

      <div className="contacts-split">
        <div className="contacts-list-wrap">
          {loading ? (
            <div className="loading" style={{ minHeight: 120 }}>Loading…</div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              {contacts.length === 0 ? (
                <>
                  <p>No contacts yet.</p>
                  <button className="cta-link" onClick={() => setModalState({ kind: 'contact' })}>
                    Add your first contact →
                  </button>
                </>
              ) : (
                <p>No matches. Try another search or filter.</p>
              )}
            </div>
          ) : (
            <ul className="contacts-list">
              {visible.map((c) => {
                const clientCount = c.clients?.length || 0
                const brandCount = (c.clients || []).reduce((n, cl) => n + (cl.brands?.length || 0), 0)
                const isStale = staleIds.has(c.id)
                return (
                  <li
                    key={c.id}
                    data-contact-id={c.id}
                    className={`contact-row ${selectedContactId === c.id ? 'selected' : ''}`}
                    onClick={() => setSelectedContactId(c.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedContactId(c.id) } }}
                  >
                    <div className="contact-row-main">
                      <div className="contact-row-name">{c.name}</div>
                      <div className="contact-row-sub">
                        {c.email || c.phone || '—'}
                        {c.preferred_contact && <span className="contact-row-pref">· prefers {c.preferred_contact}</span>}
                      </div>
                    </div>
                    <div className="contact-row-meta">
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <StagePill contact={c} />
                        {isStale && <StaleBadge />}
                      </div>
                      <div className="contact-row-counts">
                        {clientCount} client{clientCount === 1 ? '' : 's'} · {brandCount} brand{brandCount === 1 ? '' : 's'}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="contacts-detail-wrap">
          {!selected ? (
            <div className="empty-state detail-empty">
              <p>Select a contact on the left to see clients &amp; brands.</p>
            </div>
          ) : (
            <ContactDetail
              contact={selected}
              financials={financials}
              isStale={staleIds.has(selected.id)}
              onEditContact={() => setModalState({ kind: 'contact', data: selected })}
              onAddClient={() => setModalState({ kind: 'client', data: { contactId: selected.id } })}
              onEditClient={(client) => setModalState({ kind: 'client', data: { contactId: selected.id, client } })}
              onAddBrand={(clientId) => setModalState({ kind: 'brand', data: { clientId } })}
              onEditBrand={(brand, clientId) => setModalState({ kind: 'brand', data: { clientId, brand } })}
              onSendBankLink={sendBankLink}
              bankLink={bankLink}
              bankBusy={bankBusy}
              onDismissBankLink={() => setBankLink(null)}
            />
          )}
        </div>
      </div>

      {/* Modals */}
      {modalState?.kind === 'contact' && (
        <EditContactModal
          contact={modalState.data}
          onClose={() => setModalState(null)}
          onSaved={handleModalSaved}
        />
      )}
      {modalState?.kind === 'client' && (
        <EditClientModal
          contactId={modalState.data.contactId}
          client={modalState.data.client}
          onClose={() => setModalState(null)}
          onSaved={handleModalSaved}
        />
      )}
      {modalState?.kind === 'brand' && (
        <EditBrandModal
          clientId={modalState.data.clientId}
          brand={modalState.data.brand}
          onClose={() => setModalState(null)}
          onSaved={handleModalSaved}
        />
      )}
    </div>
  )
}

/* ============================================================
   Detail panel
   ============================================================ */

function ContactDetail({
  contact,
  financials,
  isStale,
  onEditContact,
  onAddClient,
  onEditClient,
  onAddBrand,
  onEditBrand,
  onSendBankLink,
  bankLink,
  bankBusy,
  onDismissBankLink,
}) {
  // Aggregate money snapshot across clients
  let totalPaid = 0, totalOutstanding = 0, monthlyRecurring = 0
  for (const cl of contact.clients || []) {
    const f = financials.byClient.get(cl.id)
    if (f) {
      totalPaid += f.paid
      totalOutstanding += f.outstanding
    }
    for (const b of cl.brands || []) {
      const bf = financials.byBrand.get(b.id)
      if (bf) monthlyRecurring += bf.retainerMonthly
    }
  }

  return (
    <div className="detail-pane">
      <div className="detail-header">
        <div>
          <div className="detail-kind">Contact</div>
          <h2>{contact.name}</h2>
          <div className="detail-sub">
            {contact.email && <span>{contact.email}</span>}
            {contact.phone && <span>{contact.phone}</span>}
            {contact.preferred_contact && <span>prefers {contact.preferred_contact}</span>}
          </div>
        </div>
        <div className="detail-header-actions">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <StagePill contact={contact} />
            {isStale && <StaleBadge />}
          </div>
          <button className="btn btn-link" onClick={onEditContact}>Edit</button>
        </div>
      </div>

      {(() => {
        const ld = leadDetailsOf(contact)
        if (!ld) return null
        const sourceLabel = ld.referred_by
          ? `referral — ${ld.referred_by}`
          : (ld.source ? ld.source.replace(/_/g, ' ') : null)
        return sourceLabel ? (
          <div className="detail-sub" style={{ marginTop: -4, fontSize: 11, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--text-lo)' }}>
            Source · {sourceLabel}
          </div>
        ) : null
      })()}

      {contact.notes && (
        <div className="detail-note">{contact.notes}</div>
      )}

      {(() => {
        const ld = leadDetailsOf(contact)
        if (!ld) return null
        const pillColor = LEAD_STAGE_COLOR[ld.stage] || 'var(--border-strong)'
        return (
          <>
            {ld.scope_summary && (
              <div className="detail-note" style={{ borderLeftColor: pillColor }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Scope</div>
                {ld.scope_summary}
              </div>
            )}
            {ld.next_step && (
              <div className="detail-note" style={{ borderLeftColor: pillColor }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Next step</div>
                {ld.next_step}
              </div>
            )}
            {ld.notes && (
              <div className="detail-note" style={{ borderLeftColor: pillColor }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Lead notes</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{ld.notes}</div>
              </div>
            )}
            {ld.stage === 'lost' && ld.lost_reason && (
              <div className="detail-note" style={{ borderLeftColor: COLORS.steel }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Lost reason</div>
                {ld.lost_reason}
              </div>
            )}
          </>
        )
      })()}

      <div className="detail-money">
        <div><span className="eyebrow">Paid to date</span><strong>{fmtMoneyShort(totalPaid)}</strong></div>
        <div><span className="eyebrow">Currently owed</span><strong>{fmtMoneyShort(totalOutstanding)}</strong></div>
        <div><span className="eyebrow">Monthly recurring</span><strong>{fmtMoneyShort(monthlyRecurring)}/mo</strong></div>
      </div>

      <div className="detail-section-header">
        <span className="eyebrow">Clients</span>
        <button className="btn btn-link" onClick={onAddClient}>+ Add client</button>
      </div>

      {(contact.clients || []).length === 0 ? (
        <div className="empty-state" style={{ padding: 16 }}>
          <p>No clients for this contact yet.</p>
          <button className="cta-link" onClick={onAddClient}>Add client →</button>
        </div>
      ) : (
        <div className="client-list">
          {contact.clients.map((client) => (
            <ClientCard
              key={client.id}
              client={client}
              financials={financials}
              onEdit={() => onEditClient(client)}
              onAddBrand={() => onAddBrand(client.id)}
              onEditBrand={(brand) => onEditBrand(brand, client.id)}
              onSendBankLink={() => onSendBankLink(client)}
              bankBusy={bankBusy}
              bankLink={bankLink?.client_id === client.id ? bankLink : null}
              onDismissBankLink={onDismissBankLink}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ClientCard({
  client,
  financials,
  onEdit,
  onAddBrand,
  onEditBrand,
  onSendBankLink,
  bankBusy,
  bankLink,
  onDismissBankLink,
}) {
  const f = financials.byClient.get(client.id) || { paid: 0, outstanding: 0 }
  const canSendBankLink = client.stripe_customer_id && !client.bank_info_on_file
  const billingState = clientBillingState(client, financials.allInvoices || [])

  return (
    <div className="client-card">
      <div className="client-card-header">
        <div>
          <div className="client-card-name">{client.name}</div>
          {client.legal_name && client.legal_name !== client.name && (
            <div className="client-card-legal">{client.legal_name}</div>
          )}
          {billingState && (
            <div style={{ marginTop: 6 }}>
              <BillingStatePill state={billingState} />
            </div>
          )}
        </div>
        <div className="client-card-actions">
          <StatusPill status={client.status} />
          <button className="btn btn-link" onClick={onEdit}>Edit</button>
        </div>
      </div>

      <div className="client-card-meta">
        {client.billing_email && <span>{client.billing_email}</span>}
        <span>{client.payment_method?.replace('_', ' ')}</span>
        {client.bank_info_on_file && <span className="bank-ok">✓ bank on file</span>}
        {f.paid > 0 && <span>{fmtMoneyShort(f.paid)} paid</span>}
        {f.outstanding > 0 && <span style={{ color: COLORS.amber }}>{fmtMoneyShort(f.outstanding)} owed</span>}
      </div>

      {canSendBankLink && (
        <div className="bank-link-row">
          <button
            className="btn btn-secondary"
            onClick={onSendBankLink}
            disabled={bankBusy}
          >
            {bankBusy ? 'Generating…' : 'Send Bank Connection Link'}
          </button>
          {bankLink && !bankLink.error && (
            <BankLinkResult link={bankLink} onDismiss={onDismissBankLink} />
          )}
          {bankLink && bankLink.error && (
            <div className="bank-link-error">
              <div>{bankLink.error}</div>
              {bankLink.fallbackHint && <pre>{bankLink.fallbackHint}</pre>}
              <button className="btn btn-link" onClick={onDismissBankLink}>Dismiss</button>
            </div>
          )}
        </div>
      )}

      <div className="brand-section">
        <div className="brand-section-header">
          <span className="eyebrow">Brands</span>
          <button className="btn btn-link-small" onClick={onAddBrand}>+ Add brand</button>
        </div>
        {(client.brands || []).length === 0 ? (
          <div className="brand-empty">No brands yet.</div>
        ) : (
          <div className="brand-grid">
            {client.brands.map((b) => (
              <BrandCard
                key={b.id}
                brand={b}
                financials={financials}
                onEdit={() => onEditBrand(b)}
              />
            ))}
          </div>
        )}
      </div>

      {client.notes && <div className="client-card-notes">{client.notes}</div>}
    </div>
  )
}

function BrandCard({ brand, financials, onEdit }) {
  const bf = financials.byBrand.get(brand.id) || { buildoutTotal: 0, retainerMonthly: 0 }
  const recentWork = (financials.workByBrand?.get(brand.id) || []).slice(0, 20)
  const retainerProjectId = financials.retainerProjectByBrand?.get(brand.id)
  const [copied, setCopied] = useState(false)

  const copyBriefing = async () => {
    const { data, error } = await supabase
      .from('projects')
      .select('briefing_md')
      .eq('brand_id', brand.id)
      .eq('status', 'active')
      .order('type')
      .limit(1)
      .maybeSingle()
    if (error || !data?.briefing_md) {
      alert('No briefing available — add or activate a project for this brand first.')
      return
    }
    // Also include is_briefing_file project files
    const { data: projects } = await supabase
      .from('projects')
      .select('id')
      .eq('brand_id', brand.id)
      .eq('status', 'active')
    const projectIds = (projects || []).map(p => p.id)
    const { data: files } = projectIds.length > 0
      ? await supabase.from('project_files').select('name, storage_path').eq('is_briefing_file', true).in('project_id', projectIds)
      : { data: [] }
    let out = data.briefing_md
    if (files && files.length > 0) {
      out += '\n\n---\n\n(Briefing files not inlined yet — download separately.)\n'
    }
    try {
      await navigator.clipboard.writeText(out)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      alert('Clipboard unavailable. Briefing logged to console.')
      console.log(out)
    }
  }

  return (
    <div className="brand-card" style={{ borderLeftColor: brand.color || 'var(--border-strong)' }}>
      <div className="brand-card-header">
        <div>
          <div className="brand-card-name">{brand.name}</div>
          <div className="brand-card-meta">
            {brand.industry && <span>{brand.industry}</span>}
            {(brand.location_city || brand.location_state) && (
              <span>{[brand.location_city, brand.location_state].filter(Boolean).join(', ')}</span>
            )}
          </div>
        </div>
        <div className="brand-card-actions">
          <span style={badgeStyle(BRAND_STATUS_COLOR[brand.status] || COLORS.steel)}>{brand.status}</span>
          <button className="btn btn-link-small" onClick={onEdit}>Edit</button>
        </div>
      </div>

      <div className="brand-card-links">
        {brand.website_url && <a href={brand.website_url} target="_blank" rel="noreferrer">Website</a>}
        {brand.instagram_url && <a href={brand.instagram_url} target="_blank" rel="noreferrer">Instagram</a>}
        {brand.facebook_url && <a href={brand.facebook_url} target="_blank" rel="noreferrer">Facebook</a>}
        {brand.gbp_url && <a href={brand.gbp_url} target="_blank" rel="noreferrer">GBP</a>}
        {brand.yelp_url && <a href={brand.yelp_url} target="_blank" rel="noreferrer">Yelp</a>}
      </div>

      {(bf.buildoutTotal > 0 || bf.retainerMonthly > 0) && (
        <div className="brand-card-money">
          {bf.buildoutTotal > 0 && <span>{fmtMoneyShort(bf.buildoutTotal)} buildout</span>}
          {bf.retainerMonthly > 0 && <span>{fmtMoneyShort(bf.retainerMonthly)}/mo retainer</span>}
        </div>
      )}

      <div className="brand-card-footer">
        <button className="btn btn-link-small" onClick={copyBriefing}>
          {copied ? '✓ Briefing copied' : 'Copy briefing'}
        </button>
      </div>

      {recentWork.length > 0 && (
        <div className="brand-activity">
          <div className="brand-activity-header">
            <span className="eyebrow">Recent activity (30d)</span>
            {retainerProjectId && (
              <Link to={`/projects?selected=${retainerProjectId}&tab=activity`} className="btn btn-link-small">
                View all →
              </Link>
            )}
          </div>
          <ul className="brand-activity-list">
            {recentWork.map((w) => (
              <li key={w.id} className="brand-activity-row">
                <span className="brand-activity-date">
                  {new Date(w.performed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                <span className="brand-activity-title">{w.title}</span>
                <span className="brand-activity-svc">{w.retainer_services?.name || 'General'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function BankLinkResult({ link, onDismiss }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      alert(link.url)
    }
  }
  const smsBody = `Click this link to securely connect your bank account for automatic payments with Laviolette LLC: ${link.url}`
  return (
    <div className="bank-link-result">
      <div className="bank-link-url">{link.url}</div>
      <div className="bank-link-actions">
        <button className="btn btn-link" onClick={copy}>{copied ? '✓ Copied' : 'Copy link'}</button>
        <a className="btn btn-link" href={`sms:?body=${encodeURIComponent(smsBody)}`}>Text</a>
        <a className="btn btn-link" href={`mailto:?subject=${encodeURIComponent('Connect your bank account — Laviolette LLC')}&body=${encodeURIComponent(smsBody)}`}>Email</a>
        <button className="btn btn-link" onClick={onDismiss}>Dismiss</button>
      </div>
      <div className="bank-link-note">Expires in 24 hours.</div>
    </div>
  )
}
