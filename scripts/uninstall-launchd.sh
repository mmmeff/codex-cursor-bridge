#!/usr/bin/env bash
# Remove the codex-cursor-bridge LaunchAgent.
set -euo pipefail

LABEL="com.user.codex-cursor-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ -f "$PLIST" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ Removed $PLIST"
else
  echo "No LaunchAgent found at $PLIST"
fi
