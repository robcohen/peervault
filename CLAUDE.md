# PeerVault - Claude Code Instructions

## Project Overview

PeerVault is an Obsidian plugin for P2P vault sync using Loro CRDTs and Iroh transport. No servers required.

- **Stack**: TypeScript, Obsidian API, Loro CRDT (WASM), Iroh networking (WASM)
- **Build**: `bun run build` or `just build`
- **Type check**: `bun run check` or `just check`
- **Package manager**: Bun (with Node.js available for Obsidian compatibility)
- **Dev shell**: `nix develop` (provides all tooling including Rust/WASM)

## Build & Release

See `RELEASING.md` for the full release checklist.

Quick build:
```sh
just build        # Build plugin
just wasm         # Rebuild Iroh WASM (if needed)
just wasm-check   # Verify WASM has no native imports
```

## WASM Build (peervault-core)

The core is a Rust crate (`peervault-core/`) compiled to WASM. **Requires nix develop shell.**

### Building WASM
```sh
nix develop                    # Enter dev shell
cd peervault-core
cargo build --target wasm32-unknown-unknown --features wasm --no-default-features
# Or for release:
cargo build --target wasm32-unknown-unknown --features wasm --no-default-features --release
```

### Verifying WASM
```sh
# Must show "0" — any env imports means native code leaked through
wasm-tools print target/wasm32-unknown-unknown/release/peervault_core.wasm | grep '"env"' | wc -l
```

### Key Dependencies (Cargo.toml)
- `iroh = "0.95"` — QUIC transport via relay
- `iroh-blobs = "0.97"` — Bao-verified blob transfer (MemStore for WASM)
- `iroh-gossip = "0.95"` — Epidemic broadcast (HyParView + PlumTree)
- `loro = "1.10"` — CRDT (LoroTree + LoroText)
- `chacha20poly1305` / `ecies` — Encryption
- `wasm-bindgen = "=0.2.105"` — Pinned for iroh compatibility

### Troubleshooting
- **"env" imports in WASM**: A dependency compiled native code. Check with `wasm-tools print`.
- **wasm-opt errors**: Disabled via `Cargo.toml` metadata (`wasm-opt = false`).
- **Rust version**: Some deps require Rust 1.95+. Pin `constant_time_eq` if needed: `cargo update constant_time_eq@0.4.3 --precise 0.4.2`

## Architecture

### Overview

The plugin has two layers:
1. **Rust WASM core** (`peervault-core/`) — all sync, transport, encryption, and CRDT logic
2. **TypeScript wrapper** (`src/`) — thin Obsidian plugin that calls the WASM module

### Key Directories
- `src/main.ts` - Obsidian plugin entry point, file watching, settings UI
- `src/core/peer-vault-client.ts` - TypeScript wrapper around WASM module
- `peervault-core/` - Rust WASM crate (the actual sync engine)
- `peervault-core/src/wasm.rs` - WASM bindings (WasmPeerVault, sync protocol)
- `peervault-core/src/store/` - Loro CRDT document store
- `peervault-core/src/net/` - Iroh transport layer
- `peervault-core/src/sync.rs` - SyncEngine (encrypted CRDT sync)
- `peervault-core/src/runner.rs` - SyncRunner (structured sync protocol)
- `peervault-core/src/blobs_bridge.rs` - iroh-blobs MemStore ↔ HostInterface bridge
- `peervault-core/src/gossip_bridge.rs` - iroh-gossip real-time CRDT broadcast
- `peervault-core/src/sync_handler.rs` - ProtocolHandler for sync ALPN
- `peervault-core/src/protocol.rs` - Wire format (V3 binary protocol)
- `e2e/` - End-to-end testing framework (CDP-based)

### Networking Stack (iroh Router)

Three protocols registered on a single iroh Endpoint via `iroh::protocol::Router`:

```
Router
  ├── SyncHandler     (ALPN: peervault/sync/1)  — initial full sync + pairing
  ├── BlobsProtocol   (ALPN: iroh-blobs)        — Bao-verified blob transfer
  └── Gossip          (ALPN: /iroh-gossip/1)    — real-time CRDT delta broadcast
```

- **Initial sync**: V3 binary protocol (VersionInfo → Updates → BlobHashes → BlobTransfer → SyncComplete)
- **Live sync**: iroh-gossip broadcasts encrypted Loro deltas on local changes (debounced 200ms)
- **Blob transfer**: iroh-blobs with MemStore, Bao-verified 16KB chunk streaming
- **Pairing**: One-time nonce in VersionInfo.pairing_nonce, validated by acceptor

### Sync Protocol (V3)
1. Initiator sends `VersionInfo` with `pairing_nonce` and `supports_iroh_blobs: true`
2. Acceptor validates pairing (known peer or valid nonce), sends its `VersionInfo`
3. Both exchange encrypted CRDT updates via `Updates` messages
4. If both support iroh-blobs: exchange `BlobHashes`, transfer via iroh-blobs ALPN
5. Exchange `SyncComplete`, sync done
6. After sync: both subscribe to gossip topic (TopicId = vault_id)
7. Subsequent changes broadcast via gossip (encrypted, debounced, max 64KB)
8. Deltas >64KB trigger `sync_needed` event → fallback to point-to-point sync

