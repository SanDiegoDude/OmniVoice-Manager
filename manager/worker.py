"""GPU worker process.

All Torch/CUDA work (OmniVoice TTS + Mel-Band-Roformer isolation) happens here,
in a child process, so the FastAPI server process never touches CUDA. In
load-on-demand (LOD) mode the parent terminates this process after each job,
which forces the OS to reclaim all VRAM.

Communication is via two multiprocessing Queues. Messages are plain dicts; the
worker emits ("ready"|"progress"|"result"|"error", request_id, payload) tuples.
"""

from __future__ import annotations

import traceback
from typing import Any, Dict, List, Optional

import numpy as np


def _build_gen_kwargs(params: Dict[str, Any]) -> Dict[str, Any]:
    """Map UI/API params to OmniVoice generation-config kwargs."""
    keys = [
        "num_step",
        "guidance_scale",
        "t_shift",
        "denoise",
        "preprocess_prompt",
        "postprocess_output",
        "layer_penalty_factor",
        "position_temperature",
        "class_temperature",
        "audio_chunk_duration",
        "audio_chunk_threshold",
    ]
    return {k: params[k] for k in keys if k in params and params[k] is not None}


def gpu_worker(req_q, res_q, cfg: Dict[str, Any]) -> None:
    import os
    import sys

    # Ensure the repo root is importable in the spawned child.
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    # Die when the parent (server) dies — even on SIGKILL — so a hard-killed
    # server can never orphan this GPU worker and leak its CUDA context/VRAM.
    try:
        import ctypes
        import signal

        PR_SET_PDEATHSIG = 1
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
        if os.getppid() == 1:  # parent already gone during startup race
            os._exit(0)
    except Exception:  # noqa: BLE001
        pass

    import torch

    from omnivoice import OmniVoice

    _state: Dict[str, Any] = {"model": None, "isolator": None, "dereverber": None, "dfn": None}

    def get_model():
        if _state["model"] is None:
            dtype = torch.float16 if cfg.get("dtype", "float16") == "float16" else torch.float32
            res_q.put(("progress", None, {"stage": "loading_model", "message": "Loading OmniVoice model..."}))
            _state["model"] = OmniVoice.from_pretrained(
                cfg["model_id"],
                device_map=cfg["device"],
                dtype=dtype,
                load_asr=cfg.get("load_asr", True),
                asr_model_name=cfg.get("asr_model", "openai/whisper-large-v3-turbo"),
            )
        return _state["model"]

    def get_isolator():
        if _state["isolator"] is None:
            from manager.vocal_isolation import VocalIsolator

            device = cfg["device"] if str(cfg["device"]).startswith("cuda") else cfg["device"]
            _state["isolator"] = VocalIsolator(device=device, debug=cfg.get("debug", False))
        return _state["isolator"]

    def get_dereverber():
        if _state["dereverber"] is None:
            from manager.vocal_isolation import VocalIsolator

            device = cfg["device"] if str(cfg["device"]).startswith("cuda") else cfg["device"]
            _state["dereverber"] = VocalIsolator.dereverber(device=device, debug=cfg.get("debug", False))
        return _state["dereverber"]

    def get_dfn():
        if _state["dfn"] is None:
            from manager.vocal_isolation.dereverb_dfn import DeepFilterNetEnhancer

            _state["dfn"] = DeepFilterNetEnhancer(device=cfg["device"])
        return _state["dfn"]

    def apply_dereverb(wav: np.ndarray, sr: int, method: str) -> np.ndarray:
        if (method or "roformer").lower() == "deepfilternet":
            return get_dfn().process(wav, sample_rate=sr).astype(np.float32)
        return get_dereverber().isolate(wav, sample_rate=sr).astype(np.float32)

    def handle_dereverb(payload: Dict[str, Any]):
        wav = np.asarray(payload["waveform"], dtype=np.float32)
        sr = int(payload.get("sample_rate", 24000))
        method = payload.get("method", "roformer")
        out = apply_dereverb(wav, sr, method)
        return {"waveform": out.astype(np.float32), "sample_rate": sr}

    def handle_warmup(_payload):
        get_model()
        return {"loaded": True}

    def handle_transcribe(payload: Dict[str, Any], rid):
        """Whisper-transcribe an arbitrary clip (used to align a segment's text to
        its actual audio after trimming/splitting)."""
        wav = np.asarray(payload["waveform"], dtype=np.float32)
        sr = int(payload.get("sample_rate", 24000))
        model = get_model()

        want_chunks = bool(payload.get("chunks", False))

        def _run():
            if getattr(model, "_asr_pipe", None) is None:
                raise RuntimeError("ASR model is not loaded.")
            # Whisper's HF pipeline only accepts <=30s natively; longer clips (and
            # any timestamped request) need chunked long-form decoding.
            dur = len(wav) / float(max(sr, 1))
            if want_chunks or dur > 28.0:
                w = np.squeeze(wav)
                # Word-level stamps when chunks are requested (precise sentence
                # boundaries for auto-slice); segment-level is enough otherwise.
                res = model._asr_pipe(
                    {"array": w, "sampling_rate": int(sr)},
                    return_timestamps="word" if want_chunks else True,
                    chunk_length_s=30,
                    batch_size=4,
                )
                text = (res.get("text", "") if isinstance(res, dict) else "") or ""
                chunks = []
                if want_chunks and isinstance(res, dict):
                    for c in res.get("chunks", []) or []:
                        tstamp = c.get("timestamp") or (None, None)
                        chunks.append({"text": c.get("text", ""), "start": tstamp[0], "end": tstamp[1]})
                return text, chunks
            return model.transcribe((wav, sr)), []

        try:
            text, chunks = _run()
        except RuntimeError:
            res_q.put(("progress", rid, {"stage": "loading_asr", "message": "Loading Whisper..."}))
            model.load_asr_model(model_name=cfg.get("asr_model", "openai/whisper-large-v3-turbo"))
            text, chunks = _run()
        out: Dict[str, Any] = {"text": (text or "").strip()}
        if want_chunks:
            out["chunks"] = chunks
        return out

    def handle_isolate(payload: Dict[str, Any]):
        iso = get_isolator()
        wav = np.asarray(payload["waveform"], dtype=np.float32)
        sr = int(payload.get("sample_rate", 24000))
        vocals = iso.isolate(wav, sample_rate=sr)
        return {"waveform": vocals.astype(np.float32), "sample_rate": sr}

    def handle_generate(payload: Dict[str, Any], rid):
        speakers: Dict[str, Any] = payload["speakers"]
        lines: List[Dict[str, Any]] = payload["lines"]
        params: Dict[str, Any] = payload.get("params", {})
        low_vram = bool(payload.get("low_vram", False))
        multitrack = bool(payload.get("multitrack", False))

        from manager.audio_utils import match_loudness, normalize_rms, peak_limit

        REF_SR = 24000  # references arrive resampled to 24 kHz from the server

        # Phase 1 — clean each clone reference using ONLY the secondary models
        # (isolation / dereverb). In low-VRAM mode we free each secondary model
        # the instant it's done, so the big TTS model never shares the GPU with
        # them — capping the peak at max(one secondary model, TTS) instead of the
        # sum of all of them.
        cleaned: Dict[str, Any] = {}  # sid -> (wav, sample_rate, ref_text)
        for sid, spk in speakers.items():
            if spk.get("mode") != "clone" or spk.get("waveform") is None:
                continue
            wav = np.asarray(spk["waveform"], dtype=np.float32)
            spk_sr = int(spk.get("sample_rate", REF_SR))
            if spk.get("isolate"):
                res_q.put(("progress", rid, {"stage": "isolating", "speaker": sid}))
                wav = get_isolator().isolate(wav, sample_rate=spk_sr).astype(np.float32)
                if low_vram:
                    _free("isolator")
            if spk.get("dereverb"):
                method = spk.get("dereverb_method", "roformer")
                res_q.put(("progress", rid, {"stage": "dereverb", "speaker": sid, "method": method}))
                wav = apply_dereverb(wav, spk_sr, method)
                if low_vram:
                    _free("dereverber", "dfn")
            if spk.get("normalize"):
                # Active-frame leveling (not whole-signal RMS): quiet references
                # don't just clone quietly — decode scales output to the ref's
                # RMS, so an under-leveled ref drags every render down with it.
                from manager.perform import normalize_active

                wav = normalize_active(wav, spk_sr)
            cleaned[sid] = (wav, spk_sr, spk.get("ref_text") or None)

        # Make sure no secondary model is resident before the TTS model loads.
        if low_vram:
            _free("isolator", "dereverber", "dfn")

        # Phase 2 — load the TTS model, build the reusable clone prompts, then
        # synthesize line by line.
        model = get_model()
        sr = model.sampling_rate
        gen_kwargs = _build_gen_kwargs(params)
        gap_ms = int(payload.get("gap_ms", 250))
        gap = np.zeros(int(sr * gap_ms / 1000.0), dtype=np.float32)

        clone_prompts: Dict[str, Any] = {}
        for sid, (wav, spk_sr, ref_text) in cleaned.items():
            clone_prompts[sid] = model.create_voice_clone_prompt(
                ref_audio=(wav, spk_sr),
                ref_text=ref_text,
                preprocess_prompt=bool(params.get("preprocess_prompt", True)),
            )

        speech: List[np.ndarray] = []
        segments_out: List[Dict[str, Any]] = []
        total = len(lines)
        for idx, line in enumerate(lines):
            sid = str(line["speaker_id"])
            text = line["text"].strip()
            if not text:
                continue
            spk = speakers.get(sid, {})
            mode = spk.get("mode", "auto")
            language = spk.get("language") or None

            kw: Dict[str, Any] = dict(text=text, language=language, **gen_kwargs)
            if params.get("speed") and float(params["speed"]) != 1.0:
                kw["speed"] = float(params["speed"])
            if params.get("duration") and float(params["duration"]) > 0:
                kw["duration"] = float(params["duration"])

            if mode == "clone" and sid in clone_prompts:
                kw["voice_clone_prompt"] = clone_prompts[sid]
            elif mode == "design" and spk.get("instruct"):
                kw["instruct"] = spk["instruct"].strip()
            # auto: no voice prompt

            perf = line.get("perform")
            if perf is not None:
                # V2V performance transfer: seed the token grid from the user's
                # recorded take and re-voice it with this speaker's clone prompt.
                from manager.perform import perform_transfer

                vc = clone_prompts.get(sid)
                if vc is None:
                    raise RuntimeError(
                        "Performance transfer needs a voice reference on this channel "
                        "(clone voice, promoted track, or Vocal Inpaint lock)."
                    )
                res_q.put(
                    ("progress", rid, {"stage": "performing", "line": idx + 1, "total": total, "text": text[:80]})
                )
                audio = perform_transfer(
                    model,
                    text=text,
                    vc_prompt=vc,
                    perf_wav=np.asarray(perf["waveform"], dtype=np.float32),
                    perf_sr=int(perf.get("sample_rate", REF_SR)),
                    mode=str(perf.get("mode", "character")),
                    strength=int(perf.get("strength", 3)),
                    seed=perf.get("seed"),
                    language=language,
                    gen_params=params,
                ).astype(np.float32)
                speech.append(audio)
                segments_out.append(
                    {"index": int(line.get("index", idx)), "speaker_id": sid, "text": text, "waveform": audio}
                )
                continue

            res_q.put(
                ("progress", rid, {"stage": "generating", "line": idx + 1, "total": total, "text": text[:80]})
            )
            audio = model.generate(**kw)[0].astype(np.float32)
            speech.append(audio)
            segments_out.append(
                {"index": int(line.get("index", idx)), "speaker_id": sid, "text": text, "waveform": audio}
            )

        if not speech:
            raise ValueError("No non-empty lines to generate.")

        # Multitrack: hand back RAW per-segment audio (plus the cleaned reference
        # for each clone speaker so single-segment regen is fast + consistent).
        # The server owns stitching/loudness so a regenerated take re-levels
        # against the whole conversation.
        if multitrack:
            refs_out = {sid: wav for sid, (wav, _spk_sr, _rt) in cleaned.items()}
            return {"segments": segments_out, "refs": refs_out, "sample_rate": sr}

        # Perceptual loudness leveling (LUFS): match every utterance to a common
        # target so quiet/loud speakers sit at the same perceived volume. This is
        # the fix for multi-voice level mismatch that RMS normalization can't do.
        if params.get("match_loudness", True):
            target_lufs = float(params.get("target_lufs", -20.0))
            res_q.put(("progress", rid, {"stage": "leveling", "total": total}))
            speech = match_loudness(speech, sr, target_lufs=target_lufs)

        # Interleave the inter-line gap, concatenate, then a single true-peak
        # limiter on the whole mix prevents the leveled peaks from clipping.
        chunks: List[np.ndarray] = []
        for i, seg in enumerate(speech):
            chunks.append(seg)
            if i < len(speech) - 1 and gap.size:
                chunks.append(gap)
        full = np.concatenate(chunks).astype(np.float32)

        if params.get("match_loudness", True):
            full = peak_limit(full, ceiling_db=float(params.get("peak_ceiling_db", -1.0)))

        return {"waveform": full, "sample_rate": sr}

    def _free(*keys: str) -> None:
        """Close the named secondary models and reclaim their VRAM immediately."""
        try:
            for key in keys:
                if _state.get(key) is not None:
                    try:
                        _state[key].close()
                    except Exception:  # noqa: BLE001
                        pass
                    _state[key] = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass

    def free_secondary() -> None:
        """Release all secondary models (isolation / dereverb) + CUDA cache after
        a job. The OmniVoice TTS model itself stays loaded (it is the primary
        model, freed only on shutdown or in LOD mode)."""
        _free("isolator", "dereverber", "dfn")

    handlers = {
        "warmup": lambda p, rid: handle_warmup(p),
        "isolate": lambda p, rid: handle_isolate(p),
        "dereverb": lambda p, rid: handle_dereverb(p),
        "transcribe": handle_transcribe,
        "generate": handle_generate,
    }

    res_q.put(("ready", None, {}))

    while True:
        msg = req_q.get()
        cmd = msg.get("cmd")
        rid = msg.get("rid")
        if cmd == "shutdown":
            break
        if cmd == "ping":
            res_q.put(("result", rid, {"ok": True}))
            continue
        handler = handlers.get(cmd)
        if handler is None:
            res_q.put(("error", rid, f"Unknown command: {cmd}"))
            continue
        try:
            result = handler(msg.get("payload", {}), rid)
            res_q.put(("result", rid, result))
        except Exception as e:  # noqa: BLE001
            res_q.put(("error", rid, f"{type(e).__name__}: {e}\n{traceback.format_exc()}"))
        finally:
            free_secondary()

    # Cleanup on shutdown.
    try:
        for key in ("isolator", "dereverber", "dfn"):
            if _state.get(key) is not None:
                try:
                    _state[key].close()
                except Exception:  # noqa: BLE001
                    pass
        _state["model"] = None
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass
