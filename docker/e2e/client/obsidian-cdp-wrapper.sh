#!/bin/bash
# Wrapper script for Obsidian that adds CDP (Chrome DevTools Protocol) flags
# This replaces /usr/bin/obsidian

CDP_PORT="${CDP_PORT:-9222}"
BIN=/opt/obsidian/obsidian
VAULT_PATH="/config/vault"

echo "[CDP Wrapper] Starting Obsidian with --remote-debugging-port=$CDP_PORT"

# Start Obsidian with CDP enabled
# Note: We pass --disable-gpu to avoid GPU-related issues in containers
${BIN} \
  --no-sandbox \
  --disable-gpu \
  --disable-software-rasterizer \
  --remote-debugging-port=$CDP_PORT \
  "$@"
