# Storage Spec

## Purpose

Define how Loro documents are persisted to disk, ensuring data durability across plugin restarts and Obsidian sessions.

## Requirements

- **REQ-ST-01**: The vault document MUST be persisted as a binary `.loro` file
- **REQ-ST-02**: Storage location MUST be within `.obsidian/plugins/peervault/`
- **REQ-ST-03**: Document MUST be loadable without the original markdown files
- **REQ-ST-04**: Storage operations MUST be atomic (no partial writes)
- **REQ-ST-05**: Storage MUST handle concurrent access safely
- **REQ-ST-06**: Snapshots MUST be used for fast startup (Loro native feature)

## Directory Structure

With Loro's single-document architecture (see [Data Model](./01-data-model.md)), storage is simplified:

```
vault-root/
├── .obsidian/
│   └── plugins/
│       └── peervault/
│           ├── main.js              # Plugin code
│           ├── manifest.json
│           ├── data.json            # Plugin settings
│           └── sync/
│               ├── vault.loro       # Main vault document (with snapshot)
│               ├── vault.updates    # Pending updates (for incremental sync)
│               ├── checkpoints/     # GC checkpoints
│               │   └── checkpoint-{timestamp}.loro
│               └── meta.json        # Storage metadata
```

## File Formats

### .loro Files

Loro documents can be exported in two modes:

1. **Snapshot mode** - Contains full state + compressed history (fast to load)
2. **Update mode** - Contains only operations since last export (for sync)

```typescript
import { LoroDoc } from 'loro-crdt';

// Export with snapshot (for persistence) - FAST LOADING
const snapshotBytes: Uint8Array = doc.export({ mode: 'snapshot' });
await writeFile('vault.loro', snapshotBytes);

// Export updates only (for sync)
const updateBytes: Uint8Array = doc.export({ mode: 'update', from: lastVersion });

// Import from snapshot
const doc = new LoroDoc();
doc.import(snapshotBytes);

// Import incremental updates
doc.import(updateBytes);
```

### meta.json

Storage metadata for integrity and migration.

```typescript
interface StorageMeta {
  /** Schema version for migrations */
  version: number;

  /** When storage was initialized */
  createdAt: string;

  /** Last successful write timestamp */
  lastWrite: string;

  /** Last known version vector as base64 (for JSON storage) */
  lastVersion: string | null;

  /** Document size in bytes (for monitoring) */
  docSizeBytes: number;

  /** Number of files in vault (quick stat) */
  fileCount: number;
}
```

## Interface

```typescript
import { LoroDoc, VersionVector } from 'loro-crdt';

interface StorageAdapter {
  /**
   * Initialize storage, creating directories if needed.
   * Loads the vault document if it exists.
   */
  initialize(): Promise<LoroDoc>;

  /**
   * Save the vault document to disk with snapshot.
   * Uses atomic write to prevent corruption.
   */
  save(doc: LoroDoc): Promise<void>;

  /**
   * Save incremental updates for efficient sync.
   * Appends to updates file.
   */
  saveUpdates(doc: LoroDoc, from: VersionVector): Promise<void>;

  /**
   * Load the vault document from disk.
   * Uses snapshot for fast loading.
   */
  load(): Promise<LoroDoc | null>;

  /**
   * Get pending updates since last full save.
   */
  getPendingUpdates(): Promise<Uint8Array | null>;

  /**
   * Clear pending updates after successful sync.
   */
  clearPendingUpdates(): Promise<void>;

  /**
   * Create a checkpoint for garbage collection.
   */
  createCheckpoint(doc: LoroDoc): Promise<string>;

  /**
   * List available checkpoints.
   */
  listCheckpoints(): Promise<string[]>;

  /**
   * Restore from a checkpoint.
   */
  restoreCheckpoint(checkpointId: string): Promise<LoroDoc>;

  /**
   * Get storage statistics.
   */
  getStats(): Promise<StorageStats>;
}

interface StorageStats {
  docSizeBytes: number;
  updatesSizeBytes: number;
  checkpointCount: number;
  lastSaveTime: number;
}
```

## Implementation Details

### Atomic Writes

Use write-to-temp-then-rename pattern to prevent corruption:

```typescript
async function atomicWrite(path: string, data: Uint8Array): Promise<void> {
  const tempPath = `${path}.tmp.${Date.now()}`;
  await writeFile(tempPath, data);
  await rename(tempPath, path);
}
```

