#!/usr/bin/env bash
# Build peervault-iroh WASM module

set -e

echo "Building peervault-iroh WASM..."

# Build for web target
wasm-pack build --target web --release

# Optimize WASM size if wasm-opt is available
if command -v wasm-opt &> /dev/null; then
    echo "Optimizing WASM..."
    wasm-opt -Oz pkg/peervault_iroh_bg.wasm -o pkg/peervault_iroh_bg.wasm
fi

echo "Build complete! Output in pkg/"
