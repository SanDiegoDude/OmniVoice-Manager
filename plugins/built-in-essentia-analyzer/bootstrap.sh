#!/usr/bin/env bash
# Build the isolated Essentia analyzer sidecar environment + fetch its models.
# Linux (x86_64 / aarch64) and macOS (Apple Silicon). Windows → bootstrap.bat.
#
#   1. uv venv (.venv)  → plugin.json points `python` at .venv/bin/python
#   2. audio analysis deps — prefer `essentia-tensorflow` (DSP *and* the ML
#      taggers); fall back to plain `essentia` (DSP-only) where TF wheels don't
#      exist (commonly Linux aarch64 / macOS arm64).
#   3. if TF is available → download Discogs-EffNet + MTG-Jamendo heads → models/
# Re-runnable / idempotent. Pure CPU — this is a built-in *service* plug-in.
#
# The sidecar degrades gracefully: with plain essentia it still reports BPM / key /
# loudness / duration, just no genre / mood / instrument / vocal tags.
#
# Overrides (env): UV=<path-to-uv>  PYVER=<3.11>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"
MODELS="$HERE/models"
PYVER="${PYVER:-3.11}"

log()  { printf '\n\033[1;36m[essentia-bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[essentia-bootstrap]\033[0m %s\n' "$*"; }

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64)  log "Target: Linux x86_64 → essentia-tensorflow (full taggers)." ;;
  Linux/aarch64) warn "Target: Linux aarch64 (DGX/Grace-Blackwell). essentia-tensorflow may lack aarch64 wheels — will fall back to DSP-only essentia if so." ;;
  Darwin/arm64)  warn "Target: macOS arm64. essentia-tensorflow may be unavailable — will fall back to DSP-only essentia if so." ;;
  Darwin/*)      warn "macOS on '$ARCH' (Intel) — best effort; Apple Silicon (arm64) is the Mac target." ;;
  *)             warn "Unrecognized $OS/$ARCH — best effort." ;;
esac

UV="${UV:-uv}"
command -v "$UV" >/dev/null 2>&1 || { warn "uv not found on PATH (set UV=/path/to/uv)."; exit 1; }

# ── venv ──────────────────────────────────────────────────────────────────────
if [[ ! -x "$VENV/bin/python" ]]; then
  log "Creating venv ($PYVER) → $VENV"
  "$UV" venv --python "$PYVER" "$VENV"
fi
PY="$VENV/bin/python"

# ── deps: prefer essentia-tensorflow, fall back to plain essentia ─────────────
log "Installing audio-analysis deps (trying essentia-tensorflow first)…"
if VIRTUAL_ENV="$VENV" "$UV" pip install --python "$PY" "numpy<2" "essentia-tensorflow"; then
  log "essentia-tensorflow installed."
else
  warn "essentia-tensorflow unavailable on this platform — falling back to DSP-only 'essentia'."
  VIRTUAL_ENV="$VENV" "$UV" pip install --python "$PY" "numpy<2" "essentia"
fi

# Authoritative check: did we actually get the TensorFlow predict algorithms?
HAS_TF="$("$PY" - <<'PY'
try:
    import essentia.standard as es
    print("1" if hasattr(es, "TensorflowPredict2D") else "0")
except Exception:
    print("0")
PY
)"

# ── models (only meaningful when TF is present) ───────────────────────────────
if [[ "$HAS_TF" == "1" ]]; then
  mkdir -p "$MODELS"
  BASE="https://essentia.upf.edu/models"
  declare -a FILES=(
    "feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb"
    "classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb"
    "classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json"
    "classification-heads/mtg_jamendo_moodtheme/mtg_jamendo_moodtheme-discogs-effnet-1.pb"
    "classification-heads/mtg_jamendo_moodtheme/mtg_jamendo_moodtheme-discogs-effnet-1.json"
    "classification-heads/mtg_jamendo_instrument/mtg_jamendo_instrument-discogs-effnet-1.pb"
    "classification-heads/mtg_jamendo_instrument/mtg_jamendo_instrument-discogs-effnet-1.json"
    "classification-heads/voice_instrumental/voice_instrumental-discogs-effnet-1.pb"
    "classification-heads/voice_instrumental/voice_instrumental-discogs-effnet-1.json"
  )
  dl() {
    local url="$1" out="$2"
    [[ -s "$out" ]] && { log "have $(basename "$out")"; return 0; }
    log "fetch $(basename "$out")"
    curl -fL --retry 3 -o "$out" "$url" || { warn "download failed: $url"; rm -f "$out"; return 1; }
  }
  miss=0
  for rel in "${FILES[@]}"; do
    dl "$BASE/$rel" "$MODELS/$(basename "$rel")" || miss=1
  done
  [[ "$miss" == 0 ]] || warn "Some model files failed to download — DSP still works; learned tags will be skipped until present."
else
  warn "TensorFlow algorithms not available — skipping model download. DSP analysis (bpm/key/loudness/duration) will still work; learned tags are disabled on this platform."
fi

# ── smoke check ───────────────────────────────────────────────────────────────
log "Verifying essentia import…"
"$PY" - <<'PY'
import essentia, essentia.standard as es
print("essentia", essentia.__version__, "ok; learned-tags (TensorFlow):", hasattr(es, "TensorflowPredict2D"))
PY

log "Done. Essentia analyzer ready (built-in CPU service plug-in)."
