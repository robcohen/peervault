# File Watcher Spec

## Purpose

Monitor the Obsidian vault for file changes and propagate them to the Loro document. This bridges the filesystem and CRDT layers.

## Requirements

- **REQ-FW-01**: MUST detect file creation, modification, deletion, and rename
- **REQ-FW-02**: MUST debounce rapid changes to avoid excessive updates
- **REQ-FW-03**: MUST track all text files (configurable filter)
- **REQ-FW-04**: MUST ignore changes originating from sync (prevent loops)
- **REQ-FW-05**: MUST handle large vaults (1000+ files) efficiently

## Events

```typescript
type FileEvent =
  | { type: 'create'; path: string }
  | { type: 'modify'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; oldPath: string; newPath: string };
```

## Interface

```typescript
interface FileWatcher {
  /**
   * Start watching the vault for changes.
   */
  start(): void;

  /**
   * Stop watching and clean up resources.
   */
  stop(): void;

  /**
   * Register a callback for file events.
   */
  onFileEvent(callback: (event: FileEvent) => void): void;

  /**
   * Temporarily ignore changes to a path (during sync writes).
   * @param path - File path to ignore
   * @param duration - How long to ignore (ms)
   */
  ignoreTemporarily(path: string, duration: number): void;

  /**
   * Perform initial scan of vault to build document set.
   */
  performFullScan(): Promise<FileEvent[]>;
}
```

## Implementation

### Using Obsidian Events

Obsidian provides vault events we can hook into:

```typescript
class ObsidianFileWatcher implements FileWatcher {
  private callbacks: ((event: FileEvent) => void)[] = [];
  private ignoredPaths = new Map<string, number>(); // path -> expiry time
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private excludedFolders: Set<string>;

  private readonly DEBOUNCE_MS = 500;

  constructor(
    private vault: Vault,
    private config: FileWatcherConfig
  ) {
    this.excludedFolders = new Set(config.excludedFolders);
  }

  start(): void {
    this.vault.on('create', this.handleCreate.bind(this));
    this.vault.on('modify', this.handleModify.bind(this));
    this.vault.on('delete', this.handleDelete.bind(this));
    this.vault.on('rename', this.handleRename.bind(this));
  }

  stop(): void {
    // Obsidian handles cleanup on plugin unload
    this.debounceTimers.forEach(timer => clearTimeout(timer));
  }

  private handleCreate(file: TAbstractFile): void {
    if (!this.shouldTrack(file)) return;
    this.emitDebounced(file.path, { type: 'create', path: file.path });
  }

  private handleModify(file: TAbstractFile): void {
    if (!this.shouldTrack(file)) return;
    this.emitDebounced(file.path, { type: 'modify', path: file.path });
  }

  private handleDelete(file: TAbstractFile): void {
    if (!this.shouldTrack(file)) return;
    // Deletions are not debounced - emit immediately
    this.emit({ type: 'delete', path: file.path });
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    if (!this.shouldTrack(file)) return;
    this.emit({ type: 'rename', oldPath, newPath: file.path });
  }

  private shouldTrack(file: TAbstractFile): boolean {
    // Only track files (not folders directly - handled via file events)
    if (!(file instanceof TFile)) return false;

    // Check file extension based on config
    if (!this.isTextFile(file)) return false;

    // Check ignore list
    if (this.isIgnored(file.path)) return false;

    // Ignore plugin directory
    if (file.path.startsWith('.obsidian/')) return false;

    // Check excluded folders
    if (this.isExcludedFolder(file.path)) return false;

    return true;
  }

  private isTextFile(file: TFile): boolean {
    // Track all text files (configurable)
    const textExtensions = this.config.textExtensions || [
      'md', 'txt', 'canvas', 'json', 'css', 'js', 'ts'
    ];
    return textExtensions.includes(file.extension);
  }

  private isExcludedFolder(path: string): boolean {
    for (const excluded of this.excludedFolders) {
      if (path.startsWith(excluded + '/') || path === excluded) {
        return true;
      }
    }
    return false;
  }

  private isIgnored(path: string): boolean {
    const expiry = this.ignoredPaths.get(path);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.ignoredPaths.delete(path);
      return false;
    }
    return true;
  }

  ignoreTemporarily(path: string, duration: number): void {
    this.ignoredPaths.set(path, Date.now() + duration);
  }

  private emitDebounced(path: string, event: FileEvent): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      this.emit(event);
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(path, timer);
  }

  private emit(event: FileEvent): void {
    for (const callback of this.callbacks) {
      callback(event);
    }
  }

  onFileEvent(callback: (event: FileEvent) => void): void {
    this.callbacks.push(callback);
  }
}

interface FileWatcherConfig {
  /** Folders to exclude from sync */
  excludedFolders: string[];

  /** File extensions to track (default: all text files) */
  textExtensions?: string[];

  /** Debounce time in ms */
  debounceMs?: number;
}
```

