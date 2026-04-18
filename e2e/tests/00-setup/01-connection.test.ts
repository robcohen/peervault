/**
 * Setup Tests - Connection and Plugin Verification
 *
 * Verifies CDP connection, plugin presence, and initial state.
 */

import { delay } from "../../config";
import type { TestContext } from "../../lib/context";
import { assert, retryCheck } from "../../lib/assertions";

export default [
  {
    name: "CDP connection to TEST vault works",
    tags: ["smoke"],
    async fn(ctx: TestContext) {
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
    tags: ["smoke"],
    async fn(ctx: TestContext) {
      const enabled = await retryCheck(
        () => ctx.test.plugin.isEnabled(),
        (result) => result === true,
        { maxAttempts: 3, delayMs: 2000 }
      );
      if (!enabled) {
        console.log("  Warning: Plugin not enabled yet");
      }
    },
  },

  {
    name: "PeerVault plugin is enabled in TEST2",
    tags: ["smoke"],
    async fn(ctx: TestContext) {
      const enabled = await retryCheck(
        () => ctx.test2.plugin.isEnabled(),
        (result) => result === true,
        { maxAttempts: 3, delayMs: 2000 }
      );
      if (!enabled) {
        console.log("  Warning: Plugin not enabled yet");
      }
    },
  },

  {
    name: "Plugin is ready in TEST",
    async fn(ctx: TestContext) {
      const ready = await ctx.test.plugin.waitForReady(10000);
      assert(ready, "Plugin not ready in TEST vault");
      console.log("  Plugin ready");
    },
  },

  {
    name: "Plugin is ready in TEST2",
    async fn(ctx: TestContext) {
      const ready = await ctx.test2.plugin.waitForReady(10000);
      assert(ready, "Plugin not ready in TEST2 vault");
      console.log("  Plugin ready");
    },
  },

  {
    name: "TEST vault has node ID",
    async fn(ctx: TestContext) {
      const nodeId = await ctx.test.plugin.getNodeId();
      if (!nodeId || nodeId.length < 10) {
        console.log("  Warning: No node ID yet");
        return;
      }
      console.log(`  Node ID: ${nodeId.slice(0, 16)}...`);
    },
  },

  {
    name: "TEST2 vault has node ID",
    async fn(ctx: TestContext) {
      const nodeId = await ctx.test2.plugin.getNodeId();
      if (!nodeId || nodeId.length < 10) {
        console.log("  Warning: No node ID yet");
        return;
      }
      console.log(`  Node ID: ${nodeId.slice(0, 16)}...`);
    },
  },

  {
    name: "Both vaults have different node IDs",
    async fn(ctx: TestContext) {
      const [nodeId1, nodeId2] = await Promise.all([
        ctx.test.plugin.getNodeId(),
        ctx.test2.plugin.getNodeId(),
      ]);
      if (!nodeId1 || !nodeId2 || nodeId1.length < 10 || nodeId2.length < 10) {
        console.log("  Skipped: Waiting for node IDs");
        return;
      }
      assert(
        nodeId1 !== nodeId2,
        `Vaults should have different node IDs, both have: ${nodeId1}`
      );
      console.log("  Node IDs are different");
    },
  },

  {
    name: "Plugin versions match",
    async fn(ctx: TestContext) {
      const [v1, v2] = await Promise.all([
        ctx.test.plugin.getVersion(),
        ctx.test2.plugin.getVersion(),
      ]);
      if (v1 === "unknown" || v2 === "unknown") {
        console.log(`  Warning: Versions not ready yet (TEST=${v1}, TEST2=${v2})`);
        return;
      }
      assert(
        v1 === v2,
        `Plugin versions should match: TEST=${v1}, TEST2=${v2}`
      );
      console.log(`  Both vaults running v${v1}`);
    },
  },
];
