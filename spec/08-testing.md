# Testing Strategy Spec

## Purpose

Define the testing approach for PeerVault, including unit tests, integration tests, end-to-end tests, and test fixtures.

## Requirements

- **REQ-TS-01**: All core logic MUST have unit test coverage >80%
- **REQ-TS-02**: Sync protocol MUST be tested with simulated network conditions
- **REQ-TS-03**: Tests MUST run without real Obsidian instance where possible
- **REQ-TS-04**: E2E tests MUST cover critical user flows
- **REQ-TS-05**: Tests MUST be deterministic (no flaky tests)

## Test Pyramid

```
                    ┌───────────┐
                    │   E2E     │  Few, slow, high confidence
                    │  Tests    │
                   ┌┴───────────┴┐
                   │ Integration  │  Some, medium speed
                   │    Tests     │
                  ┌┴──────────────┴┐
                  │   Unit Tests    │  Many, fast, isolated
                  └────────────────┘
```

## Test Categories

### 1. Unit Tests

Test individual functions and classes in isolation.

**Scope:**
- Loro document operations (create, update, delete)
- LoroTree hierarchy operations
- LoroText content operations
- Version vector handling
- Sync message serialization
- Ticket parsing

**Framework:** Vitest or Jest

```typescript
import { LoroDoc, LoroTree, LoroText, LoroMap } from 'loro-crdt';

// Example: Vault document creation
describe('createVaultDoc', () => {
  it('creates document with correct structure', () => {
    const doc = createVaultDoc('vault-123', 'My Vault');

    const meta = doc.getMap('meta');
    expect(meta.get('vaultId')).toBe('vault-123');
    expect(meta.get('name')).toBe('My Vault');
    expect(meta.get('version')).toBe(1);

    const files = doc.getTree('files');
    expect(files).toBeDefined();
  });

  it('generates unique peer IDs', () => {
    const doc1 = createVaultDoc('vault-1', 'Vault 1');
    const doc2 = createVaultDoc('vault-2', 'Vault 2');

    expect(doc1.peerId).not.toBe(doc2.peerId);
  });
});
```

```typescript
// Example: Loro text operations with Fugue
describe('updateFileContent', () => {
  it('applies insertions correctly', () => {
    const doc = new LoroDoc();
    const files = doc.getTree('files');
    const nodeId = createFile(doc, null, 'test.md', 'Hello world');

    updateFileContent(doc, nodeId, 'Hello brave world');

    const nodeData = files.getMeta(nodeId);
    const content = nodeData.get('content') as LoroText;
    expect(content.toString()).toBe('Hello brave world');
  });

  it('applies deletions correctly', () => {
    const doc = new LoroDoc();
    const nodeId = createFile(doc, null, 'test.md', 'Hello world');

    updateFileContent(doc, nodeId, 'Hello');

    const content = getFileContent(doc, nodeId);
    expect(content).toBe('Hello');
  });

  it('preserves concurrent edits (Fugue merge)', () => {
    // Create base document
    const doc1 = new LoroDoc();
    const nodeId = createFile(doc1, null, 'test.md', 'Hello world');

    // Fork: export and import to second doc
    const doc2 = new LoroDoc();
    doc2.import(doc1.export({ mode: 'snapshot' }));

    // Concurrent edits
    updateFileContent(doc1, nodeId, 'Hello brave world');
    updateFileContent(doc2, nodeId, 'Hello new world');

    // Merge: import updates from doc2 into doc1
    const updates = doc2.export({ mode: 'update', from: doc1.version() });
    doc1.import(updates);

    // Fugue algorithm preserves both insertions
    const content = getFileContent(doc1, nodeId);
    expect(content).toContain('brave');
    expect(content).toContain('new');
    // Order is deterministic based on peer IDs
  });
});
```

```typescript
// Example: LoroTree file hierarchy operations
describe('LoroTree operations', () => {
  it('creates nested folder structure', () => {
    const doc = createVaultDoc('test', 'Test');

    const folderId = createFolder(doc, null, 'Notes');
    const subFolderId = createFolder(doc, folderId, 'Daily');
    const fileId = createFile(doc, subFolderId, '2024-01-15.md', '# Today');

    const path = getNodePath(doc, fileId);
    expect(path).toBe('Notes/Daily/2024-01-15.md');
  });

  it('handles move operations', () => {
    const doc = createVaultDoc('test', 'Test');

    const folder1 = createFolder(doc, null, 'folder-a');
    const folder2 = createFolder(doc, null, 'folder-b');
    const fileId = createFile(doc, folder1, 'note.md', 'content');

    // Move file to different folder
    const files = doc.getTree('files');
    files.mov(fileId, folder2);

    const newPath = getNodePath(doc, fileId);
    expect(newPath).toBe('folder-b/note.md');
  });

  it('handles concurrent moves (last-writer-wins)', () => {
    const doc1 = createVaultDoc('test', 'Test');
    const folderA = createFolder(doc1, null, 'folder-a');
    const folderB = createFolder(doc1, null, 'folder-b');
    const fileId = createFile(doc1, null, 'note.md', 'content');

    // Fork
    const doc2 = new LoroDoc();
    doc2.import(doc1.export({ mode: 'snapshot' }));

    // Concurrent moves
    doc1.getTree('files').mov(fileId, folderA);
    doc2.getTree('files').mov(fileId, folderB);

    // Merge
    doc1.import(doc2.export({ mode: 'update', from: doc1.version() }));

    // File is in exactly one location (deterministic)
    const path = getNodePath(doc1, fileId);
    expect(path === 'folder-a/note.md' || path === 'folder-b/note.md').toBe(true);
  });
});
```

