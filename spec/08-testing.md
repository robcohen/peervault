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
- Automerge document operations (create, update, delete)
- Text diffing algorithms
- Document ID generation
- Sync message serialization
- Ticket parsing

**Framework:** Vitest or Jest

```typescript
// Example: Document ID generation
describe('generateDocId', () => {
  it('produces deterministic IDs', () => {
    const id1 = generateDocId('vault-123', 'Notes/test.md');
    const id2 = generateDocId('vault-123', 'Notes/test.md');
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different paths', () => {
    const id1 = generateDocId('vault-123', 'Notes/a.md');
    const id2 = generateDocId('vault-123', 'Notes/b.md');
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for different vaults', () => {
    const id1 = generateDocId('vault-1', 'Notes/test.md');
    const id2 = generateDocId('vault-2', 'Notes/test.md');
    expect(id1).not.toBe(id2);
  });
});
```

```typescript
// Example: Automerge text updates
describe('updateFileContent', () => {
  it('applies insertions correctly', () => {
    const doc = createFileDoc('test.md', 'Hello world');
    const updated = updateFileContent(doc, 'Hello brave world');
    expect(updated.content.toString()).toBe('Hello brave world');
  });

  it('applies deletions correctly', () => {
    const doc = createFileDoc('test.md', 'Hello world');
    const updated = updateFileContent(doc, 'Hello');
    expect(updated.content.toString()).toBe('Hello');
  });

  it('preserves concurrent edits', () => {
    const base = createFileDoc('test.md', 'Hello world');

    // Fork into two branches
    const branch1 = updateFileContent(base, 'Hello brave world');
    const branch2 = updateFileContent(base, 'Hello new world');

    // Merge
    const merged = Automerge.merge(branch1, branch2);

    // Both insertions should be present
    const content = merged.content.toString();
    expect(content).toContain('brave');
    expect(content).toContain('new');
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
// Mock Obsidian Vault API
class MockVault {
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
// Mock Iroh Transport
class MockTransport implements IrohTransport {
  private connections = new Map<string, MockConnection>();
  private incomingHandlers: ((conn: PeerConnection) => void)[] = [];

  async connectWithTicket(ticket: string): Promise<PeerConnection> {
    const peerId = this.extractPeerId(ticket);
    const conn = new MockConnection(peerId);
    this.connections.set(peerId, conn);
    return conn;
  }

  // Test helper: simulate incoming connection
  simulateIncomingConnection(peerId: string): MockConnection {
    const conn = new MockConnection(peerId);
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
  let vault: MockVault;
  let storage: MockStorage;
  let watcher: FileWatcher;
  let docManager: DocumentManager;

  beforeEach(() => {
    vault = new MockVault();
    storage = new MockStorage();
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

Test the sync protocol with simulated peers.

```typescript
describe('SyncProtocol', () => {
  it('syncs documents between two peers', async () => {
    // Create two in-memory sync engines
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Peer1 has a document
    await peer1.docManager.createDoc('Notes/test.md', 'Hello from peer1');

    // Connect peers via mock transport
    const [conn1, conn2] = createLinkedConnections();

    // Run sync
    await Promise.all([
      peer1.syncWith(conn1),
      peer2.syncWith(conn2),
    ]);

    // Peer2 should now have the document
    const doc = await peer2.docManager.getDoc('Notes/test.md');
    expect(doc!.content.toString()).toBe('Hello from peer1');
  });

  it('merges concurrent edits', async () => {
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Both start with same document
    const initialDoc = createFileDoc('Notes/test.md', 'Line 1\nLine 2\nLine 3');
    await peer1.docManager.setDoc('Notes/test.md', initialDoc);
    await peer2.docManager.setDoc('Notes/test.md', Automerge.clone(initialDoc));

    // Concurrent edits (offline)
    await peer1.docManager.updateContent('Notes/test.md', 'Line 1 edited by peer1\nLine 2\nLine 3');
    await peer2.docManager.updateContent('Notes/test.md', 'Line 1\nLine 2\nLine 3 edited by peer2');

    // Sync
    const [conn1, conn2] = createLinkedConnections();
    await Promise.all([
      peer1.syncWith(conn1),
      peer2.syncWith(conn2),
    ]);

    // Both should have merged content
    const content1 = (await peer1.docManager.getDoc('Notes/test.md'))!.content.toString();
    const content2 = (await peer2.docManager.getDoc('Notes/test.md'))!.content.toString();

    expect(content1).toBe(content2);
    expect(content1).toContain('edited by peer1');
    expect(content1).toContain('edited by peer2');
  });

  it('handles sync interruption and resume', async () => {
    const peer1 = createTestSyncEngine('peer1');
    const peer2 = createTestSyncEngine('peer2');

    // Peer1 has multiple documents
    for (let i = 0; i < 10; i++) {
      await peer1.docManager.createDoc(`Notes/doc${i}.md`, `Content ${i}`);
    }

    // Start sync, interrupt after 3 docs
    const [conn1, conn2] = createLinkedConnections();
    conn1.interruptAfter(3);

    await Promise.all([
      peer1.syncWith(conn1).catch(() => {}),
      peer2.syncWith(conn2).catch(() => {}),
    ]);

    // Peer2 should have partial sync
    const syncedCount = await peer2.docManager.getDocCount();
    expect(syncedCount).toBeGreaterThan(0);
    expect(syncedCount).toBeLessThan(10);

    // Resume sync
    const [conn3, conn4] = createLinkedConnections();
    await Promise.all([
      peer1.syncWith(conn3),
      peer2.syncWith(conn4),
    ]);

    // Now all docs should be synced
    expect(await peer2.docManager.getDocCount()).toBe(10);
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

### Mock Data Generators

```typescript
// Generate test vault with N files
function generateTestVault(fileCount: number): Map<string, string> {
  const files = new Map<string, string>();

  for (let i = 0; i < fileCount; i++) {
    const path = `Notes/generated-${i.toString().padStart(4, '0')}.md`;
    const content = `# Generated Note ${i}\n\nThis is test content for note ${i}.\n`;
    files.set(path, content);
  }

  return files;
}

// Generate document with specific change history
function generateDocWithHistory(changeCount: number): Automerge.Doc<FileDoc> {
  let doc = createFileDoc('test.md', 'Initial content');

  for (let i = 0; i < changeCount; i++) {
    doc = Automerge.change(doc, d => {
      d.content.insertAt(d.content.length, `\nChange ${i}`);
    });
  }

  return doc;
}
```

## Network Simulation

Test behavior under various network conditions:

```typescript
class NetworkSimulator {
  constructor(private connection: MockConnection) {}

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
| Data Model | All CRDT operations preserve data integrity |
| Storage | Documents survive restart, no corruption |
| File Watcher | All file events captured within 1s |
| Sync Protocol | Two peers converge to identical state |
| Transport | Connection established within 10s |
| Peer Management | Peers persist and auto-reconnect |
| UI | All user flows completable |

## Dependencies

- Vitest or Jest (unit/integration tests)
- Playwright (E2E tests)
- Mock libraries for Obsidian APIs
