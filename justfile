# PeerVault development commands
# Run `just` to see available commands

# Default: show help
default:
    @just --list

# ============================================================================
# WASM Build Commands (PeerVault Core - transport, sync, crypto)
# ============================================================================

# Build PeerVault Core WASM module (requires nix develop shell for clang)
wasm:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Building PeerVault Core WASM module..."
    cd peervault-core
    # CC_wasm32_unknown_unknown should be set by flake.nix shellHook
    if [ -z "${CC_wasm32_unknown_unknown:-}" ]; then
        echo "Warning: CC_wasm32_unknown_unknown not set. Run 'nix develop' first."
        echo "Attempting build anyway..."
    fi
    wasm-pack build --release --target web --features wasm --no-default-features
    echo "WASM build complete: peervault-core/pkg/"

# Clean and rebuild WASM from scratch
wasm-clean:
    rm -rf target peervault-core/pkg
    just wasm

# Verify WASM has no "env" imports (ring native code)
wasm-check:
    #!/usr/bin/env bash
    set -euo pipefail
    WASM_FILE="peervault-core/pkg/peervault_core_bg.wasm"
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

# Alias for backward compatibility
wasm-core: wasm

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
    MIN_APP_VERSION=$(jq -r '.minAppVersion' manifest.json)
    MAJOR=$(echo "$CURRENT" | cut -d. -f1)
    MINOR=$(echo "$CURRENT" | cut -d. -f2)
    PATCH=$(echo "$CURRENT" | cut -d. -f3)
    NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
    echo "Bumping version: $CURRENT -> $NEW_VERSION (minAppVersion: $MIN_APP_VERSION)"

    # Update manifest.json
    jq ".version = \"$NEW_VERSION\"" manifest.json > manifest.json.tmp && mv manifest.json.tmp manifest.json

    # Update versions.json (reads minAppVersion from manifest.json)
    jq ". + {\"$NEW_VERSION\": \"$MIN_APP_VERSION\"}" versions.json > versions.json.tmp && mv versions.json.tmp versions.json

    # Build
    bun run build

    # Create tarball
    tar -czvf "peervault-$NEW_VERSION.tar.gz" -C dist main.js manifest.json styles.css

    echo ""
    echo "Ready for release v$NEW_VERSION"
    echo "To publish, run:"
    echo "  git add manifest.json versions.json && git commit -m 'Release v$NEW_VERSION'"
    echo "  git tag v$NEW_VERSION && git push && git push --tags"
    echo "  gh release create v$NEW_VERSION peervault-$NEW_VERSION.tar.gz dist/main.js dist/manifest.json dist/styles.css --title 'v$NEW_VERSION' --generate-notes"

# Create a full release (bump, commit, tag, push, create GitHub release)
release-full:
    #!/usr/bin/env bash
    set -euo pipefail

    # Check for uncommitted changes
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "Error: Uncommitted changes detected. Commit or stash them first."
        exit 1
    fi

    # Run bump
    just bump

    # Get the new version
    NEW_VERSION=$(jq -r '.version' manifest.json)

    # Commit and tag
    git add manifest.json versions.json
    git commit -m "Release v$NEW_VERSION"
    git tag "v$NEW_VERSION"

    # Push
    git push && git push --tags

    # Create GitHub release
    gh release create "v$NEW_VERSION" \
        "peervault-$NEW_VERSION.tar.gz" \
        dist/main.js \
        dist/manifest.json \
        dist/styles.css \
        --title "v$NEW_VERSION" \
        --generate-notes

    echo ""
    echo "Released v$NEW_VERSION!"

    # Clean up tarball
    rm -f "peervault-$NEW_VERSION.tar.gz"

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
# Local S3 Server (MinIO for cloud sync testing)
# ============================================================================

# Directory for MinIO data
minio_dir := ".minio"
minio_log := ".minio/minio.log"
minio_pid := ".minio/minio.pid"
minio_port := "9000"
minio_console := "9001"
minio_user := "minioadmin"
minio_pass := "minioadmin"
minio_bucket := "peervault-test"

