# PeerVault Architecture

## Overview

PeerVault is an Obsidian plugin for peer-to-peer vault synchronization using CRDTs and QUIC transport.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Obsidian Plugin                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   main.ts   │  │  Settings   │  │   Status    │  │     Commands        │ │
│  │   (entry)   │  │    Tab      │  │    Modal    │  │  (sync, pair, etc)  │ │
│  └──────┬──────┘  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────┼───────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Core Layer                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │  PeerManager    │  │  DocumentManager │  │       VaultSync            │  │
│  │  - Peer CRUD    │  │  - Loro CRDT     │  │  - File watcher            │  │
│  │  - Pairing      │  │  - Snapshots     │  │  - CRDT <-> Files          │  │
│  │  - Reconnection │  │  - Updates       │  │  - Conflict tracking       │  │
│  └────────┬────────┘  └────────┬─────────┘  └─────────────────────────────┘  │
└───────────┼────────────────────┼────────────────────────────────────────────┘
            │                    │
            ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Sync Layer                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         SyncSession                                  │    │
│  │  - Protocol state machine (init → version → updates → blobs → live) │    │
│  │  - Message encoding/decoding                                         │    │
│  │  - Blob sync with parallel loading                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Transport Layer                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                       IrohTransport                                  │    │
│  │  - WASM endpoint management                                          │    │
│  │  - Connection pooling                                                │    │
│  │  - Stream multiplexing                                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Iroh WASM (peervault-iroh)                        │    │
│  │  - WasmEndpoint: QUIC endpoint with relay support                    │    │
│  │  - WasmConnection: Peer connection wrapper                           │    │
│  │  - WasmStream: Bidirectional byte stream                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Network                                         │
│  ┌───────────────┐         ┌───────────────┐         ┌───────────────┐      │
│  │  Relay Server │ ◄─────► │  Relay Server │ ◄─────► │  Relay Server │      │
│  │  (NAT traverse)│         │               │         │               │      │
│  └───────────────┘         └───────────────┘         └───────────────┘      │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Components

### Plugin Layer (`src/main.ts`, `src/ui/`)
- Entry point and lifecycle management
- Settings UI for configuration
- Status modal for sync progress
- Commands for manual operations

### Core Layer (`src/core/`, `src/peer/`)

**PeerManager** (`src/peer/peer-manager.ts`)
- Manages peer relationships and state
- Handles pairing flow (invite generation, acceptance)
- Automatic reconnection with exponential backoff
- Coordinates sync sessions

**DocumentManager** (`src/core/document-manager.ts`)
- Wraps Loro CRDT document
- Manages snapshots and incremental updates
- Tracks file metadata (path, hash, timestamps)

**VaultSync** (`src/core/vault-sync.ts`)
- Watches Obsidian vault for file changes
- Syncs CRDT state to/from actual files
- Handles conflict detection

### Sync Layer (`src/sync/`)

**SyncSession** (`src/sync/sync-session.ts`)
- Implements sync protocol state machine
- States: `init` → `version` → `updates` → `blobs` → `live`
- Handles both initiator and acceptor roles

**Protocol Messages** (`src/sync/messages.ts`)
- VERSION_INFO: Exchange vault ID and CRDT version
- UPDATES: CRDT update bytes
- BLOB_REQUEST/BLOB_DATA: Binary file sync
- PING/PONG: Keep-alive in live mode

### Transport Layer (`src/transport/`)

**IrohTransport** (`src/transport/iroh-transport.ts`)
- Manages WASM Iroh endpoint lifecycle
- Connection pooling and reuse
- Accept loop for incoming connections

**Iroh WASM** (`peervault-iroh/`)
- Rust crate compiled to WASM
- QUIC transport with relay fallback
- NAT traversal via relay servers

## Data Flow

### Sync Protocol

```
    Initiator                              Acceptor
        │                                      │
        │──────── VERSION_INFO ───────────────►│
        │                                      │
        │◄─────── VERSION_INFO ────────────────│
        │                                      │
        │──────── UPDATES ────────────────────►│
        │                                      │
        │◄─────── UPDATES ─────────────────────│
        │                                      │
        │──────── BLOB_REQUEST ───────────────►│
        │                                      │
        │◄─────── BLOB_DATA ───────────────────│
        │                                      │
        │◄─────── BLOB_REQUEST ────────────────│
        │                                      │
        │──────── BLOB_DATA ──────────────────►│
        │                                      │
        │◄─────────── PING ────────────────────│
        │                                      │
        │──────────── PONG ───────────────────►│
        │              (live mode)             │
```

### Pairing Flow

1. Device A generates invite (ticket JSON with node address)
2. Device B pastes invite, connects as initiator
3. Device A sees unknown peer, shows pairing request
4. User accepts on Device A
5. Both devices save peer info
6. Device B reconnects, sync begins

## Storage

### Plugin Data (`<vault>/.obsidian/plugins/peervault/`)
- `data.json`: Settings (relay servers, sync interval, etc.)
- `peervault-snapshot.bin`: Loro CRDT snapshot
- `peervault-peers.json`: Known peers and groups
- `peervault-transport-key`: Iroh identity key (32 bytes)

### Blob Store (`<vault>/.peervault/blobs/`)
- Content-addressed storage for binary files
- Files named by SHA-256 hash
- Metadata JSON alongside each blob

## Error Handling

See `src/errors/` for the structured error system:
- Error codes: `TRANSPORT_WASM_OOM`, `SYNC_TIMEOUT`, etc.
- Categories: network, storage, sync, transport, peer, config, platform
- Severity levels: info, warning, error, critical
- Recovery hints in error context

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Plugin entry, lifecycle |
| `src/peer/peer-manager.ts` | Peer & sync orchestration |
| `src/sync/sync-session.ts` | Sync protocol implementation |
| `src/transport/iroh-transport.ts` | WASM transport wrapper |
| `src/core/document-manager.ts` | Loro CRDT management |
| `src/core/vault-sync.ts` | File ↔ CRDT sync |
| `peervault-iroh/src/lib.rs` | Rust WASM bindings |
