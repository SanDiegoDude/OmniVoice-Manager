"""Library metadata store — the data layer that lets analysis travel with a
sample instead of living inside whatever plug-in produced it.

Both libraries (``sound`` and ``voice``) are filesystem-first: a sample *is* a
file at a relative path, with no database behind it. This module adds a small
side-store so we can attach:

* **analysis** — a *core-owned, fixed* schema (bpm / key / loudness / instruments
  / genre / mood / structure …) filled by an analyzer provider (e.g. the Essentia
  service plug-in), plus an open ``extra`` bag for provider-specific extras, and
* **manual** — a freeform, user-edited bag (voice actor, character, tags, notes…).

Records are keyed by **content hash**, not path, so metadata survives renames,
moves, and files copied straight into the library dir (the routes that would
break a path-keyed index). A small ``(size, mtime) → hash`` cache keeps us from
re-hashing unchanged files on every read. The store lives under ``data/`` (never
inside the library dirs, so it never pollutes the file scan).

Core owns the schema; providers only *fill* it — keeping consumers (ACE-Step,
search, the UI) bound to stable fields regardless of which analyzer ran.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import DATA_DIR

_META_DIR = DATA_DIR / "library_meta"
_LIBRARIES = ("sound", "voice")

# Core-owned analysis schema. Providers fill what they can; missing → None/[]. An
# open ``extra`` bag carries anything off-schedule without a schema bump.
_ANALYSIS_FIELDS: Dict[str, Any] = {
    "bpm": None,
    "key": None,
    "loudness_lufs": None,
    "duration_s": None,
    "instruments": list,
    "genre": list,
    "mood": list,
    "danceability": None,
    "voice_instrumental": None,  # "vocal" | "instrumental" | None
}

_lock = threading.RLock()
_cache: Dict[str, Dict[str, Any]] = {}  # library -> loaded store (lazy)


def _store_path(library: str) -> Path:
    return _META_DIR / f"{library}.json"


def _empty_store() -> Dict[str, Any]:
    # records: hash -> record ; paths: rel_path -> {size, mtime, hash}
    return {"version": 1, "records": {}, "paths": {}}


def _load(library: str) -> Dict[str, Any]:
    if library not in _LIBRARIES:
        raise ValueError(f"Unknown library: {library!r}")
    with _lock:
        cached = _cache.get(library)
        if cached is not None:
            return cached
        p = _store_path(library)
        data = _empty_store()
        if p.exists():
            try:
                loaded = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data["records"] = loaded.get("records") or {}
                    data["paths"] = loaded.get("paths") or {}
            except (json.JSONDecodeError, OSError):
                pass  # corrupt/missing → start clean rather than crash
        _cache[library] = data
        return data


def _save(library: str, data: Dict[str, Any]) -> None:
    _META_DIR.mkdir(parents=True, exist_ok=True)
    p = _store_path(library)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)  # atomic on POSIX/Windows


def content_hash(abspath: Path) -> str:
    h = hashlib.sha1()
    with open(abspath, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def hash_for(library: str, abspath: Path, rel: str) -> Optional[str]:
    """Content hash for ``rel``, using the (size, mtime) cache to skip rehashing
    unchanged files. Returns None if the file is missing."""
    try:
        st = abspath.stat()
    except OSError:
        return None
    sig = {"size": st.st_size, "mtime": int(st.st_mtime)}
    with _lock:
        data = _load(library)
        cached = data["paths"].get(rel)
        if cached and cached.get("size") == sig["size"] and cached.get("mtime") == sig["mtime"]:
            h = cached.get("hash")
            if h:
                return h
        try:
            h = content_hash(abspath)
        except OSError:
            return None
        data["paths"][rel] = {**sig, "hash": h}
        _save(library, data)
        return h


def _blank_record(rel: str, name: str) -> Dict[str, Any]:
    return {
        "analysis": None,
        "analyzer": None,
        "analyzed_at": None,
        "manual": {},
        "path": rel,
        "name": name,
        "updated_at": None,
    }


def _public(record: Optional[Dict[str, Any]], rel: str, name: str) -> Dict[str, Any]:
    if record is None:
        return _blank_record(rel, name)
    # Keep stored path/name fresh so the UI shows the current location.
    return {**record, "path": rel, "name": name}


def get(library: str, abspath: Path, rel: str, name: str = "") -> Dict[str, Any]:
    """Full metadata record for a sample (analysis + manual). Returns a blank
    skeleton when nothing is stored yet."""
    h = hash_for(library, abspath, rel)
    if not h:
        return _blank_record(rel, name)
    with _lock:
        data = _load(library)
        return _public(data["records"].get(h), rel, name)


def has_analysis(library: str, abspath: Path, rel: str) -> bool:
    h = hash_for(library, abspath, rel)
    if not h:
        return False
    with _lock:
        rec = _load(library)["records"].get(h)
        return bool(rec and rec.get("analysis"))


def _normalize_analysis(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce a provider's payload onto the core schema (+ extra bag)."""
    raw = raw or {}
    out: Dict[str, Any] = {}
    for field, default in _ANALYSIS_FIELDS.items():
        val = raw.get(field)
        if default is list:
            if isinstance(val, str):
                val = [val]
            out[field] = [str(x) for x in val] if isinstance(val, (list, tuple)) else []
        else:
            out[field] = val
    known = set(_ANALYSIS_FIELDS)
    extra = {k: v for k, v in raw.items() if k not in known and k != "extra"}
    if isinstance(raw.get("extra"), dict):
        extra.update(raw["extra"])
    out["extra"] = extra
    return out


