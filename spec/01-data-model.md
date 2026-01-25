# Data Model Spec

## Purpose

Define the Loro document schemas used to represent vault files and metadata. These schemas enable conflict-free synchronization of markdown content using Loro's high-performance CRDTs.

## Why Loro?

PeerVault uses [Loro](https://loro.dev/) instead of alternatives like Automerge or Yjs for these reasons:

1. **Native Movable Tree CRDT** - File/folder moves handled correctly without custom implementation
2. **Fugue Algorithm** - Minimizes text interleaving anomalies during concurrent edits
3. **Peritext Rich Text** - Proper handling of concurrent formatting changes
4. **10-200x Faster Parse Times** - Critical for large vaults (6ms vs 1,185ms on real-world dataset)
5. **Snapshot Feature** - Fast startup by storing pre-computed state
6. **Fractional Indexing** - Ordered siblings without reindexing

## Requirements

- **REQ-DM-01**: Each markdown file MUST be represented within the Loro document tree
- **REQ-DM-02**: File content MUST use LoroText for character-level conflict resolution with Fugue
- **REQ-DM-03**: Vault structure MUST use LoroTree for native move operation support
- **REQ-DM-04**: Deleted files MUST be tombstoned, not removed from history
- **REQ-DM-05**: Document IDs MUST be stable across sync (Loro's TreeID)

## Document Architecture

Unlike Automerge's multi-document approach, Loro efficiently handles a **single document** containing the entire vault structure. This leverages Loro's optimized tree CRDT.

```
LoroDoc (vault)
├── LoroTree (files)          # Hierarchical file structure with native moves
│   ├── TreeNode (folder: "Notes/")
│   │   ├── TreeNode (file: "daily.md")
│   │   │   └── LoroMap (metadata)
│   │   │       ├── content: LoroText
│   │   │       ├── frontmatter: LoroMap
│   │   │       └── mtime: number
│   │   └── TreeNode (file: "projects.md")
│   └── TreeNode (folder: "Archive/")
├── LoroMap (vaultMeta)       # Vault-level metadata
│   ├── vaultId: string
│   ├── version: number
│   └── createdAt: number
└── LoroMap (settings)        # Sync settings
```

## Document Schemas

### FileNode (Tree Node Data)

Each node in the LoroTree has associated data stored in a LoroMap:

```typescript
import { LoroDoc, LoroTree, LoroMap, LoroText, LoroList } from 'loro-crdt';

/**
 * Data associated with each tree node.
 * Accessed via tree.getMeta(nodeId).
 */
interface FileNodeData {
  /** Node type: 'file' or 'folder' */
  type: 'file' | 'folder';

  /** File/folder name (e.g., "daily.md" or "Notes") */
  name: string;

  /**
   * File content as LoroText (only for type='file').
   * Uses Fugue algorithm for minimal interleaving.
   */
  content?: LoroText;

  /**
   * Parsed YAML frontmatter as structured CRDT fields (only for type='file').
   * Stored in LoroMap for proper merge semantics.
   */
  frontmatter?: LoroMap<FrontmatterFields>;

  /**
   * Soft delete flag. When true, node is hidden but history preserved.
   */
  deleted: boolean;

  /**
   * Timestamp of last local modification (ms since epoch).
   */
  mtime: number;
}

/**
 * Structured frontmatter using Loro containers for proper merge.
 */
interface FrontmatterFields {
  /** Document title */
  title?: string;

  /** Tags as LoroList - concurrent additions merge correctly */
  tags?: LoroList<string>;

  /** Aliases as LoroList */
  aliases?: LoroList<string>;

  /** Creation date (ISO string) */
  created?: string;

  /** Custom fields as nested LoroMap */
  custom?: LoroMap<unknown>;
}
```

### VaultDoc

The root Loro document containing the entire vault:

```typescript
/**
 * Root vault document structure.
 */
interface VaultDoc {
  /** Hierarchical file tree with native move support */
  files: LoroTree;

  /** Vault-level metadata */
  meta: LoroMap<{
    /** Unique vault identifier - must match for peers to sync */
    vaultId: string;

    /** Schema version for migrations */
    version: number;

    /** When vault was created (ms since epoch) */
    createdAt: number;

    /** Human-readable vault name */
    name: string;
  }>;
}

/**
 * Initialize a new vault document.
 */
function createVaultDoc(vaultId: string, name: string): LoroDoc {
  const doc = new LoroDoc();

  // Initialize tree for files
  const files = doc.getTree('files');

  // Initialize metadata
  const meta = doc.getMap('meta');
  meta.set('vaultId', vaultId);
  meta.set('version', 1);
  meta.set('createdAt', Date.now());
  meta.set('name', name);

  return doc;
}
```

## Tree Operations (Native Move Support)

Loro's LoroTree provides **native movable tree CRDT** based on [Kleppmann's algorithm](https://martin.kleppmann.com/papers/move-op.pdf). This eliminates the need for manual move conflict resolution.

### Creating Files and Folders

```typescript
/**
 * Create a new file in the vault.
 */
function createFile(
  doc: LoroDoc,
  parentId: TreeID | null,
  name: string,
  content: string
): TreeID {
  const files = doc.getTree('files');

  // Create tree node (use create() for children, createNode() for roots)
  const nodeId = parentId === null ? files.createNode() : files.create(parentId);

  // Get the node's associated metadata map
  const nodeData = files.getMeta(nodeId);

  // Set file metadata
  nodeData.set('type', 'file');
  nodeData.set('name', name);
  nodeData.set('deleted', false);
  nodeData.set('mtime', Date.now());

  // Create content container
  const contentText = nodeData.setContainer('content', new LoroText());
  const { body, frontmatter } = parseFrontmatter(content);
  contentText.insert(0, body);

  // Create frontmatter container
  const frontmatterMap = nodeData.setContainer('frontmatter', new LoroMap());
  if (frontmatter.title) frontmatterMap.set('title', frontmatter.title);
  if (frontmatter.tags?.length) {
    const tagsList = frontmatterMap.setContainer('tags', new LoroList());
    frontmatter.tags.forEach(tag => tagsList.push(tag));
  }
  if (frontmatter.aliases?.length) {
    const aliasesList = frontmatterMap.setContainer('aliases', new LoroList());
    frontmatter.aliases.forEach(alias => aliasesList.push(alias));
  }
  if (frontmatter.created) frontmatterMap.set('created', frontmatter.created);

  return nodeId;
}

/**
 * Create a new folder in the vault.
 */
function createFolder(
  doc: LoroDoc,
  parentId: TreeID | null,
  name: string
): TreeID {
  const files = doc.getTree('files');
  const nodeId = parentId === null ? files.createNode() : files.create(parentId);
  const nodeData = files.getMeta(nodeId);

  nodeData.set('type', 'folder');
  nodeData.set('name', name);
  nodeData.set('deleted', false);
  nodeData.set('mtime', Date.now());

  return nodeId;
}
```

### Moving Files and Folders

Loro handles all move conflict resolution automatically:

```typescript
/**
 * Move a file or folder to a new parent.
 * Loro automatically handles:
 * - Cycle detection (moving A into A's child)
 * - Concurrent moves (last-writer-wins)
 * - Orphan prevention
 */
function moveNode(
  doc: LoroDoc,
  nodeId: TreeID,
  newParentId: TreeID | null
): void {
  const files = doc.getTree('files');

  // Loro's mov() handles all conflict resolution
  files.mov(nodeId, newParentId);

  // Update mtime
  const nodeData = files.getMeta(nodeId);
  nodeData.set('mtime', Date.now());
}

/**
 * Move a node to a specific position among siblings.
 * Uses fractional indexing for efficient ordering.
 */
function moveAfter(
  doc: LoroDoc,
  nodeId: TreeID,
  afterNodeId: TreeID
): void {
  const files = doc.getTree('files');

  // Loro's movAfter uses fractional indexing
  files.movAfter(nodeId, afterNodeId);

  const nodeData = files.getMeta(nodeId);
  nodeData.set('mtime', Date.now());
}

/**
 * Rename a file or folder.
 */
function renameNode(
  doc: LoroDoc,
  nodeId: TreeID,
  newName: string
): void {
  const files = doc.getTree('files');
  const nodeData = files.getMeta(nodeId);

  nodeData.set('name', newName);
  nodeData.set('mtime', Date.now());
}
```

### Deleting Files (Tombstoning)

```typescript
/**
 * Soft delete a file or folder.
 * The node remains in the tree but is marked deleted.
 */
function deleteNode(doc: LoroDoc, nodeId: TreeID): void {
  const files = doc.getTree('files');
  const nodeData = files.getMeta(nodeId);

  nodeData.set('deleted', true);
  nodeData.set('mtime', Date.now());

  // Recursively mark children as deleted
  const childIds = files.children(nodeId);
  for (const childId of childIds) {
    deleteNode(doc, childId);
  }
}
```

## Text Operations (Fugue Algorithm)

Loro uses the **Fugue algorithm** which minimizes interleaving when concurrent edits happen at the same position. This is superior to traditional text CRDTs.

### Updating File Content

```typescript
/**
 * Update file content with efficient diffing.
 */
function updateFileContent(
  doc: LoroDoc,
  nodeId: TreeID,
  newContent: string
): void {
  const files = doc.getTree('files');
  const nodeData = files.getMeta(nodeId);
  const content = nodeData.get('content') as LoroText;

  // Parse new content
  const { body: newBody, frontmatter: newFrontmatter } = parseFrontmatter(newContent);
  const currentBody = content.toString();

  // Apply minimal diff operations
  const patches = computeTextPatches(currentBody, newBody);
  for (const patch of patches) {
    if (patch.type === 'delete') {
      content.delete(patch.index, patch.count);
    } else if (patch.type === 'insert') {
      content.insert(patch.index, patch.text);
    }
  }

  // Update frontmatter
  updateFrontmatter(nodeData, newFrontmatter);

  nodeData.set('mtime', Date.now());
}

/**
 * Apply rich text formatting using Peritext semantics.
 * Loro's LoroText.mark() implements Peritext for proper concurrent formatting.
 */
function applyFormatting(
  content: LoroText,
  start: number,
  end: number,
  format: 'bold' | 'italic' | 'code' | 'link',
  value: boolean | string
): void {
  // Loro's mark() uses Peritext algorithm
  content.mark({ start, end }, format, value);
}
```

## Path Resolution

Convert between tree node IDs and file paths:

```typescript
/**
 * Get the full path for a tree node.
 */
function getNodePath(doc: LoroDoc, nodeId: TreeID): string {
  const files = doc.getTree('files');
  const parts: string[] = [];

  let currentId: TreeID | null = nodeId;
  while (currentId !== null) {
    const nodeData = files.getMeta(currentId);
    parts.unshift(nodeData.get('name') as string);
    currentId = files.parent(currentId);
  }

  return parts.join('/');
}

/**
 * Find a node by its path.
 */
function findNodeByPath(doc: LoroDoc, path: string): TreeID | null {
  const files = doc.getTree('files');
  const parts = path.split('/').filter(p => p.length > 0);

  let currentId: TreeID | null = null; // null = root
  for (const part of parts) {
    // Use roots() for root level, children() for nested
    const childIds = currentId === null ? files.roots() : files.children(currentId);
    const found = childIds.find(childId => {
      const childData = files.getMeta(childId);
      return childData.get('name') === part && !childData.get('deleted');
    });

    if (!found) return null;
    currentId = found;
  }

  return currentId;
}

/**
 * List all files in the vault (non-deleted).
 */
function listAllFiles(doc: LoroDoc): Array<{ nodeId: TreeID; path: string }> {
  const files = doc.getTree('files');
  const result: Array<{ nodeId: TreeID; path: string }> = [];

  function traverse(parentId: TreeID | null, pathPrefix: string) {
    // Use roots() for root level, children() for nested
    const childIds = parentId === null ? files.roots() : files.children(parentId);
    for (const childId of childIds) {
      const nodeData = files.getMeta(childId);
      if (nodeData.get('deleted')) continue;

      const name = nodeData.get('name') as string;
      const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;

      if (nodeData.get('type') === 'file') {
        result.push({ nodeId: childId, path: fullPath });
      } else {
        traverse(childId, fullPath);
      }
    }
  }

  traverse(null, '');
  return result;
}
```

## Frontmatter Handling

YAML frontmatter is stored in structured Loro containers for proper merge semantics.

### Why Structured Fields?

```yaml
# Device A adds:          # Device B adds:
tags: [work]              tags: [personal]

# Text merge (WRONG):
tags: [wperorskonall]     # Character interleaving!

# LoroList merge (CORRECT):
tags: [work, personal]    # Both preserved
```

### Parsing and Serialization

```typescript
import * as yaml from 'yaml';

interface ParsedFrontmatter {
  title?: string;
  tags?: string[];
  aliases?: string[];
  created?: string;
  custom?: Record<string, unknown>;
}

/**
 * Parse frontmatter from markdown content.
 */
function parseFrontmatter(content: string): {
  body: string;
  frontmatter: ParsedFrontmatter;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    return { body: content, frontmatter: {} };
  }

  const [, yamlStr, body] = match;
  const parsed = yaml.parse(yamlStr) || {};

  return {
    body,
    frontmatter: {
      title: parsed.title,
      tags: Array.isArray(parsed.tags) ? parsed.tags : undefined,
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases : undefined,
      created: parsed.created,
      custom: Object.fromEntries(
        Object.entries(parsed).filter(
          ([k]) => !['title', 'tags', 'aliases', 'created'].includes(k)
        )
      ),
    },
  };
}

/**
 * Serialize Loro frontmatter containers back to YAML + body.
 */
function serializeFileContent(
  content: LoroText,
  frontmatter: LoroMap<FrontmatterFields>
): string {
  const body = content.toString();
  const obj: Record<string, unknown> = {};

  const title = frontmatter.get('title');
  if (title) obj.title = title;

  const tags = frontmatter.get('tags') as LoroList<string> | undefined;
  if (tags?.length) obj.tags = tags.toArray();

  const aliases = frontmatter.get('aliases') as LoroList<string> | undefined;
  if (aliases?.length) obj.aliases = aliases.toArray();

  const created = frontmatter.get('created');
  if (created) obj.created = created;

  const custom = frontmatter.get('custom') as LoroMap<unknown> | undefined;
  if (custom) {
    for (const [key, value] of custom.entries()) {
      obj[key] = value;
    }
  }

  if (Object.keys(obj).length === 0) {
    return body;
  }

  return `---\n${yaml.stringify(obj)}---\n${body}`;
}

/**
 * Update frontmatter from parsed values.
 */
function updateFrontmatter(
  nodeData: LoroMap,
  newFrontmatter: ParsedFrontmatter
): void {
  let frontmatter = nodeData.get('frontmatter') as LoroMap<FrontmatterFields>;
  if (!frontmatter) {
    frontmatter = nodeData.setContainer('frontmatter', new LoroMap());
  }

  // Update simple fields
  if (newFrontmatter.title !== undefined) {
    frontmatter.set('title', newFrontmatter.title);
  }
  if (newFrontmatter.created !== undefined) {
    frontmatter.set('created', newFrontmatter.created);
  }

  // Update tags list
  if (newFrontmatter.tags) {
    let tags = frontmatter.get('tags') as LoroList<string>;
    if (!tags) {
      tags = frontmatter.setContainer('tags', new LoroList());
    }
    // Clear and repopulate (could be smarter with diff)
    while (tags.length > 0) tags.delete(0, 1);
    newFrontmatter.tags.forEach(tag => tags.push(tag));
  }

  // Update aliases list
  if (newFrontmatter.aliases) {
    let aliases = frontmatter.get('aliases') as LoroList<string>;
    if (!aliases) {
      aliases = frontmatter.setContainer('aliases', new LoroList());
    }
    while (aliases.length > 0) aliases.delete(0, 1);
    newFrontmatter.aliases.forEach(alias => aliases.push(alias));
  }
}
```

## Map Conflict Resolution (Last-Writer-Wins)

LoroMap uses **Last-Writer-Wins (LWW)** semantics for scalar values. Understanding this behavior is important for handling concurrent edits to metadata.

### How LWW Works

```
Device A sets: { title: "My Note" } at timestamp T1
Device B sets: { title: "My Document" } at timestamp T2

If T2 > T1:
  Result: { title: "My Document" }  (Device B's value wins)
```

### Conflict Scenarios and Resolution

| Scenario | Device A | Device B | Result | Resolution |
|----------|----------|----------|--------|------------|
| Same key, same value | `title: "X"` | `title: "X"` | `title: "X"` | No conflict |
| Same key, different value | `title: "A"` | `title: "B"` | Latest timestamp wins | LWW |
| Different keys | `title: "X"` | `author: "Y"` | Both preserved | No conflict |
| Delete vs update | `delete title` | `title: "X"` | Depends on timestamp | LWW |
| Nested maps | `meta.a: 1` | `meta.b: 2` | Both preserved | Merge |

### Best Practices for Frontmatter

```typescript
/**
 * For fields where both values matter (like tags),
 * use LoroList instead of overwriting.
 */

// WRONG: Tags as comma-separated string (LWW loses data)
frontmatter.set('tags', 'work, personal');  // Device A
frontmatter.set('tags', 'project, urgent');  // Device B
// Result: 'project, urgent' (Device A's tags lost!)

// RIGHT: Tags as LoroList (both preserved)
const tags = frontmatter.setContainer('tags', new LoroList());
tags.push('work');    // Device A
tags.push('project'); // Device B
// Result: ['work', 'project'] (both preserved!)
```

### Detecting LWW Conflicts

Loro doesn't expose conflict information directly, but you can detect concurrent edits:

```typescript
/**
 * Subscribe to changes and detect potential LWW overwrites.
 */
function detectMetadataConflicts(doc: LoroDoc): void {
  doc.subscribe((event) => {
    for (const diff of event.diff) {
      if (diff.type === 'map' && diff.updated) {
        // Multiple peers modified the same key
        // In a short time window, this might indicate concurrent edits
        console.log(`Metadata key '${diff.key}' was updated`);

        // Application can show a notification if desired
        // "Note: Title was updated by another device"
      }
    }
  });
}
```

### When to Use LWW vs CRDT Types

| Data Type | Use Case | Recommended Approach |
|-----------|----------|---------------------|
| Title | Single string, latest is fine | LWW (LoroMap scalar) |
| Tags | Multiple values, all matter | LoroList |
| Aliases | Multiple values, all matter | LoroList |
| Author | Usually one value | LWW |
| Created date | Set once, never changes | LWW |
| Custom key-value | Depends on semantics | LWW or nested LoroMap |

## Text Diffing Algorithm

The `computeTextPatches` function converts string changes to minimal LoroText operations. This is critical for efficient CRDT updates and bandwidth usage.

### Myers Diff Algorithm

PeerVault uses a variant of the **Myers diff algorithm** optimized for character-level operations:

```typescript
import DiffMatchPatch from 'diff-match-patch';

/**
 * Patch operation for LoroText.
 */
interface TextPatch {
  type: 'insert' | 'delete';
  index: number;
  text?: string;  // For insert
  count?: number; // For delete
}

/**
 * Compute minimal patches to transform oldText into newText.
 * Uses diff-match-patch library for efficient character-level diffing.
 */
function computeTextPatches(oldText: string, newText: string): TextPatch[] {
  const dmp = new DiffMatchPatch();

  // Get character-level diff
  const diffs = dmp.diff_main(oldText, newText);

  // Optimize for minimal operations
  dmp.diff_cleanupEfficiency(diffs);

  const patches: TextPatch[] = [];
  let currentIndex = 0;

  for (const [operation, text] of diffs) {
    switch (operation) {
      case DiffMatchPatch.DIFF_EQUAL:
        // No change, just advance position
        currentIndex += text.length;
        break;

      case DiffMatchPatch.DIFF_DELETE:
        patches.push({
          type: 'delete',
          index: currentIndex,
          count: text.length,
        });
        // Don't advance index - text was removed
        break;

      case DiffMatchPatch.DIFF_INSERT:
        patches.push({
          type: 'insert',
          index: currentIndex,
          text: text,
        });
        currentIndex += text.length;
        break;
    }
  }

  return patches;
}
```

### Applying Patches to LoroText

```typescript
/**
 * Apply computed patches to a LoroText instance.
 * Patches must be applied in order (index references original positions).
 */
function applyTextPatches(content: LoroText, patches: TextPatch[]): void {
  // Track offset caused by previous operations
  let offset = 0;

  for (const patch of patches) {
    const adjustedIndex = patch.index + offset;

    if (patch.type === 'delete' && patch.count !== undefined) {
      content.delete(adjustedIndex, patch.count);
      offset -= patch.count;
    } else if (patch.type === 'insert' && patch.text !== undefined) {
      content.insert(adjustedIndex, patch.text);
      offset += patch.text.length;
    }
  }
}
```

### Optimization: Line-Level Then Character-Level

For large files, a two-phase diff is more efficient:

```typescript
/**
 * Optimized diff for large files.
 * First diffs by line, then by character within changed lines.
 */
function computeOptimizedPatches(oldText: string, newText: string): TextPatch[] {
  const dmp = new DiffMatchPatch();

  // For small texts, use character-level directly
  if (oldText.length < 1000 && newText.length < 1000) {
    return computeTextPatches(oldText, newText);
  }

  // Phase 1: Line-level diff
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(oldText, newText);
  const lineDiffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(lineDiffs, lineArray);

  // Phase 2: Character-level within changed lines
  const patches: TextPatch[] = [];
  let currentIndex = 0;

  for (const [op, text] of lineDiffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      currentIndex += text.length;
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      patches.push({ type: 'delete', index: currentIndex, count: text.length });
    } else if (op === DiffMatchPatch.DIFF_INSERT) {
      patches.push({ type: 'insert', index: currentIndex, text });
      currentIndex += text.length;
    }
  }

  return patches;
}
```

### Semantic Cleanup

For user-friendly diffs (e.g., in history view), apply semantic cleanup:

```typescript
/**
 * Get human-readable diff for UI display.
 */
function getSemanticDiff(oldText: string, newText: string): Array<{
  type: 'equal' | 'insert' | 'delete';
  text: string;
}> {
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(oldText, newText);

  // Cleanup for human readability
  dmp.diff_cleanupSemantic(diffs);

  return diffs.map(([op, text]) => ({
    type: op === 0 ? 'equal' : op === 1 ? 'insert' : 'delete',
    text,
  }));
}
```

### Performance Characteristics

| Text Size | Algorithm | Time Complexity |
|-----------|-----------|-----------------|
| < 1KB | Character-level | O(n*m) |
| 1KB - 100KB | Line-then-char | O(n + k*m) where k = changed lines |
| > 100KB | Chunked diff | O(n/c * m) where c = chunk size |

### Edge Cases

| Scenario | Handling |
|----------|----------|
| Empty old text | Single insert of entire new text |
| Empty new text | Single delete of entire old text |
| Identical texts | No patches (empty array) |
| Binary content in text | Treated as opaque bytes, may be inefficient |
| Very long lines | Fall back to character-level for that line |

## Rich Text Support (Peritext + Fugue)

Loro implements both **Peritext** (for formatting spans) and **Fugue** (for text sequence). This provides superior concurrent editing behavior.

### Formatting with Peritext

```typescript
/**
 * Apply bold formatting to a range.
 */
function makeBold(content: LoroText, start: number, end: number): void {
  content.mark({ start, end }, 'bold', true);
}

/**
 * Apply link to a range.
 */
function makeLink(content: LoroText, start: number, end: number, url: string): void {
  content.mark({ start, end }, 'link', url);
}

/**
 * Get formatting at a position.
 */
function getFormattingAt(content: LoroText, position: number): Record<string, unknown> {
  return content.getFormatAt(position);
}

/**
 * Export content with formatting as delta (Quill-compatible).
 */
function exportAsDelta(content: LoroText): Delta {
  return content.toDelta();
}
```

### Cursor Tracking

Loro supports stable cursor positions that survive concurrent edits:

```typescript
/**
 * Get a stable cursor position.
 */
function getCursor(content: LoroText, position: number): Cursor {
  return content.getCursor(position);
}

/**
 * Resolve cursor to current position after edits.
 */
function resolveCursor(doc: LoroDoc, cursor: Cursor): number | null {
  return doc.getCursorPos(cursor);
}
```

## State Transitions

### File Lifecycle

```
                    ┌──────────────┐
                    │  Not in Tree │
                    └──────┬───────┘
                           │ createNode()
                           ▼
                    ┌──────────────┐
         edit ─────►│    Active    │◄───── edit
         move ─────►│ (deleted=false)◄───── move
                    └──────┬───────┘
                           │ deleteNode()
                           ▼
                    ┌──────────────┐
                    │  Tombstoned  │
                    │ (deleted=true)│
                    └──────────────┘
```

### Sync States

```
Local Only ──export──► Updates ──import──► Remote
                           │
                    concurrent edits
                           │
                           ▼
                 Auto-Merged (Loro CRDT)
```

## Tombstone Retention Policy

Deleted files are soft-deleted (tombstoned) to preserve history and enable recovery. This section defines when tombstones can be permanently removed.

### Retention Rules

| Condition | Tombstone State | Action |
|-----------|-----------------|--------|
| Deleted < 30 days | Retained | Keep for potential recovery |
| Deleted 30-90 days | Retained if space allows | Keep if under storage quota |
| Deleted > 90 days | Eligible for cleanup | Can be permanently removed |
| Explicitly restored | Removed | Tombstone cleared on restore |
| All peers synced | Required | Must verify all peers have tombstone |

### Configuration

```typescript
interface TombstoneRetentionConfig {
  /** Minimum retention period (days) */
  minRetentionDays: number;

  /** Maximum retention period (days) */
  maxRetentionDays: number;

  /** Max storage for tombstones (bytes). 0 = unlimited */
  maxTombstoneStorage: number;

  /** Require all known peers to be synced before cleanup */
  requirePeerSync: boolean;
}

const DEFAULT_RETENTION_CONFIG: TombstoneRetentionConfig = {
  minRetentionDays: 30,
  maxRetentionDays: 90,
  maxTombstoneStorage: 50 * 1024 * 1024, // 50MB
  requirePeerSync: true,
};
```

### Cleanup Process

```typescript
import { LoroDoc, TreeID } from 'loro-crdt';

class TombstoneCleanup {
  constructor(
    private doc: LoroDoc,
    private config: TombstoneRetentionConfig,
    private peerManager: PeerManager
  ) {}

  /**
   * Identify tombstones eligible for permanent deletion.
   */
  async findEligibleTombstones(): Promise<TreeID[]> {
    const eligible: TreeID[] = [];
    const files = this.doc.getTree('files');
    const now = Date.now();
    const minAge = this.config.minRetentionDays * 24 * 60 * 60 * 1000;

    // Check all peers are synced if required
    if (this.config.requirePeerSync) {
      const allSynced = await this.allPeersRecentlySynced();
      if (!allSynced) {
        console.log('Skipping tombstone cleanup: not all peers synced');
        return [];
      }
    }

    // Find old tombstones
    function traverse(parentId: TreeID | null) {
      const childIds = parentId === null ? files.roots() : files.children(parentId);
      for (const childId of childIds) {
        const nodeData = files.getMeta(childId);

        if (nodeData.get('deleted')) {
          const deletedAt = nodeData.get('deletedAt') as number;
          const age = now - deletedAt;

          if (age >= minAge) {
            eligible.push(childId);
          }
        }

        traverse(childId);
      }
    }

    traverse(null);
    return eligible;
  }

  /**
   * Permanently remove old tombstones.
   * WARNING: This is irreversible and cannot be synced back!
   */
  async cleanupTombstones(nodeIds: TreeID[]): Promise<number> {
    const files = this.doc.getTree('files');
    let cleaned = 0;

    this.doc.transact(() => {
      for (const nodeId of nodeIds) {
        // Use Loro's delete method to permanently remove
        files.delete(nodeId);
        cleaned++;
      }
    });

    return cleaned;
  }

  /**
   * Check if all known peers have synced recently.
   */
  private async allPeersRecentlySynced(): Promise<boolean> {
    const peers = this.peerManager.getPeerStates();
    const maxSyncAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();

    for (const peer of peers) {
      if (!peer.peer.lastSyncAt) return false;

      const lastSync = new Date(peer.peer.lastSyncAt).getTime();
      if (now - lastSync > maxSyncAge) {
        return false;
      }
    }

    return true;
  }
}
```

### Storage Impact

```typescript
/**
 * Calculate storage used by tombstones.
 */
function calculateTombstoneStorage(doc: LoroDoc): {
  count: number;
  totalBytes: number;
  oldestDays: number;
} {
  const files = doc.getTree('files');
  let count = 0;
  let totalBytes = 0;
  let oldestTimestamp = Date.now();
  const now = Date.now();

  function traverse(parentId: TreeID | null) {
    const childIds = parentId === null ? files.roots() : files.children(parentId);
    for (const childId of childIds) {
      const nodeData = files.getMeta(childId);

      if (nodeData.get('deleted')) {
        count++;

        // Estimate storage (simplified)
        const content = nodeData.get('content');
        if (content) {
          totalBytes += (content as LoroText).length * 2; // UTF-16
        }

        const deletedAt = nodeData.get('deletedAt') as number;
        if (deletedAt < oldestTimestamp) {
          oldestTimestamp = deletedAt;
        }
      }

      traverse(childId);
    }
  }

  traverse(null);

  return {
    count,
    totalBytes,
    oldestDays: Math.floor((now - oldestTimestamp) / (24 * 60 * 60 * 1000)),
  };
}
```

### User-Facing Options

| Setting | Description | Default |
|---------|-------------|---------|
| "Keep deleted files for" | Minimum retention period | 30 days |
| "Maximum retention" | When forced cleanup occurs | 90 days |
| "Tombstone storage limit" | Max storage for tombstones | 50 MB |
| "Require all devices synced" | Wait for sync before cleanup | Yes |

## Clock Skew Handling

Loro uses **Lamport timestamps** (logical clocks) internally, not wall-clock time. However, PeerVault stores `mtime` for UI display. This section addresses clock skew between devices.

### Lamport Timestamps vs Wall Clock

```typescript
/**
 * Loro uses logical clocks for causality ordering.
 * Wall-clock mtime is stored separately for user display.
 */
interface TimestampStrategy {
  /** Loro's internal ordering - always correct */
  causalOrder: 'lamport';

  /** User-facing timestamps - may have skew */
  displayTime: 'wall-clock';
}
```

### Detecting Clock Skew

```typescript
/**
 * Detect significant clock skew during sync.
 */
class ClockSkewDetector {
  private readonly MAX_ACCEPTABLE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Check for clock skew between local and remote timestamps.
   */
  detectSkew(localNow: number, remoteMtime: number): ClockSkewResult {
    const skew = remoteMtime - localNow;

    if (skew > this.MAX_ACCEPTABLE_SKEW_MS) {
      return {
        hasSkew: true,
        direction: 'remote-ahead',
        skewMs: skew,
        message: `Remote device clock is ${Math.round(skew / 60000)} minutes ahead`,
      };
    }

    if (skew < -this.MAX_ACCEPTABLE_SKEW_MS) {
      return {
        hasSkew: true,
        direction: 'remote-behind',
        skewMs: Math.abs(skew),
        message: `Remote device clock is ${Math.round(Math.abs(skew) / 60000)} minutes behind`,
      };
    }

    return { hasSkew: false, skewMs: 0 };
  }
}

interface ClockSkewResult {
  hasSkew: boolean;
  direction?: 'remote-ahead' | 'remote-behind';
  skewMs: number;
  message?: string;
}
```

### Handling Skewed Timestamps

```typescript
/**
 * Normalize timestamps when significant skew is detected.
 */
function normalizeTimestamp(
  remoteMtime: number,
  localNow: number,
  skewResult: ClockSkewResult
): number {
  if (!skewResult.hasSkew) {
    return remoteMtime;
  }

  // Option 1: Cap future timestamps to now
  if (skewResult.direction === 'remote-ahead') {
    return Math.min(remoteMtime, localNow);
  }

  // Option 2: Keep past timestamps as-is (they're valid history)
  return remoteMtime;
}

/**
 * When writing mtime, use bounded timestamp.
 */
function setBoundedMtime(nodeData: LoroMap, timestamp?: number): void {
  const now = Date.now();
  const mtime = timestamp ?? now;

  // Don't allow timestamps more than 1 minute in the future
  const bounded = Math.min(mtime, now + 60000);

  nodeData.set('mtime', bounded);
}
```

### User Notification

```typescript
/**
 * Warn user about clock skew affecting sync.
 */
function notifyClockSkew(skewResult: ClockSkewResult, peerName: string): void {
  if (skewResult.skewMs > 60 * 60 * 1000) {
    // More than 1 hour skew
    new Notice(
      `Warning: "${peerName}" has incorrect clock (${skewResult.message}). ` +
      `File timestamps may appear wrong.`,
      10000
    );
  }
}
```

### Peer Clock Offset Estimation

During sync, estimate peer clock offset to correct displayed timestamps:

```typescript
/**
 * Estimate clock offset during sync handshake.
 * Uses round-trip time measurement similar to NTP.
 */
class PeerClockEstimator {
  private offsets = new Map<string, PeerClockOffset>();

  /**
   * Measure clock offset using sync message exchange.
   *
   * Protocol:
   * 1. Local sends timestamp T1
   * 2. Remote receives at T2, sends back with T2 and its send time T3
   * 3. Local receives at T4
   *
   * Offset = ((T2 - T1) + (T3 - T4)) / 2
   * Round-trip delay = (T4 - T1) - (T3 - T2)
   */
  async measureOffset(peerId: string, sendTimestamp: () => Promise<{
    remoteReceiveTime: number;
    remoteSendTime: number;
  }>): Promise<void> {
    const t1 = Date.now();
    const { remoteReceiveTime: t2, remoteSendTime: t3 } = await sendTimestamp();
    const t4 = Date.now();

    const offset = ((t2 - t1) + (t3 - t4)) / 2;
    const roundTrip = (t4 - t1) - (t3 - t2);

    // Only trust measurements with reasonable round-trip times
    if (roundTrip < 5000) {  // < 5 seconds
      this.updateOffset(peerId, offset, roundTrip);
    }
  }

  private updateOffset(peerId: string, newOffset: number, roundTrip: number): void {
    const existing = this.offsets.get(peerId);

    if (!existing) {
      this.offsets.set(peerId, {
        offsetMs: newOffset,
        confidence: this.calculateConfidence(roundTrip),
        lastMeasured: Date.now(),
        measurementCount: 1,
      });
      return;
    }

    // Exponential moving average for stability
    const alpha = 0.3;  // Weight for new measurement
    existing.offsetMs = alpha * newOffset + (1 - alpha) * existing.offsetMs;
    existing.confidence = this.calculateConfidence(roundTrip);
    existing.lastMeasured = Date.now();
    existing.measurementCount++;

    this.offsets.set(peerId, existing);
  }

  private calculateConfidence(roundTripMs: number): number {
    // Higher round-trip = lower confidence
    if (roundTripMs < 100) return 0.95;
    if (roundTripMs < 500) return 0.8;
    if (roundTripMs < 1000) return 0.6;
    if (roundTripMs < 2000) return 0.4;
    return 0.2;
  }

  /**
   * Correct a remote timestamp using estimated offset.
   */
  correctTimestamp(peerId: string, remoteTimestamp: number): number {
    const offset = this.offsets.get(peerId);
    if (!offset || offset.confidence < 0.4) {
      return remoteTimestamp;  // Low confidence, don't correct
    }

    return remoteTimestamp - offset.offsetMs;
  }

  getOffset(peerId: string): PeerClockOffset | null {
    return this.offsets.get(peerId) ?? null;
  }
}

interface PeerClockOffset {
  /** Estimated offset in ms (positive = peer ahead, negative = peer behind) */
  offsetMs: number;
  /** Confidence in estimate (0-1) */
  confidence: number;
  /** When this offset was last measured */
  lastMeasured: number;
  /** Number of successful measurements */
  measurementCount: number;
}
```

### Sync Message with Timestamps

Include timestamps in sync messages for offset measurement:

```typescript
interface SyncHandshakeMessage {
  type: 'handshake';
  /** Local time when message was created */
  localTime: number;
  /** If responding, time we received the request */
  requestReceivedTime?: number;
  /** Version vector */
  version: Uint8Array;
}

/**
 * Handle handshake with clock measurement.
 */
async function handleSyncHandshake(
  connection: Connection,
  clockEstimator: PeerClockEstimator
): Promise<void> {
  // Send our timestamp
  const t1 = Date.now();
  connection.send({
    type: 'handshake',
    localTime: t1,
    version: serializeVersion(),
  });

  // Wait for response
  const response = await connection.receive();
  const t4 = Date.now();

  if (response.requestReceivedTime) {
    // Measure clock offset
    await clockEstimator.measureOffset(connection.peerId, async () => ({
      remoteReceiveTime: response.requestReceivedTime!,
      remoteSendTime: response.localTime,
    }));
  }
}
```

### Persisting Clock Offsets

```typescript
/**
 * Persist clock offsets across sessions for faster initial sync.
 */
async function persistClockOffsets(
  offsets: Map<string, PeerClockOffset>,
  storage: PluginStorage
): Promise<void> {
  // Only persist offsets with decent confidence and recent measurement
  const toSave: Record<string, PeerClockOffset> = {};
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

  for (const [peerId, offset] of offsets) {
    if (offset.confidence >= 0.6 && Date.now() - offset.lastMeasured < maxAge) {
      toSave[peerId] = offset;
    }
  }

  await storage.saveData({ clockOffsets: toSave });
}
```

### Best Practices

| Scenario | Handling |
|----------|----------|
| Future mtime from remote | Cap to current time |
| Past mtime from remote | Accept as-is (valid history) |
| Very old mtime (> 1 year future) | Log warning, cap to now |
| Conflict resolution | Loro's Lamport clock is authoritative, ignore wall-clock |
| Known peer with offset | Apply correction for display timestamps |
| New peer, unknown offset | Accept as-is until measured |
| High-latency connection | Lower confidence, measure multiple times |

## History Compaction

As vaults accumulate edits, Loro document size grows. History compaction balances storage with history access.

### When Compaction Occurs

| Trigger | Action |
|---------|--------|
| Document > 100MB | Suggest compaction |
| Document > 500MB | Force compaction warning |
| Manual request | User-triggered compaction |
| All peers synced | Safe to compact |

### Compaction Strategies

#### 1. Snapshot-Only Export

The simplest compaction: export current state without operation history.

```typescript
/**
 * Compact by creating snapshot-only export.
 * WARNING: Loses ability to merge with peers not yet synced!
 */
async function compactToSnapshot(doc: LoroDoc): Promise<{
  originalSize: number;
  compactedSize: number;
}> {
  const original = doc.export({ mode: 'snapshot' });
  const originalSize = original.byteLength;

  // Create new doc from current state only
  const compacted = new LoroDoc();
  compacted.import(original);

  // Re-export (Loro optimizes on import)
  const compactedBytes = compacted.export({ mode: 'snapshot' });

  return {
    originalSize,
    compactedSize: compactedBytes.byteLength,
  };
}
```

#### 2. Checkpoint with Shallow History

Keep recent history, discard old operations:

```typescript
interface CompactionConfig {
  /** Keep operations from last N days */
  keepHistoryDays: number;

  /** Minimum operations to keep regardless of age */
  minOperationsToKeep: number;

  /** Maximum document size before suggesting compaction */
  suggestCompactionBytes: number;
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  keepHistoryDays: 30,
  minOperationsToKeep: 1000,
  suggestCompactionBytes: 100 * 1024 * 1024, // 100MB
};

/**
 * Check if document needs compaction.
 */
function checkCompactionNeeded(doc: LoroDoc, config: CompactionConfig): {
  needed: boolean;
  currentSize: number;
  reason?: string;
} {
  const snapshot = doc.export({ mode: 'snapshot' });
  const currentSize = snapshot.byteLength;

  if (currentSize > config.suggestCompactionBytes) {
    return {
      needed: true,
      currentSize,
      reason: `Document size (${Math.round(currentSize / 1024 / 1024)}MB) exceeds threshold`,
    };
  }

  return { needed: false, currentSize };
}
```

#### 3. Shallow Clone

Create a new document with only current state:

```typescript
/**
 * Create shallow clone with no history.
 * All peers must re-sync from scratch!
 */
async function shallowClone(
  doc: LoroDoc,
  vaultId: string,
  vaultName: string
): Promise<LoroDoc> {
  const newDoc = createVaultDoc(vaultId, vaultName);
  const oldFiles = doc.getTree('files');
  const newFiles = newDoc.getTree('files');

  // Copy tree structure
  function copyNode(oldId: TreeID, newParentId: TreeID | null) {
    const oldData = oldFiles.getMeta(oldId);

    // Skip deleted nodes
    if (oldData.get('deleted')) return;

    // Create new node
    const newId = newParentId === null
      ? newFiles.createNode()
      : newFiles.create(newParentId);

    const newData = newFiles.getMeta(newId);

    // Copy metadata
    newData.set('type', oldData.get('type'));
    newData.set('name', oldData.get('name'));
    newData.set('deleted', false);
    newData.set('mtime', oldData.get('mtime'));

    // Copy content for files
    if (oldData.get('type') === 'file') {
      const oldContent = oldData.get('content') as LoroText;
      const newContent = newData.setContainer('content', new LoroText());
      newContent.insert(0, oldContent.toString());

      // Copy frontmatter
      const oldFm = oldData.get('frontmatter') as LoroMap;
      if (oldFm) {
        const newFm = newData.setContainer('frontmatter', new LoroMap());
        copyFrontmatter(oldFm, newFm);
      }
    }

    // Recursively copy children
    const childIds = oldFiles.children(oldId);
    for (const childId of childIds) {
      copyNode(childId, newId);
    }
  }

  // Copy root nodes
  for (const rootId of oldFiles.roots()) {
    copyNode(rootId, null);
  }

  return newDoc;
}
```

### Compaction Safety

```typescript
/**
 * Safe compaction with backup and peer sync verification.
 */
class SafeCompaction {
  constructor(
    private storage: StorageAdapter,
    private peerManager: PeerManager
  ) {}

  async compact(doc: LoroDoc): Promise<CompactionResult> {
    // 1. Verify all peers recently synced
    const unsynced = await this.getUnsyncedPeers();
    if (unsynced.length > 0) {
      return {
        success: false,
        error: `Cannot compact: ${unsynced.length} peers not synced`,
        unsyncedPeers: unsynced,
      };
    }

    // 2. Create backup
    const backupPath = await this.storage.createBackup('pre-compaction');

    try {
      // 3. Perform compaction
      const { compactedSize } = await compactToSnapshot(doc);

      // 4. Save compacted document
      await this.storage.saveDoc(doc);

      return {
        success: true,
        originalSize: doc.export({ mode: 'snapshot' }).byteLength,
        compactedSize,
        backupPath,
      };
    } catch (error) {
      // 5. Restore backup on failure
      await this.storage.restoreBackup(backupPath);
      throw error;
    }
  }

  private async getUnsyncedPeers(): Promise<string[]> {
    const peers = this.peerManager.getPeerStates();
    const staleThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();

    return peers
      .filter(p => {
        const lastSync = p.peer.lastSyncAt
          ? new Date(p.peer.lastSyncAt).getTime()
          : 0;
        return now - lastSync > staleThreshold;
      })
      .map(p => p.peer.name);
  }
}

interface CompactionResult {
  success: boolean;
  error?: string;
  unsyncedPeers?: string[];
  originalSize?: number;
  compactedSize?: number;
  backupPath?: string;
}
```

### User-Facing Options

| Setting | Description | Default |
|---------|-------------|---------|
| "Compact when larger than" | Document size threshold | 100 MB |
| "Keep history for" | Days of operation history | 30 days |
| "Auto-compact" | Automatic compaction when threshold reached | Off |
| "Require peer sync" | Wait for all peers before compacting | Yes |

## Undo/Redo Integration

PeerVault must integrate with Obsidian's native undo/redo system while maintaining CRDT consistency.

### Challenge

Obsidian's editor has its own undo/redo stack (CodeMirror-based), while Loro maintains operation history. These must be reconciled:

```
┌─────────────────────────────────────────────────────────────┐
│                  Undo/Redo Architecture                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  User Edit → CodeMirror → PeerVault → Loro                  │
│     ↑              ↓                    ↓                   │
│     │         CM Undo Stack       Loro History              │
│     │              ↓                    ↓                   │
│     └──────── Undo Event ────────► Undo Op                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Strategy: Editor-First Undo

PeerVault treats the editor's undo/redo as authoritative for local changes:

```typescript
/**
 * Undo/redo handler that bridges CodeMirror and Loro.
 */
class UndoRedoHandler {
  private isUndoing = false;
  private isRedoing = false;

  constructor(
    private doc: LoroDoc,
    private plugin: PeerVaultPlugin
  ) {
    // Listen to editor undo/redo events
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('editor-change', this.handleEditorChange.bind(this))
    );
  }

  /**
   * Handle editor changes, distinguishing undo/redo from normal edits.
   */
  handleEditorChange(editor: Editor, info: EditorChange): void {
    // Detect if this is an undo/redo operation
    if (this.isUndoRedoOperation(info)) {
      // Let the editor's undo/redo take precedence
      // Apply the resulting content to Loro as a new operation
      this.applyEditorStateToLoro(editor);
    }
    // Normal edits are handled by the file watcher
  }

  private isUndoRedoOperation(info: EditorChange): boolean {
    // CodeMirror marks undo/redo with specific origin
    return info.origin === 'undo' || info.origin === 'redo';
  }

  private applyEditorStateToLoro(editor: Editor): void {
    const content = editor.getValue();
    const file = this.plugin.app.workspace.getActiveFile();

    if (file) {
      // Apply as new Loro operation (not trying to reverse Loro history)
      this.doc.transact(() => {
        const nodeId = findNodeByPath(this.doc, file.path);
        if (nodeId) {
          updateFileContent(this.doc, nodeId, content);
        }
      });
    }
  }
}
```

### Why Not Loro's Native Undo?

Loro has `doc.undo()` and `doc.redo()` capabilities, but they're designed for collaborative document editing, not file sync:

| Aspect | Loro Undo | Editor Undo |
|--------|-----------|-------------|
| Scope | Entire document | Single file |
| Granularity | Per-transaction | Per-keystroke/selection |
| User expectation | Undo across files | Undo in current editor |
| Behavior on sync | May undo remote changes | Only undoes local |

### Handling Remote Changes During Undo

```typescript
/**
 * Track local vs remote changes for undo behavior.
 */
class LocalChangeTracker {
  private localVersions = new Map<string, Uint8Array>();

  /**
   * Mark current version before applying remote changes.
   */
  beforeRemoteSync(filePath: string): void {
    const nodeId = findNodeByPath(this.doc, filePath);
    if (nodeId) {
      // Store local version
      this.localVersions.set(filePath, this.doc.version().encode());
    }
  }

  /**
   * Check if content at path has only local changes.
   */
  hasOnlyLocalChanges(filePath: string): boolean {
    const stored = this.localVersions.get(filePath);
    if (!stored) return true;

    // Compare with current - if same, only local changes
    return this.doc.version().includes(stored);
  }

  /**
   * When user undoes, should we allow it?
   */
  canUndo(filePath: string): boolean {
    // Always allow undo - it creates new Loro ops
    return true;
  }
}
```

### Undo Stack Preservation

When remote changes arrive, preserve the user's undo stack:

```typescript
/**
 * Apply remote changes without disrupting editor undo stack.
 */
async function applyRemoteChanges(
  doc: LoroDoc,
  updates: Uint8Array,
  editor: Editor | null
): Promise<void> {
  // Save editor undo history
  const undoHistory = editor?.cm?.state?.field?.(historyField);

  // Apply Loro changes
  doc.import(updates);

  // If editor is open for affected file, update it
  if (editor) {
    const newContent = getFileContent(doc, getCurrentFilePath());

    // Apply content change while preserving undo history
    editor.cm.dispatch({
      changes: {
        from: 0,
        to: editor.cm.state.doc.length,
        insert: newContent,
      },
      // Mark as remote change - doesn't add to undo stack
      annotations: [Transaction.remote.of(true)],
    });
  }
}
```

### Configuration

```typescript
interface UndoConfig {
  /** Whether to show notification when remote change affects open file */
  notifyOnRemoteChange: boolean;

  /** Maximum undo history per file (CodeMirror default: 200) */
  maxUndoHistory: number;

  /** Whether undo should work across sync (experimental) */
  crossDeviceUndo: boolean;
}

const DEFAULT_UNDO_CONFIG: UndoConfig = {
  notifyOnRemoteChange: true,
  maxUndoHistory: 200,
  crossDeviceUndo: false, // Not recommended
};
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Undo after remote edit | Undoes local edit, creates new op |
| Redo after remote edit | Redoes local edit, creates new op |
| Close file with unsaved undo history | Undo history lost (standard Obsidian behavior) |
| Sync while undo in progress | Complete undo first, then sync |
| Concurrent undo on two devices | Each creates independent ops, Loro merges |

## Canvas and JSON File Support

Obsidian Canvas (.canvas) and Excalidraw files require special handling as they are JSON-based but not plain text.

### Supported JSON File Types

| Extension | Type | Strategy |
|-----------|------|----------|
| `.canvas` | Obsidian Canvas | JSON CRDT (LoroMap) |
| `.excalidraw` | Excalidraw drawings | JSON CRDT (LoroMap) |
| `.json` | Generic JSON | Opaque blob or JSON CRDT |

### Canvas File Structure

```typescript
/**
 * Obsidian Canvas file structure (simplified).
 */
interface CanvasFile {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface CanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  // ... other properties
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide: 'top' | 'bottom' | 'left' | 'right';
  toSide: 'top' | 'bottom' | 'left' | 'right';
}
```

### CRDT Representation for Canvas

```typescript
/**
 * Store canvas as CRDT-friendly structure.
 */
interface CanvasNodeData extends FileNodeData {
  type: 'canvas';

  /** Nodes stored in LoroMap for concurrent edits */
  nodes: LoroMap<string, LoroMap<CanvasNodeFields>>;

  /** Edges stored separately */
  edges: LoroMap<string, LoroMap<CanvasEdgeFields>>;

  /** Canvas metadata */
  canvasMeta: LoroMap<{
    viewportX?: number;
    viewportY?: number;
    zoom?: number;
  }>;
}

/**
 * Convert JSON canvas to CRDT representation.
 */
function canvasToLoro(canvas: CanvasFile, nodeData: LoroMap): void {
  const nodes = nodeData.setContainer('nodes', new LoroMap());
  const edges = nodeData.setContainer('edges', new LoroMap());

  // Each canvas node becomes a LoroMap entry
  for (const node of canvas.nodes) {
    const nodeMap = nodes.setContainer(node.id, new LoroMap());
    nodeMap.set('type', node.type);
    nodeMap.set('x', node.x);
    nodeMap.set('y', node.y);
    nodeMap.set('width', node.width);
    nodeMap.set('height', node.height);
    if (node.text) nodeMap.set('text', node.text);
    if (node.file) nodeMap.set('file', node.file);
  }

  // Each edge becomes a LoroMap entry
  for (const edge of canvas.edges) {
    const edgeMap = edges.setContainer(edge.id, new LoroMap());
    edgeMap.set('fromNode', edge.fromNode);
    edgeMap.set('toNode', edge.toNode);
    edgeMap.set('fromSide', edge.fromSide);
    edgeMap.set('toSide', edge.toSide);
  }
}

/**
 * Convert CRDT representation back to JSON canvas.
 */
function loroToCanvas(nodeData: LoroMap): CanvasFile {
  const nodesMap = nodeData.get('nodes') as LoroMap;
  const edgesMap = nodeData.get('edges') as LoroMap;

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  // Reconstruct nodes
  for (const [id, nodeMap] of nodesMap.entries()) {
    const map = nodeMap as LoroMap;
    nodes.push({
      id,
      type: map.get('type') as CanvasNode['type'],
      x: map.get('x') as number,
      y: map.get('y') as number,
      width: map.get('width') as number,
      height: map.get('height') as number,
      text: map.get('text') as string | undefined,
      file: map.get('file') as string | undefined,
    });
  }

  // Reconstruct edges
  for (const [id, edgeMap] of edgesMap.entries()) {
    const map = edgeMap as LoroMap;
    edges.push({
      id,
      fromNode: map.get('fromNode') as string,
      toNode: map.get('toNode') as string,
      fromSide: map.get('fromSide') as CanvasEdge['fromSide'],
      toSide: map.get('toSide') as CanvasEdge['toSide'],
    });
  }

  return { nodes, edges };
}
```

### Conflict Resolution for Canvas

Canvas operations are particularly challenging because they involve spatial properties where concurrent edits must be resolved deterministically.

#### Property-Level Merge Rules

| Property Type | Merge Strategy | Rationale |
|--------------|----------------|-----------|
| **Position (x, y)** | Last-Writer-Wins (LWW) | Spatial properties can't be meaningfully merged |
| **Size (width, height)** | LWW | Same as position |
| **Text content** | LoroText CRDT merge | Text can be merged character-by-character |
| **Node type** | LWW | Type changes are atomic |
| **File references** | LWW | File paths can't be merged |
| **Color/style** | LWW | Visual properties are atomic |
| **Edge connections** | LWW per endpoint | Each endpoint resolves independently |

#### LWW Ordering Rules

Loro's `LoroMap.set()` uses Last-Writer-Wins semantics based on:
1. **Lamport timestamp** (logical clock, not wall clock)
2. **Peer ID** as tiebreaker (deterministic ordering)

```typescript
/**
 * When two peers edit the same property concurrently:
 *
 * Peer A (ID: aaa): set('x', 100) at Lamport time 5
 * Peer B (ID: bbb): set('x', 200) at Lamport time 5
 *
 * Result: 'bbb' > 'aaa', so x = 200 wins
 *
 * This is deterministic - all peers converge to the same value.
 */
```

#### Concurrent Edit Scenarios

```typescript
/**
 * Scenario 1: Same node moved by two users
 *
 * Initial: node at (100, 100)
 * User A (offline): moves to (200, 200)
 * User B (offline): moves to (150, 300)
 *
 * After sync: Loro picks one position deterministically.
 * The "losing" position is NOT visible to either user.
 *
 * IMPORTANT: This may surprise users who expect their move to persist.
 */
function handleConcurrentMove(nodeId: string): void {
  // After merge, check if local position was overwritten
  const localPosition = this.pendingLocalMoves.get(nodeId);
  const mergedPosition = this.getNodePosition(nodeId);

  if (localPosition && !positionsEqual(localPosition, mergedPosition)) {
    // Notify user their move was overwritten
    this.emit('moveOverwritten', {
      nodeId,
      localPosition,
      mergedPosition,
    });
  }
}
```

```typescript
/**
 * Scenario 2: Node edited vs deleted
 *
 * User A: Deletes node X
 * User B: Edits node X's text
 *
 * Resolution: Edit wins - node X survives with B's text.
 * Deletion is implemented as soft-delete (deleted: true flag).
 * B's edit clears the deleted flag.
 */
function resolveDeleteVsEdit(nodeId: string, wasDeleted: boolean, wasEdited: boolean): void {
  const node = this.nodes.get(nodeId);

  if (wasDeleted && wasEdited) {
    // Edit wins: un-delete the node
    node.set('deleted', false);
    console.log(`Node ${nodeId} was deleted by one peer but edited by another. Kept the node.`);
  }
}
```

```typescript
/**
 * Scenario 3: Edge connected to deleted node
 *
 * User A: Deletes node X
 * User B: Creates edge from Y to X
 *
 * Resolution: Edge is removed for referential integrity.
 * This is handled by a post-merge consistency check.
 */
function ensureEdgeIntegrity(edges: LoroMap, nodes: LoroMap): void {
  for (const [edgeId, edge] of edges.entries()) {
    const fromNode = edge.get('fromNode');
    const toNode = edge.get('toNode');

    const fromExists = nodes.get(fromNode) && !nodes.get(fromNode).get('deleted');
    const toExists = nodes.get(toNode) && !nodes.get(toNode).get('deleted');

    if (!fromExists || !toExists) {
      // Mark edge as deleted (soft delete)
      edge.set('deleted', true);
      console.log(`Edge ${edgeId} references deleted node, marking as deleted`);
    }
  }
}
```

#### User Notification for Conflicts

```typescript
interface CanvasConflictEvent {
  type: 'position-overwritten' | 'node-restored' | 'edge-removed';
  nodeId?: string;
  edgeId?: string;
  localValue?: unknown;
  mergedValue?: unknown;
}

class CanvasConflictNotifier {
  /**
   * Notify user when their canvas edit was overwritten.
   */
  notifyConflict(event: CanvasConflictEvent): void {
    switch (event.type) {
      case 'position-overwritten':
        new Notice(
          `A node position you changed was updated by another device.`,
          3000
        );
        break;

      case 'node-restored':
        new Notice(
          `A node you deleted was edited by another device and has been restored.`,
          5000
        );
        break;

      case 'edge-removed':
        // Silent - edge removal due to node deletion is expected
        break;
    }
  }
}
```

#### Viewport State

Viewport position and zoom are **per-device** and **not synced**:

```typescript
interface CanvasViewport {
  /** Center X coordinate */
  x: number;
  /** Center Y coordinate */
  y: number;
  /** Zoom level (1.0 = 100%) */
  zoom: number;
}

// Viewport is stored locally, not in the CRDT
const VIEWPORT_STORAGE_KEY = 'peervault-canvas-viewport';

function saveLocalViewport(canvasPath: string, viewport: CanvasViewport): void {
  const viewports = JSON.parse(localStorage.getItem(VIEWPORT_STORAGE_KEY) || '{}');
  viewports[canvasPath] = viewport;
  localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(viewports));
}
```

### Excalidraw Support

```typescript
/**
 * Excalidraw files have similar structure.
 */
interface ExcalidrawFile {
  type: 'excalidraw';
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, ExcalidrawFileData>;
}

/**
 * Use same strategy as Canvas.
 */
function excalidrawToLoro(file: ExcalidrawFile, nodeData: LoroMap): void {
  const elements = nodeData.setContainer('elements', new LoroMap());

  for (const element of file.elements) {
    const elemMap = elements.setContainer(element.id, new LoroMap());
    // Store each property
    for (const [key, value] of Object.entries(element)) {
      if (typeof value === 'object') {
        // Nested objects need special handling
        elemMap.set(key, JSON.stringify(value));
      } else {
        elemMap.set(key, value);
      }
    }
  }

  // Store appState and files as JSON (less collaborative, but simpler)
  nodeData.set('appState', JSON.stringify(file.appState));
  nodeData.set('files', JSON.stringify(file.files));
}
```

### File Watcher Integration

```typescript
/**
 * Detect and handle JSON-based file types.
 */
function getFileHandler(path: string): FileHandler {
  const ext = path.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'canvas':
      return new CanvasFileHandler();
    case 'excalidraw':
      return new ExcalidrawFileHandler();
    case 'md':
      return new MarkdownFileHandler();
    default:
      // Treat as binary/blob
      return new BlobFileHandler();
  }
}

interface FileHandler {
  toLoroData(content: string | ArrayBuffer, nodeData: LoroMap): void;
  fromLoroData(nodeData: LoroMap): string | ArrayBuffer;
  getContentType(): 'text' | 'json' | 'binary';
}
```

## Loro API Reference

This section provides exact method signatures for the Loro CRDT library. These are the canonical APIs used throughout PeerVault.

### LoroDoc Methods

```typescript
import { LoroDoc, LoroTree, LoroMap, LoroText, LoroList, TreeID, VersionVector } from 'loro-crdt';

/**
 * LoroDoc - The root document container.
 */
class LoroDoc {
  /** Create a new empty document */
  constructor(): LoroDoc;

  /** Get or create a tree container */
  getTree(name: string): LoroTree;

  /** Get or create a map container */
  getMap(name: string): LoroMap;

  /** Get the current version vector */
  version(): VersionVector;

  /** Subscribe to document changes */
  subscribe(callback: (event: LoroEvent) => void): () => void;

  /** Export document (snapshot or updates) */
  export(options: ExportOptions): Uint8Array;

  /** Import updates or snapshot from another document */
  import(data: Uint8Array): void;

  /** Run operations in a transaction */
  transact(fn: () => void): void;
}

interface ExportOptions {
  /** Export mode */
  mode: 'snapshot' | 'update';
  /** For 'update' mode: export changes since this version */
  from?: VersionVector;
}
```

### LoroTree Methods

```typescript
/**
 * LoroTree - Movable tree CRDT for file hierarchy.
 */
class LoroTree {
  /**
   * Create a new root node.
   * @returns TreeID of the new node
   */
  createNode(): TreeID;

  /**
   * Create a child node under a parent.
   * @param parentId - Parent node ID
   * @returns TreeID of the new child node
   */
  create(parentId: TreeID): TreeID;

  /**
   * Get the metadata map for a node.
   * @param nodeId - The tree node ID
   * @returns LoroMap containing node metadata
   */
  getMeta(nodeId: TreeID): LoroMap;

  /**
   * Get all root-level nodes.
   * @returns Array of TreeIDs for root nodes
   */
  roots(): TreeID[];

  /**
   * Get child nodes of a parent.
   * @param parentId - The parent node ID
   * @returns Array of TreeIDs for children
   */
  children(parentId: TreeID): TreeID[];

  /**
   * Get parent of a node.
   * @param nodeId - The node to query
   * @returns Parent TreeID or null if root
   */
  parent(nodeId: TreeID): TreeID | null;

  /**
   * Move a node to a new parent.
   * Handles cycle detection automatically.
   * @param nodeId - Node to move
   * @param newParentId - New parent (null for root)
   */
  mov(nodeId: TreeID, newParentId: TreeID | null): void;

  /**
   * Move a node to a position after another sibling.
   * Uses fractional indexing for ordering.
   * @param nodeId - Node to move
   * @param afterNodeId - Node to position after
   */
  movAfter(nodeId: TreeID, afterNodeId: TreeID): void;

  /**
   * Permanently delete a node from the tree.
   * WARNING: This is irreversible. Prefer soft-delete via metadata.
   * @param nodeId - Node to delete
   */
  delete(nodeId: TreeID): void;
}

/**
 * TreeID is an opaque identifier for tree nodes.
 * Internally it's a compound of peer ID and counter.
 */
type TreeID = string; // Opaque type, treat as string
```

### LoroMap Methods

```typescript
/**
 * LoroMap - Key-value map with LWW semantics.
 */
class LoroMap<T = unknown> {
  /**
   * Get a value by key.
   * @param key - The key to retrieve
   * @returns The value or undefined
   */
  get(key: string): T | undefined;

  /**
   * Set a scalar value.
   * @param key - The key
   * @param value - Scalar value (string, number, boolean, null)
   */
  set(key: string, value: string | number | boolean | null): void;

  /**
   * Set a nested container.
   * @param key - The key
   * @param container - LoroMap, LoroList, or LoroText
   * @returns The container (for chaining)
   */
  setContainer<C extends LoroMap | LoroList | LoroText>(key: string, container: C): C;

  /**
   * Delete a key.
   * @param key - The key to delete
   */
  delete(key: string): void;

  /**
   * Get all entries as an iterator.
   * @returns Iterator of [key, value] pairs
   */
  entries(): IterableIterator<[string, T]>;

  /**
   * Get all keys.
   * @returns Iterator of keys
   */
  keys(): IterableIterator<string>;

  /**
   * Convert to plain JavaScript object.
   * @returns Plain object representation
   */
  toJSON(): Record<string, T>;
}
```

### LoroText Methods

```typescript
/**
 * LoroText - Rich text CRDT using Fugue algorithm.
 */
class LoroText {
  /** Get text length */
  readonly length: number;

  /**
   * Insert text at position.
   * @param index - Character position (0-based)
   * @param text - Text to insert
   */
  insert(index: number, text: string): void;

  /**
   * Delete characters at position.
   * @param index - Start position
   * @param count - Number of characters to delete
   */
  delete(index: number, count: number): void;

  /**
   * Apply rich text formatting (Peritext algorithm).
   * @param range - { start, end } character range
   * @param format - Format name ('bold', 'italic', 'link', etc.)
   * @param value - Format value (true for toggles, string for links)
   */
  mark(range: { start: number; end: number }, format: string, value: unknown): void;

  /**
   * Get formatting at a character position.
   * @param position - Character position
   * @returns Object with active formats
   */
  getFormatAt(position: number): Record<string, unknown>;

  /**
   * Get a stable cursor position.
   * Survives concurrent edits.
   * @param position - Character position
   * @returns Cursor object
   */
  getCursor(position: number): Cursor;

  /**
   * Convert to plain string.
   * @returns String content without formatting
   */
  toString(): string;

  /**
   * Export as Quill-compatible delta.
   * @returns Delta object with ops array
   */
  toDelta(): Delta;
}
```

### LoroList Methods

```typescript
/**
 * LoroList - Ordered list CRDT.
 */
class LoroList<T = unknown> {
  /** Get list length */
  readonly length: number;

  /**
   * Get item at index.
   * @param index - Array index
   * @returns Item value
   */
  get(index: number): T | undefined;

  /**
   * Insert item at index.
   * @param index - Position to insert at
   * @param value - Value to insert
   */
  insert(index: number, value: T): void;

  /**
   * Append item to end.
   * @param value - Value to append
   */
  push(value: T): void;

  /**
   * Delete items at index.
   * @param index - Start position
   * @param count - Number of items to delete
   */
  delete(index: number, count: number): void;

  /**
   * Convert to plain array.
   * @returns Array representation
   */
  toArray(): T[];
}
```

### VersionVector Methods

```typescript
/**
 * VersionVector - Tracks causality for sync.
 */
class VersionVector {
  /**
   * Encode to binary for transmission.
   * @returns Binary representation
   */
  encode(): Uint8Array;

  /**
   * Convert to JSON-friendly object.
   * @returns Object with { peerId: counter } entries
   */
  toJSON(): Record<string, number>;

  /**
   * Check if this version includes another.
   * @param other - Version to compare
   * @returns True if this >= other
   */
  includes(other: Uint8Array | VersionVector): boolean;
}
```

### Common Type Definitions

```typescript
/** Event emitted on document changes */
interface LoroEvent {
  /** Array of individual changes */
  diff: LoroDiff[];
  /** Origin of change ('local' or 'import') */
  origin: 'local' | 'import';
}

/** Individual change within an event */
interface LoroDiff {
  /** Type of change */
  type: 'map' | 'list' | 'text' | 'tree';
  /** For map changes: the affected key */
  key?: string;
  /** Whether value was updated (vs deleted) */
  updated?: boolean;
}

/** Cursor for stable position tracking */
interface Cursor {
  /** Opaque cursor data */
  readonly data: Uint8Array;
}

/** Quill-compatible delta format */
interface Delta {
  ops: Array<{
    insert?: string;
    delete?: number;
    retain?: number;
    attributes?: Record<string, unknown>;
  }>;
}
```

### Usage Examples

```typescript
// Complete example: create vault with file
const doc = new LoroDoc();
const files = doc.getTree('files');
const meta = doc.getMap('meta');

// Set vault metadata
meta.set('vaultId', 'abc123');
meta.set('version', 1);

// Create a folder
const folderId = files.createNode();
const folderMeta = files.getMeta(folderId);
folderMeta.set('type', 'folder');
folderMeta.set('name', 'Notes');
folderMeta.set('deleted', false);

// Create a file in the folder
const fileId = files.create(folderId);
const fileMeta = files.getMeta(fileId);
fileMeta.set('type', 'file');
fileMeta.set('name', 'daily.md');
fileMeta.set('deleted', false);
fileMeta.set('mtime', Date.now());

// Add content
const content = fileMeta.setContainer('content', new LoroText());
content.insert(0, '# Daily Note\n\nToday I learned...');

// Export for sync
const updates = doc.export({ mode: 'update' });

// On another device, import
const doc2 = new LoroDoc();
doc2.import(updates);
```

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0",
    "yaml": "^2.0.0",
    "diff-match-patch": "^1.0.5"
  }
}
```

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| CRDT Library | Loro | Native tree CRDT, Fugue algorithm, 10-200x faster parsing, snapshot support |
| Document Structure | Single LoroDoc with LoroTree | Leverages native move operations, simpler sync |
| Binary files | Hash references to iroh-blobs | Store file hashes in CRDT, sync binaries separately via iroh-blobs |
| Frontmatter | LoroMap with LoroList for arrays | Concurrent tag/alias edits merge correctly |
| Large files | User-configurable size limit | Let users set max file size in settings. Default 5MB recommended |
| Text Algorithm | Fugue (via Loro) | Minimizes interleaving anomalies in concurrent edits |
| Rich Text | Peritext (via Loro) | Proper concurrent formatting span handling |
| Move Operations | Native LoroTree | Automatic cycle detection, last-writer-wins conflict resolution |
