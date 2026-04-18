/**
 * Setup Tests - State Reset
 *
 * Clears all vault state to prepare for test run.
 * Simplified for the new WASM-based plugin.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertVaultEmpty,
  assertNoPeers,
} from "../../lib/assertions";
import { isDockerMode, getConfig } from "../../config";

export default [
  {
    name: "Reset TEST vault state",
    async fn(ctx: TestContext) {
      // Get initial state
      const initialState = await ctx.test.state.getStateSummary();
      console.log(`  Initial TEST state: ${JSON.stringify(initialState)}`);

      // Perform reset
      const result = await ctx.test.state.resetAll();
      console.log(`  Deleted ${result.deleted} files from TEST`);

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
      console.log(`  Deleted ${result.deleted} files from TEST2`);

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
    name: "Configure TEST relay URL",
    async fn(ctx: TestContext) {
      const cfg = getConfig();
      const relayUrl = cfg.transport.relayUrl;

      // Set relay URL in settings (will be used after plugin reload)
      await ctx.test.plugin.setRelayUrl(relayUrl);
      console.log(`  Relay URL set to: ${relayUrl}`);
    },
  },

  {
    name: "Configure TEST2 relay URL",
    async fn(ctx: TestContext) {
      const cfg = getConfig();
      const relayUrl = cfg.transport.relayUrl;

      // Set relay URL in settings (will be used after plugin reload)
      await ctx.test2.plugin.setRelayUrl(relayUrl);
      console.log(`  Relay URL set to: ${relayUrl}`);
    },
  },

  {
    name: "Reinstall TEST plugin with fresh code",
    async fn(ctx: TestContext) {
      // Skip in Docker mode - plugin is pre-installed
      if (isDockerMode) {
        console.log("  Skipping reinstall in Docker mode (plugin pre-installed)");
        return;
      }

      // Get dist path relative to project root
      const distPath = process.cwd() + "/dist";

      console.log(`  Installing from: ${distPath}`);
      const result = await ctx.test.lifecycle.reinstall(distPath);

      if (!result.success) {
        throw new Error(`Failed to reinstall plugin: ${result.error}`);
      }

      // Verify plugin is enabled after reinstall
      const enabled = await ctx.test.plugin.isEnabled();
      assert(enabled, "Plugin should be enabled after reinstall");

      console.log("  Plugin reinstalled successfully");
    },
  },

  {
    name: "Reinstall TEST2 plugin with fresh code",
    async fn(ctx: TestContext) {
      // Skip in Docker mode - plugin is pre-installed
      if (isDockerMode) {
        console.log("  Skipping reinstall in Docker mode (plugin pre-installed)");
        return;
      }

      // Get dist path relative to project root
      const distPath = process.cwd() + "/dist";

      console.log(`  Installing from: ${distPath}`);
      const result = await ctx.test2.lifecycle.reinstall(distPath);

      if (!result.success) {
        throw new Error(`Failed to reinstall plugin: ${result.error}`);
      }

      // Verify plugin is enabled after reinstall
      const enabled = await ctx.test2.plugin.isEnabled();
      assert(enabled, "Plugin should be enabled after reinstall");

      console.log("  Plugin reinstalled successfully");
    },
  },
];