### Obsidian Storage Adapter

```typescript
class ObsidianStorageAdapter implements StorageAdapter {
  private basePath: string;
  private lastVersion: VersionVector | null = null;

  constructor(
    private vault: Vault,
    pluginDir: string
  ) {
    this.basePath = `${pluginDir}/sync`;
  }

  async initialize(): Promise<LoroDoc> {
    // Ensure directories exist
    await this.ensureDir(this.basePath);
    await this.ensureDir(`${this.basePath}/checkpoints`);

    // Try to load existing document
    const doc = await this.load();
    if (doc) {
      return doc;
    }

    // Create new document
    return new LoroDoc();
  }

  async save(doc: LoroDoc): Promise<void> {
    // Export with snapshot for fast loading
    const bytes = doc.export({ mode: 'snapshot' });
    const path = `${this.basePath}/vault.loro`;

    // Atomic write
    await atomicWrite(path, bytes, this.vault);

    // Update metadata
    this.lastVersion = doc.version();
    await this.updateMeta(doc);

    // Clear pending updates (now included in snapshot)
    await this.clearPendingUpdates();
  }

  async saveUpdates(doc: LoroDoc, from: VersionVector): Promise<void> {
    const updates = doc.export({ mode: 'update', from });
    const path = `${this.basePath}/vault.updates`;

    // Append updates
    const existing = await this.readBinaryOrEmpty(path);
    const combined = concatUint8Arrays(existing, updates);
    await this.vault.adapter.writeBinary(path, combined);
  }

  async load(): Promise<LoroDoc | null> {
    const path = `${this.basePath}/vault.loro`;

    if (!await this.vault.adapter.exists(path)) {
      return null;
    }

    const bytes = await this.vault.adapter.readBinary(path);
    const doc = new LoroDoc();

    // Import snapshot (fast!)
    doc.import(new Uint8Array(bytes));

    // Apply any pending updates
    const updates = await this.getPendingUpdates();
    if (updates) {
      doc.import(updates);
    }

    this.lastVersion = doc.version();
    return doc;
  }

  async getPendingUpdates(): Promise<Uint8Array | null> {
    const path = `${this.basePath}/vault.updates`;

    if (!await this.vault.adapter.exists(path)) {
      return null;
    }

    const bytes = await this.vault.adapter.readBinary(path);
    return bytes.byteLength > 0 ? new Uint8Array(bytes) : null;
  }

  async clearPendingUpdates(): Promise<void> {
    const path = `${this.basePath}/vault.updates`;
    if (await this.vault.adapter.exists(path)) {
      await this.vault.adapter.remove(path);
    }
  }

  async createCheckpoint(doc: LoroDoc): Promise<string> {
    const timestamp = Date.now();
    const checkpointId = `checkpoint-${timestamp}`;
    const path = `${this.basePath}/checkpoints/${checkpointId}.loro`;

    const bytes = doc.export({ mode: 'snapshot' });
    await this.vault.adapter.writeBinary(path, bytes);

    return checkpointId;
  }

  private async updateMeta(doc: LoroDoc): Promise<void> {
    const versionBytes = doc.version().encode();
    const meta: StorageMeta = {
      version: 1,
      createdAt: new Date().toISOString(),
      lastWrite: new Date().toISOString(),
      lastVersion: btoa(String.fromCharCode(...versionBytes)),
      docSizeBytes: doc.export({ mode: 'snapshot' }).byteLength,
      fileCount: countFiles(doc),
    };

    const path = `${this.basePath}/meta.json`;
    await this.vault.adapter.write(path, JSON.stringify(meta, null, 2));
  }
}
```

### Save Strategies

