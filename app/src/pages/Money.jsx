import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fmtMoneyShort, fmtDate, daysUntil, badgeStyle, COLORS, colorForInvoiceStatus } from '../lib/format'
import EditInvoiceModal from '../components/forms/EditInvoiceModal'
import MarkPaidModal from '../components/forms/MarkPaidModal'
import EditExpenseModal from '../components/forms/EditExpenseModal'

const TABS = ['invoices', 'revenue', 'expenses']

export default function Money() {
  const [params, setParams] = useSearchParams()
  const activeTab = TABS.includes(params.get('tab')) ? params.get('tab') : 'invoices'
  const setTab = (t) => setParams((p) => { p.set('tab', t); return p })

  return (
    <div className="money-page">
      <div className="page-header">
        <span className="eyebrow">Money</span>
        <h1>Invoices · Revenue · Expenses</h1>
        <p>Who owes what, what's coming in, what's going out.</p>
      </div>

      <div className="tab-bar">
        {TABS.map((t) => (
          <button key={t} className={`tab ${activeTab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {activeTab === 'invoices' && <InvoicesTab />}
      {activeTab === 'revenue' && <RevenueTab />}
      {activeTab === 'expenses' && <ExpensesTab />}
    </div>
  )
}

/* ================ INVOICES ================ */

function InvoicesTab() {
  const [invoices, setInvoices] = useState([])
  const [clients, setClients] = useState([])
  const [brands, setBrands] = useState([])
  const [projects, setProjects] = useState([])
  const [expanded, setExpanded] = useState(null)
  const [modal, setModal] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    const [invRes, clRes, brRes, prRes] = await Promise.all([
      supabase.from('invoices').select('*, clients(id, name, legal_name)').order('due_date', { ascending: false }),
      supabase.from('clients').select('id, name, legal_name').order('name'),
      supabase.from('brands').select('id, name, client_id').order('name'),
      supabase.from('projects').select('id, name, type, brand_id, total_fee, brands(id, name, client_id)').order('name'),
    ])
    if (invRes.error) { setErr(invRes.error.message); setLoading(false); return }
    if (clRes.error) { setErr(clRes.error.message); setLoading(false); return }
    if (brRes.error) { setErr(brRes.error.message); setLoading(false); return }
    if (prRes.error) { setErr(prRes.error.message); setLoading(false); return }
    setInvoices(invRes.data || [])
    setClients(clRes.data || [])
    setBrands(brRes.data || [])
    setProjects(prRes.data || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Group invoices
  const groups = useMemo(() => {
    const out = { overdue: [], due_month: [], coming_up: [], paid: [] }
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    for (const inv of invoices) {
      if (inv.status === 'paid') { out.paid.push(inv); continue }
      if (inv.status === 'void' || inv.status === 'draft') continue
      const du = daysUntil(inv.due_date)
      if (inv.status === 'overdue' || (du !== null && du < 0)) out.overdue.push(inv)
      else if (inv.status === 'partially_paid') out.overdue.push(inv)
      else {
        const d = new Date(inv.due_date + 'T00:00:00')
        if (d <= endOfMonth) out.due_month.push(inv)
        else out.coming_up.push(inv)
      }
    }
    return out
  }, [invoices])

  const outstanding = [...groups.overdue, ...groups.due_month, ...groups.coming_up].reduce((s, i) => {
    const t = parseFloat(i.total) || 0
    const p = i.status === 'partially_paid' ? (parseFloat(i.paid_amount) || 0) : 0
    return s + (t - p)
  }, 0)

  const receivedThisMonth = useMemo(() => {
    const today = new Date()
    const m0 = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10)
    const m1 = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10)
    return invoices
      .filter((i) => i.paid_date && i.paid_date >= m0 && i.paid_date <= m1)
      .reduce((s, i) => s + (i.status === 'partially_paid' ? (parseFloat(i.paid_amount) || 0) : (parseFloat(i.total) || 0)), 0)
  }, [invoices])

  return (
    <div className="invoices-tab">
      {err && <div className="login-error" style={{marginBottom:16}}>{err}</div>}
      <div className="money-summary">
        <div className="summary-card"><span className="eyebrow">Outstanding</span><strong style={{ color: COLORS.amber }}>{fmtMoneyShort(outstanding)}</strong></div>
        <div className="summary-card"><span className="eyebrow">Received this month</span><strong style={{ color: COLORS.green }}>{fmtMoneyShort(receivedThisMonth)}</strong></div>
        <div className="summary-card"><span className="eyebrow">Total invoices</span><strong>{invoices.length}</strong></div>
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'invoice' })} disabled={clients.length === 0}>+ Create invoice</button>
      </div>

      {loading ? <div className="loading">Loading…</div> : (
        <>
          <InvoiceGroup label="Overdue / partially paid" color={COLORS.red} rows={groups.overdue} expanded={expanded} setExpanded={setExpanded} setModal={setModal} />
          <InvoiceGroup label="Due this month" color={COLORS.amber} rows={groups.due_month} expanded={expanded} setExpanded={setExpanded} setModal={setModal} />
          <InvoiceGroup label="Coming up" color={COLORS.steel} rows={groups.coming_up} expanded={expanded} setExpanded={setExpanded} setModal={setModal} />
          <InvoiceGroup label="Paid" color={COLORS.green} rows={groups.paid} expanded={expanded} setExpanded={setExpanded} setModal={setModal} collapsedByDefault />
        </>
      )}

      {modal?.kind === 'invoice' && (
        <EditInvoiceModal
          invoice={modal.data}
          clients={clients}
          brands={brands}
          projects={projects}
          onClose={() => setModal(null)}
          onSaved={() => load()}
        />
      )}
      {modal?.kind === 'paid' && (
        <MarkPaidModal
          invoice={modal.data}
          onClose={() => setModal(null)}
          onSaved={() => load()}
        />
      )}
    </div>
  )
}

function InvoiceGroup({ label, color, rows, expanded, setExpanded, setModal, collapsedByDefault }) {
  const [open, setOpen] = useState(!collapsedByDefault)
  if (rows.length === 0) return null
  const total = rows.reduce((s, i) => s + (parseFloat(i.total) || 0), 0)
  return (
    <div className="invoice-group">
      <button className="invoice-group-header" onClick={() => setOpen(!open)}>
        <span className="alert-dot" style={{ background: color }} />
        <span className="invoice-group-label" style={{ color }}>{label}</span>
        <span className="invoice-group-count">{rows.length}</span>
        <span style={{ flex: 1 }} />
        <span className="invoice-group-total">{fmtMoneyShort(total)}</span>
        <span className="invoice-group-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="invoice-list">
          {rows.map((inv) => (
            <InvoiceRow
              key={inv.id}
              inv={inv}
              isExpanded={expanded === inv.id}
              onExpand={() => setExpanded(expanded === inv.id ? null : inv.id)}
              setModal={setModal}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function InvoiceRow({ inv, isExpanded, onExpand, setModal }) {
  const du = daysUntil(inv.due_date)
  const isOverdue = (inv.status === 'overdue') || (inv.status === 'pending' && du !== null && du < 0)
  const color = colorForInvoiceStatus(isOverdue ? 'overdue' : inv.status)
  return (
    <li className={`invoice-row ${isExpanded ? 'expanded' : ''}`}>
      <div className="invoice-row-main" onClick={onExpand}>
        <span className="invoice-number">{inv.invoice_number}</span>
        <span className="invoice-client">{inv.clients?.legal_name || inv.clients?.name || '—'}</span>
        <span className="invoice-desc">{inv.description || '—'}</span>
        <span className="invoice-total">{fmtMoneyShort(inv.total)}</span>
        <span className="invoice-due">
          {fmtDate(inv.due_date)}
          {du !== null && du < 0 && inv.status !== 'paid' && <span className="invoice-du"> · {Math.abs(du)}d late</span>}
          {du !== null && du >= 0 && du <= 7 && inv.status !== 'paid' && <span className="invoice-du"> · in {du}d</span>}
        </span>
        <span style={badgeStyle(color)}>{isOverdue ? 'overdue' : inv.status}</span>
      </div>
      {isExpanded && (
        <div className="invoice-row-detail">
          {Array.isArray(inv.line_items) && inv.line_items.length > 0 && (
            <ul className="invoice-lines">
              {inv.line_items.map((l, i) => (
                <li key={i}><span>{l.description}</span><span>{fmtMoneyShort(l.amount)}</span></li>
              ))}
            </ul>
          )}
          {inv.notes && <div className="invoice-notes">{inv.notes}</div>}
          <div className="invoice-actions">
            {inv.status !== 'paid' && inv.status !== 'void' && (
              <button className="btn btn-primary" onClick={() => setModal({ kind: 'paid', data: inv })}>Mark paid</button>
            )}
            <button className="btn btn-secondary" onClick={() => setModal({ kind: 'invoice', data: inv })}>Edit</button>
            {inv.paid_date && <span className="invoice-paid-note">Paid {fmtDate(inv.paid_date)} · {inv.payment_method?.replace('_', ' ')}</span>}
          </div>
        </div>
      )}
    </li>
  )
}

/* ================ REVENUE ================ */

function RevenueTab() {
  const [invoices, setInvoices] = useState([])
  const [expenses, setExpenses] = useState([])
  const [projects, setProjects] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    setErr('')
    Promise.all([
      supabase.from('invoices').select('id, client_id, total, paid_amount, paid_date, status, project_id, projects(id, type)'),
      supabase.from('expenses').select('amount, date'),
      supabase.from('projects').select('id, brand_id, type, status, total_fee'),
      supabase.from('clients').select('id, name, legal_name'),
    ]).then(([inv, ex, pr, cl]) => {
      if (inv.error) { setErr(inv.error.message); setLoading(false); return }
      if (ex.error) { setErr(ex.error.message); setLoading(false); return }
      if (pr.error) { setErr(pr.error.message); setLoading(false); return }
      if (cl.error) { setErr(cl.error.message); setLoading(false); return }
      setInvoices(inv.data || [])
      setExpenses(ex.data || [])
      setProjects(pr.data || [])
      setClients(cl.data || [])
      setLoading(false)
    }).catch((e) => {
      setErr(e.message || String(e))
      setLoading(false)
    })
  }, [])

  const year = new Date().getFullYear()
  const thisMonth = new Date().getMonth()

  const paidInMonth = (m) => invoices.filter((i) => {
    if (!i.paid_date) return false
    const d = new Date(i.paid_date + 'T00:00:00')
    return d.getFullYear() === year && d.getMonth() === m
  })

  const totalIn = (rows) => rows.reduce((s, i) => s + (i.status === 'partially_paid' ? (parseFloat(i.paid_amount) || 0) : (parseFloat(i.total) || 0)), 0)
  const expensesIn = (m) => expenses.filter((e) => {
    const d = new Date(e.date + 'T00:00:00')
    return d.getFullYear() === year && d.getMonth() === m
  }).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)

  const monthLabel = (m) => new Date(year, m, 1).toLocaleDateString('en-US', { month: 'short' })

  const received = totalIn(paidInMonth(thisMonth))
  const outstandingInvoices = invoices.filter((i) => i.status === 'pending' || i.status === 'overdue' || i.status === 'sent' || i.status === 'partially_paid')
  const outstanding = outstandingInvoices.reduce((s, i) => {
    const t = parseFloat(i.total) || 0
    const p = i.status === 'partially_paid' ? (parseFloat(i.paid_amount) || 0) : 0
    return s + (t - p)
  }, 0)
  const expensesThisMonth = expensesIn(thisMonth)
  const profitThisMonth = received - expensesThisMonth

  const monthlyRetainerMRR = projects.filter((p) => p.type === 'retainer' && p.status === 'active').reduce((s, p) => s + (parseFloat(p.total_fee) || 0), 0)

  const byClient = useMemo(() => {
    const m = new Map()
    for (const i of paidInMonth(thisMonth)) {
      const amt = i.status === 'partially_paid' ? (parseFloat(i.paid_amount) || 0) : (parseFloat(i.total) || 0)
      m.set(i.client_id, (m.get(i.client_id) || 0) + amt)
    }
    return [...m.entries()]
      .map(([id, total]) => ({ id, total, name: clients.find((c) => c.id === id)?.legal_name || clients.find((c) => c.id === id)?.name || 'Unknown' }))
      .sort((a, b) => b.total - a.total)
  }, [invoices, clients])  // eslint-disable-line react-hooks/exhaustive-deps

  const ytdReceived = invoices.filter((i) => i.paid_date && new Date(i.paid_date).getFullYear() === year).reduce((s, i) => s + (i.status === 'partially_paid' ? (parseFloat(i.paid_amount) || 0) : (parseFloat(i.total) || 0)), 0)
  const ytdExpenses = expenses.filter((e) => new Date(e.date).getFullYear() === year).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)

  if (loading) return <div className="loading">Loading…</div>

  return (
    <div className="revenue-tab">
      {err && <div className="login-error" style={{marginBottom:16}}>{err}</div>}
      <div className="revenue-grid">
        <div className="revenue-card">
          <div className="revenue-card-label">{new Date(year, thisMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</div>
          <div className="revenue-line"><span>Received</span><strong style={{ color: COLORS.green }}>{fmtMoneyShort(received)}</strong></div>
          <div className="revenue-line"><span>Outstanding</span><strong style={{ color: COLORS.amber }}>{fmtMoneyShort(outstanding)}</strong></div>
          <div className="revenue-line"><span>Expenses</span><strong style={{ color: COLORS.red }}>{fmtMoneyShort(expensesThisMonth)}</strong></div>
          <div className="revenue-line revenue-line--total"><span>Profit</span><strong>{fmtMoneyShort(profitThisMonth)}</strong></div>
        </div>
        <div className="revenue-card">
          <div className="revenue-card-label">Year to date ({year})</div>
          <div className="revenue-line"><span>Total received</span><strong style={{ color: COLORS.green }}>{fmtMoneyShort(ytdReceived)}</strong></div>
          <div className="revenue-line"><span>Total expenses</span><strong style={{ color: COLORS.red }}>{fmtMoneyShort(ytdExpenses)}</strong></div>
          <div className="revenue-line revenue-line--total"><span>YTD profit</span><strong>{fmtMoneyShort(ytdReceived - ytdExpenses)}</strong></div>
          <div className="revenue-line"><span>Active MRR</span><strong>{fmtMoneyShort(monthlyRetainerMRR)}/mo</strong></div>
        </div>
      </div>

      <div className="revenue-breakdown">
        <div className="panel-header"><span className="eyebrow">This month by client</span></div>
        {byClient.length === 0 ? (
          <div className="empty-state" style={{ padding: 16 }}><p>No revenue this month yet.</p></div>
        ) : (
          <ul className="breakdown-list">
            {byClient.map((c) => (
              <li key={c.id}><span>{c.name}</span><span>{fmtMoneyShort(c.total)}</span></li>
            ))}
          </ul>
        )}
      </div>

      <div className="revenue-monthly">
        <div className="panel-header"><span className="eyebrow">Monthly history ({year})</span></div>
        <table className="monthly-table">
          <thead>
            <tr><th>Month</th><th>Received</th><th>Expenses</th><th>Profit</th></tr>
          </thead>
          <tbody>
            {Array.from({ length: 12 }, (_, m) => m).map((m) => {
              const r = totalIn(paidInMonth(m))
              const e = expensesIn(m)
              return (
                <tr key={m} className={m === thisMonth ? 'current' : ''}>
                  <td>{monthLabel(m)}</td>
                  <td>{fmtMoneyShort(r)}</td>
                  <td>{fmtMoneyShort(e)}</td>
                  <td style={{ color: r - e > 0 ? COLORS.green : r - e < 0 ? COLORS.red : 'inherit' }}>{fmtMoneyShort(r - e)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ================ EXPENSES ================ */

function ExpensesTab() {
  const [expenses, setExpenses] = useState([])
  const [clients, setClients] = useState([])
  const [brands, setBrands] = useState([])
  const [filterCat, setFilterCat] = useState('all')
  const [year, setYear] = useState(new Date().getFullYear())
  const [modal, setModal] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    const [exRes, clRes, brRes] = await Promise.all([
      supabase.from('expenses').select('*').order('date', { ascending: false }),
      supabase.from('clients').select('id, name, legal_name').order('name'),
      supabase.from('brands').select('id, name, client_id').order('name'),
    ])
    if (exRes.error) { setErr(exRes.error.message); setLoading(false); return }
    if (clRes.error) { setErr(clRes.error.message); setLoading(false); return }
    if (brRes.error) { setErr(brRes.error.message); setLoading(false); return }
    setExpenses(exRes.data || [])
    setClients(clRes.data || [])
    setBrands(brRes.data || [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => expenses.filter((e) => {
    if (year !== 'all' && new Date(e.date).getFullYear() !== year) return false
    if (filterCat !== 'all' && e.category !== filterCat) return false
    return true
  }), [expenses, year, filterCat])

  const total = filtered.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
  const deductible = filtered.reduce((s, e) => s + ((parseFloat(e.amount) || 0) * ((e.deduction_percentage || 100) / 100)), 0)

  const byCategory = useMemo(() => {
    const m = new Map()
    for (const e of filtered) {
      const entry = m.get(e.category) || { total: 0, count: 0, deductible: 0 }
      entry.total += parseFloat(e.amount) || 0
      entry.count += 1
      entry.deductible += (parseFloat(e.amount) || 0) * ((e.deduction_percentage || 100) / 100)
      m.set(e.category, entry)
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total)
  }, [filtered])

  const years = useMemo(() => {
    const s = new Set([new Date().getFullYear()])
    for (const e of expenses) s.add(new Date(e.date).getFullYear())
    return [...s].sort((a, b) => b - a)
  }, [expenses])

  const categories = ['all', 'software', 'domains', 'hosting', 'meals', 'home_office', 'equipment', 'phone', 'supplies', 'travel', 'professional', 'marketing', 'other']

  return (
    <div className="expenses-tab">
      {err && <div className="login-error" style={{marginBottom:16}}>{err}</div>}
      <div className="expenses-summary">
        <div className="summary-card"><span className="eyebrow">Total {year}</span><strong>{fmtMoneyShort(total)}</strong></div>
        <div className="summary-card"><span className="eyebrow">Deductible</span><strong style={{ color: COLORS.green }}>{fmtMoneyShort(deductible)}</strong></div>
        <div className="summary-card"><span className="eyebrow">Count</span><strong>{filtered.length}</strong></div>
        <button className="btn btn-primary" onClick={() => setModal({ kind: 'expense' })}>+ Quick add</button>
      </div>

      <div className="list-toolbar">
        <div className="toolbar-filters">
          {years.map((y) => (
            <button key={y} className={`filter-pill ${year === y ? 'active' : ''}`} onClick={() => setYear(y)}>{y}</button>
          ))}
          <button className={`filter-pill ${year === 'all' ? 'active' : ''}`} onClick={() => setYear('all')}>ALL</button>
        </div>
        <div className="toolbar-filters">
          {categories.map((c) => (
            <button key={c} className={`filter-pill ${filterCat === c ? 'active' : ''}`} onClick={() => setFilterCat(c)}>{c.replace('_', ' ')}</button>
          ))}
        </div>
      </div>

      {byCategory.length > 0 && (
        <div className="category-breakdown">
          <span className="eyebrow">By category</span>
          <ul>
            {byCategory.map(([cat, stats]) => (
              <li key={cat}>
                <span>{cat.replace('_', ' ')}</span>
                <span>{stats.count}×</span>
                <span>{fmtMoneyShort(stats.total)}</span>
                <span style={{ color: COLORS.green }}>{fmtMoneyShort(stats.deductible)} ded.</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading ? <div className="loading">Loading…</div> : (
        filtered.length === 0 ? (
          <div className="empty-state"><p>No expenses yet.</p><button className="cta-link" onClick={() => setModal({ kind: 'expense' })}>+ Quick add →</button></div>
        ) : (
          <table className="expenses-table">
            <thead>
              <tr><th>Date</th><th>Description</th><th>Vendor</th><th>Category</th><th>Amount</th><th>Ded.%</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} onClick={() => setModal({ kind: 'expense', data: e })} style={{ cursor: 'pointer' }}>
                  <td>{fmtDate(e.date, { month: 'short', day: 'numeric' })}</td>
                  <td>{e.description}</td>
                  <td>{e.vendor || '—'}</td>
                  <td>{e.category.replace('_', ' ')}</td>
                  <td>{fmtMoneyShort(e.amount)}</td>
                  <td>{e.deduction_percentage}%</td>
                  <td>{e.is_recurring && <span style={badgeStyle(COLORS.slate)}>recurring</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {modal?.kind === 'expense' && (
        <EditExpenseModal
          expense={modal.data}
          clients={clients}
          brands={brands}
          onClose={() => setModal(null)}
          onSaved={() => load()}
        />
      )}
    </div>
  )
}
