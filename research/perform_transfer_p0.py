#!/usr/bin/env python3
"""P0 feasibility: performance transfer via masked-diffusion partial seeding.

OmniVoice is a MaskGIT-style masked-token model over an (8 codebooks x T) grid.
Training masked tokens randomly across BOTH time and codebook layers, so a
partially observed grid is in-distribution — but the public generate() API only
ever starts from all-MASK. This script seeds the grid from a real human
performance and regenerates the rest conditioned on a TARGET voice:

  Path A (layer surgery):  keep coarse codebook layer(s) — content/prosody/
      timing — mask the fine layers, regenerate them in the target timbre.
      Output is frame-aligned with the source take (exact same duration).
  Path B (variation strength): keep a random fraction of ALL tokens
      (SDEdit-for-speech). mask_ratio is the strength knob.
  Baseline: all-MASK = plain TTS of the same text in the target voice
      (what regen does today — model invents the performance).

No model fork: the inference loop refuses to overwrite non-MASK tokens
(scores.masked_fill_(tokens != MASK, -inf)), so pre-seeding Just Works. We only
re-derive the unmask schedule from the ACTUAL masked count.

Usage:
  .venv/bin/python research/perform_transfer_p0.py \
      --source examples/box-of-chocolates.wav \
      --target custom_voices/television-shows/Futurama/cust-Zapp-Brannigan-Futurama.wav \
      --max-seconds 12

Outputs land in research/out/p0/ (gitignored — derived from local-only media).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from omnivoice import OmniVoice  # noqa: E402
from omnivoice.models.omnivoice import (  # noqa: E402
    OmniVoiceGenerationConfig,
    _get_time_steps,
    _gumbel_sample,
)

SR = 24000
HOP = 960  # tokenizer hop at 24 kHz -> 25 tokens/sec


def load_mono_24k(path: str) -> np.ndarray:
    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if sr != SR:
        import librosa

        wav = librosa.resample(wav, orig_sr=sr, target_sr=SR)
    return np.ascontiguousarray(wav, dtype=np.float32)


def word_bounded_slice(model: OmniVoice, wav: np.ndarray, max_s: float) -> tuple:
    """Transcribe with word timestamps and cut a window anchored at the FIRST
    spoken word (scenes often open with music/ambience), ending at the last word
    that fits within max_s of speech. Returns (sliced_wav, text, duration_s)."""
    res = model._asr_pipe(
        {"array": wav, "sampling_rate": SR},
        return_timestamps="word",
        chunk_length_s=30,
        batch_size=4,
    )
    words = []
    for c in res.get("chunks", []) or []:
        ts = c.get("timestamp") or (None, None)
        if ts[0] is None or ts[1] is None:
            continue
        s, e = float(ts[0]), float(ts[1])
        # Chunked Whisper sometimes smears a word across music/ambience —
        # drop implausible word durations so the anchor lands on real speech.
        if not (0.0 < e - s <= 3.0):
            continue
        words.append((c.get("text", ""), s, e))
    if not words:
        raise RuntimeError("Whisper produced no word timestamps on the source")
    print(f"  speech onset at {words[0][1]:.2f}s, {len(words)} plausible words")
    anchor = max(0.0, words[0][1] - 0.15)  # small lead-in pad before first word
    take, end = [], anchor
    for t, _s, e in words:
        if e - anchor > max_s:
            break
        take.append(t)
        end = e
    if not take:
        raise RuntimeError("No words fit the requested window")
    text = "".join(take).strip()
    a = int(anchor * SR)
    b = int(min(end + 0.1, len(wav) / SR) * SR)  # short tail pad
    n = (b - a) - ((b - a) % HOP)
    return wav[a : a + n].copy(), text, n / SR


def normalize_active(wav: np.ndarray, sr: int = SR, target_rms: float = 0.1) -> np.ndarray:
    """Scale so the RMS of ACTIVE (non-silent) frames hits target_rms. Movie
    dialogue is mixed quiet; seeding the grid with near-silence tokens makes the
    model render near-silence, so level the source before tokenizing."""
    n = int(sr * 0.05)
    k = len(wav) // n
    if k == 0:
        return wav
    frames = wav[: k * n].reshape(k, n)
    rms = np.sqrt((frames**2).mean(axis=1))
    gate = max(rms.max() * 0.1, 1e-5)
    active = rms[rms > gate]
    if len(active) == 0:
        return wav
    gain = target_rms / float(np.sqrt((active**2).mean()))
    return np.clip(wav * gain, -1.0, 1.0).astype(np.float32)


@torch.inference_mode()
def encode_tokens(model: OmniVoice, wav: np.ndarray) -> torch.Tensor:
    """Waveform -> (C, T) audio tokens via the model's own tokenizer."""
    n = len(wav) - (len(wav) % HOP)
    t = torch.from_numpy(wav[:n]).unsqueeze(0).unsqueeze(0).to(model.audio_tokenizer.device)
    return model.audio_tokenizer.encode(t).audio_codes.squeeze(0).long()


