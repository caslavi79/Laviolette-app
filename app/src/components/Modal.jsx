import { useEscapeKey, useBodyLock } from '../lib/hooks'

/* Reusable modal shell. Portals to the page via CSS positioning.
 * Usage:
 *   <Modal onClose={...} title="Add contact" width="medium">
 *     <form>...</form>
 *   </Modal>
 */
export default function Modal({ onClose, title, children, width = 'medium', footer }) {
  useEscapeKey(onClose)
  useBodyLock()
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal modal--${width}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