```typescript
interface SaveStrategy {
  /** Save after N operations */
  operationThreshold: number;

  /** Save after N milliseconds of inactivity */
  debounceMs: number;

  /** Force save after N milliseconds regardless of activity */
  maxDelayMs: number;

  /** Create checkpoint every N saves */
  checkpointInterval: number;
}

const DEFAULT_SAVE_STRATEGY: SaveStrategy = {
  operationThreshold: 50,      // Save after 50 ops
  debounceMs: 2000,            // Wait 2s of inactivity
  maxDelayMs: 30000,           // Force save after 30s
  checkpointInterval: 10,      // Checkpoint every 10 saves
};

class AutoSaver {
  private pendingOps = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastSave = Date.now();
  private saveCount = 0;

  constructor(
    private storage: StorageAdapter,
    private doc: LoroDoc,
    private strategy: SaveStrategy = DEFAULT_SAVE_STRATEGY
  ) {
    // Subscribe to document changes
    doc.subscribe((event) => {
      this.onDocumentChange();
    });
  }

  private onDocumentChange(): void {
    this.pendingOps++;

    // Check operation threshold
    if (this.pendingOps >= this.strategy.operationThreshold) {
      this.save();
      return;
    }

    // Check max delay
    if (Date.now() - this.lastSave >= this.strategy.maxDelayMs) {
      this.save();
      return;
    }

    // Debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.save();
    }, this.strategy.debounceMs);
  }

  private async save(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    await this.storage.save(this.doc);
    this.pendingOps = 0;
    this.lastSave = Date.now();
    this.saveCount++;

    // Create checkpoint periodically
    if (this.saveCount % this.strategy.checkpointInterval === 0) {
      await this.storage.createCheckpoint(this.doc);
    }
  }

  async flush(): Promise<void> {
    if (this.pendingOps > 0) {
      await this.save();
    }
  }
}
```

## Snapshot Storage (Loro Native)

Loro has **native snapshot support** that dramatically improves load times. Unlike other CRDTs that must replay operations, Loro snapshots contain pre-computed state.

### Performance Comparison

| Operation | Without Snapshot | With Snapshot |
|-----------|------------------|---------------|
| Load 260K ops | ~1,185ms | ~6ms |
| Load 26M ops | Skipped (OOM) | ~66ms |

### Snapshot Export Modes

```typescript
// Full snapshot - includes state + compressed history
// Use for: Persistence, backup, sharing with new peers
const snapshot = doc.export({ mode: 'snapshot' });

// Updates only - just operations since a version
// Use for: Incremental sync, real-time collaboration
const updates = doc.export({ mode: 'update', from: peerVersion });

// Shallow snapshot - state without full history (smaller)
// Use for: Read-only sharing, reducing storage
// Note: shallow-snapshot requires frontiers parameter
const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() });
```

### When to Create Snapshots

Loro automatically includes snapshot data in exports. No manual snapshot management needed for basic use cases. For advanced scenarios:

```typescript
// Check if re-export would significantly reduce size
// (after many small updates accumulated)
function shouldReexport(doc: LoroDoc, currentFileSize: number): boolean {
  const freshExport = doc.export({ mode: 'snapshot' });
  const savings = currentFileSize - freshExport.byteLength;
  const savingsPercent = savings / currentFileSize;

  // Re-export if >20% size reduction possible
  return savingsPercent > 0.2;
}
```

## Garbage Collection

Loro documents grow over time as history accumulates. Garbage collection prunes old operations.

### GC Strategy

```typescript
interface GarbageCollectionConfig {
  /** Enable automatic garbage collection */
  enabled: boolean;

  /** Minimum history retention (days) */
  minHistoryDays: number;

  /** Maximum document size before forcing GC (bytes) */
  maxDocSize: number;

  /** Require all known peers to have synced before GC */
  requirePeerConsensus: boolean;
}

const DEFAULT_GC_CONFIG: GarbageCollectionConfig = {
  enabled: true,
  minHistoryDays: 30,           // Keep at least 30 days
  maxDocSize: 50 * 1024 * 1024, // Force GC above 50MB
  requirePeerConsensus: true,   // Safe by default
};
```

### Version Vector Tracking

Track what each peer has seen for safe garbage collection:

```typescript
interface PeerSyncState {
  /** Peer's node ID */
  peerId: string;

  /** Peer's last known version vector */
  version: VersionVector;

  /** When we last synced with this peer */
  lastSyncTime: number;
}

/**
 * Find the minimum version all peers have.
 * Operations before this can be safely garbage collected.
 *
 * Note: VersionVector doesn't have an intersect() method.
 * We compute the intersection manually: only peer IDs present in ALL
 * version vectors are included, with the minimum counter for each.
 */
function findStableVersion(peerStates: PeerSyncState[]): VersionVector {
  if (peerStates.length === 0) {
    return new VersionVector(); // Empty - nothing is stable
  }

  // Start with first peer's version vector
  const firstVV = peerStates[0].version.toJSON(); // Returns Map<PeerID, number>
  const minVersions = new Map<string, number>(firstVV);

  // For each subsequent peer, intersect: only keep peer IDs in BOTH
  for (let i = 1; i < peerStates.length; i++) {
    const vvJson = peerStates[i].version.toJSON();

    for (const peerId of minVersions.keys()) {
      const otherCounter = vvJson.get(peerId);
      if (otherCounter === undefined) {
        // Peer ID not in this VV - remove from intersection
        minVersions.delete(peerId);
      } else {
        // Both have it - take minimum counter
        const current = minVersions.get(peerId)!;
        if (otherCounter < current) {
          minVersions.set(peerId, otherCounter);
        }
      }
    }
  }

  return new VersionVector(minVersions);
}
```

