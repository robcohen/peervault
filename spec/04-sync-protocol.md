# Sync Protocol Spec

## Purpose

Define how the Loro vault document is synchronized between peers over Iroh connections. This is the core of conflict-free replication.

## Requirements

- **REQ-SP-01**: Sync MUST be conflict-free (no user intervention required)
- **REQ-SP-02**: Sync MUST work incrementally (not full vault transfer each time)
- **REQ-SP-03**: Sync MUST handle offline edits gracefully
- **REQ-SP-04**: Sync MUST be resumable after connection drops
- **REQ-SP-05**: Sync MUST preserve full edit history

## Protocol Overview

With Loro's single-document architecture, sync is simplified compared to multi-document approaches:

```
┌─────────────────────────────────────────────────────────────┐
│                       Sync Session                          │
├─────────────────────────────────────────────────────────────┤
│  1. Connection established (Iroh)                           │
│  2. Exchange version vectors                                │
│  3. Export updates since peer's version                     │
│  4. Import peer's updates                                   │
│  5. Both documents converge                                 │
│  6. Keep connection open for live updates                   │
└─────────────────────────────────────────────────────────────┘
```

## Loro Sync Mechanism

Loro uses **version vectors** to track causality and enable incremental sync:

```typescript
import { LoroDoc, VersionVector } from 'loro-crdt';

// Each peer tracks what it has
const myVersion: VersionVector = doc.version();

// Export only changes since peer's version
const updates: Uint8Array = doc.export({ mode: 'update', from: peerVersion });

// Import peer's changes
doc.import(peerUpdates);
// Loro automatically merges - no conflicts!
```

## Sequence Diagrams

### Full Sync Session

```
┌────────┐                                              ┌────────┐
│ Peer A │                                              │ Peer B │
│ v=15   │                                              │ v=12   │
└───┬────┘                                              └───┬────┘
    │                                                       │
    │ ──────────── Iroh Connection Established ──────────►  │
    │                                                       │
    │                 VERSION EXCHANGE                      │
    │ ─────────────── version-info (v=15) ──────────────►  │
    │ ◄─────────────── version-info (v=12) ──────────────  │
    │                                                       │
    │                 UPDATE EXCHANGE                       │
    │ ─── updates (export from v=12, contains v=13,14,15) ►│
    │ ◄── updates (export from v=15, contains nothing) ─── │
    │                                                       │
    │                    BOTH AT v=15                       │
    │ ─────────────── sync-complete ─────────────────────►  │
    │ ◄─────────────── sync-complete ─────────────────────  │
    │                                                       │
    │                 LIVE SYNC MODE                        │
    │ ◄═══════════ bidirectional updates ═══════════════► │
    │                (on local changes)                     │
    │                                                       │
```

### Concurrent Edits (Merge)

```
┌────────┐                                              ┌────────┐
│ Peer A │                                              │ Peer B │
│ v=10   │                                              │ v=10   │
└───┬────┘                                              └───┬────┘
    │                                                       │
    │ [Offline edits]                     [Offline edits]   │
    │ Edit file X                         Edit file Y       │
    │ v=11                                v=11'             │
    │                                                       │
    │ ──────────── Connection Restored ──────────────────►  │
    │                                                       │
    │ ─────────── version-info (v=11) ───────────────────►  │
    │ ◄─────────── version-info (v=11') ─────────────────  │
    │                                                       │
    │ [Both have changes the other doesn't]                 │
    │                                                       │
    │ ─────────── updates (v=11 changes) ────────────────►  │
    │ ◄─────────── updates (v=11' changes) ──────────────  │
    │                                                       │
    │ [Import and merge]                  [Import and merge]│
    │ v=12 (merged)                       v=12 (merged)     │
    │                                                       │
    │                BOTH CONVERGED AT v=12                 │
    │                                                       │
```

### Conflict-Free Merge Example

```
         Initial State: "Hello world"
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
    ┌────────┐              ┌────────┐
    │ Peer A │              │ Peer B │
    │ offline│              │ offline│
    └───┬────┘              └───┬────┘
        │                       │
    Edit: Insert               Edit: Insert
    "brave " at pos 6          "new " at pos 6
        │                       │
        ▼                       ▼
  "Hello brave world"     "Hello new world"
        │                       │
        └───────────┬───────────┘
                    │ SYNC
                    ▼
            ┌──────────────┐
            │  Loro Merge  │
            │   (Fugue)    │
            └──────┬───────┘
                   │
                   ▼
        "Hello brave new world"
         (or "Hello new brave world")

    Both insertions preserved!
    Order determined by peer IDs (deterministic)
    Fugue algorithm minimizes interleaving
```

## Version Vector Serialization

Loro's version vectors track the causal state of each peer. For network transmission, we serialize them to a compact binary format.

### Version Vector Format

```typescript
import { LoroDoc } from 'loro-crdt';

/**
 * Version vector is a map of PeerId -> Counter.
 * PeerId is a 128-bit identifier (32-char hex string), Counter is a 32-bit integer.
 */
interface SerializedVersionVector {
  /** Array of [peerId, counter] pairs, peerId is 32-char hex string */
  entries: Array<[string, number]>;
}

/**
 * Serialize a version vector for network transmission.
 * Uses JSON for simplicity - can be optimized to binary if needed.
 */
function serializeVersionVector(doc: LoroDoc): Uint8Array {
  const version = doc.version();
  // Version is a Map<PeerId, Counter>
  const entries = version.toJSON();
  const json = JSON.stringify(entries);
  return new TextEncoder().encode(json);
}

/**
 * Deserialize a version vector from network.
 */
function deserializeVersionVector(data: Uint8Array): Map<string, number> {
  const json = new TextDecoder().decode(data);
  const entries = JSON.parse(json);
  return new Map(Object.entries(entries));
}

/**
 * Check if we need updates from peer.
 * Returns true if peer has changes we don't have.
 */
function needsUpdatesFrom(localVersion: Map<string, number>, peerVersion: Map<string, number>): boolean {
  for (const [peerId, counter] of peerVersion) {
    const localCounter = localVersion.get(peerId) ?? 0;
    if (counter > localCounter) {
      return true;
    }
  }
  return false;
}
```

### Binary Format (Optimized)

For bandwidth-critical scenarios, use a compact binary encoding:

```
┌─────────────────────────────────────────────────────┐
│ Version Vector Binary Format (v2)                    │
├─────────────────────────────────────────────────────┤
│ u8:  version (0x02)                                  │
│ u16: entry_count (big-endian)                        │
│ For each entry:                                      │
│   u128: peer_id (big-endian, 16 bytes)              │
│   u32:  counter (big-endian)                         │
│ u32: checksum (CRC32C of all preceding bytes)        │
└─────────────────────────────────────────────────────┘
```

**Important**: Loro peer IDs are 128-bit (16 bytes), not 64-bit. Each peer ID is a cryptographically random identifier generated when a peer first edits a document.

```typescript
import { crc32c } from './crc32c';  // Use a CRC32C implementation

const VERSION_VECTOR_FORMAT_VERSION = 0x02;

/**
 * Peer ID is 128-bit (16 bytes). Loro represents this as a hex string
 * or BigInt depending on the API.
 */
type PeerId = string;  // 32-char hex string representing 128 bits

function serializeVersionVectorBinary(version: Map<PeerId, number>): Uint8Array {
  // Header (1) + entry_count (2) + entries (20 each) + checksum (4)
  const ENTRY_SIZE = 20;  // 16 bytes peer_id + 4 bytes counter
  const buffer = new ArrayBuffer(1 + 2 + version.size * ENTRY_SIZE + 4);
  const view = new DataView(buffer);

  // Version byte
  view.setUint8(0, VERSION_VECTOR_FORMAT_VERSION);

  // Entry count
  view.setUint16(1, version.size, false); // big-endian

  let offset = 3;
  for (const [peerId, counter] of version) {
    // PeerId is a 32-char hex string (128 bits = 16 bytes)
    // Split into high and low 64-bit parts
    const peerIdHex = peerId.padStart(32, '0');
    const highBits = BigInt('0x' + peerIdHex.slice(0, 16));
    const lowBits = BigInt('0x' + peerIdHex.slice(16, 32));

    view.setBigUint64(offset, highBits, false);      // High 64 bits
    view.setBigUint64(offset + 8, lowBits, false);   // Low 64 bits
    view.setUint32(offset + 16, counter, false);
    offset += ENTRY_SIZE;
  }

  // Calculate and append CRC32C checksum (excludes the checksum field itself)
  const dataToChecksum = new Uint8Array(buffer, 0, offset);
  const checksum = crc32c(dataToChecksum);
  view.setUint32(offset, checksum, false);

  return new Uint8Array(buffer);
}

function deserializeVersionVectorBinary(data: Uint8Array): Map<PeerId, number> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Validate format version
  const formatVersion = view.getUint8(0);
  if (formatVersion !== VERSION_VECTOR_FORMAT_VERSION) {
    // Handle legacy v1 format (64-bit peer IDs, no checksum) for migration
    if (formatVersion === 0x01 || (data.length > 2 && formatVersion < 0x10)) {
      return deserializeVersionVectorBinaryV1(data);
    }
    throw new Error(`Unknown version vector format: ${formatVersion}`);
  }

  const count = view.getUint16(1, false);
  const ENTRY_SIZE = 20;
  const expectedLength = 1 + 2 + count * ENTRY_SIZE + 4;

  if (data.length !== expectedLength) {
    throw new Error(`Invalid version vector length: expected ${expectedLength}, got ${data.length}`);
  }

  // Verify checksum
  const checksumOffset = 3 + count * ENTRY_SIZE;
  const storedChecksum = view.getUint32(checksumOffset, false);
  const dataToChecksum = new Uint8Array(data.buffer, data.byteOffset, checksumOffset);
  const computedChecksum = crc32c(dataToChecksum);

  if (storedChecksum !== computedChecksum) {
    throw new Error(`Version vector checksum mismatch: stored=${storedChecksum}, computed=${computedChecksum}`);
  }

  const result = new Map<PeerId, number>();
  let offset = 3;

  for (let i = 0; i < count; i++) {
    const highBits = view.getBigUint64(offset, false);
    const lowBits = view.getBigUint64(offset + 8, false);
    const counter = view.getUint32(offset + 16, false);

    // Reconstruct 128-bit peer ID as hex string
    const peerId = highBits.toString(16).padStart(16, '0') +
                   lowBits.toString(16).padStart(16, '0');

    result.set(peerId, counter);
    offset += ENTRY_SIZE;
  }

  return result;
}

/**
 * Legacy v1 deserializer for migration from 64-bit peer IDs.
 * Only used when receiving data from older peers.
 */
function deserializeVersionVectorBinaryV1(data: Uint8Array): Map<PeerId, number> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint16(0, false);
  const result = new Map<PeerId, number>();

  let offset = 2;
  for (let i = 0; i < count; i++) {
    const peerIdBigInt = view.getBigUint64(offset, false);
    const counter = view.getUint32(offset + 8, false);
    // Pad to 128-bit format for compatibility
    result.set(peerIdBigInt.toString(16).padStart(32, '0'), counter);
    offset += 12;
  }

  return result;
}
```

