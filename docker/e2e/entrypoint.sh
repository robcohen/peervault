#!/bin/bash
set -e

# Create log directories
mkdir -p /var/log/supervisor
mkdir -p /var/run

# Ensure vault directories exist and have correct permissions
mkdir -p /vaults/TEST /vaults/TEST2 /vaults/TEST3
chown -R obsidian:obsidian /vaults

# Create .obsidian directories for each vault and initialize vault config
for vault in TEST TEST2 TEST3; do
    mkdir -p "/vaults/$vault/.obsidian/plugins/peervault"

    # Create app.json config with community plugins enabled
    cat > "/vaults/$vault/.obsidian/app.json" << 'APPEOF'
{
  "promptDelete": false,
  "restrictedMode": false
}
APPEOF

    # Create workspace.json
    cat > "/vaults/$vault/.obsidian/workspace.json" << 'WSEOF'
{
  "main": {
    "id": "main",
    "type": "split",
    "children": []
  }
}
WSEOF

    chown -R obsidian:obsidian "/vaults/$vault/.obsidian"
done

# Copy PeerVault plugin if mounted
if [ -d "/plugin-dist" ]; then
    echo "Installing PeerVault plugin from /plugin-dist..."
    for vault in TEST TEST2 TEST3; do
        cp -r /plugin-dist/* "/vaults/$vault/.obsidian/plugins/peervault/"
        chown -R obsidian:obsidian "/vaults/$vault/.obsidian/plugins/peervault"
    done
    echo "Plugin installed to all vaults"
fi

# Create community-plugins.json to enable PeerVault
for vault in TEST TEST2 TEST3; do
    cat > "/vaults/$vault/.obsidian/community-plugins.json" << 'EOF'
["peervault"]
EOF
    chown obsidian:obsidian "/vaults/$vault/.obsidian/community-plugins.json"
done

# Wait for display to be ready
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2

# Verify Xvfb is running
if ! kill -0 $XVFB_PID 2>/dev/null; then
    echo "ERROR: Xvfb failed to start"
    exit 1
fi
echo "Xvfb started successfully"

# Start Obsidian instances
echo "Starting Obsidian instances..."

# Obsidian binary location
OBSIDIAN_BIN="/opt/Obsidian/obsidian"

# Start single Obsidian instance with CDP enabled
echo "Starting Obsidian with CDP on port 9222..."
su - obsidian -c "DISPLAY=:99 $OBSIDIAN_BIN --remote-debugging-port=9222 --no-sandbox" &
sleep 10

# Open all three vaults via URI - each will open in a new window
echo "Opening vaults via URI..."
su - obsidian -c "DISPLAY=:99 xdg-open 'obsidian://open?path=/vaults/TEST'" 2>/dev/null &
sleep 3
su - obsidian -c "DISPLAY=:99 xdg-open 'obsidian://open?path=/vaults/TEST2'" 2>/dev/null &
sleep 3
su - obsidian -c "DISPLAY=:99 xdg-open 'obsidian://open?path=/vaults/TEST3'" 2>/dev/null &
sleep 5

# Start socat to forward external connections to localhost CDP
echo "Starting socat port forwarder..."
socat TCP-LISTEN:19222,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &
sleep 2

# Auto-click "Trust author and enable plugins" for each vault
echo "Enabling plugin trust for all vaults..."
for vault in TEST TEST2 TEST3; do
    # Get the page ID for this vault
    PAGE_ID=$(curl -s "http://localhost:9222/json/list" | grep -B5 "\"$vault\"" | grep '"id"' | head -1 | sed 's/.*: "\(.*\)".*/\1/')
    if [ -n "$PAGE_ID" ]; then
        # Use CDP to click the trust button
        cat << CDPEOF | timeout 10 bun - 2>/dev/null || true
const ws = new WebSocket("ws://localhost:9222/devtools/page/$PAGE_ID");
ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: \\\`
        (async function() {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.textContent?.includes('Trust author and enable plugins')) {
              btn.click();
              return 'clicked';
            }
          }
          return 'no-button';
        })()
      \\\`,
      returnByValue: true,
      awaitPromise: true
    }
  }));
};
ws.onmessage = (e) => { ws.close(); process.exit(0); };
setTimeout(() => process.exit(0), 5000);
CDPEOF
        echo "  $vault: trust enabled"
    fi
done
sleep 5

# Check CDP endpoints
echo "Checking CDP endpoint..."
if curl -s "http://localhost:9222/json/version" > /dev/null 2>&1; then
    echo "  Port 9222: OK"
else
    echo "  Port 9222: WAITING..."
fi

# List discovered vaults
echo "Discovered vaults:"
curl -s "http://localhost:9222/json/list" | grep -o '"title":"[^"]*"' || echo "  None yet"

# Keep container running
echo ""
echo "Container ready. CDP port: 19222"
echo "All vault windows accessible via single CDP port."
echo "Run E2E tests with: bun run test:e2e"

# Keep running forever - wait for all background jobs
while true; do
    sleep 60
done