### Full Vault Scan

For initial sync or recovery:

```typescript
async performFullScan(): Promise<FileEvent[]> {
  const events: FileEvent[] = [];
  const files = this.vault.getFiles();

  for (const file of files) {
    if (!this.shouldTrack(file)) continue;
    events.push({ type: 'create', path: file.path });
  }

  return events;
}
```

## Event Processing with Loro

The sync engine processes file events and updates the Loro document:

```typescript
import { LoroDoc, TreeID } from 'loro-crdt';

class SyncEngine {
  private doc: LoroDoc;
  private pathToNodeId = new Map<string, TreeID>();

  constructor(
    private watcher: FileWatcher,
    private storage: StorageAdapter,
    private vault: Vault
  ) {
    this.watcher.onFileEvent(this.handleFileEvent.bind(this));
  }

  async initialize(): Promise<void> {
    this.doc = await this.storage.initialize();
    this.rebuildPathIndex();
  }

  private rebuildPathIndex(): void {
    // Build path -> nodeId lookup from Loro tree
    const files = this.doc.getTree('files');
    const self = this;

    function traverse(parentId: TreeID | null, pathPrefix: string) {
      // Use roots() for root level, children() for nested
      const childIds = parentId === null ? files.roots() : files.children(parentId);
      for (const childId of childIds) {
        const nodeData = files.getMeta(childId);
        const name = nodeData.get('name') as string;
        const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;

        self.pathToNodeId.set(fullPath, childId);

        if (nodeData.get('type') === 'folder') {
          traverse(childId, fullPath);
        }
      }
    }

    traverse(null, '');
  }

  private async handleFileEvent(event: FileEvent): Promise<void> {
    switch (event.type) {
      case 'create':
        await this.handleCreate(event.path);
        break;
      case 'modify':
        await this.handleModify(event.path);
        break;
      case 'delete':
        await this.handleDelete(event.path);
        break;
      case 'rename':
        await this.handleRename(event.oldPath, event.newPath);
        break;
    }
  }

  private async handleCreate(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path) as TFile;
    const content = await this.vault.read(file);

    // Ensure parent folders exist
    const parentId = await this.ensureParentFolders(path);

    // Create file node in Loro tree
    const nodeId = createFile(this.doc, parentId, file.name, content);
    this.pathToNodeId.set(path, nodeId);

    await this.storage.save(this.doc);
  }

  private async handleModify(path: string): Promise<void> {
    const nodeId = this.pathToNodeId.get(path);
    if (!nodeId) {
      // File not tracked yet, treat as create
      await this.handleCreate(path);
      return;
    }

    const file = this.vault.getAbstractFileByPath(path) as TFile;
    const content = await this.vault.read(file);

    // Update content in Loro
    updateFileContent(this.doc, nodeId, content);

    await this.storage.save(this.doc);
  }

  private async handleDelete(path: string): Promise<void> {
    const nodeId = this.pathToNodeId.get(path);
    if (!nodeId) return;

    // Soft delete (tombstone) in Loro
    deleteNode(this.doc, nodeId);
    this.pathToNodeId.delete(path);

    await this.storage.save(this.doc);
  }

  private async handleRename(oldPath: string, newPath: string): Promise<void> {
    const nodeId = this.pathToNodeId.get(oldPath);
    if (!nodeId) {
      // File wasn't tracked, treat as create
      await this.handleCreate(newPath);
      return;
    }

    const oldParent = getParentPath(oldPath);
    const newParent = getParentPath(newPath);
    const oldName = getFileName(oldPath);
    const newName = getFileName(newPath);

    const files = this.doc.getTree('files');
    const nodeData = files.getMeta(nodeId);

    // Check if it's a rename (same folder) or move (different folder)
    if (oldParent !== newParent) {
      // Move to new parent - Loro handles conflicts automatically!
      const newParentId = await this.ensureParentFolders(newPath);
      files.mov(nodeId, newParentId);
    }

    // Update name if changed
    if (oldName !== newName) {
      nodeData.set('name', newName);
    }

    nodeData.set('mtime', Date.now());

    // Update path index
    this.pathToNodeId.delete(oldPath);
    this.pathToNodeId.set(newPath, nodeId);

    await this.storage.save(this.doc);
  }

  private async ensureParentFolders(filePath: string): Promise<TreeID | null> {
    const parts = filePath.split('/');
    parts.pop(); // Remove filename

    if (parts.length === 0) {
      return null; // Root level
    }

    let currentPath = '';
    let parentId: TreeID | null = null;

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let nodeId = this.pathToNodeId.get(currentPath);
      if (!nodeId) {
        // Create folder
        nodeId = createFolder(this.doc, parentId, part);
        this.pathToNodeId.set(currentPath, nodeId);
      }

      parentId = nodeId;
    }

    return parentId;
  }
}

function getParentPath(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? '' : path.substring(0, lastSlash);
}

function getFileName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? path : path.substring(lastSlash + 1);
}
```