## Message Framing Format

All sync messages are transmitted over Iroh streams using a **length-prefixed framing protocol**. This ensures reliable message boundary detection.

### Wire Format

```
┌─────────────────────────────────────────────────────────────┐
│                    Message Frame Format                       │
├─────────────────────────────────────────────────────────────┤
│  Byte 0-3:   Length (u32, big-endian) - payload size only   │
│  Byte 4:     Message type (u8)                               │
│  Byte 5:     Flags (u8)                                      │
│  Byte 6-9:   Checksum (u32, CRC32C, optional)               │
│  Byte 10+:   Payload (variable length)                       │
└─────────────────────────────────────────────────────────────┘
```

### Message Type Codes

```typescript
const MESSAGE_TYPES = {
  VERSION_INFO:      0x01,
  UPDATES:           0x02,
  SNAPSHOT_REQUEST:  0x03,
  SNAPSHOT:          0x04,
  SNAPSHOT_CHUNK:    0x05,  // For large snapshots
  SYNC_COMPLETE:     0x06,
  ERROR:             0x07,
  PING:              0x08,
  PONG:              0x09,
} as const;
```

### Flags Byte

```typescript
const MESSAGE_FLAGS = {
  NONE:        0x00,
  COMPRESSED:  0x01,  // Payload is gzip compressed
  CHECKSUMMED: 0x02,  // Checksum field is present
  CHUNKED:     0x04,  // Part of a chunked transfer
  FINAL_CHUNK: 0x08,  // Last chunk in a sequence
} as const;
```

### Frame Implementation

```typescript
const MAX_MESSAGE_SIZE = 64 * 1024 * 1024; // 64MB max per message
const HEADER_SIZE = 6; // Without checksum
const HEADER_SIZE_WITH_CHECKSUM = 10;

interface MessageFrame {
  type: number;
  flags: number;
  payload: Uint8Array;
  checksum?: number;
}

/**
 * Encode a message into wire format.
 */
function encodeFrame(frame: MessageFrame): Uint8Array {
  const hasChecksum = (frame.flags & MESSAGE_FLAGS.CHECKSUMMED) !== 0;
  const headerSize = hasChecksum ? HEADER_SIZE_WITH_CHECKSUM : HEADER_SIZE;
  const totalSize = headerSize + frame.payload.length;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Length (payload only, not including header)
  view.setUint32(0, frame.payload.length, false); // big-endian

  // Type and flags
  view.setUint8(4, frame.type);
  view.setUint8(5, frame.flags);

  // Optional checksum
  if (hasChecksum) {
    const checksum = crc32c(frame.payload);
    view.setUint32(6, checksum, false);
    bytes.set(frame.payload, 10);
  } else {
    bytes.set(frame.payload, 6);
  }

  return bytes;
}

/**
 * Decode a message from wire format.
 */
function decodeFrame(data: Uint8Array): MessageFrame {
  if (data.length < HEADER_SIZE) {
    throw new Error('Frame too short');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const payloadLength = view.getUint32(0, false);
  const type = view.getUint8(4);
  const flags = view.getUint8(5);

  if (payloadLength > MAX_MESSAGE_SIZE) {
    throw new Error(`Payload too large: ${payloadLength} bytes`);
  }

  const hasChecksum = (flags & MESSAGE_FLAGS.CHECKSUMMED) !== 0;
  const headerSize = hasChecksum ? HEADER_SIZE_WITH_CHECKSUM : HEADER_SIZE;

  let checksum: number | undefined;
  if (hasChecksum) {
    checksum = view.getUint32(6, false);
  }

  const payload = data.slice(headerSize, headerSize + payloadLength);

  // Verify checksum if present
  if (hasChecksum && checksum !== undefined) {
    const computed = crc32c(payload);
    if (computed !== checksum) {
      throw new Error(`Checksum mismatch: expected ${checksum}, got ${computed}`);
    }
  }

  return { type, flags, payload, checksum };
}
```

### Stream Reader

```typescript
/**
 * Read framed messages from a stream.
 */
class FramedStreamReader {
  private buffer = new Uint8Array(0);

  constructor(private stream: ReadableStream<Uint8Array>) {}

  async *messages(): AsyncGenerator<MessageFrame> {
    const reader = this.stream.getReader();

    try {
      while (true) {
        // Read header first
        while (this.buffer.length < HEADER_SIZE) {
          const { value, done } = await reader.read();
          if (done) return;
          this.buffer = concat(this.buffer, value);
        }

        // Parse header to get payload length
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
        const payloadLength = view.getUint32(0, false);
        const flags = view.getUint8(5);
        const hasChecksum = (flags & MESSAGE_FLAGS.CHECKSUMMED) !== 0;
        const headerSize = hasChecksum ? HEADER_SIZE_WITH_CHECKSUM : HEADER_SIZE;
        const totalLength = headerSize + payloadLength;

        // Read complete message
        while (this.buffer.length < totalLength) {
          const { value, done } = await reader.read();
          if (done) throw new Error('Stream ended mid-message');
          this.buffer = concat(this.buffer, value);
        }

        // Extract and decode frame
        const frameData = this.buffer.slice(0, totalLength);
        this.buffer = this.buffer.slice(totalLength);

        yield decodeFrame(frameData);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}
```

### Chunked Transfers

For messages larger than 16MB, use chunked transfer:

```typescript
const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks

/**
 * Send large data in chunks.
 */
async function sendChunked(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  type: number,
  data: Uint8Array
): Promise<void> {
  const totalChunks = Math.ceil(data.length / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, data.length);
    const chunk = data.slice(start, end);
    const isLast = i === totalChunks - 1;

    const flags = MESSAGE_FLAGS.CHUNKED |
                  MESSAGE_FLAGS.CHECKSUMMED |
                  (isLast ? MESSAGE_FLAGS.FINAL_CHUNK : 0);

    const frame = encodeFrame({ type, flags, payload: chunk });
    await writer.write(frame);
  }
}

/**
 * Receive chunked data.
 */
async function receiveChunked(
  reader: FramedStreamReader,
  expectedType: number
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];

  for await (const frame of reader.messages()) {
    if (frame.type !== expectedType) {
      throw new Error(`Unexpected message type: ${frame.type}`);
    }

    if ((frame.flags & MESSAGE_FLAGS.CHUNKED) === 0) {
      // Not chunked, return as-is
      return frame.payload;
    }

    chunks.push(frame.payload);

    if ((frame.flags & MESSAGE_FLAGS.FINAL_CHUNK) !== 0) {
      break;
    }
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
```

## Message Types

```typescript
type SyncMessage =
  | { type: 'version-info'; version: Uint8Array }    // Serialized version vector
  | { type: 'updates'; data: Uint8Array }            // Loro updates since peer version
  | { type: 'snapshot-request' }                      // Request full snapshot (new peer)
  | { type: 'snapshot'; data: Uint8Array }           // Full document snapshot
  | { type: 'sync-complete' }                        // Sync round complete
  | { type: 'error'; code: string; message: string };
```

## Sync Flow

### Initial Connection

```typescript
import { LoroDoc } from 'loro-crdt';

interface SyncSession {
  localDoc: LoroDoc;
  peerVersion: Map<string, number> | null;
  connection: IrohConnection;
}

async function startSync(session: SyncSession): Promise<void> {
  const { localDoc, connection } = session;

  // Step 1: Send our version (serialized)
  const versionData = serializeVersionVector(localDoc);
  connection.send({
    type: 'version-info',
    version: versionData,
  });

  // Step 2: Receive peer's version
  const peerMsg = await connection.receive();

  if (peerMsg.type === 'snapshot-request') {
    // New peer - send full snapshot
    await sendSnapshot(session);
    return;
  }

  if (peerMsg.type !== 'version-info') {
    throw new Error(`Unexpected message: ${peerMsg.type}`);
  }

  session.peerVersion = deserializeVersionVector(peerMsg.version);

  // Step 3: Exchange updates
  await exchangeUpdates(session);
}
```

### Update Exchange

```typescript
async function exchangeUpdates(session: SyncSession): Promise<void> {
  const { localDoc, peerVersion, connection } = session;

  // Determine what to export based on peer's version
  // If we have a cached version from last sync, use it for delta export
  // Otherwise, export everything (the peer will deduplicate)
  let updates: Uint8Array;

  if (peerVersion && peerVersion.size > 0) {
    // Export updates that peer doesn't have
    // Loro can compute this from version vectors
    updates = localDoc.export({ mode: 'update' });

    // Note: In production, implement version-aware export by
    // comparing version vectors and only sending needed ops
  } else {
    // New peer or unknown state - send all updates
    updates = localDoc.export({ mode: 'update' });
  }

  // Send updates (may be empty if peer is up-to-date)
  connection.send({
    type: 'updates',
    data: updates,
  });

  // Receive peer's updates
  const peerUpdates = await connection.receive();

  if (peerUpdates.type === 'updates' && peerUpdates.data.byteLength > 0) {
    // Import peer's changes - Loro handles merge automatically!
    // Loro deduplicates: already-seen operations are ignored
    localDoc.import(peerUpdates.data);
  }

  // Signal completion
  connection.send({ type: 'sync-complete' });
  await connection.expectMessage('sync-complete');
}
```

### Incremental Sync with Version Comparison

For efficient incremental sync, compare version vectors before export:

```typescript
/**
 * Export only the updates that peer is missing.
 * This is more efficient than sending all updates.
 */
function exportMissingUpdates(
  doc: LoroDoc,
  peerVersion: Map<string, number>
): Uint8Array {
  const localVersion = doc.version().toJSON() as Record<string, number>;

  // Check if peer is behind
  let peerNeedsUpdates = false;
  for (const [peerId, localCounter] of Object.entries(localVersion)) {
    const peerCounter = peerVersion.get(peerId) ?? 0;
    if (localCounter > peerCounter) {
      peerNeedsUpdates = true;
      break;
    }
  }

  if (!peerNeedsUpdates) {
    // Peer is up to date, return empty update
    return new Uint8Array(0);
  }

  // Export all updates - Loro will deduplicate on import
  // For very large documents, consider using shallow snapshots
  return doc.export({ mode: 'update' });
}
```

