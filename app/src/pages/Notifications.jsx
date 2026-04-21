import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtDate, COLORS } from '../lib/format'

/* Dead-letter queue for Resend failures. Reads from `notification_failures`,
 * lets Case retry via the retry-notification edge function or dismiss rows
 * he doesn't care to retry. */
export default function Notifications() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('open')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    const query = supabase
      .from('notification_failures')
      .select('id, kind, context, subject, to_email, error, payload, created_at, resolved_at, resolution')
      .order('created_at', { ascending: false })
      .limit(200)
    const { data, error } = tab === 'open'
      ? await query.is('resolved_at', null)
      : await query.not('resolved_at', 'is', null)
    if (error) { setErr(error.message); setLoading(false); return }
    setRows(data || [])
    setLoading(false)
  }, [tab])

  useEffect(() => { load() }, [load])

  const retry = async (row) => {
    if (busyId) return
    setBusyId(row.id); setErr('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (!token) throw new Error('Not authenticated.')
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/retry-notification`
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: row.id }),
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`)
      await load()
    } catch (e) {
      setErr(`Retry failed: ${e.message}`)
    } finally {
      setBusyId(null)
    }
  }

  const dismiss = async (row) => {
    if (busyId) return
    if (!confirm('Dismiss this notification? It will move to Resolved with "dismissed" status.')) return
    setBusyId(row.id); setErr('')
    const { error } = await supabase
      .from('notification_failures')
      .update({ resolved_at: new Date().toISOString(), resolution: 'dismissed' })
      .eq('id', row.id)
    if (error) { setErr(error.message); setBusyId(null); return }
    await load()
    setBusyId(null)
  }

  const KIND_LABEL = {
    internal: 'HQ alert',
    client: 'Client email',
    contract_sign_confirmation: 'Signing confirmation',
  }
  const KIND_COLOR = {
    internal: COLORS.amber,
    client: COLORS.red,
    contract_sign_confirmation: COLORS.steel,
  }

  return (
    <div className="notifications-page">
      <div className="page-header">
        <span className="eyebrow">Dead-letter queue</span>
        <h1>Failed notifications</h1>
        <p>Emails that Resend rejected — retry them or dismiss.</p>
      </div>

      <div className="tab-bar">
        <button className={`tab ${tab === 'open' ? 'active' : ''}`} onClick={() => setTab('open')}>Open</button>
        <button className={`tab ${tab === 'resolved' ? 'active' : ''}`} onClick={() => setTab('resolved')}>Resolved</button>
      </div>

      {err && <div className="login-error" style={{ marginBottom: 16 }}>{err}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state" style={{ padding: 32 }}>
          <p>{tab === 'open' ? 'No failed notifications. Resend is healthy.' : 'No resolved notifications yet.'}</p>
        </div>
      ) : (
        <ul className="notification-list">
          {rows.map((row) => {
            const isOpen = expanded === row.id
            return (
              <li key={row.id} className={`notification-row ${isOpen ? 'expanded' : ''}`}>
                <div className="notification-row-main" onClick={() => setExpanded(isOpen ? null : row.id)}>
                  <span className="notification-kind" style={{ color: KIND_COLOR[row.kind] || COLORS.steel }}>
                    {KIND_LABEL[row.kind] || row.kind}
                  </span>
                  <span className="notification-subject">{row.subject || '(no subject)'}</span>
                  <span className="notification-to">{row.to_email || '—'}</span>
                  <span className="notification-date">{fmtDate(row.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                  {row.resolution && (
                    <span className="notification-resolution" style={{ color: row.resolution === 'retried' ? COLORS.green : COLORS.slate }}>
                      {row.resolution}
                    </span>
                  )}
                </div>
                {isOpen && (
                  <div className="notification-row-detail">
                    <div className="notification-detail-grid">
                      <div><span className="eyebrow">Context</span><code>{row.context}</code></div>
                      <div><span className="eyebrow">Error</span><code>{row.error}</code></div>
                      {row.resolved_at && (
                        <div><span className="eyebrow">Resolved</span>{fmtDate(row.resolved_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                      )}
                    </div>
                    {tab === 'open' && (
                      <div className="notification-actions">
                        {/* Hide Retry for audit-only rows. retry-notification's payload
                            contract requires from/html/to/subject; internal-kind rows
                            emitted by contract-sign's unified-onboarding failure path
                            (and similar audit callsites) lack email payload fields and
                            400 on retry. For those rows, only Dismiss makes sense —
                            Case acts on the alert manually. */}
                        {(row.kind === 'internal' && !(row.payload?.from && row.payload?.html)) ? (
                          <span className="dlq-row-audit-hint" style={{ fontSize: 12, color: 'var(--text-lo)', fontStyle: 'italic' }}>
                            Audit only · dismiss when handled
                          </span>
                        ) : (
                          <button
                            className="btn btn-primary"
                            onClick={() => retry(row)}
                            disabled={busyId === row.id}
                          >
                            {busyId === row.id ? 'Retrying…' : 'Retry send'}
                          </button>
                        )}
                        <button
                          className="btn btn-secondary"
                          onClick={() => dismiss(row)}
                          disabled={busyId === row.id}
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
