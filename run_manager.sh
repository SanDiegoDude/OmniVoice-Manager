#!/usr/bin/env bash
# Launch the OmniVoice Manager (builds the web UI if needed, then serves it).
# Uses the local .venv directly so `uv` does not need to be on your PATH.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8200}"

# Build the SPA once if it hasn't been built yet. We never install Node/npm
# for you — bring your own (https://nodejs.org, 18+). It is only needed for
# this one-time build; the server itself runs without it.
if [ ! -f web/dist/index.html ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "The web UI is not built yet, and 'npm' was not found on your PATH." >&2
    echo "Install Node.js 18+ from https://nodejs.org (or your package manager)," >&2
    echo "then re-run this script. Node is only needed for this one-time build." >&2
    exit 1
  fi
  echo "Building web UI (first run)..."
  (cd web && npm install && npm run build)
fi

# Prefer the venv created by `uv sync`; fall back to `uv run` if present.
if [ -x ".venv/bin/omnivoice-manager" ]; then
  exec .venv/bin/omnivoice-manager --port "$PORT" "$@"
elif [ -x ".venv/bin/python" ]; then
  exec .venv/bin/python -m manager.server --port "$PORT" "$@"
elif command -v uv >/dev/null 2>&1; then
  exec uv run omnivoice-manager --port "$PORT" "$@"
else
  echo "No .venv found and 'uv' is not on PATH. Run 'uv sync --python 3.10' first." >&2
  exit 1
fi