### New Peer (Snapshot Transfer)

When a peer has no previous sync state, send full snapshot:

```typescript
async function sendSnapshot(session: SyncSession): Promise<void> {
  const { localDoc, connection } = session;

  // Export full snapshot (includes state + history)
  const snapshot = localDoc.export({ mode: 'snapshot' });

  connection.send({
    type: 'snapshot',
    data: snapshot,
  });

  // Wait for peer to confirm receipt
  await connection.expectMessage('sync-complete');
  connection.send({ type: 'sync-complete' });
}

async function receiveSnapshot(session: SyncSession): Promise<void> {
  const { localDoc, connection } = session;

  // Request snapshot
  connection.send({ type: 'snapshot-request' });

  const response = await connection.receive();
  if (response.type !== 'snapshot') {
    throw new Error(`Expected snapshot, got ${response.type}`);
  }

  // Import full snapshot
  localDoc.import(response.data);

  connection.send({ type: 'sync-complete' });
  await connection.expectMessage('sync-complete');
}
```

## Initial Sync Strategy (Existing Vault)

When enabling PeerVault on an existing vault with many files, a special initialization process is required. This handles the "cold start" problem where there's no CRDT history yet.

### Initialization Flow

```
┌─────────────────────────────────────────────────────────────┐
│              Initial Sync - Existing Vault                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. User enables PeerVault on existing vault                │
│  2. Scan all .md files in vault                             │
│  3. Create Loro document with current file state            │
│  4. Show progress UI during indexing                        │
│  5. Save initial snapshot                                   │
│  6. Ready to sync with peers                                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Vault Scanning

```typescript
interface VaultScanResult {
  files: Array<{ path: string; content: string; mtime: number }>;
  folders: string[];
  totalBytes: number;
  duration: number;
}

/**
 * Scan existing vault to build initial CRDT state.
 */
async function scanExistingVault(
  vault: Vault,
  onProgress: (current: number, total: number, file: string) => void
): Promise<VaultScanResult> {
  const startTime = Date.now();
  const files: VaultScanResult['files'] = [];
  const folders = new Set<string>();
  let totalBytes = 0;

  // Get all markdown files
  const allFiles = vault.getMarkdownFiles();
  const total = allFiles.length;

  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    onProgress(i + 1, total, file.path);

    // Read content
    const content = await vault.read(file);
    totalBytes += content.length;

    files.push({
      path: file.path,
      content,
      mtime: file.stat.mtime,
    });

    // Track folder hierarchy
    const parts = file.path.split('/');
    for (let j = 1; j < parts.length; j++) {
      folders.add(parts.slice(0, j).join('/'));
    }
  }

  return {
    files,
    folders: Array.from(folders),
    totalBytes,
    duration: Date.now() - startTime,
  };
}
```

### Building Initial CRDT State

```typescript
/**
 * Build Loro document from scanned vault.
 * This creates the initial CRDT state with all files.
 */
async function buildInitialCrdtState(
  scanResult: VaultScanResult,
  vaultId: string,
  vaultName: string,
  onProgress: (current: number, total: number) => void
): Promise<LoroDoc> {
  const doc = createVaultDoc(vaultId, vaultName);
  const files = doc.getTree('files');
  const total = scanResult.files.length;

  // Create folder nodes first (to get parent IDs)
  const folderNodes = new Map<string, TreeID>();

  for (const folderPath of scanResult.folders.sort((a, b) => a.length - b.length)) {
    const parts = folderPath.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parentId = parentPath ? folderNodes.get(parentPath) ?? null : null;

    const nodeId = createFolder(doc, parentId, name);
    folderNodes.set(folderPath, nodeId);
  }

  // Create file nodes with content
  doc.transact(() => {
    for (let i = 0; i < scanResult.files.length; i++) {
      const { path, content, mtime } = scanResult.files[i];
      onProgress(i + 1, total);

      const parts = path.split('/');
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('/');
      const parentId = parentPath ? folderNodes.get(parentPath) ?? null : null;

      const nodeId = createFile(doc, parentId, name, content);

      // Set mtime from original file
      const nodeData = files.getMeta(nodeId);
      nodeData.set('mtime', mtime);
    }
  });

  return doc;
}
```

### Progress UI

```typescript
class InitialSyncModal extends Modal {
  private progressBar: HTMLProgressElement;
  private statusText: HTMLElement;
  private fileText: HTMLElement;

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Initializing PeerVault' });
    contentEl.createEl('p', {
      text: 'Scanning your vault and creating sync database...',
    });

    this.progressBar = contentEl.createEl('progress', {
      attr: { max: '100', value: '0' },
    });

    this.statusText = contentEl.createEl('p', { cls: 'sync-status' });
    this.fileText = contentEl.createEl('p', { cls: 'sync-file', text: '' });
  }

  updateProgress(phase: 'scan' | 'build', current: number, total: number, file?: string): void {
    const percent = Math.round((current / total) * 100);
    this.progressBar.value = percent;

    if (phase === 'scan') {
      this.statusText.setText(`Scanning files: ${current} / ${total}`);
      if (file) this.fileText.setText(file);
    } else {
      this.statusText.setText(`Building sync database: ${current} / ${total}`);
      this.fileText.setText('');
    }
  }

  complete(stats: { files: number; bytes: number; duration: number }): void {
    this.progressBar.value = 100;
    this.statusText.setText(
      `Complete! Indexed ${stats.files} files (${formatBytes(stats.bytes)}) in ${formatDuration(stats.duration)}`
    );
    this.fileText.setText('Ready to sync');

    // Auto-close after delay
    setTimeout(() => this.close(), 2000);
  }
}
```

### Joining Existing Vault from Another Device

When a new device joins an existing synced vault:

```typescript
/**
 * Join an existing vault that already has CRDT history.
 * Receives full snapshot from peer.
 */
async function joinExistingVault(
  session: SyncSession,
  vault: Vault,
  onProgress: (phase: string, percent: number) => void
): Promise<void> {
  onProgress('connecting', 0);

  // Request full snapshot from peer
  session.connection.send({ type: 'snapshot-request' });

  onProgress('receiving', 10);

  // Receive snapshot
  const response = await session.connection.receive();
  if (response.type !== 'snapshot') {
    throw new Error(`Expected snapshot, got ${response.type}`);
  }

  onProgress('importing', 50);

  // Import snapshot to local doc
  session.localDoc.import(response.data);

  onProgress('writing-files', 70);

  // Write all files to vault
  await writeAllFilesToVault(session.localDoc, vault, (current, total) => {
    const percent = 70 + Math.round((current / total) * 25);
    onProgress('writing-files', percent);
  });

  onProgress('complete', 100);

  session.connection.send({ type: 'sync-complete' });
}

/**
 * Write all files from CRDT to vault filesystem.
 */
async function writeAllFilesToVault(
  doc: LoroDoc,
  vault: Vault,
  onProgress: (current: number, total: number) => void
): Promise<void> {
  const files = listAllFiles(doc);
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const { nodeId, path } = files[i];
    onProgress(i + 1, total);

    const content = getFullFileContent(doc, nodeId);

    // Create folders if needed
    const folderPath = path.split('/').slice(0, -1).join('/');
    if (folderPath && !await vault.adapter.exists(folderPath)) {
      await vault.createFolder(folderPath);
    }

    // Write file
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await vault.modify(existing, content);
    } else {
      await vault.create(path, content);
    }
  }
}
```

### Conflict Detection on Join

When joining, local files might conflict with remote state:

```typescript
interface JoinConflict {
  path: string;
  localContent: string;
  remoteContent: string;
  resolution: 'keep-local' | 'keep-remote' | 'merge';
}

/**
 * Detect conflicts when joining with existing local files.
 */
async function detectJoinConflicts(
  localVault: Vault,
  remoteDoc: LoroDoc
): Promise<JoinConflict[]> {
  const conflicts: JoinConflict[] = [];
  const remoteFiles = listAllFiles(remoteDoc);

  for (const { nodeId, path } of remoteFiles) {
    const localFile = localVault.getAbstractFileByPath(path);

    if (localFile instanceof TFile) {
      const localContent = await localVault.read(localFile);
      const remoteContent = getFullFileContent(remoteDoc, nodeId);

      if (localContent !== remoteContent) {
        conflicts.push({
          path,
          localContent,
          remoteContent,
          resolution: 'merge', // Default to merge
        });
      }
    }
  }

  return conflicts;
}

/**
 * Resolve join conflicts by merging local and remote content.
 */
async function resolveJoinConflicts(
  conflicts: JoinConflict[],
  doc: LoroDoc
): Promise<void> {
  for (const conflict of conflicts) {
    if (conflict.resolution === 'merge') {
      // Create local content as a new edit to merge with remote
      const nodeId = findNodeByPath(doc, conflict.path);
      if (nodeId) {
        // Update with local content - Loro will merge
        updateFileContent(doc, nodeId, conflict.localContent);
      }
    } else if (conflict.resolution === 'keep-local') {
      // Same as merge - local content becomes latest
      const nodeId = findNodeByPath(doc, conflict.path);
      if (nodeId) {
        updateFileContent(doc, nodeId, conflict.localContent);
      }
    }
    // 'keep-remote' requires no action - remote is already in doc
  }
}
```

### Batched Initial Sync

For very large vaults (10k+ files), use batched processing:

```typescript
interface BatchConfig {
  filesPerBatch: number;
  delayBetweenBatches: number;
  yieldToUI: boolean;
}

const DEFAULT_BATCH_CONFIG: BatchConfig = {
  filesPerBatch: 100,
  delayBetweenBatches: 50, // ms
  yieldToUI: true,
};

/**
 * Process files in batches to avoid UI freeze.
 */