@torch.inference_mode()
def generate_seeded(
    model: OmniVoice,
    text: str,
    vc_prompt,
    seed_tokens: torch.Tensor,  # (C, T) source-performance tokens
    keep_mask: torch.Tensor,  # (C, T) bool — True = pin from source
    cfg: OmniVoiceGenerationConfig,
    language: str = "en",
) -> torch.Tensor:
    """generate() with a pre-seeded target grid. Mirrors _generate_iterative
    (B=1 + CFG pair) but only schedules the ACTUALLY-masked tokens."""
    dev = model.device
    C = model.config.num_audio_codebook
    MASK = model.config.audio_mask_id
    T = int(seed_tokens.shape[1])

    inputs = model._prepare_inference_inputs(
        text=text,
        num_target_tokens=T,
        ref_text=vc_prompt.ref_text,
        ref_audio_tokens=vc_prompt.ref_audio_tokens,
        lang=language,
        instruct=None,
        denoise=cfg.denoise,
    )
    input_ids = inputs["input_ids"].to(dev)  # (1, C, L)
    audio_mask = inputs["audio_mask"].to(dev)  # (1, L)
    c_len = input_ids.size(2)
    u_len = T

    seed = seed_tokens.to(dev)
    keep = keep_mask.to(dev)
    tokens = torch.where(keep, seed, torch.full_like(seed, MASK)).unsqueeze(0)  # (1,C,T)

    # cond row 0 / uncond row 1 (uncond = target region only, like upstream)
    bi = torch.full((2, C, c_len), MASK, dtype=torch.long, device=dev)
    bm = torch.zeros((2, c_len), dtype=torch.bool, device=dev)
    ba = torch.zeros((2, 1, c_len, c_len), dtype=torch.bool, device=dev)
    bi[0] = input_ids[0]
    bm[0] = audio_mask[0]
    ba[0] = True
    bi[1, :, :u_len] = input_ids[0, :, -u_len:]
    bm[1, :u_len] = audio_mask[0, -u_len:]
    ba[1, :, :u_len, :u_len] = True
    if c_len > u_len:
        diag = torch.arange(u_len, c_len, device=dev)
        ba[1, :, diag, diag] = True

    # Write the seeded grid into both branches before the first step.
    bi[0, :, c_len - T : c_len] = tokens[0]
    bi[1, :, :T] = tokens[0]

    # Unmask schedule over the REAL masked count (upstream assumes T*C masked).
    total_mask = int((tokens[0] == MASK).sum().item())
    if total_mask == 0:
        return tokens[0]
    ts = _get_time_steps(0.0, 1.0, cfg.num_step, cfg.t_shift).tolist()
    sched, rem = [], total_mask
    for step in range(cfg.num_step):
        num = rem if step == cfg.num_step - 1 else min(
            math.ceil(total_mask * (ts[step + 1] - ts[step])), rem
        )
        sched.append(int(num))
        rem -= int(num)

    layer_ids = torch.arange(C, device=dev).view(1, -1, 1)
    for step in range(cfg.num_step):
        k = sched[step]
        if k <= 0:
            continue
        logits = model(input_ids=bi, audio_mask=bm, attention_mask=ba).logits.to(torch.float32)
        c_logits = logits[0:1, :, c_len - T : c_len, :]
        u_logits = logits[1:2, :, :T, :]
        pred, scores = model._predict_tokens_with_scoring(c_logits, u_logits, cfg)
        scores = scores - (layer_ids * cfg.layer_penalty_factor)
        if cfg.position_temperature > 0.0:
            scores = _gumbel_sample(scores, cfg.position_temperature)
        sample = tokens[0:1]
        scores.masked_fill_(sample != MASK, -float("inf"))
        _, topk = torch.topk(scores.flatten(), k)
        flat = sample.flatten()
        flat[topk] = pred.flatten()[topk]
        sample.copy_(flat.view_as(sample))
        bi[0:1, :, c_len - T : c_len] = sample
        bi[1:2, :, :T] = sample
    return tokens[0]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, help="Acted source performance (any sr)")
    ap.add_argument("--target", required=True, help="Target voice reference wav")
    ap.add_argument("--model", default="k2-fsa/OmniVoice")
    ap.add_argument("--max-seconds", type=float, default=12.0)
    ap.add_argument("--num-step", type=int, default=32)
    ap.add_argument("--guidance-scale", type=float, default=2.0)
    ap.add_argument("--out", default=str(REPO / "research" / "out" / "p0"))
    ap.add_argument("--seed", type=int, default=1234)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(args.seed)

    t0 = time.time()
    print(f"[{time.time()-t0:6.1f}s] loading OmniVoice ({args.model}) ...")
    model = OmniVoice.from_pretrained(
        args.model, device_map="cuda", dtype=torch.float16, load_asr=True
    )
    C = model.config.num_audio_codebook

    print(f"[{time.time()-t0:6.1f}s] loading + slicing source ...")
    full = load_mono_24k(args.source)
    raw, text, end_s = word_bounded_slice(model, full, args.max_seconds)
    print(f"  slice: {end_s:.2f}s ({len(raw)} samples, {len(raw)//HOP} tokens)")
    print(f"  transcript: {len(text)} chars (kept in manifest only)")

    print(f"[{time.time()-t0:6.1f}s] isolating vocals (source cleanup) ...")
    from manager.vocal_isolation import VocalIsolator

    iso = VocalIsolator(device="cuda")
    isolated = iso.isolate(raw, sample_rate=SR).astype(np.float32)
    n = min(len(raw), len(isolated)) // HOP * HOP
    raw, isolated = raw[:n], isolated[:n]
    del iso
    torch.cuda.empty_cache()

    raw = normalize_active(raw)
    isolated = normalize_active(isolated)
    sf.write(out / "source_raw.wav", raw, SR)
    sf.write(out / "source_isolated.wav", isolated, SR)

    print(f"[{time.time()-t0:6.1f}s] building target clone prompt ...")
    vc = model.create_voice_clone_prompt(ref_audio=args.target, ref_text=None)

    print(f"[{time.time()-t0:6.1f}s] tokenizing source takes ...")
    tok_raw = encode_tokens(model, raw)
    tok_iso = encode_tokens(model, isolated)
    T = int(tok_iso.shape[1])
    print(f"  token grid: ({C}, {T})")

    cfg = OmniVoiceGenerationConfig(
        num_step=args.num_step,
        guidance_scale=args.guidance_scale,
        postprocess_output=False,  # keep exact length/timing
    )

    g = torch.Generator().manual_seed(args.seed)

    def keep_layers(layers: list) -> torch.Tensor:
        m = torch.zeros(C, T, dtype=torch.bool)
        for layer in layers:
            m[layer] = True
        return m

    def keep_random(frac: float) -> torch.Tensor:
        return torch.rand(C, T, generator=g) < frac

    runs = [
        # (name, seed_tokens, keep_mask)
        ("baseline_tts", tok_iso, torch.zeros(C, T, dtype=torch.bool)),
        ("A_keep0_iso", tok_iso, keep_layers([0])),
        ("A_keep01_iso", tok_iso, keep_layers([0, 1])),
        ("B_keep10_iso", tok_iso, keep_random(0.10)),
        ("B_keep30_iso", tok_iso, keep_random(0.30)),
        ("B_keep50_iso", tok_iso, keep_random(0.50)),
        ("A_keep0_raw", tok_raw, keep_layers([0])),
        ("B_keep30_raw", tok_raw, keep_random(0.30)),
    ]

    manifest = {
        "source": args.source,
        "target": args.target,
        "slice_seconds": end_s,
        "text": text,
        "tokens": [C, T],
        "num_step": args.num_step,
        "guidance_scale": args.guidance_scale,
        "seed": args.seed,
        "runs": [],
    }

    for name, seed_tok, keep in runs:
        kept = int(keep.sum().item())
        print(
            f"[{time.time()-t0:6.1f}s] {name}: kept {kept}/{C*T} tokens "
            f"({100.0*kept/(C*T):.0f}%) ..."
        )
        tk = generate_seeded(model, text, vc, seed_tok, keep, cfg)
        with torch.inference_mode():
            audio = model._decode_and_post_process(tk, vc.ref_rms, cfg)
        sf.write(out / f"{name}.wav", audio, SR)
        manifest["runs"].append({"name": name, "kept_tokens": kept, "out": f"{name}.wav"})

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"[{time.time()-t0:6.1f}s] done -> {out}")


if __name__ == "__main__":
    main()
