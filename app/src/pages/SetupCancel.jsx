/* Stripe Checkout cancel landing. No auth, no nav chrome. */
export default function SetupCancel() {
  return (
    <div className="stripe-redirect">
      <div className="stripe-redirect-wrap">
        <a href="https://laviolette.io/" className="stripe-redirect-mark" aria-label="Laviolette">
          <span className="L">La</span><span className="v">v</span><span className="L">iolette</span>
        </a>
        <div className="stripe-redirect-icon stripe-redirect-icon--muted">×</div>
        <h1>Setup was not completed</h1>
        <p className="stripe-redirect-body">Your bank account wasn't connected. No action was taken.</p>
        <p className="stripe-redirect-body">
          If you'd like to try again, reach out to Case for a new link.
        </p>
        <div className="stripe-redirect-muted">
          Contact: <a href="tel:+15123509124">(512) 350-9124</a> or{' '}
          <a href="mailto:case.laviolette@gmail.com">case.laviolette@gmail.com</a>.
        </div>
      </div>
    </div>
  )
}