async function buildInitialStateBatched(
  scanResult: VaultScanResult,
  vaultId: string,
  config: BatchConfig,
  onProgress: (current: number, total: number) => void
): Promise<LoroDoc> {
  const doc = createVaultDoc(vaultId, 'Vault');
  const total = scanResult.files.length;
  let processed = 0;

  for (let i = 0; i < scanResult.files.length; i += config.filesPerBatch) {
    const batch = scanResult.files.slice(i, i + config.filesPerBatch);

    // Process batch in single transaction
    doc.transact(() => {
      for (const { path, content, mtime } of batch) {
        createFileAtPath(doc, path, content, mtime);
        processed++;
      }
    });

    onProgress(processed, total);

    // Yield to UI
    if (config.yieldToUI) {
      await new Promise(resolve => setTimeout(resolve, config.delayBetweenBatches));
    }
  }

  return doc;
}
```

### Initial Sync Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Batch size | Files per transaction | 100 |
| Show progress | Display progress modal | Yes |
| Conflict handling | How to handle existing files | Merge |
| Exclude patterns | Glob patterns to skip | `['.*', 'node_modules/**']` |

## Sync State Persistence

Track sync state with each peer for efficient reconnection:

```typescript
interface PeerSyncState {
  /** Peer's Iroh node ID */
  peerId: string;

  /** Last known version of peer's document (serialized) */
  lastKnownVersion: string;  // JSON serialized version vector

  /** When we last synced */
  lastSyncTime: number;

  /** Bytes transferred in last sync */
  lastSyncBytes: number;
}

class SyncStateManager {
  private states = new Map<string, PeerSyncState>();
  private storageKey = 'peervault-sync-states';

  constructor(private storage: StorageAdapter) {}

  async load(): Promise<void> {
    const data = await this.storage.read(this.storageKey);
    if (data) {
      const parsed = JSON.parse(data);
      this.states = new Map(Object.entries(parsed));
    }
  }

  async onSyncComplete(peerId: string, doc: LoroDoc, bytesTransferred: number): Promise<void> {
    const version = doc.version().toJSON();
    const state: PeerSyncState = {
      peerId,
      lastKnownVersion: JSON.stringify(version),
      lastSyncTime: Date.now(),
      lastSyncBytes: bytesTransferred,
    };

    this.states.set(peerId, state);
    await this.persist();
  }

  getPeerVersion(peerId: string): Map<string, number> | null {
    const state = this.states.get(peerId);
    if (!state) return null;

    try {
      const parsed = JSON.parse(state.lastKnownVersion);
      return new Map(Object.entries(parsed));
    } catch {
      return null;
    }
  }

  private async persist(): Promise<void> {
    const obj = Object.fromEntries(this.states);
    await this.storage.write(this.storageKey, JSON.stringify(obj));
  }
}
```

## Live Sync

After initial sync, keep connection open for real-time updates:

```typescript
class LiveSync {
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_MS = 1000;

  constructor(
    private doc: LoroDoc,
    private connections: Map<string, IrohConnection>,
    private stateManager: SyncStateManager
  ) {
    // Subscribe to local document changes
    doc.subscribe((event) => {
      if (event.origin === 'local') {
        this.onLocalChange();
      }
    });
  }

  private onLocalChange(): void {
    // Debounce rapid edits
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.broadcastUpdates();
    }, this.DEBOUNCE_MS);
  }

  private async broadcastUpdates(): Promise<void> {
    const myVersion = this.doc.version();

    for (const [peerId, connection] of this.connections) {
      try {
        const peerVersion = this.stateManager.getPeerVersion(peerId);
        if (!peerVersion) continue;

        // Export only new changes
        const updates = this.doc.export({
          mode: 'update',
          from: peerVersion,
        });

        if (updates.byteLength > 0) {
          connection.send({ type: 'updates', data: updates });
        }
      } catch (error) {
        console.error(`Failed to sync with ${peerId}:`, error);
      }
    }
  }

  async handleIncomingUpdates(peerId: string, data: Uint8Array): Promise<void> {
    // Import peer's changes
    this.doc.import(data);

    // Update peer's known version
    await this.stateManager.onSyncComplete(peerId, this.doc, data.byteLength);

    // Trigger filesystem write-back
    this.emit('remoteChange');
  }
}
```

## Priority Sync

Sync currently-open files first for better UX:

```typescript
interface SyncPriority {
  /** Currently open file paths */
  openFiles: Set<string>;

  /** Recently edited files */
  recentlyEdited: Map<string, number>;
}

class PrioritizedSync {
  constructor(private priority: SyncPriority) {}

  /**
   * When receiving updates, prioritize applying changes
   * to open files immediately.
   */
  async applyUpdatesWithPriority(
    doc: LoroDoc,
    updates: Uint8Array,
    writeBack: (path: string, content: string) => Promise<void>
  ): Promise<void> {
    // Import all updates
    const beforeVersion = doc.version();
    doc.import(updates);

    // Get changed files
    const changes = this.getChangedFiles(doc, beforeVersion);

    // Sort by priority (open files first)
    const prioritized = [...changes].sort((a, b) => {
      const aOpen = this.priority.openFiles.has(a) ? 0 : 1;
      const bOpen = this.priority.openFiles.has(b) ? 0 : 1;
      return aOpen - bOpen;
    });

    // Apply changes in priority order
    for (const path of prioritized) {
      const content = this.getFileContent(doc, path);
      await writeBack(path, content);
    }
  }
}
```

## Bandwidth Optimization

### Incremental Updates

Loro's version vectors enable minimal data transfer:

```typescript
// BAD: Send entire document every time
const fullDoc = doc.export({ mode: 'snapshot' });  // Large!

// GOOD: Send only changes since peer's version
const updates = doc.export({ mode: 'update', from: peerVersion });  // Small!
```

### Compression

Loro's binary format is already compact, but additional compression helps:

```typescript
async function sendCompressed(
  connection: IrohConnection,
  data: Uint8Array
): Promise<void> {
  // Use native compression if available
  if (typeof CompressionStream !== 'undefined') {
    const compressed = await compress(data);
    connection.send({
      type: 'updates',
      data: compressed,
      compressed: true,
    });
  } else {
    connection.send({
      type: 'updates',
      data,
      compressed: false,
    });
  }
}
```

### Rate Limiting on Metered Connections

```typescript
interface BandwidthConfig {
  /** Max bytes per second on metered connection */
  meteredBytesPerSecond: number;

  /** Detect metered connection automatically */
  autoDetectMetered: boolean;
}

class RateLimitedSync {
  private readonly tokenBucket: TokenBucket;
  private isMetered: boolean = false;

  constructor(private config: BandwidthConfig) {
    this.tokenBucket = new TokenBucket(config.meteredBytesPerSecond);

    if (config.autoDetectMetered && navigator.connection) {
      this.isMetered = navigator.connection.saveData ||
                        navigator.connection.effectiveType === '2g';

      navigator.connection.addEventListener('change', () => {
        this.isMetered = navigator.connection.saveData ||
                          navigator.connection.effectiveType === '2g';
      });
    }
  }

  async sendWithRateLimit(data: Uint8Array): Promise<void> {
    if (this.isMetered) {
      // Wait for tokens
      await this.tokenBucket.consume(data.byteLength);
    }
    // Send data
  }
}
```

## Conflict Resolution

Loro handles conflicts automatically:

### Text Conflicts (Fugue Algorithm)

```
Device A: "Hello world" → "Hello brave world"
Device B: "Hello world" → "Hello new world"
                    ↓ sync
Merged result: "Hello brave new world"

Fugue minimizes interleaving - insertions stay grouped!
```

### Tree Conflicts (LoroTree)

```
Device A: Move "note.md" to "folder-a/"
Device B: Move "note.md" to "folder-b/"
                    ↓ sync
Result: File in one location (last-writer-wins)
No manual resolution needed!
```

### Map/List Conflicts

```
Device A: Add tag "work"
Device B: Add tag "personal"
                    ↓ sync
Result: Both tags present ["work", "personal"]
```

## Read-Only Peer Enforcement

Some peers may be configured as read-only (e.g., archive servers, limited access devices). The sync protocol enforces this at multiple layers.

### Permission Model

```typescript
interface PeerPermissions {
  /** Peer identifier */
  peerId: string;

  /** Can this peer send updates to us? */
  canWrite: boolean;

  /** Folders this peer is excluded from */
  excludedFolders: string[];
}

/**
 * Get permissions for a peer based on their group membership.
 */
function getPeerPermissions(peerId: string, groupManager: PeerGroupManager): PeerPermissions {
  const policy = groupManager.getEffectiveSyncPolicy(peerId);

  return {
    peerId,
    canWrite: !policy.readOnly,
    excludedFolders: policy.excludedFolders,
  };
}
```

### Enforcement in Sync Protocol

```typescript
class ProtectedSyncSession {
  constructor(
    private session: SyncSession,
    private permissions: PeerPermissions
  ) {}

  async handleIncomingUpdates(data: Uint8Array): Promise<void> {
    // Check if peer is allowed to write
    if (!this.permissions.canWrite) {
      console.warn(`Rejecting updates from read-only peer: ${this.permissions.peerId}`);
      this.session.connection.send({
        type: 'error',
        code: 'READ_ONLY',
        message: 'You do not have write permission for this vault',
      });
      return;
    }

    // Filter updates based on excluded folders
    if (this.permissions.excludedFolders.length > 0) {
      const filteredUpdates = await this.filterUpdates(data);
      if (filteredUpdates.byteLength > 0) {
        this.session.localDoc.import(filteredUpdates);
      }
    } else {
      this.session.localDoc.import(data);
    }
  }

  /**
   * Filter updates to exclude changes to protected folders.
   * Note: This requires inspecting the update operations.
   */
  private async filterUpdates(data: Uint8Array): Promise<Uint8Array> {
    // Import to a temporary doc to inspect changes
    const tempDoc = new LoroDoc();
    tempDoc.import(this.session.localDoc.export({ mode: 'snapshot' }));
    tempDoc.import(data);

    // Check for changes to excluded folders
    // If changes affect excluded folders, reject entire update
    // This is conservative but safe
    for (const folder of this.permissions.excludedFolders) {
      if (this.hasChangesToFolder(tempDoc, folder)) {
        console.warn(`Rejecting updates affecting excluded folder: ${folder}`);
        return new Uint8Array(0);
      }
    }

    return data;
  }

