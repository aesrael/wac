#!/bin/bash
# Generate + install the launchd plist for wac, then load it.
# Usage: ./scripts/install-launchd.sh  (or: npm run launchd)
# Reads the opencode password + port from ~/.config/wac/config.json so you
# never paste secrets; edits nothing else.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CFG="${WAC_CONFIG:-$HOME/.config/wac}"
CONFIG_FILE="$CFG/config.json"
PLIST_DEST="$HOME/Library/LaunchAgents/com.user.wac.plist"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "error: no $CONFIG_FILE — run 'node wac status' once to create a default config" >&2
  exit 1
fi

PASSWORD="$(node -e "console.log(require(process.argv[1]).opencodePassword || '')" "$CONFIG_FILE")"
PORT="$(node -e "const u=new URL(require(process.argv[1]).opencodeBaseUrl||'http://127.0.0.1:8080'); console.log(u.port||'8080')" "$CONFIG_FILE")"
NODE_BIN="$(command -v node)"
ENTRY="$REPO/wac"

if [[ -z "$PASSWORD" ]]; then
  echo "error: set opencodePassword in $CONFIG_FILE (or export OPENCODE_SERVER_PASSWORD)" >&2
  exit 1
fi

cat > "$PLIST_DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.wac</string>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$ENTRY</string>
        <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENCODE_SERVER_PASSWORD</key>
        <string>$PASSWORD</string>
        <key>WAC_PORT</key>
        <string>$PORT</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>$CFG/wac.log</string>
    <key>StandardErrorPath</key>
    <string>$CFG/wac.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"
echo "installed $PLIST_DEST"
echo "entry:  $ENTRY"
echo "port:   $PORT"
echo "wac will start at login and restart on crash."