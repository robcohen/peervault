# Binary Files Spec

## Purpose

Define how PeerVault handles binary files (images, PDFs, attachments) that cannot be efficiently represented as CRDTs. Binary files are synced via iroh-blobs with hash references stored in the Loro document.

## Requirements

- **REQ-BF-01**: Binary files MUST be synced between peers
- **REQ-BF-02**: Binary files MUST NOT be stored in the Loro document (too large)
- **REQ-BF-03**: Binary files MUST be content-addressed (deduplicated by hash)
- **REQ-BF-04**: Sync MUST handle missing blobs gracefully
- **REQ-BF-05**: Large files MUST support resumable transfers

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Binary File Sync                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Loro Document                     iroh-blobs              │
│   ┌──────────────────┐             ┌──────────────────┐     │
│   │ files (LoroTree) │             │  Blob Store      │     │
│   │                  │             │                  │     │
│   │ image.png        │────hash────►│  abc123...       │     │
│   │ ├─ type: binary  │             │  (actual bytes)  │     │
│   │ ├─ hash: abc123  │             │                  │     │
│   │ └─ size: 1.2MB   │             │  def456...       │     │
│   │                  │             │  (actual bytes)  │     │
│   │ doc.pdf          │────hash────►│                  │     │
│   │ ├─ type: binary  │             └──────────────────┘     │
│   │ ├─ hash: def456  │                                      │
│   │ └─ size: 5.0MB   │                                      │
│   └──────────────────┘                                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Data Model

### Binary File Node in Loro

```typescript
import { LoroDoc, LoroMap, TreeID } from 'loro-crdt';

interface BinaryFileNode {
  /** Node type indicator */
  type: 'binary';

  /** File name */
  name: string;

  /** Content hash (iroh-blobs hash) */
  hash: string;

  /** File size in bytes */
  size: number;

  /** MIME type */
  mimeType: string;

  /** Modification time */
  mtime: number;

  /** Soft delete flag */
  deleted: boolean;
}

/**
 * Create a binary file reference in the Loro tree.
 * Actual content stored in iroh-blobs.
 */
function createBinaryFileRef(
  doc: LoroDoc,
  parentId: TreeID | null,
  name: string,
  hash: string,
  size: number,
  mimeType: string
): TreeID {
  const files = doc.getTree('files');

  const nodeId = files.create(parentId);
  const nodeData = files.getMeta(nodeId);

  doc.transact(() => {
    nodeData.set('type', 'binary');
    nodeData.set('name', name);
    nodeData.set('hash', hash);
    nodeData.set('size', size);
    nodeData.set('mimeType', mimeType);
    nodeData.set('mtime', Date.now());
    nodeData.set('deleted', false);
  });

  return nodeId;
}
```

### Supported Binary Types

| Extension | MIME Type | Handling |
|-----------|-----------|----------|
| `.png`, `.jpg`, `.gif`, `.webp` | `image/*` | Binary via iroh-blobs |
| `.pdf` | `application/pdf` | Binary via iroh-blobs |
| `.mp3`, `.wav`, `.m4a` | `audio/*` | Binary via iroh-blobs |
| `.mp4`, `.webm` | `video/*` | Binary via iroh-blobs |
| `.zip`, `.tar.gz` | `application/*` | Binary via iroh-blobs |
| `.canvas` | `application/json` | Text via Loro (special case) |

## iroh-blobs Integration

### Blob Store

```typescript
import { BlobStore, Hash } from 'iroh-blobs';

class BinaryFileStore {
  private blobStore: BlobStore;
  private basePath: string;

  constructor(pluginDir: string) {
    this.basePath = `${pluginDir}/blobs`;
  }

  async initialize(): Promise<void> {
    this.blobStore = await BlobStore.create({
      path: this.basePath,
    });
  }

  /**
   * Add a binary file to the blob store.
   * Returns content hash for referencing.
   */
  async addFile(content: Uint8Array): Promise<string> {
    const hash = await this.blobStore.add(content);
    return hash.toString();
  }

  /**
   * Add file from filesystem path.
   */
  async addFromPath(filePath: string): Promise<{ hash: string; size: number }> {
    const result = await this.blobStore.addFromPath(filePath);
    return {
      hash: result.hash.toString(),
      size: result.size,
    };
  }

  /**
   * Get blob content by hash.
   */
  async getBlob(hash: string): Promise<Uint8Array | null> {
    try {
      return await this.blobStore.get(Hash.fromString(hash));
    } catch {
      return null;
    }
  }

  /**
   * Check if blob exists locally.
   */
  async hasBlob(hash: string): Promise<boolean> {
    return this.blobStore.has(Hash.fromString(hash));
  }

  /**
   * Export blob to filesystem path.
   */
  async exportToPath(hash: string, filePath: string): Promise<void> {
    await this.blobStore.exportToPath(Hash.fromString(hash), filePath);
  }

  /**
   * Get all blob hashes in store.
   */
  async listBlobs(): Promise<string[]> {
    const hashes = await this.blobStore.list();
    return hashes.map(h => h.toString());
  }

  /**
   * Remove blob from store (garbage collection).
   */
  async removeBlob(hash: string): Promise<void> {
    await this.blobStore.remove(Hash.fromString(hash));
  }
}
```

