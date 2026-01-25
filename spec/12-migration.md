# Migration Strategy Spec

## Purpose

Define how PeerVault handles schema changes, version upgrades, and data migrations to ensure backward compatibility and smooth updates.

## Requirements

- **REQ-MIG-01**: Schema changes MUST NOT cause data loss
- **REQ-MIG-02**: Migrations MUST be automatic on plugin update
- **REQ-MIG-03**: Peers with different versions MUST negotiate compatibility
- **REQ-MIG-04**: Rollback MUST be possible for failed migrations
- **REQ-MIG-05**: Migration progress MUST be visible to users

## Version Schema

### Versioned Components

| Component | Current Version | Location |
|-----------|-----------------|----------|
| Plugin | 1.0.0 | manifest.json |
| Storage schema | 1 | meta.json |
| Sync protocol | 1 | ALPN identifier |
| VaultIndex schema | 1 | Inside document |
| FileDoc schema | 1 | Inside document |

### Version Format

```typescript
interface VersionInfo {
  /** Plugin version (semver) */
  plugin: string;

  /** Storage schema version (integer) */
  storage: number;

  /** Sync protocol version (integer) */
  protocol: number;

  /** Document schema version (integer) */
  schema: number;
}

// Current versions
const CURRENT_VERSIONS: VersionInfo = {
  plugin: '1.0.0',
  storage: 1,
  protocol: 1,
  schema: 1,
};
```

## Storage Migrations

### Migration Registry

```typescript
interface Migration {
  /** Version this migration upgrades FROM */
  fromVersion: number;

  /** Version this migration upgrades TO */
  toVersion: number;

  /** Human-readable description */
  description: string;

  /** Migration function */
  migrate: (storage: StorageAdapter) => Promise<void>;

  /** Rollback function (best effort) */
  rollback?: (storage: StorageAdapter) => Promise<void>;
}

const STORAGE_MIGRATIONS: Migration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Add checksum to stored documents',
    migrate: async (storage) => {
      // Example: add checksums to all .crdt files
      const docIds = await storage.listDocs();
      for (const docId of docIds) {
        const doc = await storage.loadDoc(docId);
        const checksum = computeChecksum(doc);
        await storage.saveDocWithChecksum(docId, doc, checksum);
      }
    },
    rollback: async (storage) => {
      // Remove checksum metadata
    },
  },
];
```

### Migration Runner

```typescript
class MigrationRunner {
  constructor(
    private storage: StorageAdapter,
    private migrations: Migration[],
  ) {}

  async run(): Promise<MigrationResult> {
    const currentVersion = await this.storage.getSchemaVersion();
    const targetVersion = Math.max(...this.migrations.map(m => m.toVersion));

    if (currentVersion >= targetVersion) {
      return { status: 'up-to-date', fromVersion: currentVersion };
    }

    // Find migration path
    const path = this.findMigrationPath(currentVersion, targetVersion);
    if (!path) {
      throw new Error(`No migration path from v${currentVersion} to v${targetVersion}`);
    }

    // Create backup before migration
    await this.createBackup(currentVersion);

    // Run migrations in sequence
    const result: MigrationResult = {
      status: 'success',
      fromVersion: currentVersion,
      toVersion: targetVersion,
      migrationsRun: [],
    };

    try {
      for (const migration of path) {
        console.log(`Running migration: ${migration.description}`);
        await migration.migrate(this.storage);
        await this.storage.setSchemaVersion(migration.toVersion);
        result.migrationsRun.push(migration.description);
      }
    } catch (error) {
      result.status = 'failed';
      result.error = error.message;

      // Attempt rollback
      await this.attemptRollback(path, result.migrationsRun.length);
    }

    return result;
  }

  private findMigrationPath(from: number, to: number): Migration[] | null {
    const path: Migration[] = [];
    let current = from;

    while (current < to) {
      const next = this.migrations.find(m => m.fromVersion === current);
      if (!next) return null;
      path.push(next);
      current = next.toVersion;
    }

    return path;
  }

  private async createBackup(version: number): Promise<void> {
    const backupPath = `${this.storage.basePath}/backup-v${version}-${Date.now()}`;
    await this.storage.copyTo(backupPath);
  }

  private async attemptRollback(
    path: Migration[],
    completedCount: number,
  ): Promise<void> {
    // Rollback in reverse order
    for (let i = completedCount - 1; i >= 0; i--) {
      const migration = path[i];
      if (migration.rollback) {
        try {
          await migration.rollback(this.storage);
        } catch (e) {
          console.error(`Rollback failed for: ${migration.description}`);
        }
      }
    }
  }
}
```

## Document Schema Migrations

Loro documents may need schema evolution as features are added.

### Schema Version in Documents

