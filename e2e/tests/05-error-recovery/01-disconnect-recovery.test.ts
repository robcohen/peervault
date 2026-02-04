/**
 * Error Recovery Tests - Disconnection Recovery
 *
 * Tests recovery from connection issues and plugin reloads.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
  assertPluginEnabled,
  assertPeerCount,
} from "../../lib/assertions";

export default [
  {
    name: "Ensure sync sessions active before recovery tests",
    async fn(ctx: TestContext) {
      const test1Active = await ctx.test.plugin.ensureActiveSessions();
      const test2Active = await ctx.test2.plugin.ensureActiveSessions();

      assert(test1Active, "TEST should have active sync session");
      assert(test2Active, "TEST2 should have active sync session");
      console.log("  Sync sessions active");
    },
  },

  {
    name: "Sync resumes after plugin reload",
    async fn(ctx: TestContext) {
      // Create a file (overwrite if exists)
      await ctx.test.vault.createFile(
        "pre-reload.md",
        "Created before reload",
        true
      );
      await ctx.test2.sync.waitForFile("pre-reload.md");
      console.log("  Initial file synced");

      // Reload TEST plugin
      await ctx.test.lifecycle.reload();
      console.log("  Reloaded TEST plugin");

      // Verify plugin still enabled
      await assertPluginEnabled(ctx.test.plugin);

      // Wait for sync sessions on BOTH vaults to reach live state
      const maxWaitMs = 30000;
      const startTime = Date.now();
      let bothLive = false;
      while (Date.now() - startTime < maxWaitMs) {
        const testSessions = await ctx.test.plugin.getActiveSessions();
        const test2Sessions = await ctx.test2.plugin.getActiveSessions();
        const testLive = testSessions.some((s: { state?: string }) => s.state === "live");
        const test2Live = test2Sessions.some((s: { state?: string }) => s.state === "live");

        if (testLive && test2Live) {
          console.log("  Both sessions are live after reload");
          bothLive = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!bothLive) {
        console.log("  Warning: Not all sessions live after 30s, proceeding anyway");
      }

      // Give a small settling time for the connection to fully stabilize
      await new Promise((r) => setTimeout(r, 1000));

      // Create new file (overwrite if exists)
      await ctx.test.vault.createFile(
        "post-reload.md",
        "Created after reload",
        true
      );

      // Should still sync
      await ctx.test2.sync.waitForFile("post-reload.md", { timeoutMs: 30000 });
      console.log("  Post-reload file synced - recovery successful");
    },
  },

  {
    name: "Both plugins reload and reconnect",
    async fn(ctx: TestContext) {
      // Reload plugins sequentially to avoid CDP timeout issues
      await ctx.test.lifecycle.reload();
      await new Promise((r) => setTimeout(r, 2000)); // Small gap
      await ctx.test2.lifecycle.reload();
      console.log("  Reloaded both plugins");

      // Wait for reconnection - needs longer due to exponential backoff
      await new Promise((r) => setTimeout(r, 15000));

      // Verify both enabled
      await assertPluginEnabled(ctx.test.plugin);
      await assertPluginEnabled(ctx.test2.plugin);

      // Create and sync a file (overwrite if exists)
      await ctx.test2.vault.createFile(
        "after-both-reload.md",
        "Created after both reloaded",
        true
      );
      await ctx.test.sync.waitForFile("after-both-reload.md", {
        timeoutMs: 30000,
      });
      console.log("  Sync works after both plugins reloaded");
    },
  },

  {
    name: "Peers reconnect after reload",
    async fn(ctx: TestContext) {
      // Get peer count before reload
      const peersBefore = await ctx.test.plugin.getConnectedPeers();
      console.log(`  Peers before reload: ${peersBefore.length}`);

      // Reload TEST
      await ctx.test.lifecycle.reload();

      // Wait for reconnection
      let attempts = 0;
      const maxAttempts = 30;

      while (attempts < maxAttempts) {
        const peers = await ctx.test.plugin.getConnectedPeers();
        const connected = peers.filter((p) => p.connectionState === "connected");

        if (connected.length >= peersBefore.length) {
          console.log(`  Reconnected with ${connected.length} peer(s)`);
          return;
        }

        attempts++;
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Final check
      const finalPeers = await ctx.test.plugin.getConnectedPeers();
      const finalConnected = finalPeers.filter(
        (p) => p.connectionState === "connected"
      );
      assert(
        finalConnected.length > 0,
        `Expected at least 1 connected peer after reload, got ${finalConnected.length}`
      );
    },
  },

  {
    name: "Changes made during reconnection sync after",
    async fn(ctx: TestContext) {
      // Disable TEST plugin temporarily
      await ctx.test.lifecycle.disable();
      console.log("  Disabled TEST plugin");

      // Make changes in TEST2 while disconnected (overwrite if exists)
      await ctx.test2.vault.createFile(
        "during-disconnect.md",
        "Created while TEST was disconnected",
        true
      );
      await ctx.test2.vault.createFile(
        "during-disconnect-2.md",
        "Another file during disconnect",
        true
      );
      console.log("  Created files in TEST2 during disconnect");

      // Wait a moment
      await new Promise((r) => setTimeout(r, 1000));

      // Re-enable TEST plugin
      await ctx.test.lifecycle.enable();
      console.log("  Re-enabled TEST plugin");

      // Wait for sync
      await ctx.test.sync.waitForFile("during-disconnect.md", {
        timeoutMs: 30000,
      });
      await ctx.test.sync.waitForFile("during-disconnect-2.md");
      console.log("  Changes made during disconnect synced successfully");
    },
  },

  {
    name: "CRDT versions converge after recovery",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence();
      console.log("  CRDT versions converged after recovery tests");
    },
  },
];
