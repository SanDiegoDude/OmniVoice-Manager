import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Job, type Plugin, type PluginLabField, type SegmentEdit, type SegmentMeta, type Sound } from '../api'
import ToolModal from './ToolModal'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

type Vals = Record<string, string | number | boolean>

/** Generic, schema-driven generation modal ("Sound Lab"). Renders a plug-in's
 * declared `ui.lab` fields, runs its generic generate job, previews the result
 * (waveform + autoplay + speed/dB + download), supports fast reroll, and either
 * saves to the library (deferred — pick a folder + filename) or, in `track`
 * placement, drops the take onto the timeline. No plug-in-specific code lives
 * here — everything comes from the manifest schema. */
export function SoundLab({
  open,
  plugin,
  onClose,
  placement = 'library',
  sessionId,
  folders,
  voiceFolders = [],
  defaultLibrary,
  scriptConfigured,
  scriptLabel,
  librarySounds,
  onGenerated,
  onPlaceInTrack,
  notify,
}: {
  open: boolean
  plugin: Plugin | null
  onClose: () => void
  placement?: 'library' | 'track'
  sessionId: string | null
  folders: string[]
  voiceFolders?: string[]
  defaultLibrary?: 'voice' | 'sound'
  scriptConfigured: boolean
  scriptLabel?: string | null
  librarySounds?: Sound[]
  onGenerated: () => void
  onPlaceInTrack?: (url: string, filename: string, edit?: SegmentEdit) => void | Promise<void>
  notify: (msg: string) => void
}) {
  // 3 seconds: a sane default length for a quick foley take. Kept fixed across
  // category tabs (the user dials in the exact length they want, not a per-tab
  // preset that fights their edits).
  const DEFAULT_DURATION = 3
  const lab = plugin?.ui?.lab
  const fields = useMemo<PluginLabField[]>(() => lab?.fields ?? [], [lab])
  const categories = lab?.categories ?? []
  // Which libraries this plug-in may save into. Order sets the default; a picker
  // shows when more than one is allowed. Omitted → sound-only (legacy foley).
  const saveTargets = useMemo<('voice' | 'sound')[]>(
    () => (lab?.save_to && lab.save_to.length ? lab.save_to : ['sound']),
    [lab],
  )

  const [category, setCategory] = useState<string>(categories[0]?.id ?? '')
  const [vals, setVals] = useState<Vals>({})
  const [reprompt, setReprompt] = useState(true)
  const [advanced, setAdvanced] = useState(false)
  const [tab, setTab] = useState<'generate' | 'library'>('generate')
  const [pickedSound, setPickedSound] = useState<Sound | null>(null)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Job['progress']>({})
  const [result, setResult] = useState<NonNullable<Job['result']> | null>(null)
  // Whether the run that produced `result` actually asked for an LLM reprompt.
  // Lets us flag a *silent fallback* (asked, but came back un-enhanced) without
  // mistaking it for "reprompt off" or a Reroll (which intentionally skips it).
  const [repromptTried, setRepromptTried] = useState(false)
  // The shaped prompt from the last successful reprompt. Persists across Rerolls
  // (which reuse it but skip the LLM, so the result itself is un-flagged) so the
  // "Generated prompt" panel stays visible while you reroll the same take.
  const [enhancedPrompt, setEnhancedPrompt] = useState<string | null>(null)
  const [speed, setSpeed] = useState(1)
  // Trim window + output gain dialed into the preview — baked onto the placed
  // segment (track) or the saved file (library) so what you hear is what you get.
  const [trim, setTrim] = useState<{ start: number; end: number; dur: number } | null>(null)
  const [gainDb, setGainDb] = useState(0)
  const previewRef = useRef<AudioPlayerHandle | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveFolder, setSaveFolder] = useState('')
  const [saveName, setSaveName] = useState('')
  // The library a generated take saves into (voice | sound), within saveTargets.
  const [saveLib, setSaveLib] = useState<'voice' | 'sound'>(saveTargets[0])
  // Set when a generate fails because the gated model couldn't be fetched — the
  // help note then pops with the exact reason even if the cache probe was racy.
  const [gateError, setGateError] = useState<string | null>(null)
  const cancelled = useRef(false)

  // (Re)initialize field values from the schema defaults whenever the modal
  // opens or the plug-in changes.
  useEffect(() => {
    if (!open || !lab) return
    cancelled.current = false
    const initCat = categories[0]?.id ?? ''
    setCategory(initCat)
    const v: Vals = {}
    for (const f of fields) {
      if (f.type === 'toggle') v[f.key] = Boolean(f.default ?? false)
      else if (f.type === 'seed') v[f.key] = ''
      else v[f.key] = (f.default as string | number | undefined) ?? (f.type === 'number' ? 0 : '')
    }
    // Length defaults to 3s on open and stays put as the user switches tabs.
    if ('duration' in v) v.duration = DEFAULT_DURATION
    setVals(v)
    setResult(null)
    setProgress({})
    setSpeed(1)
    setTrim(null)
    setGainDb(0)
    setSaved(false)
    setSaveName('')
    setSaveFolder('')
    setSaveLib(defaultLibrary && saveTargets.includes(defaultLibrary) ? defaultLibrary : saveTargets[0])
    setGateError(null)
    setRepromptTried(false)
    setEnhancedPrompt(null)
    setTab(placement === 'track' ? 'generate' : 'generate')
    setPickedSound(null)
    return () => {
      cancelled.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plugin?.id])

  if (!plugin || !lab) {
    return (
      <ToolModal open={open} title="Sound Lab" onClose={onClose} width={680}>
        <div className="empty">This generator plug-in isn’t available.</div>
      </ToolModal>
    )
  }

  const installed = plugin.installed
  const needs = (plugin.needs ?? {}) as {
    model?: string
    model_gated?: boolean
    model_url?: string
  }
  const modelGated = Boolean(needs.model_gated)
  // Where to send the user to accept the license (explicit override, else derive
  // the HF page from the repo id) and our bundled troubleshooting page.
  const gateUrl = needs.model_url || (needs.model ? `https://huggingface.co/${needs.model}` : null)
  const helpUrl = `/api/plugins/${plugin.id}/help`
  // The model auto-downloads on first generate; the note only matters while it's
  // not yet local. Show it proactively when the cache probe says it's missing, or
  // reactively when a generate actually fails on the gate. A successful take
  // proves the weights are present, so it always wins.
  const showGateNote =
    installed && modelGated && !result && (gateError != null || plugin.model_present === false)
  const filenameFrom = lab.filename_from || 'prompt'
  const primaryField = fields.find((f) => f.primary) || fields.find((f) => f.type === 'textarea')
  const activeCat = categories.find((c) => c.id === category)
  // "Smart reprompt" is live: the plug-in supports it, the user left it on, and a
  // Script-AI provider exists. Drives both the button label and whether Generate
  // runs the prompt through the LLM before SA3.
  const repromptActive = Boolean(lab.reprompt) && reprompt && scriptConfigured

  const setVal = (k: string, v: string | number | boolean) => setVals((p) => ({ ...p, [k]: v }))

  // Switching category never touches the length — the user owns that number.
  const pickCategory = (id: string) => setCategory(id)

  const suggestName = () => {
    const raw = String(vals[filenameFrom] ?? '').slice(0, 15)
    return slugify(raw) || (category ? slugify(category) : 'sound')
  }

  // Non-destructive trim/speed/gain dialed into the preview, as a segment edit
  // (only the knobs the user actually moved). Speed rides natively on the
  // timeline (pitch-preserving); trim/gain bake into the clip on save.
  const adj = (): SegmentEdit => {
    const a: SegmentEdit = {}
    if (trim) {
      if (trim.start > 0.01) a.trim_start_s = Number(trim.start.toFixed(3))
      if (trim.dur > 0 && trim.end < trim.dur - 0.01) a.trim_end_s = Number(trim.end.toFixed(3))
    }
    if (Math.abs(speed - 1) > 0.01) a.speed = Number(speed.toFixed(2))
    if (Math.abs(gainDb) > 0.01) a.gain_db = Number(gainDb.toFixed(1))
    return a
  }

  const buildFields = (override?: Vals): Record<string, unknown> => {
    const src = { ...vals, ...(override ?? {}) }
    const out: Record<string, unknown> = {}
    if (category) out.category = category
    for (const f of fields) {
      const v = src[f.key]
      if (f.type === 'number') {
        if (v !== '' && v != null) out[f.key] = Number(v)
      } else if (f.type === 'seed') {
        out[f.key] = v === '' || v == null ? null : Number(v)
      } else if (f.type === 'toggle') {
        out[f.key] = Boolean(v)
      } else if (v !== '' && v != null) {
        out[f.key] = v
      }
    }
    return out
  }

  const primaryEmpty = primaryField ? !String(vals[primaryField.key] ?? '').trim() : false

  // `opts.reprompt` lets a caller force the LLM step off — Reroll uses this to
  // re-run SA3 on the already-shaped prompt without re-hitting the AI.
  const runGenerate = async (override?: Vals, opts?: { reprompt?: boolean; reroll?: boolean }) => {
    if (primaryEmpty || busy) return
    setBusy(true)
    setResult(null)
    setSaved(false)
    setGateError(null)
    setSpeed(1)
    setTrim(null)
    setGainDb(0)
    setProgress({ stage: 'queued' })
    const useReprompt = opts?.reprompt ?? repromptActive
    setRepromptTried(useReprompt)
    // A fresh generate starts a new prompt cycle (drop any prior enhanced prompt);
    // a Reroll keeps it so the panel persists across rerolls.
    if (!opts?.reroll) setEnhancedPrompt(null)
    try {
      const { job_id } = await api.pluginGenerate(plugin.id, {
        fields: buildFields(override),
        reprompt: useReprompt,
        save: false, // always preview first; saving is a deliberate second step
        session_id: sessionId,
        library: saveLib,
      })
      for (;;) {
        if (cancelled.current) return
        const j = await api.job(job_id)
        setProgress(j.progress || {})
        if (j.status === 'done') {
          setResult(j.result)
          if (j.result?.reprompted && j.result?.prompt) setEnhancedPrompt(String(j.result.prompt))
          setSaveName(suggestName())
          break
        }
        if (j.status === 'error') throw new Error(j.error || 'Generation failed')
        await sleep(700)
      }
    } catch (e) {
      const msg = (e as Error).message || 'Generation failed'
      // A gated/auth failure means the model never downloaded — surface the help
      // note (with links) instead of just a transient toast.
      if (modelGated && /gat(ed|e)|401|403|access|licen[cs]e|token|auth|huggingface|GatedRepo/i.test(msg)) {
        setGateError(msg)
      }
      notify(`${plugin.name}: ${msg}`)
    } finally {
      if (!cancelled.current) setBusy(false)
    }
  }

  // Reroll Generation: a fresh SA3 take on the SAME prompt — explicitly does NOT
  // re-run the LLM. We feed back the prompt SA3 actually used last time (the
  // reprompted, shaped text when reprompt was on; the raw text otherwise) and
  // force reprompt off. If a seed is pinned we bump it so the take changes;
  // a blank seed is already random.
  const reroll = () => {
    if (!result || busy) return
    const override: Vals = {}
    if (primaryField && result.prompt) override[primaryField.key] = result.prompt
    const seedField = fields.find((f) => f.type === 'seed')
    if (seedField) {
      const cur = vals[seedField.key]
      if (cur !== '' && cur != null) {
        const next = Number(cur) + 1
        override[seedField.key] = next
        setVal(seedField.key, next)
      }
    }
    runGenerate(override, { reprompt: false, reroll: true })
  }

  // Has the user trimmed or changed gain? (Those bake into a library copy.)
  const trimGainActive = () => {
    const a = adj()
    return a.trim_start_s != null || a.trim_end_s != null || a.gain_db != null
  }

  const doSave = async () => {
    if (!result?.temp) return
    const name = (saveName.trim() || suggestName()).replace(/\//g, '-')
    const fileName = name.toLowerCase().endsWith('.wav') ? name : `${name}.wav`
    const path = saveFolder ? `${saveFolder}/${name}` : name
    // Bake the previewed trim + gain into the saved file (same render as the
    // player's ⬇). Speed stays out — it's a timeline knob, not a baked one.
    const baked = trimGainActive() && previewRef.current
    try {
      let savedName: string
      if (saveLib === 'voice') {
        if (baked) {
          const blob = await previewRef.current!.exportBlob()
          if (!blob) throw new Error('Preview is still loading — try again in a moment.')
          // Stage the trimmed take, then ingest it into the voice library.
          const up = await api.uploadVoice(new File([blob], fileName, { type: 'audio/wav' }))
          savedName = (await api.importTempVoice(up.upload_id, path)).name
        } else {
          savedName = (await api.importTempVoice(result.temp, path)).name
        }
        notify(`Saved “${savedName}” to the voice library`)
      } else {
        let desc: Sound
        if (baked) {
          const blob = await previewRef.current!.exportBlob()
          if (!blob) throw new Error('Preview is still loading — try again in a moment.')
          desc = await api.uploadSound(new File([blob], fileName, { type: 'audio/wav' }), saveFolder)
        } else {
          desc = await api.importTempSound(result.temp, path)
        }
        savedName = desc.name
        notify(`Saved “${savedName}” to the sound library`)
      }
      setSaved(true)
      onGenerated()
    } catch (e) {
      notify((e as Error).message)
    }
  }

  const place = async () => {
    if (!onPlaceInTrack) return
    const fromLib = tab === 'library' && !!pickedSound
    const url = fromLib ? `/api/audio/sound/${pickedSound!.id}` : result?.audio_url
    if (!url) return
    const fname = fromLib ? pickedSound!.filename : `${suggestName()}.wav`
    if (fromLib) {
      await onPlaceInTrack(url, fname)
    } else {
      // A freshly generated take becomes a "foley" segment that remembers how it
      // was made — its prompt becomes the clip's dialogue and it can be re-rolled.
      const meta: SegmentMeta = {
        plugin: plugin.id,
        category: category || undefined,
        prompt: String(result?.raw_prompt ?? vals[filenameFrom] ?? '').trim() || undefined,
        fields: buildFields(),
        reprompt: repromptActive,
      }
      await onPlaceInTrack(url, fname, { ...adj(), kind: 'foley', meta })
    }
    onClose()
  }

  const stageMsg = progress.message || progress.stage || ''
  const previewUrl = result?.audio_url
  const canPlace = placement === 'track' && (tab === 'library' ? !!pickedSound : !!previewUrl)

  const renderField = (f: PluginLabField) => {
    if (f.type === 'textarea') {
      return (
        <div key={f.key}>
          <label className="field-label">{f.label}</label>
          <textarea
            className="input"
            rows={f.rows ?? 3}
            placeholder={activeCat?.placeholder || f.placeholder}
            value={String(vals[f.key] ?? '')}
            onChange={(e) => setVal(f.key, e.target.value)}
          />
        </div>
      )
    }
    if (f.type === 'number') {
      return (
        <label key={f.key} className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="hint">{f.label}</span>
          <input
            type="number"
            className="input"
            style={{ width: 90 }}
            min={f.min}
            max={f.max}
            step={f.step}
            value={vals[f.key] as number}
            onChange={(e) => setVal(f.key, e.target.value === '' ? '' : Number(e.target.value))}
          />
          {f.unit && <span className="hint">{f.unit}</span>}
        </label>
      )
    }
    if (f.type === 'seed') {
      return (
        <label key={f.key} className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="hint">{f.label}</span>
          <input
            className="input"
            style={{ width: 110 }}
            placeholder="random"
            value={String(vals[f.key] ?? '')}
            onChange={(e) => setVal(f.key, e.target.value)}
          />
        </label>
      )
    }
    if (f.type === 'toggle') {
      return (
        <label key={f.key} className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={Boolean(vals[f.key])} onChange={(e) => setVal(f.key, e.target.checked)} />
          <span>{f.label}</span>
        </label>
      )
    }
    if (f.type === 'select') {
      return (
        <label key={f.key} className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="hint">{f.label}</span>
          <select className="input" value={String(vals[f.key] ?? '')} onChange={(e) => setVal(f.key, e.target.value)}>
            {(f.options ?? []).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
      )
    }
    return (
      <label key={f.key} className="row" style={{ gap: 6, alignItems: 'center' }}>
        <span className="hint">{f.label}</span>
        <input className="input" value={String(vals[f.key] ?? '')} onChange={(e) => setVal(f.key, e.target.value)} />
      </label>
    )
  }

  const simpleFields = fields.filter((f) => !f.primary && !f.advanced && f.type !== 'textarea')
  const advancedFields = fields.filter((f) => f.advanced)

  return (
    <ToolModal open={open} title={`🎛 ${lab.title || `Sound Lab — ${plugin.name}`}`} onClose={onClose} width={700}>
      {!installed && (
        <div className="empty" style={{ marginBottom: 12 }}>
          The {plugin.name} plug-in isn’t installed yet. Run its bootstrap script first.
        </div>
      )}

      {placement === 'track' && (
        <div className="row" style={{ gap: 6, marginBottom: 12 }}>
          <button className={`btn sm ${tab === 'generate' ? 'primary' : 'ghost'}`} onClick={() => setTab('generate')}>Generate</button>
          <button className={`btn sm ${tab === 'library' ? 'primary' : 'ghost'}`} onClick={() => setTab('library')}>Load from library</button>
        </div>
      )}

      {tab === 'library' ? (
        <div>
          <div className="hint" style={{ marginBottom: 6 }}>Pick a saved sound to drop on the track.</div>
          <div className="card-body" style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 6 }}>
            {(librarySounds ?? []).length === 0 ? (
              <div className="empty">No saved sounds yet.</div>
            ) : (
              (librarySounds ?? []).map((s) => (
                <div
                  key={s.id}
                  className={`voice-item ${pickedSound?.id === s.id ? 'sel' : ''}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setPickedSound(s)}
                >
                  <span className="vname">{s.name}</span>
                </div>
              ))
            )}
          </div>
          {pickedSound && (
            <div style={{ marginTop: 12 }}>
              <AudioPlayer url={`/api/audio/sound/${pickedSound.id}`} autoPlay={false} playbackRate={speed} showDownload={false} />
            </div>
          )}
        </div>
      ) : (
        <>
          {categories.length > 0 && (
            <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              {categories.map((c) => (
                <button key={c.id} className={`btn sm ${category === c.id ? 'primary' : 'ghost'}`} onClick={() => pickCategory(c.id)}>
                  {c.id}
                </button>
              ))}
            </div>
          )}

          {primaryField && renderField(primaryField)}

          <div className="row" style={{ gap: 16, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {simpleFields.map(renderField)}
            {lab.reprompt && (
              <label
                className="row"
                style={{ gap: 6, alignItems: 'center' }}
                title={scriptConfigured ? `Rewrite your description into a detailed prompt using ${scriptLabel || 'the configured AI'}` : 'No Script-AI provider configured — your text is used as-is'}
              >
                <input type="checkbox" checked={reprompt && scriptConfigured} disabled={!scriptConfigured} onChange={(e) => setReprompt(e.target.checked)} />
                <span>Smart reprompt{!scriptConfigured && ' (no AI)'}</span>
              </label>
            )}
          </div>

          {advancedFields.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button className="btn ghost sm" onClick={() => setAdvanced(!advanced)}>{advanced ? '▾' : '▸'} Advanced</button>
              {advanced && (
                <div className="row" style={{ gap: 16, marginTop: 8, flexWrap: 'wrap' }}>{advancedFields.map(renderField)}</div>
              )}
            </div>
          )}

          <div className="row" style={{ marginTop: 16, gap: 8 }}>
            <button
              className="btn primary"
              style={{ flex: 1 }}
              disabled={busy || primaryEmpty || installed === false}
              onClick={() => runGenerate()}
              title={repromptActive ? 'Rewrite your description into a detailed SA3 prompt, then generate' : 'Generate audio from your prompt as written'}
            >
              {busy ? `Generating… ${stageMsg}` : repromptActive ? 'Process Prompt and Generate' : 'Generate'}
            </button>
          </div>

          {showGateNote && (
            <div className="hint gate-note" style={{ marginTop: 8 }}>
              <strong>This model’s weights are gated.</strong>{' '}
              {gateError
                ? 'The automatic download was blocked: '
                : 'They’ll download automatically on first generate, but only once you’ve granted access. '}
              {gateError && <code style={{ display: 'block', margin: '4px 0' }}>{gateError}</code>}
              {gateUrl && (
                <>
                  {' '}
                  <a href={gateUrl} target="_blank" rel="noopener noreferrer">
                    Accept the license on Hugging Face
                  </a>
                  , then make sure this machine is signed in (CLI token).{' '}
                </>
              )}
              <a href={helpUrl} target="_blank" rel="noopener noreferrer">
                Troubleshooting &amp; manual download →
              </a>
            </div>
          )}

          {result && previewUrl && (
            <div className="card" style={{ marginTop: 16, padding: 12 }}>
              {enhancedPrompt && (
                <div style={{ marginBottom: 8 }}>
                  <div className="field-label">Generated prompt</div>
                  <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>{enhancedPrompt}</div>
                </div>
              )}
              {repromptTried && !result.reprompted && (
                <div className="hint" style={{ marginBottom: 8 }}>
                  ⚠ Smart reprompt didn’t return a rewrite — generated from your prompt as-is
                  (the AI provider declined or errored). Quality may differ from a reprompted take.
                </div>
              )}
              <AudioPlayer
                key={previewUrl}
                ref={previewRef}
                url={previewUrl}
                autoPlay
                playbackRate={speed}
                filename={`${suggestName()}.wav`}
                encodeUrl="/api/audio/encode"
                onTrimChange={(start, end, dur) => setTrim({ start, end, dur })}
                onGainChange={setGainDb}
              />
              <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
                <button
                  className="btn sm"
                  onClick={reroll}
                  disabled={busy}
                  title="A fresh SA3 take on the same prompt (new seed). Does not re-run the AI prompt — use Generate for that."
                >
                  ↻ Reroll Generation
                </button>
                <span className="hint" style={{ marginLeft: 4 }}>Speed · {speed.toFixed(2)}×</span>
                <input type="range" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} style={{ flex: 1 }} />
                {speed !== 1 && <button className="btn ghost sm" onClick={() => setSpeed(1)}>Reset</button>}
              </div>
            </div>
          )}
        </>
      )}

      {/* Save / place actions */}
      {tab === 'generate' && previewUrl && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div className="field-label">Save to {saveLib === 'voice' ? 'voice' : 'sound'} library</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {saveTargets.length > 1 && (
              <select
                className="input"
                style={{ minWidth: 110 }}
                value={saveLib}
                onChange={(e) => { setSaveLib(e.target.value as 'voice' | 'sound'); setSaveFolder(''); setSaved(false) }}
                title="Which library to save this clip into"
              >
                {saveTargets.map((t) => (
                  <option key={t} value={t}>{t === 'voice' ? '🎙 Voice' : '🔊 Sound'}</option>
                ))}
              </select>
            )}
            <select className="input" style={{ minWidth: 150 }} value={saveFolder} onChange={(e) => setSaveFolder(e.target.value)}>
              <option value="">📁 Library root</option>
              {(saveLib === 'voice' ? voiceFolders : folders).map((f) => (
                <option key={f} value={f}>📁 {f}</option>
              ))}
            </select>
            <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="filename" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
            <button className="btn" disabled={saved} onClick={doSave}>{saved ? '✓ Saved' : '💾 Save'}</button>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Saved to the <strong>{saveLib === 'voice' ? 'voice' : 'sound'}</strong> library as{' '}
            <code>{(saveFolder ? saveFolder + '/' : '') + (saveName.trim() || suggestName())}</code>. Use the player’s ⬇ to download without saving.
            {trimGainActive() && ' Your trim & gain are baked into the saved copy.'}
            {Math.abs(speed - 1) > 0.01 && ' (Speed is a timeline knob — it applies when you place on a track, not to library copies.)'}
          </div>
        </div>
      )}

      {placement === 'track' && (
        <div style={{ marginTop: 12 }}>
          <button className="btn primary block" disabled={!canPlace} onClick={place}>
            ＋ Place on track
          </button>
        </div>
      )}
    </ToolModal>
  )
}
