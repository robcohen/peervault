/**
 * Cloud Sync Tests - API Verification
 *
 * Tests that the CloudSync API is available and properly structured.
 * Note: These tests don't require a real S3 bucket - they verify the API surface.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertTruthy,
  assertEqual,
} from "../../lib/assertions";

export default [
  {
    name: "CloudSync API is available",
    async fn(ctx: TestContext) {
      const hasCloudSync = await ctx.test.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          return typeof plugin?.getCloudSync === "function";
        })()
      `);

      assertTruthy(hasCloudSync, "Plugin should have getCloudSync method");
      console.log("  CloudSync API available: true");
    },
  },

  {
    name: "CloudSync instance exists",
    async fn(ctx: TestContext) {
      const cloudSyncExists = await ctx.test.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          return cloudSync !== null && cloudSync !== undefined;
        })()
      `);

      assertTruthy(cloudSyncExists, "CloudSync instance should exist");
      console.log("  CloudSync instance exists: true");
    },
  },

  {
    name: "CloudSync has required methods",
    async fn(ctx: TestContext) {
      const methods = await ctx.test.client.evaluate<string[]>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return [];

          const requiredMethods = [
            "initialize",
            "configure",
            "disable",
            "setVaultKey",
            "getState",
            "isConfigured",
            "startAutoSync",
            "stopAutoSync",
            "queueDelta",
            "sync",
            "commit",
            "getCommitHistory",
            "setBlobStore",
            "setConflictStrategy",
          ];

          return requiredMethods.filter(m => typeof cloudSync[m] === "function");
        })()
      `);

      console.log(`  Methods found: ${methods.length}`);

      const requiredCount = 14; // Number of required methods
      assert(
        methods.length >= requiredCount,
        `CloudSync should have at least ${requiredCount} methods, found ${methods.length}: ${methods.join(", ")}`,
      );
    },
  },

  {
    name: "CloudSync state structure is correct",
    async fn(ctx: TestContext) {
      const state = await ctx.test.client.evaluate<Record<string, unknown>>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return null;
          return cloudSync.getState();
        })()
      `);

      assertTruthy(state, "CloudSync state should be returned");
      assertTruthy("status" in state, "State should have status field");
      assertTruthy("pendingUploads" in state, "State should have pendingUploads field");
      assertTruthy("pendingDownloads" in state, "State should have pendingDownloads field");

      console.log(`  State: ${JSON.stringify(state)}`);
    },
  },

  {
    name: "CloudSync is not configured by default",
    async fn(ctx: TestContext) {
      const isConfigured = await ctx.test.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          return cloudSync?.isConfigured() ?? false;
        })()
      `);

      assertEqual(isConfigured, false, "CloudSync should not be configured by default");
      console.log("  Not configured by default: confirmed");
    },
  },

  {
    name: "CloudSync status is disabled when not configured",
    async fn(ctx: TestContext) {
      const status = await ctx.test.client.evaluate<string>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          return cloudSync?.getState()?.status ?? "unknown";
        })()
      `);

      assertEqual(status, "disabled", "Status should be 'disabled' when not configured");
      console.log(`  Status when not configured: ${status}`);
    },
  },

  {
    name: "CloudSync commit history is empty when not configured",
    async fn(ctx: TestContext) {
      const commits = await ctx.test.client.evaluate<unknown[]>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          return await cloudSync?.getCommitHistory() ?? [];
        })()
      `);

      assertEqual(commits.length, 0, "Commit history should be empty when not configured");
      console.log("  Commit history empty: confirmed");
    },
  },

  {
    name: "CloudSync sync returns error when not configured",
    async fn(ctx: TestContext) {
      const result = await ctx.test.client.evaluate<{ success: boolean; error?: string }>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          return await cloudSync?.sync() ?? { success: false, error: "No cloudSync" };
        })()
      `);

      assertEqual(result.success, false, "Sync should fail when not configured");
      assertTruthy(result.error, "Should have error message");
      console.log(`  Sync result: ${result.error}`);
    },
  },

  {
    name: "CloudSync API available on both vaults",
    async fn(ctx: TestContext) {
      const test2HasCloudSync = await ctx.test2.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          return typeof plugin?.getCloudSync === "function";
        })()
      `);

      assertTruthy(test2HasCloudSync, "TEST2 should have CloudSync API");
      console.log("  TEST2 CloudSync API available: true");
    },
  },
];
