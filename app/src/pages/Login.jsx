import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    setResetSent(false)
    setLoading(true)

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    setLoading(false)
    if (signInError) {
      setError(signInError.message)
    } else {
      const redirect = location.state?.from || '/'
      navigate(redirect, { replace: true })
    }
  }

  const handleReset = async () => {
    if (!email) {
      setError('Enter your email first.')
      return
    }
    setError('')
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    })
    if (err) setError(err.message)
    else setResetSent(true)
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-mark">
          <span className="L">La</span><span className="v">v</span><span className="L">iolette</span>
        </div>
        <h1>HQ</h1>
        <p className="login-sub">Operations Portal</p>
        <form onSubmit={handleLogin} className="login-form">
          <div className="login-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="login-field">
            <label htmlFor="password">Password</label>
            <div className="login-password-wrap">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="login-toggle-pw"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          {error && <div className="login-error">{error}</div>}
          {resetSent && <div className="login-success">Password reset email sent. Check your inbox.</div>}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
          <button type="button" className="login-forgot" onClick={handleReset}>
            Forgot password?
          </button>
        </form>
      </div>
    </div>
  )
}
