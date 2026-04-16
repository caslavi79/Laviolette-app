import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtMoneyShort, fmtDate, badgeStyle, COLORS, colorForProjectStatus } from '../lib/format'
import EditProjectModal from '../components/forms/EditProjectModal'
import EditDeliverableModal from '../components/forms/EditDeliverableModal'
import EditServiceModal from '../components/forms/EditServiceModal'

const DELIVERABLE_CYCLE = { not_started: 'in_progress', in_progress: 'complete', complete: 'not_started' }

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [brands, setBrands] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState('all')
  const [filterStatus, setFilterStatus] = useState('active')
  const [search, setSearch] = useState('')
  const [modal, setModal] = useState(null)
  const [err, setErr] = useState('')

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
    if (action === 'deleted' && selectedId && _row.id === selectedId) setSelectedId(null)
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
                    onClick={() => setSelectedId(p.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(p.id) } }}
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
              onEdit={() => setModal({ kind: 'project', data: selected })}
              onAddDeliverable={() => setModal({ kind: 'deliverable', data: { projectId: selected.id, nextNumber: (selected.deliverables?.length || 0) + 1 } })}
              onEditDeliverable={(d) => setModal({ kind: 'deliverable', data: { projectId: selected.id, deliverable: d } })}
              onToggleDeliverable={toggleDeliverableStatus}
              onAddService={() => setModal({ kind: 'service', data: { projectId: selected.id, nextNumber: (selected.retainer_services?.length || 0) + 1 } })}
              onEditService={(s) => setModal({ kind: 'service', data: { projectId: selected.id, service: s } })}
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
    </div>
  )
}

/* ================= Detail ================= */

function ProjectDetail({
  project,
  onEdit,
  onAddDeliverable,
  onEditDeliverable,
  onToggleDeliverable,
  onAddService,
  onEditService,
}) {
  const accent = project.brands?.color || 'var(--copper)'
  const isBuildout = project.type === 'buildout'
  const isRetainer = project.type === 'retainer'
  const total = project.deliverables?.length || 0
  const done = (project.deliverables || []).filter((d) => d.status === 'complete').length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

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

      {project.notes && <div className="detail-note">{project.notes}</div>}

      {isBuildout && (
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

      {isRetainer && (
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

      {project.briefing_md && (
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
