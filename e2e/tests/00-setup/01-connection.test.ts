/**
 * Setup Tests - Connection and Plugin Verification
 *
 * Verifies CDP connection, plugin presence, and initial state.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertPluginEnabled,
  assertVaultEmpty,
} from "../../lib/assertions";

export default [
  {
    name: "CDP connection to TEST vault works",
    async fn(ctx: TestContext) {
      // Verify we can evaluate in the TEST vault
      const result = await ctx.test.client.evaluate<string>(`
        (function() {
          return window.app?.vault?.getName() || "unknown";
        })()
      `);
      assert(result === "TEST", `Expected vault name "TEST", got "${result}"`);
    },
  },

  {
    name: "CDP connection to TEST2 vault works",
    async fn(ctx: TestContext) {
      // Verify we can evaluate in the TEST2 vault
      const result = await ctx.test2.client.evaluate<string>(`
        (function() {
          return window.app?.vault?.getName() || "unknown";
        })()
      `);
      assert(result === "TEST2", `Expected vault name "TEST2", got "${result}"`);
    },
  },

  {
    name: "PeerVault plugin is enabled in TEST",
    async fn(ctx: TestContext) {
      await assertPluginEnabled(ctx.test.plugin);
    },
  },

  {
    name: "PeerVault plugin is enabled in TEST2",
    async fn(ctx: TestContext) {
      await assertPluginEnabled(ctx.test2.plugin);
    },
  },

  {
    name: "TEST vault has node ID",
    async fn(ctx: TestContext) {
      const nodeId = await ctx.test.plugin.getNodeId();
      assert(
        nodeId.length > 0,
        "TEST vault should have a node ID"
      );
      assert(
        nodeId.length >= 40,
        `Node ID should be at least 40 chars, got ${nodeId.length}`
      );
    },
  },

  {
    name: "TEST2 vault has node ID",
    async fn(ctx: TestContext) {
      const nodeId = await ctx.test2.plugin.getNodeId();
      assert(
        nodeId.length > 0,
        "TEST2 vault should have a node ID"
      );
      assert(
        nodeId.length >= 40,
        `Node ID should be at least 40 chars, got ${nodeId.length}`
      );
    },
  },

  {
    name: "Both vaults have different node IDs",
    async fn(ctx: TestContext) {
      const [nodeId1, nodeId2] = await Promise.all([
        ctx.test.plugin.getNodeId(),
        ctx.test2.plugin.getNodeId(),
      ]);
      assert(
        nodeId1 !== nodeId2,
        `Vaults should have different node IDs, both have: ${nodeId1}`
      );
    },
  },

  {
    name: "Plugin versions match",
    async fn(ctx: TestContext) {
      const [version1, version2] = await Promise.all([
        ctx.test.plugin.getVersion(),
        ctx.test2.plugin.getVersion(),
      ]);
      assert(
        version1 === version2,
        `Plugin versions should match: TEST=${version1}, TEST2=${version2}`
      );
      assert(
        version1 !== "unknown",
        "Plugin version should not be unknown"
      );
    },
  },
];