# Install MinIO server and client if not present
minio-install:
    #!/usr/bin/env bash
    set -e
    mkdir -p .local/bin

    # Detect OS and arch
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)
    case $ARCH in
        x86_64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
    esac

    # Install MinIO server
    if command -v minio &> /dev/null; then
        echo "MinIO server already installed"
    elif [ -f ".local/bin/minio" ]; then
        echo "MinIO server found in .local/bin"
    else
        echo "Installing MinIO server..."
        curl -L "https://dl.min.io/server/minio/release/${OS}-${ARCH}/minio" -o .local/bin/minio
        chmod +x .local/bin/minio
        echo "Installed MinIO server to .local/bin/minio"
    fi

    # Install MinIO client (mc)
    if command -v mc &> /dev/null; then
        echo "MinIO client (mc) already installed"
    elif [ -f ".local/bin/mc" ]; then
        echo "MinIO client found in .local/bin"
    else
        echo "Installing MinIO client (mc)..."
        curl -L "https://dl.min.io/client/mc/release/${OS}-${ARCH}/mc" -o .local/bin/mc
        chmod +x .local/bin/mc
        echo "Installed MinIO client to .local/bin/mc"
    fi

# Start local MinIO server
minio-start: minio-install
    #!/usr/bin/env bash
    set -e
    mkdir -p {{minio_dir}}/data

    # Check if already running
    if [ -f "{{minio_pid}}" ]; then
        PID=$(cat "{{minio_pid}}")
        if kill -0 "$PID" 2>/dev/null; then
            echo "MinIO already running (PID $PID)"
            echo "Console: http://localhost:{{minio_console}}"
            echo "S3 API:  http://localhost:{{minio_port}}"
            exit 0
        fi
        rm "{{minio_pid}}"
    fi

    # Find MinIO binary
    MINIO_BIN=""
    if command -v minio &> /dev/null; then
        MINIO_BIN="minio"
    elif [ -f ".local/bin/minio" ]; then
        MINIO_BIN=".local/bin/minio"
    else
        echo "Error: MinIO not found. Run 'just minio-install' first."
        exit 1
    fi

    echo "Starting MinIO server..."

    # Start MinIO
    MINIO_ROOT_USER={{minio_user}} \
    MINIO_ROOT_PASSWORD={{minio_pass}} \
        "$MINIO_BIN" server {{minio_dir}}/data \
        --address ":{{minio_port}}" \
        --console-address ":{{minio_console}}" \
        > "{{minio_log}}" 2>&1 &

    PID=$!
    echo "$PID" > "{{minio_pid}}"

    # Wait for startup
    sleep 2
    if kill -0 "$PID" 2>/dev/null; then
        echo "MinIO started (PID $PID)"
        echo ""
        echo "Console: http://localhost:{{minio_console}}"
        echo "S3 API:  http://localhost:{{minio_port}}"
        echo ""
        echo "Credentials:"
        echo "  Access Key: {{minio_user}}"
        echo "  Secret Key: {{minio_pass}}"
        echo ""
        echo "Creating test bucket..."
        just minio-create-bucket
    else
        echo "Error: MinIO failed to start. Check {{minio_log}}"
        cat "{{minio_log}}"
        exit 1
    fi

# Create the test bucket
minio-create-bucket:
    #!/usr/bin/env bash
    set -e
    # Find mc binary
    MC_BIN=""
    if command -v mc &> /dev/null; then
        MC_BIN="mc"
    elif [ -f ".local/bin/mc" ]; then
        MC_BIN=".local/bin/mc"
    else
        echo "Error: mc not found. Run 'just minio-install' first."
        exit 1
    fi

    # Configure mc alias for local MinIO
    "$MC_BIN" alias set local http://localhost:{{minio_port}} {{minio_user}} {{minio_pass}} --api S3v4 2>/dev/null || true

    # Create bucket (ignore if exists)
    "$MC_BIN" mb local/{{minio_bucket}} 2>/dev/null || echo "Bucket already exists"
    echo "Bucket '{{minio_bucket}}' ready"