### Compaction with Loro

```typescript
class GarbageCollector {
  constructor(
    private storage: StorageAdapter,
    private peerManager: PeerManager,
    private config: GarbageCollectionConfig = DEFAULT_GC_CONFIG
  ) {}

  async maybeCompact(doc: LoroDoc): Promise<boolean> {
    if (!this.config.enabled) return false;

    const stats = await this.storage.getStats();

    // Check if compaction needed
    if (stats.docSizeBytes < this.config.maxDocSize) {
      return false;
    }

    // Get peer sync states
    const peerStates = await this.peerManager.getPeerSyncStates();

    if (this.config.requirePeerConsensus && peerStates.length > 0) {
      // Find stable version
      const stableVersion = findStableVersion(peerStates);

      // Check if all peers are recent enough
      const oldestPeerSync = Math.min(...peerStates.map(p => p.lastSyncTime));
      const retentionMs = this.config.minHistoryDays * 24 * 60 * 60 * 1000;

      if (Date.now() - oldestPeerSync < retentionMs) {
        console.log('GC skipped: peers not all synced within retention period');
        return false;
      }
    }

    // Create checkpoint before GC
    await this.storage.createCheckpoint(doc);

    // Loro's shallow snapshot discards detailed history
    // while preserving ability to merge with peers
    // Note: shallow-snapshot requires frontiers parameter
    const compacted = doc.export({ mode: 'shallow-snapshot', frontiers: doc.oplogFrontiers() });

    // Create new document from compacted export
    const newDoc = new LoroDoc();
    newDoc.import(compacted);

    // Save compacted document
    await this.storage.save(newDoc);

    console.log(`GC completed: ${stats.docSizeBytes} -> ${compacted.byteLength} bytes`);
    return true;
  }
}
```

### GC Coordination Protocol

When garbage collecting with `requirePeerConsensus: true`:

```
┌────────┐                              ┌────────┐
│ Peer A │                              │ Peer B │
└───┬────┘                              └───┬────┘
    │                                       │
    │  GC_PROPOSE                           │
    │  { version: X }                       │
    │──────────────────────────────────────►│
    │                                       │
    │                     GC_ACK            │
    │           { version: X, myVersion: Y }│
    │◄──────────────────────────────────────│
    │                                       │
    │  [Compute stable version]             │
    │                                       │
    │  GC_COMMIT                            │
    │  { stableVersion: min(X,Y) }          │
    │──────────────────────────────────────►│
    │                                       │
    │  [Both peers compact]                 │
    │                                       │
```

### Warning: Data Loss Risk

Garbage collection permanently removes history. Mitigations:

1. **Checkpoint before GC**: Always create checkpoint
2. **Consensus required**: Don't GC until all peers confirm
3. **Minimum retention**: Keep at least 30 days of history
4. **Time travel preserved**: Loro shallow snapshots still support checkout to recent versions

## Encryption at Rest

Files are encrypted before writing to disk.

```typescript
interface EncryptionConfig {
  /** Enable encryption */
  enabled: boolean;

  /** Encryption algorithm */
  algorithm: 'AES-256-GCM';

  /** Key derivation function */
  kdf: 'PBKDF2' | 'Argon2id';

  /** KDF iterations (for PBKDF2) */
  iterations: number;
}

const DEFAULT_ENCRYPTION_CONFIG: EncryptionConfig = {
  enabled: true,
  algorithm: 'AES-256-GCM',
  kdf: 'PBKDF2',
  iterations: 100000,
};

class EncryptedStorageAdapter implements StorageAdapter {
  private key: CryptoKey | null = null;

  constructor(
    private inner: StorageAdapter,
    private config: EncryptionConfig = DEFAULT_ENCRYPTION_CONFIG
  ) {}

  async unlock(passphrase: string): Promise<void> {
    // Derive key from passphrase
    const salt = await this.getOrCreateSalt();
    this.key = await deriveKey(passphrase, salt, this.config);
  }

  async save(doc: LoroDoc): Promise<void> {
    if (!this.key) throw new Error('Storage locked');

    const plaintext = doc.export({ mode: 'snapshot' });
    const ciphertext = await encrypt(plaintext, this.key);
    await this.inner.saveRaw(ciphertext);
  }

  async load(): Promise<LoroDoc | null> {
    if (!this.key) throw new Error('Storage locked');

    const ciphertext = await this.inner.loadRaw();
    if (!ciphertext) return null;

    const plaintext = await decrypt(ciphertext, this.key);
    const doc = new LoroDoc();
    doc.import(plaintext);
    return doc;
  }
}
```

