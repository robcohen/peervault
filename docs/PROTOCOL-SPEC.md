# PeerVault Sync Protocol Specification

**Status**: Draft (documenting current implementation)
**Version**: 0.1
**Date**: 2026-02-09

## Overview

PeerVault is a P2P document synchronization protocol designed for collaborative editing across devices. It combines:

- **CRDT-based conflict resolution** (Loro)
- **Relay-assisted P2P transport** (Iroh/QUIC)
- **Content-addressed blob storage**
- **Vault key encryption** for cloud backup

This document describes the current protocol implementation, identifies architectural issues, and proposes a cleaner design suitable for embedding in multiple host applications.

---

## 1. Current Architecture

### 1.1 Layer Stack

```
┌─────────────────────────────────────────────────────────┐
│                    Host Application                      │
│                 (Obsidian, VS Code, etc.)               │
├─────────────────────────────────────────────────────────┤
│                    Plugin Layer (TS)                     │
│         UI, Settings, File System Integration           │
├─────────────────────────────────────────────────────────┤
│                  Protocol Layer (TS)                     │
│    SyncSession, PeerManager, DocumentManager            │
│    ~2500 lines of state machine logic                   │
├─────────────────────────────────────────────────────────┤
│                  Transport Layer (TS)                    │
│    IrohTransport, HybridTransport, WebRTC               │
│    Stream management, callback routing                  │
├─────────────────────────────────────────────────────────┤
│                    WASM Layer (Rust)                     │
│    Iroh networking, Loro CRDT                           │
│    Connection/stream primitives only                    │
└─────────────────────────────────────────────────────────┘
```

**Problem**: Protocol logic is in TypeScript, making it:
- Hard to test in isolation
- Vulnerable to JS async edge cases
- Not portable to non-JS hosts
- Duplicated if we want native mobile apps

### 1.2 Message Types

The protocol uses 22 message types multiplexed over a single bidirectional QUIC stream:

| Code | Name | Category | Purpose |
|------|------|----------|---------|
| 0x01 | VERSION_INFO | Handshake | Exchange vault ID, version vectors, peer info |
| 0x02 | UPDATES | Sync | CRDT delta updates |
| 0x03 | SNAPSHOT_REQUEST | Sync | Request full CRDT state |
| 0x04 | SNAPSHOT | Sync | Full CRDT state response |
| 0x05 | SNAPSHOT_CHUNK | Sync | Chunked snapshot for large docs |
| 0x06 | SYNC_COMPLETE | Sync | Sync phase finished |
| 0x07 | ERROR | Control | Error with code and message |
| 0x08 | PING | Keepalive | Liveness check |
| 0x09 | PONG | Keepalive | Liveness response |
| 0x10 | BLOB_HASHES | Blob | List of blob hashes we have |
| 0x11 | BLOB_REQUEST | Blob | Request specific blobs |
| 0x12 | BLOB_DATA | Blob | Blob content transfer |
| 0x13 | BLOB_SYNC_COMPLETE | Blob | Blob sync finished |
| 0x20 | PEER_REMOVED | Mesh | Notify peer removal |
| 0x21 | PEER_ANNOUNCEMENT | Mesh | Announce new/updated peers |
| 0x22 | PEER_REQUEST | Mesh | Request peer list |
| 0x23 | PEER_LEFT | Mesh | Notify peer departure |
| 0x30 | KEY_EXCHANGE_REQUEST | Crypto | Request vault encryption key |
| 0x31 | KEY_EXCHANGE_RESPONSE | Crypto | Provide encrypted vault key |
| 0x40 | WEBRTC_OFFER | Transport | WebRTC SDP offer |
| 0x41 | WEBRTC_ANSWER | Transport | WebRTC SDP answer |
| 0x42 | WEBRTC_ICE_CANDIDATE | Transport | ICE candidate |
| 0x43 | WEBRTC_READY | Transport | WebRTC channel ready |
| 0x44 | WEBRTC_FAILED | Transport | WebRTC upgrade failed |

