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

es_imports() {  # 0 if `import essentia.standard` works in the venv, else non-zero
  "$PY" - <<'PY' >/dev/null 2>&1
import essentia.standard  # noqa
PY
}

# Experimental: compile Essentia from source for platforms with no prebuilt wheel
# (notably Linux aarch64). Opt-in via ESSENTIA_BUILD_FROM_SOURCE=1. We never auto
# `sudo apt` for you — if the C++ toolchain / audio dev libs are missing we print
# the install line and bail. Best-effort: any failure falls through to a clean skip.
build_essentia_from_source() {
  warn "ESSENTIA_BUILD_FROM_SOURCE=1 — attempting a from-source build (experimental, slow)."
  local missing=() c
  for c in cc c++ pkg-config git; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  if [[ ${#missing[@]} -gt 0 ]]; then
    warn "Missing build tools (${missing[*]}). Install the toolchain + audio dev libs first, e.g.:"
    warn "  sudo apt-get install -y build-essential libeigen3-dev libyaml-dev libfftw3-dev \\"
    warn "      libavcodec-dev libavformat-dev libavutil-dev libswresample-dev \\"
    warn "      libsamplerate0-dev libtag1-dev libchromaprint-dev"
    return 1
  fi
  local src="$HERE/.essentia-src"
  rm -rf "$src"
  git clone --depth 1 https://github.com/MTG/essentia "$src" || return 1
  VIRTUAL_ENV="$VENV" "$UV" pip install --python "$PY" "numpy<2" pyyaml six || return 1
  local platlib; platlib="$("$PY" -c 'import sysconfig;print(sysconfig.get_paths()["platlib"])')"
  ( cd "$src" \
    && "$PY" waf configure --with-python --build-static --pythondir="$platlib" --prefix="$VENV" \
    && "$PY" waf \
    && "$PY" waf install ) || { warn "waf build failed (see output above)."; return 1; }
  log "Source build complete."
  return 0
}

# ── deps: prefer essentia-tensorflow, fall back to plain essentia ─────────────
# Order matters and we must not abort on the fallback (set -e): on aarch64 BOTH
# wheels are absent, and we want to skip gracefully rather than crash the launcher.
log "Installing audio-analysis deps (trying essentia-tensorflow first)…"
if VIRTUAL_ENV="$VENV" "$UV" pip install --python "$PY" "numpy<2" "essentia-tensorflow"; then
  log "essentia-tensorflow installed."
elif VIRTUAL_ENV="$VENV" "$UV" pip install --python "$PY" "numpy<2" "essentia"; then
  warn "essentia-tensorflow unavailable — installed DSP-only 'essentia' (no learned tags)."
else
  warn "No prebuilt essentia wheel for $OS/$ARCH (expected on Linux aarch64)."
fi

# ── no usable wheel? optional source build, else a clean graceful skip ────────
if ! es_imports; then
  # Keep numpy present so the sidecar still starts and reports a precise message.
  VIRTUAL_ENV="$VENV" "$UV" pip install --python "$PY" "numpy<2" >/dev/null 2>&1 || true
  if [[ "${ESSENTIA_BUILD_FROM_SOURCE:-0}" == "1" ]]; then
    build_essentia_from_source || true
  fi
fi
if ! es_imports; then
  warn "Essentia has no prebuilt package for $OS/$ARCH (no PyPI wheel, no conda-forge build)."
  warn "The analyzer will report 'unavailable' here — sounds still save and metadata stays hand-editable."
  warn "To compile it anyway, reinstall this built-in with ESSENTIA_BUILD_FROM_SOURCE=1."
  # Exit 0 so the launcher marks this built-in 'done' and won't retry the impossible
  # install on every launch. The sidecar degrades cleanly at runtime.
  log "Done (analyzer unavailable on this platform — graceful skip)."
  exit 0
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
