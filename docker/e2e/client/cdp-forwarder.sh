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

# Forward CDP connections
# Using TCP-LISTEN with fork to handle multiple connections
exec socat TCP-LISTEN:${EXTERNAL_PORT},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:$CDP_PORT
