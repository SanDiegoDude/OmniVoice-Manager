#!/usr/bin/env bash
# Launch the OmniVoice Manager (keeps the install current, then serves the UI).
# Uses the local .venv directly so `uv` does not need to be on your PATH.
#
# By default every launch KEEPS THE INSTALL CURRENT — it frees the port, syncs
# Python deps/CLI (uv sync), bootstraps any new/changed built-in plug-ins, and
# rebuilds the web UI if its sources changed. This is the safe default: pull and
# run, and you're up to date. Cheap when nothing changed (each step is skipped
# when already current).
#
# Script-level flags (consumed here, NOT passed to the server):
#   --norebuild  Fast launch: skip uv sync + the web staleness check + built-in
#                update checks. Only builds/bootstraps things that are missing
#                outright. Use when you KNOW nothing changed since last launch.
#   --rebuild    (deprecated; now the default) Force a fresh web build and
#                re-bootstrap of built-ins even if they look current.
#   --forceup    (deprecated; now always done) The port is always freed first.
# Everything else is passed through, e.g.: ./run_manager.sh --ssl --lod
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8200}"

# --- Parse our own flags; collect the rest to forward to the server ---
FAST=0      # --norebuild → skip update checks (fast launch)
FORCE=0     # --rebuild   → force web rebuild + built-in re-bootstrap
ARGS=()
for a in "$@"; do
  case "$a" in
    --norebuild) FAST=1 ;;
    --rebuild) FORCE=1 ;;
    --forceup|--force-up) : ;;  # deprecated no-op: the port is always freed now
    *) ARGS+=("$a") ;;
  esac
done

# --- Always free the port (only ever one manager per host) ---
pids=""
if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)
elif command -v fuser >/dev/null 2>&1; then
  pids=$(fuser "$PORT/tcp" 2>/dev/null || true)
fi
if [ -n "$pids" ]; then
  echo "Freeing port $PORT (stopping existing manager: $pids)"
  kill $pids 2>/dev/null || true
  sleep 1
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
  sleep 1
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

# --- Sync Python deps + CLI commands (default; skipped on --norebuild) ---
# `uv sync` re-syncs dependencies AND regenerates the project's console scripts
# (omnivoice-manager, omnivoice-plugin, …). Cheap no-op when nothing changed.
if [ "$FAST" != "1" ]; then
  if [ -n "$UV_BIN" ]; then
    echo "Syncing Python deps + CLI commands (uv sync) ..."
    "$UV_BIN" sync || echo "uv sync failed — continuing with the existing environment." >&2
  else
    echo "'uv' not found (PATH, ~/.local/bin, ~/.cargo/bin) — skipping dependency sync." >&2
    echo "  Install uv or run 'uv sync' yourself if deps/CLI commands changed." >&2
  fi
fi

# --- Bootstrap built-in plug-ins (plugins/built-in-*) ---
# First-party plug-ins ship with the host and each need their own isolated sidecar
# env (own deps, possibly model downloads). To avoid reinstalling on every launch,
# we fingerprint each plug-in's bootstrap inputs (bootstrap.sh + plugin.json) and
# only (re)bootstrap when: the venv is missing, the fingerprint changed (the plug-in
# was updated), or --rebuild forces it. The success marker lives inside .venv, so it
# vanishes if the env is deleted. Best-effort: a failure never blocks the server.
builtin_fingerprint() { cat "$1/bootstrap.sh" "$1/plugin.json" 2>/dev/null | cksum | tr -d ' '; }
for bs in plugins/built-in-*/bootstrap.sh; do
  [ -e "$bs" ] || continue
  pdir="$(dirname "$bs")"
  marker="$pdir/.venv/.ov-bootstrap-ok"
  fp="$(builtin_fingerprint "$pdir")"
  need=0
  if [ ! -x "$pdir/.venv/bin/python" ]; then
    need=1                                   # not installed
  elif [ "$FORCE" = "1" ]; then
    need=1                                   # --rebuild: force
  elif [ -f "$marker" ] && [ "$FAST" != "1" ] && [ "$(cat "$marker" 2>/dev/null || true)" != "$fp" ]; then
    need=1                                   # plug-in changed since last bootstrap
  fi
  if [ "$need" = "1" ]; then
    echo "Bootstrapping built-in plug-in: $pdir"
    if ( cd "$pdir" && UV="${UV_BIN:-uv}" bash ./bootstrap.sh ); then
      echo "$fp" > "$marker" 2>/dev/null || true
    else
      echo "  bootstrap failed for $pdir — continuing (tool may be unavailable until fixed)." >&2
    fi
  elif [ ! -f "$marker" ]; then
    # venv already present but unmarked (legacy / just built) → adopt it as the
    # current baseline rather than reinstalling.
    echo "$fp" > "$marker" 2>/dev/null || true
  fi
done

# --- Decide whether the SPA needs (re)building ---
# Build when: no build exists, --rebuild forces it, or (default) any web source
# file is newer than the last build. --norebuild skips the staleness scan. We
# never install Node/npm for you — bring your own (https://nodejs.org, 18+).
need_build=0
if [ ! -f web/dist/index.html ]; then
  need_build=1
elif [ "$FORCE" = "1" ]; then
  need_build=1
elif [ "$FAST" != "1" ] && [ -n "$(find web/src web/index.html web/package.json web/vite.config.ts web/tsconfig.json web/tsconfig.app.json web/tsconfig.node.json -newer web/dist/index.html 2>/dev/null)" ]; then
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