## Error Handling

| Error | Recovery |
|-------|----------|
| Disk full | Surface error to user, pause sync |
| Corrupted .loro file | Log error, attempt recovery from checkpoint or peers |
| Decryption failed | Prompt for correct passphrase |
| Permission denied | Surface error, check Obsidian sandbox |
| Version mismatch | Attempt migration, fallback to checkpoint |
| GC consensus timeout | Abort GC, retry later |

## Partial Write Crash Recovery

This section describes how PeerVault detects and recovers from crashes that interrupt write operations, preventing data corruption.

### Crash Scenarios

| Scenario | Risk | Detection | Recovery |
|----------|------|-----------|----------|
| Crash during `.loro` write | Corrupted main document | Missing/partial file | Restore from `.loro.bak` |
| Crash during temp file creation | Orphaned temp file | `.tmp.*` files exist | Delete temp, main file intact |
| Crash after temp write, before rename | Main file outdated | `.tmp.*` newer than main | Complete the rename |
| Crash during meta.json update | Stale metadata | Version mismatch | Regenerate from document |
| Crash during encryption | Corrupted ciphertext | Decryption fails | Restore from backup |

### Write-Ahead Safety

```typescript
/**
 * Safe write protocol:
 * 1. Write to temp file (temp-{timestamp}.loro.tmp)
 * 2. Create backup of current file (vault.loro.bak)
 * 3. Atomic rename temp -> main
 * 4. Delete backup on success
 * 5. Cleanup orphaned temps on startup
 */
class SafeStorageWriter {
  private readonly MAIN_FILE = 'vault.loro';
  private readonly BACKUP_FILE = 'vault.loro.bak';

  async safeWrite(data: Uint8Array): Promise<void> {
    const tempFile = `vault.loro.tmp.${Date.now()}`;
    const mainPath = `${this.basePath}/${this.MAIN_FILE}`;
    const backupPath = `${this.basePath}/${this.BACKUP_FILE}`;
    const tempPath = `${this.basePath}/${tempFile}`;

    try {
      // Step 1: Write complete data to temp file
      await this.vault.adapter.writeBinary(tempPath, data);

      // Step 2: Verify temp file integrity
      const written = await this.vault.adapter.readBinary(tempPath);
      if (!this.verifyIntegrity(data, new Uint8Array(written))) {
        throw new Error('Temp file verification failed');
      }

      // Step 3: Create backup of current file (if exists)
      if (await this.vault.adapter.exists(mainPath)) {
        await this.vault.adapter.copy(mainPath, backupPath);
      }

      // Step 4: Atomic rename temp -> main
      await this.vault.adapter.rename(tempPath, mainPath);

      // Step 5: Delete backup on success
      if (await this.vault.adapter.exists(backupPath)) {
        await this.vault.adapter.remove(backupPath);
      }

    } catch (error) {
      // Cleanup temp file on error
      if (await this.vault.adapter.exists(tempPath)) {
        await this.vault.adapter.remove(tempPath);
      }
      throw error;
    }
  }

  private verifyIntegrity(expected: Uint8Array, actual: Uint8Array): boolean {
    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== actual[i]) return false;
    }
    return true;
  }
}
```

### Startup Recovery Protocol