### 2. Integration Tests

Test component interactions with mocked dependencies.

**Scope:**
- FileWatcher + DocumentManager integration
- SyncProtocol + Transport integration
- Storage + DocumentCache integration
- PeerManager + Transport integration

**Mocking Strategy:**

```typescript
// Test Obsidian Vault API
class TestVault {
  private files = new Map<string, string>();
  private eventHandlers = new Map<string, Function[]>();

  async read(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? '';
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.files.set(file.path, content);
    this.emit('modify', file);
  }

  async create(path: string, content: string): Promise<TFile> {
    const file = { path, extension: 'md' } as TFile;
    this.files.set(path, content);
    this.emit('create', file);
    return file;
  }

  on(event: string, handler: Function): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  // Test helper: simulate external file change
  simulateExternalChange(path: string, content: string): void {
    this.files.set(path, content);
    this.emit('modify', { path, extension: 'md' });
  }
}
```

```typescript
// Test Transport - implements Transport interface for testing
// Uses in-memory connections instead of real networking
class TestTransport implements Transport {
  private connections = new Map<string, TestConnection>();
  private incomingHandlers: ((conn: PeerConnection) => void)[] = [];

  async connectWithTicket(ticket: string): Promise<PeerConnection> {
    const peerId = this.extractPeerId(ticket);
    const conn = new TestConnection(peerId);
    this.connections.set(peerId, conn);
    return conn;
  }

  // Test helper: simulate incoming connection
  simulateIncomingConnection(peerId: string): TestConnection {
    const conn = new TestConnection(peerId);
    this.incomingHandlers.forEach(h => h(conn));
    return conn;
  }

  // Test helper: simulate network partition
  simulateDisconnect(peerId: string): void {
    const conn = this.connections.get(peerId);
    conn?.simulateDisconnect();
  }
}
```

```typescript
// Integration test example
describe('FileWatcher + DocumentManager', () => {
  let vault: TestVault;
  let storage: MemoryStorage;
  let watcher: FileWatcher;
  let docManager: DocumentManager;

  beforeEach(() => {
    vault = new TestVault();
    storage = new MemoryStorage();
    watcher = new ObsidianFileWatcher(vault);
    docManager = new DocumentManager(storage);

    // Wire up
    watcher.onFileEvent(async (event) => {
      if (event.type === 'modify') {
        const content = await vault.read({ path: event.path } as TFile);
        await docManager.updateOrCreate(event.path, content);
      }
    });

    watcher.start();
  });

  it('creates doc when file is created', async () => {
    await vault.create('Notes/test.md', 'Hello world');

    // Wait for debounce
    await sleep(600);

    const doc = await docManager.getDoc('Notes/test.md');
    expect(doc).not.toBeNull();
    expect(doc!.content.toString()).toBe('Hello world');
  });

  it('updates doc when file is modified', async () => {
    await vault.create('Notes/test.md', 'Hello');
    await sleep(600);

    vault.simulateExternalChange('Notes/test.md', 'Hello world');
    await sleep(600);

    const doc = await docManager.getDoc('Notes/test.md');
    expect(doc!.content.toString()).toBe('Hello world');
  });
});
```

### 3. Sync Protocol Tests

Test the Loro sync protocol with simulated peers.

