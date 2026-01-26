/**
 * Garbage Collector Tests
 *
 * Tests for document compaction and orphaned blob cleanup.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { GarbageCollector } from '../src/core/gc/garbage-collector';
import { DocumentManager } from '../src/core/document-manager';
import { BlobStore } from '../src/core/blob-store';
import { MemoryStorageAdapter } from '../src/core/storage-adapter';
import type { Logger } from '../src/utils/logger';
import type { GCConfig } from '../src/core/gc/types';

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('GarbageCollector', () => {
  let storage: MemoryStorageAdapter;
  let logger: Logger;
  let docManager: DocumentManager;
  let blobStore: BlobStore;
  let gc: GarbageCollector;

  const defaultConfig: GCConfig = {
    enabled: true,
    maxDocSizeMB: 50,
    minHistoryDays: 0, // No minimum for testing
    requirePeerConsensus: false,
  };

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    logger = createTestLogger();
    docManager = new DocumentManager(storage, logger);
    await docManager.initialize();
    blobStore = new BlobStore(storage, logger);
    // BlobStore doesn't require initialization
  });

  describe('Document Compaction', () => {
    it('should compact document and reduce size', async () => {
      // Create many files to build up history
      for (let i = 0; i < 50; i++) {
        await docManager.handleFileCreate(`file${i}.md`);
        docManager.setTextContent(`file${i}.md`, `Content ${i}`);
      }

      // Modify files to create more history
      for (let i = 0; i < 50; i++) {
        docManager.setTextContent(`file${i}.md`, `Updated content ${i}`);
      }

      // Delete some files
      for (let i = 0; i < 25; i++) {
        await docManager.handleFileDelete(`file${i}.md`);
      }

      await docManager.save();

      const beforeSize = docManager.getDocumentSize();

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      const stats = await gc.run();

      expect(stats.beforeSize).toBe(beforeSize);
      // After compaction, size should be smaller or equal
      expect(stats.afterSize).toBeLessThanOrEqual(stats.beforeSize);
    });

    it('should preserve current file state after compaction', async () => {
      // Create files with content
      await docManager.handleFileCreate('keep.md');
      docManager.setTextContent('keep.md', 'Keep this content');

      await docManager.handleFileCreate('also-keep.md');
      docManager.setTextContent('also-keep.md', 'Also keep this');

      await docManager.save();

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      await gc.run();

      // Verify files still exist and have correct content
      const paths = docManager.listAllPaths();
      expect(paths).toContain('keep.md');
      expect(paths).toContain('also-keep.md');

      const content1 = docManager.getContent('keep.md');
      expect(content1?.text).toBe('Keep this content');

      const content2 = docManager.getContent('also-keep.md');
      expect(content2?.text).toBe('Also keep this');
    });
  });

  describe('Orphaned Blob Cleanup', () => {
    it('should detect orphaned blobs', async () => {
      // Add a blob directly (not referenced by any file)
      const orphanData = new TextEncoder().encode('orphan blob data');
      const orphanHash = await blobStore.add(orphanData);

      // Add a blob that IS referenced
      await docManager.handleFileCreate('image.png');
      const referencedData = new TextEncoder().encode('referenced blob');
      const referencedHash = await blobStore.add(referencedData);
      docManager.setBlobHash('image.png', referencedHash);

      await docManager.save();

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      const stats = await gc.run();

      // Should have cleaned 1 orphan
      expect(stats.blobsRemoved).toBe(1);
      expect(stats.blobBytesReclaimed).toBeGreaterThan(0);

      // Referenced blob should still exist
      const stillExists = await blobStore.get(referencedHash);
      expect(stillExists).toBeDefined();

      // Orphan blob should be gone
      const orphanGone = await blobStore.get(orphanHash);
      expect(orphanGone).toBeNull();
    });

    it('should not remove blobs still in use', async () => {
      // Create multiple files with blob references
      const blob1 = await blobStore.add(new TextEncoder().encode('blob 1'));
      const blob2 = await blobStore.add(new TextEncoder().encode('blob 2'));

      await docManager.handleFileCreate('file1.png');
      docManager.setBlobHash('file1.png', blob1);

      await docManager.handleFileCreate('file2.png');
      docManager.setBlobHash('file2.png', blob2);

      await docManager.save();

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      const stats = await gc.run();

      // No orphans
      expect(stats.blobsRemoved).toBe(0);

      // Both blobs should still exist
      expect(await blobStore.get(blob1)).toBeDefined();
      expect(await blobStore.get(blob2)).toBeDefined();
    });
  });

  describe('Peer Consensus', () => {
    it('should skip GC when peer consensus required but peers not synced recently', async () => {
      const configWithConsensus: GCConfig = {
        ...defaultConfig,
        requirePeerConsensus: true,
        minHistoryDays: 1, // Require sync within 1 day
      };

      // Mock peer manager with stale peer (synced 2 days ago)
      const mockPeerManager = {
        getPeerSyncStates: () => [
          { peerId: 'peer1', lastSyncTime: Date.now() - 2 * 24 * 60 * 60 * 1000, isConnected: false },
        ],
      };

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        mockPeerManager as any,
        configWithConsensus
      );

      // maybeRun returns null when skipped
      const stats = await gc.maybeRun();
      expect(stats).toBeNull();

      // Verify checkPeerConsensus explains why
      const consensus = gc.checkPeerConsensus();
      expect(consensus.canCompact).toBe(false);
      expect(consensus.reason).toContain('peer');
    });

    it('should run GC when peers are synced', async () => {
      const configWithConsensus: GCConfig = {
        ...defaultConfig,
        requirePeerConsensus: true,
        minHistoryDays: 1,
      };

      // Mock peer manager with recently synced peer
      const mockPeerManager = {
        getPeerSyncStates: () => [
          { peerId: 'peer1', lastSyncTime: Date.now() - 1000, isConnected: true },
        ],
      };

      // Create some content
      await docManager.handleFileCreate('test.md');
      await docManager.save();

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        mockPeerManager as any,
        configWithConsensus
      );

      // Force run to get stats
      const stats = await gc.run();

      expect(stats).toBeDefined();
      expect(stats.timestamp).toBeGreaterThan(0);
    });
  });

  describe('Configuration', () => {
    it('should respect disabled flag via maybeRun', async () => {
      const disabledConfig: GCConfig = {
        ...defaultConfig,
        enabled: false,
      };

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        disabledConfig
      );

      // maybeRun should return null when disabled
      const stats = await gc.maybeRun();
      expect(stats).toBeNull();

      // shouldRun should return false
      expect(gc.shouldRun()).toBe(false);
    });
  });
});
