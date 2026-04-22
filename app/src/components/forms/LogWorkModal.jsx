import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../Modal'
import { TextField } from '../Field'
import { supabase } from '../../lib/supabase'

/* Validate + normalize a link input. Strict: only http/https URLs are
 * accepted. Anything else (ftp, file, data, javascript, protocol-relative
 * `//foo`, mangled input) returns null and is silently dropped — spec
 * calls this out as acceptable since link is an optional field.
 * Bare domains like "example.com" (no scheme) are also rejected rather
 * than auto-upgraded, to avoid surprising the user. */
function sanitizeUrl(raw) {
  const s = (raw || '').trim()
  if (!s) return null
  // Reject protocol-relative (//foo) explicitly before parsing; URL()
  // would otherwise treat these as relative to the document origin.
  if (s.startsWith('//')) return null
  // Require an explicit http(s) scheme. No auto-prepend.
  if (!/^https?:\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/* timestamptz ↔ <input type="datetime-local"> bridging.
 * datetime-local has no timezone — we treat it as the user's local time. */
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(local) {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/* Default session window: starts 1 hour ago (rounded down to the nearest
 * 15 minutes), ends now. Matches the common case of "I just finished a
 * chunk of work and want to log it." */
function defaultSessionWindow() {
  const end = new Date()
  const start = new Date(end.getTime() - 60 * 60_000)
  // Round start down to nearest 15min for cleaner labels.
  const m = start.getMinutes()
  start.setMinutes(m - (m % 15), 0, 0)
  return { start: start.toISOString(), end: end.toISOString() }
}

/* Preset factories — each returns {start, end} in ISO. */
function presetJustNow() {
  return defaultSessionWindow()  // last hour ending now
}
function presetThisMorning() {
  const d = new Date()
  const start = new Date(d); start.setHours(9, 0, 0, 0)
  const end = new Date(d); end.setHours(12, 0, 0, 0)
  return { start: start.toISOString(), end: end.toISOString() }
}
function presetThisAfternoon() {
  const d = new Date()
  const start = new Date(d); start.setHours(13, 0, 0, 0)
  const end = new Date(d); end.setHours(17, 0, 0, 0)
  return { start: start.toISOString(), end: end.toISOString() }
}

const GENERAL_SENTINEL = '__general__'  // in-UI key for the "— General —" task row (service_id=null)

export default function LogWorkModal({
  defaultBrandId,
  defaultServiceId,
  onClose,
  onSaved,
}) {
  const [brands, setBrands] = useState([])       // [{ id, name, color, services: [...] }]
  const [loadingBrands, setLoadingBrands] = useState(true)
  const [brandId, setBrandId] = useState(defaultBrandId || '')
  // Session window (ISO strings)
  const initial = defaultSessionWindow()
  const [startedAt, setStartedAt] = useState(initial.start)
  const [endedAt, setEndedAt] = useState(initial.end)
  // Task selection — keyed by service_id OR GENERAL_SENTINEL.
  // Each entry: { checked, title, count }. title starts empty → falls back to service name on submit.
  const [taskStates, setTaskStates] = useState({})
  const [notes, setNotes] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const notesInputRef = useRef(null)

  // Load brands + their retainer services, and pick the default brand.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingBrands(true)
      const [brandsRes, recentRes] = await Promise.all([
        supabase
          .from('brands')
          // Left-join on projects so brands with no project yet still
          // appear in the picker. work_log.brand_id references brands
          // directly — no project required.
          .select(`
            id, name, color,
            projects (
              id, type, status,
              retainer_services ( id, number, name, active )
            )
          `)
          .order('name'),
        supabase
          .from('work_log')
          .select('brand_id, performed_at')
          .gte('performed_at', new Date(Date.now() - 24 * 3600_000).toISOString())
          .order('performed_at', { ascending: false })
          .limit(1),
      ])
      if (cancelled) return
      if (brandsRes.error) {
        setErr(brandsRes.error.message)
        setBrands([])
        setLoadingBrands(false)
        return
      }
      const shaped = (brandsRes.data || []).map((b) => {
        const retainer = (b.projects || []).find((p) => p.type === 'retainer')
        const services = retainer
          ? (retainer.retainer_services || []).filter((s) => s.active).sort((a, b) => a.number - b.number)
          : []
        return { id: b.id, name: b.name, color: b.color, hasRetainer: !!retainer, services }
      })
      setBrands(shaped)
      if (!defaultBrandId && shaped.length > 0) {
        const recent = recentRes.data?.[0]?.brand_id
        const picked = (recent && shaped.some((b) => b.id === recent)) ? recent : shaped[0].id
        setBrandId(picked)
      }
      setLoadingBrands(false)
    })()
    return () => { cancelled = true }
  }, [defaultBrandId])

  const selectedBrand = useMemo(() => brands.find((b) => b.id === brandId) || null, [brands, brandId])

  // Build the task list: services for the brand + a General sentinel.
  const taskList = useMemo(() => {
    if (!selectedBrand) return []
    const rows = (selectedBrand.services || []).map((s) => ({
      key: s.id,
      service_id: s.id,
      serviceName: s.name,
      isGeneral: false,
    }))
    rows.push({
      key: GENERAL_SENTINEL,
      service_id: null,
      serviceName: '— General —',
      isGeneral: true,
    })
    return rows
  }, [selectedBrand])

  // Reset task state when brand changes (services are brand-scoped).
  // Pre-check defaultServiceId if provided and still valid for this brand.
  useEffect(() => {
    if (!selectedBrand) { setTaskStates({}); return }
    setTaskStates((prev) => {
      const next = {}
      for (const t of taskList) {
        const prevEntry = prev[t.key]
        // Keep existing state if we had one; otherwise start unchecked.
        next[t.key] = prevEntry || { checked: false, title: '', count: 1 }
      }
      // If caller passed a defaultServiceId and we haven't yet checked it,
      // pre-check on first arrival.
      if (defaultServiceId && next[defaultServiceId] && !next[defaultServiceId].checked) {
        next[defaultServiceId] = { ...next[defaultServiceId], checked: true }
      }
      return next
    })
  }, [selectedBrand, taskList, defaultServiceId])

  // After brand is resolved, focus the notes textarea (first editable field in the session flow).
  useEffect(() => {
    if (!loadingBrands && brandId && notesInputRef.current) {
      // Don't auto-focus on mobile — the modal opens full-screen and the
      // focus shift scrolls the layout. Desktop only.
      if (typeof window !== 'undefined' && window.innerWidth >= 768) {
        notesInputRef.current.focus({ preventScroll: true })
      }
    }
  }, [loadingBrands, brandId])

  const toggleTask = (key) => {
    setTaskStates((prev) => ({
      ...prev,
      [key]: { ...prev[key], checked: !prev[key]?.checked },
    }))
  }
  const updateTaskField = (key, field, value) => {
    setTaskStates((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }))
  }

  const applyPreset = (preset) => {
    const win = preset === 'now' ? presetJustNow()
              : preset === 'am'  ? presetThisMorning()
              : preset === 'pm'  ? presetThisAfternoon()
              : defaultSessionWindow()
    setStartedAt(win.start); setEndedAt(win.end)
  }

  const save = useCallback(async ({ logAnother = false } = {}) => {
    setErr('')
    if (!brandId) { setErr('Pick a brand.'); return false }
    if (!startedAt || !endedAt) { setErr('Session window is required.'); return false }
    const startMs = Date.parse(startedAt)
    const endMs = Date.parse(endedAt)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) { setErr('Session window times are invalid.'); return false }
    if (endMs < startMs) { setErr('End time is before start time.'); return false }
    // Sanity: start no older than 30 days, end no more than 1h in the future.
    const nowMs = Date.now()
    if (startMs < nowMs - 30 * 86_400_000) { setErr('Start time is more than 30 days ago — pick a more recent session.'); return false }
    if (endMs > nowMs + 3_600_000) { setErr('End time is in the future. Adjust the window.'); return false }

    // Collect checked tasks. Each needs a title — fall back to service name if blank.
    const selectedTasks = []
    for (const t of taskList) {
      const s = taskStates[t.key]
      if (!s?.checked) continue
      const title = (s.title || '').trim() || t.serviceName
      if (!title) continue  // defensive — "— General —" has a truthy serviceName
      if (title.length > 200) { setErr(`Task title too long (${title.slice(0, 40)}…). Max 200 chars.`); return false }
      const count = Math.max(1, Math.min(1000, Math.floor(Number(s.count) || 1)))
      selectedTasks.push({ service_id: t.service_id, title, count })
    }
    if (selectedTasks.length === 0) { setErr('Pick at least one task.'); return false }

    const sanitizedLink = sanitizeUrl(linkUrl)
    const trimmedNotes = notes.trim() || null
    if (trimmedNotes && trimmedNotes.length > 2000) { setErr('Notes too long (max 2000 chars).'); return false }

    setBusy(true)
    // Client-generated session_id groups all N rows from this submit.
    // Batch insert is atomic (one statement) — all rows land or none do.
    const sessionId = crypto.randomUUID()
    const startedIso = new Date(startMs).toISOString()
    const endedIso = new Date(endMs).toISOString()
    const rows = selectedTasks.map((t) => ({
      session_id: sessionId,
      brand_id: brandId,
      service_id: t.service_id,
      title: t.title,
      count: t.count,
      notes: trimmedNotes,
      link_url: sanitizedLink,
      started_at: startedIso,
      ended_at: endedIso,
      // performed_at = started_at keeps every downstream consumer
      // (v_work_log_monthly, recap aggregator, Today CT-boundary
      // query, ActivityTab sort) unchanged. Sessions are invisible
      // to them — they still see N row-granular entries per session.
      performed_at: startedIso,
    }))

    try {
      const { data, error } = await supabase.from('work_log').insert(rows).select()
      if (error) throw error
      onSaved?.(data, 'created')
      if (logAnother) {
        // Reset for next session: keep brand, clear window (new defaults),
        // clear tasks, clear notes + link.
        const next = defaultSessionWindow()
        setStartedAt(next.start); setEndedAt(next.end)
        setTaskStates((prev) => {
          const out = {}
          for (const key of Object.keys(prev)) out[key] = { checked: false, title: '', count: 1 }
          return out
        })
        setNotes(''); setLinkUrl('')
        setToast(`Logged ${rows.length} task${rows.length === 1 ? '' : 's'} — add another`)
        setTimeout(() => setToast(''), 2200)
        setTimeout(() => notesInputRef.current?.focus({ preventScroll: true }), 0)
        setBusy(false)
        return true
      }
      onClose()
      return true
    } catch (e) {
      setErr(e.message || String(e))
      setBusy(false)
      return false
    }
  }, [brandId, startedAt, endedAt, taskList, taskStates, notes, linkUrl, onClose, onSaved])

  const handleSubmit = (e) => {
    e.preventDefault()
    save({ logAnother: false })
  }
  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      save({ logAnother: true })
    }
  }

  const checkedCount = Object.values(taskStates).filter((s) => s?.checked).length

  return (
    <Modal onClose={onClose} title="Log work" width="medium">
      <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="form-grid">
        {/* Brand picker + color swatch. */}
        <div className="field field--span-full">
          <label htmlFor="log_brand">Brand</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {selectedBrand?.color && (
              <span
                aria-hidden="true"
                style={{
                  width: 14, height: 14, borderRadius: 3,
                  background: selectedBrand.color,
                  flexShrink: 0,
                  boxShadow: '0 0 0 1px var(--border)',
                }}
              />
            )}
            <select
              id="log_brand"
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              style={{ flex: 1 }}
            >
              {loadingBrands && <option value="">Loading…</option>}
              {!loadingBrands && brands.length === 0 && <option value="">No brands yet</option>}
              {!loadingBrands && brands.length > 0 && !brandId && <option value="">Pick a brand…</option>}
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Session window. */}
        <div className="field field--span-full log-work-window">
          <label>Session window</label>
          <div className="log-work-window-row">
            <input
              id="log_started_at"
              type="datetime-local"
              aria-label="Start time"
              value={toLocalInput(startedAt)}
              onChange={(e) => setStartedAt(fromLocalInput(e.target.value) || startedAt)}
            />
            <span className="log-work-window-sep">→</span>
            <input
              id="log_ended_at"
              type="datetime-local"
              aria-label="End time"
              value={toLocalInput(endedAt)}
              onChange={(e) => setEndedAt(fromLocalInput(e.target.value) || endedAt)}
            />
          </div>
          <div className="log-work-presets">
            <button type="button" className="btn-chip" onClick={() => applyPreset('now')}>
              Just now · 1hr
            </button>
            <button type="button" className="btn-chip" onClick={() => applyPreset('am')}>
              This morning
            </button>
            <button type="button" className="btn-chip" onClick={() => applyPreset('pm')}>
              This afternoon
            </button>
          </div>
        </div>

        {/* Tasks — multi-select. */}
        <div className="field field--span-full">
          <label>
            Tasks{' '}
            <span style={{ color: 'var(--text-lo)', fontWeight: 'normal', fontSize: 11 }}>
              ({checkedCount} selected)
            </span>
          </label>
          {taskList.length === 0 ? (
            <div className="field-hint" style={{ fontSize: 12, color: 'var(--text-lo)' }}>
              Loading services…
            </div>
          ) : (
            <ul className="log-work-task-list">
              {taskList.map((t) => {
                const state = taskStates[t.key] || { checked: false, title: '', count: 1 }
                return (
                  <li
                    key={t.key}
                    className={`log-work-task${state.checked ? ' log-work-task--checked' : ''}${t.isGeneral ? ' log-work-task--general' : ''}`}
                  >
                    <label className="log-work-task-head">
                      <input
                        type="checkbox"
                        checked={!!state.checked}
                        onChange={() => toggleTask(t.key)}
                      />
                      <span className="log-work-task-name">{t.serviceName}</span>
                    </label>
                    {state.checked && (
                      <div className="log-work-task-fields">
                        <input
                          type="text"
                          className="log-work-task-title"
                          placeholder={`Title (optional — defaults to "${t.serviceName}")`}
                          maxLength={200}
                          value={state.title}
                          onChange={(e) => updateTaskField(t.key, 'title', e.target.value)}
                        />
                        <input
                          type="number"
                          className="log-work-task-count"
                          aria-label="How many"
                          min={1}
                          max={1000}
                          step={1}
                          value={state.count}
                          onChange={(e) => updateTaskField(t.key, 'count', e.target.value)}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Shared notes + link (one per session). */}
        <div className="field field--span-full">
          <label htmlFor="log_notes">Notes (optional — shared across all tasks)</label>
          <textarea
            id="log_notes"
            ref={notesInputRef}
            rows={2}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <TextField
          id="log_link"
          label="Link (optional — shared)"
          value={linkUrl}
          onChange={setLinkUrl}
          placeholder="https://…"
          span="full"
        />

        {toast && (
          <div className="form-hint" style={{ gridColumn: '1 / -1', color: 'var(--copper)', fontSize: 12 }}>
            ✓ {toast}
          </div>
        )}
        {err && <div className="form-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => save({ logAnother: true })}
            disabled={busy}
            title="Cmd/Ctrl+Enter"
          >
            Save &amp; log another
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : `Save${checkedCount > 0 ? ` (${checkedCount} task${checkedCount === 1 ? '' : 's'})` : ''}`}
          </button>
        </div>
      </form>
    </Modal>
  )
}
