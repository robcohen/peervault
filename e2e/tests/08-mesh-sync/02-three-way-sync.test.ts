/**
 * 3-Way Mesh Sync Tests - File Synchronization
 *
 * Tests that files sync correctly across all three vaults:
 * - File created in TEST syncs to TEST2 and TEST3
 * - File created in TEST3 syncs to TEST and TEST2
 * - Modifications propagate to all vaults
 *
 * PREREQUISITE: Run 01-three-way-pairing.test.ts first.
 */

import { delay, getConfig } from "../../config";
import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileContent,
  assertFileExists,
} from "../../lib/assertions";

export default [
  {
    name: "Verify all vaults are connected",
    async fn(ctx: TestContext) {
      if (!ctx.test3) {
        throw new Error("TEST3 vault not available. Run with 3-vault context.");
      }

      // Quick connectivity check
      const testPeers = await ctx.test.plugin.getConnectedPeers();
      const test2Peers = await ctx.test2.plugin.getConnectedPeers();
      const test3Peers = await ctx.test3.plugin.getConnectedPeers();

      assert(testPeers.length >= 2, "TEST should have at least 2 peers");
      assert(test2Peers.length >= 2, "TEST2 should have at least 2 peers");
      assert(test3Peers.length >= 2, "TEST3 should have at least 2 peers");

      console.log("  All vaults are connected in mesh topology");
    },
  },

  {
    name: "Create file in TEST - syncs to TEST2 and TEST3",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const path = "mesh-test-from-test.md";
      const content = "# Created in TEST\n\nThis file was created in the TEST vault.";

      // Clean up any existing file
      try { await ctx.test.vault.deleteFile(path); } catch {}
      try { await ctx.test2.vault.deleteFile(path); } catch {}
      try { await ctx.test3.vault.deleteFile(path); } catch {}

      // Create in TEST
      await ctx.test.vault.createFile(path, content);
      console.log(`  Created ${path} in TEST`);

      // Wait for sync to both TEST2 and TEST3
      await Promise.all([
        ctx.test2.sync.waitForFile(path),
        ctx.test3.sync.waitForFile(path),
      ]);

      // Verify content
      await assertFileContent(ctx.test2.vault, path, content);
      await assertFileContent(ctx.test3.vault, path, content);

      console.log("  File synced to TEST2 and TEST3");
    },
  },

  {
    name: "Create file in TEST3 - syncs to TEST and TEST2",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const path = "mesh-test-from-test3.md";
      const content = "# Created in TEST3\n\nThis file was created in the TEST3 vault.";

      // Clean up any existing file
      try { await ctx.test.vault.deleteFile(path); } catch {}
      try { await ctx.test2.vault.deleteFile(path); } catch {}
      try { await ctx.test3.vault.deleteFile(path); } catch {}

      // Create in TEST3
      await ctx.test3.vault.createFile(path, content);
      console.log(`  Created ${path} in TEST3`);

      // Wait for sync to both TEST and TEST2
      await Promise.all([
        ctx.test.sync.waitForFile(path),
        ctx.test2.sync.waitForFile(path),
      ]);

      // Verify content
      await assertFileContent(ctx.test.vault, path, content);
      await assertFileContent(ctx.test2.vault, path, content);

      console.log("  File synced to TEST and TEST2");
    },
  },

  {
    name: "Modify file in TEST2 - syncs to TEST and TEST3",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const path = "mesh-test-from-test.md";
      const newContent = "# Created in TEST (Modified by TEST2)\n\nThis file was modified in TEST2.";

      // Modify in TEST2
      await ctx.test2.vault.modifyFile(path, newContent);
      console.log(`  Modified ${path} in TEST2`);

      // Wait for sync to both TEST and TEST3
      await Promise.all([
        ctx.test.sync.waitForContent(path, newContent),
        ctx.test3.sync.waitForContent(path, newContent),
      ]);

      console.log("  Modification synced to TEST and TEST3");
    },
  },

  {
    name: "Delete file in TEST - deletes from TEST2 and TEST3",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const path = "mesh-test-from-test3.md";

      // Delete in TEST
      await ctx.test.vault.deleteFile(path);
      console.log(`  Deleted ${path} in TEST`);

      // Wait for deletion to sync
      await Promise.all([
        ctx.test2.sync.waitForFileDeletion(path),
        ctx.test3.sync.waitForFileDeletion(path),
      ]);

      console.log("  Deletion synced to TEST2 and TEST3");
    },
  },

  {
    name: "Wait for mesh convergence",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      // Wait for all vaults to have same CRDT state
      await ctx.waitForMeshConvergence();
      console.log("  Mesh CRDT versions converged");
    },
  },

  {
    name: "Verify file lists match across all vaults",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const testFiles = await ctx.test.vault.listFiles();
      const test2Files = await ctx.test2.vault.listFiles();
      const test3Files = await ctx.test3.vault.listFiles();

      // Filter to only .md files to avoid .obsidian differences
      const filterMd = (files: string[]) => files.filter(f => f.endsWith(".md")).sort();

      const testMd = filterMd(testFiles);
      const test2Md = filterMd(test2Files);
      const test3Md = filterMd(test3Files);

      console.log(`  TEST files: ${testMd.length}`);
      console.log(`  TEST2 files: ${test2Md.length}`);
      console.log(`  TEST3 files: ${test3Md.length}`);

      // Check that all vaults have the same files
      const allSame = testMd.length === test2Md.length &&
                      testMd.length === test3Md.length &&
                      testMd.every((f, i) => f === test2Md[i] && f === test3Md[i]);

      if (!allSame) {
        console.log(`  TEST md files: ${testMd.join(", ")}`);
        console.log(`  TEST2 md files: ${test2Md.join(", ")}`);
        console.log(`  TEST3 md files: ${test3Md.join(", ")}`);
      }

      assert(allSame, "All vaults should have the same .md files");
      console.log("  File lists match across all vaults");
    },
  },
];
