// Tracks the text field the user last focused so the Tag Library (which lives in
// a different column) can inject a bracket tag at the caret. Editors call
// focusTag/blurTag; the Tag Library calls injectTag.

type Inserter = (tag: string) => void

let _active: Inserter | null = null

export function focusTag(el: HTMLTextAreaElement | HTMLInputElement, apply: (next: string) => void) {
  _active = (tag) => {
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    // OmniVoice tags are fixed (no editable inner part); add a trailing space so
    // the next word isn't glued on. A "{}" marker, if present, parks the caret
    // between the braces for any future editable tag.
    const hole = tag.indexOf('{}')
    const text = hole >= 0 ? tag.replace('{}', '') : tag.endsWith(' ') ? tag : tag + ' '
    const next = el.value.slice(0, start) + text + el.value.slice(end)
    apply(next)
    const caret = hole >= 0 ? start + hole : start + text.length
    requestAnimationFrame(() => {
      el.focus()
      try {
        el.setSelectionRange(caret, caret)
      } catch {
        /* ignore */
      }
    })
  }
}

export function blurTag() {
  const mine = _active
  // Delay so a Tag Library click (which fires before blur settles) still lands.
  setTimeout(() => {
    if (_active === mine) _active = null
  }, 200)
}

export function injectTag(tag: string): boolean {
  if (_active) {
    _active(tag)
    return true
  }
  return false
}
