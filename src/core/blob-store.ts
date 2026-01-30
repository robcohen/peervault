/**
 * Blob Store - Content-addressed storage for binary files
 *
 * Stores binary files by their content hash (SHA-256).
 * The Loro document only stores references (hashes) to blobs.
 */

import type { StorageAdapter } from "../types";
import type { Logger } from "../utils/logger";

const BLOB_PREFIX = "blob:";
const BLOB_META_PREFIX = "blob-meta:";

/** Default maximum blob size: 500 MB */
const DEFAULT_MAX_BLOB_SIZE = 500 * 1024 * 1024;

/** Metadata stored for each blob */
export interface BlobMeta {
  hash: string;
  size: number;
  mimeType: string;
  createdAt: number;
  refCount: number;
}

/** Configuration for blob store */
export interface BlobStoreConfig {
  /** Maximum blob size in bytes (default: 500 MB) */
  maxBlobSize?: number;
}

/**
 * Content-addressed blob storage.
 */
export class BlobStore {
  private maxBlobSize: number;
  private cachedTotalSize: number | null = null;

  constructor(
    private storage: StorageAdapter,
    private logger: Logger,
    config?: BlobStoreConfig,
  ) {
    this.maxBlobSize = config?.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE;
  }

  /**
   * Add content to the blob store.
   * Returns the content hash.
   * @throws Error if content exceeds max blob size
   */
  async add(
    content: Uint8Array,
    mimeType: string = "application/octet-stream",
  ): Promise<string> {
    // Validate blob size
    if (content.length > this.maxBlobSize) {
      const sizeMB = (content.length / (1024 * 1024)).toFixed(1);
      const maxMB = (this.maxBlobSize / (1024 * 1024)).toFixed(0);
      throw new Error(`Blob size ${sizeMB}MB exceeds maximum ${maxMB}MB`);
    }

    const hash = await this.hashContent(content);

    // Check if blob already exists
    const existing = await this.getMeta(hash);
    if (existing) {
      // Increment reference count
      existing.refCount++;
      await this.saveMeta(hash, existing);
      this.logger.debug("Blob already exists, incremented ref count:", hash);
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

    // Invalidate cached total size
    this.cachedTotalSize = null;

    this.logger.debug("Added blob:", hash, "size:", content.length);
    return hash;
  }

  /**
   * Get the maximum allowed blob size.
   */
  getMaxBlobSize(): number {
    return this.maxBlobSize;
  }

  /**
   * Check if a blob size is within limits.
   */
  isValidSize(size: number): boolean {
    return size <= this.maxBlobSize;
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
      // Invalidate cached total size
      this.cachedTotalSize = null;
      this.logger.debug("Removed blob (ref count 0):", hash);
    } else {
      await this.saveMeta(hash, meta);
      this.logger.debug(
        "Decremented blob ref count:",
        hash,
        "new count:",
        meta.refCount,
      );
    }
  }

  /**
   * Get total storage used by blobs.
   * Uses caching for better performance on repeated calls.
   */
  async getTotalSize(): Promise<number> {
    // Return cached value if available
    if (this.cachedTotalSize !== null) {
      return this.cachedTotalSize;
    }

    const hashes = await this.list();

    // Batch metadata lookups in parallel (batches of 10)
    const BATCH_SIZE = 10;
    let total = 0;

    for (let i = 0; i < hashes.length; i += BATCH_SIZE) {
      const batch = hashes.slice(i, i + BATCH_SIZE);
      const metas = await Promise.all(batch.map((hash) => this.getMeta(hash)));
      for (const meta of metas) {
        if (meta) {
          total += meta.size;
        }
      }
    }

    // Cache the result
    this.cachedTotalSize = total;
    return total;
  }