  private hasChangesToFolder(doc: LoroDoc, folderPath: string): boolean {
    // Implementation: check if any tree operations affect nodes
    // under the excluded folder path
    // This requires walking the tree and comparing paths
    return false; // Placeholder - implement based on change detection needs
  }
}
```

### Sending Updates to Read-Only Peers

Read-only peers can still receive updates from us:

```typescript
async function sendUpdatesToReadOnlyPeer(
  session: SyncSession,
  permissions: PeerPermissions
): Promise<void> {
  // We can send updates TO read-only peers
  // We just don't accept updates FROM them

  const updates = session.localDoc.export({ mode: 'update' });

  // Filter out excluded folders from what we send
  const filteredUpdates = filterUpdatesForFolders(
    updates,
    permissions.excludedFolders
  );

  session.connection.send({
    type: 'updates',
    data: filteredUpdates,
  });
}
```

### Error Codes for Permission Violations

```typescript
const SYNC_ERROR_CODES = {
  READ_ONLY: 'Peer is configured as read-only',
  FOLDER_EXCLUDED: 'Updates affect an excluded folder',
  PERMISSION_DENIED: 'Peer does not have required permissions',
} as const;
```

## Error Handling

| Error | Recovery |
|-------|----------|
| Connection lost mid-sync | Resume on reconnect using persisted peer version |
| Corrupt update data | Request full snapshot from peer |
| Version vector mismatch | Fall back to snapshot transfer |
| Sync timeout | Retry with exponential backoff |
| Out of memory | Use streaming for large updates |

## Offline Operation Mode

Extended offline support for users without network access for days or weeks.

### Offline States

```typescript
enum OfflineState {
  /** Online, actively syncing */
  ONLINE = 'online',

  /** Temporarily offline, will auto-reconnect */
  TEMPORARILY_OFFLINE = 'temporarily_offline',

  /** Explicitly set offline by user */
  USER_OFFLINE = 'user_offline',

  /** Extended offline (> 24 hours) */
  EXTENDED_OFFLINE = 'extended_offline',
}

interface OfflineStatus {
  state: OfflineState;
  since: number;  // Timestamp when went offline
  pendingChanges: number;
  lastSyncedVersion: Uint8Array;
}
```

### Offline Change Tracking

```typescript
/**
 * Track changes made while offline for efficient sync on reconnect.
 */
class OfflineChangeTracker {
  private offlineSince: number | null = null;
  private versionAtOffline: Uint8Array | null = null;
  private pendingChangeCount = 0;

  constructor(private doc: LoroDoc) {}

  /**
   * Mark start of offline period.
   */
  goOffline(): void {
    this.offlineSince = Date.now();
    this.versionAtOffline = this.doc.version().encode();
    this.pendingChangeCount = 0;
  }

  /**
   * Track a local change made while offline.
   */
  trackChange(): void {
    this.pendingChangeCount++;
  }

  /**
   * Get changes made since going offline.
   */
  getOfflineChanges(): Uint8Array {
    if (!this.versionAtOffline) {
      return new Uint8Array(0);
    }

    return this.doc.export({
      mode: 'update',
      from: this.versionAtOffline,
    });
  }

  /**
   * Get offline duration in milliseconds.
   */
  getOfflineDuration(): number {
    return this.offlineSince ? Date.now() - this.offlineSince : 0;
  }

  /**
   * Reset on reconnect.
   */
  goOnline(): void {
    this.offlineSince = null;
    this.versionAtOffline = null;
    this.pendingChangeCount = 0;
  }
}
```

### Extended Offline Recovery

```typescript
/**
 * Handle sync after extended offline period (days/weeks).
 */
class ExtendedOfflineRecovery {
  private readonly EXTENDED_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

  async recoverFromExtendedOffline(
    session: SyncSession,
    tracker: OfflineChangeTracker
  ): Promise<RecoveryResult> {
    const offlineDuration = tracker.getOfflineDuration();

    if (offlineDuration < this.EXTENDED_THRESHOLD_MS) {
      // Normal sync sufficient
      return { type: 'normal', duration: offlineDuration };
    }

    // Extended offline - need careful recovery
    console.log(`Extended offline: ${Math.round(offlineDuration / 3600000)}h`);

    // 1. Check if we're still compatible with peers
    const compatibility = await this.checkCompatibility(session);
    if (!compatibility.compatible) {
      return {
        type: 'incompatible',
        reason: compatibility.reason,
        suggestion: compatibility.suggestion,
      };
    }

    // 2. Request peer's version vector
    const peerVersion = await session.requestVersionVector();

    // 3. Calculate divergence
    const localChanges = tracker.getOfflineChanges();
    const divergence = this.calculateDivergence(
      tracker.versionAtOffline!,
      peerVersion
    );

    // 4. If divergence is huge, suggest snapshot instead of updates
    if (divergence.tooLarge) {
      return {
        type: 'snapshot_recommended',
        localChangeCount: localChanges.byteLength,
        peerChangeCount: divergence.estimatedPeerChanges,
      };
    }

    // 5. Normal incremental sync
    return { type: 'incremental', localChanges, peerVersion };
  }

  private calculateDivergence(
    localVersion: Uint8Array,
    peerVersion: Uint8Array
  ): DivergenceInfo {
    // Compare version vectors to estimate divergence
    // This is a heuristic based on version vector distance

    const localEntries = this.parseVersionVector(localVersion);
    const peerEntries = this.parseVersionVector(peerVersion);

    let totalDifference = 0;
    const allPeers = new Set([...localEntries.keys(), ...peerEntries.keys()]);

    for (const peerId of allPeers) {
      const local = localEntries.get(peerId) || 0;
      const peer = peerEntries.get(peerId) || 0;
      totalDifference += Math.abs(local - peer);
    }

    return {
      totalDifference,
      tooLarge: totalDifference > 10000, // Heuristic threshold
      estimatedPeerChanges: totalDifference,
    };
  }
}

interface RecoveryResult {
  type: 'normal' | 'incremental' | 'snapshot_recommended' | 'incompatible';
  duration?: number;
  localChanges?: Uint8Array;
  peerVersion?: Uint8Array;
  localChangeCount?: number;
  peerChangeCount?: number;
  reason?: string;
  suggestion?: string;
}
```

### Offline UI

```typescript
/**
 * Offline indicator and controls.
 */
class OfflineStatusUI {
  private statusEl: HTMLElement;

  update(status: OfflineStatus): void {
    switch (status.state) {
      case OfflineState.ONLINE:
        this.statusEl.removeClass('offline');
        this.statusEl.setText('');
        break;

      case OfflineState.TEMPORARILY_OFFLINE:
        this.statusEl.addClass('offline');
        this.statusEl.setText(`Offline (${status.pendingChanges} pending)`);
        break;

      case OfflineState.EXTENDED_OFFLINE:
        this.statusEl.addClass('offline', 'extended');
        const days = Math.floor((Date.now() - status.since) / 86400000);
        this.statusEl.setText(`Offline ${days}d (${status.pendingChanges} pending)`);
        break;

      case OfflineState.USER_OFFLINE:
        this.statusEl.addClass('offline', 'manual');
        this.statusEl.setText('Offline mode');
        break;
    }
  }

  /**
   * Show extended offline warning.
   */
  showExtendedOfflineWarning(tracker: OfflineChangeTracker): void {
    const duration = tracker.getOfflineDuration();
    const days = Math.floor(duration / 86400000);

    new Notice(
      `You've been offline for ${days} day(s). ` +
      `${tracker.pendingChangeCount} changes are pending sync.`,
      0 // Don't auto-dismiss
    );
  }
}
```

### Offline Settings

```typescript
interface OfflineConfig {
  /** Auto-retry interval when temporarily offline */
  retryIntervalMs: number;

  /** Warn after this duration offline */
  warnAfterMs: number;

  /** Max offline duration before suggesting recovery */
  maxOfflineDurationMs: number;

  /** Queue changes when offline instead of failing */
  queueOfflineChanges: boolean;
}

const DEFAULT_OFFLINE_CONFIG: OfflineConfig = {
  retryIntervalMs: 30000,           // 30 seconds
  warnAfterMs: 24 * 60 * 60 * 1000, // 24 hours
  maxOfflineDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  queueOfflineChanges: true,
};
```

### Offline Sequence Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Extended Offline → Reconnect                              │
└─────────────────────────────────────────────────────────────────────────────┘

   Device                      Offline Tracker               Peer
      │                              │                          │
      │  1. LOSE CONNECTION          │                          │
      ├─────────────────────────────►│                          │
      │  goOffline()                 │                          │
      │                              │                          │
      │  ... 3 days pass ...         │                          │
      │                              │                          │
      │  2. LOCAL EDITS (offline)    │                          │
      ├─────────────────────────────►│                          │
      │  trackChange() x N           │                          │
      │                              │                          │
      │  3. RECONNECT                │                          │
      ├◄────────────────────────────►├─────────────────────────►│
      │                              │                          │
      │  4. CHECK COMPATIBILITY      │                          │
      │◄─────────────────────────────┤                          │
      │  Extended offline detected   │                          │
      │                              │                          │
      │  5. REQUEST PEER VERSION     │                          │
      ├─────────────────────────────────────────────────────────►│
      │                              │                          │
      │  6. CALCULATE DIVERGENCE     │                          │
      │◄─────────────────────────────┤                          │
      │                              │                          │
      │  7. INCREMENTAL SYNC         │                          │
      ├─────────────────────────────────────────────────────────►│
      │  Send offline changes        │                          │
      │                              │                          │
      │◄────────────────────────────────────────────────────────┤
      │  Receive peer changes        │                          │
      │                              │                          │
      │  8. MERGE                    │                          │
      ├─────────────────────────────►│                          │
      │  Loro merges all changes     │                          │
      │                              │                          │
      │  9. NOTIFY USER              │                          │
      ├───────►                      │                          │
      │  "Synced 47 offline changes" │                          │
      │                              │                          │
      ▼                              ▼                          ▼
```

## Split-Brain Recovery Strategy

A "split-brain" scenario occurs when two or more peer groups operate independently for an extended period, accumulating significant divergent changes. While Loro CRDTs guarantee eventual consistency, users may need guidance when merging large divergent histories.

### Split-Brain Detection

