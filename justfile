# PeerVault development commands
# Run `just` to see available commands

# Default: show help
default:
    @just --list

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

# Create a release build
release version:
    @echo "Building release {{version}}..."
    bun run build
    @echo "Updating manifest.json version to {{version}}..."
    jq '.version = "{{version}}"' manifest.json > manifest.json.tmp && mv manifest.json.tmp manifest.json
    @echo "Release {{version}} ready!"

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

# Run Playwright tests
e2e:
    bun run test:e2e

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
