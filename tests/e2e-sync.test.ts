/**
 * E2E Sync Tests
 *
 * Tests for end-to-end sync between two peers using mock transport.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DocumentManager } from '../src/core/document-manager';
import { MemoryStorageAdapter } from '../src/core/storage-adapter';
import { BlobStore } from '../src/core/blob-store';
import { MockTransport, clearMockRegistry, type TransportConfig } from '../src/transport';
import { PeerManager } from '../src/peer';
import {
  SyncMessageType,
  serializeMessage,
  deserializeMessage,
  createBlobHashesMessage,
  createBlobRequestMessage,
  createBlobDataMessage,
  createBlobSyncCompleteMessage,
} from '../src/sync';
import type { Logger } from '../src/utils/logger';

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createTestConfig(name: string): TransportConfig {
  const keys = new Map<string, Uint8Array>();

  return {
    storage: {
      loadSecretKey: async () => keys.get(name) ?? null,
      saveSecretKey: async (key: Uint8Array) => {
        keys.set(name, key);
      },
    },
    logger: createTestLogger(),
    debug: false,
  };
}

interface TestPeer {
  storage: MemoryStorageAdapter;
  docManager: DocumentManager;
  transport: MockTransport;
  peerManager: PeerManager;
  logger: Logger;
}

async function createTestPeer(name: string): Promise<TestPeer> {
  const storage = new MemoryStorageAdapter();
  const logger = createTestLogger();
  const docManager = new DocumentManager(storage, logger);
  await docManager.initialize();

  const transport = new MockTransport(createTestConfig(name));
  await transport.initialize();

  const peerManager = new PeerManager(transport, docManager, storage, logger, {
    autoSyncInterval: 0, // Disable auto-sync for tests
    autoReconnect: false,
  });
  await peerManager.initialize();

  return { storage, docManager, transport, peerManager, logger };
}

async function shutdownPeer(peer: TestPeer): Promise<void> {
  await peer.peerManager.shutdown();
  await peer.transport.shutdown();
}

describe('E2E Sync', () => {
  let peerA: TestPeer;
  let peerB: TestPeer;

  beforeEach(async () => {
    clearMockRegistry();
    peerA = await createTestPeer('peerA');
    peerB = await createTestPeer('peerB');
  });

  afterEach(async () => {
    await shutdownPeer(peerA);
    await shutdownPeer(peerB);
    clearMockRegistry();
  });

  describe('Basic Connection', () => {
    it('should connect two peers', async () => {
      const ticket = await peerB.peerManager.generateInvite();
      await peerA.peerManager.addPeer(ticket, 'Peer B');

      // Wait for connection to establish
      await new Promise((r) => setTimeout(r, 100));

      const peersA = peerA.peerManager.getPeers();
      expect(peersA.length).toBe(1);
      expect(peersA[0].nodeId).toBe(peerB.transport.getNodeId());
    });

    it('should generate unique node IDs', async () => {
      const nodeA = peerA.transport.getNodeId();
      const nodeB = peerB.transport.getNodeId();

      expect(nodeA).not.toBe(nodeB);
      expect(nodeA.length).toBe(32);
      expect(nodeB.length).toBe(32);
    });
  });

  describe('Document Sync', () => {
    it('should sync file creation from A to B', async () => {
      // Create file on peer A
      await peerA.docManager.handleFileCreate('notes/test.md');
      const pathsA = peerA.docManager.listAllPaths();
      expect(pathsA).toContain('notes/test.md');

      // Export updates from A
      const updates = peerA.docManager.exportUpdates();
      expect(updates.length).toBeGreaterThan(0);

      // Import to B
      peerB.docManager.importUpdates(updates);

      // B should now have the file
      const pathsB = peerB.docManager.listAllPaths();
      expect(pathsB).toContain('notes');
      expect(pathsB).toContain('notes/test.md');
    });

    it('should sync multiple files', async () => {
      // Create multiple files on A
      await peerA.docManager.handleFileCreate('file1.md');
      await peerA.docManager.handleFileCreate('file2.md');
      await peerA.docManager.handleFileCreate('folder/file3.md');

      // Export and import
      const updates = peerA.docManager.exportUpdates();
      peerB.docManager.importUpdates(updates);

      const pathsB = peerB.docManager.listAllPaths();
      expect(pathsB).toContain('file1.md');
      expect(pathsB).toContain('file2.md');
      expect(pathsB).toContain('folder');
      expect(pathsB).toContain('folder/file3.md');
    });

    it('should sync file deletion', async () => {
      // Create file on A and sync to B
      await peerA.docManager.handleFileCreate('to-delete.md');
      let updates = peerA.docManager.exportUpdates();
      peerB.docManager.importUpdates(updates);

      expect(peerB.docManager.listAllPaths()).toContain('to-delete.md');

      // Delete on A
      await peerA.docManager.handleFileDelete('to-delete.md');
      expect(peerA.docManager.listAllPaths()).not.toContain('to-delete.md');

      // Sync deletion to B
      updates = peerA.docManager.exportUpdates();
      peerB.docManager.importUpdates(updates);

      expect(peerB.docManager.listAllPaths()).not.toContain('to-delete.md');
    });

    it('should sync file rename', async () => {
      // Create and sync file
      await peerA.docManager.handleFileCreate('old-name.md');
      let updates = peerA.docManager.exportUpdates();
      peerB.docManager.importUpdates(updates);

      expect(peerB.docManager.listAllPaths()).toContain('old-name.md');

      // Rename on A
      await peerA.docManager.handleFileRename('old-name.md', 'new-name.md');

      // Sync to B
      updates = peerA.docManager.exportUpdates();
      peerB.docManager.importUpdates(updates);

      const pathsB = peerB.docManager.listAllPaths();
      expect(pathsB).not.toContain('old-name.md');
      expect(pathsB).toContain('new-name.md');
    });
  });

  describe('Bidirectional Sync', () => {
    it('should sync changes from both peers', async () => {
      // A creates file1
      await peerA.docManager.handleFileCreate('from-a.md');

      // B creates file2
      await peerB.docManager.handleFileCreate('from-b.md');

      // Exchange updates
      const updatesA = peerA.docManager.exportUpdates();
      const updatesB = peerB.docManager.exportUpdates();

      peerA.docManager.importUpdates(updatesB);
      peerB.docManager.importUpdates(updatesA);

      // Both should have both files
      const pathsA = peerA.docManager.listAllPaths();
      const pathsB = peerB.docManager.listAllPaths();

      expect(pathsA).toContain('from-a.md');
      expect(pathsA).toContain('from-b.md');
      expect(pathsB).toContain('from-a.md');
      expect(pathsB).toContain('from-b.md');
    });

    it('should handle concurrent file creation', async () => {
      // Both peers create files in the same folder at the same time
      await peerA.docManager.handleFileCreate('shared/fileA.md');
      await peerB.docManager.handleFileCreate('shared/fileB.md');

      // Exchange updates
      const updatesA = peerA.docManager.exportUpdates();
      const updatesB = peerB.docManager.exportUpdates();

      peerA.docManager.importUpdates(updatesB);
      peerB.docManager.importUpdates(updatesA);

      // Both should have both files
      const pathsA = peerA.docManager.listAllPaths();
      const pathsB = peerB.docManager.listAllPaths();

      expect(pathsA).toContain('shared');
      expect(pathsA).toContain('shared/fileA.md');
      expect(pathsA).toContain('shared/fileB.md');

      expect(pathsB).toContain('shared');
      expect(pathsB).toContain('shared/fileA.md');
      expect(pathsB).toContain('shared/fileB.md');
    });
  });

  describe('Version Vectors', () => {
    it('should track versions correctly', async () => {
      const initialVersion = peerA.docManager.getVersionBytes();
      expect(initialVersion.length).toBeGreaterThan(0);

      // Create file
      await peerA.docManager.handleFileCreate('test.md');

      const afterVersion = peerA.docManager.getVersionBytes();
      // Version should change after modification
      expect(afterVersion).not.toEqual(initialVersion);
    });

    it('should export incremental updates', async () => {
      // Create first file and get version
      await peerA.docManager.handleFileCreate('first.md');
      const version1 = peerA.docManager.getVersion();

      // Create second file
      await peerA.docManager.handleFileCreate('second.md');

      // Export only updates since version1
      const updates = peerA.docManager.exportUpdates(version1);

      // These updates should only contain the second file
      // (Loro handles this internally - we just verify updates are generated)
      expect(updates.length).toBeGreaterThan(0);
    });
  });

  describe('Persistence', () => {
    it('should persist and reload document state', async () => {
      // Create files
      await peerA.docManager.handleFileCreate('persist1.md');
      await peerA.docManager.handleFileCreate('persist2.md');
      await peerA.docManager.save();

      // Create new document manager with same storage
      const docManager2 = new DocumentManager(peerA.storage, peerA.logger);
      await docManager2.initialize();

      const paths = docManager2.listAllPaths();
      expect(paths).toContain('persist1.md');
      expect(paths).toContain('persist2.md');

      // Vault ID should be preserved
      expect(docManager2.getVaultId()).toBe(peerA.docManager.getVaultId());
    });
  });
});

describe('Blob Sync Message Serialization', () => {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  it('should serialize and deserialize BLOB_HASHES message', () => {
    const hashes = ['abc123', 'def456', 'ghi789'];
    const msg = createBlobHashesMessage(hashes);

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(SyncMessageType.BLOB_HASHES);
    expect((deserialized as typeof msg).hashes).toEqual(hashes);
  });

  it('should serialize and deserialize empty BLOB_HASHES message', () => {
    const msg = createBlobHashesMessage([]);

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(SyncMessageType.BLOB_HASHES);
    expect((deserialized as typeof msg).hashes).toEqual([]);
  });

  it('should serialize and deserialize BLOB_REQUEST message', () => {
    const hashes = ['hash1', 'hash2'];
    const msg = createBlobRequestMessage(hashes);

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(SyncMessageType.BLOB_REQUEST);
    expect((deserialized as typeof msg).hashes).toEqual(hashes);
  });

  it('should serialize and deserialize BLOB_DATA message', () => {
    const hash = 'abcdef123456';
    const data = new TextEncoder().encode('Hello, binary world!');
    const mimeType = 'text/plain';
    const msg = createBlobDataMessage(hash, data, mimeType);

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(SyncMessageType.BLOB_DATA);
    expect((deserialized as typeof msg).hash).toBe(hash);
    expect((deserialized as typeof msg).data).toEqual(data);
    expect((deserialized as typeof msg).mimeType).toBe(mimeType);
  });

  it('should serialize and deserialize BLOB_DATA without mimeType', () => {
    const hash = 'abcdef123456';
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const msg = createBlobDataMessage(hash, data);

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(SyncMessageType.BLOB_DATA);
    expect((deserialized as typeof msg).hash).toBe(hash);
    expect((deserialized as typeof msg).data).toEqual(data);
    expect((deserialized as typeof msg).mimeType).toBeUndefined();
  });

  it('should serialize and deserialize BLOB_SYNC_COMPLETE message', () => {
    const msg = createBlobSyncCompleteMessage(42);

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(SyncMessageType.BLOB_SYNC_COMPLETE);
    expect((deserialized as typeof msg).blobCount).toBe(42);
  });

  it('should handle large blob data', () => {
    const hash = 'largehash';
    const data = new Uint8Array(100000).fill(0xaa); // 100KB
    const msg = createBlobDataMessage(hash, data, 'application/octet-stream');

    const serialized = serializeMessage(msg);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.type).toBe(SyncMessageType.BLOB_DATA);
    expect((deserialized as typeof msg).data.length).toBe(100000);
    expect((deserialized as typeof msg).data[0]).toBe(0xaa);
    expect((deserialized as typeof msg).data[99999]).toBe(0xaa);
  });
});

describe('Blob Sync Integration', () => {
  it('should identify missing blobs between stores', async () => {
    const storageA = new MemoryStorageAdapter();
    const storageB = new MemoryStorageAdapter();
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

    const blobStoreA = new BlobStore(storageA, logger);
    const blobStoreB = new BlobStore(storageB, logger);

    // Add blobs to A
    const content1 = new TextEncoder().encode('Content 1');
    const content2 = new TextEncoder().encode('Content 2');
    const hash1 = await blobStoreA.add(content1, 'text/plain');
    const hash2 = await blobStoreA.add(content2, 'text/plain');

    // Add only one blob to B
    await blobStoreB.add(content1, 'text/plain');

    // Get hashes from A
    const hashesA = await blobStoreA.list();
    expect(hashesA.length).toBe(2);

    // B should be missing hash2
    const missingFromB = await blobStoreB.getMissing(hashesA);
    expect(missingFromB.length).toBe(1);
    expect(missingFromB[0]).toBe(hash2);
  });

  it('should sync blobs between stores', async () => {
    const storageA = new MemoryStorageAdapter();
    const storageB = new MemoryStorageAdapter();
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

    const blobStoreA = new BlobStore(storageA, logger);
    const blobStoreB = new BlobStore(storageB, logger);

    // Add unique blobs to each store
    const contentA = new TextEncoder().encode('From A');
    const contentB = new TextEncoder().encode('From B');

    const hashA = await blobStoreA.add(contentA, 'text/plain');
    const hashB = await blobStoreB.add(contentB, 'text/plain');

    // Simulate sync: exchange hash lists
    const hashesA = await blobStoreA.list();
    const hashesB = await blobStoreB.list();

    // Find missing blobs
    const missingFromA = await blobStoreA.getMissing(hashesB);
    const missingFromB = await blobStoreB.getMissing(hashesA);

    expect(missingFromA).toContain(hashB);
    expect(missingFromB).toContain(hashA);

    // Transfer missing blobs
    for (const hash of missingFromA) {
      const data = await blobStoreB.get(hash);
      const meta = await blobStoreB.getMeta(hash);
      if (data) {
        await blobStoreA.add(data, meta?.mimeType);
      }
    }

    for (const hash of missingFromB) {
      const data = await blobStoreA.get(hash);
      const meta = await blobStoreA.getMeta(hash);
      if (data) {
        await blobStoreB.add(data, meta?.mimeType);
      }
    }

    // Both stores should now have both blobs
    expect(await blobStoreA.has(hashA)).toBe(true);
    expect(await blobStoreA.has(hashB)).toBe(true);
    expect(await blobStoreB.has(hashA)).toBe(true);
    expect(await blobStoreB.has(hashB)).toBe(true);

    // Verify content
    const retrievedA = await blobStoreB.get(hashA);
    const retrievedB = await blobStoreA.get(hashB);
    expect(retrievedA).toEqual(contentA);
    expect(retrievedB).toEqual(contentB);
  });

  it('should handle empty blob sync', async () => {
    const storage = new MemoryStorageAdapter();
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const blobStore = new BlobStore(storage, logger);

    // Empty store should handle getMissing gracefully
    const hashes = await blobStore.list();
    expect(hashes).toEqual([]);

    const missing = await blobStore.getMissing(['nonexistent']);
    expect(missing).toEqual(['nonexistent']);
  });
});
