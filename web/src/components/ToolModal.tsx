import { useEffect, useRef, type ReactNode } from 'react'

// Stack of open tool modals so Escape/Space only ever act on the TOP one
// (e.g. the save-voice sub-modal over the vocal-performance modal).
const modalStack: number[] = []
let nextModalId = 1

/** Standardized pop-over modal for specialized tools (trim/speed, vocal
 * performance, future plug-ins). Centered, viewport-clamped, ESC to close.
 * Overlay clicks do NOT close — tool modals hold unsaved work. */
export default function ToolModal({
  open,
  title,
  onClose,
  actions,
  width = 760,
  onSpace,
  children,
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  /** Right-aligned header buttons (e.g. Save) rendered next to the ✕. */
  actions?: ReactNode
  width?: number
  /** Spacebar handler while the modal is open (e.g. toggle the modal's player).
   * Space NEVER reaches the page underneath — with or without a handler — so
   * it can't start the main timeline playing behind the modal. */
  onSpace?: () => void
  children: ReactNode
}) {
  const idRef = useRef(0)
  if (idRef.current === 0) idRef.current = nextModalId++

  useEffect(() => {
    if (!open) return
    const id = idRef.current
    modalStack.push(id)
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return // not the top modal
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.code === 'Space') {
        const el = e.target as HTMLElement
        const typing =
          el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
        if (typing) return
        // Capture-phase stop: the multitrack editor's window listener (bubble
        // phase) never sees it, so playback stays scoped to the modal.
        e.preventDefault()
        e.stopPropagation()
        onSpace?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const i = modalStack.indexOf(id)
      if (i >= 0) modalStack.splice(i, 1)
    }
  }, [open, onClose, onSpace])

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
