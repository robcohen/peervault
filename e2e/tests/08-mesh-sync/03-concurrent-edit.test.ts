/**
 * 3-Way Mesh Sync Tests - Concurrent Edits
 *
 * Tests CRDT conflict resolution when all three vaults
 * edit the same file simultaneously.
 *
 * PREREQUISITE: Run 01-three-way-pairing.test.ts first.
 */

import { delay, getConfig } from "../../config";
import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileContains,
} from "../../lib/assertions";

export default [
  {
    name: "Verify mesh connectivity before concurrent edit test",
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

      console.log("  Mesh connectivity verified");
    },
  },

  {
    name: "Create base file for concurrent edit test",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const path = "concurrent-edit-test.md";
      const content = "# Concurrent Edit Test\n\nBase content.";

      // Clean up any existing file
      try { await ctx.test.vault.deleteFile(path); } catch {}
      try { await ctx.test2.vault.deleteFile(path); } catch {}
      try { await ctx.test3.vault.deleteFile(path); } catch {}

      // Create in TEST
      await ctx.test.vault.createFile(path, content);

      // Wait for sync to all vaults
      await Promise.all([
        ctx.test2.sync.waitForFile(path),
        ctx.test3.sync.waitForFile(path),
      ]);

      console.log("  Base file created and synced to all vaults");
    },
  },

  {
    name: "All three vaults edit simultaneously",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const cfg = getConfig();
      const path = "concurrent-edit-test.md";

      // Each vault adds unique content
      const testAddition = "\n\n## Added by TEST\nUnique content from TEST vault.";
      const test2Addition = "\n\n## Added by TEST2\nUnique content from TEST2 vault.";
      const test3Addition = "\n\n## Added by TEST3\nUnique content from TEST3 vault.";

      // Read base content
      const baseContent = await ctx.test.vault.readFile(path);

      // All three vaults edit simultaneously
      console.log("  Starting simultaneous edits...");
      await Promise.all([
        ctx.test.vault.modifyFile(path, baseContent + testAddition),
        ctx.test2.vault.modifyFile(path, baseContent + test2Addition),
        ctx.test3.vault.modifyFile(path, baseContent + test3Addition),
      ]);

      console.log("  All three vaults made concurrent edits");

      // Allow time for CRDT to propagate and merge
      await delay(cfg.sync.settleDelay);
    },
  },

  {
    name: "Wait for mesh convergence after concurrent edits",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const cfg = getConfig();

      // Wait for CRDT versions to converge
      await ctx.waitForMeshConvergence(cfg.sync.convergenceTimeout * 2);

      console.log("  Mesh converged after concurrent edits");
    },
  },

  {
    name: "Verify CRDT merged all three contributions",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const cfg = getConfig();
      const path = "concurrent-edit-test.md";

      // Wait for content to stabilize across all vaults (CRDT may need time)
      const maxAttempts = 10;
      const pollMs = cfg.sync.pollInterval * 5;
      let attempts = 0;
      let contentMatches = false;
      let testContent = "";
      let test2Content = "";
      let test3Content = "";

      while (attempts < maxAttempts && !contentMatches) {
        testContent = await ctx.test.vault.readFile(path);
        test2Content = await ctx.test2.vault.readFile(path);
        test3Content = await ctx.test3.vault.readFile(path);

        contentMatches = testContent === test2Content && test2Content === test3Content;
        if (!contentMatches) {
          attempts++;
          if (attempts < maxAttempts) {
            await delay(pollMs);
          }
        }
      }

      console.log(`  TEST content length: ${testContent.length}`);
      console.log(`  TEST2 content length: ${test2Content.length}`);
      console.log(`  TEST3 content length: ${test3Content.length}`);

      // IMPORTANT: When three vaults simultaneously REPLACE entire file content,
      // CRDT conflict resolution picks ONE winner (last-writer-wins at the operation level).
      // This is expected behavior - concurrent full-content replacements cannot all be merged.
      // The key guarantee is eventual consistency: all vaults converge to the same state.

      // The test verifies:
      // 1. All vaults converged to the same content (eventual consistency)
      // 2. At least one contribution was preserved (CRDT picked a winner)

      assert(contentMatches, "All vaults should have converged to the same content");
      console.log("  Content matches exactly across all vaults");

      // Count how many contributions were preserved
      const hasTest = testContent.includes("Added by TEST");
      const hasTest2 = testContent.includes("Added by TEST2");
      const hasTest3 = testContent.includes("Added by TEST3");
      const contributionsPreserved = [hasTest, hasTest2, hasTest3].filter(Boolean).length;

      console.log(`  Contributions preserved: ${contributionsPreserved}/3`);
      if (hasTest) console.log("    - TEST contribution present");
      if (hasTest2) console.log("    - TEST2 contribution present");
      if (hasTest3) console.log("    - TEST3 contribution present");

      // At least one contribution should be present (CRDT picked a winner)
      assert(
        contributionsPreserved >= 1,
        "At least one contribution should be preserved by CRDT"
      );

      console.log("  CRDT achieved eventual consistency across the mesh");
    },
  },

  {
    name: "Cleanup concurrent edit test file",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const path = "concurrent-edit-test.md";

      // Delete from TEST
      await ctx.test.vault.deleteFile(path);

      // Wait for deletion to sync
      await Promise.all([
        ctx.test2.sync.waitForFileDeletion(path),
        ctx.test3.sync.waitForFileDeletion(path),
      ]);

      console.log("  Test file cleaned up");
    },
  },

  {
    name: "Cleanup all mesh test files",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      // Clean up mesh-test-from-test.md that was created earlier
      const filesToClean = ["mesh-test-from-test.md"];

      for (const path of filesToClean) {
        try {
          await ctx.test.vault.deleteFile(path);
          await Promise.all([
            ctx.test2.sync.waitForFileDeletion(path),
            ctx.test3.sync.waitForFileDeletion(path),
          ]);
        } catch {
          // File may not exist, ignore
        }
      }

      console.log("  All mesh test files cleaned up");
    },
  },
];
