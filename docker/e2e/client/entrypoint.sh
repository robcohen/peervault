#!/bin/bash
set -e

# Single-client entrypoint for scalable E2E testing
# Environment variables:
#   VAULT_NAME - Name of this client/vault (e.g., "client-1")
#   CDP_PORT   - CDP port to listen on (default: 9222)
#   RELAY_URL  - Iroh relay URL (default: http://relay:3340)

VAULT_NAME="${VAULT_NAME:-client}"
CDP_PORT="${CDP_PORT:-9222}"
RELAY_URL="${RELAY_URL:-http://relay:3340}"

echo "=== PeerVault E2E Client: $VAULT_NAME ==="
echo "CDP Port: $CDP_PORT"
echo "Relay: $RELAY_URL"

# Create vault directory structure
mkdir -p "/vault/.obsidian/plugins/peervault"
chown -R obsidian:obsidian /vault

# Create app.json config with community plugins enabled
cat > "/vault/.obsidian/app.json" << 'EOF'
{
  "promptDelete": false,
  "restrictedMode": false
}
EOF

# Create workspace.json
cat > "/vault/.obsidian/workspace.json" << 'EOF'
{
  "main": {
    "id": "main",
    "type": "split",
    "children": []
  }
}
EOF

# Enable PeerVault plugin
cat > "/vault/.obsidian/community-plugins.json" << 'EOF'
["peervault"]
EOF

chown -R obsidian:obsidian /vault/.obsidian

# Copy PeerVault plugin if mounted
if [ -d "/plugin-dist" ]; then
    echo "Installing PeerVault plugin..."
    cp -r /plugin-dist/* "/vault/.obsidian/plugins/peervault/"
    chown -R obsidian:obsidian "/vault/.obsidian/plugins/peervault"
    echo "Plugin installed"
fi

# Create default plugin settings with relay URL
cat > "/vault/.obsidian/plugins/peervault/data.json" << EOF
{
  "autoSync": true,
  "syncInterval": 0,
  "excludedFolders": [],
  "excludedExtensions": [],
  "maxFileSize": 104857600,
  "showStatusBar": true,
  "debugMode": true,
  "deviceNickname": "$VAULT_NAME",
  "showDeviceList": true,
  "relayServers": ["$RELAY_URL"],
  "transportType": "hybrid",
  "enableWebRTC": true,
  "autoWebRTCUpgrade": true
}
EOF
chown obsidian:obsidian "/vault/.obsidian/plugins/peervault/data.json"

# Start Xvfb
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2

if ! kill -0 $XVFB_PID 2>/dev/null; then
    echo "ERROR: Xvfb failed to start"
    exit 1
fi
echo "Xvfb started"

# Start socat to forward CDP connections BEFORE Obsidian
# This forwards external 19222 to internal CDP_PORT
echo "Starting CDP forwarder on port 19222..."
socat TCP-LISTEN:19222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:$CDP_PORT &
SOCAT_PID=$!
sleep 1

# Start Obsidian with CDP, opening the vault directly via command line
# Using obsidian:// URI directly in the command to open vault
echo "Starting Obsidian with vault..."
OBSIDIAN_BIN="/opt/Obsidian/obsidian"

# Start Obsidian with the vault path - Obsidian will open this vault
su - obsidian -c "DISPLAY=:99 $OBSIDIAN_BIN \
    --remote-debugging-port=$CDP_PORT \
    --no-sandbox \
    --disable-gpu \
    --disable-software-rasterizer \
    --disable-dev-shm-usage \
    'obsidian://open?path=/vault'" &
OBSIDIAN_PID=$!

echo "Waiting for Obsidian to start..."
sleep 10

# Wait for CDP to be ready
echo "Waiting for CDP endpoint..."
MAX_WAIT=60
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
    if curl -s "http://localhost:$CDP_PORT/json/version" > /dev/null 2>&1; then
        echo "CDP endpoint ready!"
        break
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    echo "  Still waiting... ($ELAPSED/$MAX_WAIT)"
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
    echo "WARNING: CDP endpoint not ready after ${MAX_WAIT}s"
    # Show process status for debugging
    ps aux | grep -E "obsidian|chrome" | head -10
fi

echo ""
echo "=== $VAULT_NAME ready ==="
echo "CDP endpoint: http://localhost:19222"
echo ""

# Keep container running and monitor Obsidian
while true; do
    sleep 60
    # Check if Obsidian is still running
    if ! kill -0 $OBSIDIAN_PID 2>/dev/null; then
        echo "WARNING: Obsidian process died, restarting..."
        su - obsidian -c "DISPLAY=:99 $OBSIDIAN_BIN \
            --remote-debugging-port=$CDP_PORT \
            --no-sandbox \
            --disable-gpu \
            --disable-software-rasterizer \
            --disable-dev-shm-usage \
            'obsidian://open?path=/vault'" &
        OBSIDIAN_PID=$!
        sleep 10
    fi
    # Periodic health check
    if ! curl -s "http://localhost:$CDP_PORT/json/version" > /dev/null 2>&1; then
        echo "WARNING: CDP endpoint not responding"
    fi
done
