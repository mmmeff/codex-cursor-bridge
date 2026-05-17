#!/usr/bin/env bash
# Install codex-cursor-bridge as a macOS LaunchAgent (auto-start at login,
# auto-restart on crash).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is macOS-only. On Linux use systemd; see README." >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$REPO_DIR/server.mjs"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH. Install Node 20+ first (https://nodejs.org)." >&2
  exit 1
fi

LABEL="com.user.codex-cursor-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$REPO_DIR/server.log"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$SERVER</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CODEX_BRIDGE_PORT</key>
        <string>${CODEX_BRIDGE_PORT:-7711}</string>
        <key>CODEX_BRIDGE_HOST</key>
        <string>${CODEX_BRIDGE_HOST:-127.0.0.1}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
</dict>
</plist>
EOF

# Reload to pick up any prior version.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

sleep 1
if curl -sS --max-time 3 "http://127.0.0.1:${CODEX_BRIDGE_PORT:-7711}/healthz" >/dev/null; then
  echo "✓ codex-cursor-bridge installed and running at http://127.0.0.1:${CODEX_BRIDGE_PORT:-7711}/v1"
  echo "  plist: $PLIST"
  echo "  log:   $LOG"
else
  echo "Installed but health check failed. Inspect $LOG for errors." >&2
  exit 1
fi
