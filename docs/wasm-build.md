# WASM Build Guide for peervault-iroh

This document explains how to build the Iroh WASM module for PeerVault, including the specific requirements for NixOS.

## Overview

PeerVault uses [Iroh](https://iroh.computer) for P2P networking. Iroh is a Rust library that we compile to WebAssembly (WASM) to run in the browser environment (Obsidian uses Chromium).

## The Ring Crate Problem

Iroh depends on `rustls` for TLS, which depends on `ring` for cryptography. The `ring` crate contains C code for performance-critical cryptographic operations.

When compiling to WASM, this C code must be cross-compiled using a WASM-compatible C compiler. If compiled incorrectly, the resulting WASM will have `"env"` imports - references to native functions that don't exist in the browser, causing runtime errors like:

```
LinkError: WebAssembly.instantiate(): Import #70 "env" "ring_core_0_17_14__x25519_ge_frombytes_vartime":
function import requires a callable
```

## NixOS-Specific Solution

On NixOS, the standard `clang` is wrapped with additional flags for the Nix environment. Some of these flags (like `-fzero-call-used-regs=used-gpr`) are not supported by the WASM target, causing compilation to fail or fall back to native code.

The solution is documented in [iroh GitHub Discussion #3200](https://github.com/n0-computer/iroh/discussions/3200):

1. Use **unwrapped clang** from LLVM packages: `llvmPackages.clang-unwrapped`
2. Set `CC_wasm32_unknown_unknown=clang` for the `cc` crate

This is configured in `flake.nix`:

```nix
buildInputs = [
  # ... other packages ...
  llvmPackages.clang-unwrapped  # Unwrapped clang for WASM cross-compilation
];

shellHook = ''
  # WASM cross-compilation: use clang for ring crate
  export CC_wasm32_unknown_unknown=clang
'';
```

## Building

### Prerequisites

1. Enter the Nix development shell:
   ```sh
   nix develop
   ```

2. Verify the environment variable is set:
   ```sh
   echo $CC_wasm32_unknown_unknown  # Should print: clang
   ```

### Build Commands

```sh
# Build WASM module
just wasm

# Clean and rebuild from scratch
just wasm-clean

# Verify WASM has no native imports
just wasm-check
```

### What `just wasm` Does

1. Changes to `peervault-iroh/` directory
2. Runs `wasm-pack build --target web --release`
3. Output goes to `peervault-iroh/pkg/`

### Verifying the Build

Run `just wasm-check` to verify the WASM has no `"env"` imports:

```
$ just wasm-check
Checking WASM for native code imports...
Total imports: 141
Env imports: 0
OK: WASM is clean (no env imports)
```

If you see `Env imports: > 0`, the build used native code and will fail at runtime.

## Troubleshooting

### "env" imports in WASM

**Symptom**: `just wasm-check` shows env imports > 0

**Cause**: The C compiler used for ring wasn't WASM-compatible

**Solution**:
1. Make sure you're in `nix develop` shell
2. Verify `echo $CC_wasm32_unknown_unknown` returns `clang`
3. Run `just wasm-clean` to force a full rebuild

### wasm-opt errors

**Symptom**: Build fails with wasm-opt errors about bulk memory operations

**Solution**: This is disabled via `Cargo.toml`:
```toml
[package.metadata.wasm-pack.profile.release]
wasm-opt = false
```

### LinkError at runtime

**Symptom**: Obsidian console shows `LinkError: WebAssembly.instantiate()` with "env" imports

**Cause**: The WASM binary has native code that can't run in browser

**Solution**: Rebuild with `just wasm-clean && just wasm` and verify with `just wasm-check`

### wasm-bindgen version mismatch

**Symptom**: Build fails with version mismatch error

**Solution**: The `wasm-bindgen` version is pinned in `Cargo.toml`:
```toml
wasm-bindgen = "=0.2.105"
```

Make sure this matches the version expected by Iroh.

## How the WASM is Bundled

The build process:

1. `wasm-pack` compiles Rust to WASM and generates JS bindings in `peervault-iroh/pkg/`
2. `esbuild.config.mjs` inlines the WASM as base64 in the final `dist/main.js`
3. At runtime, the plugin decodes and instantiates the WASM

This approach ensures the plugin is self-contained (no external file loading needed).

## References

- [Iroh WASM Browser Support](https://docs.iroh.computer/deployment/wasm-browser-support)
- [GitHub Discussion #3200: NixOS WASM Build](https://github.com/n0-computer/iroh/discussions/3200)
- [ring crate WASM issues](https://github.com/briansmith/ring/issues?q=wasm)