**Problem**: Too many concerns multiplexed on one stream:
- Sync protocol
- Blob transfer
- Peer discovery
- Key exchange
- Transport upgrade signaling

### 1.3 Wire Format

All messages share a common header:

```
┌─────────┬────────────────────┬─────────────────────┐
│ type(1) │   timestamp(8)     │    payload(var)     │
│  u8     │      u64 BE        │        ...          │
└─────────┴────────────────────┴─────────────────────┘
```

Strings are length-prefixed (u32 or u16 depending on context).
Binary data is length-prefixed (u32).

### 1.4 Session State Machine

```
                    ┌─────────┐
                    │  idle   │
                    └────┬────┘
                         │ connect/accept
                         ▼
              ┌─────────────────────┐
              │ exchanging_versions │
              └──────────┬──────────┘
                         │ VERSION_INFO exchanged
                         ▼
                  ┌─────────────┐
                  │   syncing   │◄────────┐
                  └──────┬──────┘         │
                         │                │ live updates
              ┌──────────┼──────────┐     │
              ▼          ▼          ▼     │
         [snapshot] [updates] [blobs]     │
              │          │          │     │
              └──────────┴──────────┘     │
                         │ SYNC_COMPLETE  │
                         ▼                │
                    ┌─────────┐           │
                    │  live   │───────────┘
                    └────┬────┘
                         │ error/disconnect
                         ▼
                    ┌─────────┐
                    │  error  │
                    └─────────┘
```

**Problem**: State transitions are implicit and scattered across 2500+ lines of TypeScript.

---

## 2. Protocol Flows

### 2.1 Initial Sync (Initiator)

```
Initiator                              Acceptor
    │                                      │
    │─────── open QUIC stream ────────────▶│
    │                                      │
    │─────── VERSION_INFO ────────────────▶│
    │         vaultId, versionBytes,       │
    │         ticket, hostname, hasVaultKey│
    │                                      │
    │◀─────── VERSION_INFO ────────────────│
    │                                      │
    │         [compare version vectors]    │
    │                                      │
    │◀─────── UPDATES (if acceptor ahead) ─│
    │                                      │
    │─────── UPDATES (if initiator ahead) ▶│
    │                                      │
    │─────── BLOB_HASHES ─────────────────▶│
    │◀─────── BLOB_HASHES ─────────────────│
    │                                      │
    │◀─────── BLOB_REQUEST ────────────────│
    │─────── BLOB_DATA (for each) ────────▶│
    │                                      │
    │─────── BLOB_REQUEST ────────────────▶│
    │◀─────── BLOB_DATA (for each) ────────│
    │                                      │
    │─────── SYNC_COMPLETE ───────────────▶│
    │◀─────── SYNC_COMPLETE ───────────────│
    │                                      │
    │         [enter live mode]            │
    │                                      │
```

### 2.2 Live Mode

After initial sync, the session enters "live" mode:

1. **PING/PONG**: Exchanged every 30s for liveness
2. **UPDATES**: Sent when local CRDT changes (micro-batched 15ms)
3. **BLOB_REQUEST/BLOB_DATA**: On-demand blob fetching
4. **KEY_EXCHANGE_***: Vault key gossip (one-shot, easily missed)

**Problem**: Key exchange happens once at live mode entry. If missed, no retry mechanism.

### 2.3 Pairing Flow

```
Device A (has vault)                    Device B (joining)
    │                                          │
    │  [User clicks "Add Device"]              │
    │  [Shows QR code with ticket]             │
    │                                          │
    │                    [User scans QR]       │
    │                                          │
    │◀─────────── connect with ticket ─────────│
    │                                          │
    │  [Unknown peer detected]                 │
    │  [Show pairing request in UI]            │
    │                                          │
    │  [User approves]                         │
    │                                          │
    │─────────── save peer, close conn ───────▶│
    │                                          │
    │  [Device B retries connection]           │
    │                                          │
    │◀─────────── reconnect ───────────────────│
    │                                          │
    │  [Now known peer, accept sync]           │
    │                                          │
```

