#!/bin/bash
# Starts wac (and ensures opencode serve is up). Referenced by the launchd plist.
# Edit the paths below for your machine.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

NODE_BIN="$(command -v node)"
# Resolve to the repo root (parent of scripts/), regardless of where it's cloned.
WAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# opencode serve: start if not already listening on the configured port
PORT="8080"
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  OPENCODE="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"
  nohup "$OPENCODE" serve --hostname 127.0.0.1 --port "$PORT" \
    >"$HOME/.config/wac/opencode.log" 2>&1 &
fi

exec "$NODE_BIN" "$WAC_DIR/wac" serve