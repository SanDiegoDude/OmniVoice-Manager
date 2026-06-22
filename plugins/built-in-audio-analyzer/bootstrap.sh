#!/usr/bin/env bash
# Build the isolated Audio Analyzer sidecar environment + fetch the PANNs model.
# Universal: Linux (x86_64 / aarch64) and macOS (Apple Silicon). Windows -> bootstrap.bat.
#
#   1. uv venv (.venv)  -> plugin.json points `python` at .venv/bin/python
#   2. CPU PyTorch (from the official CPU index, so we never pull a multi-GB CUDA
#      build for what is a CPU service), then librosa + pyloudnorm + soundfile +
#      panns-inference.
#   3. download the CNN14 AudioSet checkpoint -> models/
# Re-runnable / idempotent. Pure CPU — this is a built-in *service* plug-in.
#
# Overrides (env): UV=<path-to-uv>  PYVER=<3.11>  TORCH_CPU_INDEX=<url>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"
MODELS="$HERE/models"
PYVER="${PYVER:-3.11}"
TORCH_CPU_INDEX="${TORCH_CPU_INDEX:-https://download.pytorch.org/whl/cpu}"
CKPT_URL="https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1"
CKPT="$MODELS/Cnn14_mAP=0.431.pth"

log()  { printf '\n\033[1;36m[audio-analyzer-bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[audio-analyzer-bootstrap]\033[0m %s\n' "$*"; }

OS="$(uname -s)"; ARCH="$(uname -m)"
log "Target: $OS/$ARCH — librosa + pyloudnorm + PANNs (CPU PyTorch). Universal."

UV="${UV:-uv}"
command -v "$UV" >/dev/null 2>&1 || { warn "uv not found on PATH (set UV=/path/to/uv)."; exit 1; }

# ── venv ──────────────────────────────────────────────────────────────────────
if [[ ! -x "$VENV/bin/python" ]]; then
  log "Creating venv ($PYVER) -> $VENV"
  "$UV" venv --python "$PYVER" "$VENV"
fi
PY="$VENV/bin/python"

# ── CPU PyTorch first (own index → no CUDA), then the rest ────────────────────
log "Installing CPU PyTorch (from $TORCH_CPU_INDEX)…"
VIRTUAL_ENV="$VENV" "$UV" pip install --python "$PY" --index-url "$TORCH_CPU_INDEX" "torch"

log "Installing librosa + pyloudnorm + soundfile + panns-inference…"
VIRTUAL_ENV="$VENV" "$UV" pip install --python "$PY" \
  "numpy<2" "librosa>=0.10" "soundfile>=0.12" "pyloudnorm>=0.1.1" "panns-inference>=0.1.1"

# ── model (CNN14 AudioSet checkpoint, ~315 MB) ────────────────────────────────
mkdir -p "$MODELS"
if [[ -s "$CKPT" ]]; then
  log "have $(basename "$CKPT")"
else
  log "fetch $(basename "$CKPT") (~315 MB)…"
  curl -fL --retry 3 -o "$CKPT" "$CKPT_URL" || { warn "checkpoint download failed — DSP still works; learned tags disabled until present."; rm -f "$CKPT"; }
fi

# ── smoke check ───────────────────────────────────────────────────────────────
log "Verifying imports…"
"$PY" - <<'PY'
import numpy, librosa, pyloudnorm
msg = f"librosa {librosa.__version__}, numpy {numpy.__version__}"
try:
    import torch, panns_inference  # noqa
    msg += f", torch {torch.__version__}, panns ok"
except Exception as e:
    msg += f"; PANNs unavailable ({type(e).__name__}: {e}) — DSP-only tags"
print(msg)
PY

log "Done. Audio Analyzer ready (built-in universal CPU service plug-in)."
