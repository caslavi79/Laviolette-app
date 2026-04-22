import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../Modal'
import { TextField, TextareaField, SelectField } from '../Field'
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

/* performed_at ↔ <input type="datetime-local"> bridging.
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

export default function LogWorkModal({
  defaultBrandId,
  defaultServiceId,
  onClose,
  onSaved,
}) {
  const [brands, setBrands] = useState([])       // [{ id, name, color, services: [...] }]
  const [loadingBrands, setLoadingBrands] = useState(true)
  const [brandId, setBrandId] = useState(defaultBrandId || '')
  const [serviceId, setServiceId] = useState(defaultServiceId || '')
  const [title, setTitle] = useState('')
  const [count, setCount] = useState(1)
  const [notes, setNotes] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [performedAt, setPerformedAt] = useState(new Date().toISOString())
  const [showDetails, setShowDetails] = useState(false)
  const [showTimePicker, setShowTimePicker] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')        // "Save & log another" confirmation
  const titleInputRef = useRef(null)

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
          // directly — no project required. Audit 2026-04-22 A8 LOW
          // (was `projects!inner` which excluded brands without a
          // project from the picker entirely).
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

  // Reset service if the current one doesn't belong to the newly selected brand.
  useEffect(() => {
    if (!selectedBrand) return
    if (serviceId && !selectedBrand.services.some((s) => s.id === serviceId)) {
      setServiceId('')
    }
  }, [selectedBrand, serviceId])

  // After brand+service are resolved, focus the title input (fast mobile entry).
  useEffect(() => {
    if (!loadingBrands && brandId && titleInputRef.current) {
      titleInputRef.current.focus()
    }
  }, [loadingBrands, brandId])

  const save = useCallback(async ({ logAnother = false } = {}) => {
    setErr('')
    if (!brandId) { setErr('Pick a brand.'); return false }
    const t = title.trim()
    if (!t) { setErr('Title is required.'); return false }
    if (t.length > 200) { setErr('Title is too long (max 200 chars).'); return false }
    const c = Math.max(1, Math.min(1000, Math.floor(Number(count) || 1)))
    setBusy(true)
    const payload = {
      brand_id: brandId,
      service_id: serviceId || null,
      title: t,
      count: c,
      notes: notes.trim() || null,
      link_url: sanitizeUrl(linkUrl),
      performed_at: performedAt || new Date().toISOString(),
    }
    try {
      const { data, error } = await supabase.from('work_log').insert(payload).select().single()
      if (error) throw error
      onSaved?.(data, 'created')
      if (logAnother) {
        // Keep brand + service; clear the rest so the next entry is fast.
        setTitle(''); setCount(1); setNotes(''); setLinkUrl('')
        setPerformedAt(new Date().toISOString())
        setShowTimePicker(false)
        setShowDetails(false)
        setToast('Logged — add another')
        setTimeout(() => setToast(''), 1800)
        // Refocus the title input for the next entry.
        setTimeout(() => titleInputRef.current?.focus(), 0)
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
  }, [brandId, serviceId, title, count, notes, linkUrl, performedAt, onClose, onSaved])

  const handleSubmit = (e) => {
    e.preventDefault()
    save({ logAnother: false })
  }

  // Cmd/Ctrl+Enter anywhere in the form → Save & log another.
  const handleKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      save({ logAnother: true })
    }
  }

  const brandOptions = brands.map((b) => ({ value: b.id, label: b.name }))
  const serviceOptions = (selectedBrand?.services || []).map((s) => ({ value: s.id, label: s.name }))

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
              {brandOptions.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Service picker — only if the brand has a retainer with active services. */}
        {selectedBrand && selectedBrand.hasRetainer && serviceOptions.length > 0 ? (
          <SelectField
            id="log_service"
            label="Service (optional)"
            value={serviceId}
            onChange={setServiceId}
            options={serviceOptions}
            placeholder="— General —"
            span="full"
          />
        ) : selectedBrand && !selectedBrand.hasRetainer ? (
          <div className="field field--span-full field-hint" style={{ fontSize: 12, color: 'var(--text-lo)' }}>
            No retainer services on this brand — entry will log as General.
          </div>
        ) : null}

        {/* Title */}
        <div className="field field--span-full">
          <label htmlFor="log_title">What did you do?</label>
          <input
            id="log_title"
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            placeholder='e.g. "Responded to 3 Google reviews"'
          />
        </div>

        {/* Details — collapsed by default. Count is the load-bearing field
           for monthly recap aggregation; notes + link are icing. */}
        <div className="field field--span-full">
          {!showDetails ? (
            <button
              type="button"
              className="btn btn-link"
              style={{ padding: 0, fontSize: 12 }}
              onClick={() => setShowDetails(true)}
            >
              + Count, notes, link… <span style={{ color: 'var(--text-lo)' }}>(optional)</span>
            </button>
          ) : (
            <>
              <div className="form-grid" style={{ gridColumn: '1 / -1', marginTop: 4 }}>
                <TextField
                  id="log_count"
                  type="number"
                  label="How many?"
                  value={count}
                  onChange={(v) => setCount(v)}
                  min="1"
                  max="1000"
                  step="1"
                  hint='e.g. "3" if this entry covers 3 posts or 3 reviews'
                />
                <div />
                <TextareaField
                  id="log_notes"
                  label="Notes (optional)"
                  value={notes}
                  onChange={setNotes}
                  rows={2}
                  maxLength={2000}
                />
                <TextField
                  id="log_link"
                  label="Link (optional)"
                  value={linkUrl}
                  onChange={setLinkUrl}
                  placeholder="https://…"
                  span="full"
                />
              </div>
            </>
          )}
        </div>

        {/* Performed at — collapsed by default. */}
        <div className="field field--span-full">
          {!showTimePicker ? (
            <button
              type="button"
              className="btn btn-link"
              style={{ padding: 0, fontSize: 12 }}
              onClick={() => setShowTimePicker(true)}
            >
              Set a different time… <span style={{ color: 'var(--text-lo)' }}>(defaults to now)</span>
            </button>
          ) : (
            <>
              <label htmlFor="log_performed">Performed at</label>
              <input
                id="log_performed"
                type="datetime-local"
                value={toLocalInput(performedAt)}
                onChange={(e) => setPerformedAt(fromLocalInput(e.target.value) || new Date().toISOString())}
              />
            </>
          )}
        </div>

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