```typescript
interface SplitBrainMetrics {
  /** Number of local operations since last sync with this peer */
  localOpsSincePeerSync: number;

  /** Number of remote operations we haven't seen */
  remoteOpsAhead: number;

  /** Files modified locally */
  localModifiedFiles: Set<string>;

  /** Files modified remotely */
  remoteModifiedFiles: Set<string>;

  /** Files modified by both sides */
  overlappingFiles: Set<string>;

  /** Estimated merge complexity (0-1) */
  mergeComplexity: number;
}

class SplitBrainDetector {
  /** Thresholds for split-brain classification */
  private readonly THRESHOLDS = {
    /** Minor: few changes, low overlap */
    minor: { ops: 50, overlap: 2 },
    /** Moderate: significant changes, some overlap */
    moderate: { ops: 200, overlap: 10 },
    /** Severe: many changes, high overlap */
    severe: { ops: 1000, overlap: 50 },
  };

  /**
   * Analyze divergence between local and remote versions.
   */
  async analyzeSpitBrain(
    localDoc: LoroDoc,
    remoteVersion: VersionVector,
    remoteModifiedFiles: string[]
  ): Promise<SplitBrainMetrics> {
    const localVersion = localDoc.version();

    // Calculate operations ahead on each side
    const localOps = this.countOpsAhead(localVersion, remoteVersion);
    const remoteOps = this.countOpsAhead(remoteVersion, localVersion);

    // Get locally modified files since common ancestor
    const localModified = await this.getModifiedFilesSince(
      localDoc,
      this.findCommonAncestor(localVersion, remoteVersion)
    );

    const remoteModified = new Set(remoteModifiedFiles);

    // Find overlap
    const overlapping = new Set(
      [...localModified].filter(f => remoteModified.has(f))
    );

    // Calculate merge complexity
    const complexity = this.calculateComplexity(
      localOps,
      remoteOps,
      overlapping.size
    );

    return {
      localOpsSincePeerSync: localOps,
      remoteOpsAhead: remoteOps,
      localModifiedFiles: localModified,
      remoteModifiedFiles: remoteModified,
      overlappingFiles: overlapping,
      mergeComplexity: complexity,
    };
  }

  /**
   * Classify the severity of the split-brain.
   */
  classifySeverity(metrics: SplitBrainMetrics): 'none' | 'minor' | 'moderate' | 'severe' {
    const totalOps = metrics.localOpsSincePeerSync + metrics.remoteOpsAhead;
    const overlap = metrics.overlappingFiles.size;

    if (totalOps < this.THRESHOLDS.minor.ops && overlap < this.THRESHOLDS.minor.overlap) {
      return 'none';
    }
    if (totalOps < this.THRESHOLDS.moderate.ops && overlap < this.THRESHOLDS.moderate.overlap) {
      return 'minor';
    }
    if (totalOps < this.THRESHOLDS.severe.ops && overlap < this.THRESHOLDS.severe.overlap) {
      return 'moderate';
    }
    return 'severe';
  }

  private calculateComplexity(localOps: number, remoteOps: number, overlap: number): number {
    // Complexity is higher with more operations and more overlapping files
    const opsFactor = Math.min(1, (localOps + remoteOps) / 2000);
    const overlapFactor = Math.min(1, overlap / 100);
    return opsFactor * 0.6 + overlapFactor * 0.4;
  }
}
```

### Recovery Strategies

```typescript
/**
 * Split-brain recovery modes.
 */
type RecoveryMode =
  | 'auto-merge'        // Let Loro merge automatically (default)
  | 'review-first'      // Pause for user review before merging
  | 'local-priority'    // Merge but prefer local on text conflicts
  | 'remote-priority'   // Merge but prefer remote on text conflicts
  | 'fork'              // Don't merge, create parallel history branch
  | 'manual';           // Export both, let user decide

interface RecoveryOptions {
  mode: RecoveryMode;

  /** For 'review-first': show these files first */
  priorityFiles?: string[];

  /** Create backup before merging */
  createBackup: boolean;

  /** Notify user after merge */
  notifyOnComplete: boolean;
}

class SplitBrainRecovery {
  /**
   * Get recommended recovery options based on severity.
   */
  getRecommendedOptions(
    severity: 'none' | 'minor' | 'moderate' | 'severe',
    metrics: SplitBrainMetrics
  ): RecoveryOptions {
    switch (severity) {
      case 'none':
      case 'minor':
        return {
          mode: 'auto-merge',
          createBackup: false,
          notifyOnComplete: true,
        };

      case 'moderate':
        return {
          mode: 'auto-merge',
          createBackup: true,
          notifyOnComplete: true,
        };

      case 'severe':
        return {
          mode: 'review-first',
          priorityFiles: Array.from(metrics.overlappingFiles),
          createBackup: true,
          notifyOnComplete: true,
        };
    }
  }

  /**
   * Execute recovery with specified options.
   */
  async executeRecovery(
    localDoc: LoroDoc,
    remoteUpdates: Uint8Array,
    options: RecoveryOptions
  ): Promise<RecoveryResult> {
    // Create backup if requested
    if (options.createBackup) {
      await this.createPreMergeBackup(localDoc);
    }

    switch (options.mode) {
      case 'auto-merge':
        return this.autoMerge(localDoc, remoteUpdates);

      case 'review-first':
        return this.reviewThenMerge(localDoc, remoteUpdates, options.priorityFiles);

      case 'fork':
        return this.createFork(localDoc, remoteUpdates);

      case 'manual':
        return this.exportForManual(localDoc, remoteUpdates);

      default:
        return this.autoMerge(localDoc, remoteUpdates);
    }
  }

  private async autoMerge(
    localDoc: LoroDoc,
    remoteUpdates: Uint8Array
  ): Promise<RecoveryResult> {
    const beforeVersion = localDoc.version();

    // Loro merge is always safe
    localDoc.import(remoteUpdates);

    const afterVersion = localDoc.version();

    return {
      success: true,
      mode: 'auto-merge',
      mergedChanges: this.countVersionDiff(beforeVersion, afterVersion),
    };
  }

  private async reviewThenMerge(
    localDoc: LoroDoc,
    remoteUpdates: Uint8Array,
    priorityFiles?: string[]
  ): Promise<RecoveryResult> {
    // Show diff preview UI
    const preview = await this.generateMergePreview(localDoc, remoteUpdates);

    // Emit event for UI to handle
    this.emit('review-required', {
      preview,
      priorityFiles,
      continueCallback: () => this.autoMerge(localDoc, remoteUpdates),
      cancelCallback: () => ({ success: false, mode: 'review-first', reason: 'cancelled' }),
    });

    return {
      success: true,
      mode: 'review-first',
      pendingReview: true,
    };
  }

  private async createFork(
    localDoc: LoroDoc,
    remoteUpdates: Uint8Array
  ): Promise<RecoveryResult> {
    // Don't merge - keep local as-is
    // Store remote as separate branch for later
    const forkId = `fork-${Date.now()}`;
    await this.storeFork(forkId, remoteUpdates);

    return {
      success: true,
      mode: 'fork',
      forkId,
      message: 'Remote changes stored as separate fork. Merge manually when ready.',
    };
  }

  private async createPreMergeBackup(doc: LoroDoc): Promise<string> {
    const snapshot = doc.export({ mode: 'snapshot' });
    const backupPath = `.peervault/backups/pre-merge-${Date.now()}.loro`;
    await this.storage.write(backupPath, snapshot);
    return backupPath;
  }
}
```

### User Interface for Split-Brain

```typescript
/**
 * Modal shown when severe split-brain detected.
 */
class SplitBrainModal extends Modal {
  constructor(
    app: App,
    private metrics: SplitBrainMetrics,
    private recovery: SplitBrainRecovery
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Significant Divergence Detected' });

    // Summary
    const summary = contentEl.createDiv({ cls: 'split-brain-summary' });
    summary.createEl('p', {
      text: `Your vault has diverged significantly from your peer.`,
    });

    // Metrics
    const metrics = contentEl.createDiv({ cls: 'split-brain-metrics' });
    metrics.createEl('div', {
      text: `Local changes: ${this.metrics.localOpsSincePeerSync} operations`,
    });
    metrics.createEl('div', {
      text: `Remote changes: ${this.metrics.remoteOpsAhead} operations`,
    });
    metrics.createEl('div', {
      text: `Files modified by both: ${this.metrics.overlappingFiles.size}`,
    });

    // Overlapping files list
    if (this.metrics.overlappingFiles.size > 0) {
      const fileList = contentEl.createDiv({ cls: 'overlapping-files' });
      fileList.createEl('h4', { text: 'Files with potential conflicts:' });
      const ul = fileList.createEl('ul');
      for (const file of Array.from(this.metrics.overlappingFiles).slice(0, 10)) {
        ul.createEl('li', { text: file });
      }
      if (this.metrics.overlappingFiles.size > 10) {
        ul.createEl('li', {
          text: `... and ${this.metrics.overlappingFiles.size - 10} more`,
          cls: 'more-files',
        });
      }
    }

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'split-brain-actions' });

    new ButtonComponent(actions)
      .setButtonText('Merge Automatically')
      .setCta()
      .onClick(() => {
        this.close();
        this.recovery.executeRecovery(this.localDoc, this.remoteUpdates, {
          mode: 'auto-merge',
          createBackup: true,
          notifyOnComplete: true,
        });
      });

    new ButtonComponent(actions)
      .setButtonText('Review First')
      .onClick(() => {
        this.close();
        this.recovery.executeRecovery(this.localDoc, this.remoteUpdates, {
          mode: 'review-first',
          priorityFiles: Array.from(this.metrics.overlappingFiles),
          createBackup: true,
          notifyOnComplete: true,
        });
      });

    new ButtonComponent(actions)
      .setButtonText('Keep Separate (Fork)')
      .onClick(() => {
        this.close();
        this.recovery.executeRecovery(this.localDoc, this.remoteUpdates, {
          mode: 'fork',
          createBackup: false,
          notifyOnComplete: true,
        });
      });
  }
}
```

### Split-Brain Prevention

```typescript
/**
 * Settings to reduce split-brain scenarios.
 */
const SPLIT_BRAIN_PREVENTION = {
  /** Warn user when going offline for extended period */
  offlineWarningThreshold: 24 * 60 * 60 * 1000, // 24 hours

  /** Auto-sync when reconnected before user starts editing */
  syncBeforeEdit: true,

  /** Sync more frequently when in "active editing" mode */
  activeEditingSyncInterval: 30_000, // 30 seconds

  /** Background sync even when not actively editing */
  backgroundSyncInterval: 5 * 60 * 1000, // 5 minutes
};
```

## Plugin Conflict Detection

Detect and warn about other sync plugins that may conflict.

### Known Conflicting Plugins

```typescript
const CONFLICTING_PLUGINS = [
  {
    id: 'obsidian-sync',
    name: 'Obsidian Sync',
    severity: 'critical',
    message: 'Obsidian Sync may cause duplicate syncs and conflicts. Disable one sync solution.',
  },
  {
    id: 'obsidian-git',
    name: 'Obsidian Git',
    severity: 'warning',
    message: 'Git-based sync may conflict with PeerVault. Consider using one for sync, one for backup.',
  },
  {
    id: 'remotely-save',
    name: 'Remotely Save',
    severity: 'critical',
    message: 'Multiple sync plugins will cause conflicts. Disable one.',
  },
  {
    id: 'syncthing-integration',
    name: 'Syncthing Integration',
    severity: 'warning',
    message: 'External folder sync may conflict. Ensure they sync different folders.',
  },
];

interface ConflictingPlugin {
  id: string;
  name: string;
  severity: 'warning' | 'critical';
  message: string;
}
```