## Sync Protocol

### Binary File Sync Flow

```
┌────────┐                                              ┌────────┐
│ Peer A │                                              │ Peer B │
└───┬────┘                                              └───┬────┘
    │                                                       │
    │ ══════════ Loro Sync (metadata first) ═══════════►   │
    │                                                       │
    │ [Peer B receives file tree with binary hashes]        │
    │                                                       │
    │         BLOB_REQUEST                                  │
    │ ◄───── { hashes: [abc123, def456] } ─────────────    │
    │                                                       │
    │         BLOB_HAVE                                     │
    │ ─────── { available: [abc123], missing: [] } ──────► │
    │                                                       │
    │         BLOB_TRANSFER                                 │
    │ ─────── { hash: abc123, data: <bytes> } ───────────► │
    │                                                       │
    │ [Peer B writes blob to local store]                   │
    │                                                       │
    │         BLOB_ACK                                      │
    │ ◄───── { hash: abc123, received: true } ────────────  │
    │                                                       │
```

### Message Types

```typescript
type BlobMessage =
  | { type: 'blob-request'; hashes: string[] }
  | { type: 'blob-have'; available: string[]; missing: string[] }
  | { type: 'blob-transfer'; hash: string; data: Uint8Array; offset: number; total: number }
  | { type: 'blob-ack'; hash: string; received: boolean }
  | { type: 'blob-cancel'; hash: string };
```

### Sync Implementation

```typescript
class BinarySyncProtocol {
  constructor(
    private blobStore: BinaryFileStore,
    private doc: LoroDoc
  ) {}

  /**
   * After Loro sync, request missing blobs.
   */
  async syncBlobs(connection: IrohConnection): Promise<void> {
    // Get all binary file hashes from Loro doc
    const requiredHashes = this.getBinaryHashes();

    // Check which we have locally
    const missingHashes: string[] = [];
    for (const hash of requiredHashes) {
      if (!await this.blobStore.hasBlob(hash)) {
        missingHashes.push(hash);
      }
    }

    if (missingHashes.length === 0) {
      return; // All blobs present
    }

    // Request missing blobs
    connection.send({
      type: 'blob-request',
      hashes: missingHashes,
    });

    // Receive blobs
    for await (const msg of connection.messages()) {
      if (msg.type === 'blob-transfer') {
        await this.handleBlobTransfer(msg, connection);
      } else if (msg.type === 'blob-have') {
        // Peer doesn't have some blobs - try other peers
        if (msg.missing.length > 0) {
          console.warn('Peer missing blobs:', msg.missing);
        }
      }
    }
  }

  private async handleBlobTransfer(
    msg: BlobTransferMessage,
    connection: IrohConnection
  ): Promise<void> {
    // For large files, this may be chunked
    // Accumulate chunks until complete
    await this.blobStore.addChunk(msg.hash, msg.data, msg.offset, msg.total);

    if (msg.offset + msg.data.length >= msg.total) {
      // Transfer complete
      connection.send({
        type: 'blob-ack',
        hash: msg.hash,
        received: true,
      });
    }
  }

  private getBinaryHashes(): string[] {
    const hashes: string[] = [];
    const files = this.doc.getTree('files');

    function traverse(parentId: TreeID | null) {
      // Use roots() for root level, children() for nested
      const childIds = parentId === null ? files.roots() : files.children(parentId);
      for (const childId of childIds) {
        const nodeData = files.getMeta(childId);
        if (nodeData.get('type') === 'binary' && !nodeData.get('deleted')) {
          hashes.push(nodeData.get('hash') as string);
        }
        traverse(childId);
      }
    }

    traverse(null);
    return hashes;
  }
}
```

## Resumable Blob Transfers

Large binary files need resumable transfers to handle connection interruptions.

### Transfer State Persistence