```typescript
import { LoroDoc, VersionVector } from 'loro-crdt';

describe('SyncProtocol', () => {
  it('syncs vault between two peers via version vectors', async () => {
    // Create two sync engines with separate Loro docs
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Peer1 creates a file
    createFile(peer1.doc, null, 'Notes/test.md', 'Hello from peer1');

    // Connect peers via mock transport
    const [conn1, conn2] = createLinkedConnections();

    // Run sync (exchange version vectors, then updates)
    await Promise.all([
      peer1.syncWith(conn1),
      peer2.syncWith(conn2),
    ]);

    // Peer2 should now have the file
    const content = getFileContent(peer2.doc, 'Notes/test.md');
    expect(content).toBe('Hello from peer1');

    // Version vectors should match
    expect(peer1.doc.version().encode()).toEqual(peer2.doc.version().encode());
  });

  it('merges concurrent edits with Loro', async () => {
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Start with same base state
    createFile(peer1.doc, null, 'Notes/test.md', 'Line 1\nLine 2\nLine 3');

    // Sync to get same base
    const [c1, c2] = createLinkedConnections();
    await Promise.all([peer1.syncWith(c1), peer2.syncWith(c2)]);

    // Concurrent offline edits
    updateFileContent(peer1.doc, 'Notes/test.md', 'Line 1 edited by peer1\nLine 2\nLine 3');
    updateFileContent(peer2.doc, 'Notes/test.md', 'Line 1\nLine 2\nLine 3 edited by peer2');

    // Sync again
    const [c3, c4] = createLinkedConnections();
    await Promise.all([peer1.syncWith(c3), peer2.syncWith(c4)]);

    // Both should have merged content (Fugue preserves both edits)
    const content1 = getFileContent(peer1.doc, 'Notes/test.md');
    const content2 = getFileContent(peer2.doc, 'Notes/test.md');

    expect(content1).toBe(content2);
    expect(content1).toContain('edited by peer1');
    expect(content1).toContain('edited by peer2');
  });

  it('handles sync interruption via version vectors', async () => {
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Peer1 has many files
    for (let i = 0; i < 10; i++) {
      createFile(peer1.doc, null, `Notes/doc${i}.md`, `Content ${i}`);
    }

    // Partial sync (simulate interruption)
    const partialExport = peer1.doc.export({ mode: 'snapshot' });
    const partialBytes = partialExport.slice(0, partialExport.length / 2);

    // This will fail or partially import
    try {
      peer2.doc.import(partialBytes);
    } catch {
      // Expected - partial data
    }

    // Full sync should complete correctly
    const fullExport = peer1.doc.export({ mode: 'snapshot' });
    peer2.doc.import(fullExport);

    // Verify all files present
    const fileCount = countFiles(peer2.doc);
    expect(fileCount).toBe(10);
  });

  it('incremental sync only transfers new changes', async () => {
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Initial sync
    createFile(peer1.doc, null, 'initial.md', 'Initial content');
    const [c1, c2] = createLinkedConnections();
    await Promise.all([peer1.syncWith(c1), peer2.syncWith(c2)]);

    // Record peer2's version
    const peer2Version = peer2.doc.version();

    // Peer1 makes more changes
    createFile(peer1.doc, null, 'new.md', 'New content');

    // Export only new changes
    const incrementalUpdate = peer1.doc.export({ mode: 'update', from: peer2Version });

    // Should be much smaller than full snapshot
    const fullSnapshot = peer1.doc.export({ mode: 'snapshot' });
    expect(incrementalUpdate.length).toBeLessThan(fullSnapshot.length);

    // Apply incremental update
    peer2.doc.import(incrementalUpdate);

    // Peer2 should have new file
    expect(getFileContent(peer2.doc, 'new.md')).toBe('New content');
  });
});
```

### 4. End-to-End Tests

Test complete user flows in a real Obsidian environment.

**Framework:** Playwright + Obsidian test vault

```typescript
// E2E test setup
describe('PeerVault E2E', () => {
  let obsidian1: ObsidianTestInstance;
  let obsidian2: ObsidianTestInstance;

  beforeAll(async () => {
    // Launch two Obsidian instances with test vaults
    obsidian1 = await launchObsidian({ vault: 'test-vault-1' });
    obsidian2 = await launchObsidian({ vault: 'test-vault-2' });

    // Install plugin in both
    await obsidian1.installPlugin('peervault');
    await obsidian2.installPlugin('peervault');
  });

  afterAll(async () => {
    await obsidian1.close();
    await obsidian2.close();
  });

  it('pairs two devices via QR code flow', async () => {
    // Device 1: Open settings, click "Add Device"
    await obsidian1.openSettings('PeerVault');
    await obsidian1.click('button:has-text("Show QR Code")');

    // Get ticket from modal
    const ticket = await obsidian1.getTextContent('.peervault-ticket');

    // Device 2: Open settings, enter ticket
    await obsidian2.openSettings('PeerVault');
    await obsidian2.click('button:has-text("Enter Ticket")');
    await obsidian2.fill('textarea', ticket);
    await obsidian2.fill('input[placeholder*="name"]', 'Test Device 1');
    await obsidian2.click('button:has-text("Connect")');

    // Verify connection
    await expect(obsidian1.locator('.peervault-status')).toContainText('Synced');
    await expect(obsidian2.locator('.peervault-status')).toContainText('Synced');
  });

  it('syncs file creation', async () => {
    // Create file on device 1
    await obsidian1.createFile('Notes/e2e-test.md', 'Created on device 1');

    // Wait for sync
    await sleep(2000);

    // Verify on device 2
    const content = await obsidian2.readFile('Notes/e2e-test.md');
    expect(content).toBe('Created on device 1');
  });

  it('syncs concurrent edits', async () => {
    // Both devices edit the same file
    await obsidian1.editFile('Notes/e2e-test.md', 'Line from device 1\n');
    await obsidian2.editFile('Notes/e2e-test.md', 'Line from device 2\n');

    // Wait for sync
    await sleep(3000);

    // Both should have merged content
    const content1 = await obsidian1.readFile('Notes/e2e-test.md');
    const content2 = await obsidian2.readFile('Notes/e2e-test.md');

    expect(content1).toBe(content2);
    expect(content1).toContain('Line from device 1');
    expect(content1).toContain('Line from device 2');
  });
});
```

## Test Fixtures

### Sample Vaults

```
test/fixtures/
├── empty-vault/              # Empty vault for fresh start tests
├── small-vault/              # 10 files, simple structure
│   ├── Notes/
│   │   ├── note1.md
│   │   └── note2.md
│   └── Daily/
│       └── 2024-01-15.md
├── large-vault/              # 1000+ files for performance tests
├── conflict-vault/           # Pre-staged conflict scenarios
│   ├── base/                 # Common ancestor
│   ├── branch-a/             # One set of edits
│   └── branch-b/             # Conflicting edits
└── binary-vault/             # Vault with attachments
```

### Test Data Generators

