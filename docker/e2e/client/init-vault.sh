#!/bin/bash
# Initialize vault and PeerVault plugin for E2E testing
# This runs during container init (before Obsidian starts)

set -e

VAULT_NAME="${VAULT_NAME:-client}"
RELAY_URL="${RELAY_URL:-http://relay:3340}"
# Use vault name as directory so Obsidian identifies it by name
VAULT_PATH="/config/$VAULT_NAME"

echo "=== Initializing E2E Vault: $VAULT_NAME ==="

# Create vault directory
mkdir -p "$VAULT_PATH/.obsidian/plugins/peervault"

# Create Obsidian config files
# restrictedMode: false enables community plugins
# communityPluginsTrusted: true marks the vault as already trusted (skips the trust dialog)
cat > "$VAULT_PATH/.obsidian/app.json" << 'EOF'
{
  "promptDelete": false,
  "restrictedMode": false,
  "communityPluginsTrusted": true
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
# Note: relayUrl is a single URL string, not an array
cat > "$VAULT_PATH/.obsidian/plugins/peervault/data.json" << EOF
{
  "deviceName": "$VAULT_NAME",
  "autoSync": true,
  "autoSyncInterval": 5,
  "relayUrl": "$RELAY_URL"
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

# Create obsidian.json with the vault pre-registered AND pre-trusted
# The "trusted" field marks the vault as already having user consent for community plugins
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
  "updateDisabled": true,
  "trustedVaults": {
    "$VAULT_PATH": true
  }
}
EOF

chown -R abc:abc "$OBSIDIAN_CONFIG_DIR"

echo "=== Vault initialized: $VAULT_PATH ==="
echo "=== Obsidian configured to open vault: $VAULT_ID ==="
