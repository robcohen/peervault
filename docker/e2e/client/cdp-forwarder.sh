#!/bin/bash
# CDP port forwarder service
# Forwards external port 19222 to Obsidian's internal CDP port (9222)

CDP_PORT="${CDP_PORT:-9222}"
EXTERNAL_PORT=19222

echo "Starting CDP forwarder: 0.0.0.0:${EXTERNAL_PORT} -> 127.0.0.1:$CDP_PORT"

# Wait for Obsidian to start and CDP to be available
echo "Waiting for CDP to be ready on port $CDP_PORT..."
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
    if curl -s "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; then
        echo "CDP is ready!"
        break
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
    echo "WARNING: CDP not ready after ${MAX_WAIT}s, starting forwarder anyway"
fi

# Accept trust dialog if present (allows community plugins to load)
echo "Checking for trust dialog..."
accept_trust_dialog() {
    # Get WebSocket URL for the Obsidian page (first ws:// URL from CDP)
    WS_URL=$(curl -s "http://127.0.0.1:$CDP_PORT/json" | grep -o 'ws://[^"]*' | head -1)

    if [ -z "$WS_URL" ]; then
        echo "  No CDP target found"
        return 1
    fi

    # Use websocat with pre-built JSON file (avoids shell escaping issues)
    if [ -f /opt/accept-trust-dialog.json ]; then
        result=$(cat /opt/accept-trust-dialog.json | websocat -n1 "$WS_URL" 2>/dev/null)
        # Extract the value from the response
        echo "$result" | grep -o '"value":"[^"]*"' | sed 's/"value":"\([^"]*\)"/\1/'
    else
        echo "  JSON file not found"
        return 1
    fi
}

# Try to accept trust dialog multiple times (it may take a moment to appear)
for attempt in 1 2 3 4 5; do
    sleep 2
    result=$(accept_trust_dialog)
    echo "  Attempt $attempt: $result"
    if [ "$result" = "clicked" ]; then
        echo "Trust dialog accepted!"
        sleep 3  # Wait for plugins to load
        break
    fi
    if [ "$result" = "no-modal" ] && [ $attempt -ge 3 ]; then
        echo "No trust dialog found (vault may already be trusted)"
        break
    fi
done

# Forward CDP connections
# Using TCP-LISTEN with fork to handle multiple connections
exec socat TCP-LISTEN:${EXTERNAL_PORT},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:$CDP_PORT
