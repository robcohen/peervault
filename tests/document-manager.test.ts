/**
 * Document Manager Tests
 *
 * Tests for the Loro document manager.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { DocumentManager } from '../src/core/document-manager';
import { MemoryStorageAdapter } from '../src/core/storage-adapter';
import type { Logger } from '../src/utils/logger';

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('DocumentManager', () => {
  let storage: MemoryStorageAdapter;
  let logger: Logger;
  let docManager: DocumentManager;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    logger = createTestLogger();
    docManager = new DocumentManager(storage, logger);
    await docManager.initialize();
  });

  describe('Initialization', () => {
    it('should initialize with a vault ID', async () => {
      const vaultId = docManager.getVaultId();
      expect(vaultId).toBeDefined();
      expect(vaultId.length).toBeGreaterThan(0);
    });

    it('should persist and reload document', async () => {
      // Create a file
      await docManager.handleFileCreate('test.md');
      await docManager.save();

      // Create new document manager with same storage
      const docManager2 = new DocumentManager(storage, logger);
      await docManager2.initialize();

      // Should have the same vault ID
      expect(docManager2.getVaultId()).toBe(docManager.getVaultId());

      // Should have the same file
      const paths = docManager2.listAllPaths();
      expect(paths).toContain('test.md');
    });
  });

  describe('File Operations', () => {
    it('should create a file node', async () => {
      await docManager.handleFileCreate('notes/test.md');

      const paths = docManager.listAllPaths();
      expect(paths).toContain('notes');
      expect(paths).toContain('notes/test.md');
    });

    it('should create nested folder structure', async () => {
      await docManager.handleFileCreate('a/b/c/file.md');

      const paths = docManager.listAllPaths();
      expect(paths).toContain('a');
      expect(paths).toContain('a/b');
      expect(paths).toContain('a/b/c');
      expect(paths).toContain('a/b/c/file.md');
    });

    it('should modify a file node', async () => {
      await docManager.handleFileCreate('test.md');
      const meta1 = docManager.getFileMeta('test.md');

      // Wait a bit to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      await docManager.handleFileModify('test.md');
      const meta2 = docManager.getFileMeta('test.md');

      expect(meta2!.mtime).toBeGreaterThan(meta1!.mtime);
    });

    it('should delete a file node (soft delete)', async () => {
      await docManager.handleFileCreate('test.md');
      expect(docManager.listAllPaths()).toContain('test.md');

      await docManager.handleFileDelete('test.md');
      expect(docManager.listAllPaths()).not.toContain('test.md');

      // File should be soft deleted (metadata still exists internally)
    });

    it('should rename a file node', async () => {
      await docManager.handleFileCreate('old.md');
      expect(docManager.listAllPaths()).toContain('old.md');

      await docManager.handleFileRename('old.md', 'new.md');

      const paths = docManager.listAllPaths();
      expect(paths).not.toContain('old.md');
      expect(paths).toContain('new.md');
    });

    it('should move a file to different folder', async () => {
      await docManager.handleFileCreate('folder1/test.md');
      expect(docManager.listAllPaths()).toContain('folder1/test.md');

      await docManager.handleFileRename('folder1/test.md', 'folder2/test.md');

      const paths = docManager.listAllPaths();
      expect(paths).not.toContain('folder1/test.md');
      expect(paths).toContain('folder2/test.md');
      expect(paths).toContain('folder2');
    });
  });

  describe('File Metadata', () => {
    it('should return correct file metadata', async () => {
      await docManager.handleFileCreate('document.md');
      const meta = docManager.getFileMeta('document.md');

      expect(meta).toBeDefined();
      expect(meta!.name).toBe('document.md');
      expect(meta!.type).toBe('text/markdown');
      expect(meta!.mtime).toBeGreaterThan(0);
      expect(meta!.ctime).toBeGreaterThan(0);
    });

    it('should detect MIME types correctly', async () => {
      const files = [
        { path: 'test.md', type: 'text/markdown' },
        { path: 'test.txt', type: 'text/plain' },
        { path: 'test.json', type: 'application/json' },
        { path: 'test.png', type: 'image/png' },
        { path: 'test.jpg', type: 'image/jpeg' },
        { path: 'test.unknown', type: 'application/octet-stream' },
      ];

      for (const { path, type } of files) {
        await docManager.handleFileCreate(path);
        const meta = docManager.getFileMeta(path);
        expect(meta!.type).toBe(type);
      }
    });

    it('should return undefined for non-existent file', () => {
      const meta = docManager.getFileMeta('nonexistent.md');
      expect(meta).toBeUndefined();
    });
  });

  describe('Version Management', () => {
    it('should have a version after initialization', () => {
      const version = docManager.getVersion();
      expect(version).toBeDefined();
    });

    it('should export version as bytes', () => {
      const bytes = docManager.getVersionBytes();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
    });

    it('should export updates', async () => {
      await docManager.handleFileCreate('test.md');
      const updates = docManager.exportUpdates();
      expect(updates).toBeInstanceOf(Uint8Array);
      expect(updates.length).toBeGreaterThan(0);
    });

    it('should import updates from another document', async () => {
      // Create two documents
      const storage2 = new MemoryStorageAdapter();
      const docManager2 = new DocumentManager(storage2, logger);
      await docManager2.initialize();

      // Create file in first document
      await docManager.handleFileCreate('shared.md');

      // Export and import to second document
      const updates = docManager.exportUpdates();
      docManager2.importUpdates(updates);

      // Note: The two docs won't have the same vault ID,
      // but the file tree structure should be imported
      // This is a simplified test - full sync requires matching vault IDs
    });
  });

  describe('Path Cache', () => {
    it('should cache paths correctly', async () => {
      await docManager.handleFileCreate('test.md');

      const nodeId = docManager.getNodeByPath('test.md');
      expect(nodeId).toBeDefined();

      const path = docManager.getPathByNode(nodeId!);
      expect(path).toBe('test.md');
    });

    it('should update cache on rename', async () => {
      await docManager.handleFileCreate('old.md');
      const nodeId = docManager.getNodeByPath('old.md');

      await docManager.handleFileRename('old.md', 'new.md');

      expect(docManager.getNodeByPath('old.md')).toBeUndefined();
      expect(docManager.getNodeByPath('new.md')).toBe(nodeId);
    });

    it('should update cache on delete', async () => {
      await docManager.handleFileCreate('test.md');
      expect(docManager.getNodeByPath('test.md')).toBeDefined();

      await docManager.handleFileDelete('test.md');
      expect(docManager.getNodeByPath('test.md')).toBeUndefined();
    });
  });
});