### Conflict Detector

```typescript
/**
 * Detect conflicting plugins on startup.
 */
class PluginConflictDetector {
  constructor(private app: App) {}

  /**
   * Check for conflicting plugins.
   */
  detectConflicts(): ConflictingPlugin[] {
    const enabledPlugins = this.app.plugins.enabledPlugins;
    const conflicts: ConflictingPlugin[] = [];

    for (const plugin of CONFLICTING_PLUGINS) {
      if (enabledPlugins.has(plugin.id)) {
        conflicts.push(plugin);
      }
    }

    return conflicts;
  }

  /**
   * Show conflict warning to user.
   */
  showConflictWarning(conflicts: ConflictingPlugin[]): void {
    if (conflicts.length === 0) return;

    const critical = conflicts.filter(c => c.severity === 'critical');
    const warnings = conflicts.filter(c => c.severity === 'warning');

    if (critical.length > 0) {
      // Show modal for critical conflicts
      new PluginConflictModal(this.app, critical).open();
    } else if (warnings.length > 0) {
      // Show notice for warnings
      new Notice(
        `PeerVault: ${warnings.map(w => w.name).join(', ')} may conflict. ` +
        `Check settings for details.`,
        10000
      );
    }
  }
}

class PluginConflictModal extends Modal {
  constructor(app: App, private conflicts: ConflictingPlugin[]) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Sync Conflict Warning' });

    contentEl.createEl('p', {
      text: 'The following plugins may conflict with PeerVault:',
    });

    const list = contentEl.createEl('ul');
    for (const conflict of this.conflicts) {
      const item = list.createEl('li');
      item.createEl('strong', { text: conflict.name });
      item.createEl('span', { text: ` - ${conflict.message}` });
    }

    contentEl.createEl('p', {
      text: 'We recommend disabling other sync plugins to prevent data inconsistencies.',
      cls: 'warning-text',
    });

    const buttons = contentEl.createDiv({ cls: 'modal-buttons' });

    buttons.createEl('button', {
      text: 'Open Plugin Settings',
      cls: 'mod-cta',
    }).onclick = () => {
      this.app.setting.open();
      this.app.setting.openTabById('community-plugins');
      this.close();
    };

    buttons.createEl('button', {
      text: 'Dismiss',
    }).onclick = () => this.close();
  }
}
```

## Bandwidth Monitoring and Throttling

Track and limit bandwidth usage.

### Bandwidth Tracker

```typescript
interface BandwidthStats {
  /** Bytes sent in current period */
  bytesSent: number;

  /** Bytes received in current period */
  bytesReceived: number;

  /** Period start time */
  periodStart: number;

  /** Period duration in ms */
  periodDuration: number;

  /** Per-peer breakdown */
  perPeer: Map<string, { sent: number; received: number }>;
}

class BandwidthTracker {
  private stats: BandwidthStats;
  private readonly PERIOD_DURATION = 60000; // 1 minute

  constructor() {
    this.resetPeriod();
  }

  recordSent(peerId: string, bytes: number): void {
    this.maybeResetPeriod();
    this.stats.bytesSent += bytes;

    const peerStats = this.stats.perPeer.get(peerId) || { sent: 0, received: 0 };
    peerStats.sent += bytes;
    this.stats.perPeer.set(peerId, peerStats);
  }

  recordReceived(peerId: string, bytes: number): void {
    this.maybeResetPeriod();
    this.stats.bytesReceived += bytes;

    const peerStats = this.stats.perPeer.get(peerId) || { sent: 0, received: 0 };
    peerStats.received += bytes;
    this.stats.perPeer.set(peerId, peerStats);
  }

  getCurrentRateBps(): { send: number; receive: number } {
    const elapsed = Date.now() - this.stats.periodStart;
    if (elapsed === 0) return { send: 0, receive: 0 };

    return {
      send: (this.stats.bytesSent * 1000) / elapsed,
      receive: (this.stats.bytesReceived * 1000) / elapsed,
    };
  }

  getTotalTransferred(): { sent: number; received: number } {
    return {
      sent: this.stats.bytesSent,
      received: this.stats.bytesReceived,
    };
  }

  private maybeResetPeriod(): void {
    if (Date.now() - this.stats.periodStart > this.PERIOD_DURATION) {
      this.resetPeriod();
    }
  }

  private resetPeriod(): void {
    this.stats = {
      bytesSent: 0,
      bytesReceived: 0,
      periodStart: Date.now(),
      periodDuration: this.PERIOD_DURATION,
      perPeer: new Map(),
    };
  }
}
```

### Bandwidth Throttler

```typescript
interface ThrottleConfig {
  /** Max bytes per second upload */
  maxUploadBps: number;

  /** Max bytes per second download */
  maxDownloadBps: number;

  /** Enable throttling */
  enabled: boolean;

  /** Throttle only on cellular */
  onlyOnCellular: boolean;
}

const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  maxUploadBps: 0,    // 0 = unlimited
  maxDownloadBps: 0,
  enabled: false,
  onlyOnCellular: true,
};

class BandwidthThrottler {
  private uploadTokens: number;
  private downloadTokens: number;
  private lastRefill: number;

  constructor(private config: ThrottleConfig) {
    this.uploadTokens = config.maxUploadBps;
    this.downloadTokens = config.maxDownloadBps;
    this.lastRefill = Date.now();
  }

  /**
   * Wait for permission to send bytes.
   */
  async waitToSend(bytes: number): Promise<void> {
    if (!this.shouldThrottle()) return;

    this.refillTokens();

    while (this.uploadTokens < bytes) {
      // Wait for tokens to refill
      const waitTime = ((bytes - this.uploadTokens) / this.config.maxUploadBps) * 1000;
      await sleep(Math.min(waitTime, 100));
      this.refillTokens();
    }

    this.uploadTokens -= bytes;
  }

  /**
   * Wait for permission to receive bytes.
   */
  async waitToReceive(bytes: number): Promise<void> {
    if (!this.shouldThrottle()) return;

    this.refillTokens();

    while (this.downloadTokens < bytes) {
      const waitTime = ((bytes - this.downloadTokens) / this.config.maxDownloadBps) * 1000;
      await sleep(Math.min(waitTime, 100));
      this.refillTokens();
    }

    this.downloadTokens -= bytes;
  }

  private shouldThrottle(): boolean {
    if (!this.config.enabled) return false;
    if (this.config.onlyOnCellular && !this.isOnCellular()) return false;
    return true;
  }

  private isOnCellular(): boolean {
    const connection = navigator.connection;
    return connection?.type === 'cellular';
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;

    if (this.config.maxUploadBps > 0) {
      this.uploadTokens = Math.min(
        this.uploadTokens + elapsed * this.config.maxUploadBps,
        this.config.maxUploadBps * 2 // Max burst
      );
    }

    if (this.config.maxDownloadBps > 0) {
      this.downloadTokens = Math.min(
        this.downloadTokens + elapsed * this.config.maxDownloadBps,
        this.config.maxDownloadBps * 2
      );
    }
  }
}
```

## Sync Rate Limiting

Prevent sync storms from rapid edits.

### Edit Debouncing

```typescript
interface RateLimitConfig {
  /** Minimum time between syncs in ms */
  minSyncIntervalMs: number;

  /** Debounce delay for edits in ms */
  editDebounceMs: number;

  /** Max edits before forcing sync */
  maxPendingEdits: number;

  /** Cooldown after burst of edits */
  burstCooldownMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  minSyncIntervalMs: 5000,    // 5 seconds
  editDebounceMs: 1000,       // 1 second
  maxPendingEdits: 50,        // Force sync after 50 edits
  burstCooldownMs: 10000,     // 10 second cooldown after burst
};

class SyncRateLimiter {
  private lastSyncTime = 0;
  private pendingEditCount = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private isBurstCooldown = false;

  constructor(
    private config: RateLimitConfig,
    private syncFn: () => Promise<void>
  ) {}

  /**
   * Called when user makes an edit.
   */
  onEdit(): void {
    this.pendingEditCount++;

    // Check for burst condition
    if (this.pendingEditCount >= this.config.maxPendingEdits) {
      this.handleBurst();
      return;
    }

    // Debounce normal edits
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.maybeSync();
    }, this.config.editDebounceMs);
  }

  private async maybeSync(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSyncTime;

    if (elapsed < this.config.minSyncIntervalMs) {
      // Too soon, schedule for later
      setTimeout(() => this.maybeSync(), this.config.minSyncIntervalMs - elapsed);
      return;
    }

    if (this.isBurstCooldown) {
      // In cooldown, wait
      return;
    }

    await this.doSync();
  }

  private async handleBurst(): Promise<void> {
    console.log('Burst detected, syncing and entering cooldown');

    await this.doSync();

    // Enter cooldown
    this.isBurstCooldown = true;
    setTimeout(() => {
      this.isBurstCooldown = false;
      // Check if more edits accumulated during cooldown
      if (this.pendingEditCount > 0) {
        this.maybeSync();
      }
    }, this.config.burstCooldownMs);
  }

  private async doSync(): Promise<void> {
    this.lastSyncTime = Date.now();
    this.pendingEditCount = 0;

    try {
      await this.syncFn();
    } catch (error) {
      console.error('Sync failed:', error);
    }
  }
}
```

## Cross-Spec Sequence Diagrams

These diagrams illustrate flows that span multiple spec files.

