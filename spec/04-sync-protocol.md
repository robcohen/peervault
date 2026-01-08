# Sync Protocol Spec

## Purpose

Define how Automerge documents are synchronized between peers over Iroh connections. This is the core of conflict-free replication.

## Requirements

- **REQ-SP-01**: Sync MUST be conflict-free (no user intervention required)
- **REQ-SP-02**: Sync MUST work incrementally (not full vault transfer each time)
- **REQ-SP-03**: Sync MUST handle offline edits gracefully
- **REQ-SP-04**: Sync MUST be resumable after connection drops
- **REQ-SP-05**: Sync MUST preserve full edit history

## Protocol Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       Sync Session                          │
├─────────────────────────────────────────────────────────────┤
│  1. Connection established (Iroh)                           │
│  2. Exchange VaultIndex documents                           │
│  3. Identify documents to sync (new, updated)               │
│  4. For each document: run Automerge sync protocol          │
│  5. Write merged results to disk                            │
│  6. Keep connection open for live updates                   │
└─────────────────────────────────────────────────────────────┘
```

## Sequence Diagrams

### Full Sync Session

```
┌────────┐                                              ┌────────┐
│ Peer A │                                              │ Peer B │
└───┬────┘                                              └───┬────┘
    │                                                       │
    │ ──────────── Iroh Connection Established ──────────►  │
    │                                                       │
    │                 INDEX SYNC PHASE                      │
    │ ─────────────── index-sync (A's changes) ──────────►  │
    │ ◄─────────────── index-sync (B's changes) ──────────  │
    │ ─────────────── index-sync (A's changes) ──────────►  │
    │ ◄─────────────── index-sync (B's changes) ──────────  │
    │                    ... until converged ...            │
    │                                                       │
    │                DOCUMENT SYNC PHASE                    │
    │                                                       │
    │ ─────── For each doc in merged index: ───────        │
    │                                                       │
    │ ─────────────── doc-sync (docId, data) ────────────►  │
    │ ◄─────────────── doc-sync (docId, data) ────────────  │
    │                    ... until converged ...            │
    │ ─────────────── doc-complete (docId) ──────────────►  │
    │ ◄─────────────── doc-complete (docId) ──────────────  │
    │                                                       │
    │                    ... next doc ...                   │
    │                                                       │
    │ ─────────────── sync-complete ─────────────────────►  │
    │ ◄─────────────── sync-complete ─────────────────────  │
    │                                                       │
    │                 LIVE SYNC MODE                        │
    │ ◄═══════════ bidirectional doc-sync ═══════════════► │
    │                (on local changes)                     │
    │                                                       │
```

### Automerge Sync Protocol (Per Document)

```
┌────────┐                                              ┌────────┐
│ Peer A │                                              │ Peer B │
│        │                                              │        │
│ Doc v3 │                                              │ Doc v2 │
└───┬────┘                                              └───┬────┘
    │                                                       │
    │  generateSyncMessage(doc, state)                      │
    │  → "I have changes 1,2,3, need anything?"             │
    │ ─────────────── sync message ──────────────────────►  │
    │                                                       │
    │                       receiveSyncMessage(doc, state, msg)
    │                       → Merge changes, update state
    │                       generateSyncMessage(doc, state)
    │                       → "Thanks, I had 1,2, here's my 2'"
    │ ◄─────────────── sync message ──────────────────────  │
    │                                                       │
    │  receiveSyncMessage(doc, state, msg)                  │
    │  → Merge change 2', both now have 1,2,2',3            │
    │  generateSyncMessage(doc, state)                      │
    │  → "I think we're synced"                             │
    │ ─────────────── sync message (empty) ──────────────►  │
    │                                                       │
    │                       generateSyncMessage → null      │
    │ ◄─────────────── sync message (empty) ──────────────  │
    │                                                       │
    │                    ✓ CONVERGED                        │
    │               Both have identical docs                │
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
            │   Automerge  │
            │    Merge     │
            └──────┬───────┘
                   │
                   ▼
        "Hello brave new world"
         (or "Hello new brave world")

    Both insertions preserved!
    Order determined by actor IDs (deterministic)
```

## Message Types

```typescript
type SyncMessage =
  | { type: 'index-sync'; data: Uint8Array }      // Automerge sync msg for index
  | { type: 'doc-sync'; docId: string; data: Uint8Array }  // Automerge sync msg
  | { type: 'request-doc'; docId: string }        // Request a document
  | { type: 'doc-complete'; docId: string }       // Finished syncing a doc
  | { type: 'sync-complete' }                     // All docs synced
  | { type: 'error'; code: string; message: string };
```

## Sync Flow

### Phase 1: Index Synchronization

Exchange the VaultIndex document first to discover what files exist.

```typescript
async function syncIndex(
  localIndex: Automerge.Doc<VaultIndex>,
  connection: IrohConnection
): Promise<Automerge.Doc<VaultIndex>> {
  const syncState = Automerge.initSyncState();

  while (true) {
    // Generate our sync message
    const [newSyncState, message] = Automerge.generateSyncMessage(
      localIndex,
      syncState
    );

    if (message) {
      connection.send({ type: 'index-sync', data: message });
    }

    // Receive peer's sync message
    const peerMessage = await connection.receive();
    if (peerMessage.type !== 'index-sync') break;

    // Apply peer's changes
    const [newDoc, newState] = Automerge.receiveSyncMessage(
      localIndex,
      syncState,
      peerMessage.data
    );

    localIndex = newDoc;
    syncState = newState;

    // Check if sync is complete (no more messages needed)
    if (!message && !peerMessage.data) break;
  }

  return localIndex;
}
```

### Phase 2: Document Discovery

After index sync, determine which documents need syncing:

```typescript
interface SyncPlan {
  /** Docs we have that peer needs */
  toSend: string[];
  /** Docs peer has that we need */
  toReceive: string[];
  /** Docs both have that may need merging */
  toMerge: string[];
}

function createSyncPlan(
  localIndex: VaultIndex,
  localDocIds: Set<string>
): SyncPlan {
  const plan: SyncPlan = { toSend: [], toReceive: [], toMerge: [] };

  for (const [path, entry] of Object.entries(localIndex.files)) {
    if (entry.deleted) continue;

    if (!localDocIds.has(entry.docId)) {
      // We don't have this doc locally
      plan.toReceive.push(entry.docId);
    } else {
      // Both have it - may need to merge
      plan.toMerge.push(entry.docId);
    }
  }

  // Note: toSend is determined by peer's requests
  return plan;
}
```

### Phase 3: Document Synchronization

For each document, run Automerge's sync protocol:

```typescript
async function syncDocument(
  docId: string,
  localDoc: Automerge.Doc<FileDoc> | null,
  connection: IrohConnection
): Promise<Automerge.Doc<FileDoc>> {
  // If we don't have the doc, create empty one
  let doc = localDoc ?? Automerge.init<FileDoc>();
  let syncState = Automerge.initSyncState();

  while (true) {
    const [newState, message] = Automerge.generateSyncMessage(doc, syncState);
    syncState = newState;

    if (message) {
      connection.send({ type: 'doc-sync', docId, data: message });
    }

    const response = await connection.receiveWithTimeout(5000);

    if (response.type === 'doc-complete') break;
    if (response.type !== 'doc-sync') throw new Error('Unexpected message');

    const [newDoc, newSyncState] = Automerge.receiveSyncMessage(
      doc,
      syncState,
      response.data
    );

    doc = newDoc;
    syncState = newSyncState;

    if (!message && response.data.length === 0) {
      connection.send({ type: 'doc-complete', docId });
      break;
    }
  }

  return doc;
}
```

### Phase 4: Write Back

After sync, write merged documents to vault:

```typescript
async function writeBackToVault(
  doc: Automerge.Doc<FileDoc>,
  vault: Vault,
  watcher: FileWatcher
): Promise<void> {
  if (doc.deleted) {
    // Remove file if it exists
    const file = vault.getAbstractFileByPath(doc.path);
    if (file) {
      watcher.ignoreTemporarily(doc.path, 2000);
      await vault.delete(file);
    }
    return;
  }

  const content = doc.content.toString();
  const existingFile = vault.getAbstractFileByPath(doc.path);

  watcher.ignoreTemporarily(doc.path, 2000);

  if (existingFile instanceof TFile) {
    await vault.modify(existingFile, content);
  } else {
    // Ensure parent folders exist
    await ensureFolderExists(vault, doc.path);
    await vault.create(doc.path, content);
  }
}
```

## Using automerge-repo

For simplified sync, we can use `automerge-repo` which handles the sync protocol:

```typescript
import { Repo } from '@automerge/automerge-repo';
import { IrohNetworkAdapter } from './iroh-adapter';

const repo = new Repo({
  network: [new IrohNetworkAdapter(irohEndpoint)],
  storage: new ObsidianStorageAdapter(vault),
});

// Documents sync automatically when peers connect
const handle = repo.find<FileDoc>(docId);
handle.on('change', ({ doc }) => {
  writeBackToVault(doc, vault, watcher);
});
```

## Conflict Resolution

Automerge handles conflicts automatically at the character level:

```
Device A: "Hello world" → "Hello brave world"
Device B: "Hello world" → "Hello new world"
                    ↓ sync
Merged result: "Hello brave new world" (both insertions preserved)
```

For same-position edits, Automerge uses actor ID ordering (deterministic but arbitrary). This is acceptable for text - the result is always consistent across peers.

## Live Sync

After initial sync, keep connection open for real-time updates:

```typescript
class LiveSync {
  private pendingChanges = new Map<string, NodeJS.Timeout>();

  onLocalChange(docId: string, doc: Automerge.Doc<FileDoc>): void {
    // Debounce to batch rapid edits
    const existing = this.pendingChanges.get(docId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pendingChanges.delete(docId);
      this.broadcastChange(docId, doc);
    }, 1000);

    this.pendingChanges.set(docId, timer);
  }

  private broadcastChange(docId: string, doc: Automerge.Doc<FileDoc>): void {
    for (const peer of this.connectedPeers) {
      this.syncDocument(docId, doc, peer.connection);
    }
  }
}
```

## Error Handling

| Error | Recovery |
|-------|----------|
| Connection lost mid-sync | Resume on reconnect (sync state is persistent) |
| Corrupt sync message | Request resend, log error |
| Document too large | Chunk transfer, or exclude from sync |
| Sync timeout | Retry with backoff |

## Dependencies

- `@automerge/automerge` - Sync protocol implementation
- `@automerge/automerge-repo` - Optional higher-level API
- Iroh transport (see 05-transport-iroh.md)

## Open Questions

1. **Sync priority**: Sync recently-edited files first?
2. **Bandwidth limits**: Throttle sync on metered connections?
3. **Selective sync**: Allow users to exclude folders?
