import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { badgeStyle, COLORS } from '../lib/format'

function fmtMs(n) {
  if (n == null) return '—'
  return `${n} ms`
}

function fmtWhen(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function staleBadges(stale) {
  const arr = Array.isArray(stale) ? stale : []
  if (arr.length === 0) return null
  return (
    <span className="incident-badges">
      {arr.map((s, i) => (
        <span
          key={i}
          style={badgeStyle(COLORS.red)}
          title={`${s.hours_ago}h since last run`}
          aria-label={`${String(s.jobname || '').replace(/^laviolette_/, '')}: ${s.hours_ago} hours since last run`}
        >
          {String(s.jobname || '').replace(/^laviolette_/, '')}
        </span>
      ))}
    </span>
  )
}

export default function Incidents() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [unhealthyOnly, setUnhealthyOnly] = useState(true)
  const [err, setErr] = useState('')
  const [stats, setStats] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    const sinceIso = new Date(Date.now() - 30 * 86400_000).toISOString()
    let q = supabase
      .from('health_checks')
      .select('id, checked_at, http_status, healthy, stale_crons, unresolved_dlq_count, response_ms, source')
      .gte('checked_at', sinceIso)
      .order('checked_at', { ascending: false })
      .limit(500)
    if (unhealthyOnly) q = q.eq('healthy', false)
    const { data, error } = await q
    if (error) { setErr(error.message); setLoading(false); return }
    setRows(data || [])

    const { data: statsData } = await supabase.from('v_health_stats_7d').select('*').maybeSingle()
    setStats(statsData || null)
    setLoading(false)
  }, [unhealthyOnly])

  useEffect(() => { load() }, [load])

  const hasData = rows.length > 0
  const statsLine = useMemo(() => {
    if (!stats || !stats.total_checks) return 'No health checks yet. Configure UptimeRobot — see docs/MONITORING_SETUP.md.'
    return `${stats.healthy_checks || 0} / ${stats.total_checks} healthy in last 7 days · uptime ${stats.uptime_pct ?? '—'}%`
  }, [stats])

  return (
    <div className="incidents-page">
      <div className="page-header">
        <span className="eyebrow">Observability</span>
        <h1>Incidents</h1>
        <p>Every /health probe logged over the last 30 days. Unhealthy rows by default.</p>
      </div>

      <div className="list-toolbar">
        <div className="incidents-stats">{statsLine}</div>
        <div style={{ flex: 1 }} />
        <label className="incidents-toggle">
          <input
            type="checkbox"
            checked={unhealthyOnly}
            onChange={(e) => setUnhealthyOnly(e.target.checked)}
          />
          <span>Unhealthy only</span>
        </label>
      </div>

      {err && <div className="login-error" style={{ marginBottom: 16 }}>{err}</div>}

      {loading ? (
        <div className="loading" style={{ minHeight: 120 }}>Loading…</div>
      ) : !hasData ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <p>
            {unhealthyOnly
              ? 'No incidents in the last 30 days. 🎉'
              : 'No health checks logged yet.'}
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-lo)' }}>
            Setup guide: <code>docs/MONITORING_SETUP.md</code> in the repo.
          </p>
        </div>
      ) : (
        <div className="incidents-table-scroll" style={{ overflowX: 'auto' }}>
          <table className="incidents-table">
            <thead>
              <tr>
                <th>Checked at</th>
                <th>Status</th>
                <th>Message</th>
                <th>Stale crons</th>
                <th>DLQ</th>
                <th>Response</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.healthy ? 'row-healthy' : 'row-unhealthy'}>
                  <td>{fmtWhen(r.checked_at)}</td>
                  <td>
                    <span
                      style={badgeStyle(r.healthy ? COLORS.green : COLORS.red)}
                      aria-label={`HTTP ${r.http_status} — ${r.healthy ? 'healthy' : 'unhealthy'}`}
                    >
                      {r.http_status}
                    </span>
                  </td>
                  <td className="incidents-message">
                    {r.healthy ? 'OK' : (Array.isArray(r.stale_crons) && r.stale_crons.length > 0
                      ? `${r.stale_crons.length} stale`
                      : (r.unresolved_dlq_count >= 5 ? `DLQ: ${r.unresolved_dlq_count} unresolved` : 'Unhealthy'))}
                  </td>
                  <td>{staleBadges(r.stale_crons)}</td>
                  <td>{r.unresolved_dlq_count ?? '—'}</td>
                  <td>{fmtMs(r.response_ms)}</td>
                  <td><span className="incidents-source">{r.source || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