## Move and Rename Handling

With Loro's native tree CRDT, move operations are **dramatically simplified**. Loro automatically handles:

- **Cycle detection** - Prevents moving A into B when B is inside A
- **Concurrent moves** - Last-writer-wins with deterministic resolution
- **Orphan prevention** - Files survive even if parent is deleted

### How Loro Handles Concurrent Moves

```
Device A: Move "note.md" to "folder-a/"
Device B: Move "note.md" to "folder-b/"

Loro resolution:
1. Both operations are recorded
2. Last operation (by timestamp/peer ID) wins
3. File ends up in exactly one location
4. No manual conflict resolution needed!
```

### Folder Moves

When a folder is moved/renamed, Loro automatically moves all children:

```typescript
// Moving a folder moves all its contents automatically
const folderId = this.pathToNodeId.get('old-folder');
const newParentId = this.pathToNodeId.get('new-location');

// Single operation - Loro handles descendants
files.mov(folderId, newParentId);

// Update path index for all descendants
this.rebuildPathIndex();
```

### Concurrent Move + Edit

When one device edits a file while another moves it:

```typescript
/**
 * Loro keeps content and tree structure separate.
 * - Content (LoroText) merges independently
 * - Tree position (LoroTree) resolves move conflicts
 *
 * Result: Content is preserved at the resolved location.
 */

// Example scenario:
// Device A: Edit "notes/todo.md" content
// Device B: Move "notes/todo.md" to "archive/todo.md"

// After sync:
// - File is at "archive/todo.md" (move applied)
// - Content includes Device A's edits (content merged)
```

## Preventing Sync Loops

When sync writes a file from a remote change, we must not re-sync it:

```typescript
class SyncEngine {
  async writeToFilesystem(path: string, content: string): Promise<void> {
    // Ignore events for this file for 2 seconds
    this.watcher.ignoreTemporarily(path, 2000);

    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
    } else {
      // Ensure parent folders exist in filesystem
      await this.ensureFilesystemFolders(path);
      await this.vault.create(path, content);
    }
  }

  private async ensureFilesystemFolders(path: string): Promise<void> {
    const parts = path.split('/');
    parts.pop(); // Remove filename

    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!this.vault.getAbstractFileByPath(currentPath)) {
        await this.vault.createFolder(currentPath);
      }
    }
  }
}
```

## Subscribing to Loro Changes

Listen to Loro document changes for bidirectional sync:

```typescript
class SyncEngine {
  private setupLoroSubscription(): void {
    // Subscribe to all changes in the Loro document
    this.doc.subscribe((event) => {
      // Filter for remote changes (not from this peer)
      if (event.origin === 'local') return;

      this.handleRemoteChanges(event);
    });
  }

  private async handleRemoteChanges(event: LoroEvent): void {
    // Process tree changes (creates, moves, deletes)
    for (const diff of event.diff.tree || []) {
      await this.syncTreeChangeToFilesystem(diff);
    }

    // Process content changes
    for (const [containerId, diff] of Object.entries(event.diff)) {
      if (containerId.startsWith('content:')) {
        await this.syncContentChangeToFilesystem(containerId, diff);
      }
    }
  }

  private async syncTreeChangeToFilesystem(diff: TreeDiff): void {
    const nodeId = diff.target;
    const nodeData = this.doc.getTree('files').getMeta(nodeId);
    const path = getNodePath(this.doc, nodeId);

    if (diff.action === 'create' && nodeData.get('type') === 'file') {
      await this.writeToFilesystem(path, serializeFile(nodeData));
    } else if (diff.action === 'delete' || nodeData.get('deleted')) {
      await this.deleteFromFilesystem(path);
    } else if (diff.action === 'move') {
      await this.moveOnFilesystem(diff.oldPath, path);
    }
  }
}
```

