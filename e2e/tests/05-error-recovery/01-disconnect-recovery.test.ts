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
    name: "Sync resumes after plugin reload",
    async fn(ctx: TestContext) {
      // Create a file
      await ctx.test.vault.createFile(
        "pre-reload.md",
        "Created before reload"
      );
      await ctx.test2.sync.waitForFile("pre-reload.md", { timeoutMs: 30000 });
      console.log("  Initial file synced");

      // Reload TEST plugin
      await ctx.test.lifecycle.reload();
      console.log("  Reloaded TEST plugin");

      // Verify plugin still enabled
      await assertPluginEnabled(ctx.test.plugin);

      // Wait for reconnection
      await new Promise((r) => setTimeout(r, 5000));

      // Create new file
      await ctx.test.vault.createFile(
        "post-reload.md",
        "Created after reload"
      );

      // Should still sync
      await ctx.test2.sync.waitForFile("post-reload.md", { timeoutMs: 60000 });
      console.log("  Post-reload file synced - recovery successful");
    },
  },

  {
    name: "Both plugins reload and reconnect",
    async fn(ctx: TestContext) {
      // Reload both plugins
      await Promise.all([
        ctx.test.lifecycle.reload(),
        ctx.test2.lifecycle.reload(),
      ]);
      console.log("  Reloaded both plugins");

      // Wait for reconnection - needs longer due to exponential backoff
      // Both sides will fail initial connect (other not ready), then retry
      await new Promise((r) => setTimeout(r, 20000));

      // Verify both enabled
      await assertPluginEnabled(ctx.test.plugin);
      await assertPluginEnabled(ctx.test2.plugin);

      // Create and sync a file
      await ctx.test2.vault.createFile(
        "after-both-reload.md",
        "Created after both reloaded"
      );
      await ctx.test.sync.waitForFile("after-both-reload.md", {
        timeoutMs: 60000,
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

      // Make changes in TEST2 while disconnected
      await ctx.test2.vault.createFile(
        "during-disconnect.md",
        "Created while TEST was disconnected"
      );
      await ctx.test2.vault.createFile(
        "during-disconnect-2.md",
        "Another file during disconnect"
      );
      console.log("  Created files in TEST2 during disconnect");

      // Wait a moment
      await new Promise((r) => setTimeout(r, 2000));

      // Re-enable TEST plugin
      await ctx.test.lifecycle.enable();
      console.log("  Re-enabled TEST plugin");

      // Wait for sync
      await ctx.test.sync.waitForFile("during-disconnect.md", {
        timeoutMs: 60000,
      });
      await ctx.test.sync.waitForFile("during-disconnect-2.md", {
        timeoutMs: 30000,
      });
      console.log("  Changes made during disconnect synced successfully");
    },
  },

  {
    name: "CRDT versions converge after recovery",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(60000);
      console.log("  CRDT versions converged after recovery tests");
    },
  },
];
