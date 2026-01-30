# PeerVault development commands
# Run `just` to see available commands

# Default: show help
default:
    @just --list

# ============================================================================
# WASM Build Commands (Iroh networking layer)
# ============================================================================

# Build Iroh WASM module (requires nix develop shell for clang)
wasm:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Building Iroh WASM module..."
    cd peervault-iroh
    # CC_wasm32_unknown_unknown should be set by flake.nix shellHook
    if [ -z "${CC_wasm32_unknown_unknown:-}" ]; then
        echo "Warning: CC_wasm32_unknown_unknown not set. Run 'nix develop' first."
        echo "Attempting build anyway..."
    fi
    wasm-pack build --target web --release
    echo "WASM build complete: peervault-iroh/pkg/"

# Clean and rebuild WASM from scratch
wasm-clean:
    rm -rf peervault-iroh/target peervault-iroh/pkg
    just wasm

# Verify WASM has no "env" imports (ring native code)
wasm-check:
    #!/usr/bin/env bash
    set -euo pipefail
    WASM_FILE="peervault-iroh/pkg/peervault_iroh_bg.wasm"
    if [ ! -f "$WASM_FILE" ]; then
        echo "Error: WASM not found. Run 'just wasm' first."
        exit 1
    fi
    echo "Checking WASM for native code imports..."
    bun -e "
    const fs = require('fs');
    const wasmBytes = fs.readFileSync('$WASM_FILE');
    WebAssembly.compile(wasmBytes).then(module => {
        const imports = WebAssembly.Module.imports(module);
        const envImports = imports.filter(i => i.module === 'env');
        console.log('Total imports:', imports.length);
        console.log('Env imports:', envImports.length);
        if (envImports.length > 0) {
            console.log('ERROR: WASM has native code imports:');
            envImports.slice(0, 5).forEach(i => console.log('  -', i.name));
            process.exit(1);
        } else {
            console.log('OK: WASM is clean (no env imports)');
        }
    });
    "

# ============================================================================
# Main Build Commands
# ============================================================================

# Initialize the project (first-time setup)
init:
    bun init -y
    bun add loro-crdt
    bun add -d typescript @types/node esbuild obsidian @types/obsidian
    @echo "Project initialized! Run 'just dev' to start development."

# Install dependencies
install:
    bun install

# Run TypeScript type checking
check:
    bun run tsc --noEmit

# Build the plugin for production
build:
    bun run build

# Build and watch for changes
dev:
    bun run dev

# Run tests
test:
    bun test

# Run tests in watch mode
test-watch:
    bun test --watch

# Lint the code
lint:
    bun run lint

# Format the code
fmt:
    bun run format

# Clean build artifacts
clean:
    rm -rf dist/ .bun/ node_modules/

# Create a release build with specific version
release version:
    @echo "Building release {{version}}..."
    bun run build
    @echo "Updating manifest.json version to {{version}}..."
    jq '.version = "{{version}}"' manifest.json > manifest.json.tmp && mv manifest.json.tmp manifest.json
    @echo "Release {{version}} ready!"

# Bump patch version, build, and create GitHub release
bump:
    #!/usr/bin/env bash
    set -euo pipefail
    # Get current version and bump patch
    CURRENT=$(jq -r '.version' manifest.json)
    MAJOR=$(echo "$CURRENT" | cut -d. -f1)
    MINOR=$(echo "$CURRENT" | cut -d. -f2)
    PATCH=$(echo "$CURRENT" | cut -d. -f3)
    NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
    echo "Bumping version: $CURRENT -> $NEW_VERSION"

    # Update manifest.json
    jq ".version = \"$NEW_VERSION\"" manifest.json > manifest.json.tmp && mv manifest.json.tmp manifest.json

    # Update versions.json
    jq ". + {\"$NEW_VERSION\": \"1.4.0\"}" versions.json > versions.json.tmp && mv versions.json.tmp versions.json

    # Build
    bun run build

    # Create tarball
    tar -czvf "peervault-$NEW_VERSION.tar.gz" -C dist main.js manifest.json styles.css

    echo "Ready for release v$NEW_VERSION"
    echo "Run: gh release create v$NEW_VERSION peervault-$NEW_VERSION.tar.gz dist/main.js dist/manifest.json dist/styles.css --title \"v$NEW_VERSION\" --generate-notes"

# Copy plugin to Obsidian vault for testing (set OBSIDIAN_VAULT env var)
deploy:
    #!/usr/bin/env bash
    if [ -z "$OBSIDIAN_VAULT" ]; then
        echo "Error: Set OBSIDIAN_VAULT environment variable to your vault path"
        exit 1
    fi
    PLUGIN_DIR="$OBSIDIAN_VAULT/.obsidian/plugins/peervault"
    mkdir -p "$PLUGIN_DIR"
    cp dist/main.js "$PLUGIN_DIR/"
    cp manifest.json "$PLUGIN_DIR/"
    cp styles.css "$PLUGIN_DIR/" 2>/dev/null || true
    echo "Deployed to $PLUGIN_DIR"

# Watch and auto-deploy on changes
dev-deploy:
    #!/usr/bin/env bash
    if [ -z "$OBSIDIAN_VAULT" ]; then
        echo "Error: Set OBSIDIAN_VAULT environment variable to your vault path"
        exit 1
    fi
    watchexec -e ts,css -w src -- just build && just deploy