**Problem**: Pairing requires connection close/reopen cycle. Error-prone.

---

## 3. Identified Problems

### 3.1 Protocol Design Issues

1. **Single-stream multiplexing**: All message types on one stream creates ordering dependencies and head-of-line blocking.

2. **Implicit state machine**: No formal state machine; transitions scattered across code.

3. **One-shot key exchange**: Vault key gossip happens once at live mode entry. If the receiver isn't ready, the key is never delivered.

4. **Coupled concerns**: Sync protocol, blob transfer, peer discovery, key exchange, and transport signaling are all mixed together.

5. **No message acknowledgment**: Fire-and-forget for most messages. No way to know if peer received.

6. **Timestamp in every message**: 8 bytes per message for timestamps that are rarely used.

### 3.2 Implementation Issues

1. **Protocol logic in TypeScript**: ~2500 lines of state machine in `sync-session.ts`, vulnerable to async bugs.

2. **Callback hell**: Stream callbacks registered multiple times, competing for messages.

3. **Session/stream lifecycle mismatch**: Sessions outlive their streams, leading to "live" sessions that can't communicate.

4. **No backpressure**: Blob transfers can overwhelm slow connections.

5. **Host-coupled**: Current design assumes Obsidian's file system and settings APIs.

---

## 4. Comparison to Canonical Protocols

### 4.1 Automerge Sync Protocol

Automerge uses a simpler approach:
- **Sync messages** contain bloom filters of known changes
- **Response** contains missing changes
- **No separate handshake** - every message is self-describing
- **Idempotent** - can replay messages safely

```
┌─────────────────────────────────────────┐
│            Automerge Sync               │
├─────────────────────────────────────────┤
│ 1. Send bloom filter of our heads       │
│ 2. Receive bloom filter of their heads  │
│ 3. Send changes they're missing         │
│ 4. Receive changes we're missing        │
│ 5. Repeat until converged               │
└─────────────────────────────────────────┘
```

**Lesson**: Simpler is better. No complex state machine needed.

### 4.2 libp2p Protocol Multiplexing

libp2p uses protocol negotiation per stream:
- Each protocol gets its own stream
- Protocols are identified by path-like IDs: `/ipfs/kad/1.0.0`
- Clean separation of concerns

```
Connection
├── Stream 1: /peervault/sync/1.0
├── Stream 2: /peervault/blob/1.0
├── Stream 3: /peervault/keyex/1.0
└── Stream 4: /peervault/mesh/1.0
```

**Lesson**: Use multiple streams, one per protocol.

### 4.3 Signal Protocol (Key Exchange)

Signal's X3DH key exchange:
- Prekey bundles published to server
- One-time keys for forward secrecy
- Explicit key exchange protocol, not piggybacked

**Lesson**: Key exchange should be a dedicated protocol, not an afterthought.

### 4.4 QUIC Streams

QUIC provides:
- Multiplexed streams over single connection
- Per-stream flow control
- No head-of-line blocking between streams

**Lesson**: We're using QUIC but not leveraging its stream multiplexing.

---

## 5. Proposed Architecture

### 5.1 New Layer Stack