```typescript
import { LoroDoc, LoroMap } from 'loro-crdt';

// Schema version is stored in the meta map
interface VaultMeta {
  vaultId: string;
  name: string;
  version: number;  // Schema version
  createdAt: number;
}

// Version history:
// v1: Initial schema - LoroTree files, LoroText content, LoroMap frontmatter
// v2: (future) Add tags container, binary file references
```

### Document Migration

```typescript
import { LoroDoc } from 'loro-crdt';

const CURRENT_SCHEMA_VERSION = 1;

function migrateLoroDoc(doc: LoroDoc): LoroDoc {
  const meta = doc.getMap('meta');
  const version = (meta.get('version') as number) ?? 1;

  if (version === CURRENT_SCHEMA_VERSION) {
    return doc;
  }

  // Migrate through each version
  doc.transact(() => {
    if (version < 2) {
      // Example: v1 -> v2 migration
      // Add new containers or transform existing data

      // Initialize new tags container if not exists
      // const tags = doc.getList('tags');

      // Update version
      meta.set('version', 2);
    }

    // Future migrations...
  });

  return doc;
}

/**
 * Validate document has required structure after migration.
 */
function validateLoroDoc(doc: LoroDoc): boolean {
  try {
    const meta = doc.getMap('meta');
    const files = doc.getTree('files');

    // Check required fields
    if (!meta.get('vaultId')) return false;
    if (!meta.get('version')) return false;

    // Files tree should exist
    if (!files) return false;

    return true;
  } catch {
    return false;
  }
}
```

## Protocol Version Negotiation

When peers connect, they must agree on protocol version:

### ALPN-Based Versioning

```typescript
// Protocol versions as ALPNs
const PROTOCOL_ALPNS = [
  'peervault/sync/1',  // v1 protocol
  // 'peervault/sync/2',  // Future
];

// Endpoint advertises supported protocols
const endpoint = await Endpoint.create({
  alpns: PROTOCOL_ALPNS,
});
```

### Version Handshake

```
┌─────────────────────────────────────────────────────────────┐
│                  Protocol Negotiation                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Peer A (v1, v2)              Peer B (v1)                   │
│       │                            │                         │
│       │ ─── Connect with v2 ────►  │                         │
│       │                            │ (doesn't support v2)    │
│       │ ◄── Reject, offer v1 ────  │                         │
│       │                            │                         │
│       │ ─── Connect with v1 ────►  │                         │
│       │                            │                         │
│       │ ◄─── Accept ─────────────  │                         │
│       │                            │                         │
│       │ ════ Sync using v1 ══════  │                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
class ProtocolNegotiator {
  private readonly supportedVersions = [1]; // Add versions as implemented

  async negotiate(connection: IrohConnection): Promise<number> {
    // Send our supported versions
    await connection.send({
      type: 'version-offer',
      versions: this.supportedVersions,
    });

    // Receive peer's supported versions
    const response = await connection.receive();
    if (response.type !== 'version-offer') {
      throw new Error('Expected version offer');
    }

    // Find highest common version
    const commonVersions = this.supportedVersions.filter(
      v => response.versions.includes(v)
    );

    if (commonVersions.length === 0) {
      throw new Error('No compatible protocol version');
    }

    const selectedVersion = Math.max(...commonVersions);

    // Confirm selection
    await connection.send({
      type: 'version-select',
      version: selectedVersion,
    });

    return selectedVersion;
  }
}
```

## User Communication

### Migration UI

```typescript
class MigrationModal extends Modal {
  constructor(
    app: App,
    private migration: MigrationProgress,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Updating PeerVault' });

    contentEl.createEl('p', {
      text: 'Please wait while your sync data is updated to the new format.',
    });

    // Progress bar
    const progress = contentEl.createEl('progress', {
      attr: { max: '100', value: '0' },
    });

    // Status text
    const status = contentEl.createEl('p', { cls: 'migration-status' });

    // Update progress
    this.migration.onProgress((percent, message) => {
      progress.value = percent;
      status.setText(message);
    });

    // Close when done
    this.migration.onComplete(() => {
      this.close();
      new Notice('PeerVault update complete!');
    });

    // Handle errors
    this.migration.onError((error) => {
      status.setText(`Error: ${error}`);
      status.addClass('migration-error');
    });
  }
}
```

### Version Mismatch Warning

```typescript
function showVersionMismatchWarning(
  localVersion: number,
  peerVersion: number,
  peerName: string,
): void {
  const modal = new Modal(app);

  modal.contentEl.createEl('h2', { text: 'Version Mismatch' });

  modal.contentEl.createEl('p', {
    text: `${peerName} is using a different version of PeerVault.`,
  });

  if (peerVersion > localVersion) {
    modal.contentEl.createEl('p', {
      text: 'Please update your plugin to continue syncing.',
    });
  } else {
    modal.contentEl.createEl('p', {
      text: 'Ask them to update their plugin, or sync may be limited.',
    });
  }

  modal.open();
}
```

## Backup Strategy

### Automatic Backups

