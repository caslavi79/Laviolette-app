import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

/* NavLink that respects a global unsaved-changes guard. The guard is
 * a window property set/unset by forms so that clicking a nav item
 * while edits are pending triggers a confirm dialog (ported from the
 * Sheepdog reference pattern).
 */
function GuardedNavLink({ to, end, children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const isActive = end ? location.pathname === to : location.pathname.startsWith(to)
  return (
    <a
      href={to}
      className={`sidebar-link${isActive ? ' active' : ''}`}
      onClick={(e) => {
        e.preventDefault()
        if (window.__unsavedChangesGuard && !window.confirm('You have unsaved changes. Discard them?')) return
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}

export default function Layout() {
  const navigate = useNavigate()
  const [alertCount, setAlertCount] = useState(0)

  const handleLogout = async () => {
    if (window.__unsavedChangesGuard && !window.confirm('You have unsaved changes. Discard them?')) return
    const { error } = await supabase.auth.signOut()
    if (error && import.meta.env.DEV) console.error('Logout error:', error.message)
    navigate('/login')
  }

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const { count } = await supabase
        .from('notification_failures')
        .select('id', { count: 'exact', head: true })
        .is('resolved_at', null)
      if (!cancelled) setAlertCount(count || 0)
    }
    refresh()
    const iv = setInterval(refresh, 60_000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [])

  return (
    <div className="app-layout">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <aside className="sidebar">
        <div className="sidebar-brand" aria-label="Laviolette HQ">
          <span className="L">La</span><span className="v">v</span><span className="L">iolette</span>
        </div>
        <nav className="sidebar-nav" aria-label="Primary">
          <GuardedNavLink to="/" end>Today</GuardedNavLink>
          <GuardedNavLink to="/schedule">Schedule</GuardedNavLink>
          <GuardedNavLink to="/contacts">Contacts</GuardedNavLink>
          <GuardedNavLink to="/projects">Projects</GuardedNavLink>
          <GuardedNavLink to="/money">Money</GuardedNavLink>
          <GuardedNavLink to="/contracts">Contracts</GuardedNavLink>
          <GuardedNavLink to="/incidents">Incidents</GuardedNavLink>
          {alertCount > 0 && (
            <GuardedNavLink to="/notifications">
              <span className="nav-alert-row">
                <span>Alerts</span>
                <span className="nav-alert-badge">{alertCount}</span>
              </span>
            </GuardedNavLink>
          )}
        </nav>
        <button onClick={handleLogout} className="sidebar-logout">Log Out</button>
      </aside>
      <main className="app-main" id="main-content">
        <Outlet />
      </main>
    </div>
  )
}
