import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    if (import.meta.env.DEV) console.error('[Laviolette] Uncaught error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#12100D',
            color: '#F4F0E8',
            fontFamily: "'DM Sans', sans-serif",
            padding: 32,
            textAlign: 'center',
          }}
        >
          <p
            style={{
              fontSize: 11,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: '#C25A4E',
              marginBottom: 16,
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
            }}
          >
            Something went wrong
          </p>
          <h1 style={{ fontSize: 32, fontWeight: 400, marginBottom: 12, fontFamily: "'Cormorant Garamond', serif" }}>
            Application Error
          </h1>
          <p style={{ color: 'rgba(240,235,225,0.68)', fontSize: 14, maxWidth: 460, lineHeight: 1.6, marginBottom: 32 }}>
            {import.meta.env.DEV
              ? this.state.error?.message || 'An unexpected error occurred.'
              : 'An unexpected error occurred. Please reload the page.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#B8845A',
              color: '#12100D',
              border: 'none',
              padding: '12px 28px',
              borderRadius: 3,
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: 2,
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            Reload Page
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
