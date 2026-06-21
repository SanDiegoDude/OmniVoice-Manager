# 🧩 External plug-ins

OmniVoice can run third-party generators (text-to-audio models, FX, analyzers)
as **external plug-ins** without ever putting their dependencies on the core. The
guiding rule, learned the hard way from ComfyUI custom nodes, is:

> A plug-in must never be able to destabilize the host.

So a plug-in runs as a **sidecar**: its own process, in its own
[`uv`](https://docs.astral.sh/uv/)-managed virtualenv, with a completely
independent dependency set (a different torch / CUDA build is fine). The host and
the sidecar talk over a tiny newline-delimited-JSON protocol on stdio. If a
plug-in crashes, leaks, or pins an incompatible library, the host is untouched.

The first plug-in shipped with this model is [Stable Audio 3](#reference-plug-in-stable-audio-3)
for foley / SFX / music generation.

---

## Anatomy of a plug-in

Plug-ins live in `plugins/<id>/`. The host discovers any directory there that
contains a `plugin.json`:

```
plugins/
  _sdk/                     # tracked in the core repo — the host's plug-in SDK
    omnivoice_plugin.py     # injected onto the sidecar's PYTHONPATH
  README.md                 # tracked — the drop-in directory contract
  <installed-plugin>/       # untracked — installed from its own repo (see below)
    plugin.json             # manifest (the only file the host reads directly)
    sidecar.py              # entrypoint — runs in the plug-in's own venv
    bootstrap.sh            # one-shot installer: builds .venv, installs deps
    …                       # plug-in-private helpers / assets
    .venv/                  # the isolated env (git-ignored, built by bootstrap)
```

Only `plugin.json`, the sidecar entrypoint, and the SDK are mandatory. Everything
else (bootstrap script, helper modules, model assets) is up to the plug-in. The
core repo tracks only `_sdk/` and `README.md`; installed plug-ins live in their
own repos and are git-ignored here — see [Installing & distributing
plug-ins](#installing--distributing-plug-ins).

---

## Quickstart: your first plug-in

Build a complete, working plug-in from scratch in four files. The example —
**Tone Generator** — synthesizes a sine-wave tone: no GPU, no model, light deps,
runs everywhere. It exercises the whole pipeline (manifest → bootstrap → sidecar
→ SDK → UI contribution → generate → save), so it's a faithful template for any
audio-generator plug-in. Deep-dive on each piece in the sections below.

**1. Make the folder** under the host's `plugins/` directory:

```bash
mkdir -p plugins/tone-gen && cd plugins/tone-gen
```

**2. `plugin.json`** — the manifest (the only file the host reads directly):

```json
{
  "id": "tone-gen",
  "name": "Tone Generator",
  "version": "0.1.0",
  "description": "Minimal example plug-in: synthesizes a pure sine-wave tone.",
  "author": "you",
  "license": "MIT",
  "isolation": "sidecar",
  "entrypoint": "sidecar.py",
  "python": ".venv/bin/python",
  "capabilities": ["generate"],
  "needs": { "bootstrap": "./bootstrap.sh" },
  "ui": {
    "kind": "audio-generator",
    "contributions": [
      { "slot": "sound.library.action", "label": "Tone Generator", "icon": "🔊", "opens": "lab" }
    ],
    "lab": {
      "title": "Tone Generator",
      "filename_from": "note",
      "fields": [
        { "key": "note",     "type": "text",   "label": "Label", "primary": true, "default": "A4 sine" },
        { "key": "freq",     "type": "number", "label": "Frequency", "unit": "Hz", "min": 20, "max": 20000, "default": 440 },
        { "key": "duration", "type": "number", "label": "Length", "unit": "sec", "min": 0.1, "step": 0.1, "default": 2 }
      ]
    }
  }
}
```

> `python` is declared as the POSIX path; the host auto-translates it to
> `.venv\Scripts\python.exe` on Windows. The `ui` block is **optional** — omit it
> for a headless plug-in you drive over HTTP (see the variations note at the end).

**3. `bootstrap.sh`** — builds the isolated venv (the `--no-config` flags keep the
host's `pyproject.toml` torch pin out of your env):

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"

if command -v uv >/dev/null 2>&1; then
  uv venv --no-config --python 3.10 "$VENV"
  uv pip install --no-config --python "$VENV/bin/python" numpy
else
  python3 -m venv "$VENV"
  "$VENV/bin/python" -m pip install numpy
fi
echo "tone-gen env ready at $VENV"
```

```bash
chmod +x bootstrap.sh && ./bootstrap.sh
```

**4. `sidecar.py`** — the plug-in itself. The host puts the SDK on `PYTHONPATH`;
a class plus one `run(...)` call is the whole thing:

```python
import os
import sys
import wave

_sdk = os.environ.get("OMNIVOICE_PLUGIN_SDK")
if _sdk and _sdk not in sys.path:
    sys.path.insert(0, _sdk)

from omnivoice_plugin import run


class ToneGen:
    def generate(self, ctx, **payload):
        import numpy as np

        freq = float(payload.get("freq") or 440.0)
        dur = float(payload.get("duration") or 2.0)
        sr = 44100
        ctx.progress(stage="render", message=f"Synthesizing {freq:.0f} Hz…")

        t = np.linspace(0, dur, int(sr * dur), endpoint=False)
        wav = (0.2 * np.sin(2 * np.pi * freq * t)).astype(np.float32)

        out = ctx.tmp_path(".wav")
        with wave.open(out, "w") as w:
            w.setnchannels(1)
            w.setsampwidth(2)  # 16-bit PCM
            w.setframerate(sr)
            w.writeframes((wav * 32767).astype("<i2").tobytes())

        ctx.progress(stage="done", message="Done")
        return {"audio_path": out, "sample_rate": sr, "duration_s": round(dur, 2)}


run(ToneGen())
```

**5. Run it.** Restart the manager so it discovers the new folder, then drive it
from the UI or headless:

```bash
# from the repo root, (re)start the manager
./run_manager.sh

# confirm it registered
curl -s localhost:8200/api/plugins | jq '.[] | {id, installed}'

# UI:  Sound Library → "🔊 Tone Generator" → set a frequency → Generate.
# Headless: queue a job, then poll it.
curl -s -X POST localhost:8200/api/plugins/tone-gen/generate \
  -H 'content-type: application/json' \
  -d '{"fields":{"note":"A4","freq":440,"duration":2},"reprompt":false,"save":false}'
# → {"job_id":"..."}
curl -s localhost:8200/api/jobs/<job_id> | jq .
```

That's a complete plug-in. To distribute it, push the folder to its own git repo
and others install it with `omnivoice-plugin install <git-url>` (see
[Installing & distributing plug-ins](#installing--distributing-plug-ins)).

### Develop & debug

- **Logs:** everything a plug-in writes via `ctx.log(...)` (and anything on
  stderr) goes to `data/plugins/logs/<id>.log`. `tail -f` it while testing.
- **Code reload:** the host keeps one warm sidecar per plug-in. After editing
  `sidecar.py`, `POST /api/plugins/<id>/unload` (or restart the manager) to
  respawn it with your new code.
- **Bootstrap failures** surface in that log too; re-run `./bootstrap.sh` after
  fixing — it's idempotent.
- **Cross-platform:** ship a `bootstrap.bat` (a thin launcher over a
  `bootstrap.ps1`) for Windows users; the host picks the right script per-OS when
  installing. See the [reference plug-in](#reference-plug-in-stable-audio-3) for a
  full multi-OS bootstrap.

### Variations

- **Headless / non-audio plug-in:** drop the `ui` block and expose any method as
  a command. Drive it with `POST /api/plugins/<id>/invoke` → `{ "cmd": "<method>",
  "payload": { ... } }`. Return any JSON-serializable dict.
- **GPU model:** set `"gpu": true` (+ `vram_mb`, `supports_low_vram`), load weights
  lazily in `load(ctx)`, and free them in `unload(ctx)` — see
  [Memory management](#memory-management).
- **Use the host's LLM, sound library, or project storage:** call back via
  `ctx.host_call(...)` — see [Host hooks](#host-hooks-the-api-available-to-plug-ins).

---

## The manifest — `plugin.json`

The manifest is the contract: it tells the host how to launch the plug-in
**without importing any of its code**. JSON (not TOML) keeps the host stdlib-only
on Python 3.10.

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier (also the directory name). Used in all routes. |
| `name` · `version` · `description` · `author` · `homepage` | Display metadata. |
| `source` | The plug-in's own git repo (used for install/update + provenance). |
| `license` | The plug-in's license — often **distinct from the host's** (e.g. a model under a vendor license). Surfaced in the API. |
| `isolation` | `"sidecar"` (own venv, the only supported mode today) or `"inprocess"`. |
| `entrypoint` | Script the host runs, e.g. `"sidecar.py"`. |
| `python` | Path to the venv interpreter, **relative to the plug-in dir** (e.g. `".venv/bin/python"`). |
| `gpu` | `true` if it touches the GPU — the host **frees the TTS model first** (see [Memory](#memory-management)). |
| `vram_mb` | Peak VRAM estimate (informational + future LOD scheduling). |
| `supports_low_vram` | `true` if the plug-in honors a `low_vram` flag in its payload. |
| `supports_cpu_offload` | Declares CPU-offload capability. |
| `capabilities` | Commands the host may invoke, e.g. `["generate"]`. |
| `needs` | Free-form requirements, e.g. `{ "model": "...", "model_gated": true, "bootstrap": "./bootstrap.sh" }`. |
| `ui` | **Declarative UI contributions + generation schema** — see [UI contributions](#ui-contributions-hooking-into-the-app) below. |

`installed` is **derived**, not declared: a sidecar plug-in is "installed" once
its `python` interpreter exists on disk. The host exposes the manifest (minus
filesystem paths) at `GET /api/plugins`.

---

## UI contributions (hooking into the app)

Plug-ins **never** edit core frontend code to add buttons or menus. Instead the
manifest's `ui` block declares **contributions** into named host **slots**, and a
**`lab` schema** that drives a generic generation modal ("Sound Lab"). The core
renders whatever is registered for each slot — so a new plug-in lights up across
the UI just by shipping a `plugin.json`, with zero plug-in JavaScript.

```json
"ui": {
  "kind": "audio-generator",
  "contributions": [
    { "slot": "sound.library.action", "label": "Generate Foley — Stable Audio 3", "icon": "🎛", "opens": "lab" },
    { "slot": "track.menu.empty",     "label": "Generate Foley…",                 "icon": "🎛", "opens": "lab" }
  ],
  "lab": {
    "title": "Sound Lab — Stable Audio 3",
    "filename_from": "prompt",
    "categories": [
      { "id": "SFX", "duration": 8, "placeholder": "e.g. heavy wooden door creaking open…" }
    ],
    "fields": [
      { "key": "prompt",   "type": "textarea", "label": "Describe the sound", "primary": true },
      { "key": "duration", "type": "number",   "label": "Length", "unit": "sec", "min": 1, "max": 300, "default": 8 },
      { "key": "steps",    "type": "number",   "label": "Steps", "default": 8, "advanced": true },
      { "key": "seed",     "type": "seed",     "label": "Seed", "advanced": true }
    ],
    "reprompt": true
  }
}
```

**Slots** currently rendered by the core:

| Slot | Where it appears |
| --- | --- |
| `sound.library.action` | A button in the Sound Library panel footer. |
| `voice.library.action` | A button in the Voice Library panel footer (the voice-side twin — for plug-ins that produce reference voices). |
| `track.menu.empty` | An item in the multitrack double-click menu on an audio track (drops the result at the click point). |

A contribution's `opens` names a `ui` block to open — today `"lab"`, the
schema-driven Sound Lab.

**`ui.kind` can select a dedicated lab.** Most generators use `"audio-generator"`
→ the generic schema-driven Sound Lab. The host can also ship a *purpose-built*
editor for a kind: `"url-clipper"` renders the **Clip Grabber** lab — a fetch box
that runs the plug-in's `generate` (a pure download) then loads the result into
the shared waveform editor for trim / zoom / pan / cleanup / save. A `url-clipper`
plug-in only implements the download; trimming, cleanup and the library save are
host-driven against the standard endpoints. Its `lab.fields` are unused beyond the
`url` field, but `lab.save_to` still applies.

For the default `audio-generator` lab — **field types:** `textarea`, `number`,
`seed`, `toggle`, `select`, `text`. `primary` marks the headline field, `advanced`
tucks a field behind a disclosure, and `categories` (optional) offer one-click presets that set
field defaults (e.g. duration). `filename_from` picks the field whose first ~15
chars seed the suggested save filename. `reprompt: true` shows the "smart
reprompt" toggle (the plug-in's sidecar performs the rewrite via the
[`reprompt` host hook](#host-hooks-the-api-available-to-plug-ins)).

**Save target — `lab.save_to`.** By default a generated take saves into the
**sound** library (foley). A plug-in that produces voices (or either) declares
`"save_to": ["voice", "sound"]` (order sets the default) and the Lab shows a
small library picker in the Save box, ingesting into whichever the user
chooses. Omit it for the legacy sound-only behaviour. Pair it with a
`voice.library.action` contribution so the plug-in also launches from the Voice
Library panel.

The Sound Lab generates to a temp **preview** (waveform, autoplay, speed/dB,
download), then **saves on demand** into the chosen library + folder (voice or
sound, per `save_to`) — or, from a track, drops straight onto the timeline. None
of this is plug-in-specific code.

---

## The sidecar & the SDK

A sidecar is any program that speaks the protocol on stdio. The easiest way is
the bundled SDK, `plugins/_sdk/omnivoice_plugin.py` — **pure standard library**
so it imports cleanly inside any venv. The host puts it on the sidecar's
`PYTHONPATH` automatically.

A complete plug-in is a class plus one line:

```python
from omnivoice_plugin import run

class MyPlugin:
    def load(self, ctx):
        # heavy, lazy init (load weights to GPU, etc.)
        ...

    def unload(self, ctx):
        # free GPU / drop references
        ...

    def health(self, ctx):
        return {"ok": True}

    def generate(self, ctx, **payload):
        out = ctx.tmp_path(".wav")
        # ... write audio to `out` ...
        ctx.progress(stage="render", pct=100)
        return {"audio_path": out, "duration_s": 8.0, "sample_rate": 44100}

run(MyPlugin())
```

Method names map to commands: a `generate` command calls `plugin.generate(ctx,
**payload)`. `load` / `unload` / `health` / `shutdown` are built in.

### The `Context` object

Every handler receives a `ctx`:

| Member | Use |
| --- | --- |
| `ctx.progress(**data)` | Emit an incremental progress event (surfaces in job polling on the host). |
| `ctx.log(msg, level=...)` | Human log line → stderr → the plug-in's log file. |
| `ctx.tmp_path(suffix)` | A unique path in the host-owned per-plugin temp dir (host cleans it up). |
| `ctx.host_call(method, **params)` | Call a [host hook](#host-hooks-the-api-available-to-plug-ins) and get the result back synchronously. |

> **stdout is reserved for protocol JSON.** Never `print()` to stdout from a
> plug-in — use `ctx.log(...)` or `sys.stderr`. The host captures stderr to
> `data/plugins/logs/<id>.log`.

### Passing audio

Audio (and any large blob) is passed **by file path**, not serialized into JSON.
A handler writes to `ctx.tmp_path()` and returns `{"audio_path": ...}`. The host
reads the file and ingests/serves it. This keeps the protocol cheap and avoids
base64 bloat.

---

## The stdio protocol

Newline-delimited JSON, host → sidecar on **stdin**, sidecar → host on
**stdout**:

```jsonc
// host → sidecar
{"cmd": "generate", "rid": "abc", "payload": { ... }}

// sidecar → host
{"type": "ready",    "data": {"plugin_id": "...", "capabilities": [...]}}  // once
{"type": "progress", "rid": "abc", "data": { ... }}
{"type": "result",   "rid": "abc", "data": { ... }}
{"type": "error",    "rid": "abc", "error": "..."}
```

You normally never touch this layer — the SDK implements it. It's documented so
you can write a sidecar in another language if you ever need to.

---

## Host hooks (the API available to plug-ins)

While handling a command, a plug-in can reach **back into the host** with
`ctx.host_call(method, **params)`. The host injects the calling plug-in's `id`,
so a plug-in can only ever scope its own data. Available hooks:

| Hook | Signature | What it does |
| --- | --- | --- |
| `reprompt` | `reprompt(system=..., user=..., temperature=0.7, max_tokens=400, provider_id=None)` → `{"text": ...}` | Rewrite a prompt with the host's **configured Script-AI provider** (OpenAI-compatible or Vertex). Lets a plug-in reuse OmniVoice's LLM instead of bundling its own. |
| `save_sound` | `save_sound(audio_path=..., rel_path=...)` → sound descriptor | Ingest a WAV into the shared [sound library](sound-library.md) (native sample rate / channels preserved). |
| `save_voice` | `save_voice(audio_path=..., rel_path=...)` → voice descriptor | Ingest a WAV into the shared **voice library** — the voice-side twin of `save_sound` (verbatim, de-duped). Lets a plug-in add reference voices, not just foley. |
| `set_project_data` | `set_project_data(session_id=..., data=..., merge=True)` | Persist arbitrary plug-in state onto a project. See below. |
| `get_project_data` | `get_project_data(session_id=...)` → your stored data | Read this plug-in's project state back. |

Example — let the host rewrite a prompt before you render it:

```python
def generate(self, ctx, prompt, **rest):
    better = ctx.host_call(
        "reprompt",
        system="You are a foley prompt engineer.",
        user=prompt,
    )["text"]
    ...
```

### The project-data hook (persistence that travels)

Projects (multitrack sessions) carry a `plugin_data` dict — arbitrary,
per-plug-in JSON that is saved with the project **and travels inside the `.omvp`
bundle** on export/import. This is the supported way for a plug-in to remember
state across sessions (last settings, generated-asset references, etc.) without
inventing its own storage.

- Write: `ctx.host_call("set_project_data", session_id=sid, data={...}, merge=True)`
- Read: `ctx.host_call("get_project_data", session_id=sid)`

A project's ⓘ popover surfaces which plug-ins have attached data, so users can see
what a `.omvp` depends on.

### Per-segment metadata

Beyond project-level data, **every timeline clip carries its own open `meta`
bag** plus a `kind` tag. When an `audio-generator` take is placed on the timeline
it lands as `kind: "foley"` with `meta` describing how it was made — the origin
`plugin` id, `category`, source `prompt` (also written as the clip's dialogue),
and the generation `fields`. The host uses this to **re-roll the clip in place**
via the same plug-in (the ↻ on a foley clip → `POST …/segment/{i}/regenerate-foley`,
which re-runs the generator at the clip's *current* dialogue and length). Plug-ins
may stash arbitrary extra keys under `meta`; it round-trips with the project and
the `.omvp`. The timeline colours foley (teal) and plain uploads (slate) apart
from voiced/performance clips, and only foley/voiced clips expose a regenerate
action — a static uploaded clip has nothing to regenerate.

---

## Memory management

OmniVoice targets home GPUs, so plug-ins must cooperate on VRAM:

1. **GPU serialization (both directions).** When a plug-in declares `"gpu": true`,
   the host **frees the main TTS model before invoking it**. Symmetrically, the
   TTS worker **frees GPU plug-in sidecars before it (re)acquires the GPU**
   (`plugin_host.free_gpu`, wired to `ModelManager.before_gpu`). So whichever side
   you switch to gets the GPU to itself and the other reloads lazily — the SA3
   model and the TTS/Whisper models can never coexist and OOM a clone/transcribe.
   In non-LOD a warm sidecar stays resident across consecutive plug-in jobs (fast
   iteration) and is only torn down when the worker next needs the GPU.

   **Orphan reaping.** A manager that's `SIGKILL`'d (e.g. `run_manager --forceup`)
   can't run its atexit shutdown, which would otherwise orphan sidecars that pin
   VRAM forever. On startup the host scans `/proc` and kills any leftover sidecar
   processes (matched by their exact entrypoint path) before spawning fresh ones.

2. **Low-VRAM passthrough.** When the host is in Low-VRAM mode, it sets
   `low_vram: true` in the payload of any plug-in that declares
   `"supports_low_vram": true`. The plug-in should then trade speed for footprint
   (e.g. CPU offload, smaller batch, sequential stages). Always implement
   `unload(ctx)` to drop weights and free the GPU when the host asks.

3. **Single instance, enforced by the host.** A plug-in only ever runs **one
   task at a time**: the host keeps one sidecar process per plug-in id and gates
   `invoke()` so a second concurrent command for the same plug-in is rejected
   up-front (`"… is already running a task"`) instead of spawning a rival process
   or silently queueing. `PluginHost.is_busy(id)` exposes the state. This is the
   master-level guarantee that two copies of a model can never load at once.

Be a good citizen: lazy-load in `load`/first use, and release in `unload`.

---

## Installation & isolation (`bootstrap.sh`)

A sidecar plug-in ships a bootstrap script that builds its `.venv` with `uv`. Two
things matter for isolation:

- Build the venv with `uv venv --no-config` and install with
  `uv pip install --no-config` so the plug-in does **not** inherit dependency
  pins from the repo's root `pyproject.toml` (this is what lets a plug-in pin a
  different torch than the host).
- Point the manifest's `python` at the resulting `.venv/bin/python`. The host
  launches the sidecar with that interpreter, never the host's.

The `.venv` is git-ignored — users (re)build it by running the bootstrap. Gated
model weights (HuggingFace license-accept required) are downloaded by the
bootstrap's optional model step, not committed.

**Cross-platform / NVIDIA ARM / macOS.** A bootstrap should branch on `uname -s`
and `uname -m` and pick a torch build that actually has wheels for that
OS/arch. The reference SA3 bootstrap does this: Linux x86_64 uses `torch==2.7.1`
(cu126) + a prebuilt flash-attn wheel, while Linux `aarch64` (Grace-Blackwell —
GB10 "DGX Spark"/EdgeXpert, GH200) uses `torch==2.10.0` (cu130), since torch
2.7.x ships no aarch64 CUDA wheels. When the plug-in's package hard-pins a torch
the target arch can't satisfy, install torch yourself first, then add the package
with `--no-deps` and provide its remaining (non-torch) deps — overriding the pin.
flash-attn has no aarch64 prebuilt, so SA3 falls back to torch SDPA there
(`SA3_BUILD_FLASH=1` opts into a source build). **macOS (Apple Silicon)** has no
CUDA: branch on `uname -s == Darwin`, install torch from the **default PyPI
index** (its Mac wheels are not on a CUDA index), skip flash-attn, and let the
model run on the **Metal (MPS)** backend. A plug-in that touches the GPU should
select its device as `cuda → mps → cpu`, run full precision off-CUDA (fp16 is
CUDA-only on a Mac), set `PYTORCH_ENABLE_MPS_FALLBACK=1` so unsupported ops fall
back to CPU instead of crashing, and free `torch.mps.empty_cache()` on unload —
all of which the reference SA3 sidecar does. Expect MVP-grade speed on MPS.

---

## Driving plug-ins over HTTP

| Method & Path | Purpose |
| --- | --- |
| `GET /api/plugins` | List installed/available plug-ins (public manifest + `installed` + `model_present`). |
| `GET /api/plugins/{id}` | One plug-in's manifest. |
| `POST /api/plugins/install` | Install from a git URL (`{git_url, name?, bootstrap?, force?}`) → job id (clone + bootstrap). |
| `POST /api/plugins/{id}/health` | Start (if needed) and ping the sidecar. |
| `POST /api/plugins/{id}/unload` | Stop the sidecar and free its resources. |
| `GET /api/plugins/{id}/help` | Serve the plug-in's bundled help page (`needs.help`, e.g. gated-model troubleshooting). |
| `POST /api/plugins/{id}/generate` | Generic audio-generator job (schema-driven, see below) → queued job. Optional `library: "voice" \| "sound"` picks the library for an eager `save=true`. |
| `POST /api/plugins/{id}/invoke` | Generic command invoke (`{cmd, payload}`) → queued job. |
| `POST /api/sounds/import-temp` | Save a generated preview (`{temp, path}`) into the **sound** library. |
| `POST /api/voices/import-temp` | Save a generated preview (`{temp, path}`) into the **voice** library (the deferred-save twin). |

Plug-in commands that do real work run as **async jobs**: the call returns a job
id, poll `GET /api/jobs/{job_id}` for progress/result (same as synthesis).

---

## Installing & distributing plug-ins

`plugins/` is a **drop-in directory**. The host discovers any subfolder with a
valid `plugin.json` — it doesn't care how the folder got there. Only the
host-provided SDK (`plugins/_sdk/`) and `plugins/README.md` are tracked in the
core repo; **installed plug-ins live in their own repos and stay untracked**
(along with the isolated `.venv` each builds). This keeps plug-in licenses (e.g.
a model under a vendor license) cleanly separate from the Apache-2.0 host.

Three equivalent ways to install:

```bash
# 1. From the app (clone + build the venv) — the primary method:
omnivoice-plugin install <git-url> [--name <folder>] [--no-bootstrap] [--force]
omnivoice-plugin list

# 2. From the running manager (returns a job id; poll /api/jobs/{id} for
#    clone + bootstrap progress, then it auto-re-discovers):
POST /api/plugins/install   { "git_url": "<git-url>", "bootstrap": true }

# 3. By hand / copy / platform installer:
cd plugins && git clone <git-url> <name> && cd <name> && ./bootstrap.sh
```

A correctly-shaped folder dropped in by any means (copy, Windows installer, …)
works the same. Declare `source` (the plug-in's repo) and `license` in the
manifest so the app can show provenance and the right license.

---

## Reference plug-in: Stable Audio 3

Stable Audio 3 (Stability AI's **Medium** model — text-to-audio foley / SFX /
music / instrument / one-shot) is maintained as a **standalone example plug-in**
in its own repo, and is the canonical worked example of everything above:

> **https://github.com/SanDiegoDude/omnivoice-manager-plugin-stable-audio-3**

Install it with `omnivoice-plugin install <that-url>`. It demonstrates isolation
(its own per-arch torch venv), GPU serialization + low-VRAM, reprompting via the
host LLM hook (the sidecar calls `reprompt` with its own category prompts),
declarative `ui.contributions` + `ui.lab` (the Sound Lab modal), and
sound-library + project-data integration — all with no edits to the host.

Generate (generic route — works for any audio-generator plug-in):

```jsonc
POST /api/plugins/stable-audio-3/generate
{
  "fields": {                  // the plug-in's own ui.lab schema payload
    "prompt": "heavy wooden door creaking open in a stone hall",
    "category": "SFX",         // Music | Instrument | SFX | One-shot
    "duration": 8.0,
    "steps": 8,
    "cfg": 1.0,
    "seed": null
  },
  "reprompt": true,            // sidecar rewrites via the host's Script-AI provider
  "save": false,               // false → temp preview; true → ingest immediately
  "save_path": null,           // library folder/name when save=true
  "session_id": "..."          // optional: tag the open project
}
```

The response job's `result` carries the final `prompt`, `raw_prompt`,
`reprompted`, the sample rate, an `audio_url`, and either a saved `sound`
descriptor (when `save=true`) or a `temp` handle to save later via
`POST /api/sounds/import-temp`.

See [the sound library](sound-library.md) for where generated foley lands and how
it drops onto the timeline.
