#!/bin/bash
# Initialize vault and PeerVault plugin for E2E testing
# This runs during container init (before Obsidian starts)

set -e

VAULT_NAME="${VAULT_NAME:-client}"
RELAY_URL="${RELAY_URL:-http://relay:3340}"
VAULT_PATH="/config/vault"

echo "=== Initializing E2E Vault: $VAULT_NAME ==="

# Create vault directory
mkdir -p "$VAULT_PATH/.obsidian/plugins/peervault"

# Create Obsidian config files
cat > "$VAULT_PATH/.obsidian/app.json" << 'EOF'
{
  "promptDelete": false,
  "restrictedMode": false
}
EOF

cat > "$VAULT_PATH/.obsidian/workspace.json" << 'EOF'
{
  "main": {
    "id": "main",
    "type": "split",
    "children": []
  }
}
EOF

# Enable PeerVault plugin
cat > "$VAULT_PATH/.obsidian/community-plugins.json" << 'EOF'
["peervault"]
EOF

# Copy PeerVault plugin if mounted
if [ -d "/plugin-dist" ]; then
    echo "Installing PeerVault plugin from /plugin-dist..."
    cp -r /plugin-dist/* "$VAULT_PATH/.obsidian/plugins/peervault/"
    echo "Plugin installed"
fi

# Create plugin settings with relay URL
cat > "$VAULT_PATH/.obsidian/plugins/peervault/data.json" << EOF
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

# Set proper ownership (abc is the linuxserver default user)
chown -R abc:abc "$VAULT_PATH"

# Configure Obsidian to open this vault automatically
# Obsidian stores vault list in ~/.config/obsidian/obsidian.json
OBSIDIAN_CONFIG_DIR="/config/.config/obsidian"
mkdir -p "$OBSIDIAN_CONFIG_DIR"

# Generate a unique vault ID (based on vault name hash)
VAULT_ID=$(echo -n "$VAULT_PATH" | md5sum | cut -c1-16)
TIMESTAMP=$(date +%s)000

# Create obsidian.json with the vault pre-registered
cat > "$OBSIDIAN_CONFIG_DIR/obsidian.json" << EOF
{
  "vaults": {
    "$VAULT_ID": {
      "path": "$VAULT_PATH",
      "ts": $TIMESTAMP,
      "open": true
    }
  },
  "frame": "native",
  "updateDisabled": true
}
EOF

chown -R abc:abc "$OBSIDIAN_CONFIG_DIR"

echo "=== Vault initialized: $VAULT_PATH ==="
echo "=== Obsidian configured to open vault: $VAULT_ID ==="