## Case Sensitivity Handling

Different operating systems have different file path case sensitivity rules. PeerVault must handle this to avoid data loss and sync issues.

### Platform Behavior

| Platform | Case Sensitivity | Example |
|----------|------------------|---------|
| macOS (HFS+/APFS) | Case-insensitive, case-preserving | `Note.md` = `note.md` |
| Windows (NTFS) | Case-insensitive, case-preserving | `Note.md` = `note.md` |
| Linux (ext4) | Case-sensitive | `Note.md` ≠ `note.md` |
| iOS | Case-insensitive | `Note.md` = `note.md` |
| Android | Case-sensitive (usually) | Depends on filesystem |

### The Problem

```
Peer A (macOS): Creates "Daily Notes/2024-01-15.md"
Peer B (Linux): Creates "daily notes/2024-01-15.md"

When synced:
- On macOS: Files conflict (same file, different name)
- On Linux: Both files exist (different paths)
```

### Solution: Canonical Path Normalization

```typescript
/**
 * Normalize paths for comparison and storage.
 * We use lowercase paths as the canonical form for CRDT storage.
 */
class PathNormalizer {
  /**
   * Get canonical path for CRDT storage.
   * This is case-insensitive to ensure cross-platform compatibility.
   */
  toCanonical(path: string): string {
    // Normalize to lowercase for case-insensitive matching
    return path.toLowerCase();
  }

  /**
   * Get display path (preserves original case).
   * Stored separately in node metadata.
   */
  toDisplay(path: string): string {
    return path;
  }

  /**
   * Check if two paths refer to the same file (cross-platform).
   */
  pathsEqual(a: string, b: string): boolean {
    return this.toCanonical(a) === this.toCanonical(b);
  }
}
```

### Node Metadata Extension

```typescript
interface FileNodeMeta {
  // ... existing fields

  /** Canonical path (lowercase, for matching) */
  canonicalPath: string;

  /** Display path (preserves original case) */
  displayPath: string;

  /** Platform where file was created */
  createdOnPlatform: 'windows' | 'macos' | 'linux' | 'ios' | 'android';
}
```

### Conflict Detection

