# Obsidian + Automerge + Iroh: Build Plan

## Architecture Overview

```
┌────────────────────────────────────────────────┐
│              Obsidian Plugin (TS)              │
├────────────────────────────────────────────────┤
│  File Watcher ←→ Automerge Docs ←→ Sync Engine │
├──────────────────┬─────────────────────────────┤
│ @automerge/      │      Iroh (WASM)            │
│ automerge        │      - P2P connections      │
│ - CRDT logic     │      - NAT traversal        │
│ - Binary format  │      - Relay fallback       │
└──────────────────┴─────────────────────────────┘
```

**Key decision:** Each markdown file = one Automerge document. This keeps it simple and git-like (file-level history, not character-level real-time collab).

---

## Phase 1: Local CRDT Layer

**Goal:** Wrap Obsidian vault files in Automerge documents with local persistence.

```
npm install @automerge/automerge @automerge/automerge-repo
```

**Tasks:**
1. Create Obsidian plugin scaffold
2. On file change → create/update Automerge doc with file content as text
3. Store Automerge binary (`.crdt`) files in `.obsidian/sync/` folder
4. Build simple UI: show doc history, diff between versions

**Data model:**
```typescript
interface FileDoc {
  content: string;        // or Automerge.Text for char-level
  frontmatter: Record<string, unknown>;
  path: string;
  deleted: boolean;
}
```

**Milestone:** Can edit file, see change history locally, restore old versions.

---

## Phase 2: P2P Transport with Iroh

**Goal:** Connect two devices directly and sync Automerge docs.

Iroh has experimental WASM/JS support. Options:
- **Option A:** Use `iroh` WASM bindings in Electron renderer
- **Option B:** Spawn native Iroh sidecar process, communicate via IPC
- **Option C:** Use iroh-based sync server you self-host

Start with **Option A** (pure WASM) for simplicity:

```
npm install @iroh/iroh  # or build from iroh-ffi
```

**Tasks:**
1. Initialize Iroh endpoint on plugin load
2. Generate/persist EndpointID (your device identity)
3. Implement pairing flow: Device A shows QR/ticket → Device B scans
4. Use `automerge-repo` sync protocol over Iroh streams

**Connection flow:**
```
Device A                          Device B
────────                          ────────
1. Generate ticket (EndpointID + relay info)
2. Display QR code ──────────────→ Scan QR
3. ←─────── Iroh connects (hole-punch or relay)
4. Exchange Automerge sync messages
5. Both devices converge
```

**Milestone:** Two devices can pair and sync a single doc.

---

## Phase 3: Full Vault Sync

**Goal:** Sync entire vault, handle conflicts, deletions.

**Tasks:**
1. Maintain index doc listing all files (path → docId mapping)
2. On connect: exchange index, request missing docs
3. Handle deletions (tombstone in index, don't delete Automerge history)
4. Add conflict UI: when Automerge has concurrent edits to same field, show diff
5. Background sync: reconnect on network change, periodic sync

**Sync protocol:**
```
1. Exchange index doc (list of files + docIds)
2. For each docId peer has that we don't: request it
3. For each docId both have: run Automerge sync protocol
4. Write merged docs to disk
```

**Milestone:** Full vault syncs between devices, survives offline edits.

---

## Phase 4: Multi-Peer & Discovery

**Goal:** More than 2 devices, optional discovery.

**Tasks:**
1. Store multiple peer EndpointIDs, connect to all on startup
2. (Optional) Use `iroh-gossip` for topic-based discovery
3. Add "vault sharing" — generate invite link, others join
4. Implement access control (read-only peers, etc.)

**Milestone:** 3+ devices stay in sync. Can share vault with others.

---

## File Structure

```
your-vault/
├── .obsidian/
│   └── plugins/
│       └── p2p-sync/
│           ├── main.js
│           ├── manifest.json
│           ├── data.json          # settings, peer list
│           └── crdt/
│               ├── index.crdt     # file index doc
│               ├── abc123.crdt    # per-file Automerge docs
│               └── ...
├── Notes/
│   └── example.md
```

---

## Key Libraries

| Purpose | Library |
|---------|---------|
| CRDT | `@automerge/automerge` |
| Doc management | `@automerge/automerge-repo` |
| P2P transport | `iroh` (via WASM or FFI) |
| Plugin framework | Obsidian Plugin API |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Iroh WASM is experimental | Fall back to WebRTC (like obsidian-decentralized) or native sidecar |
| Large vaults = slow sync | Sync incrementally, prioritize recently edited |
| Binary attachments | Store as blobs via `iroh-blobs`, reference by hash |
| Mobile Obsidian | WASM works, but test early — may need relay-only mode |

---

## Minimal Viable Demo (3-day sprint)

If you want to validate fast:

1. **Day 1:** Obsidian plugin that wraps one file in Automerge, saves `.crdt` locally
2. **Day 2:** Add Iroh, connect two instances via hardcoded ticket, sync that one doc
3. **Day 3:** Expand to full vault index, basic UI

This proves the stack works before investing in polish.
