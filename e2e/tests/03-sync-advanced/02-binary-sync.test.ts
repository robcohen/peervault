/**
 * Advanced Sync Tests - Binary Files
 *
 * Tests syncing binary files (images, etc.) between vaults.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
} from "../../lib/assertions";
import { loadFixturesByName } from "../../lib/fixtures";

export default [
  {
    name: "Sync binary image file from fixtures",
    async fn(ctx: TestContext) {
      // Load binary fixtures
      const count = await loadFixturesByName(ctx.test.vault, "binary");
      console.log(`  Loaded ${count} binary fixtures`);

      // Wait for sync
      await ctx.test2.sync.waitForFile("test-image.png", { timeoutMs: 30000 });
      console.log("  Binary file synced");

      // Verify it exists
      await assertFileExists(ctx.test2.vault, "test-image.png");
    },
  },

  {
    name: "Binary file content matches after sync",
    async fn(ctx: TestContext) {
      // Read binary from both vaults
      const [content1, content2] = await Promise.all([
        ctx.test.vault.readBinaryFile("test-image.png"),
        ctx.test2.vault.readBinaryFile("test-image.png"),
      ]);

      // Compare byte by byte
      assert(
        content1.length === content2.length,
        `Binary sizes differ: ${content1.length} vs ${content2.length}`
      );

      for (let i = 0; i < content1.length; i++) {
        assert(
          content1[i] === content2[i],
          `Binary content differs at byte ${i}`
        );
      }

      console.log(`  Binary content matches (${content1.length} bytes)`);
    },
  },

  {
    name: "Create and sync inline binary file",
    async fn(ctx: TestContext) {
      // Create a small binary file (fake PNG header)
      const binary = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, // IHDR length
        0x49, 0x48, 0x44, 0x52, // "IHDR"
        0x00, 0x00, 0x00, 0x02, // width = 2
        0x00, 0x00, 0x00, 0x02, // height = 2
        0x08, 0x02, // bit depth, color type
        0x00, 0x00, 0x00, // compression, filter, interlace
      ]);

      await ctx.test2.vault.createFile("inline-binary.png", binary);
      console.log("  Created inline binary file");

      // Wait for sync
      await ctx.test.sync.waitForFile("inline-binary.png", { timeoutMs: 30000 });
      console.log("  Inline binary synced");

      // Verify content
      const synced = await ctx.test.vault.readBinaryFile("inline-binary.png");
      assert(
        synced.length === binary.length,
        `Binary size mismatch: ${synced.length} vs ${binary.length}`
      );
    },
  },

  {
    name: "Modify binary file syncs correctly",
    async fn(ctx: TestContext) {
      // Create modified version with larger size
      const modified = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x04, // width = 4 (changed)
        0x00, 0x00, 0x00, 0x04, // height = 4 (changed)
        0x08, 0x02,
        0x00, 0x00, 0x00,
        0xFF, 0xFF, // extra bytes
      ]);

      // Delete old and create new (binary modify)
      await ctx.test2.vault.deleteFile("inline-binary.png");
      await ctx.test2.vault.createFile("inline-binary.png", modified);

      // Wait for the new size to sync (poll until size matches)
      const expectedSize = modified.length;
      let syncedSize = 0;
      const startTime = Date.now();
      const timeout = 30000;

      while (Date.now() - startTime < timeout) {
        try {
          const synced = await ctx.test.vault.readBinaryFile("inline-binary.png");
          syncedSize = synced.length;
          if (syncedSize === expectedSize) break;
        } catch {
          // File might not exist momentarily during update
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      assert(
        syncedSize === expectedSize,
        `Modified binary size mismatch: ${syncedSize} vs ${expectedSize}`
      );
      console.log("  Modified binary synced");
    },
  },

  {
    name: "Delete binary file syncs correctly",
    async fn(ctx: TestContext) {
      await ctx.test.vault.deleteFile("inline-binary.png");

      await ctx.test2.sync.waitForFileDeletion("inline-binary.png", {
        timeoutMs: 30000,
      });
      console.log("  Binary deletion synced");
    },
  },

  {
    name: "CRDT versions converge after binary operations",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(30000);
      console.log("  CRDT versions converged");
    },
  },
];
