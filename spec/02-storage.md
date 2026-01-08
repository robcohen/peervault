# Storage Spec

## Purpose

Define how Automerge documents are persisted to disk, ensuring data durability across plugin restarts and Obsidian sessions.

## Requirements

- **REQ-ST-01**: All Automerge documents MUST be persisted as binary `.crdt` files
- **REQ-ST-02**: Storage location MUST be within `.obsidian/plugins/peervault/`
- **REQ-ST-03**: Documents MUST be loadable without the original markdown file
- **REQ-ST-04**: Storage operations MUST be atomic (no partial writes)
- **REQ-ST-05**: Storage MUST handle concurrent access safely

## Directory Structure

```
vault-root/
├── .obsidian/
│   └── plugins/
│       └── peervault/
│           ├── main.js              # Plugin code
│           ├── manifest.json
│           ├── data.json            # Plugin settings
│           └── sync/
│               ├── index.crdt       # VaultIndex document
│               ├── docs/
│               │   ├── a1b2c3d4.crdt
│               │   ├── e5f6g7h8.crdt
│               │   └── ...
│               └── meta.json        # Storage metadata
```

## File Formats

### .crdt Files

Binary Automerge document format (compressed).

```typescript
// Writing
const binary: Uint8Array = Automerge.save(doc);
await writeFile(path, binary);

// Reading
const binary: Uint8Array = await readFile(path);
const doc = Automerge.load<FileDoc>(binary);
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

  /** Total document count (for quick stats) */
  docCount: number;
}
```

## Interface

```typescript
interface StorageAdapter {
  /**
   * Initialize storage, creating directories if needed.
   * Loads existing documents into memory.
   */
  initialize(): Promise<void>;

  /**
   * Save a document to disk.
   * @param docId - Unique document identifier
   * @param doc - Automerge document to save
   */
  saveDoc<T>(docId: string, doc: Automerge.Doc<T>): Promise<void>;

  /**
   * Load a document from disk.
   * @param docId - Document identifier
   * @returns Document or null if not found
   */
  loadDoc<T>(docId: string): Promise<Automerge.Doc<T> | null>;

  /**
   * Delete a document file (used for cleanup, not normal deletion).
   * Normal deletion should use tombstones.
   */
  deleteDoc(docId: string): Promise<void>;

  /**
   * List all stored document IDs.
   */
  listDocs(): Promise<string[]>;

  /**
   * Get the vault index document.
   */
  getIndex(): Promise<Automerge.Doc<VaultIndex>>;

  /**
   * Save the vault index document.
   */
  saveIndex(index: Automerge.Doc<VaultIndex>): Promise<void>;
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

### Obsidian Adapter Integration

Use Obsidian's `Vault` API for file operations:

```typescript
class ObsidianStorageAdapter implements StorageAdapter {
  constructor(
    private vault: Vault,
    private basePath: string
  ) {}

  async saveDoc<T>(docId: string, doc: Automerge.Doc<T>): Promise<void> {
    const binary = Automerge.save(doc);
    const path = `${this.basePath}/docs/${docId}.crdt`;

    // Obsidian's adapter.writeBinary handles atomicity
    await this.vault.adapter.writeBinary(path, binary);
  }

  async loadDoc<T>(docId: string): Promise<Automerge.Doc<T> | null> {
    const path = `${this.basePath}/docs/${docId}.crdt`;

    if (!await this.vault.adapter.exists(path)) {
      return null;
    }

    const binary = await this.vault.adapter.readBinary(path);
    return Automerge.load<T>(new Uint8Array(binary));
  }
}
```

### Lazy Loading

Don't load all documents into memory at startup. Load on demand:

```typescript
class DocumentCache {
  private cache = new Map<string, Automerge.Doc<FileDoc>>();

  async get(docId: string): Promise<Automerge.Doc<FileDoc> | null> {
    if (this.cache.has(docId)) {
      return this.cache.get(docId)!;
    }

    const doc = await this.storage.loadDoc<FileDoc>(docId);
    if (doc) {
      this.cache.set(docId, doc);
    }
    return doc;
  }

  evict(docId: string): void {
    this.cache.delete(docId);
  }
}
```

## Error Handling

| Error | Recovery |
|-------|----------|
| Disk full | Surface error to user, pause sync |
| Corrupted .crdt file | Log error, attempt recovery from peers |
| Missing index.crdt | Rebuild from docs/ directory scan |
| Permission denied | Surface error, check Obsidian sandbox |

## Dependencies

- Obsidian `Vault` API for file operations
- `@automerge/automerge` for serialization

## Open Questions

1. **Compression**: Automerge's save() already compresses. Additional compression needed?
2. **Encryption at rest**: Should .crdt files be encrypted? With what key?
3. **Backup**: Auto-backup before destructive operations?
