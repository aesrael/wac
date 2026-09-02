#!/bin/bash
# Starts wac (and ensures opencode serve is up). Referenced by the launchd plist.
# opencode serve is started on the port from WAC_PORT (set by install-launchd.sh)
# or from ~/.config/wac/config.json, default 8080.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

NODE_BIN="$(command -v node)"
# Resolve to the repo root (parent of scripts/), regardless of where it's cloned.
WAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CFG="${WAC_CONFIG:-$HOME/.config/wac}"

# Port: prefer WAC_PORT env (installed by launchd), else read from config.
if [[ -n "${WAC_PORT:-}" ]]; then
  PORT="$WAC_PORT"
else
  PORT="$(node -e "const c=require(process.argv[1]); const u=new URL(c.opencodeBaseUrl||'http://127.0.0.1:8080'); console.log(u.port||'8080')" "$CFG/config.json" 2>/dev/null || echo 8080)"
fi

# Password for opencode serve: from env (launchd provides it), else config.
PW="${OPENCODE_SERVER_PASSWORD:-}"
if [[ -z "$PW" && -n "$CFG/config.json" ]]; then
  PW="$(node -e "console.log(require(process.argv[1]).opencodePassword || '')" "$CFG/config.json" 2>/dev/null || true)"
fi

# opencode serve: start if not already listening on the configured port
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  OPENCODE="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
  if [[ -n "$PW" ]]; then
    OPENCODE_SERVER_PASSWORD="$PW" nohup "$OPENCODE" serve --hostname 127.0.0.1 --port "$PORT" \
      >"$CFG/opencode.log" 2>&1 &
  else
    nohup "$OPENCODE" serve --hostname 127.0.0.1 --port "$PORT" \
      >"$CFG/opencode.log" 2>&1 &
  fi
fi

exec "$NODE_BIN" "$WAC_DIR/wac" serve