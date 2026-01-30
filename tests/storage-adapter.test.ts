/**
 * Storage Adapter Tests
 *
 * Tests for storage adapter implementations.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { MemoryStorageAdapter } from "../src/core/storage-adapter";

// ============================================================================
// Tests
// ============================================================================

describe("MemoryStorageAdapter", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
  });

  describe("Basic Operations", () => {
    it("should return null for non-existent key", async () => {
      const result = await storage.read("nonexistent");
      expect(result).toBeNull();
    });

    it("should write and read data", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await storage.write("test-key", data);

      const result = await storage.read("test-key");
      expect(result).toEqual(data);
    });

    it("should overwrite existing data", async () => {
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([4, 5, 6, 7]);

      await storage.write("key", data1);
      await storage.write("key", data2);

      const result = await storage.read("key");
      expect(result).toEqual(data2);
    });

    it("should delete data", async () => {
      const data = new Uint8Array([1, 2, 3]);
      await storage.write("key", data);
      expect(await storage.read("key")).toEqual(data);

      await storage.delete("key");
      expect(await storage.read("key")).toBeNull();
    });

    it("should handle deleting non-existent key", async () => {
      // Should not throw
      await storage.delete("nonexistent");
    });
  });

  describe("Exists Check", () => {
    it("should return false for non-existent key", async () => {
      expect(await storage.exists("nonexistent")).toBe(false);
    });

    it("should return true for existing key", async () => {
      await storage.write("key", new Uint8Array([1]));
      expect(await storage.exists("key")).toBe(true);
    });

    it("should return false after deletion", async () => {
      await storage.write("key", new Uint8Array([1]));
      await storage.delete("key");
      expect(await storage.exists("key")).toBe(false);
    });
  });

  describe("List Operation", () => {
    it("should return empty array when no keys", async () => {
      const keys = await storage.list();
      expect(keys).toEqual([]);
    });

    it("should list all keys", async () => {
      await storage.write("key1", new Uint8Array([1]));
      await storage.write("key2", new Uint8Array([2]));
      await storage.write("key3", new Uint8Array([3]));

      const keys = await storage.list();
      expect(keys).toHaveLength(3);
      expect(keys).toContain("key1");
      expect(keys).toContain("key2");
      expect(keys).toContain("key3");
    });

    it("should filter by prefix", async () => {
      await storage.write("prefix/a", new Uint8Array([1]));
      await storage.write("prefix/b", new Uint8Array([2]));
      await storage.write("other/c", new Uint8Array([3]));

      const keys = await storage.list("prefix/");
      expect(keys).toHaveLength(2);
      expect(keys).toContain("prefix/a");
      expect(keys).toContain("prefix/b");
      expect(keys).not.toContain("other/c");
    });

    it("should return empty when no keys match prefix", async () => {
      await storage.write("key1", new Uint8Array([1]));

      const keys = await storage.list("nonexistent/");
      expect(keys).toEqual([]);
    });
  });

  describe("Clear Operation", () => {
    it("should clear all data", async () => {
      await storage.write("key1", new Uint8Array([1]));
      await storage.write("key2", new Uint8Array([2]));
      expect(await storage.list()).toHaveLength(2);

      storage.clear();

      expect(await storage.list()).toEqual([]);
      expect(await storage.exists("key1")).toBe(false);
      expect(await storage.exists("key2")).toBe(false);
    });
  });

  describe("Binary Data Handling", () => {
    it("should handle empty data", async () => {
      const empty = new Uint8Array([]);
      await storage.write("empty", empty);

      const result = await storage.read("empty");
      expect(result).toEqual(empty);
      expect(result!.length).toBe(0);
    });

    it("should handle large data", async () => {
      const large = new Uint8Array(1024 * 1024); // 1MB
      for (let i = 0; i < large.length; i++) {
        large[i] = i % 256;
      }

      await storage.write("large", large);

      const result = await storage.read("large");
      expect(result).toEqual(large);
    });

    it("should handle binary data with all byte values", async () => {
      const allBytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        allBytes[i] = i;
      }

      await storage.write("bytes", allBytes);

      const result = await storage.read("bytes");
      expect(result).toEqual(allBytes);
    });
  });

  describe("Key Naming", () => {
    it("should handle simple keys", async () => {
      await storage.write("simple", new Uint8Array([1]));
      expect(await storage.exists("simple")).toBe(true);
    });

    it("should handle path-like keys", async () => {
      await storage.write("path/to/file.bin", new Uint8Array([1]));
      expect(await storage.exists("path/to/file.bin")).toBe(true);
    });

    it("should handle keys with special characters", async () => {
      const key = "key-with_special.chars";
      await storage.write(key, new Uint8Array([1]));
      expect(await storage.exists(key)).toBe(true);
    });

    it("should treat keys as case-sensitive", async () => {
      await storage.write("Key", new Uint8Array([1]));
      await storage.write("key", new Uint8Array([2]));

      expect(await storage.read("Key")).toEqual(new Uint8Array([1]));
      expect(await storage.read("key")).toEqual(new Uint8Array([2]));
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle concurrent writes to different keys", async () => {
      const writes = [];
      for (let i = 0; i < 100; i++) {
        writes.push(storage.write(`key${i}`, new Uint8Array([i])));
      }

      await Promise.all(writes);

      const keys = await storage.list();
      expect(keys).toHaveLength(100);
    });

    it("should handle concurrent reads", async () => {
      await storage.write("shared", new Uint8Array([42]));

      const reads = [];
      for (let i = 0; i < 100; i++) {
        reads.push(storage.read("shared"));
      }

      const results = await Promise.all(reads);
      for (const result of results) {
        expect(result).toEqual(new Uint8Array([42]));
      }
    });
  });
});
