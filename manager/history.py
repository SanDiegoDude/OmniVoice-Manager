"""Persistent prompt / script / generation history (JSON on disk)."""

from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

from .config import HISTORY_DIR

_HISTORY_FILE = HISTORY_DIR / "history.json"
_lock = threading.Lock()


def _read() -> List[Dict[str, Any]]:
    if not _HISTORY_FILE.exists():
        return []
    try:
        return json.loads(_HISTORY_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def _write(entries: List[Dict[str, Any]]) -> None:
    tmp = _HISTORY_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(entries, indent=2, ensure_ascii=False))
    tmp.replace(_HISTORY_FILE)


def add_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        entries = _read()
        entry = {
            "id": uuid.uuid4().hex,
            "timestamp": time.time(),
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
            **entry,
        }
        entries.insert(0, entry)
        # Keep the most recent 500 entries.
        del entries[500:]
        _write(entries)
        return entry


def list_entries(kind: Optional[str] = None, limit: int = 200) -> List[Dict[str, Any]]:
    entries = _read()
    if kind:
        entries = [e for e in entries if e.get("type") == kind]
    return entries[:limit]


def get_entry(entry_id: str) -> Optional[Dict[str, Any]]:
    for e in _read():
        if e.get("id") == entry_id:
            return e
    return None


def delete_entry(entry_id: str) -> bool:
    with _lock:
        entries = _read()
        new = [e for e in entries if e.get("id") != entry_id]
        if len(new) == len(entries):
            return False
        _write(new)
        return True


def clear(kind: Optional[str] = None) -> None:
    with _lock:
        if kind is None:
            _write([])
        else:
            _write([e for e in _read() if e.get("type") != kind])
