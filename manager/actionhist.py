"""Action history: a real multi-step undo/redo stack per project.

This is the "Action history" pillar of the History/Outputs column. It replaces
the old single-step ``<sid>__undo`` stash with a bounded ring of labeled
snapshots that supports redo and survives reloads.

Storage (under ``output/sessions/<sid>__hist/``):
    blobs/<sha1>     content-addressed copies of the media pool (seg_*/ref_*/
                     perform_*/inpaint_*/… — everything but the regenerable mix)
    index.json       { "cursor": int, "steps": [ {id,label,ts,files,manifest} ] }

Because every snapshot's manifest is tiny JSON and the big WAVs are
content-addressed, repeated takes / undo snapshots dedupe instead of
duplicating audio: a step that only tweaks a trim number adds ~nothing on disk.

A step's ``manifest`` is the full ``session.json`` dict at that moment and
``files`` maps each media filename to the hash of its bytes. Restoring a step
rewrites the manifest and copies the referenced blobs back to their filenames;
the caller then re-stitches the mix.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from .sessions import SESSIONS_DIR

MAX_STEPS = 50
_lock = threading.RLock()


def _sess_dir(sid: str) -> Path:
    return SESSIONS_DIR / sid


def _hist_dir(sid: str) -> Path:
    return SESSIONS_DIR / f"{sid}__hist"


def _blobs_dir(sid: str) -> Path:
    return _hist_dir(sid) / "blobs"


def _index_path(sid: str) -> Path:
    return _hist_dir(sid) / "index.json"


def _read_index(sid: str) -> Dict[str, Any]:
    p = _index_path(sid)
    if not p.exists():
        return {"cursor": -1, "steps": []}
    try:
        data = json.loads(p.read_text())
        data.setdefault("cursor", len(data.get("steps", [])) - 1)
        data.setdefault("steps", [])
        return data
    except (json.JSONDecodeError, OSError):
        return {"cursor": -1, "steps": []}


def _write_index(sid: str, index: Dict[str, Any]) -> None:
    _hist_dir(sid).mkdir(parents=True, exist_ok=True)
    p = _index_path(sid)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False))
    tmp.replace(p)


def _media_files(sid: str, manifest: Dict[str, Any]) -> List[Path]:
    """Every file in the session dir that belongs to the media pool — i.e. all
    on-disk files except the manifest and the regenerable mix."""
    d = _sess_dir(sid)
    if not d.is_dir():
        return []
    mix = manifest.get("mix_file", "mix.wav")
    skip = {"session.json", "session.json.tmp", mix}
    return [f for f in d.iterdir() if f.is_file() and f.name not in skip]


def _hash_file(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _capture(sid: str) -> Optional[Dict[str, Any]]:
    """Snapshot the current on-disk state into a step dict, copying any new
    media bytes into the content-addressed blob store. Returns None if the
    session has no manifest (nothing to snapshot)."""
    d = _sess_dir(sid)
    manifest_path = d / "session.json"
    if not manifest_path.exists():
        return None
    try:
        manifest = json.loads(manifest_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    blobs = _blobs_dir(sid)
    blobs.mkdir(parents=True, exist_ok=True)
    files: Dict[str, str] = {}
    for f in _media_files(sid, manifest):
        digest = _hash_file(f)
        files[f.name] = digest
        dest = blobs / digest
        if not dest.exists():
            shutil.copy2(f, dest)
    return {
        "id": uuid.uuid4().hex[:12],
        "label": "",
        "ts": time.time(),
        "files": files,
        "manifest": manifest,
    }


def _gc_blobs(sid: str, index: Dict[str, Any]) -> None:
    """Delete content blobs no longer referenced by any retained step."""
    referenced = {h for step in index["steps"] for h in step.get("files", {}).values()}
    blobs = _blobs_dir(sid)
    if not blobs.is_dir():
        return
    for b in blobs.iterdir():
        if b.is_file() and b.name not in referenced:
            b.unlink(missing_ok=True)


def ensure_baseline(sid: str, label: str = "Opened") -> None:
    """Capture the current state as the history's root step if the stack is
    empty. This is the pre-first-action state every later undo can return to."""
    with _lock:
        index = _read_index(sid)
        if index["steps"]:
            return
        step = _capture(sid)
        if step is None:
            return
        step["label"] = label
        index["steps"] = [step]
        index["cursor"] = 0
        _write_index(sid, index)


def commit(sid: str, label: str) -> None:
    """Record the current (post-action) state as a new step. Drops any redo
    branch ahead of the cursor, enforces the bounded ring, and GCs orphans."""
    with _lock:
        index = _read_index(sid)
        # If nothing captured a baseline yet (e.g. a brand-new scene's first
        # edit), seed one from the current state so this step has an ancestor.
        if not index["steps"]:
            base = _capture(sid)
            if base is None:
                return
            base["label"] = "Initial"
            index["steps"] = [base]
            index["cursor"] = 0
        step = _capture(sid)
        if step is None:
            return
        step["label"] = label
        cursor = index["cursor"]
        # Truncate the redo branch (everything after the current position).
        index["steps"] = index["steps"][: cursor + 1]
        index["steps"].append(step)
        # Enforce the bounded ring, dropping the oldest steps.
        if len(index["steps"]) > MAX_STEPS:
            index["steps"] = index["steps"][-MAX_STEPS:]
        index["cursor"] = len(index["steps"]) - 1
        _gc_blobs(sid, index)
        _write_index(sid, index)


def _restore(sid: str, step: Dict[str, Any]) -> None:
    """Rewrite the session dir to match a captured step: restore tracked media
    from blobs and write the manifest. The mix is left for the caller to rebuild."""
    d = _sess_dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    manifest = step["manifest"]
    want = step.get("files", {})
    # Remove media files that aren't part of this step (regenerated takes, etc.).
    for f in _media_files(sid, manifest):
        if f.name not in want:
            f.unlink(missing_ok=True)
    blobs = _blobs_dir(sid)
    for name, digest in want.items():
        src = blobs / digest
        if src.exists():
            shutil.copy2(src, d / name)
    tmp = (d / "session.json").with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    tmp.replace(d / "session.json")


def undo(sid: str) -> bool:
    """Step one state back. Returns False if there's nothing to undo."""
    with _lock:
        index = _read_index(sid)
        if index["cursor"] <= 0:
            return False
        index["cursor"] -= 1
        _restore(sid, index["steps"][index["cursor"]])
        _write_index(sid, index)
        return True


