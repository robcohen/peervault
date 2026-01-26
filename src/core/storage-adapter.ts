/**
 * Storage Adapter - Obsidian storage implementation
 *
 * Provides a unified storage interface on top of Obsidian's plugin data API.
 */

import type { Plugin } from "obsidian";
import type { StorageAdapter } from "../types";

const STORAGE_PREFIX = "peervault-storage/";

/**
 * Storage adapter using Obsidian's plugin data directory.
 */
export class ObsidianStorageAdapter implements StorageAdapter {
  private cache = new Map<string, Uint8Array>();

  constructor(private plugin: Plugin) {}

  /**
   * Read raw bytes from storage.
   */
  async read(key: string): Promise<Uint8Array | null> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached) return cached;

    try {
      const path = this.getStoragePath(key);
      const adapter = this.plugin.app.vault.adapter;

      if (await adapter.exists(path)) {
        const data = await adapter.readBinary(path);
        const bytes = new Uint8Array(data);
        this.cache.set(key, bytes);
        return bytes;
      }
    } catch (error) {
      console.error(`Failed to read storage key "${key}":`, error);
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
      this.cache.set(key, data);
    } catch (error) {
      console.error(`Failed to write storage key "${key}":`, error);
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
      this.cache.delete(key);
    } catch (error) {
      console.error(`Failed to delete storage key "${key}":`, error);
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
      console.error("Failed to list storage keys:", error);
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
