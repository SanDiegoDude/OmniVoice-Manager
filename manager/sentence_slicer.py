"""Sentence-level auto-slicing of multitrack segments.

Shared by the per-clip editor action (``/auto-slice``), the bulk "slice all
voice tracks" job, and the optional auto-slice-on-generate phase. Keeping it in
one place means all three paths detect sentence boundaries identically.

The model_manager is passed in (not imported) to avoid an import cycle:
``server`` and ``service`` both import this module, and this module only needs
``sessions`` plus whatever transcriber the caller hands it.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, List, Optional

from . import sessions

# A "sentence" run: text up to (and including) terminal punctuation + trailing
# quotes/brackets. Used to split the segment's own script into sentences.
_SENT_RE = re.compile(r"[^.!?…。！？]+(?:[.!?…。！？]+['\"”’\)\]]*)?\s*")
_TERM_RE = re.compile(r"[.!?…。！？]['\"”’\)\]]*\s*$")


def group_sentences(chunks: list, total_s: float) -> list:
    """Merge Whisper timestamped chunks into sentences by terminal punctuation.
    Each result has {text, start, end} in the same (audible) time domain."""
    sentences: list = []
    cur_text = ""
    cur_start = None
    cur_end = 0.0
    for c in chunks:
        t = c.get("text", "") or ""
        st = c.get("start")
        en = c.get("end")
        if cur_start is None:
            cur_start = float(st) if st is not None else cur_end
        cur_text += t
        if en is not None:
            cur_end = float(en)
        if _TERM_RE.search(t):
            sentences.append({"text": cur_text.strip(), "start": cur_start, "end": cur_end})
            cur_text = ""
            cur_start = None
    if cur_text.strip():
        sentences.append({"text": cur_text.strip(), "start": cur_start if cur_start is not None else cur_end, "end": total_s})
    return [s for s in sentences if s["text"]]


def sentences_from_source(chunks: list, source: str, total_s: float) -> Optional[list]:
    """Build auto-slice sentences from the segment's *own* script text, taking
    only the timing from Whisper's word stamps. Whisper occasionally decodes a
    whole 30s chunk lowercased with no punctuation, which both wrecked the
    dialogue text on sliced clips and collapsed sentence detection; the script
    that generated the audio is the better source of truth for the words.
    Returns None when the script can't be aligned (caller falls back to the
    raw Whisper sentences)."""
    import difflib

    src_sents = [m.group(0).strip() for m in _SENT_RE.finditer(source) if m.group(0).strip()]
    if len(src_sents) < 2:
        return None

    def norm(w: str) -> str:
        return re.sub(r"[^a-z0-9']+", "", w.lower())

    words = [c for c in chunks if (c.get("text") or "").strip()]
    if not words:
        return None
    src_words: list = []
    sent_of: list = []
    for si, s in enumerate(src_sents):
        for w in s.split():
            src_words.append(norm(w))
            sent_of.append(si)
    sm = difflib.SequenceMatcher(a=[norm(c["text"]) for c in words], b=src_words, autojunk=False)
    spans = [[None, None] for _ in src_sents]  # [start, end] audible seconds
    matched = 0
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            matched += 1
            si = sent_of[b + k]
            st, en = words[a + k].get("start"), words[a + k].get("end")
            if st is not None:
                spans[si][0] = st if spans[si][0] is None else min(spans[si][0], st)
            if en is not None:
                spans[si][1] = en if spans[si][1] is None else max(spans[si][1], en)
    if matched < max(2, len(src_words) // 2):
        return None  # script and audio genuinely disagree

    # Sentences whose words never matched carry no timing — fold their text
    # into a timed neighbour so no dialogue is dropped. auto_slice cuts each
    # slice at the previous slice's end, so only `end` has to be solid.
    out: list = []
    pending = ""
    for si, s in enumerate(src_sents):
        st, en = spans[si]
        text = f"{pending} {s}".strip()
        pending = ""
        if en is None or (out and en <= out[-1]["end"]):
            pending = text
            continue
        out.append({"text": text, "start": st if st is not None else (out[-1]["end"] if out else 0.0), "end": float(en)})
    if pending:
        if not out:
            return None
        out[-1]["text"] = f"{out[-1]['text']} {pending}".strip()
    if len(out) < 2:
        return None
    out[-1]["end"] = total_s
    return out


def _detect_sentences(model_manager, sid: str, index: int, *, keep_warm: bool) -> Optional[list]:
    """Transcribe a segment and return its detected sentences (>=2) or None.

    ``keep_warm`` holds the Whisper worker loaded after the call (bulk batches
    pass True and free it once at the end); a lone slice passes False so LOD
    frees the model as usual.
    """
    audio, sr, _name, _start = sessions.render_segment(sid, index)
    total_s = len(audio) / float(max(sr, 1))
    res = model_manager.transcribe(
        {"waveform": audio, "sample_rate": sr, "chunks": True},
        kill_after=False if keep_warm else None,
    )
    chunks = res.get("chunks") or []
    src_text = sessions.segment_text(sid, index)
    sentences = sentences_from_source(chunks, src_text, total_s) if src_text else None
    if sentences is None:
        sentences = group_sentences(chunks, total_s)
    return sentences if len(sentences) >= 2 else None


def slice_segment(model_manager, sid: str, index: int, *, keep_warm: bool = False) -> bool:
    """Sentence-slice a single segment in place. Returns True if it was split
    into >=2 clips, False if it couldn't be (single sentence / no words).
    Raises FileNotFoundError if the segment no longer exists."""
    sentences = _detect_sentences(model_manager, sid, index, keep_warm=keep_warm)
    if not sentences:
        return False
    try:
        sessions.auto_slice(sid, index, sentences)
        return True
    except ValueError:
        return False  # produced <2 usable clips after clamping


def slice_all_voice(
    model_manager,
    sid: str,
    progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Sentence-slice every generative (voice) segment in a session; uploaded
    audio channels are skipped. Whisper is held warm across the whole batch and
    freed once at the end under LOD, so a big scene loads the ASR model once
    instead of thrashing it per clip. Returns the updated public session."""
    indices: List[int] = sessions.voice_segment_indices(sid)
    total = len(indices)
    sliced = 0
    for i, idx in enumerate(indices):
        if progress_cb:
            progress_cb({
                "stage": "slicing",
                "message": f"Slicing by sentence… ({i + 1}/{total})",
                "current": i + 1,
                "total": total,
            })
        try:
            if slice_segment(model_manager, sid, idx, keep_warm=True):
                sliced += 1
        except FileNotFoundError:
            continue  # segment vanished (shouldn't happen mid-batch) — skip
    # Free the warm Whisper worker once the batch is done (no-op when not LOD).
    if getattr(model_manager, "settings", None) and model_manager.settings.load_on_demand:
        try:
            model_manager.unload()
        except Exception:
            pass
    out = sessions.get(sid)
    if out is not None:
        out["_bulk_sliced"] = sliced
    return out
