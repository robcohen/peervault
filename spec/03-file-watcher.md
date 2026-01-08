# File Watcher Spec

## Purpose

Monitor the Obsidian vault for file changes and propagate them to Automerge documents. This bridges the filesystem and CRDT layers.

## Requirements

- **REQ-FW-01**: MUST detect file creation, modification, deletion, and rename
- **REQ-FW-02**: MUST debounce rapid changes to avoid excessive updates
- **REQ-FW-03**: MUST ignore non-markdown files (configurable)
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

  private readonly DEBOUNCE_MS = 500;

  constructor(private vault: Vault) {}

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
    // Only track markdown files
    if (!(file instanceof TFile)) return false;
    if (file.extension !== 'md') return false;

    // Check ignore list
    if (this.isIgnored(file.path)) return false;

    // Ignore plugin directory
    if (file.path.startsWith('.obsidian/')) return false;

    return true;
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
}
```

### Full Vault Scan

For initial sync or recovery:

```typescript
async performFullScan(): Promise<FileEvent[]> {
  const events: FileEvent[] = [];
  const files = this.vault.getMarkdownFiles();

  for (const file of files) {
    if (file.path.startsWith('.obsidian/')) continue;
    events.push({ type: 'create', path: file.path });
  }

  return events;
}
```

## Event Processing

The sync engine processes file events:

```typescript
class SyncEngine {
  constructor(
    private watcher: FileWatcher,
    private docManager: DocumentManager,
    private storage: StorageAdapter
  ) {
    this.watcher.onFileEvent(this.handleFileEvent.bind(this));
  }

  private async handleFileEvent(event: FileEvent): Promise<void> {
    switch (event.type) {
      case 'create':
      case 'modify':
        await this.syncFileToDoc(event.path);
        break;
      case 'delete':
        await this.tombstoneDoc(event.path);
        break;
      case 'rename':
        await this.handleRename(event.oldPath, event.newPath);
        break;
    }
  }

  private async syncFileToDoc(path: string): Promise<void> {
    const content = await this.vault.read(
      this.vault.getAbstractFileByPath(path) as TFile
    );
    await this.docManager.updateOrCreate(path, content);
  }
}
```

## Preventing Sync Loops

When sync writes a file from a remote change, we must not re-sync it:

```typescript
async writeFromSync(path: string, content: string): Promise<void> {
  // Ignore events for this file for 2 seconds
  this.watcher.ignoreTemporarily(path, 2000);

  const file = this.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    await this.vault.modify(file, content);
  } else {
    await this.vault.create(path, content);
  }
}
```

## Dependencies

- Obsidian `Vault` API for file events
- Obsidian `TFile`, `TAbstractFile` types

## Error Handling

| Error | Recovery |
|-------|----------|
| File read fails | Retry once, then skip and log |
| Too many rapid events | Increase debounce, warn user |
| Watcher stops working | Restart watcher, notify user |

## Open Questions

1. **Excluded folders**: Should users be able to exclude folders from sync?
2. **File type filtering**: Support other files like `.canvas`, `.json`?
3. **Symlinks**: Follow symlinks or ignore them?
