/**
 * Blob Store - Content-addressed storage for binary files
 *
 * Stores binary files by their content hash (SHA-256).
 * The Loro document only stores references (hashes) to blobs.
 */

import type { StorageAdapter } from '../types';
import type { Logger } from '../utils/logger';

const BLOB_PREFIX = 'blob:';
const BLOB_META_PREFIX = 'blob-meta:';

/** Metadata stored for each blob */
export interface BlobMeta {
  hash: string;
  size: number;
  mimeType: string;
  createdAt: number;
  refCount: number;
}

/**
 * Content-addressed blob storage.
 */
export class BlobStore {
  constructor(
    private storage: StorageAdapter,
    private logger: Logger
  ) {}

  /**
   * Add content to the blob store.
   * Returns the content hash.
   */
  async add(content: Uint8Array, mimeType: string = 'application/octet-stream'): Promise<string> {
    const hash = await this.hashContent(content);

    // Check if blob already exists
    const existing = await this.getMeta(hash);
    if (existing) {
      // Increment reference count
      existing.refCount++;
      await this.saveMeta(hash, existing);
      this.logger.debug('Blob already exists, incremented ref count:', hash);
      return hash;
    }

    // Store the blob
    await this.storage.write(BLOB_PREFIX + hash, content);

    // Store metadata
    const meta: BlobMeta = {
      hash,
      size: content.length,
      mimeType,
      createdAt: Date.now(),
      refCount: 1,
    };
    await this.saveMeta(hash, meta);

    this.logger.debug('Added blob:', hash, 'size:', content.length);
    return hash;
  }

  /**
   * Get blob content by hash.
   */
  async get(hash: string): Promise<Uint8Array | null> {
    return this.storage.read(BLOB_PREFIX + hash);
  }

  /**
   * Check if blob exists.
   */
  async has(hash: string): Promise<boolean> {
    return this.storage.exists(BLOB_PREFIX + hash);
  }

  /**
   * Get blob metadata.
   */
  async getMeta(hash: string): Promise<BlobMeta | null> {
    const data = await this.storage.read(BLOB_META_PREFIX + hash);
    if (!data) return null;

    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return null;
    }
  }

  /**
   * List all blob hashes.
   */
  async list(): Promise<string[]> {
    const keys = await this.storage.list(BLOB_PREFIX);
    return keys.map((k) => k.slice(BLOB_PREFIX.length));
  }

  /**
   * Decrement reference count. Removes blob if count reaches 0.
   */
  async release(hash: string): Promise<void> {
    const meta = await this.getMeta(hash);
    if (!meta) return;

    meta.refCount--;

    if (meta.refCount <= 0) {
      // Remove blob and metadata
      await this.storage.delete(BLOB_PREFIX + hash);
      await this.storage.delete(BLOB_META_PREFIX + hash);
      this.logger.debug('Removed blob (ref count 0):', hash);
    } else {
      await this.saveMeta(hash, meta);
      this.logger.debug('Decremented blob ref count:', hash, 'new count:', meta.refCount);
    }
  }

  /**
   * Get total storage used by blobs.
   */
  async getTotalSize(): Promise<number> {
    const hashes = await this.list();
    let total = 0;

    for (const hash of hashes) {
      const meta = await this.getMeta(hash);
      if (meta) {
        total += meta.size;
      }
    }

    return total;
  }

  /**
   * Get list of missing blobs (hashes that don't exist locally).
   */
  async getMissing(hashes: string[]): Promise<string[]> {
    const missing: string[] = [];

    for (const hash of hashes) {
      if (!(await this.has(hash))) {
        missing.push(hash);
      }
    }

    return missing;
  }

  /**
   * Compute SHA-256 hash of content.
   */
  private async hashContent(content: Uint8Array): Promise<string> {
    // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
    const buffer = new ArrayBuffer(content.length);
    new Uint8Array(buffer).set(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Save blob metadata.
   */
  private async saveMeta(hash: string, meta: BlobMeta): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(meta));
    await this.storage.write(BLOB_META_PREFIX + hash, data);
  }
}

/**
 * Determine if a file should be stored as a blob (binary) vs text.
 */
export function isBinaryFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  const binaryExtensions = new Set([
    // Images
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'ico',
    'bmp',
    'tiff',
    'tif',
    // Audio
    'mp3',
    'wav',
    'm4a',
    'ogg',
    'flac',
    'aac',
    // Video
    'mp4',
    'webm',
    'mov',
    'avi',
    'mkv',
    // Documents
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    // Archives
    'zip',
    'tar',
    'gz',
    'rar',
    '7z',
    // Other
    'exe',
    'dll',
    'so',
    'dylib',
    'wasm',
    'ttf',
    'otf',
    'woff',
    'woff2',
    'eot',
  ]);

  return binaryExtensions.has(ext);
}

/**
 * Get MIME type for a filename.
 */
export function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  const mimeTypes: Record<string, string> = {
    // Text
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    css: 'text/css',
    js: 'application/javascript',
    ts: 'application/typescript',
    html: 'text/html',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    // Documents
    pdf: 'application/pdf',
    // Archives
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    // Fonts
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
  };

  return mimeTypes[ext] ?? 'application/octet-stream';
}
