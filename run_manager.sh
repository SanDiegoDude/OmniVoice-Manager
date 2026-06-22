#!/usr/bin/env bash
# Launch the OmniVoice Manager (builds the web UI if needed, then serves it).
# Uses the local .venv directly so `uv` does not need to be on your PATH.
#
# Script-level flags (consumed here, NOT passed to the server):
#   --rebuild    Sync Python deps + CLI commands (uv sync) AND force a fresh web
#                UI build, even if a build already exists. Catches libraries and
#                console scripts (e.g. omnivoice-plugin) added during active dev.
#   --forceup    Kill any process already listening on the port first.
# Everything else is passed through, e.g.: ./run_manager.sh --ssl --lod
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8200}"

# --- Parse our own flags; collect the rest to forward to the server ---
REBUILD=0
FORCEUP=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --rebuild) REBUILD=1 ;;
    --forceup|--force-up) FORCEUP=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

# --- Free the port if asked (kills a stale/orphaned server holding it) ---
if [ "$FORCEUP" = "1" ]; then
  pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)
  elif command -v fuser >/dev/null 2>&1; then
    pids=$(fuser "$PORT/tcp" 2>/dev/null || true)
  fi
  if [ -n "$pids" ]; then
    echo "Killing process(es) holding port $PORT: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    # Force any that ignored SIGTERM.
    if command -v lsof >/dev/null 2>&1; then
      pids=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)
      [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    fi
    sleep 1
  fi
fi

# --- Locate uv (PATH + the usual install locations) ---
# The launcher normally runs off .venv without uv on PATH, so look around before
# giving up. Echoes the path (empty if not found).
find_uv() {
  if command -v uv >/dev/null 2>&1; then command -v uv; return; fi
  for c in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" "/usr/local/bin/uv" ".venv/bin/uv"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
}
UV_BIN="$(find_uv || true)"

# --- Sync Python deps + CLI commands on --rebuild ---
# `uv sync` re-syncs dependencies AND regenerates the project's console scripts
# (omnivoice-manager, omnivoice-plugin, …), so newly added CLI commands show up
# after a rebuild.
if [ "$REBUILD" = "1" ]; then
  if [ -n "$UV_BIN" ]; then
    echo "Syncing Python deps + CLI commands (uv sync) ..."
    "$UV_BIN" sync || echo "uv sync failed — continuing with the existing environment." >&2
  else
    echo "--rebuild: 'uv' not found (PATH, ~/.local/bin, ~/.cargo/bin) — skipping sync." >&2
    echo "  Install uv or run 'uv sync' yourself if deps/CLI commands changed." >&2
  fi
fi

# --- Bootstrap built-in plug-ins (plugins/built-in-*) ---
# First-party plug-ins ship with the host and each need their own isolated sidecar
# env (own deps, possibly model downloads). We bootstrap any whose env is missing
# (first run after a pull) and re-run all of them on --rebuild. Best-effort: a
# failure here never blocks the server — the affected tool simply stays unavailable
# or degraded until its bootstrap succeeds.
for bs in plugins/built-in-*/bootstrap.sh; do
  [ -e "$bs" ] || continue
  pdir="$(dirname "$bs")"
  if [ "$REBUILD" = "1" ] || [ ! -x "$pdir/.venv/bin/python" ]; then
    echo "Bootstrapping built-in plug-in: $pdir"
    ( cd "$pdir" && UV="${UV_BIN:-uv}" bash ./bootstrap.sh ) \
      || echo "  bootstrap failed for $pdir — continuing (tool may be unavailable until fixed)." >&2
  fi
done

# --- Decide whether the SPA needs (re)building ---
# Rebuild when: no build exists, --rebuild was passed, or any web source file is
# newer than the last build. We never install Node/npm for you — bring your own
# (https://nodejs.org, 18+). Node is only needed for this build step.
need_build=0
if [ ! -f web/dist/index.html ]; then
  need_build=1
elif [ "$REBUILD" = "1" ]; then
  need_build=1
elif [ -n "$(find web/src web/index.html web/package.json web/vite.config.ts web/tsconfig.json web/tsconfig.app.json web/tsconfig.node.json -newer web/dist/index.html 2>/dev/null)" ]; then
  echo "Web UI is older than its source — rebuilding."
  need_build=1
fi

if [ "$need_build" = "1" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "The web UI needs building, but 'npm' was not found on your PATH." >&2
    echo "Install Node.js 18+ from https://nodejs.org (or your package manager)," >&2
    echo "then re-run this script. Node is only needed for the build step." >&2
    exit 1
  fi
  echo "Building web UI ..."
  (cd web && npm install && npm run build)
fi

# Prefer the venv created by `uv sync`; fall back to `uv run` if present.
if [ -x ".venv/bin/omnivoice-manager" ]; then
  exec .venv/bin/omnivoice-manager --port "$PORT" ${ARGS[@]+"${ARGS[@]}"}
elif [ -x ".venv/bin/python" ]; then
  exec .venv/bin/python -m manager.server --port "$PORT" ${ARGS[@]+"${ARGS[@]}"}
elif command -v uv >/dev/null 2>&1; then
  exec uv run omnivoice-manager --port "$PORT" ${ARGS[@]+"${ARGS[@]}"}
else
  echo "No .venv found and 'uv' is not on PATH. Run 'uv sync --python 3.10' first." >&2
  exit 1
fi