```
┌─────────────────────────────────────────────────────────┐
│                    Host Application                      │
│              (Obsidian, VS Code, Logseq, etc.)          │
├─────────────────────────────────────────────────────────┤
│                   Host Bindings (thin)                   │
│         File system, settings, UI callbacks             │
│                    ~200 lines per host                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│              ┌─────────────────────────┐                │
│              │     WASM Core (Rust)    │                │
│              ├─────────────────────────┤                │
│              │  Protocol State Machine │                │
│              │  CRDT Operations (Loro) │                │
│              │  Message Serialization  │                │
│              │  Blob Management        │                │
│              │  Key Management         │                │
│              │  Peer Management        │                │
│              └─────────────────────────┘                │
│                          │                              │
├──────────────────────────┼──────────────────────────────┤
│                   Transport Layer                        │
│              Iroh QUIC / WebRTC Bridge                  │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Protocol Separation

Split into independent sub-protocols, each on its own stream:

| Protocol | Stream | Purpose |
|----------|--------|---------|
| `/pv/sync/1` | Bidirectional | CRDT sync (version exchange, deltas) |
| `/pv/blob/1` | Bidirectional | Content-addressed blob transfer |
| `/pv/keys/1` | Bidirectional | Vault key exchange |
| `/pv/mesh/1` | Bidirectional | Peer discovery and announcements |
| `/pv/ctrl/1` | Bidirectional | Connection control, errors |

### 5.3 Simplified Sync Protocol

Inspired by Automerge:

```
message SyncRequest {
    vault_id: [u8; 32],
    version_vector: VersionVector,
    bloom_filter: BloomFilter,  // of known change IDs
}

message SyncResponse {
    changes: Vec<Change>,       // changes peer is missing
    blob_refs: Vec<BlobRef>,    // blobs referenced by changes
}
```

Flow:
1. Open `/pv/sync/1` stream
2. Send `SyncRequest`
3. Receive `SyncResponse` with missing changes
4. Apply changes to local CRDT
5. Send our `SyncResponse` with changes they're missing
6. Repeat until both sides send empty response
7. Keep stream open for live updates

### 5.4 Dedicated Key Exchange

On `/pv/keys/1` stream:

```
message KeyRequest {
    requester_public_key: [u8; 32],  // X25519
}

message KeyResponse {
    encrypted_vault_key: Vec<u8>,    // Encrypted to requester's public key
    key_id: [u8; 32],                // Hash of vault key for verification
}

message KeyAck {
    key_id: [u8; 32],                // Confirms receipt
}
```

Key exchange can be initiated anytime, not just at session start.

### 5.5 Host Interface

Minimal interface the WASM core needs from host:

```rust
trait HostInterface {
    // File operations
    fn read_file(&self, path: &str) -> Result<Vec<u8>>;
    fn write_file(&self, path: &str, data: &[u8]) -> Result<()>;
    fn delete_file(&self, path: &str) -> Result<()>;
    fn list_files(&self, path: &str) -> Result<Vec<FileInfo>>;

    // Storage (key-value for settings, peer list, etc.)
    fn storage_get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    fn storage_set(&self, key: &str, value: &[u8]) -> Result<()>;

    // Events (host -> core)
    fn on_file_changed(&self, path: &str);

    // Callbacks (core -> host)
    fn notify_sync_progress(&self, progress: SyncProgress);
    fn notify_peer_status(&self, peer_id: &str, status: PeerStatus);
    fn request_user_approval(&self, request: ApprovalRequest) -> bool;
}
```

### 5.6 Transport Abstraction

The core doesn't care about transport details:

```rust
trait Transport {
    fn connect(&self, peer: &PeerInfo) -> Result<Connection>;
    fn accept(&self) -> Result<Connection>;
}

trait Connection {
    fn open_stream(&self, protocol: &str) -> Result<Stream>;
    fn accept_stream(&self) -> Result<(String, Stream)>;  // Returns protocol ID
    fn close(&self);
}

