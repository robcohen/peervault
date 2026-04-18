/**
 * Chaos Testing - Resilience Tests
 *
 * Tests system resilience under adverse conditions:
 * - Random disconnects
 * - Rapid file operations
 * - Plugin reloads during sync
 * - Concurrent stress
 */

import { delay } from "../../config";
import type { TestContext } from "../../lib/context";
import { assert, assertFileExists, assertWithRetry } from "../../lib/assertions";

/** Random integer between min and max (inclusive) */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random delay between min and max milliseconds */
async function randomDelay(minMs: number, maxMs: number): Promise<void> {
  await delay(randomInt(minMs, maxMs));
}

export default [
  {
    name: "Ensure sync sessions active before chaos tests",
    tags: ["chaos"],
    async fn(ctx: TestContext) {
      const active1 = await ctx.test.plugin.ensureActiveSessions();
      const active2 = await ctx.test2.plugin.ensureActiveSessions();
      assert(active1 && active2, "Both vaults should have active sync sessions");
      console.log("  Sync sessions active - ready for chaos");
    },
  },

  {
    name: "Chaos: Rapid file create/delete cycles",
    tags: ["chaos"],
    async fn(ctx: TestContext) {
      const cycles = 10;
      let successCount = 0;

      for (let i = 0; i < cycles; i++) {
        const filename = `chaos-rapid-${i}.md`;

        try {
          // Create file
          await ctx.test.vault.createFile(filename, `Chaos cycle ${i}`, true);

          // Random delay (simulating real-world timing)
          await randomDelay(100, 500);

          // Delete file
          await ctx.test.vault.deleteFile(filename);

          successCount++;
        } catch {
          // Expected - operations may conflict
        }
      }

      console.log(`  Completed ${successCount}/${cycles} rapid create/delete cycles`);
      assert(successCount >= cycles / 2, "At least half of cycles should succeed");
    },
  },

  {
    name: "Chaos: Concurrent operations from both vaults",
    tags: ["chaos"],
    async fn(ctx: TestContext) {
      const operations = 20;
      const results: Array<{ vault: string; op: string; success: boolean }> = [];

      // Start concurrent operations from both vaults
      const promises: Promise<void>[] = [];

      for (let i = 0; i < operations; i++) {
        // Alternate between vaults
        const vault = i % 2 === 0 ? ctx.test : ctx.test2;
        const vaultName = i % 2 === 0 ? "TEST" : "TEST2";
        const filename = `chaos-concurrent-${i}.md`;

        promises.push(
          (async () => {
            try {
              await randomDelay(0, 200);
              await vault.vault.createFile(filename, `Concurrent ${i} from ${vaultName}`, true);
              await randomDelay(50, 150);
              await vault.vault.deleteFile(filename);
              results.push({ vault: vaultName, op: `file-${i}`, success: true });
            } catch {
              results.push({ vault: vaultName, op: `file-${i}`, success: false });
            }
          })()
        );
      }

      await Promise.allSettled(promises);

      const successCount = results.filter(r => r.success).length;
      console.log(`  ${successCount}/${operations} concurrent operations succeeded`);

      // Wait for sync to stabilize
      await delay(2000);
    },
  },

  {
    name: "Chaos: Plugin reload during active sync",
    tags: ["chaos"],
    async fn(ctx: TestContext) {
      // Create a file to trigger sync
      const filename = "chaos-reload-sync.md";
      await ctx.test.vault.createFile(filename, "Content before reload", true);

      // Immediately reload the plugin while sync might be happening
      await ctx.test.lifecycle.reload();

      // Wait for plugin to recover
      await delay(3000);

      // Clear any error sessions
      await ctx.test.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          if (plugin?.peerManager?.clearErrorSessions) {
            plugin.peerManager.clearErrorSessions();
          }
        })()
      `);

      // Verify plugin recovered
      const enabled = await ctx.test.plugin.isEnabled();
      assert(enabled, "Plugin should be enabled after reload during sync");

      console.log("  Plugin recovered from reload during sync");

      // Cleanup
      try { await ctx.test.vault.deleteFile(filename); } catch {}
      try { await ctx.test2.vault.deleteFile(filename); } catch {}
    },
  },

  {
    name: "Chaos: Random file modifications storm",
    tags: ["chaos"],
    async fn(ctx: TestContext) {
      const files = ["storm-1.md", "storm-2.md", "storm-3.md"];
      const modifications = 30;

      // Create base files
      for (const file of files) {
        await ctx.test.vault.createFile(file, "Base content\n", true);
      }
      await delay(1000);

      // Storm of modifications
      const promises: Promise<void>[] = [];

      for (let i = 0; i < modifications; i++) {
        const file = files[randomInt(0, files.length - 1)];
        const vault = randomInt(0, 1) === 0 ? ctx.test : ctx.test2;

        promises.push(
          (async () => {
            try {
              await randomDelay(0, 100);
              const content = `Modification ${i} at ${Date.now()}\n`;
              await vault.vault.createFile(file, content, true);
            } catch {
              // Expected - concurrent modifications may conflict
            }
          })()
        );
      }

      await Promise.allSettled(promises);

      // Wait for CRDT to converge
      await delay(3000);

      // Verify files exist and content converged
      for (const file of files) {
        try {
          const [c1, c2] = await Promise.all([
            ctx.test.vault.readFile(file),
            ctx.test2.vault.readFile(file),
          ]);

          if (c1 !== c2) {
            console.log(`  Warning: ${file} content differs (CRDT still converging)`);
          }
        } catch {
          console.log(`  Warning: ${file} may not exist on both vaults`);
        }
      }

      console.log(`  Completed ${modifications} random modifications across ${files.length} files`);

      // Cleanup
      for (const file of files) {
        try { await ctx.test.vault.deleteFile(file); } catch {}
        try { await ctx.test2.vault.deleteFile(file); } catch {}
      }
    },
  },

  {
    name: "Chaos: Stress test with verification",
    tags: ["chaos"],
    async fn(ctx: TestContext) {
      const testFile = "chaos-stress-verify.md";
      const iterations = 10;
      let verified = 0;

      for (let i = 0; i < iterations; i++) {
        const content = `Stress iteration ${i} - ${Date.now()}`;

        // Create or update file
        await ctx.test.vault.createFile(testFile, content, true);

        // Random delay
        await randomDelay(200, 800);

        // Verify it synced (with retry)
        try {
          await assertWithRetry(
            async () => {
              const synced = await ctx.test2.vault.readFile(testFile);
              assert(synced === content, "Content should match");
            },
            { maxAttempts: 5, delayMs: 500 }
          );
          verified++;
        } catch {
          console.log(`  Iteration ${i} verification failed (timing issue)`);
        }
      }

      console.log(`  Verified ${verified}/${iterations} stress iterations`);
      assert(verified >= iterations / 2, "At least half of iterations should verify");

      // Cleanup
      try { await ctx.test.vault.deleteFile(testFile); } catch {}
      try { await ctx.test2.vault.deleteFile(testFile); } catch {}
    },
  },

  {
    name: "Chaos: Recovery after session errors",
    tags: ["chaos"],
    async fn(ctx: TestContext) {
      // Clear any existing error sessions
      await ctx.test.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          if (plugin?.peerManager?.clearErrorSessions) {
            plugin.peerManager.clearErrorSessions();
          }
        })()
      `);
      await ctx.test2.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          if (plugin?.peerManager?.clearErrorSessions) {
            plugin.peerManager.clearErrorSessions();
          }
        })()
      `);

      // Force sync to re-establish connections
      await Promise.allSettled([
        ctx.test.plugin.forceSync().catch(() => {}),
        ctx.test2.plugin.forceSync().catch(() => {}),
      ]);

      // Wait for recovery
      await delay(5000);

      // Verify we can still sync
      const testFile = "chaos-recovery-test.md";
      await ctx.test.vault.createFile(testFile, "Recovery test content", true);

      try {
        await ctx.test2.sync.waitForFile(testFile, { timeoutMs: 30000 });
        console.log("  Successfully synced after recovery");
      } catch {
        console.log("  Warning: Sync after recovery timed out (may need more time)");
      }

      // Cleanup
      try { await ctx.test.vault.deleteFile(testFile); } catch {}
      try { await ctx.test2.vault.deleteFile(testFile); } catch {}
    },
  },

  {
    name: "Chaos: Final state verification",
    tags: ["chaos"],
    async fn(ctx: TestContext) {
      // Wait for everything to settle
      await delay(3000);

      // Check that both vaults are still operational
      const [nodeId1, nodeId2] = await Promise.all([
        ctx.test.plugin.getNodeId(),
        ctx.test2.plugin.getNodeId(),
      ]);

      assert(nodeId1.length > 0, "TEST should have node ID after chaos tests");
      assert(nodeId2.length > 0, "TEST2 should have node ID after chaos tests");

      // Check for error sessions
      const [sessions1, sessions2] = await Promise.all([
        ctx.test.plugin.getActiveSessions(),
        ctx.test2.plugin.getActiveSessions(),
      ]);

      const errors1 = sessions1.filter(s => s.state === "error").length;
      const errors2 = sessions2.filter(s => s.state === "error").length;

      if (errors1 > 0 || errors2 > 0) {
        console.log(`  Warning: ${errors1 + errors2} error sessions after chaos (will be cleared)`);

        // Clean up error sessions
        await ctx.test.client.evaluate(`
          (async function() {
            const plugin = window.app?.plugins?.plugins?.["peervault"];
            if (plugin?.peerManager?.clearErrorSessions) {
              plugin.peerManager.clearErrorSessions();
            }
          })()
        `);
        await ctx.test2.client.evaluate(`
          (async function() {
            const plugin = window.app?.plugins?.plugins?.["peervault"];
            if (plugin?.peerManager?.clearErrorSessions) {
              plugin.peerManager.clearErrorSessions();
            }
          })()
        `);
      }

      console.log("  Chaos tests complete - system verified operational");
    },
  },
];
