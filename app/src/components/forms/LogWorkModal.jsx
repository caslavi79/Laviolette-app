import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../Modal'
import { TextField } from '../Field'
import { supabase } from '../../lib/supabase'

/* Validate + normalize a link input. Strict: only http/https URLs are
 * accepted. Anything else (ftp, file, data, javascript, protocol-relative
 * `//foo`, mangled input) returns null and is silently dropped — spec
 * calls this out as acceptable since link is an optional field. */
function sanitizeUrl(raw) {
  const s = (raw || '').trim()
  if (!s) return null
  if (s.startsWith('//')) return null
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
  const m = start.getMinutes()
  start.setMinutes(m - (m % 15), 0, 0)
  return { start: start.toISOString(), end: end.toISOString() }
}

function presetJustNow() {
  return defaultSessionWindow()
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

/* Derive a display title from notes.
 * - First line of notes (trimmed).
 * - Capped at 200 chars to satisfy the work_log.title CHECK.
 * - Fallback: "Work session" (only possible if Case saves with empty
 *   notes, which the form validation tries to prevent).
 *
 * The session-grouped UI only shows notes in the expanded view; the
 * title field is vestigial for v2.1 and mostly exists to satisfy the
 * NOT NULL + length constraints on the column. A future migration
 * can drop title once downstream consumers (monthly recap, legacy
 * ActivityTab entries) no longer rely on it. */
function titleFromNotes(notes) {
  const firstLine = (notes || '').split('\n')[0].trim()
  if (!firstLine) return 'Work session'
  return firstLine.slice(0, 200)
}

export default function LogWorkModal({
  defaultBrandId,
  // eslint-disable-next-line no-unused-vars -- kept for call-site compat; v2.1 no longer
  // attaches to a specific service at save time (session_id groups sessions; categorization
  // deferred to retroactive tagging in v3).
  defaultServiceId,
  onClose,
  onSaved,
}) {
  const [brands, setBrands] = useState([])
  const [loadingBrands, setLoadingBrands] = useState(true)
  const [brandId, setBrandId] = useState(defaultBrandId || '')
  const initial = defaultSessionWindow()
  const [startedAt, setStartedAt] = useState(initial.start)
  const [endedAt, setEndedAt] = useState(initial.end)
  const [notes, setNotes] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const notesInputRef = useRef(null)

  // Load brands — just the list + color. No service lookup needed any
  // more; a session logs against a brand with freeform notes.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingBrands(true)
      const [brandsRes, recentRes] = await Promise.all([
        supabase
          .from('brands')
          .select('id, name, color')
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
      const shaped = (brandsRes.data || [])
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

  // After brand is resolved, focus the notes textarea — the primary
  // field in this form. Skip on mobile (virtual keyboard + scroll).
  useEffect(() => {
    if (!loadingBrands && brandId && notesInputRef.current) {
      if (typeof window !== 'undefined' && window.innerWidth >= 768) {
        notesInputRef.current.focus({ preventScroll: true })
      }
    }
  }, [loadingBrands, brandId])

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
    const trimmedNotes = notes.trim()
    if (!trimmedNotes) { setErr('Write what you did — even a one-liner is fine.'); return false }
    if (trimmedNotes.length > 2000) { setErr('Notes too long (max 2000 chars).'); return false }
    if (!startedAt || !endedAt) { setErr('Session window is required.'); return false }
    const startMs = Date.parse(startedAt)
    const endMs = Date.parse(endedAt)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) { setErr('Session window times are invalid.'); return false }
    if (endMs < startMs) { setErr('End time is before start time.'); return false }
    const nowMs = Date.now()
    if (startMs < nowMs - 30 * 86_400_000) { setErr('Start time is more than 30 days ago — pick a more recent session.'); return false }
    if (endMs > nowMs + 3_600_000) { setErr('End time is in the future. Adjust the window.'); return false }

    setBusy(true)
    const sessionId = crypto.randomUUID()
    const startedIso = new Date(startMs).toISOString()
    const endedIso = new Date(endMs).toISOString()
    const payload = {
      session_id: sessionId,
      brand_id: brandId,
      service_id: null,               // v2.1 — no per-task categorization
      title: titleFromNotes(trimmedNotes),
      count: 1,
      notes: trimmedNotes,
      link_url: sanitizeUrl(linkUrl),
      started_at: startedIso,
      ended_at: endedIso,
      performed_at: startedIso,
    }

    try {
      const { data, error } = await supabase.from('work_log').insert(payload).select().single()
      if (error) throw error
      onSaved?.(data, 'created')
      if (logAnother) {
        // Keep brand, reset everything else to defaults.
        const next = defaultSessionWindow()
        setStartedAt(next.start); setEndedAt(next.end)
        setNotes(''); setLinkUrl('')
        setToast('Logged — add another')
        setTimeout(() => setToast(''), 2000)
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
  }, [brandId, notes, linkUrl, startedAt, endedAt, onClose, onSaved])

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

        {/* Notes — primary field. */}
        <div className="field field--span-full">
          <label htmlFor="log_notes">What did you do?</label>
          <textarea
            id="log_notes"
            ref={notesInputRef}
            rows={5}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={'e.g. "Responded to 3 Google reviews, drafted this week\'s Instagram caption, sent Case pics for approval"'}
          />
        </div>

        <TextField
          id="log_link"
          label="Link (optional)"
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
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