```typescript
/**
 * Recovery checks performed on plugin startup.
 */
class CrashRecovery {
  async performRecovery(): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      recovered: false,
      action: 'none',
      details: '',
    };

    // Check 1: Orphaned temp files
    const orphanedTemps = await this.findOrphanedTemps();
    if (orphanedTemps.length > 0) {
      await this.handleOrphanedTemps(orphanedTemps, result);
    }

    // Check 2: Backup file exists (incomplete previous write)
    if (await this.backupExists()) {
      await this.handleBackupFile(result);
    }

    // Check 3: Main file corrupted
    if (await this.mainFileCorrupted()) {
      await this.handleCorruptedMain(result);
    }

    // Check 4: Meta.json stale
    if (await this.metadataStale()) {
      await this.regenerateMetadata(result);
    }

    return result;
  }

  private async findOrphanedTemps(): Promise<string[]> {
    const files = await this.vault.adapter.list(this.basePath);
    return files.files.filter(f => f.includes('.tmp.'));
  }

  private async handleOrphanedTemps(
    temps: string[],
    result: RecoveryResult
  ): Promise<void> {
    // Check if any temp is newer than main (interrupted rename)
    const mainStat = await this.getStat(this.MAIN_FILE);

    for (const temp of temps) {
      const tempStat = await this.getStat(temp);

      if (mainStat && tempStat.mtime > mainStat.mtime) {
        // Temp is newer - this was an interrupted write
        // Validate temp and complete the rename
        if (await this.validateLoroFile(temp)) {
          await this.vault.adapter.rename(
            `${this.basePath}/${temp}`,
            `${this.basePath}/${this.MAIN_FILE}`
          );
          result.recovered = true;
          result.action = 'completed-interrupted-write';
          result.details = `Recovered from interrupted write: ${temp}`;
        } else {
          // Temp corrupted, delete it
          await this.vault.adapter.remove(`${this.basePath}/${temp}`);
          result.details = `Deleted corrupted temp: ${temp}`;
        }
      } else {
        // Temp is older or main doesn't exist - orphan, delete
        await this.vault.adapter.remove(`${this.basePath}/${temp}`);
        result.details = `Cleaned orphaned temp: ${temp}`;
      }
    }
  }

  private async handleBackupFile(result: RecoveryResult): Promise<void> {
    // Backup exists means crash after backup, before delete
    // Main file should be good, but verify
    if (await this.validateLoroFile(this.MAIN_FILE)) {
      // Main is valid, delete backup
      await this.vault.adapter.remove(`${this.basePath}/${this.BACKUP_FILE}`);
      result.details = 'Cleaned up backup after verified main file';
    } else {
      // Main corrupted, restore from backup
      if (await this.validateLoroFile(this.BACKUP_FILE)) {
        await this.vault.adapter.copy(
          `${this.basePath}/${this.BACKUP_FILE}`,
          `${this.basePath}/${this.MAIN_FILE}`
        );
        await this.vault.adapter.remove(`${this.basePath}/${this.BACKUP_FILE}`);
        result.recovered = true;
        result.action = 'restored-from-backup';
        result.details = 'Restored main file from backup';
      } else {
        // Both corrupted - need checkpoint or peer recovery
        result.action = 'needs-checkpoint-recovery';
        result.details = 'Both main and backup corrupted';
      }
    }
  }

  private async handleCorruptedMain(result: RecoveryResult): Promise<void> {
    // Try recovery sources in order
    const sources = [
      { name: 'backup', path: this.BACKUP_FILE },
      { name: 'checkpoint', path: await this.findLatestCheckpoint() },
    ];

    for (const source of sources) {
      if (!source.path) continue;

      if (await this.validateLoroFile(source.path)) {
        await this.vault.adapter.copy(
          `${this.basePath}/${source.path}`,
          `${this.basePath}/${this.MAIN_FILE}`
        );
        result.recovered = true;
        result.action = `restored-from-${source.name}`;
        result.details = `Recovered from ${source.name}`;
        return;
      }
    }

    // No local recovery possible
    result.action = 'needs-peer-recovery';
    result.details = 'All local recovery sources exhausted';
  }

  private async validateLoroFile(filename: string): Promise<boolean> {
    try {
      const path = `${this.basePath}/${filename}`;
      if (!await this.vault.adapter.exists(path)) {
        return false;
      }

      const bytes = await this.vault.adapter.readBinary(path);
      if (bytes.byteLength < 8) {
        return false; // Too small to be valid
      }

      // Try to import as Loro document
      const doc = new LoroDoc();
      doc.import(new Uint8Array(bytes));

      // Basic validation: should have meta map
      const meta = doc.getMap('meta');
      return meta !== null;

    } catch (error) {
      console.error(`Validation failed for ${filename}:`, error);
      return false;
    }
  }
}

interface RecoveryResult {
  recovered: boolean;
  action: 'none' | 'completed-interrupted-write' | 'restored-from-backup' |
          'restored-from-checkpoint' | 'needs-checkpoint-recovery' |
          'needs-peer-recovery';
  details: string;
}
```