# Stop MinIO server
minio-stop:
    #!/usr/bin/env bash
    if [ -f "{{minio_pid}}" ]; then
        PID=$(cat "{{minio_pid}}")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping MinIO (PID $PID)..."
            kill "$PID"
            rm "{{minio_pid}}"
            echo "MinIO stopped"
        else
            echo "MinIO not running (stale PID file)"
            rm "{{minio_pid}}"
        fi
    else
        PIDS=$(pgrep -f "minio server" || true)
        if [ -n "$PIDS" ]; then
            echo "Killing MinIO processes: $PIDS"
            pkill -f "minio server" || true
        else
            echo "MinIO not running"
        fi
    fi

# Show MinIO status
minio-status:
    #!/usr/bin/env bash
    if [ -f "{{minio_pid}}" ]; then
        PID=$(cat "{{minio_pid}}")
        if kill -0 "$PID" 2>/dev/null; then
            echo "MinIO running (PID $PID)"
            echo "Console: http://localhost:{{minio_console}}"
            echo "S3 API:  http://localhost:{{minio_port}}"
            echo ""
            echo "Cloud Sync Config:"
            echo "  Endpoint:   http://localhost:{{minio_port}}"
            echo "  Bucket:     {{minio_bucket}}"
            echo "  Access Key: {{minio_user}}"
            echo "  Secret Key: {{minio_pass}}"
            echo "  Region:     us-east-1"
            echo ""
            if [ -f "{{minio_log}}" ]; then
                echo "Recent logs:"
                tail -5 "{{minio_log}}"
            fi
        else
            echo "MinIO not running (stale PID file)"
        fi
    else
        PIDS=$(pgrep -f "minio server" || true)
        if [ -n "$PIDS" ]; then
            echo "MinIO running (PIDs: $PIDS) - not managed by just"
        else
            echo "MinIO not running"
        fi
    fi

# Tail MinIO logs
minio-logs:
    #!/usr/bin/env bash
    if [ -f "{{minio_log}}" ]; then
        tail -f "{{minio_log}}"
    else
        echo "No MinIO log found. Start with 'just minio-start'"
    fi

# Clean MinIO data
minio-clean: minio-stop
    rm -rf {{minio_dir}}
    echo "MinIO data cleaned"

# ============================================================================
# Docker E2E Testing (containerized Obsidian)
# ============================================================================

# Build Docker image for E2E testing
docker-e2e-build:
    docker compose -f docker/e2e/docker-compose.yml build

# Start E2E testing containers
docker-e2e-up:
    #!/usr/bin/env bash
    set -e
    # Build first if needed
    docker compose -f docker/e2e/docker-compose.yml up -d
    echo "Waiting for containers to be healthy..."
    sleep 10
    # Check health
    for port in 9222 9223 9224; do
        if curl -s "http://localhost:$port/json/version" > /dev/null; then
            echo "  Port $port: OK"
        else
            echo "  Port $port: waiting..."
        fi
    done
    echo ""
    echo "Containers started. Run 'just docker-e2e-test' to run tests."

# Stop E2E testing containers
docker-e2e-down:
    docker compose -f docker/e2e/docker-compose.yml down

# Run E2E tests against Docker containers
docker-e2e-test:
    E2E_DOCKER=1 bun run test:e2e --docker

# Full Docker E2E workflow: build, start, test, stop
docker-e2e: docker-e2e-build docker-e2e-up
    #!/usr/bin/env bash
    set -e
    echo "Running E2E tests against Docker containers..."
    E2E_DOCKER=1 bun run test:e2e --docker || true
    echo ""
    echo "Stopping containers..."
    just docker-e2e-down

# Show Docker container logs
docker-e2e-logs:
    docker compose -f docker/e2e/docker-compose.yml logs -f