trait Stream {
    fn send(&self, data: &[u8]) -> Result<()>;
    fn recv(&self) -> Result<Vec<u8>>;
    fn close(&self);
}
```

Transport implementations:
- **IrohTransport**: QUIC via Iroh relay (current)
- **WebRTCBridge**: For browser environments
- **LocalTransport**: For testing

---

## 6. Migration Path

### Phase 1: Document & Stabilize
- [x] Document current protocol (this spec)
- [ ] Add protocol version negotiation
- [ ] Fix critical bugs (stream lifecycle, callback routing)

### Phase 2: Separate Protocols
- [ ] Split blob sync to separate stream
- [ ] Split key exchange to separate stream
- [ ] Split mesh protocol to separate stream

### Phase 3: Rust Core
- [ ] Implement protocol state machine in Rust
- [ ] Move CRDT operations to Rust
- [ ] Define stable host interface
- [ ] WASM bindings for JS hosts

### Phase 4: Multi-Host
- [ ] Extract Obsidian-specific code to host binding
- [ ] Create VS Code host binding
- [ ] Create CLI host for testing/scripting

---

## 7. Open Questions

1. **Backward compatibility**: How to support old clients during migration?

2. **WebRTC**: Keep as transport option or remove complexity?

3. **Cloud sync**: Should cloud backup be part of core or a host feature?

4. **Encryption**: Per-document keys or single vault key?

5. **Conflict UI**: How should hosts surface CRDT conflicts to users?

---

## Appendix A: Current Message Formats

### VERSION_INFO (0x01)

```
┌────────┬───────────┬─────────────┬──────────────┬────────────┐
│ type   │ timestamp │ vaultId     │ versionBytes │ ticket     │
│ u8     │ u64       │ u32+bytes   │ u32+bytes    │ u32+bytes  │
├────────┴───────────┴─────────────┴──────────────┴────────────┤
│ hostname    │ nickname     │ protocolVer │ pluginVer        │
│ u16+bytes   │ u16+bytes?   │ u8          │ u16+bytes?       │
├─────────────┴──────────────┴─────────────┴──────────────────┤
│ groupIds[]        │ knownPeers[]        │ hasVaultKey      │
│ u16+[u16+bytes]   │ u16+[peer...]       │ u8               │
└───────────────────┴─────────────────────┴──────────────────┘
```

### UPDATES (0x02)

```
┌────────┬───────────┬─────────┬──────────────┐
│ type   │ timestamp │ opCount │ updates      │
│ u8     │ u64       │ u32     │ u32+bytes    │
└────────┴───────────┴─────────┴──────────────┘
```

### BLOB_DATA (0x12)

```
┌────────┬───────────┬──────────┬────────────┬──────────┐
│ type   │ timestamp │ hash     │ mimeType   │ data     │
│ u8     │ u64       │ u16+str  │ u16+str?   │ u32+bytes│
└────────┴───────────┴──────────┴────────────┴──────────┘
```

### KEY_EXCHANGE_REQUEST (0x30)

```
┌────────┬───────────┬────────────────┬────────────────┐
│ type   │ timestamp │ publicKey      │ hasExistingKey │
│ u8     │ u64       │ u32+bytes(32)  │ u8             │
└────────┴───────────┴────────────────┴────────────────┘
```

---

## Appendix B: State Machine (Current)

```
States:
  - idle
  - exchanging_versions
  - syncing
  - live
  - error

Transitions:
  idle -> exchanging_versions: on startSync() or handleIncomingSync()
  exchanging_versions -> syncing: on valid VERSION_INFO exchange
  exchanging_versions -> error: on invalid vault ID or version mismatch
  syncing -> live: on SYNC_COMPLETE exchange
  syncing -> error: on timeout or protocol error
  live -> live: on UPDATES, PING, PONG, BLOB_*, KEY_EXCHANGE_*
  live -> error: on connection loss or fatal error
  * -> idle: on abort() or close()
```

---

## Appendix C: References

- [Automerge Sync Protocol](https://automerge.org/docs/how-it-works/sync/)
- [libp2p Specifications](https://github.com/libp2p/specs)
- [Signal Protocol](https://signal.org/docs/)
- [QUIC RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html)
- [Loro CRDT](https://loro.dev/)
- [Iroh](https://iroh.computer/)