```typescript
interface BlobTransferState {
  /** Blob content hash */
  hash: string;

  /** Total size in bytes */
  totalSize: number;

  /** Bytes received so far */
  receivedBytes: number;

  /** Peer we're downloading from */
  sourcePeerId: string;

  /** When transfer started */
  startedAt: number;

  /** Last activity timestamp (for stall detection) */
  lastActivityAt: number;

  /** Temp file path for partial download */
  tempFilePath: string;

  /** Number of retry attempts due to stalls */
  retryCount?: number;

  /** Peers we've already tried (to avoid retry loops) */
  triedPeers?: string[];
}

class BlobTransferManager extends EventEmitter {
  private activeTransfers = new Map<string, BlobTransferState>();
  private stallTimers = new Map<string, NodeJS.Timeout>();
  private readonly CHUNK_SIZE = 64 * 1024; // 64KB chunks
  private readonly STALL_TIMEOUT_MS = 30_000; // 30s without data = stalled
  private readonly MAX_RETRIES = 3;

  constructor(
    private blobStore: BinaryFileStore,
    private storage: StorageAdapter,
    private peerManager: PeerManager
  ) {
    super();
  }

  /**
   * Start stall detection for a transfer.
   * If no data received within STALL_TIMEOUT_MS, try another peer.
   */
  private startStallTimer(hash: string): void {
    this.clearStallTimer(hash);

    const timer = setTimeout(async () => {
      const state = this.activeTransfers.get(hash);
      if (!state) return;

      const stallDuration = Date.now() - state.lastActivityAt;
      console.warn(`Blob transfer stalled: ${hash} (no data for ${stallDuration}ms)`);

      state.retryCount = (state.retryCount || 0) + 1;

      if (state.retryCount >= this.MAX_RETRIES) {
        // Max retries exceeded - give up
        this.emit('transferFailed', {
          hash,
          reason: 'max-retries-exceeded',
          receivedBytes: state.receivedBytes,
          totalSize: state.totalSize,
        });
        this.activeTransfers.delete(hash);
        await this.savePendingTransfers();
        return;
      }

      // Try a different peer
      const alternativePeer = await this.findAlternativePeer(hash, state.sourcePeerId);

      if (alternativePeer) {
        console.log(`Retrying blob ${hash} from peer ${alternativePeer.nodeId} (attempt ${state.retryCount})`);
        state.sourcePeerId = alternativePeer.nodeId;
        state.lastActivityAt = Date.now();

        this.emit('transferRetry', {
          hash,
          newPeerId: alternativePeer.nodeId,
          attempt: state.retryCount,
        });

        // Request resume from new peer
        alternativePeer.connection.send({
          type: 'blob-request-resume',
          hash,
          offset: state.receivedBytes,
        });

        this.startStallTimer(hash);
      } else {
        // No alternative peers available - wait and retry later
        this.emit('transferWaiting', {
          hash,
          reason: 'no-peers-available',
          receivedBytes: state.receivedBytes,
        });

        // Exponential backoff before retrying
        const backoffMs = Math.min(60_000, this.STALL_TIMEOUT_MS * Math.pow(2, state.retryCount));
        setTimeout(() => {
          if (this.activeTransfers.has(hash)) {
            this.startStallTimer(hash);
          }
        }, backoffMs);
      }
    }, this.STALL_TIMEOUT_MS);

    this.stallTimers.set(hash, timer);
  }

  private clearStallTimer(hash: string): void {
    const timer = this.stallTimers.get(hash);
    if (timer) {
      clearTimeout(timer);
      this.stallTimers.delete(hash);
    }
  }

  /**
   * Find an alternative peer that has the blob.
   */
  private async findAlternativePeer(
    hash: string,
    excludePeerId: string
  ): Promise<{ nodeId: string; connection: IrohConnection } | null> {
    const connectedPeers = this.peerManager.getConnectedPeers()
      .filter(p => p.nodeId !== excludePeerId);

    for (const peer of connectedPeers) {
      // Ask peer if they have the blob
      const hasBlob = await this.queryPeerForBlob(peer.connection, hash);
      if (hasBlob) {
        return peer;
      }
    }

    return null;
  }

  private async queryPeerForBlob(connection: IrohConnection, hash: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);

      connection.send({ type: 'blob-query', hashes: [hash] });

      connection.once('message', (msg) => {
        clearTimeout(timeout);
        if (msg.type === 'blob-have' && msg.available.includes(hash)) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  async loadPendingTransfers(): Promise<void> {
    const data = await this.storage.read('pending-blob-transfers');
    if (data) {
      const states = JSON.parse(data) as BlobTransferState[];
      for (const state of states) {
        this.activeTransfers.set(state.hash, state);
      }
    }
  }

  async savePendingTransfers(): Promise<void> {
    const states = Array.from(this.activeTransfers.values());
    await this.storage.write('pending-blob-transfers', JSON.stringify(states));
  }

  /**
   * Request blob with resume support and stall detection.
   */
  async requestBlob(
    hash: string,
    totalSize: number,
    connection: IrohConnection
  ): Promise<void> {
    let state = this.activeTransfers.get(hash);

    if (state) {
      // Resume existing transfer
      console.log(`Resuming blob transfer: ${hash} from offset ${state.receivedBytes}`);
      state.lastActivityAt = Date.now();
    } else {
      // Start new transfer
      const tempPath = await this.blobStore.createTempFile(hash);
      state = {
        hash,
        totalSize,
        receivedBytes: 0,
        sourcePeerId: connection.peerId,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        tempFilePath: tempPath,
        retryCount: 0,
        triedPeers: [connection.peerId],
      };
      this.activeTransfers.set(hash, state);
    }

    // Request from current offset
    connection.send({
      type: 'blob-request-resume',
      hash,
      offset: state.receivedBytes,
    });

    // Start stall detection
    this.startStallTimer(hash);

    // Emit progress event
    this.emit('transferStarted', {
      hash,
      totalSize,
      resumedFrom: state.receivedBytes,
      peerId: connection.peerId,
    });

    await this.savePendingTransfers();
  }

  /**
   * Handle incoming chunk. Resets stall timer on each chunk.
   */
  async handleChunk(
    hash: string,
    offset: number,
    data: Uint8Array,
    connection: IrohConnection
  ): Promise<boolean> {
    const state = this.activeTransfers.get(hash);
    if (!state) {
      console.warn(`Received chunk for unknown transfer: ${hash}`);
      return false;
    }

    // Reset stall timer - we received data
    this.startStallTimer(hash);

    // Verify offset matches expected
    if (offset !== state.receivedBytes) {
      console.warn(`Offset mismatch: expected ${state.receivedBytes}, got ${offset}`);
      // Request retry from correct offset
      connection.send({
        type: 'blob-request-resume',
        hash,
        offset: state.receivedBytes,
      });
      return false;
    }

    // Write chunk to temp file
    await this.blobStore.writeChunkToTemp(state.tempFilePath, offset, data);

    state.receivedBytes += data.length;
    state.lastActivityAt = Date.now();

    // Emit progress event
    this.emit('transferProgress', {
      hash,
      receivedBytes: state.receivedBytes,
      totalSize: state.totalSize,
      percentage: Math.round((state.receivedBytes / state.totalSize) * 100),
    });

    // Check if complete
    if (state.receivedBytes >= state.totalSize) {
      // Stop stall detection
      this.clearStallTimer(hash);

      // Verify hash and finalize
      const isValid = await this.blobStore.finalizeAndVerify(
        state.tempFilePath,
        hash
      );

      if (isValid) {
        this.activeTransfers.delete(hash);
        await this.savePendingTransfers();

        connection.send({
          type: 'blob-ack',
          hash,
          received: true,
        });

        this.emit('transferComplete', {
          hash,
          totalSize: state.totalSize,
          duration: Date.now() - state.startedAt,
          retries: state.retryCount || 0,
        });

        return true;
      } else {
        // Hash mismatch - restart transfer
        console.error(`Hash mismatch for blob: ${hash}`);
        state.receivedBytes = 0;
        state.retryCount = (state.retryCount || 0) + 1;
        await this.blobStore.truncateTemp(state.tempFilePath);

        this.emit('transferHashMismatch', { hash, retrying: true });

        connection.send({
          type: 'blob-request-resume',
          hash,
          offset: 0,
        });

        this.startStallTimer(hash);
        return false;
      }
    }

    // Save progress periodically (every 1MB)
    if (state.receivedBytes % (1024 * 1024) < this.CHUNK_SIZE) {
      await this.savePendingTransfers();
    }

    return false; // Not complete yet
  }

  /**
   * Clean up stale transfers.
   */
  async cleanupStaleTransfers(): Promise<void> {
    const staleTimeout = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();

    for (const [hash, state] of this.activeTransfers) {
      if (now - state.lastActivityAt > staleTimeout) {
        console.log(`Cleaning up stale transfer: ${hash}`);
        await this.blobStore.deleteTempFile(state.tempFilePath);
        this.activeTransfers.delete(hash);
      }
    }

    await this.savePendingTransfers();
  }

  /**
   * Get transfer progress for UI.
   */
  getTransferProgress(hash: string): { received: number; total: number } | null {
    const state = this.activeTransfers.get(hash);
    if (!state) return null;
    return { received: state.receivedBytes, total: state.totalSize };
  }
}
```

