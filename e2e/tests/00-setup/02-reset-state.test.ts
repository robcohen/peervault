/**
 * Setup Tests - State Reset
 *
 * Clears all vault state to prepare for test run.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertVaultEmpty,
  assertNoPeers,
} from "../../lib/assertions";

export default [
  {
    name: "Reset TEST vault state",
    async fn(ctx: TestContext) {
      // Get initial state
      const initialState = await ctx.test.state.getStateSummary();
      console.log(`  Initial TEST state: ${JSON.stringify(initialState)}`);

      // Perform reset
      const result = await ctx.test.state.resetAll();
      console.log(`  Deleted ${result.deletedCount} files from TEST`);

      // Verify clean
      await ctx.test.state.waitForCleanState(5000);
    },
  },

  {
    name: "Reset TEST2 vault state",
    async fn(ctx: TestContext) {
      // Get initial state
      const initialState = await ctx.test2.state.getStateSummary();
      console.log(`  Initial TEST2 state: ${JSON.stringify(initialState)}`);

      // Perform reset
      const result = await ctx.test2.state.resetAll();
      console.log(`  Deleted ${result.deletedCount} files from TEST2`);

      // Verify clean
      await ctx.test2.state.waitForCleanState(5000);
    },
  },

  {
    name: "TEST vault is empty",
    async fn(ctx: TestContext) {
      await assertVaultEmpty(ctx.test.vault);
    },
  },

  {
    name: "TEST2 vault is empty",
    async fn(ctx: TestContext) {
      await assertVaultEmpty(ctx.test2.vault);
    },
  },

  {
    name: "TEST has no peers",
    async fn(ctx: TestContext) {
      await assertNoPeers(ctx.test.plugin);
    },
  },

  {
    name: "TEST2 has no peers",
    async fn(ctx: TestContext) {
      await assertNoPeers(ctx.test2.plugin);
    },
  },

  {
    name: "Reload TEST plugin",
    async fn(ctx: TestContext) {
      await ctx.test.lifecycle.reload();

      // Verify plugin is still enabled after reload
      const enabled = await ctx.test.plugin.isEnabled();
      assert(enabled, "Plugin should be enabled after reload");
    },
  },

  {
    name: "Reload TEST2 plugin",
    async fn(ctx: TestContext) {
      await ctx.test2.lifecycle.reload();

      // Verify plugin is still enabled after reload
      const enabled = await ctx.test2.plugin.isEnabled();
      assert(enabled, "Plugin should be enabled after reload");
    },
  },
];
