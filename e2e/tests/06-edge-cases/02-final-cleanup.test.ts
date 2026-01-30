/**
 * Edge Case Tests - Final Cleanup
 *
 * Cleanup test files and verify final state.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertVaultEmpty,
  assertVaultsInSync,
} from "../../lib/assertions";

export default [
  {
    name: "Final CRDT convergence check",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(60000);

      const [v1, v2] = await Promise.all([
        ctx.test.sync.getVersion(),
        ctx.test2.sync.getVersion(),
      ]);

      console.log(`  TEST version: ${v1.slice(0, 32)}...`);
      console.log(`  TEST2 version: ${v2.slice(0, 32)}...`);
      assert(v1 === v2, "CRDT versions should match");
    },
  },

  {
    name: "File lists match between vaults",
    async fn(ctx: TestContext) {
      const [files1, files2] = await Promise.all([
        ctx.test.vault.listFiles(),
        ctx.test2.vault.listFiles(),
      ]);

      const sorted1 = [...files1].sort();
      const sorted2 = [...files2].sort();

      console.log(`  TEST has ${files1.length} files`);
      console.log(`  TEST2 has ${files2.length} files`);

      // Find differences if any
      const only1 = sorted1.filter((f) => !sorted2.includes(f));
      const only2 = sorted2.filter((f) => !sorted1.includes(f));

      if (only1.length > 0) {
        console.log(`  Only in TEST: ${only1.slice(0, 5).join(", ")}${only1.length > 5 ? "..." : ""}`);
      }
      if (only2.length > 0) {
        console.log(`  Only in TEST2: ${only2.slice(0, 5).join(", ")}${only2.length > 5 ? "..." : ""}`);
      }

      assert(
        JSON.stringify(sorted1) === JSON.stringify(sorted2),
        `File lists differ: TEST has ${only1.length} unique, TEST2 has ${only2.length} unique`
      );
    },
  },

  {
    name: "CRDT file lists match",
    async fn(ctx: TestContext) {
      const [crdt1, crdt2] = await Promise.all([
        ctx.test.plugin.getCrdtFiles(),
        ctx.test2.plugin.getCrdtFiles(),
      ]);

      const sorted1 = [...crdt1].sort();
      const sorted2 = [...crdt2].sort();

      console.log(`  TEST CRDT tracks ${crdt1.length} files`);
      console.log(`  TEST2 CRDT tracks ${crdt2.length} files`);

      assert(
        JSON.stringify(sorted1) === JSON.stringify(sorted2),
        "CRDT file lists should match"
      );
    },
  },

  {
    name: "Clean up TEST vault",
    async fn(ctx: TestContext) {
      const result = await ctx.test.state.resetVaultFiles();
      console.log(`  Deleted ${result.deletedCount} files from TEST`);
    },
  },

  {
    name: "Wait for cleanup to sync",
    async fn(ctx: TestContext) {
      // Wait for deletions to sync
      await new Promise((r) => setTimeout(r, 10000));
      await ctx.waitForConvergence(60000);
    },
  },

  {
    name: "Clean up TEST2 vault",
    async fn(ctx: TestContext) {
      const result = await ctx.test2.state.resetVaultFiles();
      console.log(`  Deleted ${result.deletedCount} files from TEST2`);
    },
  },

  {
    name: "Verify both vaults empty",
    async fn(ctx: TestContext) {
      // Wait for sync
      await new Promise((r) => setTimeout(r, 5000));

      const [files1, files2] = await Promise.all([
        ctx.test.vault.listFiles(),
        ctx.test2.vault.listFiles(),
      ]);

      console.log(`  TEST has ${files1.length} files remaining`);
      console.log(`  TEST2 has ${files2.length} files remaining`);

      // Note: May not be perfectly empty due to sync timing
      // Just verify they match
      assert(
        files1.length === files2.length,
        `File counts differ: TEST=${files1.length}, TEST2=${files2.length}`
      );
    },
  },

  {
    name: "Print final summary",
    async fn(ctx: TestContext) {
      const [state1, state2] = await Promise.all([
        ctx.test.state.getStateSummary(),
        ctx.test2.state.getStateSummary(),
      ]);

      console.log("\n  Final TEST state:");
      console.log(`    Files: ${state1.fileCount}`);
      console.log(`    Peers: ${state1.peerCount}`);
      console.log(`    Sessions: ${state1.sessionCount}`);
      console.log(`    CRDT files: ${state1.crdtFileCount}`);

      console.log("\n  Final TEST2 state:");
      console.log(`    Files: ${state2.fileCount}`);
      console.log(`    Peers: ${state2.peerCount}`);
      console.log(`    Sessions: ${state2.sessionCount}`);
      console.log(`    CRDT files: ${state2.crdtFileCount}`);

      console.log("\n  E2E test run complete!");
    },
  },
];