def redo(sid: str) -> bool:
    """Step one state forward. Returns False if there's nothing to redo."""
    with _lock:
        index = _read_index(sid)
        if index["cursor"] >= len(index["steps"]) - 1:
            return False
        index["cursor"] += 1
        _restore(sid, index["steps"][index["cursor"]])
        _write_index(sid, index)
        return True


def can_undo(sid: str) -> bool:
    index = _read_index(sid)
    return index["cursor"] > 0


def can_redo(sid: str) -> bool:
    index = _read_index(sid)
    return index["cursor"] < len(index["steps"]) - 1


def state(sid: str) -> Dict[str, Any]:
    """The action-history view for the column: labeled steps + the cursor."""
    index = _read_index(sid)
    steps = [
        {"id": s["id"], "label": s.get("label") or "Edit", "ts": s.get("ts"), "index": i}
        for i, s in enumerate(index["steps"])
    ]
    return {
        "steps": steps,
        "cursor": index["cursor"],
        "can_undo": index["cursor"] > 0,
        "can_redo": index["cursor"] < len(index["steps"]) - 1,
    }


def jump(sid: str, target: int) -> bool:
    """Restore an arbitrary step by index (navigable history). No-op if the
    target is the current cursor or out of range."""
    with _lock:
        index = _read_index(sid)
        if target < 0 or target >= len(index["steps"]) or target == index["cursor"]:
            return False
        index["cursor"] = target
        _restore(sid, index["steps"][target])
        _write_index(sid, index)
        return True


def discard(sid: str) -> None:
    shutil.rmtree(_hist_dir(sid), ignore_errors=True)