### Resume Protocol Messages

```typescript
type BlobResumeMessage =
  | { type: 'blob-request-resume'; hash: string; offset: number }
  | { type: 'blob-chunk'; hash: string; offset: number; data: Uint8Array; total: number }
  | { type: 'blob-ack'; hash: string; received: boolean }
  | { type: 'blob-error'; hash: string; error: string };
```

### Sender Side

```typescript
class BlobSender {
  private readonly CHUNK_SIZE = 64 * 1024;

  async handleResumeRequest(
    hash: string,
    offset: number,
    connection: IrohConnection
  ): Promise<void> {
    const blob = await this.blobStore.getBlob(hash);
    if (!blob) {
      connection.send({
        type: 'blob-error',
        hash,
        error: 'Blob not found',
      });
      return;
    }

    // Stream from requested offset
    let currentOffset = offset;
    while (currentOffset < blob.length) {
      const end = Math.min(currentOffset + this.CHUNK_SIZE, blob.length);
      const chunk = blob.slice(currentOffset, end);

      connection.send({
        type: 'blob-chunk',
        hash,
        offset: currentOffset,
        data: chunk,
        total: blob.length,
      });

      currentOffset = end;

      // Small delay to prevent overwhelming the connection
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}
```

## File Watcher Integration

```typescript
class BinaryFileWatcher {
  private textExtensions = new Set(['md', 'txt', 'json', 'css', 'js', 'ts', 'canvas']);

  constructor(
    private vault: Vault,
    private doc: LoroDoc,
    private blobStore: BinaryFileStore
  ) {}

  isBinaryFile(file: TFile): boolean {
    return !this.textExtensions.has(file.extension);
  }

  async handleBinaryCreate(file: TFile): Promise<void> {
    // Add to blob store
    const content = await this.vault.readBinary(file);
    const { hash, size } = await this.blobStore.addFile(new Uint8Array(content));

    // Add reference to Loro doc
    const parentId = await this.ensureParentFolders(file.path);
    const mimeType = this.getMimeType(file.extension);

    createBinaryFileRef(this.doc, parentId, file.name, hash, size, mimeType);
  }

  async handleBinaryModify(file: TFile): Promise<void> {
    // Read new content
    const content = await this.vault.readBinary(file);
    const { hash: newHash, size } = await this.blobStore.addFile(new Uint8Array(content));

    // Update Loro reference
    const nodeId = this.getNodeIdForPath(file.path);
    if (!nodeId) {
      await this.handleBinaryCreate(file);
      return;
    }

    const files = this.doc.getTree('files');
    const nodeData = files.getMeta(nodeId);

    const oldHash = nodeData.get('hash') as string;

    this.doc.transact(() => {
      nodeData.set('hash', newHash);
      nodeData.set('size', size);
      nodeData.set('mtime', Date.now());
    });

    // Old blob can be garbage collected later
    this.scheduleGC(oldHash);
  }

  async writeBinaryFromSync(path: string, hash: string): Promise<void> {
    // Get blob content
    const content = await this.blobStore.getBlob(hash);
    if (!content) {
      throw new Error(`Blob not found: ${hash}`);
    }

    // Write to filesystem
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modifyBinary(file, content.buffer);
    } else {
      await this.vault.createBinary(path, content.buffer);
    }
  }

  private getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'pdf': 'application/pdf',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'mp4': 'video/mp4',
      'webm': 'video/webm',
    };
    return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
  }
}
```