  /**
   * Get list of missing blobs (hashes that don't exist locally).
   * Uses parallel existence checks for better performance.
   */
  async getMissing(hashes: string[]): Promise<string[]> {
    if (hashes.length === 0) return [];

    // Check existence in parallel (batches of 20)
    const BATCH_SIZE = 20;
    const missing: string[] = [];

    for (let i = 0; i < hashes.length; i += BATCH_SIZE) {
      const batch = hashes.slice(i, i + BATCH_SIZE);
      const existsResults = await Promise.all(batch.map((hash) => this.has(hash)));

      for (let j = 0; j < batch.length; j++) {
        if (!existsResults[j]) {
          missing.push(batch[j]!);
        }
      }
    }

    return missing;
  }

  /**
   * Invalidate the total size cache.
   * Call this after bulk operations that modify blobs.
   */
  invalidateSizeCache(): void {
    this.cachedTotalSize = null;
  }

  /**
   * Find orphaned blobs that are not referenced by the document.
   *
   * @param referencedHashes Set of hashes that are currently referenced
   * @returns List of orphaned blob info
   */
  async findOrphans(
    referencedHashes: Set<string>,
  ): Promise<Array<{ hash: string; size: number; createdAt?: number }>> {
    const allHashes = await this.list();
    const orphans: Array<{ hash: string; size: number; createdAt?: number }> =
      [];

    for (const hash of allHashes) {
      if (!referencedHashes.has(hash)) {
        const meta = await this.getMeta(hash);
        if (meta) {
          orphans.push({
            hash,
            size: meta.size,
            createdAt: meta.createdAt,
          });
        }
      }
    }

    return orphans;
  }

  /**
   * Remove orphaned blobs that are not referenced by the document.
   *
   * @param referencedHashes Set of hashes that are currently referenced
   * @returns Number of bytes reclaimed
   */
  async cleanOrphans(
    referencedHashes: Set<string>,
  ): Promise<{ count: number; bytesReclaimed: number }> {
    const orphans = await this.findOrphans(referencedHashes);
    let bytesReclaimed = 0;

    for (const orphan of orphans) {
      try {
        await this.storage.delete(BLOB_PREFIX + orphan.hash);
        await this.storage.delete(BLOB_META_PREFIX + orphan.hash);
        bytesReclaimed += orphan.size;
        this.logger.debug(
          "Removed orphan blob:",
          orphan.hash,
          "size:",
          orphan.size,
        );
      } catch (error) {
        this.logger.warn("Failed to remove orphan blob:", orphan.hash, error);
      }
    }

    if (orphans.length > 0) {
      // Invalidate cached total size
      this.cachedTotalSize = null;
      this.logger.info(
        `Cleaned ${orphans.length} orphan blobs, reclaimed ${bytesReclaimed} bytes`,
      );
    }

    return { count: orphans.length, bytesReclaimed };
  }

  /**
   * Compute SHA-256 hash of content.
   */
  private async hashContent(content: Uint8Array): Promise<string> {
    // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
    const buffer = new ArrayBuffer(content.length);
    new Uint8Array(buffer).set(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
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
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  const binaryExtensions = new Set([
    // Images
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "ico",
    "bmp",
    "tiff",
    "tif",
    // Audio
    "mp3",
    "wav",
    "m4a",
    "ogg",
    "flac",
    "aac",
    // Video
    "mp4",
    "webm",
    "mov",
    "avi",
    "mkv",
    // Documents
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    // Archives
    "zip",
    "tar",
    "gz",
    "rar",
    "7z",
    // Other
    "exe",
    "dll",
    "so",
    "dylib",
    "wasm",
    "ttf",
    "otf",
    "woff",
    "woff2",
    "eot",
  ]);

  return binaryExtensions.has(ext);
}

/**
 * Get MIME type for a filename.
 */
export function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  const mimeTypes: Record<string, string> = {
    // Text
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    css: "text/css",
    js: "application/javascript",
    ts: "application/typescript",
    html: "text/html",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    // Images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    bmp: "image/bmp",
    // Audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    flac: "audio/flac",
    // Video
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    // Documents
    pdf: "application/pdf",
    // Archives
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    // Fonts
    ttf: "font/ttf",
    otf: "font/otf",
    woff: "font/woff",
    woff2: "font/woff2",
  };

  return mimeTypes[ext] ?? "application/octet-stream";
}