```typescript
import { LoroDoc } from 'loro-crdt';

// Generate test vault with N files
function generateTestVault(fileCount: number): LoroDoc {
  const doc = createVaultDoc('test-vault', 'Test Vault');

  for (let i = 0; i < fileCount; i++) {
    const path = `Notes/generated-${i.toString().padStart(4, '0')}.md`;
    const content = `# Generated Note ${i}\n\nThis is test content for note ${i}.\n`;
    createFile(doc, null, path, content);
  }

  return doc;
}

// Generate document with specific change history
function generateDocWithHistory(changeCount: number): LoroDoc {
  const doc = createVaultDoc('test', 'Test');
  const fileId = createFile(doc, null, 'test.md', 'Initial content');

  for (let i = 0; i < changeCount; i++) {
    const files = doc.getTree('files');
    const nodeData = files.getMeta(fileId);
    const content = nodeData.get('content') as LoroText;

    doc.transact(() => {
      content.insert(content.length, `\nChange ${i}`);
    });
  }

  return doc;
}

// Generate conflict scenario for testing
function generateConflictScenario(): { base: LoroDoc; branch1: LoroDoc; branch2: LoroDoc } {
  const base = createVaultDoc('test', 'Test');
  createFile(base, null, 'conflict.md', 'Original content');

  // Fork into two branches
  const branch1 = new LoroDoc();
  branch1.import(base.export({ mode: 'snapshot' }));

  const branch2 = new LoroDoc();
  branch2.import(base.export({ mode: 'snapshot' }));

  // Make conflicting edits
  updateFileContent(branch1, 'conflict.md', 'Branch 1 edit');
  updateFileContent(branch2, 'conflict.md', 'Branch 2 edit');

  return { base, branch1, branch2 };
}
```

## Network Simulation

Test behavior under various network conditions:

```typescript
class NetworkSimulator {
  constructor(private connection: TestConnection) {}

  // Add latency to all messages
  setLatency(ms: number): void {
    this.connection.latency = ms;
  }

  // Drop N% of messages
  setPacketLoss(percent: number): void {
    this.connection.packetLoss = percent;
  }

  // Limit bandwidth (bytes/sec)
  setBandwidth(bytesPerSec: number): void {
    this.connection.bandwidth = bytesPerSec;
  }

  // Simulate disconnect after N messages
  disconnectAfter(messageCount: number): void {
    this.connection.disconnectAfter = messageCount;
  }

  // Simulate network partition for duration
  partition(durationMs: number): void {
    this.connection.paused = true;
    setTimeout(() => {
      this.connection.paused = false;
    }, durationMs);
  }
}

// Usage in tests
it('handles high latency', async () => {
  const [conn1, conn2] = createLinkedConnections();
  new NetworkSimulator(conn1).setLatency(500);

  // Sync should still complete, just slower
  const startTime = Date.now();
  await runSync(peer1, peer2, conn1, conn2);
  const elapsed = Date.now() - startTime;

  expect(elapsed).toBeGreaterThan(5000); // Expect slowdown
  expect(await peer2.hasDoc('Notes/test.md')).toBe(true);
});
```

## CI Integration

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:unit
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3

  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:integration

  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx playwright install
      - run: npm run test:e2e
```

## Acceptance Criteria

| Component | Criteria |
|-----------|----------|
| Data Model | All Loro operations preserve data integrity |
| Storage | Loro document survives restart, no corruption |
| File Watcher | All file events captured within 1s |
| Sync Protocol | Two peers converge to identical version vector |
| Transport | Connection established within 10s |
| Peer Management | Peers persist and auto-reconnect |
| UI | All user flows completable |
| History | Time travel shows correct historical state |

## Property-Based Testing

For CRDT correctness, use property-based testing:

```typescript
import { fc } from 'fast-check';

describe('Loro CRDT Properties', () => {
  it('concurrent edits always converge', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(2), fc.string())), // (peerId, edit)
        (edits) => {
          const docs = [
            createVaultDoc('test', 'Test'),
            createVaultDoc('test', 'Test'),
            createVaultDoc('test', 'Test'),
          ];

          // Apply edits to respective docs
          for (const [peerId, edit] of edits) {
            createFile(docs[peerId], null, 'test.md', edit);
          }

          // Merge all into doc[0]
          for (let i = 1; i < docs.length; i++) {
            docs[0].import(docs[i].export({ mode: 'update', from: docs[0].version() }));
          }

          // Apply same merge to all others
          const finalState = docs[0].export({ mode: 'snapshot' });
          for (let i = 1; i < docs.length; i++) {
            docs[i].import(finalState);
          }

          // All docs should be identical
          for (let i = 1; i < docs.length; i++) {
            expect(docs[i].export({ mode: 'snapshot' }))
              .toEqual(docs[0].export({ mode: 'snapshot' }));
          }
        }
      )
    );
  });

  it('operations are commutative', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (edit1, edit2) => {
        // Apply edit1 then edit2
        const doc1 = createVaultDoc('test', 'Test');
        createFile(doc1, null, 'a.md', edit1);
        createFile(doc1, null, 'b.md', edit2);

        // Apply edit2 then edit1
        const doc2 = createVaultDoc('test', 'Test');
        createFile(doc2, null, 'b.md', edit2);
        createFile(doc2, null, 'a.md', edit1);

        // Merge and compare
        doc1.import(doc2.export({ mode: 'update', from: doc1.version() }));
        doc2.import(doc1.export({ mode: 'update', from: doc2.version() }));

        expect(countFiles(doc1)).toBe(countFiles(doc2));
      })
    );
  });
});
```

