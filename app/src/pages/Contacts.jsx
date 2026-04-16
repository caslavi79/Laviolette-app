import { useEffect, useMemo, useState, useCallback } from 'react'
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
const BRAND_STATUS_COLOR = {
  active:     COLORS.green,
  paused:     COLORS.amber,
  offboarded: COLORS.slate,
}

function StatusPill({ status, map = STATUS_COLOR }) {
  const color = map[status] || COLORS.steel
  return <span style={badgeStyle(color)}>{status}</span>
}

/* --------- page --------- */

export default function Contacts() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedContactId, setSelectedContactId] = useState(null)
  const [financials, setFinancials] = useState({ byClient: new Map(), byBrand: new Map() })
  const [modalState, setModalState] = useState(null) // { kind, data }
  const [bankLink, setBankLink] = useState(null)     // { url, client_name } — populated by Send Bank Link
  const [bankBusy, setBankBusy] = useState(false)

  const loadContacts = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('contacts')
      .select(`
        *,
        clients (
          *,
          brands (*)
        )
      `)
      .order('name')
    if (error) {
      setContacts([])
      setLoading(false)
      return
    }
    setContacts(data || [])
    setLoading(false)
  }, [])

  const loadFinancials = useCallback(async () => {
    // Aggregate invoice totals per client + project totals per brand.
    const [invRes, projRes] = await Promise.all([
      supabase.from('invoices').select('client_id, total, paid_amount, status'),
      supabase.from('projects').select('brand_id, type, total_fee, status'),
    ])
    const byClient = new Map()
    for (const i of invRes.data || []) {
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
    for (const p of projRes.data || []) {
      const entry = byBrand.get(p.brand_id) || { buildoutTotal: 0, retainerMonthly: 0 }
      if (p.type === 'retainer' && p.status === 'active') entry.retainerMonthly += parseFloat(p.total_fee) || 0
      if (p.type === 'buildout') entry.buildoutTotal += parseFloat(p.total_fee) || 0
      byBrand.set(p.brand_id, entry)
    }
    // Roll client recurring from its brands (for now, we store per-project; sum manually per brand into client)
    // We leave client.recurring = sum of its brands' retainers for display
    setFinancials({ byClient, byBrand })
  }, [])

  useEffect(() => { loadContacts(); loadFinancials() }, [loadContacts, loadFinancials])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return contacts.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (!q) return true
      const haystack = [
        c.name, c.email, c.phone,
        ...(c.clients || []).flatMap((cl) => [cl.name, cl.legal_name, cl.billing_email]),
        ...(c.clients || []).flatMap((cl) => (cl.brands || []).flatMap((b) => [b.name, b.instagram_handle])),
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [contacts, search, statusFilter])

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
        />
        <div className="toolbar-filters">
          {['all', 'lead', 'active', 'past'].map((s) => (
            <button
              key={s}
              className={`filter-pill ${statusFilter === s ? 'active' : ''}`}
              onClick={() => setStatusFilter(s)}
            >
              {s}
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
                return (
                  <li
                    key={c.id}
                    className={`contact-row ${selectedContactId === c.id ? 'selected' : ''}`}
                    onClick={() => setSelectedContactId(c.id)}
                  >
                    <div className="contact-row-main">
                      <div className="contact-row-name">{c.name}</div>
                      <div className="contact-row-sub">
                        {c.email || c.phone || '—'}
                        {c.preferred_contact && <span className="contact-row-pref">· prefers {c.preferred_contact}</span>}
                      </div>
                    </div>
                    <div className="contact-row-meta">
                      <StatusPill status={c.status} />
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
          <StatusPill status={contact.status} />
          <button className="btn btn-link" onClick={onEditContact}>Edit</button>
        </div>
      </div>

      {contact.notes && (
        <div className="detail-note">{contact.notes}</div>
      )}

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

  return (
    <div className="client-card">
      <div className="client-card-header">
        <div>
          <div className="client-card-name">{client.name}</div>
          {client.legal_name && client.legal_name !== client.name && (
            <div className="client-card-legal">{client.legal_name}</div>
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
    const { data: files } = await supabase
      .from('project_files')
      .select('name, storage_path')
      .eq('is_briefing_file', true)
      .in('project_id', [])
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