```typescript
class CaseSensitivityHandler {
  private pathIndex = new Map<string, TreeID>(); // canonical -> nodeId

  /**
   * Check for case conflicts before creating a file.
   */
  checkForConflict(displayPath: string): CaseConflict | null {
    const canonical = this.normalizer.toCanonical(displayPath);
    const existingId = this.pathIndex.get(canonical);

    if (existingId) {
      const existingMeta = this.tree.getMeta(existingId);
      const existingDisplay = existingMeta.get('displayPath');

      // Same canonical path but different display path = case conflict
      if (existingDisplay !== displayPath) {
        return {
          type: 'case-conflict',
          existingPath: existingDisplay,
          newPath: displayPath,
          canonical,
          nodeId: existingId,
        };
      }
    }

    return null;
  }

  /**
   * Handle case conflict during sync from case-sensitive to case-insensitive platform.
   *
   * Scenario: Linux has both `README.md` and `readme.md`, syncing to macOS.
   * We cannot have both files on macOS - must resolve.
   */
  resolveConflict(
    conflict: CaseConflict,
    incomingNodeId: TreeID,
    strategy: CaseConflictStrategy = 'merge-content'
  ): ConflictResolution {
    const existingMeta = this.tree.getMeta(conflict.nodeId);
    const incomingMeta = this.tree.getMeta(incomingNodeId);

    switch (strategy) {
      case 'merge-content':
        // Use Loro to merge content from both files
        return this.mergeContentResolution(conflict, incomingNodeId);

      case 'rename-incoming':
        // Keep both files, rename incoming to avoid conflict
        return this.renameIncomingResolution(conflict, incomingNodeId);

      case 'keep-newer':
        // Keep file with more recent mtime, discard other
        return this.keepNewerResolution(conflict, existingMeta, incomingMeta, incomingNodeId);

      default:
        return this.mergeContentResolution(conflict, incomingNodeId);
    }
  }

  /**
   * Merge content from conflicting files using Loro CRDT.
   * Both file contents are preserved through CRDT merge.
   */
  private mergeContentResolution(conflict: CaseConflict, incomingNodeId: TreeID): ConflictResolution {
    const existingMeta = this.tree.getMeta(conflict.nodeId);
    const incomingMeta = this.tree.getMeta(incomingNodeId);

    const existingContent = existingMeta.getContainer('content') as LoroText;
    const incomingContent = incomingMeta.getContainer('content') as LoroText;

    // Loro merges the content - if they have common history, it's a proper merge
    // If no common history (independently created), content is concatenated with separator
    const hasCommonHistory = this.checkCommonHistory(conflict.nodeId, incomingNodeId);

    if (!hasCommonHistory) {
      // No common history - files were created independently
      // Append incoming content with clear separator
      const separator = `\n\n---\n\n<!-- Content merged from "${conflict.newPath}" (case conflict) -->\n\n`;
      existingContent.insert(existingContent.toString().length, separator);
      existingContent.insert(existingContent.toString().length, incomingContent.toString());
    }
    // If common history exists, Loro handles merge automatically

    // Mark incoming node as deleted (merged into existing)
    incomingMeta.set('deleted', true);
    incomingMeta.set('deletedReason', 'case-conflict-merged');
    incomingMeta.set('mergedInto', conflict.nodeId.toString());

    return {
      action: 'merge-into-existing',
      targetNodeId: conflict.nodeId,
      deletedNodeId: incomingNodeId,
      hadCommonHistory: hasCommonHistory,
      message: hasCommonHistory
        ? `Case conflict resolved: "${conflict.newPath}" merged into "${conflict.existingPath}"`
        : `Case conflict: content from "${conflict.newPath}" appended to "${conflict.existingPath}"`,
    };
  }

  /**
   * Rename incoming file to avoid conflict.
   * Preserves both files with distinct names.
   */
  private renameIncomingResolution(conflict: CaseConflict, incomingNodeId: TreeID): ConflictResolution {
    const incomingMeta = this.tree.getMeta(incomingNodeId);
    const originalName = incomingMeta.get('name') as string;

    // Generate unique name: "readme.md" -> "readme (case conflict).md"
    const ext = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '';
    const baseName = originalName.includes('.') ? originalName.slice(0, originalName.lastIndexOf('.')) : originalName;
    const newName = `${baseName} (case conflict)${ext}`;

    incomingMeta.set('name', newName);

    return {
      action: 'rename-incoming',
      targetNodeId: conflict.nodeId,
      renamedNodeId: incomingNodeId,
      originalName,
      newName,
      message: `Case conflict: "${conflict.newPath}" renamed to "${newName}"`,
    };
  }

  /**
   * Keep the newer file, delete the older one.
   */
  private keepNewerResolution(
    conflict: CaseConflict,
    existingMeta: LoroMap,
    incomingMeta: LoroMap,
    incomingNodeId: TreeID
  ): ConflictResolution {
    const existingMtime = existingMeta.get('mtime') as number;
    const incomingMtime = incomingMeta.get('mtime') as number;

    if (incomingMtime > existingMtime) {
      // Incoming is newer - replace existing content
      const existingContent = existingMeta.getContainer('content') as LoroText;
      const incomingContent = incomingMeta.getContainer('content') as LoroText;

      // Clear existing and copy incoming content
      existingContent.delete(0, existingContent.toString().length);
      existingContent.insert(0, incomingContent.toString());
      existingMeta.set('mtime', incomingMtime);

      // Delete incoming node
      incomingMeta.set('deleted', true);
      incomingMeta.set('deletedReason', 'case-conflict-superseded');

      return {
        action: 'replace-existing',
        targetNodeId: conflict.nodeId,
        deletedNodeId: incomingNodeId,
        keptPath: conflict.existingPath,
        message: `Case conflict: kept newer "${conflict.newPath}", discarded "${conflict.existingPath}"`,
      };
    } else {
      // Existing is newer - just delete incoming
      incomingMeta.set('deleted', true);
      incomingMeta.set('deletedReason', 'case-conflict-older');

      return {
        action: 'keep-existing',
        targetNodeId: conflict.nodeId,
        deletedNodeId: incomingNodeId,
        keptPath: conflict.existingPath,
        message: `Case conflict: kept existing "${conflict.existingPath}", discarded "${conflict.newPath}"`,
      };
    }
  }

  private checkCommonHistory(nodeIdA: TreeID, nodeIdB: TreeID): boolean {
    // Check if nodes share any common operations in their history
    // This would be determined by checking if they were ever the same node
    // or if one was created from copying the other
    // For now, assume no common history if they have different node IDs
    return false;
  }

  /**
   * Called when user renames a file with only case change.
   * e.g., "note.md" -> "Note.md"
   */
  handleCaseOnlyRename(oldPath: string, newPath: string): void {
    const nodeId = this.findNodeByCanonical(this.normalizer.toCanonical(oldPath));
    if (!nodeId) return;

    // Update display path only (canonical stays the same)
    const meta = this.tree.getMeta(nodeId);
    meta.set('displayPath', newPath);

    // Platform-specific: ensure filesystem reflects the case
    // On case-insensitive systems, may need to rename through a temp name
    if (Platform.isCaseInsensitive) {
      this.renameThroughTemp(oldPath, newPath);
    }
  }

  /**
   * Rename through a temporary path to change case on case-insensitive systems.
   */
  private async renameThroughTemp(oldPath: string, newPath: string): Promise<void> {
    const tempPath = `${newPath}.peervault-temp-${Date.now()}`;
    await this.vault.adapter.rename(oldPath, tempPath);
    await this.vault.adapter.rename(tempPath, newPath);
  }
}

interface CaseConflict {
  type: 'case-conflict';
  existingPath: string;
  newPath: string;
  canonical: string;
  nodeId: TreeID;
}

type CaseConflictStrategy =
  | 'merge-content'    // Default: merge content using Loro, delete duplicate node
  | 'rename-incoming'  // Keep both files, rename incoming to avoid conflict
  | 'keep-newer';      // Keep newer file, delete older (potential data loss!)

interface ConflictResolution {
  action: 'merge-into-existing' | 'rename-incoming' | 'replace-existing' | 'keep-existing';
  targetNodeId: TreeID;
  deletedNodeId?: TreeID;
  renamedNodeId?: TreeID;
  originalName?: string;
  newName?: string;
  keptPath?: string;
  hadCommonHistory?: boolean;
  message: string;
}

/**
 * User-configurable case conflict settings.
 */
interface CaseConflictSettings {
  /** Default resolution strategy */
  strategy: CaseConflictStrategy;
  /** Show notification on conflict */
  notifyOnConflict: boolean;
  /** Log conflicts for review */
  logConflicts: boolean;
}
```

