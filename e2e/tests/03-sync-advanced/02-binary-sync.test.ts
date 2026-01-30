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

      // Verify the file exists in TEST vault
      await assertFileExists(ctx.test.vault, "test-image.png");
      console.log("  Binary file exists in TEST vault");

      // Wait for debounce (vault sync debounces file changes)
      await new Promise((r) => setTimeout(r, 500));

      // Check if file is tracked in TEST's CRDT
      let crdtFiles1 = await ctx.test.plugin.getCrdtFiles();
      let inCrdt1 = crdtFiles1.includes("test-image.png");
      console.log(`  File in TEST CRDT: ${inCrdt1} (${crdtFiles1.length} files total)`);

      // If not in CRDT, try triggering a sync explicitly
      if (!inCrdt1) {
        console.log("  File not in CRDT, triggering sync...");
        await ctx.test.plugin.sync();
        await new Promise((r) => setTimeout(r, 1000));
        crdtFiles1 = await ctx.test.plugin.getCrdtFiles();
        inCrdt1 = crdtFiles1.includes("test-image.png");
        console.log(`  After sync - File in TEST CRDT: ${inCrdt1} (${crdtFiles1.length} files total)`);
      }

      // Give the live sync a moment
      await new Promise((r) => setTimeout(r, 2000));

      // Check CRDT state on TEST2
      const crdtFiles2 = await ctx.test2.plugin.getCrdtFiles();
      const inCrdt2 = crdtFiles2.includes("test-image.png");
      console.log(`  File in TEST2 CRDT: ${inCrdt2} (${crdtFiles2.length} files total)`);

      // Check blob store status on both vaults
      const blobInfo1 = await ctx.test.plugin.getBlobStoreInfo();
      const blobInfo2 = await ctx.test2.plugin.getBlobStoreInfo();
      console.log(`  TEST blob store: ${blobInfo1.blobCount} blobs, ${blobInfo1.referencedHashes.length} referenced, ${blobInfo1.missingHashes.length} missing`);
      console.log(`  TEST2 blob store: ${blobInfo2.blobCount} blobs, ${blobInfo2.referencedHashes.length} referenced, ${blobInfo2.missingHashes.length} missing`);

      // Check blob:received event counts
      const blobRecvCount1 = await ctx.test.plugin.getBlobReceivedCount();
      const blobRecvCount2 = await ctx.test2.plugin.getBlobReceivedCount();
      console.log(`  TEST blob:received count: ${blobRecvCount1}, TEST2 blob:received count: ${blobRecvCount2}`);

      // If TEST2 has missing blobs, the automatic sync should have requested them
      // Wait a bit longer and check again
      if (blobInfo2.missingHashes.length > 0) {
        console.log("  TEST2 has missing blobs, waiting for automatic transfer...");
        await new Promise((r) => setTimeout(r, 3000));
        const blobInfo2After = await ctx.test2.plugin.getBlobStoreInfo();
        console.log(`  After wait - TEST2 blob store: ${blobInfo2After.blobCount} blobs, ${blobInfo2After.missingHashes.length} missing`);
        const blobRecvCountAfter = await ctx.test2.plugin.getBlobReceivedCount();
        console.log(`  After wait - TEST2 blob:received count: ${blobRecvCountAfter}`);
      }

      // Force trigger syncFromDocument on TEST2 if needed
      console.log("  Triggering syncFromDocument on TEST2...");
      const syncResult = await ctx.test2.client.evaluate<{ created: number; updated: number; failed: number }>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const vs = plugin?.vaultSync;
          if (!vs?.syncFromDocument) return { created: -1, updated: -1, failed: -1 };
          return await vs.syncFromDocument();
        })()
      `);
      console.log(`  syncFromDocument result: created=${syncResult.created}, updated=${syncResult.updated}, failed=${syncResult.failed}`);

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

      // Wait for CRDT sync (debounce)
      await new Promise((r) => setTimeout(r, 1000));

      // Check CRDT status on both sides
      const crdtFiles2 = await ctx.test2.plugin.getCrdtFiles();
      const inCrdt2 = crdtFiles2.includes("inline-binary.png");
      console.log(`  File in TEST2 CRDT: ${inCrdt2}`);

      // Wait for live sync to transfer CRDT update
      await new Promise((r) => setTimeout(r, 2000));

      const crdtFiles1 = await ctx.test.plugin.getCrdtFiles();
      const inCrdt1 = crdtFiles1.includes("inline-binary.png");
      console.log(`  File in TEST CRDT: ${inCrdt1}`);

      // Force syncFromDocument on TEST to write the file
      console.log("  Triggering syncFromDocument on TEST...");
      const syncResult = await ctx.test.client.evaluate<{ created: number; updated: number; failed: number }>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const vs = plugin?.vaultSync;
          if (!vs?.syncFromDocument) return { created: -1, updated: -1, failed: -1 };
          return await vs.syncFromDocument();
        })()
      `);
      console.log(`  syncFromDocument result: created=${syncResult.created}, updated=${syncResult.updated}, failed=${syncResult.failed}`);

      // Wait for sync
      await ctx.test.sync.waitForFile("inline-binary.png", { timeoutMs: 10000 });
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
      console.log(`  Modified binary file (${modified.length} bytes)`);

      // Wait for CRDT sync
      await new Promise((r) => setTimeout(r, 3000));

      // Force syncFromDocument on TEST to write the modified file
      console.log("  Triggering syncFromDocument on TEST...");
      await ctx.test.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const vs = plugin?.vaultSync;
          if (vs?.syncFromDocument) await vs.syncFromDocument();
        })()
      `);

      // Verify the content matches
      const synced = await ctx.test.vault.readBinaryFile("inline-binary.png");
      assert(
        synced.length === modified.length,
        `Modified binary size mismatch: ${synced.length} vs ${modified.length}`
      );
      console.log("  Modified binary synced");
    },
  },

  {
    name: "Delete binary file syncs correctly",
    async fn(ctx: TestContext) {
      // Delete from TEST
      await ctx.test.vault.deleteFile("inline-binary.png");
      console.log("  Deleted binary file from TEST");

      // Wait for CRDT sync
      await new Promise((r) => setTimeout(r, 3000));

      // Force syncFromDocument on TEST2 to apply the deletion
      await ctx.test2.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const vs = plugin?.vaultSync;
          if (vs?.syncFromDocument) await vs.syncFromDocument();
        })()
      `);

      // Verify file is deleted
      const exists = await ctx.test2.vault.fileExists("inline-binary.png");
      assert(!exists, "File should be deleted from TEST2");
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
