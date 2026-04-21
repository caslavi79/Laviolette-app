import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SIGN_ENDPOINT = `${SUPABASE_URL}/functions/v1/contract-sign`

/* Public contract-signing page. No auth required.
 * Fetches the contract JSON from the contract-sign edge function,
 * renders the filled content inside a sandboxed iframe, captures
 * signature via either typed cursive OR canvas draw, and POSTs back. */
export default function Sign() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [state, setState] = useState('loading') // loading | ready | submitting | signed | error | already_signed
  const [contract, setContract] = useState(null)
  const [err, setErr] = useState('')
  const [signerName, setSignerName] = useState('')
  const [mode, setMode] = useState('type') // 'type' | 'draw'
  const canvasRef = useRef(null)
  const hiddenCanvasRef = useRef(null)
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

  /* Render the typed name into the hidden canvas using Great Vibes cursive,
   * then return a base64 PNG data URL — same format we'd get from the
   * drawn-signature canvas. Downstream code doesn't need to know which mode. */
  const generateTypedSignature = async () => {
    const c = hiddenCanvasRef.current
    if (!c) throw new Error('Signature renderer unavailable')
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, c.width, c.height)
    // Ensure Great Vibes is loaded before rendering (browser may not have fetched yet)
    try { await document.fonts.load('72px "Great Vibes"') } catch { /* non-fatal */ }
    ctx.fillStyle = '#12100D'
    ctx.textBaseline = 'middle'
    ctx.font = '72px "Great Vibes", cursive'
    // Fit text to canvas width with ~20px padding on each side
    const maxWidth = c.width - 40
    let fontSize = 72
    while (ctx.measureText(signerName).width > maxWidth && fontSize > 24) {
      fontSize -= 4
      ctx.font = `${fontSize}px "Great Vibes", cursive`
    }
    const x = 20
    const y = c.height / 2
    ctx.fillText(signerName, x, y)
    return c.toDataURL('image/png')
  }

  const submit = async (e) => {
    e.preventDefault()
    setErr('')
    if (!signerName.trim()) { setErr('Type your full name.'); return }
    let signature_data
    try {
      if (mode === 'type') {
        signature_data = await generateTypedSignature()
      } else {
        if (!hasInk.current) { setErr('Sign in the box above.'); return }
        signature_data = canvasRef.current.toDataURL('image/png')
      }
    } catch (renderErr) {
      setErr(renderErr.message || 'Failed to render signature')
      return
    }
    setState('submitting')
    try {
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
      <div className="sign-page sign-page--signed">
        <div className="sign-brand">
          <span className="L">La</span><span className="v">v</span><span className="L">iolette</span>
        </div>
        <div className="sign-signed-success">
          <div className="sign-signed-icon">✓</div>
          <h1>{state === 'signed' ? 'Signed' : 'Already signed'}</h1>
          <p>
            {contract?.client_name && <>Thank you, <strong>{contract.client_name}</strong>. </>}
            The contract <em>{contract?.name}</em> has been signed. A confirmation email is on its way.
          </p>
          <div className="sign-signed-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.print()}
            >
              Download signed copy (PDF)
            </button>
            <a
              className="btn btn-secondary"
              href={window.location.href}
              onClick={(e) => { e.preventDefault(); window.location.reload() }}
            >
              Refresh
            </a>
          </div>
          <p className="sign-signed-note">
            Use "Download signed copy" to save the fully-executed agreement as a PDF via your browser's Save-as-PDF option. Your copy is also emailed to you for safekeeping.
          </p>
        </div>
        <h2 className="sign-signed-heading">Signed contract</h2>
        <iframe
          className="sign-content sign-content--signed"
          title="Signed contract"
          sandbox=""
          srcDoc={contract?.filled_html || '<p>No content provided.</p>'}
        />
        <div className="sign-signed-footer-muted">
          Questions? <a href="mailto:case.laviolette@gmail.com">case.laviolette@gmail.com</a>
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

      <iframe
        className="sign-content"
        title="Contract content"
        sandbox=""
        srcDoc={contract.filled_html || '<p>No content provided.</p>'}
      />

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

        <div className="sign-mode-toggle" role="tablist" aria-label="Signature mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'type'}
            className={`sign-mode-btn ${mode === 'type' ? 'active' : ''}`}
            onClick={() => setMode('type')}
          >
            Type
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'draw'}
            className={`sign-mode-btn ${mode === 'draw' ? 'active' : ''}`}
            onClick={() => setMode('draw')}
          >
            Draw
          </button>
        </div>

        {mode === 'type' ? (
          <label className="sign-field">
            <span>Signature preview</span>
            <div className="sign-typed-preview" aria-live="polite">
              {signerName.trim() ? signerName : <span className="sign-typed-placeholder">Start typing your name above…</span>}
            </div>
            <p className="sign-mode-note">This cursive rendering is your signature. Switch to Draw if you'd rather sign with your finger/mouse.</p>
          </label>
        ) : (
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
        )}

        {/* Hidden canvas used to render typed signatures to base64 PNG so the
            stored signature_data format is identical whether typed or drawn. */}
        <canvas ref={hiddenCanvasRef} width={900} height={220} style={{ display: 'none' }} />

        {err && <div className="login-error">{err}</div>}

        <p className="sign-consent">
          By clicking <strong>I agree and sign</strong>, I consent to the use of
          electronic signatures and agree that my electronic signature has the
          same legal effect as a handwritten signature under the U.S. ESIGN Act
          and the Uniform Electronic Transactions Act (UETA).
        </p>

        <div className="sign-actions">
          <button type="submit" className="btn btn-primary" disabled={state === 'submitting'}>
            {state === 'submitting' ? 'Submitting…' : 'I agree and sign'}
          </button>
        </div>
      </form>
    </div>
  )
}
