"""Plug-in host wiring: the host call-back hooks and the Stable Audio 3 job.

Kept out of server.py so the route layer stays thin. Builds the dict of host
hooks a sidecar can call back into (``ctx.host_call(...)``), and assembles the
background job that runs an SA3 generation end-to-end: optional Script-AI
reprompt → sidecar generate → ingest into the sound library → tag the project.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import actionhist, samples, scripts_ai, service, sessions, voices
from .config import DATA_DIR, settings

TMP_DIR = DATA_DIR / "tmp"


def _resolve_reference_audio(handle: Optional[str]) -> Optional[str]:
    """Turn a reference-audio handle into a local file path for the sidecar.

    Accepted forms (the only things the client may send):
      * ``"sound:<sound_id>"`` — a sound already in the shared library.
      * ``"temp:<name>"``      — an upload staged under ``data/tmp`` via
        ``/api/plugins/ref-upload`` (name is a bare filename, no separators).

    Returns an absolute path string, or ``None`` if the handle is empty/invalid
    (a bad reference is treated as "no reference" rather than failing the job).
    """
    handle = (handle or "").strip()
    if not handle:
        return None
    kind, _, rest = handle.partition(":")
    rest = rest.strip()
    if not rest:
        return None
    if kind == "sound":
        try:
            return str(samples.resolve_sound_path(rest))
        except Exception:  # noqa: BLE001 — missing/invalid id → no reference
            return None
    if kind == "temp":
        if "/" in rest or "\\" in rest or ".." in rest:
            return None
        p = TMP_DIR / rest
        return str(p) if p.exists() else None
    return None


# ---------------------------------------------------------------------------
# Host hooks — the API a plug-in sidecar can call back into via host_call().
# Each is (plugin_id, params) -> json-serializable result. plugin_id is injected
# by the host so a plug-in can only ever scope its own data.
# ---------------------------------------------------------------------------
def build_host_hooks() -> Dict[str, Callable[[str, Dict[str, Any]], Any]]:
    def reprompt(plugin_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        text = scripts_ai.rewrite_prompt(
            params.get("system", ""),
            params.get("user", ""),
            temperature=float(params.get("temperature", 0.7)),
            max_tokens=int(params.get("max_tokens", 400)),
            provider_id=params.get("provider_id"),
        )
        return {"text": text}

    def save_sound(plugin_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        src = Path(params["audio_path"])
        rel = params.get("rel_path") or f"generated/{plugin_id}/sound"
        return samples.import_file(src, rel)

    def save_voice(plugin_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Ingest a WAV into the shared voice library — the voice-side twin of
        ``save_sound``. Preserves the file verbatim (native sample rate /
        channels), de-duping against existing voices like a manual import."""
        src = Path(params["audio_path"])
        rel = params.get("rel_path") or f"generated/{plugin_id}/voice"
        return voices.import_file(src, rel)

    def set_project_data(plugin_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        return sessions.set_plugin_data(
            params["session_id"], plugin_id, params.get("data"), bool(params.get("merge", True))
        )

    def get_project_data(plugin_id: str, params: Dict[str, Any]) -> Any:
        return sessions.get_plugin_data(params["session_id"], plugin_id)

    return {
        "reprompt": reprompt,
        "save_sound": save_sound,
        "save_voice": save_voice,
        "set_project_data": set_project_data,
        "get_project_data": get_project_data,
    }


# ---------------------------------------------------------------------------
# Generic plug-in "generate" job
#
# Any audio-generator plug-in shares this orchestration: invoke the sidecar's
# `generate` command with the UI's field payload (the host stays agnostic about
# what those fields mean), then ingest the result into the shared sound library
# (or stage a one-off preview), and tag the open project. Prompt rewriting lives
# inside the plug-in's sidecar (it calls the `reprompt` host hook with its own
# category prompts), so there is no plug-in-specific logic here.
# ---------------------------------------------------------------------------
def make_generate_job(
    plugin_host,
    plugin_id: str,
    fields: Dict[str, Any],
    *,
    reprompt: bool = False,
    provider_id: Optional[str] = None,
    save: bool = True,
    save_path: Optional[str] = None,
    session_id: Optional[str] = None,
    library: Optional[str] = None,
    reference_audio: Optional[str] = None,
) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    fields = {k: v for k, v in (fields or {}).items() if v is not None}
    raw_prompt = str(fields.get("prompt") or "").strip()

    # Resolve an optional reference-audio *handle* into a concrete local path the
    # sidecar can read, then hand it over in the field payload as
    # `reference_audio_path`. Handles are opaque ("sound:<id>" / "temp:<name>") so
    # the browser never sees or supplies a raw filesystem path.
    ref_path = _resolve_reference_audio(reference_audio)
    if ref_path:
        fields["reference_audio_path"] = ref_path
    # Which library a host-side save (save=True) lands in. Defaults to the sound
    # library to preserve the original foley behaviour; "voice" ingests into the
    # voice library instead. (Deferred saves from the Lab pick the library at
    # save time, so this only governs the eager save=True path.)
    library = (library or "sound").strip().lower()
    if library not in ("sound", "voice"):
        library = "sound"

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        # Run the isolated sidecar (GPU-serialized + reprompt handled in-sidecar).
        payload = {
            **fields,
            "reprompt": bool(reprompt),
            "provider_id": provider_id,
            "low_vram": settings.low_vram,
        }
        result = plugin_host.invoke(plugin_id, "generate", payload, progress_cb=progress_cb)

        audio_path = result.get("audio_path")
        out: Dict[str, Any] = {
            "plugin": plugin_id,
            "category": result.get("category") or fields.get("category"),
            "prompt": result.get("prompt") or raw_prompt,
            "raw_prompt": result.get("raw_prompt") or raw_prompt,
            "reprompted": bool(result.get("reprompted")),
            "duration_s": result.get("duration_s"),
            "sample_rate": result.get("sample_rate"),
        }

        # Echo the requested target so the Lab can default its save-to selector.
        out["library"] = library
        # Persist into the chosen library, or stage a one-off preview the caller
        # can audition and (optionally) save later via /api/{sounds,voices}/import-temp.
        if audio_path and save:
            rel = save_path or f"generated/{service.slugify(raw_prompt or plugin_id)}"
            if library == "voice":
                desc = voices.import_file(Path(audio_path), rel)
                out["voice"] = desc
                out["audio_url"] = f"/api/audio/voice/{desc['id']}"
            else:
                desc = samples.import_file(Path(audio_path), rel)
                out["sound"] = desc
                out["audio_url"] = f"/api/audio/sound/{desc['id']}"
        elif audio_path:
            TMP_DIR.mkdir(parents=True, exist_ok=True)
            name = f"_plugin_{uuid.uuid4().hex}.wav"
            shutil.copy2(audio_path, TMP_DIR / name)
            out["audio_url"] = f"/api/audio/temp/{name}"
            out["temp"] = name  # handle for a deferred save into either library

        # Tag the open project via the plug-in data hook (travels in the .omvp).
        if session_id:
            try:
                sessions.set_plugin_data(
                    session_id,
                    plugin_id,
                    {"last_generated": {
                        "prompt": out["prompt"],
                        "category": out.get("category"),
                        "library": out.get("library"),
                        "sound": out.get("sound"),
                        "voice": out.get("voice"),
                    }},
                    merge=True,
                )
            except Exception:  # noqa: BLE001
                pass

        return out

    return job


# ---------------------------------------------------------------------------
# Foley re-roll job — regenerate a placed clip in place via its origin plug-in
#
# A foley segment (kind="foley") remembers which plug-in made it and the fields
# used (in its segment meta). Re-rolling runs the same generator with the clip's
# *current* dialogue (prompt) and on-timeline length, then swaps the new take
# into the same segment slot — the multitrack twin of the Sound Lab's reroll.
# ---------------------------------------------------------------------------
def make_foley_regen_job(
    plugin_host,
    sid: str,
    index: int,
    plugin_id: str,
    fields: Dict[str, Any],
    *,
    reprompt: bool = False,
    provider_id: Optional[str] = None,
) -> Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]:
    fields = {k: v for k, v in (fields or {}).items() if v is not None}

    def job(progress_cb: Callable[[Dict[str, Any]], None]) -> Dict[str, Any]:
        payload = {
            **fields,
            "reprompt": bool(reprompt),
            "provider_id": provider_id,
            "low_vram": settings.low_vram,
        }
        result = plugin_host.invoke(plugin_id, "generate", payload, progress_cb=progress_cb)
        audio_path = result.get("audio_path")
        if not audio_path:
            raise RuntimeError(f"{plugin_id}: plug-in returned no audio to place.")
        session = sessions.replace_segment_audio(
            sid, index, audio_path,
            meta_patch={
                "plugin": plugin_id,
                "category": result.get("category") or fields.get("category"),
                "prompt": result.get("prompt") or fields.get("prompt"),
                "fields": fields,
                "reprompt": bool(reprompt),
                "provider_id": provider_id,
            },
        )
        actionhist.commit(sid, "Re-roll foley")
        return {"session": session, "session_id": sid, "regenerated_index": index}

    return job
