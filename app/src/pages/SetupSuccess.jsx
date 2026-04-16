import { useSearchParams } from 'react-router-dom'

/* Stripe Checkout success landing. No auth, no nav chrome. */
export default function SetupSuccess() {
  const [params] = useSearchParams()
  const client = params.get('client') || ''
  const safeClient = client.replace(/[<>]/g, '')

  return (
    <div className="stripe-redirect">
      <div className="stripe-redirect-wrap">
        <a href="https://laviolette.io/" className="stripe-redirect-mark" aria-label="Laviolette">
          <span className="L">La</span><span className="v">v</span><span className="L">iolette</span>
        </a>
        <div className="stripe-redirect-icon">✓</div>
        <h1>Bank account connected</h1>
        <p className="stripe-redirect-body">
          {safeClient ? (
            <><strong>{safeClient}</strong>, your bank account has been securely connected for automatic
            payments with <em>Laviolette LLC</em>.</>
          ) : (
            <>Your bank account has been securely connected for automatic payments with <em>Laviolette LLC</em>.</>
          )}
        </p>
        <p className="stripe-redirect-body">
          You don't need to do anything else. Payments will be processed automatically according to
          your service agreement.
        </p>
        <p className="stripe-redirect-note">You can close this page.</p>
        <div className="stripe-redirect-muted">
          Questions? Contact Case at <a href="tel:+15123509124">(512) 350-9124</a> or{' '}
          <a href="mailto:case.laviolette@gmail.com">case.laviolette@gmail.com</a>.
        </div>
      </div>
    </div>
  )
}
