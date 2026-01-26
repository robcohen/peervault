# Mobile WASM Compatibility

This document explains how PeerVault achieves mobile (Android/iOS) compatibility for WebAssembly dependencies.

## The Problem

Obsidian mobile runs in a WebView (browser environment), not Node.js. Libraries like `loro-crdt` that are designed for Node.js use APIs that don't exist in browsers:

1. **`require('util')`** - Node.js module for `TextEncoder`/`TextDecoder`
2. **`require('crypto')`** - Node.js crypto module
3. **`require('fs')` / `require('path')`** - File system access for loading `.wasm` files
4. **Sync `WebAssembly.Module()`** - Blocked on mobile for modules >4KB

## The Solution

We use a custom esbuild transform plugin that modifies `loro-crdt` at build time to be browser-compatible. This follows the same pattern used by other working Obsidian WASM plugins like [obsidian-plugin-wasm-image](https://github.com/KawaNae/obsidian-plugin-wasm-image).

### Key Configuration

```javascript
// esbuild.config.mjs
const config = {
  platform: 'browser',  // NOT 'node'
  format: 'cjs',
  target: 'es2020',
  plugins: [loroTransformPlugin],
  // ...
};
```

### Transformations Applied

The `loroTransformPlugin` applies these transformations to `loro-crdt/nodejs`:

#### 1. TextEncoder/TextDecoder

```javascript
// Before (Node.js)
const { TextEncoder, TextDecoder } = require(`util`);

// After (Browser)
const TextEncoder = globalThis.TextEncoder;
const TextDecoder = globalThis.TextDecoder;
```

#### 2. Crypto Polyfill

The crypto polyfill in loro-crdt exists because the `getrandom` Rust crate needs `globalThis.crypto.getRandomValues()`. In Node.js ESM, this isn't available by default. But browsers already have `globalThis.crypto`, so we just replace the require:

```javascript
// Before (Node.js)
const { webcrypto } = require("crypto");

// After (Browser)
const webcrypto = globalThis.crypto; // Already available in browsers
```

See [getrandom issue #256](https://github.com/rust-random/getrandom/issues/256) for details.

#### 3. WASM Loading

Mobile browsers block synchronous `WebAssembly.Module()` for modules larger than 4KB. We inline the WASM as base64 and use async loading:

```javascript
// Before (Node.js - sync)
const path = require('path').join(__dirname, 'loro_wasm_bg.wasm');
const bytes = require('fs').readFileSync(path);
const wasmModule = new WebAssembly.Module(bytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, imports);

// After (Browser - async)
const wasmBase64 = "AGFzbQEAAAA..."; // Inlined at build time
const bytes = atob(wasmBase64);
const { instance } = await WebAssembly.instantiate(bytes, imports);
```

## Why This Approach?

### Why not use `loro-crdt/base64` or `loro-crdt/bundler`?

These versions use **top-level await**, which is not supported in CommonJS format (required by Obsidian).

From [loro-dev/loro issue #180](https://github.com/loro-dev/loro/issues/180):
> "It's supported by using `loro-crdt/base64`"

But this only works for ESM output, not CJS.

### Why not use `platform: 'node'`?

With `platform: 'node'`, esbuild leaves Node.js built-ins (like `require('crypto')`) as external requires. These fail at runtime in browser environments.

### Is the transform plugin a "hack"?

No - this is the **standard pattern** for WASM plugins on Obsidian mobile. The [obsidian-plugin-wasm-image](https://github.com/KawaNae/obsidian-plugin-wasm-image) plugin uses the exact same approach with its `fixJsquash` plugin.

## Waiting for WASM Initialization

Since WASM is loaded asynchronously, you must wait for it before using `loro-crdt`:

```typescript
// src/core/document-manager.ts
export async function waitForLoroWasm(): Promise<void> {
  const loroModule = await import('loro-crdt') as any;
  if (loroModule.__wasmReady) {
    await loroModule.__wasmReady;
  }
}

// src/main.ts
override async onload(): Promise<void> {
  await waitForLoroWasm();
  // Now safe to use loro-crdt
}
```

## Build Verification

After building, verify mobile compatibility:

```bash
# Should all be 0 (no Node.js requires)
grep -c 'require("crypto")' dist/main.js
grep -c 'require("util")' dist/main.js

# Should be >= 1 (async loading)
grep -c 'WebAssembly.instantiate' dist/main.js

# Should be 0 (no sync loading)
grep -c 'new WebAssembly.Module' dist/main.js

# Should be >= 1 (ready promise exported)
grep -c '__wasmReady' dist/main.js
```

## References

- [Obsidian Mobile Development Docs](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- [obsidian-plugin-wasm-image](https://github.com/KawaNae/obsidian-plugin-wasm-image) - Working example of WASM on mobile
- [getrandom issue #256](https://github.com/rust-random/getrandom/issues/256) - Why the crypto polyfill exists
- [loro-dev/loro issue #180](https://github.com/loro-dev/loro/issues/180) - CJS bundling discussion
- [WASM in Obsidian Plugin forum thread](https://forum.obsidian.md/t/wasm-in-obsidian-plugin/103577)
