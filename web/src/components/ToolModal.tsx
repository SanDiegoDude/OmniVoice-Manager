import { useEffect, type ReactNode } from 'react'

/** Standardized pop-over modal for specialized tools (trim/speed, vocal
 * performance, future plug-ins). Centered, viewport-clamped, ESC to close.
 * Overlay clicks do NOT close — tool modals hold unsaved work. */
export default function ToolModal({
  open,
  title,
  onClose,
  actions,
  width = 760,
  children,
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  /** Right-aligned header buttons (e.g. Save) rendered next to the ✕. */
  actions?: ReactNode
  width?: number
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-panel" style={{ width: `min(${width}px, calc(100vw - 32px))` }}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <div className="row" style={{ gap: 6 }}>
            {actions}
            <button className="btn sm ghost" onClick={onClose} title="Close (Esc)">✕</button>
          </div>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
