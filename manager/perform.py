"""Performance transfer (V2V): paint a cloned voice over a human performance.

OmniVoice is a masked-diffusion token model over an (8 codebooks x T) grid and
its inference loop never overwrites non-MASK tokens — so we can seed the grid
from a real recorded performance and regenerate the rest conditioned on a
target voice-clone prompt. Two ears-validated modes (research/):

  character: pin codebook layer 0 (timing/prosody skeleton), then RELEASE the
      pins partway through the unmask schedule. The earlier the release, the
      more the target's own mannerisms take over the read.
  voice:     pin layer 0 at a token stride, never release. Denser pins stick
      tighter to the source actor's exact delivery; sparser pins let the
      target timbre interpolate between anchors.

Strength is a 1..5 UI weight:
  character: 1 -> release@0.80 (barely teases from source) ... 5 -> release@0.10
  voice:     1 -> stride 1 (full pin)                     ... 5 -> stride 6
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

import numpy as np
import torch

# UI weight (1..5) -> knob value, calibrated by ear (see ROADMAP P1-P3 notes).
CHARACTER_RELEASE = {1: 0.80, 2: 0.60, 3: 0.40, 4: 0.25, 5: 0.10}
VOICE_STRIDE = {1: 1, 2: 2, 3: 3, 4: 4, 5: 6}


def normalize_active(wav: np.ndarray, sr: int, target_rms: float = 0.1) -> np.ndarray:
    """Scale so the RMS of ACTIVE (non-silent) frames hits target_rms. Quiet
    sources seed near-silence tokens and the model faithfully renders near-
    silence — level the performance before tokenizing."""
    n = int(sr * 0.05)
    k = len(wav) // n
    if k == 0:
        return wav
    frames = wav[: k * n].reshape(k, n)
    rms = np.sqrt((frames**2).mean(axis=1))
    gate = max(float(rms.max()) * 0.1, 1e-5)
    active = rms[rms > gate]
    if len(active) == 0:
        return wav
    gain = target_rms / float(np.sqrt((active**2).mean()))
    return np.clip(wav * gain, -1.0, 1.0).astype(np.float32)


def build_keep_mask(C: int, T: int, mode: str, strength: int) -> Tuple[torch.Tensor, Optional[float]]:
    """(keep_mask, release_at) for a UI mode + 1..5 strength weight."""
    s = max(1, min(5, int(strength)))
    keep = torch.zeros(C, T, dtype=torch.bool)
    if mode == "voice":
        keep[0, :: VOICE_STRIDE[s]] = True
        return keep, None
    keep[0] = True
    return keep, CHARACTER_RELEASE[s]


@torch.inference_mode()
def _encode_tokens(model, wav: np.ndarray, hop: int) -> torch.Tensor:
    n = len(wav) - (len(wav) % hop)
    t = torch.from_numpy(wav[:n]).unsqueeze(0).unsqueeze(0).to(model.audio_tokenizer.device)
    return model.audio_tokenizer.encode(t).audio_codes.squeeze(0).long()


@torch.inference_mode()
def _generate_seeded(
    model,
    text: str,
    vc_prompt,
    seed_tokens: torch.Tensor,
    keep_mask: torch.Tensor,
    cfg,
    language: Optional[str],
    release_at: Optional[float],
) -> torch.Tensor:
    """Mirror of OmniVoice._generate_iterative (B=1 + CFG pair) with a
    pre-seeded target grid; only the actually-masked tokens are scheduled."""
    from omnivoice.models.omnivoice import _get_time_steps, _gumbel_sample

    dev = model.device
    C = model.config.num_audio_codebook
    MASK = model.config.audio_mask_id
    T = int(seed_tokens.shape[1])

    inputs = model._prepare_inference_inputs(
        text=text,
        num_target_tokens=T,
        ref_text=vc_prompt.ref_text,
        ref_audio_tokens=vc_prompt.ref_audio_tokens,
        lang=language or "en",
        instruct=None,
        denoise=cfg.denoise,
    )
    input_ids = inputs["input_ids"].to(dev)
    audio_mask = inputs["audio_mask"].to(dev)
    c_len = input_ids.size(2)
    u_len = T

    seed = seed_tokens.to(dev)
    keep = keep_mask.to(dev)
    tokens = torch.where(keep, seed, torch.full_like(seed, MASK)).unsqueeze(0)

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

    bi[0, :, c_len - T : c_len] = tokens[0]
    bi[1, :, :T] = tokens[0]

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

    release_step = None
    if release_at is not None and 0.0 <= release_at < 1.0:
        release_step = max(1, min(cfg.num_step - 1, int(round(cfg.num_step * release_at))))

    layer_ids = torch.arange(C, device=dev).view(1, -1, 1)
    for step in range(cfg.num_step):
        if release_step is not None and step == release_step:
            sample = tokens[0:1]
            rel = keep.unsqueeze(0)
            extra = int(rel.sum().item())
            if extra > 0:
                sample.masked_fill_(rel, MASK)
                bi[0:1, :, c_len - T : c_len] = sample
                bi[1:2, :, :T] = sample
                rem_steps = cfg.num_step - step
                for j in range(step, cfg.num_step):
                    sched[j] += extra // rem_steps
                sched[cfg.num_step - 1] += extra % rem_steps
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


def perform_transfer(
    model,
    *,
    text: str,
    vc_prompt,
    perf_wav: np.ndarray,
    perf_sr: int,
    mode: str = "character",
    strength: int = 3,
    seed: Optional[int] = None,
    language: Optional[str] = None,
    gen_params: Optional[Dict[str, Any]] = None,
) -> np.ndarray:
    """Render `text` in the vc_prompt voice, riding the recorded performance.
    Output duration == performance duration (timing transfers exactly)."""
    from omnivoice.models.omnivoice import OmniVoiceGenerationConfig

    sr = int(model.sampling_rate)
    wav = np.asarray(perf_wav, dtype=np.float32)
    if wav.ndim > 1:
        wav = wav.mean(axis=0 if wav.shape[0] < wav.shape[-1] else -1)
    if int(perf_sr) != sr:
        import librosa

        wav = librosa.resample(wav, orig_sr=int(perf_sr), target_sr=sr).astype(np.float32)
    wav = normalize_active(wav, sr)

    hop = sr // 25  # tokenizer frame rate is 25 tokens/sec
    tokens = _encode_tokens(model, wav, hop)
    C, T = int(tokens.shape[0]), int(tokens.shape[1])
    keep, release_at = build_keep_mask(C, T, mode, strength)

    p = gen_params or {}
    cfg = OmniVoiceGenerationConfig(
        num_step=int(p.get("num_step", 32) or 32),
        guidance_scale=float(p.get("guidance_scale", 2.0) or 2.0),
        postprocess_output=False,  # never trim/fade — timing is the product
    )
    if p.get("t_shift") is not None:
        cfg.t_shift = float(p["t_shift"])

    if seed is not None:
        torch.manual_seed(int(seed) % (2**31))

    tk = _generate_seeded(model, text, vc_prompt, tokens, keep, cfg, language, release_at)
    with torch.inference_mode():
        audio = model._decode_and_post_process(tk, vc_prompt.ref_rms, cfg)
    return np.asarray(audio, dtype=np.float32)
