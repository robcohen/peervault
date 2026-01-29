# PeerVault - Claude Code Instructions

## Project Overview

PeerVault is an Obsidian plugin for P2P vault sync using Loro CRDTs and Iroh transport. No servers required.

- **Stack**: TypeScript, Obsidian API, Loro CRDT (WASM), Iroh networking (WASM)
- **Build**: esbuild via `node esbuild.config.mjs`
- **Type check**: `npx tsc --noEmit`
- **Package manager**: Uses Node.js (not Bun) for Obsidian plugin compatibility

## Build & Release

See `RELEASING.md` for the full release checklist.

Quick build:
```sh
node esbuild.config.mjs
```

## Architecture

### Key Directories
- `src/peer/` - Peer management, pairing, groups
- `src/sync/` - Sync protocol (version exchange, CRDT merge, blob sync)
- `src/transport/` - Iroh WASM transport layer (QUIC over relay)
- `src/core/` - Document manager, vault sync, storage adapters
- `src/ui/` - Obsidian UI (settings tab, status modal, modals)
- `src/crypto/` - Encryption services
- `src/utils/` - Logger, events
- `peervault-iroh/` - Rust/WASM crate for Iroh networking

### Sync Protocol
1. Initiator opens a QUIC stream and sends `VERSION_INFO`
2. Acceptor receives `VERSION_INFO`, validates vault ID, sends its own
3. Both exchange CRDT updates and blobs
4. Enter live mode with ping keepalives

### Pairing Flow
1. Device A shows QR/ticket in Settings > Devices > Add Device
2. Device B pastes ticket and connects (becomes initiator)
3. Device A sees unknown peer, shows pairing request in Settings
4. User accepts on Device A - peer is saved, stale connection closed
5. Device B reconnects (via retry cycle), Device A accepts as known peer
6. Sync completes with proper initiator/acceptor roles

**Critical**: The acceptor must NOT initiate sync after accepting pairing. Both sides being initiators causes a deadlock (both send VERSION_INFO on separate streams, neither reads the other's).

### Connection Model
- Iroh QUIC connections via relay servers (e.g., `use1-1.relay.n0.iroh-canary.iroh.link`)
- `iroh::endpoint::Connection` is Clone + Send + Sync (no Mutex needed)
- Transport auto-runs a stream accept loop per connection
- Reconnect: exponential backoff, 10 attempts max, capped at 30s

## Key Files

- `src/main.ts` - Plugin entry point, commands
- `src/peer/peer-manager.ts` - Core peer/pairing logic
- `src/sync/sync-session.ts` - Sync protocol implementation
- `src/transport/iroh-transport.ts` - WASM Iroh transport
- `src/ui/settings-tab.ts` - Settings with integrated pairing UI
- `src/ui/status-modal.ts` - Sync status display
- `src/utils/logger.ts` - Logger with buffer for "Copy Logs" feature
- `peervault-iroh/src/lib.rs` - Rust WASM bindings for Iroh
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

## Known Issues & Gotchas

- **Ring crate WASM**: Needs `cargo build` + `wasm-bindgen` (not `wasm-pack`). Pin `wasm-bindgen = "=0.2.105"`.
- **WASM Connection**: `iroh::endpoint::Connection` is Clone - do NOT wrap in Mutex (causes deadlock on accept_bi/open_bi).
- **versions.json**: Must be updated with every release for BRAT compatibility.
- **dist/manifest.json**: Auto-copied by build from root `manifest.json`.
