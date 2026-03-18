#!/bin/bash
# Install LaunchAgent to start Apple Container system service at login.
# Run from repo root: ./scripts/install-apple-container-launchagent.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_SRC="$REPO_ROOT/launchd/com.nanoclaw.apple-container-system.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.nanoclaw.apple-container-system.plist"

if [ ! -f "$PLIST_SRC" ]; then
  echo "Error: plist not found at $PLIST_SRC"
  exit 1
fi

mkdir -p "$(dirname "$PLIST_DEST")"
sed "s|{{HOME}}|$HOME|g" "$PLIST_SRC" > "$PLIST_DEST"
echo "Installed: $PLIST_DEST"

launchctl load "$PLIST_DEST"
echo "Loaded. Apple Container system service will start at login."
echo "To start now: container system start"
echo "To unload: launchctl unload $PLIST_DEST"