### Pairing Flow
1. Device A generates pairing ticket (transport ticket + encryption key + vault ID + nonce)
2. Device B pastes ticket, calls `connectPeer` (becomes initiator)
3. Initiator sends `VersionInfo` with the one-time nonce
4. Acceptor validates nonce against `pending_pairings`, adds to `known_peers`
5. Sync completes, both subscribe to gossip for live updates

### Connection Model
- Iroh QUIC connections via relay servers (default: `use1-1.relay.n0.computer`)
- `iroh::endpoint::Connection` is Clone + Send + Sync (no Mutex needed)
- Router dispatches incoming connections by ALPN
- Gossip uses HyParView (5 active + 30 passive peers) for topology management

## Key Files

- `src/main.ts` - Plugin entry point, commands, file watching, settings UI
- `src/core/peer-vault-client.ts` - TypeScript WASM wrapper, event handling
- `peervault-core/src/wasm.rs` - Main WASM entry point (WasmPeerVault)
- `peervault-core/src/net/transport.rs` - IrohTransport with Router
- `peervault-core/src/protocol.rs` - V3 binary wire format
- `peervault-core/src/gossip_bridge.rs` - Gossip subscription and broadcast
- `peervault-core/src/blobs_bridge.rs` - Blob transfer bridge
- `peervault-core/Cargo.toml` - Rust dependencies (iroh, iroh-blobs, iroh-gossip, loro)
- `esbuild.config.mjs` - Build config with WASM inlining

## Debugging

### Laptop (Desktop Obsidian)
Open dev console: Ctrl+Shift+I (or Cmd+Opt+I on Mac)

### Mobile (Android via ADB)
```sh
# Connect device
adb devices -l

# Forward WebView debug port (find PID from `adb logcat | grep obsidian`)
adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>

# List debug targets
curl -s http://localhost:9222/json

# Tail live console via CDP (Python)
uv run --with websockets python3 -c "
import json, asyncio, websockets
async def tail():
    uri = 'ws://localhost:9222/devtools/page/<PAGE_ID>'
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({'id': 1, 'method': 'Runtime.enable'}))
        await ws.recv()
        while True:
            msg = await asyncio.wait_for(ws.recv(), timeout=120)
            data = json.loads(msg)
            if data.get('method') == 'Runtime.consoleAPICalled':
                args = data['params'].get('args', [])
                text = ' '.join(a.get('value', a.get('description', '?')) for a in args)
                if 'PeerVault' in text:
                    print(f'[{data[\"params\"][\"type\"]}] {text}', flush=True)
asyncio.run(tail())
"
```

### In-App Log Export
Settings > PeerVault > Advanced > "Copy Logs" - copies last 200 log entries to clipboard.

## E2E Testing

The `e2e/` directory contains a comprehensive testing framework that runs against real Obsidian instances via CDP.

```sh
# Start Obsidian with CDP enabled
obsidian --remote-debugging-port=9222

# Open TEST and TEST2 vaults, then run:
bun run test:e2e              # Run all tests
bun run test:e2e --suite=02-sync-basic  # Run specific suite
bun run test:e2e --discover   # List available vaults
```

See `e2e/README.md` for full documentation including:
- Test suite descriptions
- Writing new tests
- Available assertions and utilities
- Troubleshooting guide

## Cloud Sync

Cloud sync (S3-compatible backup) is implemented in the Rust core at `peervault-core/src/cloud/`. Supports AWS S3, MinIO, Cloudflare R2, Backblaze B2.

### Key Files
- `peervault-core/src/cloud/sync.rs` - Upload/download deltas, retry logic
- `peervault-core/src/cloud/s3_client.rs` - S3-compatible client with AWS Signature V4
- `peervault-core/src/cloud/types.rs` - Cloud sync types

### Encryption
- **Content encryption**: XChaCha20-Poly1305 (vault key)
- **Key exchange**: ECIES (x25519 + XChaCha20-Poly1305) during pairing

## Known Issues & Gotchas

- **wasm-bindgen pinned**: `wasm-bindgen = "=0.2.105"` — must match iroh's version exactly.
- **iroh Connection is Clone**: Do NOT wrap in Mutex (causes deadlock on accept_bi/open_bi).
- **constant_time_eq**: May need pinning (`cargo update constant_time_eq@0.4.3 --precise 0.4.2`) if Rust version < 1.95.
- **Gossip max message size**: 64KB. CRDT deltas larger than this trigger `sync_needed` event for point-to-point fallback.
- **versions.json**: Must be updated with every release for BRAT compatibility.
- **dist/manifest.json**: Auto-copied by build from root `manifest.json`.