### Write Journal

For additional safety, maintain a write journal:

```typescript
interface WriteJournalEntry {
  /** Unique write ID */
  id: string;

  /** Write start time */
  startedAt: number;

  /** Write completion time (null if in progress) */
  completedAt: number | null;

  /** Version being written */
  version: string;

  /** File being written */
  targetFile: string;

  /** Current phase */
  phase: 'temp-write' | 'backup' | 'rename' | 'cleanup' | 'complete';
}

class WriteJournal {
  private readonly JOURNAL_FILE = 'write-journal.json';

  async beginWrite(targetFile: string, version: string): Promise<string> {
    const entry: WriteJournalEntry = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      completedAt: null,
      version,
      targetFile,
      phase: 'temp-write',
    };

    await this.appendEntry(entry);
    return entry.id;
  }

  async updatePhase(id: string, phase: WriteJournalEntry['phase']): Promise<void> {
    const entries = await this.readJournal();
    const entry = entries.find(e => e.id === id);
    if (entry) {
      entry.phase = phase;
      if (phase === 'complete') {
        entry.completedAt = Date.now();
      }
      await this.writeJournal(entries);
    }
  }

  async recoverFromJournal(): Promise<void> {
    const entries = await this.readJournal();
    const incomplete = entries.filter(e => e.completedAt === null);

    for (const entry of incomplete) {
      console.log(`Recovering write ${entry.id} from phase ${entry.phase}`);

      switch (entry.phase) {
        case 'temp-write':
          // Incomplete temp write - delete temp and retry
          await this.cleanupTemp(entry);
          break;

        case 'backup':
        case 'rename':
          // Interrupted after backup - recovery handled by CrashRecovery
          break;

        case 'cleanup':
          // Just cleanup stalled - finish it
          await this.finishCleanup(entry);
          break;
      }

      // Mark as complete (recovered)
      entry.completedAt = Date.now();
    }

    // Prune old entries (keep last 10)
    const pruned = entries.slice(-10);
    await this.writeJournal(pruned);
  }
}
```

### Fsync Considerations

Obsidian's storage adapter may not provide fsync guarantees. For maximum safety:

```typescript
/**
 * On platforms where Node.js fs module is available,
 * we can use fsync for true durability.
 */
async function durableWrite(path: string, data: Uint8Array): Promise<void> {
  // Check if we have access to Node.js fs
  if (typeof require !== 'undefined') {
    const fs = require('fs').promises;
    const fd = await fs.open(path, 'w');
    try {
      await fd.writeFile(data);
      await fd.sync(); // Force flush to disk
    } finally {
      await fd.close();
    }
  } else {
    // Fall back to Obsidian API (no fsync guarantee)
    await this.vault.adapter.writeBinary(path, data);
  }
}
```

### Recovery UI

```typescript
/**
 * Show recovery status to user on startup.
 */
class RecoveryNotification {
  showRecoveryResult(result: RecoveryResult): void {
    if (!result.recovered && result.action === 'none') {
      return; // No recovery needed
    }

    if (result.recovered) {
      new Notice(
        `PeerVault recovered from interrupted operation: ${result.details}`,
        10000
      );
    } else if (result.action === 'needs-peer-recovery') {
      new Notice(
        'PeerVault data needs recovery. Connect to a peer to restore.',
        0 // Persistent until dismissed
      );
    } else if (result.action === 'needs-checkpoint-recovery') {
      // Show modal for checkpoint selection
      new CheckpointRecoveryModal(this.app, this.storage).open();
    }
  }
}
```

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- Obsidian `Vault` API for file operations
- Web Crypto API for encryption

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| File format | Single .loro file with snapshot | Loro's snapshot mode provides 100-200x faster loading |
| Compression | Loro's built-in compression | Loro already compresses efficiently; additional gzip not needed |
| Encryption at rest | Yes, with user passphrase | Maximum security. User must enter passphrase on plugin startup. Use AES-256-GCM. |
| Auto-backup | User-configurable checkpoints | Let users enable/disable auto-backup before migrations and destructive operations in settings |
| Save strategy | Debounced with thresholds | Balance between durability and performance |