## Extended Testing Coverage

### Fuzz Testing for Sync Messages

Test robustness against malformed or malicious sync messages:

```typescript
import { fc } from 'fast-check';

describe('Sync Message Fuzz Testing', () => {
  it('handles malformed version vectors', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 1000 }), (garbage) => {
        const syncEngine = createTestSyncEngine('test');

        // Should not crash
        expect(() => {
          try {
            syncEngine.handleVersionInfo(garbage);
          } catch (e) {
            // Expected - malformed data
            expect(e.message).toMatch(/invalid|malformed|corrupt/i);
          }
        }).not.toThrow();
      })
    );
  });

  it('handles truncated messages', () => {
    const validMessage = createValidSyncMessage();

    for (let i = 0; i < validMessage.length; i++) {
      const truncated = validMessage.slice(0, i);

      expect(() => {
        try {
          parseFrame(truncated);
        } catch (e) {
          // Expected
        }
      }).not.toThrow();
    }
  });

  it('handles oversized messages', () => {
    const hugePayload = new Uint8Array(100 * 1024 * 1024); // 100MB

    expect(() => {
      const frame = { type: MESSAGE_TYPES.UPDATES, flags: 0, payload: hugePayload };
      encodeFrame(frame);
    }).toThrow(/too large/i);
  });

  it('handles invalid message types', () => {
    for (let type = 0; type < 256; type++) {
      if (Object.values(MESSAGE_TYPES).includes(type)) continue;

      const frame = { type, flags: 0, payload: new Uint8Array(10) };
      const encoded = encodeFrame(frame);

      expect(() => {
        const syncEngine = createTestSyncEngine('test');
        syncEngine.handleRawMessage(encoded);
      }).toThrow(/unknown message type/i);
    }
  });

  it('handles corrupted checksums', () => {
    const validFrame = encodeFrame({
      type: MESSAGE_TYPES.UPDATES,
      flags: MESSAGE_FLAGS.CHECKSUMMED,
      payload: new Uint8Array([1, 2, 3, 4]),
    });

    // Corrupt checksum byte
    validFrame[7] ^= 0xff;

    expect(() => {
      decodeFrame(validFrame);
    }).toThrow(/checksum/i);
  });
});
```

### Stress Testing

Test behavior under heavy load:

```typescript
describe('Stress Testing', () => {
  it('handles 100 concurrent file changes', async () => {
    const doc = createVaultDoc('stress', 'Stress Test');
    const changes: Promise<void>[] = [];

    // Create 100 files concurrently
    for (let i = 0; i < 100; i++) {
      changes.push((async () => {
        createFile(doc, null, `file-${i}.md`, `Content ${i}`);
      })());
    }

    await Promise.all(changes);

    // Verify all files created
    const fileCount = countFiles(doc);
    expect(fileCount).toBe(100);
  });

  it('handles rapid sequential edits to same file', async () => {
    const doc = createVaultDoc('stress', 'Stress');
    const nodeId = createFile(doc, null, 'rapid.md', 'Start');

    const editCount = 1000;

    for (let i = 0; i < editCount; i++) {
      updateFileContent(doc, nodeId, `Content after ${i} edits`);
    }

    // Document should still be valid
    const content = getFileContent(doc, nodeId);
    expect(content).toContain(`${editCount - 1}`);
  });

  it('handles concurrent edits from many peers', async () => {
    const peerCount = 10;
    const peers = Array.from({ length: peerCount }, (_, i) =>
      createTestSyncEngine(`peer-${i}`)
    );

    // Create base file
    const fileId = createFile(peers[0].doc, null, 'shared.md', 'Base');

    // Sync base to all peers
    for (let i = 1; i < peerCount; i++) {
      peers[i].doc.import(peers[0].doc.export({ mode: 'snapshot' }));
    }

    // All peers edit concurrently
    for (let i = 0; i < peerCount; i++) {
      updateFileContent(peers[i].doc, fileId, `Edit from peer ${i}\n`);
    }

    // Merge all into peer 0
    for (let i = 1; i < peerCount; i++) {
      const updates = peers[i].doc.export({
        mode: 'update',
        from: peers[0].doc.version(),
      });
      peers[0].doc.import(updates);
    }

    // Content should contain all edits
    const finalContent = getFileContent(peers[0].doc, fileId);
    for (let i = 0; i < peerCount; i++) {
      expect(finalContent).toContain(`peer ${i}`);
    }
  });

  it('handles large vault sync', async () => {
    const fileCount = 10000;
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Create large vault
    console.time('create-10k-files');
    for (let i = 0; i < fileCount; i++) {
      createFile(peer1.doc, null, `file-${i}.md`, `Content ${i}`);
    }
    console.timeEnd('create-10k-files');

    // Sync to peer2
    console.time('sync-10k-files');
    const snapshot = peer1.doc.export({ mode: 'snapshot' });
    peer2.doc.import(snapshot);
    console.timeEnd('sync-10k-files');

    expect(countFiles(peer2.doc)).toBe(fileCount);
  });
});
```

### Mobile-Specific Tests