## Garbage Collection

Unreferenced blobs can be cleaned up:

```typescript
class BlobGarbageCollector {
  constructor(
    private doc: LoroDoc,
    private blobStore: BinaryFileStore
  ) {}

  /**
   * Remove blobs that are no longer referenced.
   */
  async collectGarbage(): Promise<number> {
    // Get all referenced hashes from Loro doc
    const referencedHashes = new Set(this.getAllReferencedHashes());

    // Get all blobs in store
    const storedHashes = await this.blobStore.listBlobs();

    // Find unreferenced blobs
    let removed = 0;
    for (const hash of storedHashes) {
      if (!referencedHashes.has(hash)) {
        await this.blobStore.removeBlob(hash);
        removed++;
      }
    }

    return removed;
  }

  private getAllReferencedHashes(): string[] {
    const hashes: string[] = [];
    const files = this.doc.getTree('files');

    // Include deleted files too (may need for history)
    // Only GC after retention period
    function traverse(parentId: TreeID | null) {
      // Use roots() for root level, children() for nested
      const childIds = parentId === null ? files.roots() : files.children(parentId);
      for (const childId of childIds) {
        const nodeData = files.getMeta(childId);
        if (nodeData.get('type') === 'binary') {
          hashes.push(nodeData.get('hash') as string);
        }
        traverse(childId);
      }
    }

    traverse(null);
    return hashes;
  }
}
```

### Race Condition Handling

Blob GC can race with concurrent sync operations, potentially deleting blobs that are about to be referenced. This section describes safeguards.

#### The Race Condition

```
Time    Peer A (GC)                    Peer B (Sync)
─────   ───────────────────            ─────────────────────────
t1      Start GC scan
t2      List refs: [abc, def]
t3      List blobs: [abc, def, ghi]
t4                                      Receive update: ref to "ghi"
t5                                      Import into Loro doc
t6      Delete "ghi" (unreferenced)
t7                                      Write file: needs "ghi" → MISSING!
```

