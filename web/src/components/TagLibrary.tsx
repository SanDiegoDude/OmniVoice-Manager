import { injectTag } from '../tagInject'

// Authoritative OmniVoice non-verbal cues (omnivoice/models/omnivoice.py
// `_NONVERBAL_PATTERN`). Anything else in brackets is read aloud verbatim.
const TAG_GROUPS: { group: string; tags: { tag: string; label: string }[] }[] = [
  {
    group: 'Reactions',
    tags: [
      { tag: '[laughter]', label: 'laughter' },
      { tag: '[sigh]', label: 'sigh' },
      { tag: '[dissatisfaction-hnn]', label: 'hmph (annoyed)' },
      { tag: '[confirmation-en]', label: 'mm-hm (yes)' },
    ],
  },
  {
    group: 'Questioning',
    tags: [
      { tag: '[question-en]', label: 'hmm?' },
      { tag: '[question-ah]', label: 'ah?' },
      { tag: '[question-oh]', label: 'oh?' },
      { tag: '[question-ei]', label: 'eh?' },
      { tag: '[question-yi]', label: 'yi?' },
    ],
  },
  {
    group: 'Surprise',
    tags: [
      { tag: '[surprise-ah]', label: 'ah!' },
      { tag: '[surprise-oh]', label: 'oh!' },
      { tag: '[surprise-wa]', label: 'wa!' },
      { tag: '[surprise-yo]', label: 'yo!' },
    ],
  },
]

export function TagLibrary({ notify }: { notify: (msg: string, kind?: 'info' | 'error' | 'success') => void }) {
  const onClick = (tag: string) => {
    // Keep focus on the editor (mousedown handler does this); inject at caret.
    if (!injectTag(tag)) notify('Click into the script or a segment first, then pick a tag', 'info')
  }
  return (
    <div className="card tag-lib">
      <div className="section-title" style={{ margin: 0 }}>🏷 Tag library</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Click into the script or a segment line, then tap a tag to drop it at the cursor.
      </div>
      {TAG_GROUPS.map((g) => (
        <div key={g.group} className="tag-group">
          <div className="tag-group-title">{g.group}</div>
          <div className="tag-row">
            {g.tags.map((t) => (
              <button
                key={t.tag}
                className="tag-chip"
                title={`Insert ${t.tag}`}
                // mousedown + preventDefault keeps the editor focused so the
                // caret/selection survives the click.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onClick(t.tag)
                }}
              >
                <code>{t.tag}</code>
                <span className="tag-chip-label">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="hint" style={{ marginTop: 8, opacity: 0.8 }}>
        These 13 cues are the only brackets OmniVoice interprets; anything else is read aloud. “Whisper”, accents and
        pitch/age are <strong>voice-design attributes</strong> (set per-speaker in Design mode), not inline tags.
      </div>
    </div>
  )
}