# Generate documentation from specs
docs:
    @echo "Spec files:"
    @ls -la spec/*.md

# ============================================================================
# E2E Testing Commands
# ============================================================================

# Run E2E tests
e2e:
    bun run test:e2e

# Run E2E tests with verbose output
e2e-verbose:
    bun run test:e2e --verbose

# Discover available vaults (no tests)
e2e-discover:
    bun run test:e2e --discover

# ============================================================================
# Local Relay Server (for E2E testing)
# ============================================================================

# Directory for relay data
relay_dir := ".relay"
relay_log := ".relay/relay.log"
relay_pid := ".relay/relay.pid"

# Install iroh-relay if not present
relay-install:
    #!/usr/bin/env bash
    set -euo pipefail
    if command -v iroh-relay &> /dev/null; then
        echo "iroh-relay already installed"
        iroh-relay --version
    elif [ -f ".cargo/bin/iroh-relay" ]; then
        echo "iroh-relay found in .cargo/bin"
    else
        echo "Installing iroh-relay..."
        cargo install iroh-relay --features="server" --root .
        echo "Installed to .cargo/bin/iroh-relay"
    fi

# Start local relay server (background, with logging)
relay-start: relay-install
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p {{relay_dir}}

    # Check if already running
    if [ -f "{{relay_pid}}" ]; then
        PID=$(cat "{{relay_pid}}")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Relay already running (PID $PID)"
            echo "Logs: {{relay_log}}"
            exit 0
        fi
        rm "{{relay_pid}}"
    fi

    # Find the binary
    RELAY_BIN=""
    if command -v iroh-relay &> /dev/null; then
        RELAY_BIN="iroh-relay"
    elif [ -f ".cargo/bin/iroh-relay" ]; then
        RELAY_BIN=".cargo/bin/iroh-relay"
    else
        echo "Error: iroh-relay not found. Run 'just relay-install' first."
        exit 1
    fi

    echo "Starting local relay server..."
    # Set RUST_LOG for detailed logging
    RUST_LOG=info,iroh_relay=debug,iroh=debug \
        "$RELAY_BIN" --dev > "{{relay_log}}" 2>&1 &
    PID=$!
    echo "$PID" > "{{relay_pid}}"

    # Wait for startup
    sleep 2
    if kill -0 "$PID" 2>/dev/null; then
        echo "Relay started on http://localhost:3340 (PID $PID)"
        echo "Logs: {{relay_log}}"
        echo ""
        echo "Configure vaults to use: http://localhost:3340"
    else
        echo "Error: Relay failed to start. Check {{relay_log}}"
        cat "{{relay_log}}"
        exit 1
    fi

# Stop local relay server
relay-stop:
    #!/usr/bin/env bash
    if [ -f "{{relay_pid}}" ]; then
        PID=$(cat "{{relay_pid}}")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping relay (PID $PID)..."
            kill "$PID"
            rm "{{relay_pid}}"
            echo "Relay stopped"
        else
            echo "Relay not running (stale PID file)"
            rm "{{relay_pid}}"
        fi
    else
        # Try to find and kill by process name
        PIDS=$(pgrep -f "iroh-relay" || true)
        if [ -n "$PIDS" ]; then
            echo "Killing iroh-relay processes: $PIDS"
            pkill -f "iroh-relay" || true
        else
            echo "No relay running"
        fi
    fi

# Show relay status
relay-status:
    #!/usr/bin/env bash
    if [ -f "{{relay_pid}}" ]; then
        PID=$(cat "{{relay_pid}}")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Relay running (PID $PID)"
            echo "URL: http://localhost:3340"
            echo ""
            # Show recent logs
            if [ -f "{{relay_log}}" ]; then
                echo "Recent logs:"
                tail -10 "{{relay_log}}"
            fi
        else
            echo "Relay not running (stale PID file)"
        fi
    else
        PIDS=$(pgrep -f "iroh-relay" || true)
        if [ -n "$PIDS" ]; then
            echo "Relay running (PIDs: $PIDS) - not managed by just"
        else
            echo "Relay not running"
        fi
    fi

# Tail relay logs (follow mode)
relay-logs:
    #!/usr/bin/env bash
    if [ -f "{{relay_log}}" ]; then
        tail -f "{{relay_log}}"
    else
        echo "No relay log found. Start relay with 'just relay-start'"
    fi

# Show full relay logs
relay-logs-full:
    #!/usr/bin/env bash
    if [ -f "{{relay_log}}" ]; then
        cat "{{relay_log}}"
    else
        echo "No relay log found"
    fi

# Clean relay data and logs
relay-clean: relay-stop
    rm -rf {{relay_dir}}
    echo "Relay data cleaned"

# Run E2E tests with local relay
e2e-local: relay-start
    #!/usr/bin/env bash
    echo "Running E2E tests with local relay..."
    echo "Note: Configure both test vaults to use http://localhost:3340"
    echo ""
    bun run test:e2e

# ============================================================================
# Project Stats
# ============================================================================

# Show project stats
stats:
    @echo "=== PeerVault Project Stats ==="
    @echo ""
    @echo "Spec files:"
    @wc -l spec/*.md | tail -1
    @echo ""
    @echo "Source files:"
    @find src -name "*.ts" 2>/dev/null | wc -l | xargs -I{} echo "{} TypeScript files"
    @find src -name "*.ts" -exec wc -l {} + 2>/dev/null | tail -1 || echo "0 lines"
