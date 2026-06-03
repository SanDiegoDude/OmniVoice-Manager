"""DeepFilterNet-based reference cleanup (lightweight denoise + mild dereverb).

DeepFilterNet v3 is a tiny (~2M param) real-time speech enhancer. It is far
lighter than the Mel-Band-Roformer dereverb model and excels at noise + light
room reverb, though for heavy echo the Roformer technique is stronger.

The `deepfilternet` package is an optional dependency; import is lazy so the
rest of the manager runs without it installed.
"""

from __future__ import annotations

from typing import Optional

import numpy as np


class DeepFilterNetEnhancer:
    """Lazy wrapper around DeepFilterNet (operates at 48 kHz internally)."""

    def __init__(self, device: Optional[str] = None):
        self._model = None
        self._df_state = None
        self._sr = 48000
        self._device = device

    def _ensure_initialized(self) -> None:
        if self._model is not None:
            return
        try:
            from df.enhance import init_df
        except ImportError as e:  # noqa: BLE001
            raise RuntimeError(
                "DeepFilterNet is not installed. Run `uv pip install deepfilternet` "
                "or pick the 'roformer' dereverb technique instead."
            ) from e
        self._model, self._df_state, _ = init_df()
        self._sr = self._df_state.sr()

    def process(self, audio: np.ndarray, sample_rate: int = 24000) -> np.ndarray:
        import librosa
        import torch
        from df.enhance import enhance

        self._ensure_initialized()
        wav = np.asarray(audio, dtype=np.float32)
        if wav.ndim > 1:
            wav = wav.mean(axis=0)
        if sample_rate != self._sr:
            wav = librosa.resample(wav, orig_sr=sample_rate, target_sr=self._sr)

        tensor = torch.from_numpy(wav).unsqueeze(0)  # (1, T) mono
        out = enhance(self._model, self._df_state, tensor)
        out = out.squeeze(0).cpu().numpy().astype(np.float32)

        if sample_rate != self._sr:
            out = librosa.resample(out, orig_sr=self._sr, target_sr=sample_rate)
        return out.astype(np.float32)

    def close(self) -> None:
        self._model = None
        self._df_state = None