### Full Sync from Scratch (New Device Joins)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    New Device Joins Existing Vault                          │
│                    Specs: 04, 05, 06, 07                                     │
└─────────────────────────────────────────────────────────────────────────────┘

  New Device                   Existing Device                Network
      │                              │                           │
      │    1. SCAN QR CODE           │                           │
      │◄─────────────────────────────│                           │
      │    (06-peer-management)       │                           │
      │                              │                           │
      │    2. PARSE TICKET           │                           │
      ├──────────────────►           │                           │
      │    Validate Iroh ticket      │                           │
      │                              │                           │
      │    3. CONNECT (QUIC/TLS)     │                           │
      │◄─────────────────────────────┼──────────────────────────►│
      │    (05-transport-iroh)       │    via Relay if needed    │
      │                              │                           │
      │    4. AUTHENTICATE           │                           │
      ├◄─────────────────────────────┤                           │
      │    Exchange NodeIds          │                           │
      │    Verify peer allowlist     │                           │
      │    (10-security)             │                           │
      │                              │                           │
      │    5. REQUEST SNAPSHOT       │                           │
      ├─────────────────────────────►│                           │
      │    { type: 'snapshot-request' }                          │
      │                              │                           │
      │                              │    6. EXPORT LORO DOC     │
      │                              ├───────►                   │
      │                              │    doc.export({ mode:     │
      │                              │      'snapshot' })        │
      │                              │    (01-data-model)        │
      │                              │                           │
      │    7. RECEIVE SNAPSHOT       │                           │
      │◄─────────────────────────────┤                           │
      │    { type: 'snapshot',       │                           │
      │      data: [...] }           │                           │
      │    (04-sync-protocol)        │                           │
      │                              │                           │
      │    8. IMPORT TO LORO         │                           │
      ├───────►                      │                           │
      │    doc.import(data)          │                           │
      │                              │                           │
      │    9. WRITE TO FILESYSTEM    │                           │
      ├───────►                      │                           │
      │    For each file in doc:     │                           │
      │      vault.create(path,      │                           │
      │        content)              │                           │
      │    (03-file-watcher)         │                           │
      │                              │                           │
      │    10. SHOW SUCCESS UI       │                           │
      ├───────►                      │                           │
      │    "Synced 142 files"        │                           │
      │    (07-plugin-ui)            │                           │
      │                              │                           │
      │    11. SYNC-COMPLETE         │                           │
      ├─────────────────────────────►│                           │
      │                              │                           │
      ▼                              ▼                           ▼
```

### Conflict Detection → Resolution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Concurrent Edit → Merge → Resolution                     │
│                    Specs: 01, 03, 04, 07                                     │
└─────────────────────────────────────────────────────────────────────────────┘

   Device A              CRDT Layer             Device B              UI
      │                      │                      │                  │
      │  1. EDIT FILE        │  2. EDIT FILE        │                  │
      ├─────────────────────►│◄─────────────────────┤                  │
      │  "Hello brave"       │  "Hello new"         │                  │
      │  (03-file-watcher)   │  (03-file-watcher)   │                  │
      │                      │                      │                  │
      │  3. UPDATE LORO      │  4. UPDATE LORO      │                  │
      ├─────────────────────►│◄─────────────────────┤                  │
      │  text.insert(6,      │  text.insert(6,      │                  │
      │    "brave")          │    "new")            │                  │
      │  (01-data-model)     │  (01-data-model)     │                  │
      │                      │                      │                  │
      │     ┌────────────────┼────────────────┐     │                  │
      │     │ 5. SYNC        │                │     │                  │
      │     │  Exchange      │                │     │                  │
      │     │  version       │                │     │                  │
      │     │  vectors       │                │     │                  │
      │     │  (04-sync-     │                │     │                  │
      │     │  protocol)     │                │     │                  │
      │     └────────────────┼────────────────┘     │                  │
      │                      │                      │                  │
      │  6. IMPORT REMOTE    │  7. IMPORT REMOTE    │                  │
      │     UPDATES          │     UPDATES          │                  │
      ├─────────────────────►│◄─────────────────────┤                  │
      │                      │                      │                  │
      │     ┌────────────────┴────────────────┐     │                  │
      │     │ 8. FUGUE MERGE                  │     │                  │
      │     │  Loro text CRDT merges          │     │                  │
      │     │  insertions deterministically   │     │                  │
      │     │  → "Hello brave new world"      │     │                  │
      │     │  (01-data-model)                │     │                  │
      │     └────────────────┬────────────────┘     │                  │
      │                      │                      │                  │
      │  9. DETECT           │  10. DETECT          │                  │
      │     CONCURRENT       │      CONCURRENT      │                  │
      │     CHANGES          │      CHANGES         │                  │
      ├◄─────────────────────┤─────────────────────►│                  │
      │                      │                      │                  │
      │                      │                      │  11. SHOW        │
      │                      │                      │      NOTIFICATION│
      │                      │                      ├─────────────────►│
      │                      │                      │  "Merged changes │
      │                      │                      │   with Device B" │
      │                      │                      │  (07-plugin-ui)  │
      │                      │                      │                  │
      │  12. WRITE           │  13. WRITE           │                  │
      │      MERGED          │      MERGED          │                  │
      │      CONTENT         │      CONTENT         │                  │
      ├───────►              │◄─────────────────────┤                  │
      │  vault.modify(file,  │                      │                  │
      │    "Hello brave      │                      │                  │
      │     new world")      │                      │                  │
      │  (03-file-watcher)   │                      │                  │
      │                      │                      │                  │
      ▼                      ▼                      ▼                  ▼
```

### Key Rotation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Passphrase Rotation                                       │
│                    Specs: 02, 07, 10                                         │
└─────────────────────────────────────────────────────────────────────────────┘

     User                Settings UI             Storage              Crypto
       │                     │                      │                    │
       │  1. CLICK           │                      │                    │
       │     "Change         │                      │                    │
       │     Passphrase"     │                      │                    │
       ├────────────────────►│                      │                    │
       │  (07-plugin-ui)     │                      │                    │
       │                     │                      │                    │
       │  2. ENTER CURRENT   │                      │                    │
       │     PASSPHRASE      │                      │                    │
       ├────────────────────►│                      │                    │
       │                     │                      │                    │
       │                     │  3. VERIFY           │                    │
       │                     │     PASSPHRASE       │                    │
       │                     ├─────────────────────►│                    │
       │                     │  storage.unlock()    │                    │
       │                     │  (02-storage)        │                    │
       │                     │                      │                    │
       │  4. ENTER NEW       │                      │                    │
       │     PASSPHRASE      │                      │                    │
       ├────────────────────►│                      │                    │
       │  (twice for         │                      │                    │
       │   confirmation)     │                      │                    │
       │                     │                      │                    │
       │                     │  5. CREATE BACKUP    │                    │
       │                     ├─────────────────────►│                    │
       │                     │  (10-security)       │                    │
       │                     │                      │                    │
       │                     │  6. DECRYPT          │                    │
       │                     │     ALL DATA         │                    │
       │                     ├─────────────────────►│                    │
       │                     │                      │                    │
       │                     │                      │  7. DERIVE NEW    │
       │                     │                      │     KEY           │
       │                     │                      ├───────────────────►│
       │                     │                      │  PBKDF2(new,      │
       │                     │                      │    newSalt)       │
       │                     │                      │  (10-security)    │
       │                     │                      │                    │
       │                     │  8. RE-ENCRYPT       │                    │
       │                     │     DATA             │                    │
       │                     ├─────────────────────►│◄───────────────────┤
       │                     │  (02-storage)        │  AES-256-GCM      │
       │                     │                      │                    │
       │                     │  9. SAVE NEW SALT    │                    │
       │                     ├─────────────────────►│                    │
       │                     │  meta.json           │                    │
       │                     │                      │                    │
       │  10. SUCCESS        │                      │                    │
       │      NOTIFICATION   │                      │                    │
       │◄────────────────────┤                      │                    │
       │  "Passphrase        │                      │                    │
       │   changed"          │                      │                    │
       │  (07-plugin-ui)     │                      │                    │
       │                     │                      │                    │
       ▼                     ▼                      ▼                    ▼
```

### Binary File (Blob) Sync Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Binary Attachment Sync                                    │
│                    Specs: 03, 04, 14                                         │
└─────────────────────────────────────────────────────────────────────────────┘

   Device A           CRDT Metadata           Device B            Blob Store
       │                   │                      │                    │
       │  1. ADD IMAGE     │                      │                    │
       │     TO VAULT      │                      │                    │
       ├───────►           │                      │                    │
       │  image.png        │                      │                    │
       │  (03-file-watcher)│                      │                    │
       │                   │                      │                    │
       │  2. HASH FILE     │                      │                    │
       ├───────────────────┼──────────────────────┼───────────────────►│
       │  BLAKE3(image)    │                      │                    │
       │  → abc123...      │                      │                    │
       │  (14-binary-files)│                      │                    │
       │                   │                      │                    │
       │  3. STORE         │                      │                    │
       │     REFERENCE     │                      │                    │
       │     IN CRDT       │                      │                    │
       ├──────────────────►│                      │                    │
       │  { type: 'blob',  │                      │                    │
       │    hash: 'abc123',│                      │                    │
       │    size: 1048576 }│                      │                    │
       │  (01-data-model)  │                      │                    │
       │                   │                      │                    │
       │  4. SYNC          │                      │                    │
       │     METADATA      │                      │                    │
       ├──────────────────►│◄─────────────────────┤                    │
       │  (04-sync-protocol)                      │                    │
       │                   │                      │                    │
       │                   │  5. DETECT           │                    │
       │                   │     MISSING BLOB     │                    │
       │                   ├─────────────────────►│                    │
       │                   │  hash 'abc123'       │                    │
       │                   │  not in local store  │                    │
       │                   │  (14-binary-files)   │                    │
       │                   │                      │                    │
       │  6. REQUEST       │                      │                    │
       │     BLOB          │                      │                    │
       │◄─────────────────┼──────────────────────┤                    │
       │  { type: 'blob-request',                 │                    │
       │    hash: 'abc123' }                      │                    │
       │                   │                      │                    │
       │  7. STREAM        │                      │                    │
       │     BLOB DATA     │                      │                    │
       ├──────────────────►│                      │                    │
       │  iroh-blobs       │                      │                    │
       │  transfer         │                      │                    │
       │  (05-transport-iroh)                     │                    │
       │                   │                      │                    │
       │                   │                      │  8. VERIFY &      │
       │                   │                      │     STORE         │
       │                   │                      ├───────────────────►│
       │                   │                      │  BLAKE3(data)     │
       │                   │                      │  == 'abc123'?     │
       │                   │                      │  (14-binary-files)│
       │                   │                      │                    │
       │                   │                      │  9. WRITE TO      │
       │                   │                      │     VAULT         │
       │                   │                      ├───────►           │
       │                   │                      │  attachments/     │
       │                   │                      │    image.png      │
       │                   │                      │                    │
       ▼                   ▼                      ▼                    ▼
```

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- Iroh transport (see 05-transport-iroh.md)

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Sync priority | Yes, prioritize open files | Currently-open files sync before background files for better UX. |
| Bandwidth limits | Yes, throttle on metered | Use token bucket throttling, auto-detect metered connections. |
| Selective sync | Yes, folder exclusions | Users can exclude folders in settings. See file-watcher spec. |
| Sync approach | Loro version vectors | More efficient than Automerge sync protocol, simpler with single document. |
| Conflict handling | Loro automatic | Fugue for text, LoroTree for moves, LWW for maps. No manual resolution. |