```typescript
describe('Mobile-Specific Tests', () => {
  it('respects memory limits on iOS', async () => {
    const config = getWasmMemoryConfig({ isMobile: true, isIOS: true });

    // Create large vault
    const doc = createVaultDoc('mobile', 'Mobile');

    // Monitor memory usage
    const initialMemory = process.memoryUsage().heapUsed;

    for (let i = 0; i < 1000; i++) {
      createFile(doc, null, `file-${i}.md`, 'x'.repeat(10000));
    }

    const finalMemory = process.memoryUsage().heapUsed;
    const memoryUsedMB = (finalMemory - initialMemory) / (1024 * 1024);

    // Should stay under iOS limit
    expect(memoryUsedMB).toBeLessThan(config.maxPages * 64 / 1024);
  });

  it('handles app backgrounding mid-sync', async () => {
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Create files on peer1
    for (let i = 0; i < 100; i++) {
      createFile(peer1.doc, null, `file-${i}.md`, `Content ${i}`);
    }

    // Start sync
    const [conn1, conn2] = createLinkedConnections();
    const syncPromise = peer2.syncWith(conn2);

    // Simulate app backgrounding (pause connection)
    await sleep(100);
    conn2.pause();

    // Simulate app foregrounding
    await sleep(500);
    conn2.resume();

    // Sync should complete
    await syncPromise;

    expect(countFiles(peer2.doc)).toBe(100);
  });

  it('handles network type changes during sync', async () => {
    const syncEngine = createTestSyncEngine('mobile');
    const networkAware = new NetworkAwareSync(DEFAULT_NETWORK_CONFIG);

    // Start on WiFi
    networkAware.platform.networkType = 'wifi';

    // Begin large sync
    const largeSyncPromise = syncEngine.syncLargeBlobs();

    // Switch to cellular mid-sync
    networkAware.handleNetworkChange({ type: 'cellular' });

    // Should pause blob sync on cellular
    expect(networkAware.shouldSyncBlobs()).toBe(false);

    // Switch back to WiFi
    networkAware.handleNetworkChange({ type: 'wifi' });

    // Should resume
    expect(networkAware.shouldSyncBlobs()).toBe(true);
  });
});
```

### Encryption Round-Trip Tests

```typescript
describe('Encryption Tests', () => {
  it('encrypt-decrypt round trip preserves data', async () => {
    const storage = new EncryptedStorage();
    const passphrase = 'test-passphrase-123';
    const salt = crypto.getRandomValues(new Uint8Array(16));

    await storage.unlock(passphrase, salt);

    // Create document with data
    const doc = createVaultDoc('encrypted', 'Encrypted Vault');
    createFile(doc, null, 'secret.md', 'Secret content');

    // Save (encrypts)
    const encrypted = await storage.encrypt(doc.export({ mode: 'snapshot' }));

    // Load (decrypts)
    const decrypted = await storage.decrypt(encrypted);
    const loadedDoc = new LoroDoc();
    loadedDoc.import(decrypted);

    // Content should match
    expect(getFileContent(loadedDoc, 'secret.md')).toBe('Secret content');
  });

  it('wrong passphrase fails decryption', async () => {
    const storage = new EncryptedStorage();
    const salt = crypto.getRandomValues(new Uint8Array(16));

    await storage.unlock('correct-passphrase', salt);

    const doc = createVaultDoc('test', 'Test');
    const encrypted = await storage.encrypt(doc.export({ mode: 'snapshot' }));

    // Try with wrong passphrase
    storage.lock();
    await storage.unlock('wrong-passphrase', salt);

    await expect(storage.decrypt(encrypted)).rejects.toThrow();
  });

  it('handles passphrase rotation', async () => {
    const rotation = new PassphraseRotation();
    const storage = new EncryptedStorage();

    const oldPassphrase = 'old-pass';
    const newPassphrase = 'new-pass';
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // Setup with old passphrase
    await storage.unlock(oldPassphrase, salt);
    const doc = createVaultDoc('rotate', 'Rotate Test');
    createFile(doc, null, 'test.md', 'Test content');
    await storage.save(doc);

    // Rotate passphrase
    await rotation.rotatePassphrase(storage, oldPassphrase, newPassphrase);

    // Old passphrase should fail
    storage.lock();
    await expect(storage.unlock(oldPassphrase, salt)).rejects.toThrow();

    // New passphrase should work
    const newSalt = await rotation.loadSalt();
    await storage.unlock(newPassphrase, newSalt);

    const loadedDoc = await storage.load();
    expect(getFileContent(loadedDoc, 'test.md')).toBe('Test content');
  });
});
```

### Edge Case Tests

