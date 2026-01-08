# Data Model Spec

## Purpose

Define the Automerge document schemas used to represent vault files and metadata. These schemas enable conflict-free synchronization of markdown content.

## Requirements

- **REQ-DM-01**: Each markdown file MUST be represented as a separate Automerge document
- **REQ-DM-02**: File content MUST use Automerge.Text for character-level conflict resolution
- **REQ-DM-03**: A vault index MUST track all files and their document IDs
- **REQ-DM-04**: Deleted files MUST be tombstoned, not removed from history
- **REQ-DM-05**: Document IDs MUST be stable across sync (derived deterministically or persisted)

## Document Schemas

### FileDoc

Represents a single markdown file in the vault.

```typescript
import { Text } from '@automerge/automerge';

interface FileDoc {
  /**
   * File content as Automerge Text CRDT.
   * Enables character-level merge for concurrent edits.
   */
  content: Text;

  /**
   * Relative path from vault root (e.g., "Notes/daily/2024-01-15.md").
   * Used to write back to filesystem.
   */
  path: string;

  /**
   * Soft delete flag. When true, file is removed from vault
   * but document history is preserved.
   */
  deleted: boolean;

  /**
   * Timestamp of last local modification (ms since epoch).
   * Used for conflict-free ordering when needed.
   */
  mtime: number;
}
```

### VaultIndex

Maps file paths to Automerge document IDs. This is the "root" document exchanged first during sync.

```typescript
interface VaultIndexEntry {
  /** Automerge document ID (UUID or hash) */
  docId: string;

  /** Whether this file has been deleted */
  deleted: boolean;

  /** Last known mtime for quick change detection */
  mtime: number;
}

interface VaultIndex {
  /**
   * Map of relative file paths to their index entries.
   * Key: path (e.g., "Notes/example.md")
   * Value: VaultIndexEntry
   */
  files: Record<string, VaultIndexEntry>;

  /**
   * Vault identifier. Generated on first sync setup.
   * Must match for peers to sync.
   */
  vaultId: string;

  /**
   * Schema version for forward compatibility.
   */
  version: number;
}
```

## Document ID Generation

Document IDs must be deterministic so the same file on different devices maps to the same doc.

**Strategy**: Hash of `vaultId + originalPath`

```typescript
function generateDocId(vaultId: string, path: string): string {
  const input = `${vaultId}:${path}`;
  // Use SHA-256, truncated to 32 chars
  return sha256(input).substring(0, 32);
}
```

**Note**: If a file is renamed, it gets a NEW docId. The old path is tombstoned, new path created. This preserves history at old location.

## State Transitions

### File Lifecycle

```
                    ┌──────────────┐
                    │  Not Tracked │
                    └──────┬───────┘
                           │ file created in vault
                           ▼
                    ┌──────────────┐
         edit ─────►│    Active    │◄───── edit
                    └──────┬───────┘
                           │ file deleted
                           ▼
                    ┌──────────────┐
                    │  Tombstoned  │
                    │ (deleted=true)│
                    └──────────────┘
```

### Sync States

```
Local Only ──sync──► Synced ◄──sync── Remote Only
                        │
                   concurrent edits
                        │
                        ▼
                 Auto-Merged (CRDT)
```

## Automerge Operations

### Creating a FileDoc

```typescript
import * as Automerge from '@automerge/automerge';

function createFileDoc(path: string, content: string): Automerge.Doc<FileDoc> {
  return Automerge.from<FileDoc>({
    content: new Automerge.Text(content),
    path,
    deleted: false,
    mtime: Date.now(),
  });
}
```

### Updating Content

```typescript
function updateFileContent(
  doc: Automerge.Doc<FileDoc>,
  newContent: string
): Automerge.Doc<FileDoc> {
  return Automerge.change(doc, (d) => {
    // Compute diff and apply minimal splice operations
    const patches = computeTextPatches(d.content.toString(), newContent);
    for (const patch of patches) {
      if (patch.type === 'delete') {
        d.content.deleteAt(patch.index, patch.count);
      } else if (patch.type === 'insert') {
        d.content.insertAt(patch.index, ...patch.chars);
      }
    }
    d.mtime = Date.now();
  });
}
```

### Marking Deleted

```typescript
function deleteFile(doc: Automerge.Doc<FileDoc>): Automerge.Doc<FileDoc> {
  return Automerge.change(doc, (d) => {
    d.deleted = true;
    d.mtime = Date.now();
  });
}
```

## Dependencies

- `@automerge/automerge` - CRDT implementation
- Text diffing library (e.g., `diff-match-patch`) for efficient content updates

## Open Questions

1. **Binary files**: Should we support attachments? If so, store hash reference to iroh-blobs?
2. **Frontmatter**: Parse YAML frontmatter into structured fields, or keep as part of content Text?
3. **Large files**: Set a size limit? Files over N MB could be excluded from sync.
