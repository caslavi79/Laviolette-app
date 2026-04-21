import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fmtMoneyShort, fmtDate, badgeStyle, COLORS, colorForProjectStatus } from '../lib/format'
import EditProjectModal from '../components/forms/EditProjectModal'
import EditDeliverableModal from '../components/forms/EditDeliverableModal'
import EditServiceModal from '../components/forms/EditServiceModal'
import LogWorkModal from '../components/forms/LogWorkModal'

const DELIVERABLE_CYCLE = { not_started: 'in_progress', in_progress: 'complete', complete: 'not_started' }

export default function Projects() {
  const [params, setParams] = useSearchParams()
  const [projects, setProjects] = useState([])
  const [brands, setBrands] = useState([])
  const [selectedId, setSelectedId] = useState(params.get('selected') || null)
  const [activeTab, setActiveTabState] = useState(params.get('tab') || 'overview')
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState('all')
  const [filterStatus, setFilterStatus] = useState('active')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null)
  const [logCtx, setLogCtx] = useState(null)  // { brandId, serviceId? } or null
  const [activityRefreshKey, setActivityRefreshKey] = useState(0)
  const [err, setErr] = useState('')

  const setActiveTab = useCallback((t) => {
    setActiveTabState(t)
    setParams((p) => {
      if (t && t !== 'overview') p.set('tab', t)
      else p.delete('tab')
      return p
    }, { replace: true })
  }, [setParams])

  // Keep URL in sync when the user picks a project via the list.
  const selectProject = useCallback((id) => {
    setSelectedId(id)
    setParams((p) => {
      if (id) p.set('selected', id)
      else p.delete('selected')
      return p
    }, { replace: true })
  }, [setParams])

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    const [projRes, brandRes] = await Promise.all([
      supabase
        .from('projects')
        .select(`
          *,
          brands (id, name, color, client_id, clients (id, name, legal_name)),
          deliverables (id, number, category, name, description, status, notes, completed_at, started_at),
          retainer_services (id, number, name, description, cadence, quantity_per_period, sla_hours, platforms, active),
          retainer_tasks (id, title, status, period_type, period_start, period_end, assigned_date, completed_at)
        `)
        .order('status')
        .order('updated_at', { ascending: false }),
      supabase
        .from('brands')
        .select('id, name, color, clients(id, name, legal_name)')
        .order('name'),
    ])
    if (projRes.error) { setErr(projRes.error.message); setLoading(false); return }
    if (brandRes.error) { setErr(brandRes.error.message); setLoading(false); return }
    setProjects(projRes.data || [])
    setBrands((brandRes.data || []).map((b) => ({
      ...b,
      label: `${b.name}${b.clients?.legal_name ? ` (${b.clients.legal_name})` : b.clients?.name ? ` (${b.clients.name})` : ''}`,
    })))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return projects.filter((p) => {
      if (filterType !== 'all' && p.type !== filterType) return false
      if (filterStatus !== 'all' && p.status !== filterStatus) return false
      if (!q) return true
      const hay = [p.name, p.brands?.name, p.brands?.clients?.name, p.brands?.clients?.legal_name, p.notes].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
  }, [projects, search, filterType, filterStatus])

  const selected = projects.find((p) => p.id === selectedId)

  const onModalSaved = (_row, action) => {
    load()
    if (action === 'deleted' && selectedId && _row.id === selectedId) selectProject(null)
  }

  const toggleDeliverableStatus = async (d) => {
    const next = DELIVERABLE_CYCLE[d.status] || 'not_started'
    const patch = { status: next }
    if (next === 'in_progress' && !d.started_at) patch.started_at = new Date().toISOString()
    if (next === 'complete') patch.completed_at = new Date().toISOString()
    if (next === 'not_started') patch.completed_at = null
    // Optimistic update
    setProjects((prev) => prev.map((p) =>
      p.id === selected.id
        ? { ...p, deliverables: p.deliverables.map((x) => x.id === d.id ? { ...x, ...patch } : x) }
        : p
    ))
    const { error } = await supabase.from('deliverables').update(patch).eq('id', d.id)
    if (error) setErr(error.message)
    // Trigger briefing_md + auto_complete triggers fire server-side; reload to reflect project status change.
    load()
  }

  return (
    <div className="projects-page">
      <div className="page-header">
        <span className="eyebrow">Projects</span>
        <h1>Buildouts &amp; Retainers</h1>
        <p>Numbered deliverables for buildouts · recurring services for retainers.</p>
      </div>

      <div className="list-toolbar">
        <input
          type="search"
          className="toolbar-search"
          placeholder="Search name, brand, client…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search"
        />
        <div className="toolbar-filters">
          {['all', 'buildout', 'retainer'].map((t) => (
            <button key={t} className={`filter-pill ${filterType === t ? 'active' : ''}`} onClick={() => setFilterType(t)}>{t}</button>
          ))}
        </div>
        <div className="toolbar-filters">
          {['active', 'draft', 'paused', 'complete', 'cancelled', 'all'].map((s) => (
            <button key={s} className={`filter-pill ${filterStatus === s ? 'active' : ''}`} onClick={() => setFilterStatus(s)}>{s}</button>
          ))}
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setModal({ kind: 'project' })}
          disabled={brands.length === 0}
          title={brands.length === 0 ? 'Add a brand first on the Contacts page.' : ''}
        >
          + New project
        </button>
      </div>

      {err && <div className="login-error" style={{marginBottom:16}}>{err}</div>}

      <div className="projects-split">
        <div className="projects-list-wrap">
          {loading ? (
            <div className="loading" style={{ minHeight: 120 }}>Loading…</div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              {brands.length === 0 ? (
                <>
                  <p>No brands exist yet. Add a contact → client → brand first.</p>
                  <a href="/contacts" className="cta-link">Go to Contacts →</a>
                </>
              ) : projects.length === 0 ? (
                <>
                  <p>No projects yet.</p>
                  <button className="cta-link" onClick={() => setModal({ kind: 'project' })}>
                    Create your first project →
                  </button>
                </>
              ) : (
                <p>No matches.</p>
              )}
            </div>
          ) : (
            <ul className="projects-list">
              {visible.map((p) => {
                const total = p.deliverables?.length || 0
                const done = (p.deliverables || []).filter((d) => d.status === 'complete').length
                const pct = total > 0 ? Math.round((done / total) * 100) : null
                const accent = p.brands?.color || 'var(--copper-dim)'
                return (
                  <li
                    key={p.id}
                    className={`project-row ${selectedId === p.id ? 'selected' : ''}`}
                    onClick={() => selectProject(p.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProject(p.id) } }}
                    style={{ borderLeftColor: accent }}
                  >
                    <div className="project-row-top">
                      <div className="project-row-name">{p.name}</div>
                      <span style={badgeStyle(colorForProjectStatus(p.status))}>{p.status}</span>
                    </div>
                    <div className="project-row-meta">
                      <span>{p.brands?.name || '—'}</span>
                      <span>{p.type}</span>
                      {p.total_fee != null && (
                        <span>{p.type === 'retainer' ? `${fmtMoneyShort(p.total_fee)}/mo` : fmtMoneyShort(p.total_fee)}</span>
                      )}
                    </div>
                    {p.type === 'buildout' && total > 0 && (
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${pct}%`, background: accent }} />
                        <span className="progress-label">{done}/{total} · {pct}%</span>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="projects-detail-wrap">
          {!selected ? (
            <div className="empty-state detail-empty">
              <p>Select a project on the left.</p>
            </div>
          ) : (
            <ProjectDetail
              project={selected}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              onEdit={() => setModal({ kind: 'project', data: selected })}
              onAddDeliverable={() => setModal({ kind: 'deliverable', data: { projectId: selected.id, nextNumber: (selected.deliverables?.length || 0) + 1 } })}
              onEditDeliverable={(d) => setModal({ kind: 'deliverable', data: { projectId: selected.id, deliverable: d } })}
              onToggleDeliverable={toggleDeliverableStatus}
              onAddService={() => setModal({ kind: 'service', data: { projectId: selected.id, nextNumber: (selected.retainer_services?.length || 0) + 1 } })}
              onEditService={(s) => setModal({ kind: 'service', data: { projectId: selected.id, service: s } })}
              onLogWork={(ctx) => setLogCtx(ctx || { brandId: selected.brands?.id })}
              activityRefreshKey={activityRefreshKey}
            />
          )}
        </div>
      </div>

      {modal?.kind === 'project' && (
        <EditProjectModal
          project={modal.data}
          brands={brands}
          defaultBrandId={modal.defaultBrandId}
          onClose={() => setModal(null)}
          onSaved={(row, action) => {
            onModalSaved(row, action)
            if (action === 'created') setSelectedId(row.id)
          }}
        />
      )}
      {modal?.kind === 'deliverable' && (
        <EditDeliverableModal
          projectId={modal.data.projectId}
          deliverable={modal.data.deliverable}
          nextNumber={modal.data.nextNumber}
          onClose={() => setModal(null)}
          onSaved={onModalSaved}
        />
      )}
      {modal?.kind === 'service' && (
        <EditServiceModal
          projectId={modal.data.projectId}
          service={modal.data.service}
          nextNumber={modal.data.nextNumber}
          onClose={() => setModal(null)}
          onSaved={onModalSaved}
        />
      )}
      {logCtx && (
        <LogWorkModal
          defaultBrandId={logCtx.brandId}
          defaultServiceId={logCtx.serviceId}
          onClose={() => setLogCtx(null)}
          onSaved={() => setActivityRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  )
}

/* ================= Detail ================= */

function ProjectDetail({
  project,
  activeTab,
  setActiveTab,
  onEdit,
  onAddDeliverable,
  onEditDeliverable,
  onToggleDeliverable,
  onAddService,
  onEditService,
  onLogWork,
  activityRefreshKey,
}) {
  const accent = project.brands?.color || 'var(--copper)'
  const isBuildout = project.type === 'buildout'
  const isRetainer = project.type === 'retainer'
  const total = project.deliverables?.length || 0
  const done = (project.deliverables || []).filter((d) => d.status === 'complete').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  // Tabs exist only for retainer projects. Buildouts render Overview content unwrapped.
  const tab = isRetainer ? (activeTab || 'overview') : 'overview'

  return (
    <div className="detail-pane">
      <div className="detail-header" style={{ borderLeft: `3px solid ${accent}`, paddingLeft: 16 }}>
        <div>
          <div className="detail-kind">
            {isBuildout ? 'Buildout' : 'Retainer'} · {project.brands?.name} · {project.brands?.clients?.legal_name || project.brands?.clients?.name}
          </div>
          <h2>{project.name}</h2>
          <div className="detail-sub">
            {project.total_fee != null && (
              <span>
                {isRetainer ? `${fmtMoneyShort(project.total_fee)}/mo` : fmtMoneyShort(project.total_fee)}
                {project.payment_structure ? ` · ${project.payment_structure.replace(/_/g, ' ')}` : ''}
              </span>
            )}
            {project.start_date && <span>Start {fmtDate(project.start_date)}</span>}
            {project.end_date && <span>{isRetainer ? 'Intro term ends' : 'Target'} {fmtDate(project.end_date)}</span>}
          </div>
        </div>
        <div className="detail-header-actions">
          <span style={badgeStyle(colorForProjectStatus(project.status))}>{project.status}</span>
          <button className="btn btn-link" onClick={onEdit}>Edit</button>
        </div>
      </div>

      {isRetainer && (
        <div className="tab-bar">
          <button
            type="button"
            className={`tab ${tab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            className={`tab ${tab === 'activity' ? 'active' : ''}`}
            onClick={() => setActiveTab('activity')}
          >
            Activity
          </button>
        </div>
      )}

      {tab === 'activity' && isRetainer && (
        <ActivityTab
          project={project}
          onLogWork={() => onLogWork({ brandId: project.brands?.id })}
          refreshKey={activityRefreshKey}
        />
      )}

      {tab === 'overview' && project.notes && <div className="detail-note">{project.notes}</div>}

      {tab === 'overview' && isBuildout && (
        <section>
          <div className="detail-section-header">
            <span className="eyebrow">Deliverables · {done}/{total} · {pct}%</span>
            <button className="btn btn-link" onClick={onAddDeliverable}>+ Add deliverable</button>
          </div>
          {total > 0 && (
            <div className="progress-bar progress-bar--big">
              <div className="progress-fill" style={{ width: `${pct}%`, background: accent }} />
            </div>
          )}
          {total === 0 ? (
            <div className="empty-state" style={{ padding: 16 }}>
              <p>No deliverables yet.</p>
              <button className="cta-link" onClick={onAddDeliverable}>Add your first →</button>
            </div>
          ) : (
            <DeliverableList
              deliverables={project.deliverables}
              onToggle={onToggleDeliverable}
              onEdit={onEditDeliverable}
            />
          )}
        </section>
      )}

      {tab === 'overview' && isRetainer && (
        <>
          <section>
            <div className="detail-section-header">
              <span className="eyebrow">Services ({(project.retainer_services || []).filter((s) => s.active).length} active)</span>
              <button className="btn btn-link" onClick={onAddService}>+ Add service</button>
            </div>
            {(project.retainer_services || []).length === 0 ? (
              <div className="empty-state" style={{ padding: 16 }}>
                <p>No services yet.</p>
                <button className="cta-link" onClick={onAddService}>Add your first →</button>
              </div>
            ) : (
              <ServiceList services={project.retainer_services} onEdit={onEditService} />
            )}
          </section>

          <section>
            <div className="detail-section-header">
              <span className="eyebrow">This Week · This Month</span>
            </div>
            <RetainerTaskSummary tasks={project.retainer_tasks} />
          </section>
        </>
      )}

      {tab === 'overview' && project.briefing_md && (
        <section>
          <div className="detail-section-header">
            <span className="eyebrow">Briefing</span>
            <CopyBriefingButton text={project.briefing_md} />
          </div>
          <pre className="briefing-preview">{project.briefing_md}</pre>
        </section>
      )}
    </div>
  )
}

function DeliverableList({ deliverables, onToggle, onEdit }) {
  const sorted = [...deliverables].sort((a, b) => a.number - b.number)
  const grouped = {}
  for (const d of sorted) {
    const k = d.category || 'Uncategorized'
    if (!grouped[k]) grouped[k] = []
    grouped[k].push(d)
  }
  return (
    <div className="deliverables">
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat} className="deliverable-group">
          <div className="deliverable-group-label">{cat}</div>
          <ul>
            {items.map((d) => (
              <li key={d.id} className={`deliverable-row status-${d.status}`}>
                <button
                  className="deliverable-check"
                  onClick={() => onToggle(d)}
                  aria-label={`Toggle deliverable ${d.number}`}
                  title={`Click to advance status. Currently ${d.status.replace('_', ' ')}.`}
                >
                  {d.status === 'complete' ? '✓' : d.status === 'in_progress' ? '→' : ''}
                </button>
                <span className="deliverable-num">#{d.number}</span>
                <span className="deliverable-name">{d.name}</span>
                {d.notes && <span className="deliverable-notes">{d.notes.split('\n')[0]}</span>}
                <button className="btn btn-link-small" onClick={() => onEdit(d)}>Edit</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function ServiceList({ services, onEdit }) {
  const sorted = [...services].sort((a, b) => a.number - b.number)
  return (
    <ul className="services-list">
      {sorted.map((s) => (
        <li key={s.id} className={`service-row ${s.active ? '' : 'inactive'}`}>
          <span className="service-num">#{s.number}</span>
          <div className="service-body">
            <div className="service-name">
              {s.name}
              <span className="service-meta">
                {s.cadence}
                {s.quantity_per_period > 1 && ` ×${s.quantity_per_period}`}
                {s.sla_hours && ` · SLA ${s.sla_hours}h`}
              </span>
            </div>
            {s.description && <div className="service-desc">{s.description}</div>}
            {s.platforms && s.platforms.length > 0 && (
              <div className="service-platforms">
                {s.platforms.map((p) => <span key={p}>{p}</span>)}
              </div>
            )}
          </div>
          <button className="btn btn-link-small" onClick={() => onEdit(s)}>Edit</button>
        </li>
      ))}
    </ul>
  )
}

function RetainerTaskSummary({ tasks }) {
  if (!tasks || tasks.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 16 }}>
        <p style={{ fontSize: 13 }}>Tasks are auto-generated weekly (Monday midnight) and monthly (1st) by the send-reminders edge function. Deploy Phase&nbsp;4 to start the generators.</p>
      </div>
    )
  }
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const dow = now.getDay() || 7
  const monday = new Date(now); monday.setDate(now.getDate() - (dow - 1))
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
  const month0 = new Date(now.getFullYear(), now.getMonth(), 1)
  const month1 = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  const toISO = (d) => d.toISOString().slice(0, 10)

  const week = tasks.filter((t) => t.period_type === 'weekly' && t.period_start === toISO(monday))
  const month = tasks.filter((t) => t.period_type === 'monthly' && t.period_start === toISO(month0))

  return (
    <div className="task-grid">
      <div>
        <div className="task-label">This week</div>
        {week.length === 0 ? <p className="task-empty">No weekly tasks.</p> : (
          <ul>{week.map((t) => <li key={t.id} className={t.status === 'complete' ? 'done' : ''}>{t.status === 'complete' ? '✓ ' : '○ '}{t.title}</li>)}</ul>
        )}
      </div>
      <div>
        <div className="task-label">This month</div>
        {month.length === 0 ? <p className="task-empty">No monthly tasks.</p> : (
          <ul>{month.map((t) => <li key={t.id} className={t.status === 'complete' ? 'done' : ''}>{t.status === 'complete' ? '✓ ' : '○ '}{t.title}</li>)}</ul>
        )}
      </div>
    </div>
  )
}


function fmtMonthName(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function ActivityTab({ project, onLogWork, refreshKey }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [serviceFilter, setServiceFilter] = useState('all')
  const [expandedId, setExpandedId] = useState(null)
  const [err, setErr] = useState('')

  const services = useMemo(
    () => [...(project.retainer_services || [])].sort((a, b) => a.number - b.number),
    [project.retainer_services]
  )
  const activeServices = services.filter((s) => s.active)
  const brandId = project.brands?.id

  useEffect(() => {
    if (!brandId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setErr('')
      const serviceIds = services.map((s) => s.id)
      let q = supabase
        .from('work_log')
        .select('id, title, notes, link_url, performed_at, service_id, retainer_services (name)')
        .eq('brand_id', brandId)
        .order('performed_at', { ascending: false })
      if (serviceIds.length > 0) {
        q = q.or(`service_id.in.(${serviceIds.join(',')}),service_id.is.null`)
      } else {
        q = q.is('service_id', null)
      }
      const { data, error } = await q
      if (cancelled) return
      if (error) setErr(error.message)
      setEntries(data || [])
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [brandId, services, refreshKey])

  const filtered = useMemo(() => {
    if (serviceFilter === 'all') return entries
    if (serviceFilter === 'general') return entries.filter((e) => !e.service_id)
    return entries.filter((e) => e.service_id === serviceFilter)
  }, [entries, serviceFilter])

  const months = useMemo(() => {
    const map = new Map()
    for (const e of filtered) {
      const key = String(e.performed_at).slice(0, 7)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(e)
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [filtered])

  const hasEntries = entries.length > 0

  return (
    <section className="activity-tab">
      <div className="detail-section-header" style={{ alignItems: 'center', gap: 10 }}>
        <button className="btn btn-primary" onClick={onLogWork}>+ Log work</button>
        {hasEntries && (
          <div className="toolbar-filters" style={{ marginLeft: 'auto' }}>
            <button
              className={`filter-pill ${serviceFilter === 'all' ? 'active' : ''}`}
              onClick={() => setServiceFilter('all')}
            >all</button>
            {activeServices.map((s) => (
              <button
                key={s.id}
                className={`filter-pill ${serviceFilter === s.id ? 'active' : ''}`}
                onClick={() => setServiceFilter(s.id)}
                title={s.name}
              >{s.name}</button>
            ))}
            <button
              className={`filter-pill ${serviceFilter === 'general' ? 'active' : ''}`}
              onClick={() => setServiceFilter('general')}
            >general</button>
          </div>
        )}
      </div>

      {err && <div className="form-error">{err}</div>}

      {loading ? (
        <div className="loading" style={{ minHeight: 120 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state" style={{ padding: 16 }}>
          {hasEntries ? (
            <p>No entries for this filter.</p>
          ) : (
            <>
              <p>No activity logged yet.</p>
              <button className="cta-link" onClick={onLogWork}>Log your first entry →</button>
            </>
          )}
        </div>
      ) : (
        months.map(([monthKey, rows]) => {
          const byService = new Map()
          for (const r of rows) {
            const k = r.service_id || '__general__'
            if (!byService.has(k)) {
              byService.set(k, {
                name: r.retainer_services?.name || 'General',
                entries: [],
              })
            }
            byService.get(k).entries.push(r)
          }
          return (
            <div key={monthKey} className="activity-month">
              <h3 className="activity-month-header">{fmtMonthName(monthKey)}</h3>
              {[...byService.entries()].map(([svcKey, { name, entries: svcEntries }]) => (
                <div key={svcKey} className="activity-service-group">
                  <div className="activity-service-label eyebrow">{name}</div>
                  <ul className="activity-list">
                    {svcEntries.map((e) => {
                      const open = expandedId === e.id
                      const firstLine = (e.notes || '').split('\n')[0]
                      return (
                        <li key={e.id} className={`activity-entry ${open ? 'open' : ''}`}>
                          <button
                            type="button"
                            className="activity-entry-head"
                            onClick={() => setExpandedId(open ? null : e.id)}
                            aria-expanded={open}
                          >
                            <span className="activity-entry-title">{e.title}</span>
                            <span className="activity-entry-meta">
                              {new Date(e.performed_at).toLocaleString('en-US', {
                                month: 'short', day: 'numeric',
                                hour: 'numeric', minute: '2-digit',
                              })}
                              {e.link_url && <span className="activity-entry-link-icon" aria-label="has link">↗</span>}
                            </span>
                          </button>
                          {firstLine && !open && (
                            <div className="activity-entry-preview">{firstLine}</div>
                          )}
                          {open && (
                            <div className="activity-entry-body">
                              {e.notes && <pre className="activity-entry-notes">{e.notes}</pre>}
                              {e.link_url && (
                                <a href={e.link_url} target="_blank" rel="noreferrer" className="activity-entry-link">
                                  {e.link_url}
                                </a>
                              )}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )
        })
      )}
    </section>
  )
}

function CopyBriefingButton({ text }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="btn btn-link"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          alert('Clipboard unavailable.')
        }
      }}
    >
      {copied ? '✓ Copied' : 'Copy to clipboard'}
    </button>
  )
}