# Shell into Docker container
docker-e2e-shell:
    docker compose -f docker/e2e/docker-compose.yml exec obsidian-e2e bash

# Clean Docker volumes and rebuild
docker-e2e-clean:
    docker compose -f docker/e2e/docker-compose.yml down -v
    docker compose -f docker/e2e/docker-compose.yml build --no-cache

# ============================================================================
# Scalable E2E Testing (Multiple Clients)
# ============================================================================

# Generate docker-compose for N clients
docker-e2e-generate num_clients="5":
    #!/usr/bin/env bash
    cd docker/e2e
    ./generate-compose.sh {{num_clients}} docker-compose.generated.yml
    echo "Generated docker-compose.generated.yml with {{num_clients}} clients"
    echo "Ports: 9222-$((9221 + {{num_clients}}))"

# Build scaled E2E containers
docker-e2e-scale-build num_clients="5":
    #!/usr/bin/env bash
    set -e
    cd docker/e2e
    ./generate-compose.sh {{num_clients}} docker-compose.generated.yml
    echo "Building {{num_clients}} client containers..."
    docker compose -f docker-compose.generated.yml build

# Start N client containers
docker-e2e-scale-up num_clients="5":
    #!/usr/bin/env bash
    set -e
    cd docker/e2e
    if [ ! -f docker-compose.generated.yml ]; then
        ./generate-compose.sh {{num_clients}} docker-compose.generated.yml
    fi
    echo "Starting {{num_clients}} client containers..."
    docker compose -f docker-compose.generated.yml up -d
    echo ""
    echo "Waiting for containers to be ready..."

    # Wait for each client to respond to CDP
    MAX_WAIT=180
    for i in $(seq 1 {{num_clients}}); do
        port=$((9221 + i))
        echo -n "  Waiting for client-$i (port $port)..."
        elapsed=0
        while [ $elapsed -lt $MAX_WAIT ]; do
            if curl -s "http://localhost:$port/json/version" > /dev/null 2>&1; then
                echo " ready!"
                break
            fi
            sleep 5
            elapsed=$((elapsed + 5))
            echo -n "."
        done
        if [ $elapsed -ge $MAX_WAIT ]; then
            echo " TIMEOUT (container may still be starting)"
        fi
    done
    echo ""
    echo "Client endpoints:"
    for i in $(seq 1 {{num_clients}}); do
        port=$((9221 + i))
        echo "  client-$i: http://localhost:$port"
    done

# Stop scaled containers
docker-e2e-scale-down:
    docker compose -f docker/e2e/docker-compose.generated.yml down 2>/dev/null || echo "No scaled containers running"

# Run E2E tests against N clients (scaled runner)
docker-e2e-scale-test num_clients="5":
    #!/usr/bin/env bash
    set -e
    # Generate list of CDP endpoints
    ENDPOINTS=""
    for i in $(seq 1 {{num_clients}}); do
        port=$((9221 + i))
        if [ -n "$ENDPOINTS" ]; then
            ENDPOINTS="$ENDPOINTS,"
        fi
        ENDPOINTS="${ENDPOINTS}localhost:$port"
    done
    echo "Testing with endpoints: $ENDPOINTS"
    E2E_DOCKER=1 E2E_CDP_ENDPOINTS="$ENDPOINTS" bun run test:e2e:scaled --clients={{num_clients}}

# Full scaled workflow: generate, build, start, test
docker-e2e-scale num_clients="5": (docker-e2e-scale-build num_clients) (docker-e2e-scale-up num_clients)
    #!/usr/bin/env bash
    set -e
    echo "Running E2E tests with {{num_clients}} clients..."
    just docker-e2e-scale-test {{num_clients}} || true
    echo ""
    echo "Stopping containers..."
    just docker-e2e-scale-down

# Show status of scaled containers
docker-e2e-scale-status:
    docker compose -f docker/e2e/docker-compose.generated.yml ps 2>/dev/null || echo "No scaled containers"

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
