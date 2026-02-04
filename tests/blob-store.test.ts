/**
 * Blob Store Tests
 *
 * Tests for content-addressed binary storage.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { BlobStore, isBinaryFile, getMimeType } from '../src/core/blob-store';
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

describe('BlobStore', () => {
  let storage: MemoryStorageAdapter;
  let blobStore: BlobStore;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    blobStore = new BlobStore(storage, createTestLogger());
  });

  describe('Basic Operations', () => {
    it('should add and retrieve a blob', async () => {
      const content = new TextEncoder().encode('Hello, World!');
      const hash = await blobStore.add(content, 'text/plain');

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64); // SHA-256 = 64 hex chars

      const retrieved = await blobStore.get(hash);
      expect(retrieved).toEqual(content);
    });

    it('should deduplicate identical content', async () => {
      const content = new TextEncoder().encode('Duplicate content');

      const hash1 = await blobStore.add(content, 'text/plain');
      const hash2 = await blobStore.add(content, 'text/plain');

      expect(hash1).toBe(hash2);

      // Check ref count increased
      const meta = await blobStore.getMeta(hash1);
      expect(meta?.refCount).toBe(2);
    });

    it('should return null for non-existent blob', async () => {
      const result = await blobStore.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should check if blob exists', async () => {
      const content = new TextEncoder().encode('Test');
      const hash = await blobStore.add(content);

      expect(await blobStore.has(hash)).toBe(true);
      expect(await blobStore.has('nonexistent')).toBe(false);
    });
  });

  describe('Metadata', () => {
    it('should store and retrieve metadata', async () => {
      const content = new Uint8Array([1, 2, 3, 4, 5]);
      const hash = await blobStore.add(content, 'application/octet-stream');

      const meta = await blobStore.getMeta(hash);

      expect(meta).toBeDefined();
      expect(meta?.hash).toBe(hash);
      expect(meta?.size).toBe(5);
      expect(meta?.mimeType).toBe('application/octet-stream');
      expect(meta?.refCount).toBe(1);
      expect(meta?.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('should return null for non-existent metadata', async () => {
      const meta = await blobStore.getMeta('nonexistent');
      expect(meta).toBeNull();
    });
  });

  describe('Reference Counting', () => {
    it('should release blob when ref count reaches 0', async () => {
      const content = new TextEncoder().encode('Temporary');
      const hash = await blobStore.add(content);

      expect(await blobStore.has(hash)).toBe(true);

      await blobStore.release(hash);

      expect(await blobStore.has(hash)).toBe(false);
      expect(await blobStore.getMeta(hash)).toBeNull();
    });

    it('should not release blob with multiple refs', async () => {
      const content = new TextEncoder().encode('Shared');
      const hash = await blobStore.add(content);
      await blobStore.add(content); // Second ref

      await blobStore.release(hash);

      // Should still exist with ref count 1
      expect(await blobStore.has(hash)).toBe(true);
      const meta = await blobStore.getMeta(hash);
      expect(meta?.refCount).toBe(1);
    });
  });

  describe('Listing', () => {
    it('should list all blobs', async () => {
      const content1 = new TextEncoder().encode('Content 1');
      const content2 = new TextEncoder().encode('Content 2');
      const content3 = new TextEncoder().encode('Content 3');

      const hash1 = await blobStore.add(content1);
      const hash2 = await blobStore.add(content2);
      const hash3 = await blobStore.add(content3);

      const list = await blobStore.list();

      expect(list).toContain(hash1);
      expect(list).toContain(hash2);
      expect(list).toContain(hash3);
      expect(list.length).toBe(3);
    });

    it('should return empty list when no blobs', async () => {
      const list = await blobStore.list();
      expect(list).toEqual([]);
    });
  });

  describe('Storage Size', () => {
    it('should calculate total storage size', async () => {
      const content1 = new Uint8Array(100).fill(1);
      const content2 = new Uint8Array(200).fill(2);
      const content3 = new Uint8Array(300).fill(3);

      await blobStore.add(content1);
      await blobStore.add(content2);
      await blobStore.add(content3);

      const totalSize = await blobStore.getTotalSize();
      expect(totalSize).toBe(600);
    });
  });

  describe('Missing Blobs', () => {
    it('should find missing blobs', async () => {
      const content = new TextEncoder().encode('Exists');
      const existingHash = await blobStore.add(content);

      const hashes = [existingHash, 'missing1', 'missing2'];
      const missing = await blobStore.getMissing(hashes);

      expect(missing).toContain('missing1');
      expect(missing).toContain('missing2');
      expect(missing).not.toContain(existingHash);
      expect(missing.length).toBe(2);
    });

    it('should return empty when no blobs are missing', async () => {
      const content = new TextEncoder().encode('Exists');
      const hash = await blobStore.add(content);

      const missing = await blobStore.getMissing([hash]);
      expect(missing).toEqual([]);
    });
  });

  describe('Hash Consistency', () => {
    it('should produce consistent hashes', async () => {
      const content = new TextEncoder().encode('Deterministic');

      const hash1 = await blobStore.add(content);

      // Create new blob store with new storage
      const storage2 = new MemoryStorageAdapter();
      const blobStore2 = new BlobStore(storage2, createTestLogger());

      const hash2 = await blobStore2.add(content);

      expect(hash1).toBe(hash2);
    });
  });

  describe('Integrity Verification', () => {
    it('should verify and add blob with correct hash', async () => {
      const content = new TextEncoder().encode('Verify me');
      const expectedHash = await blobStore.computeHash(content);

      const result = await blobStore.verifyAndAdd(content, expectedHash, 'text/plain');

      expect(result).toBe(true);
      expect(await blobStore.has(expectedHash)).toBe(true);
    });

    it('should reject blob with incorrect hash', async () => {
      const content = new TextEncoder().encode('Corrupted data');
      const wrongHash = 'a'.repeat(64); // Wrong hash

      const result = await blobStore.verifyAndAdd(content, wrongHash, 'text/plain');

      expect(result).toBe(false);
      expect(await blobStore.has(wrongHash)).toBe(false);
    });

    it('should compute hash correctly', async () => {
      const content = new TextEncoder().encode('Hash me');

      const hash = await blobStore.computeHash(content);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(64); // SHA-256 = 64 hex chars
    });

    it('should compute same hash as add method', async () => {
      const content = new TextEncoder().encode('Same hash');

      const computedHash = await blobStore.computeHash(content);
      const addedHash = await blobStore.add(content, 'text/plain');

      expect(computedHash).toBe(addedHash);
    });
  });
});

describe('Binary File Detection', () => {
  it('should detect image files as binary', () => {
    expect(isBinaryFile('photo.png')).toBe(true);
    expect(isBinaryFile('image.jpg')).toBe(true);
    expect(isBinaryFile('icon.gif')).toBe(true);
    expect(isBinaryFile('graphic.webp')).toBe(true);
  });

  it('should detect audio files as binary', () => {
    expect(isBinaryFile('song.mp3')).toBe(true);
    expect(isBinaryFile('audio.wav')).toBe(true);
    expect(isBinaryFile('track.m4a')).toBe(true);
  });

  it('should detect video files as binary', () => {
    expect(isBinaryFile('movie.mp4')).toBe(true);
    expect(isBinaryFile('clip.webm')).toBe(true);
    expect(isBinaryFile('video.mov')).toBe(true);
  });

  it('should detect document files as binary', () => {
    expect(isBinaryFile('document.pdf')).toBe(true);
    expect(isBinaryFile('archive.zip')).toBe(true);
  });

  it('should not detect text files as binary', () => {
    expect(isBinaryFile('notes.md')).toBe(false);
    expect(isBinaryFile('readme.txt')).toBe(false);
    expect(isBinaryFile('config.json')).toBe(false);
    expect(isBinaryFile('styles.css')).toBe(false);
  });
});

describe('MIME Type Detection', () => {
  it('should detect text MIME types', () => {
    expect(getMimeType('file.md')).toBe('text/markdown');
    expect(getMimeType('file.txt')).toBe('text/plain');
    expect(getMimeType('file.json')).toBe('application/json');
    expect(getMimeType('file.html')).toBe('text/html');
  });

  it('should detect image MIME types', () => {
    expect(getMimeType('file.png')).toBe('image/png');
    expect(getMimeType('file.jpg')).toBe('image/jpeg');
    expect(getMimeType('file.gif')).toBe('image/gif');
    expect(getMimeType('file.svg')).toBe('image/svg+xml');
  });

  it('should detect audio/video MIME types', () => {
    expect(getMimeType('file.mp3')).toBe('audio/mpeg');
    expect(getMimeType('file.mp4')).toBe('video/mp4');
    expect(getMimeType('file.webm')).toBe('video/webm');
  });

  it('should return octet-stream for unknown types', () => {
    expect(getMimeType('file.xyz')).toBe('application/octet-stream');
    expect(getMimeType('file')).toBe('application/octet-stream');
  });
});