def set_analysis(
    library: str,
    abspath: Path,
    rel: str,
    name: str,
    analysis: Dict[str, Any],
    analyzer: str = "",
) -> Dict[str, Any]:
    h = hash_for(library, abspath, rel)
    if not h:
        raise FileNotFoundError(f"Sample not found for analysis: {rel}")
    with _lock:
        data = _load(library)
        rec = data["records"].get(h) or _blank_record(rel, name)
        rec["analysis"] = _normalize_analysis(analysis)
        rec["analyzer"] = analyzer or rec.get("analyzer")
        rec["analyzed_at"] = time.time()
        rec["updated_at"] = time.time()
        rec["path"] = rel
        rec["name"] = name or rec.get("name") or rel
        data["records"][h] = rec
        _save(library, data)
        return _public(rec, rel, name)


def set_manual(
    library: str, abspath: Path, rel: str, name: str, fields: Dict[str, Any]
) -> Dict[str, Any]:
    """Merge user-edited manual fields onto the record. ``None`` values delete a
    key so the editor can clear a field."""
    h = hash_for(library, abspath, rel)
    if not h:
        raise FileNotFoundError(f"Sample not found: {rel}")
    with _lock:
        data = _load(library)
        rec = data["records"].get(h) or _blank_record(rel, name)
        manual = dict(rec.get("manual") or {})
        for k, v in (fields or {}).items():
            if v is None:
                manual.pop(k, None)
            else:
                manual[k] = v
        rec["manual"] = manual
        rec["updated_at"] = time.time()
        rec["path"] = rel
        rec["name"] = name or rec.get("name") or rel
        data["records"][h] = rec
        _save(library, data)
        return _public(rec, rel, name)


def forget_path(library: str, rel: str) -> None:
    """Drop the path→hash cache entry for a deleted/renamed sample. The record
    itself is content-keyed and kept (re-attaches if the content reappears)."""
    with _lock:
        data = _load(library)
        if data["paths"].pop(rel, None) is not None:
            _save(library, data)


def reprice_move(library: str, old_rel: str, new_rel: str) -> None:
    """Keep the path cache consistent across an in-app move/rename (content is
    unchanged, so the hash carries over)."""
    with _lock:
        data = _load(library)
        entry = data["paths"].pop(old_rel, None)
        if entry is not None:
            data["paths"][new_rel] = entry
            _save(library, data)
