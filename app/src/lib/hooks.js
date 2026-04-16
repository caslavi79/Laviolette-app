import { useEffect, useRef, useCallback } from 'react'

/* Calls onClose when Escape is pressed. */
export function useEscapeKey(onClose) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])
}

/* Locks body scroll and traps focus inside the topmost [role="dialog"]. */
export function useBodyLock() {
  useEffect(() => {
    document.body.classList.add('modal-open')
    const modal = document.querySelector('[role="dialog"]')
    if (modal) {
      const prev = document.activeElement
      const focusable = modal.querySelectorAll(
        'input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length > 0) focusable[0].focus()
      const trap = (e) => {
        if (e.key !== 'Tab' || focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus() }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus() }
        }
      }
      modal.addEventListener('keydown', trap)
      return () => {
        document.body.classList.remove('modal-open')
        modal.removeEventListener('keydown', trap)
        if (prev && typeof prev.focus === 'function') prev.focus()
      }
    }
    return () => document.body.classList.remove('modal-open')
  }, [])
}

/* Simple toast controller. Usage:
 *   const [toast, setToast] = useState('')
 *   const showToast = useToast()
 *   showToast(setToast, 'Saved')
 */
export function useToast() {
  const timerRef = useRef(null)
  const show = useCallback((setToast, msg, duration = 3000) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setToast(msg)
    timerRef.current = setTimeout(() => setToast(''), duration)
  }, [])
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  return show
}