### UI Notification

```typescript
/**
 * Notify user of case conflicts during sync.
 */
class CaseConflictNotifier {
  notifyConflict(conflict: CaseConflict, resolution: ConflictResolution): void {
    new Notice(
      `Case conflict: "${conflict.newPath}" synced as "${conflict.existingPath}" ` +
      `(platforms have different case sensitivity)`,
      5000
    );
  }
}
```

### Testing Requirements

```typescript
describe('Case sensitivity', () => {
  it('should detect case-only conflicts', () => {
    const handler = new CaseSensitivityHandler(tree);
    handler.addFile('Notes/daily.md');

    const conflict = handler.checkForConflict('Notes/Daily.md');
    expect(conflict).not.toBeNull();
    expect(conflict.type).toBe('case-conflict');
  });

  it('should handle case-only renames', async () => {
    const handler = new CaseSensitivityHandler(tree);
    handler.addFile('note.md');

    await handler.handleCaseOnlyRename('note.md', 'Note.md');

    const meta = tree.getMeta(nodeId);
    expect(meta.get('displayPath')).toBe('Note.md');
    expect(meta.get('canonicalPath')).toBe('note.md');
  });

  it('should sync case changes across platforms', async () => {
    // Simulate macOS peer renaming "note.md" -> "NOTE.md"
    // Linux peer should update display path without creating new file
  });
});
```

### Cross-Platform Sync Behavior

| Action | macOS/Windows | Linux | Result |
|--------|---------------|-------|--------|
| Create `Note.md` | Creates file | Creates file | Synced |
| Peer creates `note.md` | Same file updated | New file created | **Conflict on Linux** |
| Rename `note.md` -> `Note.md` | Case updated | Rename succeeds | Synced (display path) |

### Warning in Documentation

```
⚠️ Case Sensitivity Warning

When syncing between case-sensitive (Linux) and case-insensitive (macOS/Windows)
platforms, avoid creating files that differ only in case:

- "Note.md" and "note.md" will be separate files on Linux
- They will be the same file on macOS/Windows

PeerVault normalizes to lowercase internally to prevent data loss, but this may
result in unexpected file names when syncing from Linux to other platforms.
```

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- Obsidian `Vault` API for file events
- Obsidian `TFile`, `TAbstractFile` types

## Error Handling

| Error | Recovery |
|-------|----------|
| File read fails | Retry once, then skip and log |
| Too many rapid events | Increase debounce, warn user |
| Watcher stops working | Restart watcher, notify user |
| Loro tree inconsistent | Rebuild path index from tree |

## Edge Cases

### Vault Folder Renamed

When user renames the vault folder itself:

