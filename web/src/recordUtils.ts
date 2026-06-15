import { useSyncExternalStore } from 'react'

// Recording preferences shared by the ADR performance modal and the Voice Clone
// tab's capture panel. Persisted to localStorage and synced live across every
// mounted consumer (and across tabs via the storage event) so a toggle in one
// place is the same everywhere — no resetting to defaults each time a panel
// opens.
export interface RecordPrefs {
  /** Play a 3·2·1 beep count-in before recording actually starts. */
  countIn: boolean
  /** Auto-transcribe (Whisper) the take the moment a recording stops. */
  autoWhisper: boolean
}

const KEY = 'ovm.recordPrefs'
const DEFAULTS: RecordPrefs = { countIn: false, autoWhisper: true }

function read(): RecordPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<RecordPrefs>) }
  } catch {
    // ignore unreadable/corrupt storage — fall back to defaults
  }
  return { ...DEFAULTS }
}

let state: RecordPrefs = read()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  // Cross-tab sync: another tab wrote new prefs.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      state = read()
      emit()
    }
  })
}

export function setRecordPref<K extends keyof RecordPrefs>(key: K, value: RecordPrefs[K]) {
  if (state[key] === value) return
  state = { ...state, [key]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // best-effort persistence; live sync still works in-session
  }
  emit()
}

/** Live, persistent record prefs. Reading + writing here keeps the modal and
 * the Voice Clone tab in lockstep. */
export function useRecordPrefs(): RecordPrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
    () => state,
  )
}

/** Handle to an in-flight count-in so it can be cancelled (Esc / Cancel). */
export interface CountIn {
  cancel: () => void
}

/**
 * Play a 3·2·1 audible count-in, calling `onTick` with 3, 2, 1 (and a final 0
 * meaning "go") so the UI can show the countdown. Resolves when the count-in
 * finishes; rejects if cancelled. The returned handle cancels both the audio
 * and the pending resolution.
 */
export function startCountIn(onTick: (n: number) => void): { promise: Promise<void>; handle: CountIn } {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  let ctx: AudioContext | null = null
  const timers: number[] = []
  let cancelled = false
  let settle: (() => void) | null = null
  let fail: ((e: unknown) => void) | null = null

  const cleanup = () => {
    for (const t of timers) window.clearTimeout(t)
    timers.length = 0
    if (ctx) {
      try {
        void ctx.close()
      } catch {
        /* already closed */
      }
      ctx = null
    }
  }

  const handle: CountIn = {
    cancel: () => {
      if (cancelled) return
      cancelled = true
      cleanup()
      fail?.(new DOMException('count-in cancelled', 'AbortError'))
    },
  }

  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve
    fail = reject
    try {
      if (AudioCtx) {
        ctx = new AudioCtx()
        void ctx.resume?.()
        const beep = (freq: number, when: number, dur: number) => {
          const c = ctx!
          const osc = c.createOscillator()
          const g = c.createGain()
          osc.type = 'sine'
          osc.frequency.value = freq
          osc.connect(g)
          g.connect(c.destination)
          g.gain.setValueAtTime(0.0001, when)
          g.gain.exponentialRampToValueAtTime(0.25, when + 0.012)
          g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
          osc.start(when)
          osc.stop(when + dur + 0.03)
        }
        const t0 = ctx.currentTime + 0.06
        beep(660, t0, 0.12) // 3
        beep(660, t0 + 1, 0.12) // 2
        beep(660, t0 + 2, 0.12) // 1
        beep(990, t0 + 3, 0.2) // go
      }
    } catch {
      // Audio unavailable (autoplay policy / no device) — still run the visual
      // countdown so recording starts after the same delay.
    }
    onTick(3)
    timers.push(window.setTimeout(() => onTick(2), 1000))
    timers.push(window.setTimeout(() => onTick(1), 2000))
    timers.push(
      window.setTimeout(() => {
        onTick(0)
        cleanup()
        if (!cancelled) settle?.()
      }, 3000),
    )
  })

  return { promise, handle }
}
