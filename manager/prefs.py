"""Persistent user/machine preferences for the OmniVoice Manager.

A single namespaced JSON document (`data/prefs.json`) that survives restarts and
is shared across browsers — the place for anything we don't want users to
reconfigure every session: VRAM/output settings, the ADR track template, and
(eventually) per-plugin configuration under the reserved ``plugins`` namespace.

Design goals:
- **Extensible**: arbitrary nested namespaces; callers deep-merge partial dicts
  rather than rewriting the whole document, so new sections never clobber old.
- **Robust**: atomic writes (tmp + replace), corrupt/missing file degrades to
  defaults instead of crashing, unknown keys are preserved on round-trip.
- **One source of truth**: the in-memory `Settings` singleton mirrors the
  persisted values for the hot path; this module owns durability.
"""

from __future__ import annotations

import copy
import json
import threading
from typing import Any, Dict

from .config import DATA_DIR

_PREFS_FILE = DATA_DIR / "prefs.json"
_lock = threading.Lock()

# Default document. Every namespace a feature persists into should be declared
# here so a fresh install has a complete, well-typed shape. Plugins get a
# reserved bag they can namespace freely under their own id.
DEFAULTS: Dict[str, Any] = {
    "version": 1,
    "system": {
        "load_on_demand": False,
        "low_vram": False,
        "trim_silence": False,
    },
    "output": {
        # "mp3" (compact, shareable) or "flac" (lossless, pro-audio).
        "format": "mp3",
        "bitrate": "192k",
    },
    "tracks": {
        # ADR Studio track-1 template. New tracks inherit these processing
        # settings (voice/ref text are intentionally per-track, not stored).
        "template": None,
    },
    "ui": {},
    "plugins": {},
}


def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively merge ``patch`` into ``base`` (mutates + returns ``base``).

    Dicts merge key-by-key; everything else (including lists and ``None``)
    replaces wholesale.
    """
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def load() -> Dict[str, Any]:
    """Return the full prefs document, defaults filled in for missing keys."""
    doc = copy.deepcopy(DEFAULTS)
    try:
        if _PREFS_FILE.exists():
            stored = json.loads(_PREFS_FILE.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                _deep_merge(doc, stored)
    except Exception:
        # Corrupt or unreadable prefs should never block startup.
        pass
    return doc


def _write(doc: Dict[str, Any]) -> None:
    tmp = _PREFS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_PREFS_FILE)


def update(patch: Dict[str, Any]) -> Dict[str, Any]:
    """Deep-merge ``patch`` into the stored document and persist it.

    Returns the resulting full document. Safe for concurrent callers.
    """
    with _lock:
        doc = load()
        _deep_merge(doc, patch)
        _write(doc)
        return doc


def get(namespace: str, key: str, default: Any = None) -> Any:
    """Convenience read of ``doc[namespace][key]`` with a fallback."""
    section = load().get(namespace)
    if isinstance(section, dict):
        return section.get(key, default)
    return default