#### Solution: Reference Locking

```typescript
/**
 * Safe garbage collector with reference locking.
 */
class SafeBlobGarbageCollector {
  private readonly GC_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
  private pendingReferences = new Map<string, number>(); // hash -> expiry

  /**
   * Register a hash as "pending" - will be referenced soon.
   * Called when receiving sync updates that include new blob references.
   */
  registerPendingReference(hash: string): void {
    const expiry = Date.now() + this.GC_GRACE_PERIOD_MS;
    this.pendingReferences.set(hash, expiry);
  }

  /**
   * Clear expired pending references.
   */
  private cleanupPendingReferences(): void {
    const now = Date.now();
    for (const [hash, expiry] of this.pendingReferences) {
      if (expiry < now) {
        this.pendingReferences.delete(hash);
      }
    }
  }

  /**
   * Check if a hash is protected from GC.
   */
  private isProtected(hash: string): boolean {
    const expiry = this.pendingReferences.get(hash);
    if (expiry && expiry > Date.now()) {
      return true;
    }
    return false;
  }

  /**
   * Collect garbage with race condition protection.
   */
  async collectGarbage(): Promise<GCResult> {
    // Clean up expired pending refs
    this.cleanupPendingReferences();

    // Get all currently referenced hashes
    const referencedHashes = new Set(this.getAllReferencedHashes());

    // Get all blobs in store
    const storedHashes = await this.blobStore.listBlobs();

    // Find candidates for removal
    const candidates: string[] = [];
    for (const hash of storedHashes) {
      if (!referencedHashes.has(hash) && !this.isProtected(hash)) {
        candidates.push(hash);
      }
    }

    // Wait grace period before actual deletion
    // This gives concurrent syncs time to add references
    await this.waitGracePeriod();

    // Re-check candidates after grace period
    const finalReferencedHashes = new Set(this.getAllReferencedHashes());
    let removed = 0;
    const skipped: string[] = [];

    for (const hash of candidates) {
      // Double-check: still unreferenced and unprotected?
      if (!finalReferencedHashes.has(hash) && !this.isProtected(hash)) {
        await this.blobStore.removeBlob(hash);
        removed++;
      } else {
        skipped.push(hash);
      }
    }

    return {
      removed,
      skipped: skipped.length,
      reason: skipped.length > 0 ? 'Referenced during grace period' : undefined,
    };
  }

  private async waitGracePeriod(): Promise<void> {
    // Grace period before deletion - allows concurrent syncs to complete
    // Default 30 seconds, configurable via settings
    const gracePeriodMs = this.config?.gcGracePeriodMs ?? 30_000;
    await new Promise(resolve => setTimeout(resolve, gracePeriodMs));
  }
}

interface GCResult {
  removed: number;
  skipped: number;
  reason?: string;
}

/**
 * Configuration for blob garbage collection.
 */
interface BlobGCConfig {
  /** Grace period before deleting unreferenced blobs (ms). Default: 30000 */
  gcGracePeriodMs: number;

  /** How long pending references remain protected (ms). Default: 300000 (5 min) */
  pendingRefExpiryMs: number;

  /** Minimum time between GC runs (ms). Default: 3600000 (1 hour) */
  minGCIntervalMs: number;

  /** Enable coordinated GC with peers. Default: true */
  coordinatedGC: boolean;

  /** Timeout for peer GC acknowledgment (ms). Default: 10000 */
  peerAckTimeoutMs: number;
}

const DEFAULT_BLOB_GC_CONFIG: BlobGCConfig = {
  gcGracePeriodMs: 30_000,        // 30 seconds
  pendingRefExpiryMs: 5 * 60_000, // 5 minutes
  minGCIntervalMs: 60 * 60_000,   // 1 hour
  coordinatedGC: true,
  peerAckTimeoutMs: 10_000,
};

/**
 * Network-aware grace period adjustment.
 * Increase grace period on slow or unreliable networks.
 */
function getAdjustedGracePeriod(baseMs: number, networkInfo: NetworkInfo): number {
  // On cellular, increase grace period
  if (networkInfo.type === 'cellular') {
    return baseMs * 2;
  }

  // On slow networks (high latency), increase grace period
  if (networkInfo.latencyMs && networkInfo.latencyMs > 500) {
    return baseMs * 3;
  }

  // On metered connections, be more conservative
  if (networkInfo.isMetered) {
    return baseMs * 2;
  }

  return baseMs;
}

interface NetworkInfo {
  type: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  latencyMs?: number;
  isMetered?: boolean;
}
```