```typescript
/**
 * Handle vault root being renamed.
 * Obsidian typically requires restart, so this is mostly handled there.
 */
class VaultRenameHandler {
  private vaultPath: string;

  constructor(vault: Vault) {
    this.vaultPath = vault.adapter.getBasePath();
  }

  /**
   * Check if vault path changed on focus.
   * Called when app regains focus.
   */
  async checkVaultPathChanged(): Promise<void> {
    const currentPath = this.vault.adapter.getBasePath();

    if (currentPath !== this.vaultPath) {
      // Vault was moved/renamed
      console.log(`Vault path changed: ${this.vaultPath} -> ${currentPath}`);

      // Update stored path
      this.vaultPath = currentPath;

      // Update vault ID mapping
      await this.plugin.updateVaultPath(currentPath);

      // Notify user
      new Notice('Vault location changed. Sync continues normally.');
    }
  }
}
```

### Plugin Disable/Re-enable

When plugin is toggled off and back on:

```typescript
/**
 * Handle plugin lifecycle.
 */
class PluginLifecycle {
  /**
   * Called when plugin is disabled.
   */
  async onDisable(): Promise<void> {
    // 1. Flush all pending changes
    await this.syncEngine.flushPendingChanges();

    // 2. Save sync state
    await this.storage.saveState();

    // 3. Disconnect from peers gracefully
    for (const peer of this.peerManager.getConnectedPeers()) {
      peer.connection.send({ type: 'sync-complete' });
      await peer.connection.close();
    }

    // 4. Stop file watcher
    this.watcher.stop();
  }

  /**
   * Called when plugin is re-enabled.
   */
  async onEnable(): Promise<void> {
    // 1. Load saved state
    await this.storage.loadState();

    // 2. Detect changes made while disabled
    const changedFiles = await this.detectOfflineChanges();

    // 3. Start file watcher
    this.watcher.start();

    // 4. Reconnect to auto-connect peers
    await this.peerManager.connectAll();

    // 5. Process offline changes
    for (const file of changedFiles) {
      await this.syncEngine.handleFileEvent({ type: 'modify', path: file.path });
    }
  }

  /**
   * Detect files changed while plugin was disabled.
   */
  private async detectOfflineChanges(): Promise<TFile[]> {
    const lastSyncTime = await this.storage.getLastSyncTime();
    const changedFiles: TFile[] = [];

    for (const file of this.vault.getMarkdownFiles()) {
      if (file.stat.mtime > lastSyncTime) {
        changedFiles.push(file);
      }
    }

    return changedFiles;
  }
}
```

### File Renamed While Being Synced

```typescript
/**
 * Handle race between rename and sync.
 */
class RenameRaceHandler {
  private pendingSyncs = new Map<string, Promise<void>>();
  private renamedPaths = new Map<string, string>(); // old -> new

  /**
   * Called before sync starts for a file.
   */
  startSync(path: string): void {
    // Track that this file is being synced
    this.pendingSyncs.set(path, this.doSync(path));
  }

  /**
   * Called when file is renamed.
   */
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    // Check if file is being synced
    const pendingSync = this.pendingSyncs.get(oldPath);

    if (pendingSync) {
      // Wait for sync to complete
      await pendingSync;

      // Then handle rename
      this.renamedPaths.set(oldPath, newPath);
    }

    // Emit rename event
    this.emit({ type: 'rename', oldPath, newPath });
  }

  /**
   * Resolve current path for a file.
   * Handles case where file was renamed during operation.
   */
  getCurrentPath(originalPath: string): string {
    return this.renamedPaths.get(originalPath) || originalPath;
  }
}
```

### Concurrent Identical Changes

When two peers make the exact same change simultaneously:

```typescript
/**
 * Loro handles this automatically - identical changes are idempotent.
 * This is just for logging/debugging.
 */
class IdenticalChangeDetector {
  /**
   * Log when identical changes detected.
   * Loro merges correctly, but this helps debugging.
   */
  detectIdenticalChanges(
    localVersion: Uint8Array,
    remoteVersion: Uint8Array
  ): boolean {
    // Compare version vectors
    const localState = VersionVector.fromBytes(localVersion);
    const remoteState = VersionVector.fromBytes(remoteVersion);

    // Check if they result in same state
    // (This is rare but can happen with simultaneous identical edits)
    const isIdentical = localState.equals(remoteState);

    if (isIdentical) {
      console.log('Identical concurrent changes detected - no merge needed');
    }

    return isIdentical;
  }
}
```

### Large Batch Operations

