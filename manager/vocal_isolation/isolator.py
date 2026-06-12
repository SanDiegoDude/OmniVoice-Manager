"""Vocal isolation using Mel-Band-Roformer.

Extracts a clean vocal track from a reference sample (removing background music,
noise, room tone) so OmniVoice gets the cleanest possible voice prompt.

The checkpoint is auto-downloaded from HuggingFace (``KimberleyJSN/melbandroformer``)
into ``<repo>/models/vocal_isolation`` on first use. Override the location with the
``OMNIVOICE_MELBAND_CKPT`` environment variable.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Tuple, Union

import numpy as np
import torch
import torch.nn.functional as F

# ComfyUI-tested configuration for the vocal model.
MEL_BAND_ROFORMER_CONFIG = {
    "dim": 384,
    "depth": 6,
    "stereo": True,
    "num_stems": 1,
    "time_transformer_depth": 1,
    "freq_transformer_depth": 1,
    "num_bands": 60,
    "dim_head": 64,
    "heads": 8,
    "attn_dropout": 0,
    "ff_dropout": 0,
    "flash_attn": True,
    "dim_freqs_in": 1025,
    "sample_rate": 44100,
    "stft_n_fft": 2048,
    "stft_hop_length": 441,
    "stft_win_length": 2048,
    "stft_normalized": False,
    "mask_estimator_depth": 2,
    "multi_stft_resolution_loss_weight": 1.0,
    "multi_stft_resolutions_window_sizes": (4096, 2048, 1024, 512, 256),
    "multi_stft_hop_size": 147,
    "multi_stft_normalized": False,
}

# The dereverb checkpoint (anvuew) shares the EXACT same architecture/config as
# the vocal model — only the trained weights differ. Its single output stem is
# the dry "noreverb" signal, so the same isolate() machinery removes room reverb.
HUGGINGFACE_MODEL_ID = "KimberleyJSN/melbandroformer"
MODEL_FILENAME = "MelBandRoformer.ckpt"

DEREVERB_MODEL_ID = "anvuew/dereverb_mel_band_roformer"
DEREVERB_FILENAME = "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"

_REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_DIR = _REPO_ROOT / "models" / "vocal_isolation"


def _resolve_ckpt(repo_id: str, filename: str, env_var: str) -> str:
    override = os.getenv(env_var)
    if override and Path(override).exists():
        return override

    model_dir = Path(DEFAULT_MODEL_DIR)
    model_path = model_dir / filename
    if not model_path.exists():
        from huggingface_hub import hf_hub_download

        model_dir.mkdir(parents=True, exist_ok=True)
        return hf_hub_download(repo_id=repo_id, filename=filename, local_dir=str(model_dir))
    return str(model_path)


def get_model_path() -> str:
    """Vocal-isolation checkpoint (override via OMNIVOICE_MELBAND_CKPT)."""
    return _resolve_ckpt(HUGGINGFACE_MODEL_ID, MODEL_FILENAME, "OMNIVOICE_MELBAND_CKPT")


def get_dereverb_model_path() -> str:
    """Dereverb checkpoint (override via OMNIVOICE_DEREVERB_CKPT)."""
    return _resolve_ckpt(DEREVERB_MODEL_ID, DEREVERB_FILENAME, "OMNIVOICE_DEREVERB_CKPT")


def _windowing_array(window_size: int, fade_size: int, device: torch.device) -> torch.Tensor:
    fadein = torch.linspace(0, 1, fade_size)
    fadeout = torch.linspace(1, 0, fade_size)
    window = torch.ones(window_size)
    window[-fade_size:] *= fadeout
    window[:fade_size] *= fadein
    return window.to(device)


class VocalIsolator:
    """Loads the Mel-Band-Roformer vocal model and isolates vocals from audio."""

    def __init__(
        self,
        model_path: Optional[str] = None,
        device: Optional[str] = None,
        debug: bool = False,
        config: Optional[dict] = None,
    ):
        self.debug = debug
        self.model = None
        self.model_sample_rate = 44100
        self.chunk_size = 352800  # 8s @ 44.1kHz
        self.num_overlap = 2
        self.config = config or MEL_BAND_ROFORMER_CONFIG

        if device is None or str(device).strip().lower() == "auto":
            if torch.cuda.is_available():
                self.device = torch.device("cuda")
            elif torch.backends.mps.is_available():
                self.device = torch.device("mps")
            else:
                self.device = torch.device("cpu")
        else:
            self.device = torch.device(device)

        self.model_path = model_path or get_model_path()
        self._initialized = False

    @classmethod
    def dereverber(cls, device: Optional[str] = None, debug: bool = False) -> "VocalIsolator":
        """Construct an isolator that removes room reverb/echo (dry-signal stem)."""
        return cls(model_path=get_dereverb_model_path(), device=device, debug=debug)

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        from .mel_band_roformer import MelBandRoformer

        self.model = MelBandRoformer(**self.config).eval()
        checkpoint = torch.load(self.model_path, map_location="cpu", weights_only=False)
        if isinstance(checkpoint, dict):
            state_dict = checkpoint.get("state_dict", checkpoint.get("model", checkpoint))
        else:
            state_dict = checkpoint
        cleaned = {(k[7:] if k.startswith("module.") else k): v for k, v in state_dict.items()}
        self.model.load_state_dict(cleaned, strict=True)
        self.model = self.model.to(self.device)
        self.model.eval()
        self._initialized = True

    @torch.no_grad()
    def isolate(
        self,
        audio: Union[np.ndarray, torch.Tensor],
        sample_rate: int = 24000,
        return_instrumental: bool = False,
    ) -> Union[np.ndarray, Tuple[np.ndarray, np.ndarray]]:
        self._ensure_initialized()

        if isinstance(audio, torch.Tensor):
            audio = audio.cpu().numpy()
        audio = audio.astype(np.float32)

        original_mono = audio.ndim == 1
        original_length = audio.shape[-1]
        original_sample_rate = sample_rate

        if sample_rate != self.model_sample_rate:
            import librosa

            if original_mono:
                audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=self.model_sample_rate)
            else:
                audio = np.array(
                    [librosa.resample(ch, orig_sr=sample_rate, target_sr=self.model_sample_rate) for ch in audio]
                )

        if original_mono:
            audio = np.stack([audio, audio], axis=0)
        elif audio.shape[0] == 1:
            audio = np.concatenate([audio, audio], axis=0)

        original_for_instrumental = audio.copy()
        audio_tensor = torch.from_numpy(audio).to(self.device)
        vocals = self._process_chunked(audio_tensor).cpu().numpy()

        if original_sample_rate != self.model_sample_rate:
            import librosa

            vocals = np.array(
                [librosa.resample(ch, orig_sr=self.model_sample_rate, target_sr=original_sample_rate) for ch in vocals]
            )
            original_for_instrumental = np.array(
                [
                    librosa.resample(ch, orig_sr=self.model_sample_rate, target_sr=original_sample_rate)
                    for ch in original_for_instrumental
                ]
            )

        if original_mono:
            vocals = np.mean(vocals, axis=0)

        if vocals.shape[-1] > original_length:
            vocals = vocals[..., :original_length]
        elif vocals.shape[-1] < original_length:
            pad = original_length - vocals.shape[-1]
            vocals = np.pad(vocals, (0, pad) if original_mono else ((0, 0), (0, pad)))

        if return_instrumental:
            ref = np.mean(original_for_instrumental, axis=0) if original_mono else original_for_instrumental
            if ref.shape[-1] > original_length:
                ref = ref[..., :original_length]
            elif ref.shape[-1] < original_length:
                pad = original_length - ref.shape[-1]
                ref = np.pad(ref, (0, pad) if original_mono else ((0, 0), (0, pad)))
            return vocals.astype(np.float32), (ref - vocals).astype(np.float32)

        return vocals.astype(np.float32)

    def _process_chunked(self, audio: torch.Tensor) -> torch.Tensor:
        channels, audio_length = audio.shape
        C = self.chunk_size
        N = self.num_overlap
        step = C // N
        fade_size = C // 10
        border = C - step

        if audio_length > 2 * border and border > 0:
            audio = F.pad(audio.unsqueeze(0), (border, border), mode="reflect").squeeze(0)

        total_length = audio.shape[1]
        windowing_array = _windowing_array(C, fade_size, self.device)
        vocals = torch.zeros_like(audio, dtype=torch.float32)
        counter = torch.zeros_like(audio, dtype=torch.float32)

        for i in range(0, total_length, step):
            part = audio[:, i : i + C]
            length = part.shape[-1]
            if length < C:
                mode = "reflect" if length > C // 2 + 1 else "constant"
                part = F.pad(part.unsqueeze(0), (0, C - length), mode=mode).squeeze(0)

            x = self.model(part.unsqueeze(0))[0]

            window = windowing_array.clone()
            if i == 0:
                window[:fade_size] = 1
            elif i + C >= total_length:
                window[-fade_size:] = 1

            vocals[..., i : i + length] += x[..., :length] * window[..., :length]
            counter[..., i : i + length] += window[..., :length]

        estimated = vocals / counter.clamp(min=1e-8)
        if audio_length > 2 * border and border > 0:
            estimated = estimated[..., border:-border]
        return estimated

    def close(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None
            self._initialized = False
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            elif torch.backends.mps.is_available():
                try:
                    torch.mps.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