#### Sync-Side Protection

```typescript
class BlobSyncReceiver {
  constructor(
    private gc: SafeBlobGarbageCollector,
    private blobStore: BinaryFileStore
  ) {}

  /**
   * Handle incoming sync that may contain blob references.
   * Register pending references BEFORE importing.
   */
  async handleIncomingSync(updates: Uint8Array): Promise<void> {
    // Parse updates to find new blob references
    const newBlobRefs = this.extractBlobReferences(updates);

    // Register all as pending BEFORE importing
    for (const hash of newBlobRefs) {
      this.gc.registerPendingReference(hash);
    }

    // Now safe to import - GC won't delete these blobs
    await this.doc.import(updates);

    // Request any missing blobs
    for (const hash of newBlobRefs) {
      if (!await this.blobStore.hasBlob(hash)) {
        await this.requestBlob(hash);
      }
    }
  }

  /**
   * Extract blob hashes from incoming updates.
   * Parses the Loro update format to find binary file nodes.
   */
  private extractBlobReferences(updates: Uint8Array): string[] {
    // Create temp doc to analyze updates
    const tempDoc = new LoroDoc();
    tempDoc.import(updates);

    const hashes: string[] = [];
    const files = tempDoc.getTree('files');

    // Walk the tree looking for binary nodes
    this.walkTree(files, null, (nodeData) => {
      if (nodeData.get('type') === 'binary') {
        const hash = nodeData.get('hash') as string;
        if (hash) {
          hashes.push(hash);
        }
      }
    });

    return hashes;
  }
}
```

#### Distributed GC Coordination

When multiple peers might GC simultaneously:

```typescript
interface GCCoordinationProtocol {
  /**
   * Before GC, announce intention to peers.
   */
  announceGCIntent(): Promise<void>;

  /**
   * Wait for peers to acknowledge (or timeout).
   */
  waitForPeerAck(timeoutMs: number): Promise<boolean>;

  /**
   * Receive GC intent from peer - pause blob sync temporarily.
   */
  handlePeerGCIntent(peerId: string): void;
}

class CoordinatedBlobGC {
  async collectGarbageCoordinated(): Promise<GCResult> {
    // 1. Announce GC intent
    await this.protocol.announceGCIntent();

    // 2. Wait for acknowledgment (with timeout)
    const allAcked = await this.protocol.waitForPeerAck(10_000);
    if (!allAcked) {
      console.warn('GC proceeding without full peer acknowledgment');
    }

    // 3. Perform GC with local protection
    const result = await this.gc.collectGarbage();

    // 4. Announce GC complete
    await this.protocol.announceGCComplete();

    return result;
  }
}
```

#### Safety Guarantees

| Scenario | Protection | Outcome |
|----------|------------|---------|
| Sync during GC scan | Pending reference lock | Blob preserved |
| GC during blob transfer | Transfer completes first | Blob preserved |
| Concurrent GCs on multiple peers | Grace period | No premature deletion |
| Reference removed during grace | Double-check after grace | Safe deletion |
| Network partition during GC | Local-only GC | May delete needed blobs (recover from peers later) |

## Error Handling

| Error | Recovery |
|-------|----------|
| Blob not found locally | Request from peers |
| Blob transfer interrupted | Resume from last offset |
| Blob hash mismatch | Re-request blob |
| Disk full | Pause sync, alert user |
| Peer has no blob | Try other peers |

## Storage Layout

```
.obsidian/plugins/peervault/
├── sync/
│   ├── vault.loro        # Loro document (text + binary refs)
│   └── meta.json
└── blobs/
    ├── index.db          # iroh-blobs index
    └── data/
        ├── ab/
        │   └── c123...   # Blob content (sharded by hash prefix)
        └── de/
            └── f456...
```

## File Size Limits

Binary files are subject to size limits to prevent performance issues and excessive storage consumption.

### Size Tiers

| Tier | Size | Handling |
|------|------|----------|
| Small | < 1 MB | Direct transfer, no chunking |
| Medium | 1 - 10 MB | Chunked transfer |
| Large | 10 - 100 MB | Chunked transfer, progress UI |
| Very Large | 100 MB - 500 MB | Warning, chunked, resumable |
| Oversized | > 500 MB | Blocked by default |

### Configuration

```typescript
interface BlobSizeLimits {
  /** Files larger than this trigger warning */
  warnThreshold: number;

  /** Files larger than this are blocked */
  maxFileSize: number;

  /** Chunk size for transfers */
  chunkSize: number;

  /** Timeout per chunk */
  chunkTimeoutMs: number;
}

const DEFAULT_BLOB_LIMITS: BlobSizeLimits = {
  warnThreshold: 50 * 1024 * 1024,      // 50 MB
  maxFileSize: 500 * 1024 * 1024,        // 500 MB
  chunkSize: 64 * 1024,                   // 64 KB
  chunkTimeoutMs: 30000,                  // 30s per chunk
};
```