When user pastes many files or uses templater to create multiple files:

```typescript
/**
 * Handle rapid creation of many files.
 */
class BatchOperationHandler {
  private batchQueue: FileEvent[] = [];
  private batchTimeout: NodeJS.Timeout | null = null;
  private readonly BATCH_WINDOW_MS = 2000;
  private readonly BATCH_THRESHOLD = 10;

  /**
   * Queue event for potential batching.
   */
  queueEvent(event: FileEvent): void {
    this.batchQueue.push(event);

    // Reset timeout
    if (this.batchTimeout) clearTimeout(this.batchTimeout);

    this.batchTimeout = setTimeout(() => {
      this.processBatch();
    }, this.BATCH_WINDOW_MS);

    // Process immediately if batch is large
    if (this.batchQueue.length >= this.BATCH_THRESHOLD) {
      clearTimeout(this.batchTimeout);
      this.processBatch();
    }
  }

  private async processBatch(): Promise<void> {
    const batch = this.batchQueue;
    this.batchQueue = [];

    if (batch.length === 0) return;

    // Process in single transaction for efficiency
    this.doc.transact(() => {
      for (const event of batch) {
        this.processEvent(event);
      }
    });

    // Single save after batch
    await this.storage.save(this.doc);
  }
}
```

### File System Full

```typescript
/**
 * Handle disk full scenarios.
 */
class DiskSpaceHandler {
  private readonly MIN_FREE_SPACE_MB = 100;
  private isLowSpace = false;

  /**
   * Check disk space before write operations.
   */
  async checkDiskSpace(): Promise<boolean> {
    const freeSpace = await this.getFreeSpace();

    if (freeSpace < this.MIN_FREE_SPACE_MB * 1024 * 1024) {
      if (!this.isLowSpace) {
        this.isLowSpace = true;
        new Notice(
          'Warning: Low disk space. Sync may fail until space is freed.',
          10000
        );
      }
      return false;
    }

    this.isLowSpace = false;
    return true;
  }

  /**
   * Handle write failure due to disk full.
   */
  async handleDiskFullError(error: Error, path: string): Promise<void> {
    console.error(`Disk full, cannot write: ${path}`, error);

    new Notice(
      `Cannot save changes to ${path} - disk is full.`,
      0 // Don't auto-dismiss
    );

    // Queue for retry
    this.retryQueue.push({ path, retryCount: 0 });
  }
}
```

### Unicode and Special Characters

```typescript
/**
 * Handle files with special characters in names.
 */
class SpecialCharacterHandler {
  private readonly INVALID_CHARS = /[<>:"|?*\x00-\x1f]/g;

  /**
   * Normalize path for cross-platform compatibility.
   */
  normalizePath(path: string): string {
    // Replace invalid characters with underscore
    let normalized = path.replace(this.INVALID_CHARS, '_');

    // Handle leading/trailing spaces (Windows issue)
    const parts = normalized.split('/');
    normalized = parts.map(p => p.trim()).join('/');

    // Handle reserved names on Windows
    normalized = this.handleReservedNames(normalized);

    return normalized;
  }

  private handleReservedNames(path: string): string {
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    const parts = path.split('/');

    return parts.map(part => {
      const name = part.replace(/\.[^/.]+$/, ''); // Remove extension
      if (reserved.test(name)) {
        return '_' + part;
      }
      return part;
    }).join('/');
  }

  /**
   * Check if path has platform-specific issues.
   */
  validatePath(path: string, platform: 'windows' | 'mac' | 'linux'): ValidationResult {
    const issues: string[] = [];

    if (path.length > 260 && platform === 'windows') {
      issues.push('Path too long for Windows (max 260 characters)');
    }

    if (this.INVALID_CHARS.test(path)) {
      issues.push('Contains invalid characters');
    }

    return {
      valid: issues.length === 0,
      issues,
      normalized: this.normalizePath(path),
    };
  }
}
```

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Excluded folders | Yes, allow folder exclusions | Users can configure folders to skip in settings (e.g., templates/, archive/). |
| File type filtering | All text files | Sync any text-based file, not just .md. Maximum flexibility for different workflows. |
| Symlinks | Ignore symlinks | Skip symbolic links entirely. Avoids loops and accidentally syncing files outside vault. |
| Move conflict handling | Loro native | Loro's LoroTree handles all move conflicts automatically with cycle detection. |
| Large batch handling | Queue + batch | Queue rapid operations and process in batches for efficiency. |
| Special characters | Normalize paths | Replace invalid characters and normalize for cross-platform compatibility. |
