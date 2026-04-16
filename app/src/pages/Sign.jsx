/* Public contract-signing landing. Real rendering happens in the
 * contract-sign edge function (HTML response). This React route exists
 * so URLs like app.laviolette.io/sign?token=... don't 404 when the
 * Vite app intercepts them — it immediately redirects the browser to
 * the edge function URL, which renders the branded signing page. */

import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

export default function Sign() {
  const [params] = useSearchParams()
  const token = params.get('token')

  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL
    if (!token) return
    window.location.replace(`${url}/functions/v1/contract-sign?token=${encodeURIComponent(token)}`)
  }, [token])

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-mark">
            <span className="L">La</span><span className="v">v</span><span className="L">iolette</span>
          </div>
          <h1>Invalid signing link</h1>
          <p className="login-sub" style={{ marginTop: 12 }}>
            This link is missing its token. Ask Case to resend.
          </p>
        </div>
      </div>
    )
  }

  return <div className="loading">Opening signing page…</div>
}
