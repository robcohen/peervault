/**
 * Storage Adapter - Obsidian storage implementation
 *
 * Provides a unified storage interface on top of Obsidian's plugin data API.
 */

import type { Plugin } from "obsidian";
import type { StorageAdapter } from "../types";
import { createLogger, type Logger } from "../utils/logger";

const STORAGE_PREFIX = "peervault-storage/";

/** Maximum number of items to keep in cache */
const MAX_CACHE_ITEMS = 500;

/** Maximum total cache size in bytes (50 MB) */
const MAX_CACHE_BYTES = 50 * 1024 * 1024;

/**
 * Storage adapter using Obsidian's plugin data directory.
 */
export class ObsidianStorageAdapter implements StorageAdapter {
  private cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  private logger: Logger;

  constructor(private plugin: Plugin, logger?: Logger) {
    this.logger = logger ?? createLogger("Storage");
  }

  /**
   * Evict oldest cache entries to stay within limits.
   */
  private evictIfNeeded(): void {
    // Evict by item count
    while (this.cache.size > MAX_CACHE_ITEMS) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldValue = this.cache.get(oldestKey);
        if (oldValue) this.cacheBytes -= oldValue.length;
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    // Evict by total size
    while (this.cacheBytes > MAX_CACHE_BYTES && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldValue = this.cache.get(oldestKey);
        if (oldValue) this.cacheBytes -= oldValue.length;
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  /**
   * Add item to cache with LRU tracking.
   */
  private cacheSet(key: string, data: Uint8Array): void {
    // Remove old entry if exists (to update LRU order)
    const existing = this.cache.get(key);
    if (existing) {
      this.cacheBytes -= existing.length;
      this.cache.delete(key);
    }

    // Add new entry
    this.cache.set(key, data);
    this.cacheBytes += data.length;

    // Evict if needed
    this.evictIfNeeded();
  }

  /**
   * Read raw bytes from storage.
   */
  async read(key: string): Promise<Uint8Array | null> {
    // Check cache first (and refresh LRU order)
    const cached = this.cache.get(key);
    if (cached) {
      // Refresh LRU order by re-inserting
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    try {
      const path = this.getStoragePath(key);
      const adapter = this.plugin.app.vault.adapter;

      if (await adapter.exists(path)) {
        const data = await adapter.readBinary(path);
        const bytes = new Uint8Array(data);
        this.cacheSet(key, bytes);
        return bytes;
      }
    } catch (error) {
      this.logger.error(`Failed to read storage key "${key}":`, error);
    }

    return null;
  }

  /**
   * Write raw bytes to storage.
   */
  async write(key: string, data: Uint8Array): Promise<void> {
    try {
      const path = this.getStoragePath(key);
      const adapter = this.plugin.app.vault.adapter;

      // Ensure parent directory exists
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir && !(await adapter.exists(dir))) {
        await adapter.mkdir(dir);
      }

      await adapter.writeBinary(path, data.buffer as ArrayBuffer);
      this.cacheSet(key, data);
    } catch (error) {
      this.logger.error(`Failed to write storage key "${key}":`, error);
      throw error;
    }
  }

  /**
   * Delete a key from storage.
   */
  async delete(key: string): Promise<void> {
    try {
      const path = this.getStoragePath(key);
      const adapter = this.plugin.app.vault.adapter;

      if (await adapter.exists(path)) {
        await adapter.remove(path);
      }
      const cached = this.cache.get(key);
      if (cached) {
        this.cacheBytes -= cached.length;
      }
      this.cache.delete(key);
    } catch (error) {
      this.logger.error(`Failed to delete storage key "${key}":`, error);
      throw error;
    }
  }

  /**
   * List all keys with optional prefix.
   */
  async list(prefix?: string): Promise<string[]> {
    try {
      const basePath = this.getStoragePath("");
      const adapter = this.plugin.app.vault.adapter;

      if (!(await adapter.exists(basePath))) {
        return [];
      }

      const listing = await adapter.list(basePath);
      let keys = listing.files.map((f) =>
        f.substring(basePath.length).replace(/^\//, ""),
      );

      if (prefix) {
        keys = keys.filter((k) => k.startsWith(prefix));
      }

      return keys;
    } catch (error) {
      this.logger.error("Failed to list storage keys:", error);
      return [];
    }
  }

  /**
   * Check if a key exists.
   */
  async exists(key: string): Promise<boolean> {
    if (this.cache.has(key)) return true;

    try {
      const path = this.getStoragePath(key);
      return await this.plugin.app.vault.adapter.exists(path);
    } catch {
      return false;
    }
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  /**
   * Get the full storage path for a key.
   */
  private getStoragePath(key: string): string {
    const pluginDir = this.plugin.manifest.dir;
    return `${pluginDir}/${STORAGE_PREFIX}${key}`;
  }
}

/**
 * In-memory storage adapter for testing.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, Uint8Array>();

  async read(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    this.store.set(key, data);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.store.keys());
    if (prefix) {
      return keys.filter((k) => k.startsWith(prefix));
    }
    return keys;
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
  }
}
