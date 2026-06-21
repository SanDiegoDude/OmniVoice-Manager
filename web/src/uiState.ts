import { useState } from 'react'

/** A boolean that persists to localStorage — used for collapsible left-bar
 * sections so the user's open/closed layout survives reloads. */
export function usePersistentBool(key: string, def: boolean) {
  const [v, setV] = useState(() => {
    const s = localStorage.getItem(key)
    return s == null ? def : s === '1'
  })
  const set = (next: boolean) => {
    localStorage.setItem(key, next ? '1' : '0')
    setV(next)
  }
  return [v, set] as const
}