### Size Validation

```typescript
/**
 * Validate file before adding to blob store.
 */
function validateBlobSize(
  size: number,
  limits: BlobSizeLimits
): ValidationResult {
  if (size > limits.maxFileSize) {
    return {
      allowed: false,
      error: `File too large (${formatBytes(size)}). Maximum is ${formatBytes(limits.maxFileSize)}.`,
      suggestion: 'Consider compressing the file or using external storage.',
    };
  }

  if (size > limits.warnThreshold) {
    return {
      allowed: true,
      warning: `Large file (${formatBytes(size)}) may slow sync and use significant storage.`,
    };
  }

  return { allowed: true };
}

interface ValidationResult {
  allowed: boolean;
  error?: string;
  warning?: string;
  suggestion?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
```

### User Override

```typescript
/**
 * Allow user to override size limits for specific files.
 */
interface BlobOverride {
  /** File path or hash pattern */
  pattern: string;

  /** Custom max size for this pattern */
  maxSize: number;

  /** Reason for override (for UI display) */
  reason?: string;
}

const EXAMPLE_OVERRIDES: BlobOverride[] = [
  {
    pattern: 'assets/videos/**',
    maxSize: 1024 * 1024 * 1024, // 1 GB for videos
    reason: 'Video assets need larger limit',
  },
];
```

### Total Storage Limits

```typescript
interface StorageLimits {
  /** Maximum total blob storage */
  maxTotalBlobStorage: number;

  /** Warning threshold */
  warnAtStorage: number;
}

const DEFAULT_STORAGE_LIMITS: StorageLimits = {
  maxTotalBlobStorage: 10 * 1024 * 1024 * 1024, // 10 GB
  warnAtStorage: 5 * 1024 * 1024 * 1024,        // 5 GB
};

class StorageQuotaManager {
  async checkQuota(newBlobSize: number): Promise<QuotaResult> {
    const currentUsage = await this.getTotalBlobStorage();
    const newTotal = currentUsage + newBlobSize;

    if (newTotal > this.limits.maxTotalBlobStorage) {
      return {
        allowed: false,
        error: `Storage quota exceeded. Current: ${formatBytes(currentUsage)}, Limit: ${formatBytes(this.limits.maxTotalBlobStorage)}`,
        suggestion: 'Run garbage collection or increase storage limit.',
      };
    }

    if (newTotal > this.limits.warnAtStorage) {
      return {
        allowed: true,
        warning: `Storage usage high: ${formatBytes(newTotal)} of ${formatBytes(this.limits.maxTotalBlobStorage)}`,
      };
    }

    return { allowed: true };
  }
}
```

### UI Feedback

```typescript
/**
 * Show file size warning before sync.
 */
async function confirmLargeFile(
  file: TFile,
  validation: ValidationResult
): Promise<boolean> {
  if (!validation.warning) return true;

  return new Promise(resolve => {
    const modal = new Modal(app);

    modal.contentEl.createEl('h2', { text: 'Large File Warning' });
    modal.contentEl.createEl('p', { text: validation.warning });

    if (validation.suggestion) {
      modal.contentEl.createEl('p', {
        text: validation.suggestion,
        cls: 'suggestion',
      });
    }

    const buttons = modal.contentEl.createDiv({ cls: 'modal-buttons' });

    buttons.createEl('button', { text: 'Cancel' }).onclick = () => {
      modal.close();
      resolve(false);
    };

    buttons.createEl('button', { text: 'Sync Anyway', cls: 'mod-warning' }).onclick = () => {
      modal.close();
      resolve(true);
    };

    modal.open();
  });
}
```

## Performance Considerations

| Concern | Mitigation |
|---------|------------|
| Large file transfer | Chunked transfers, resumable |
| Duplicate detection | Content-addressed (same hash = same content) |
| Storage space | Deduplication via hashing |
| Network bandwidth | Only transfer missing blobs |
| Memory usage | Stream large files, don't load into memory |
| Oversized files | Size limits with user override option |

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0",
    "iroh-blobs": "^0.1.0"
  }
}
```

- iroh-blobs for content-addressed blob storage
- Loro for metadata storage
- Obsidian Vault API for binary file operations

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Binary file approach | Hash references to iroh-blobs | CRDTs don't work well for binary data; content-addressing provides deduplication |
| Sync order | Metadata (Loro) first, then blobs | Allows file tree to be complete even before all blobs downloaded |
| Large file handling | Chunked transfer | Supports resumable downloads, better memory usage |
| Blob GC | Reference counting + retention | Don't immediately delete; keep for history |