```typescript
describe('Edge Case Tests', () => {
  it('handles empty file', async () => {
    const doc = createVaultDoc('edge', 'Edge');
    const nodeId = createFile(doc, null, 'empty.md', '');

    const content = getFileContent(doc, nodeId);
    expect(content).toBe('');
  });

  it('handles very long file names', async () => {
    const doc = createVaultDoc('edge', 'Edge');
    const longName = 'a'.repeat(255) + '.md';

    const nodeId = createFile(doc, null, longName, 'Content');
    const path = getNodePath(doc, nodeId);

    expect(path).toBe(longName);
  });

  it('handles special characters in file names', async () => {
    const specialNames = [
      'file with spaces.md',
      'file-with-dashes.md',
      'file_with_underscores.md',
      'CamelCase.md',
      'über.md',
      '日本語.md',
      'emoji-🎉.md',
    ];

    const doc = createVaultDoc('edge', 'Edge');

    for (const name of specialNames) {
      const nodeId = createFile(doc, null, name, 'Content');
      expect(getNodePath(doc, nodeId)).toBe(name);
    }
  });

  it('handles deeply nested folders', async () => {
    const doc = createVaultDoc('edge', 'Edge');
    const depth = 50;

    let parentId: TreeID | null = null;
    for (let i = 0; i < depth; i++) {
      parentId = createFolder(doc, parentId, `level-${i}`);
    }

    const fileId = createFile(doc, parentId, 'deep.md', 'Deep content');
    const path = getNodePath(doc, fileId);

    expect(path.split('/').length).toBe(depth + 1);
  });

  it('handles file with only whitespace', async () => {
    const doc = createVaultDoc('edge', 'Edge');
    const nodeId = createFile(doc, null, 'whitespace.md', '   \n\t  \n  ');

    const content = getFileContent(doc, nodeId);
    expect(content).toBe('   \n\t  \n  ');
  });

  it('handles binary-like content in text file', async () => {
    const doc = createVaultDoc('edge', 'Edge');
    const binaryLike = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i));

    const nodeId = createFile(doc, null, 'binary-like.md', binaryLike);
    const content = getFileContent(doc, nodeId);

    expect(content.length).toBe(256);
  });
});
```

### Performance Regression Tests

```typescript
describe('Performance Regression Tests', () => {
  const benchmarks: Record<string, number> = {
    'create-1000-files': 5000,
    'sync-1000-files': 2000,
    'search-in-1000-files': 500,
  };

  it('file creation stays within budget', async () => {
    const doc = createVaultDoc('perf', 'Perf');

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      createFile(doc, null, `file-${i}.md`, `Content ${i}`);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(benchmarks['create-1000-files']);
    console.log(`create-1000-files: ${elapsed.toFixed(2)}ms`);
  });

  it('sync stays within budget', async () => {
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    for (let i = 0; i < 1000; i++) {
      createFile(peer1.doc, null, `file-${i}.md`, `Content ${i}`);
    }

    const start = performance.now();
    const snapshot = peer1.doc.export({ mode: 'snapshot' });
    peer2.doc.import(snapshot);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(benchmarks['sync-1000-files']);
    console.log(`sync-1000-files: ${elapsed.toFixed(2)}ms`);
  });
});
```

## Cross-Platform Path Tests

Testing path handling across different operating systems is critical for cross-platform sync reliability.

### Path Normalization Tests

```typescript
describe('PathNormalizer', () => {
  const normalizer = new PathNormalizer();

  describe('toCanonical', () => {
    it('lowercases paths for case-insensitive comparison', () => {
      expect(normalizer.toCanonical('Notes/Daily.md')).toBe('notes/daily.md');
      expect(normalizer.toCanonical('UPPERCASE.MD')).toBe('uppercase.md');
    });

    it('normalizes path separators', () => {
      // Windows paths
      expect(normalizer.toCanonical('Notes\\Daily.md')).toBe('notes/daily.md');
      expect(normalizer.toCanonical('Folder\\Sub\\File.md')).toBe('folder/sub/file.md');
    });

    it('handles Unicode characters', () => {
      expect(normalizer.toCanonical('Notes/日本語.md')).toBe('notes/日本語.md');
      expect(normalizer.toCanonical('Notes/Ñoño.md')).toBe('notes/ñoño.md');
    });

    it('handles emoji in paths', () => {
      expect(normalizer.toCanonical('Notes/📝 Daily.md')).toBe('notes/📝 daily.md');
    });

    it('handles spaces and special characters', () => {
      expect(normalizer.toCanonical('My Notes/Daily Log.md')).toBe('my notes/daily log.md');
      expect(normalizer.toCanonical('Notes (Archive)/Old.md')).toBe('notes (archive)/old.md');
    });
  });

  describe('pathsEqual', () => {
    it('treats different cases as equal', () => {
      expect(normalizer.pathsEqual('Note.md', 'note.md')).toBe(true);
      expect(normalizer.pathsEqual('Note.md', 'NOTE.MD')).toBe(true);
    });

    it('treats different path separators as equal', () => {
      expect(normalizer.pathsEqual('a/b/c.md', 'a\\b\\c.md')).toBe(true);
    });

    it('distinguishes actually different paths', () => {
      expect(normalizer.pathsEqual('note1.md', 'note2.md')).toBe(false);
    });
  });
});
```

### Platform-Specific Path Behavior

