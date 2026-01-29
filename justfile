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
