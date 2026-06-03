"""Pure-text helpers: parse multi-speaker scripts into ordered lines."""

from __future__ import annotations

import re
from typing import Dict, List

_SPEAKER_RE = re.compile(r"^\s*speaker\s*(\d+)\s*[:\-]\s*(.*)$", re.IGNORECASE)


def parse_script(script: str, num_speakers: int = 1) -> List[Dict[str, object]]:
    """Parse a script into ``[{"speaker_id": int, "text": str}, ...]``.

    Recognizes ``Speaker N:`` prefixes. Lines without a prefix are appended to
    the current speaker. If the script has no prefixes at all, the whole text is
    assigned to speaker 1 (single-speaker) or rotated across speakers per line.
    """
    script = (script or "").strip()
    if not script:
        return []

    raw_lines = [ln for ln in script.splitlines()]
    has_prefix = any(_SPEAKER_RE.match(ln) for ln in raw_lines)

    lines: List[Dict[str, object]] = []

    if not has_prefix:
        if num_speakers <= 1:
            return [{"speaker_id": 1, "text": script}]
        # Rotate non-prefixed lines across speakers.
        i = 0
        for ln in raw_lines:
            ln = ln.strip()
            if not ln:
                continue
            lines.append({"speaker_id": (i % num_speakers) + 1, "text": ln})
            i += 1
        return lines

    current = 1
    for ln in raw_lines:
        m = _SPEAKER_RE.match(ln)
        if m:
            sid = int(m.group(1))
            sid = max(1, sid)
            if num_speakers >= 1:
                # Clamp to the available number of speakers.
                sid = ((sid - 1) % num_speakers) + 1
            current = sid
            text = m.group(2).strip()
            if text:
                lines.append({"speaker_id": current, "text": text})
        else:
            stripped = ln.strip()
            if not stripped:
                continue
            if lines and lines[-1]["speaker_id"] == current:
                lines[-1]["text"] = f"{lines[-1]['text']} {stripped}".strip()
            else:
                lines.append({"speaker_id": current, "text": stripped})

    return lines


def speaker_labels(num_speakers: int) -> List[str]:
    return [f"Speaker {i + 1}" for i in range(num_speakers)]
