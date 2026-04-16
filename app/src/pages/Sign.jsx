import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SIGN_ENDPOINT = `${SUPABASE_URL}/functions/v1/contract-sign`

/* Public contract-signing page. No auth required.
 * Fetches the contract JSON from the contract-sign edge function,
 * renders the filled content, collects signature via canvas, and
 * POSTs back to the same endpoint. */
export default function Sign() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [state, setState] = useState('loading') // loading | ready | submitting | signed | error | already_signed
  const [contract, setContract] = useState(null)
  const [err, setErr] = useState('')
  const [signerName, setSignerName] = useState('')
  const canvasRef = useRef(null)
  const drawing = useRef(false)
  const hasInk = useRef(false)

  useEffect(() => {
    if (!token) { setState('error'); setErr('Missing token. Ask Case for a fresh link.'); return }
    ;(async () => {
      try {
        const resp = await fetch(`${SIGN_ENDPOINT}?token=${encodeURIComponent(token)}`)
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          throw new Error(body.error || `HTTP ${resp.status}`)
        }
        const data = await resp.json()
        setContract(data.contract)
        if (data.contract.status === 'signed' || data.contract.status === 'active') {
          setState('already_signed')
        } else {
          setSignerName(data.contract.signer_name || '')
          setState('ready')
        }
      } catch (e) {
        setErr(e.message)
        setState('error')
      }
    })()
  }, [token])

  const canvasPos = (e) => {
    const c = canvasRef.current
    const rect = c.getBoundingClientRect()
    const x = ((e.touches?.[0]?.clientX ?? e.clientX) - rect.left) * (c.width / rect.width)
    const y = ((e.touches?.[0]?.clientY ?? e.clientY) - rect.top) * (c.height / rect.height)
    return { x, y }
  }

  const start = (e) => {
    e.preventDefault()
    drawing.current = true
    const ctx = canvasRef.current.getContext('2d')
    const { x, y } = canvasPos(e)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#12100D'
    ctx.beginPath()
    ctx.moveTo(x, y)
  }
  const move = (e) => {
    if (!drawing.current) return
    e.preventDefault()
    const ctx = canvasRef.current.getContext('2d')
    const { x, y } = canvasPos(e)
    ctx.lineTo(x, y)
    ctx.stroke()
    hasInk.current = true
  }
  const stop = () => { drawing.current = false }
  const clearSig = () => {
    const c = canvasRef.current
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    hasInk.current = false
  }

  const submit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!signerName.trim()) { setErr('Type your full name.'); return }
    if (!hasInk.current) { setErr('Sign in the box above.'); return }
    setState('submitting')
    try {
      const signature_data = canvasRef.current.toDataURL('image/png')
      const resp = await fetch(SIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, signer_name: signerName.trim(), signature_data }),
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${resp.status}`)
      }
      setState('signed')
    } catch (e) {
      setErr(e.message)
      setState('ready')
    }
  }

  if (state === 'loading') return <div className="loading">Loading contract…</div>

  if (state === 'error') {
    return (
      <div className="stripe-redirect">
        <div className="stripe-redirect-wrap">
          <div className="stripe-redirect-mark"><span className="L">La</span><span className="v">v</span><span className="L">iolette</span></div>
          <div className="stripe-redirect-icon stripe-redirect-icon--muted">!</div>
          <h1>Contract link invalid</h1>
          <p className="stripe-redirect-body">{err}</p>
          <div className="stripe-redirect-muted">
            Ask Case for a fresh link: <a href="mailto:case.laviolette@gmail.com">case.laviolette@gmail.com</a>
          </div>
        </div>
      </div>
    )
  }

  if (state === 'signed' || state === 'already_signed') {
    return (
      <div className="stripe-redirect">
        <div className="stripe-redirect-wrap">
          <div className="stripe-redirect-mark"><span className="L">La</span><span className="v">v</span><span className="L">iolette</span></div>
          <div className="stripe-redirect-icon">✓</div>
          <h1>{state === 'signed' ? 'Signed' : 'Already signed'}</h1>
          <p className="stripe-redirect-body">
            {contract?.client_name && <>Thank you, <strong>{contract.client_name}</strong>. </>}
            The contract <em>{contract?.name}</em> has been signed. A confirmation email is on its way.
          </p>
          <p className="stripe-redirect-note">You can close this page.</p>
          <div className="stripe-redirect-muted">
            Questions? <a href="mailto:case.laviolette@gmail.com">case.laviolette@gmail.com</a>
          </div>
        </div>
      </div>
    )
  }

  // state === 'ready' | 'submitting'
  return (
    <div className="sign-page">
      <div className="sign-brand">
        <span className="L">La</span><span className="v">v</span><span className="L">iolette</span>
      </div>
      <h1 className="sign-title">{contract?.name}</h1>
      {contract?.client_name && <p className="sign-sub">Prepared for {contract.client_name}{contract.brand_name ? ` · ${contract.brand_name}` : ''}</p>}

      <div className="sign-content" dangerouslySetInnerHTML={{ __html: contract.filled_html || '<p>No content provided.</p>' }} />

      <form className="sign-form" onSubmit={submit}>
        <h2>Electronic signature</h2>
        <p className="sign-help">
          By signing below, you agree to the terms of this contract. Your signature, name, IP address, and timestamp will be recorded.
        </p>

        <label className="sign-field">
          <span>Full legal name</span>
          <input
            type="text"
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            placeholder="Type your full name"
            required
            maxLength={200}
            autoComplete="name"
          />
        </label>

        <label className="sign-field">
          <span>Draw your signature</span>
          <canvas
            ref={canvasRef}
            width={900}
            height={220}
            className="sign-canvas"
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={stop}
            onMouseLeave={stop}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={stop}
          />
          <button type="button" className="sign-clear" onClick={clearSig}>Clear</button>
        </label>

        {err && <div className="login-error">{err}</div>}

        <div className="sign-actions">
          <button type="submit" className="btn btn-primary" disabled={state === 'submitting'}>
            {state === 'submitting' ? 'Submitting…' : 'I agree and sign'}
          </button>
        </div>
      </form>
    </div>
  )
}
