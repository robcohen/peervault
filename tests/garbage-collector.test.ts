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

    it('should return a copy of config (not reference)', () => {
      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      const config1 = gc.getConfig();
      config1.maxDocSizeMB = 999;

      const config2 = gc.getConfig();
      expect(config2.maxDocSizeMB).toBe(defaultConfig.maxDocSizeMB);
    });

    it('should update config', () => {
      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      gc.updateConfig({ enabled: false, maxDocSizeMB: 100 });

      const config = gc.getConfig();
      expect(config.enabled).toBe(false);
      expect(config.maxDocSizeMB).toBe(100);
      expect(config.minHistoryDays).toBe(defaultConfig.minHistoryDays);
    });
  });

  describe('Checkpoints', () => {
    it('should create checkpoint during run', async () => {
      await docManager.handleFileCreate('test.md');
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

      const checkpoints = await gc.listCheckpoints();
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints[0]!.timestamp).toBeGreaterThan(0);
      expect(checkpoints[0]!.documentSize).toBeGreaterThan(0);
    });

    it('should list checkpoints sorted by timestamp descending', async () => {
      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      // Run GC twice to create multiple checkpoints
      await docManager.handleFileCreate('file1.md');
      await docManager.save();
      await gc.run();

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      await docManager.handleFileCreate('file2.md');
      await docManager.save();
      await gc.run();

      const checkpoints = await gc.listCheckpoints();
      expect(checkpoints.length).toBe(2);
      expect(checkpoints[0]!.timestamp).toBeGreaterThan(checkpoints[1]!.timestamp);
    });

    it('should prune old checkpoints', async () => {
      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      // Create several checkpoints
      for (let i = 0; i < 5; i++) {
        await docManager.handleFileCreate(`file${i}.md`);
        await docManager.save();
        await gc.run();
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      const beforePrune = await gc.listCheckpoints();
      expect(beforePrune.length).toBe(5);

      const pruned = await gc.pruneCheckpoints(2);
      expect(pruned).toBe(3);

      const afterPrune = await gc.listCheckpoints();
      expect(afterPrune.length).toBe(2);
    });

    it('should return 0 when no checkpoints to prune', async () => {
      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      // Create only 1 checkpoint
      await docManager.handleFileCreate('test.md');
      await docManager.save();
      await gc.run();

      const pruned = await gc.pruneCheckpoints(5);
      expect(pruned).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return current stats without running GC', async () => {
      await docManager.handleFileCreate('test.md');
      docManager.setTextContent('test.md', 'Some content');
      await docManager.save();

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        { ...defaultConfig, maxDocSizeMB: 50 }
      );

      const stats = await gc.getStats();

      expect(stats.documentSize).toBeGreaterThan(0);
      expect(stats.maxSize).toBe(50 * 1024 * 1024);
      expect(stats.shouldRun).toBe(false); // doc is small
      expect(stats.orphanedBlobCount).toBe(0);
      expect(stats.peerConsensus.canCompact).toBe(true);
    });

    it('should detect orphaned blobs in stats', async () => {
      // Create orphan blob
      await blobStore.add(new TextEncoder().encode('orphan data'));

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      const stats = await gc.getStats();

      expect(stats.orphanedBlobCount).toBe(1);
      expect(stats.orphanedBlobSize).toBeGreaterThan(0);
    });

    it('should include peer consensus info in stats', async () => {
      const mockPeerManager = {
        getPeerSyncStates: () => [
          { peerId: 'peer1', peerName: 'Stale Phone', lastSyncTime: Date.now() - 60 * 24 * 60 * 60 * 1000, isConnected: false },
        ],
      };

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        mockPeerManager as any,
        { ...defaultConfig, requirePeerConsensus: true, minHistoryDays: 30 }
      );

      const stats = await gc.getStats();

      expect(stats.peerConsensus.canCompact).toBe(false);
      expect(stats.peerConsensus.reason).toContain('Stale Phone');
    });
  });

  describe('cleanOrphanedBlobs', () => {
    it('should clean orphans without compacting document', async () => {
      // Create orphan blob
      const orphanHash = await blobStore.add(new TextEncoder().encode('orphan'));

      // Create referenced blob
      const referencedHash = await blobStore.add(new TextEncoder().encode('referenced'));
      await docManager.handleFileCreate('file.png');
      docManager.setBlobHash('file.png', referencedHash);
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

      const result = await gc.cleanOrphanedBlobs();

      expect(result.count).toBe(1);
      expect(result.bytesReclaimed).toBeGreaterThan(0);

      // Document should not have been compacted
      expect(docManager.getDocumentSize()).toBe(beforeSize);

      // Orphan gone, referenced still there
      expect(await blobStore.get(orphanHash)).toBeNull();
      expect(await blobStore.get(referencedHash)).toBeDefined();
    });
  });

  describe('Progress Callbacks', () => {
    it('should call progress callback during run', async () => {
      await docManager.handleFileCreate('test.md');
      await docManager.save();

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      const progressCalls: Array<{ percent: number; message: string }> = [];

      await gc.run((percent, message) => {
        progressCalls.push({ percent, message });
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      expect(progressCalls[0]!.percent).toBe(0);
      expect(progressCalls[progressCalls.length - 1]!.percent).toBe(100);
    });

    it('should call progress callback during cleanOrphanedBlobs', async () => {
      await blobStore.add(new TextEncoder().encode('orphan'));

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        defaultConfig
      );

      const progressCalls: number[] = [];

      await gc.cleanOrphanedBlobs((percent) => {
        progressCalls.push(percent);
      });

      expect(progressCalls).toContain(0);
      expect(progressCalls).toContain(50);
      expect(progressCalls).toContain(100);
    });
  });

  describe('Force Run', () => {
    it('should run GC with force even when conditions not met', async () => {
      const disabledConfig: GCConfig = {
        enabled: false,
        maxDocSizeMB: 1000, // very high threshold
        minHistoryDays: 0,
        requirePeerConsensus: false,
      };

      await docManager.handleFileCreate('test.md');
      await docManager.save();

      gc = new GarbageCollector(
        docManager,
        blobStore,
        storage,
        logger,
        undefined,
        disabledConfig
      );

      // Should not run normally
      expect(gc.shouldRun()).toBe(false);
      const normalResult = await gc.maybeRun();
      expect(normalResult).toBeNull();

      // Should run with force
      const forcedResult = await gc.maybeRun(true);
      expect(forcedResult).not.toBeNull();
      expect(forcedResult!.timestamp).toBeGreaterThan(0);
    });
  });
});
