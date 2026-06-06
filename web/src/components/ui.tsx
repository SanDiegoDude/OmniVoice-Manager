import { type ReactNode, useEffect, useState } from 'react'

export function Collapsible({
  title,
  children,
  defaultOpen = true,
  className = 'card',
  right,
}: {
  title: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  right?: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (!open) {
    return (
      <div className={`${className} collapsed`} onClick={() => setOpen(true)} title="Click to expand">
        <button className="mini-collapse" onClick={(e) => { e.stopPropagation(); setOpen(true) }} title="Expand">+</button>
        <span className="collapsed-title">{title}</span>
      </div>
    )
  }
  return (
    <div className={`${className} has-collapse`}>
      <button className="mini-collapse" onClick={() => setOpen(false)} title="Minimize">–</button>
      {right}
      {children}
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span>{label}</span>
    </label>
  )
}

export function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="slider-row">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
        <span className="val mono">{format ? format(value) : value}</span>
      </div>
    </label>
  )
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="m-body">{children}</div>
      </div>
    </div>
  )
}

export type ToastItem = { id: number; message: string; kind: 'info' | 'error' | 'success' }

export function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