```typescript
describe('Platform path behavior', () => {
  describe('Windows-specific', () => {
    beforeEach(() => {
      mockPlatform('windows');
    });

    it('rejects reserved names', () => {
      const WINDOWS_RESERVED = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1'];
      for (const name of WINDOWS_RESERVED) {
        expect(() => validateFileName(`${name}.md`)).toThrow(/reserved/i);
      }
    });

    it('rejects trailing dots and spaces', () => {
      expect(() => validateFileName('note. ')).toThrow(/trailing/i);
      expect(() => validateFileName('note.')).toThrow(/trailing/i);
    });

    it('rejects invalid characters', () => {
      const INVALID = ['<', '>', ':', '"', '|', '?', '*'];
      for (const char of INVALID) {
        expect(() => validateFileName(`note${char}file.md`)).toThrow(/invalid character/i);
      }
    });
  });

  describe('macOS-specific', () => {
    beforeEach(() => {
      mockPlatform('macos');
    });

    it('rejects colon in file names', () => {
      expect(() => validateFileName('note:file.md')).toThrow(/colon/i);
    });

    it('handles NFD vs NFC Unicode normalization', () => {
      // 'é' can be represented as single char (NFC) or e + combining accent (NFD)
      const nfc = 'café.md'; // Single é
      const nfd = 'café.md'; // e + combining accent
      expect(normalizer.pathsEqual(nfc, nfd)).toBe(true);
    });
  });

  describe('Linux-specific', () => {
    beforeEach(() => {
      mockPlatform('linux');
    });

    it('allows most special characters', () => {
      // Linux allows almost anything except / and null
      expect(() => validateFileName('note<file>.md')).not.toThrow();
      expect(() => validateFileName('note:file.md')).not.toThrow();
    });

    it('rejects forward slash', () => {
      expect(() => validateFileName('note/file.md')).toThrow();
    });
  });
});
```

### Cross-Platform Sync Tests

```typescript
describe('Cross-platform sync', () => {
  it('syncs case-different files as same file on case-insensitive platform', async () => {
    const macPeer = createTestPeer({ platform: 'macos' });
    const linuxPeer = createTestPeer({ platform: 'linux' });

    // Linux creates 'Note.md'
    await createFile(linuxPeer.doc, 'Note.md', 'Content');

    // Sync to macOS
    await syncPeers(linuxPeer, macPeer);

    // Verify file exists
    expect(await macPeer.fileExists('Note.md')).toBe(true);

    // Linux creates 'note.md' (different file on Linux!)
    await createFile(linuxPeer.doc, 'note.md', 'Different content');

    // Sync - macOS should see conflict, not two files
    await syncPeers(linuxPeer, macPeer);

    // macOS should have case conflict handler triggered
    expect(macPeer.caseConflicts).toHaveLength(1);
    expect(macPeer.caseConflicts[0].existingPath).toBe('Note.md');
    expect(macPeer.caseConflicts[0].newPath).toBe('note.md');
  });

  it('preserves original case when syncing', async () => {
    const peer1 = createTestPeer({ platform: 'macos' });
    const peer2 = createTestPeer({ platform: 'windows' });

    // Create with specific case
    await createFile(peer1.doc, 'MyNotes/DailyLog.md', 'Content');

    await syncPeers(peer1, peer2);

    // Case should be preserved on both platforms
    const file = await peer2.getFileByCanonicalPath('mynotes/dailylog.md');
    expect(file.displayPath).toBe('MyNotes/DailyLog.md');
  });

  it('handles path separator differences', async () => {
    const winPeer = createTestPeer({ platform: 'windows' });
    const macPeer = createTestPeer({ platform: 'macos' });

    // Create nested file
    await createFile(winPeer.doc, 'Folder\\Subfolder\\File.md', 'Content');

    await syncPeers(winPeer, macPeer);

    // macOS should have forward slashes
    expect(await macPeer.fileExists('Folder/Subfolder/File.md')).toBe(true);
  });
});
```

### CI Platform Matrix

Run path tests on actual platforms in CI:

```yaml
# .github/workflows/cross-platform.yml
name: Cross-Platform Tests

on: [push, pull_request]

jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [18, 20]

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}

      - name: Install dependencies
        run: npm ci

      - name: Run path tests
        run: npm run test:paths

      - name: Run case-sensitivity tests
        run: npm run test:case
        # This test creates files with different cases
        # to verify actual filesystem behavior

      - name: Create test files with special characters
        run: npm run test:special-chars
        if: runner.os != 'Windows'
        # Windows has more restrictions on special characters
```

### Filesystem Behavior Verification

```typescript
/**
 * These tests run against the actual filesystem to verify behavior.
 * They're slow and should be in a separate test suite.
 */
describe('Filesystem behavior verification', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  it('detects case sensitivity of current filesystem', async () => {
    const path1 = join(tempDir, 'test.txt');
    const path2 = join(tempDir, 'TEST.txt');

    await writeFile(path1, 'lower');

    // Try to read with different case
    try {
      const content = await readFile(path2, 'utf-8');
      // If we get here, filesystem is case-insensitive
      expect(content).toBe('lower');
      console.log('Filesystem is case-insensitive');
    } catch (error) {
      // File not found = case-sensitive
      console.log('Filesystem is case-sensitive');
    }
  });

  it('verifies max path length', async () => {
    // Most filesystems: 255 chars per component, 4096 total path
    const longName = 'a'.repeat(256);
    const path = join(tempDir, longName);

    try {
      await writeFile(path, 'test');
      fail('Should have thrown for path too long');
    } catch (error) {
      expect(error.code).toMatch(/ENAMETOOLONG|EINVAL/);
    }
  });
});
```

## Dependencies

```json
{
  "devDependencies": {
    "vitest": "^1.0.0",
    "fast-check": "^3.0.0",
    "@playwright/test": "^1.40.0",
    "loro-crdt": "^1.0.0"
  }
}
```

- Vitest (unit/integration tests)
- fast-check (property-based testing)
- Playwright (E2E tests)
- Test doubles for Obsidian APIs