```typescript
class BackupManager {
  private readonly MAX_BACKUPS = 5;

  async createBackup(reason: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}-${reason}`;
    const backupPath = `${this.basePath}/backups/${backupName}`;

    // Copy all sync data
    await this.copyDirectory(
      `${this.basePath}/sync`,
      backupPath,
    );

    // Write backup metadata
    await this.writeJson(`${backupPath}/backup.json`, {
      created: new Date().toISOString(),
      reason,
      pluginVersion: this.pluginVersion,
      schemaVersion: this.schemaVersion,
    });

    // Prune old backups
    await this.pruneOldBackups();

    return backupPath;
  }

  async restoreBackup(backupPath: string): Promise<void> {
    // Verify backup integrity
    const meta = await this.readJson(`${backupPath}/backup.json`);
    if (!meta) {
      throw new Error('Invalid backup: missing metadata');
    }

    // Create backup of current state first
    await this.createBackup('pre-restore');

    // Restore backup
    await this.copyDirectory(backupPath, `${this.basePath}/sync`);
  }

  private async pruneOldBackups(): Promise<void> {
    const backups = await this.listBackups();

    if (backups.length > this.MAX_BACKUPS) {
      // Sort by date, remove oldest
      backups.sort((a, b) => a.created.localeCompare(b.created));
      const toRemove = backups.slice(0, backups.length - this.MAX_BACKUPS);

      for (const backup of toRemove) {
        await this.removeDirectory(backup.path);
      }
    }
  }
}
```

### Backup Triggers

| Event | Backup? | Reason |
|-------|---------|--------|
| Before migration | Yes | `pre-migration` |
| Before restore | Yes | `pre-restore` |
| Weekly (if syncing) | Yes | `weekly` |
| Before peer removal | No | Low risk |
| On user request | Yes | `manual` |

## Testing Migrations

```typescript
import { LoroDoc } from 'loro-crdt';

describe('Storage Migrations', () => {
  it('migrates v1 Loro doc to v2', async () => {
    // Create v1 storage with Loro doc
    const storage = await createTestStorage(1);
    const v1Doc = createV1LoroDoc();
    await storage.save(v1Doc);

    // Run migration
    const runner = new MigrationRunner(storage, STORAGE_MIGRATIONS);
    const result = await runner.run();

    expect(result.status).toBe('success');
    expect(await storage.getSchemaVersion()).toBe(2);

    // Verify data integrity
    const doc = await storage.load();
    const meta = doc.getMap('meta');
    expect(meta.get('version')).toBe(2);

    // Original content preserved
    const content = getFileContent(doc, 'test.md');
    expect(content).toBe('original content');
  });

  it('rolls back on failure', async () => {
    const storage = await createTestStorage(1);
    const doc = createV1LoroDoc();
    await storage.save(doc);

    // Add a failing migration
    const badMigration: Migration = {
      fromVersion: 1,
      toVersion: 2,
      description: 'Failing migration',
      migrate: async () => { throw new Error('Simulated failure'); },
      rollback: async () => { /* restore from checkpoint */ },
    };

    const runner = new MigrationRunner(storage, [badMigration]);
    const result = await runner.run();

    expect(result.status).toBe('failed');
    // Should still be at v1
    expect(await storage.getSchemaVersion()).toBe(1);
  });

  it('handles peer version mismatch gracefully', async () => {
    const peer1 = createTestPeer({ protocolVersion: 1 });
    const peer2 = createTestPeer({ protocolVersion: 2 });

    // Should negotiate to common version (v1)
    const version = await peer1.negotiateWith(peer2);
    expect(version).toBe(1);
  });

  it('preserves Loro version vectors during migration', async () => {
    const storage = await createTestStorage(1);
    const doc = createV1LoroDoc();

    // Record version before migration
    const versionBefore = doc.version();

    await storage.save(doc);
    const runner = new MigrationRunner(storage, STORAGE_MIGRATIONS);
    await runner.run();

    // Load migrated doc
    const migrated = await storage.load();

    // Version vector should be compatible (can still sync with old peers)
    // Note: Migration creates new operations, so version will advance
    const canMerge = () => {
      const testDoc = new LoroDoc();
      testDoc.import(doc.export({ mode: 'snapshot' }));
      testDoc.import(migrated.export({ mode: 'update', from: versionBefore }));
      return true;
    };

    expect(canMerge()).toBe(true);
  });
});
```

## Migration Checklist for Developers

When adding a breaking change:

1. [ ] Increment relevant version number
2. [ ] Write migration function
3. [ ] Write rollback function (if possible)
4. [ ] Add migration tests
5. [ ] Test upgrade from previous release
6. [ ] Test peer compatibility (old ↔ new)
7. [ ] Update documentation
8. [ ] Add changelog entry

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- File system operations for backup/restore
- Loro for document migrations
- Obsidian Modal API for user communication
