# 🔊 Sound library (foley / SFX)

The sound library is the non-vocal counterpart to the [voice library](voice-clone.md):
a browseable, folder-tree, content-addressed store for **foley and sound effects**
— footsteps, doors, ambience, stingers, one-shots, music beds — that you drop
onto audio channels in the [multitrack timeline](adr-studio.md).

It sits in the left sidebar under the voice library, and is where
[Stable Audio 3](plugins.md#reference-plug-in-stable-audio-3) generations land.

## What's different from voices

Voices are normalized to 24 kHz mono because they feed the clone pipeline. Sound
effects are **preserved verbatim** — native sample rate and channels (stereo
stays stereo) — because they're played back, not cloned. Uploads and generated
audio are imported byte-for-byte; nothing is downmixed or resampled.

Sounds are **content-addressed**: importing the same audio twice de-dupes instead
of duplicating the file (the descriptor comes back with `"deduped": true`).

## On disk

Files live under `custom_sounds/` (git-ignored, same as `custom_voices/`),
organized into any folder tree you like. A sound's `id` is its path relative to
that root; its display `name` is the path without extension.

```jsonc
// a sound descriptor
{
  "id": "doors/stone-door-creak.wav",
  "name": "doors/stone-door-creak",
  "folder": "doors",
  "filename": "stone-door-creak.wav"
}
```

## Using it

- **Browse / search / organize** — folder tree with create-folder, move, rename,
  delete, and audio preview, mirroring the voice library.
- **Edit (🎚)** — the per-row edit button opens the shared Sample editor: stack
  vocal & audio transforms (echo, reverb, muffle, pitch…), preview, then **save a
  copy** or **overwrite in place** (edit-opens default to overwrite-on). Transforms
  render via the 24k-mono engine — ideal for SFX/foley. Same editor backs the
  voice library. Route: `POST /api/sounds/transform` (`{id, transforms, overwrite,
  save_as}`); voices reuse `POST /api/voices/process` with a `transforms` field.
- **Drop onto a project** — with a project open, the library's add-to-project
  action fetches the sample and adds it as a new **audio channel** on the
  timeline (reusing the existing upload-channel path). No project open → you're
  prompted to create one first.
- **Generate foley** — the **Generate Foley — Stable Audio 3** button opens the
  generation modal; saved results appear here automatically.

## HTTP API

| Method & Path | Purpose |
| --- | --- |
| `GET /api/sounds` | `{tree, flat, folders}` for the whole library |
| `POST /api/sounds/folder` | Create a folder (`{folder}`) |
| `POST /api/sounds/move` | Move a sound to a folder (`{id, folder}`) |
| `POST /api/sounds/rename` | Rename a sound (`{id, name}`) |
| `POST /api/sounds/transform` | Bake transforms onto a sound, save copy/overwrite (`{id, transforms, overwrite, save_as}`) |
| `DELETE /api/sounds/{id}` | Delete a sound |
| `POST /api/sounds/upload` | Import an audio file (multipart `file`, optional `folder`) — verbatim, no resample |
| `GET /api/audio/sound/{id}` | Serve a sound file for preview / download |

Plug-ins write into the same library via the `save_sound` host hook — see
[external plug-ins](plugins.md#host-hooks-the-api-available-to-plug-ins).
