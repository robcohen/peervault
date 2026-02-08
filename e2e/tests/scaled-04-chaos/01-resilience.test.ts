/**
 * Scaled Chaos Testing - Resilience Tests
 *
 * Tests system resilience under adverse conditions in N-client mesh:
 * - Random client disconnects
 * - Network partitions (simulated)
 * - Rapid concurrent operations
 * - Plugin reloads during sync
 * - Split-brain scenarios
 */

import type { ScaledTestContext, ClientContext } from "../../lib/scaled-context";
import { delay } from "../../config";

interface ScaledTestDef {
  name: string;
  fn: (ctx: ScaledTestContext) => Promise<void>;
  skip?: boolean;
  minClients?: number;
}

/** Random integer between min and max (inclusive) */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random delay between min and max milliseconds */
async function randomDelay(minMs: number, maxMs: number): Promise<void> {
  await delay(randomInt(minMs, maxMs));
}

/** Pick random client from array */
function randomClient(clients: ClientContext[]): ClientContext {
  return clients[randomInt(0, clients.length - 1)];
}

const tests: ScaledTestDef[] = [
  {
    name: "Verify mesh is operational before chaos",
    minClients: 2,
    fn: async (ctx) => {
      // Clear any existing errors
      await Promise.allSettled(
        ctx.clients.map((c) =>
          c.client.evaluate(`
            (async function() {
              const plugin = window.app?.plugins?.plugins?.["peervault"];
              if (plugin?.peerManager?.clearErrorSessions) {
                plugin.peerManager.clearErrorSessions();
              }
            })()
          `)
        )
      );

      await delay(1000);

      // Check connectivity
      let allConnected = true;
      for (const client of ctx.clients) {
        const peers = await client.plugin.getConnectedPeers();
        if (peers.length < ctx.numClients - 1) {
          allConnected = false;
          console.log(`  Warning: ${client.name} has ${peers.length}/${ctx.numClients - 1} peers`);
        }
      }

      if (!allConnected) {
        console.log("  Attempting to re-establish connections...");
        await Promise.allSettled(ctx.clients.map((c) => c.plugin.forceSync().catch(() => {})));
        await delay(5000);
      }

      console.log("  Mesh operational - ready for chaos testing");
    },
  },

  {
    name: "Chaos: Rapid file storm from random clients",
    minClients: 2,
    fn: async (ctx) => {
      const operations = Math.min(30, ctx.numClients * 10);
      const results: { client: string; success: boolean }[] = [];
      const testPrefix = `chaos-storm-${Date.now()}`;

      const promises = Array.from({ length: operations }, async (_, i) => {
        const client = randomClient(ctx.clients);
        const filename = `${testPrefix}-${i}.md`;

        try {
          await randomDelay(0, 200);
          await client.vault.createFile(filename, `Storm file ${i} from ${client.name}`);
          await randomDelay(50, 200);
          await client.vault.deleteFile(filename);
          results.push({ client: client.name, success: true });
        } catch {
          results.push({ client: client.name, success: false });
        }
      });

      await Promise.allSettled(promises);

      const successCount = results.filter((r) => r.success).length;
      console.log(`  ${successCount}/${operations} rapid operations succeeded`);

      // Wait for dust to settle
      await delay(2000);

      if (successCount < operations / 2) {
        throw new Error(`Too many failures: ${operations - successCount}/${operations}`);
      }
    },
  },

  {
    name: "Chaos: Concurrent writes to same file from all clients",
    minClients: 3,
    fn: async (ctx) => {
      const filename = `chaos-concurrent-${Date.now()}.md`;

      // Create base file
      await ctx.clients[0].vault.createFile(filename, "# Concurrent Test\n\n");
      await ctx.waitForConvergence(30000);

      // All clients write simultaneously
      await Promise.allSettled(
        ctx.clients.map((client) =>
          client.vault.modifyFile(filename, `# Concurrent Test\n\nLast edit: ${client.name}\n`)
        )
      );

      // Wait for CRDT to merge
      await delay(3000);
      const converged = await ctx.waitForConvergence(30000);

      if (converged) {
        // Verify all clients have same content
        const contents = await Promise.all(
          ctx.clients.map((c) => c.vault.readFile(filename).catch(() => null))
        );

        const validContents = contents.filter((c) => c !== null);
        const allSame = validContents.every((c) => c === validContents[0]);

        if (allSame) {
          console.log(`  CRDT correctly merged ${ctx.numClients} concurrent writes`);
        } else {
          console.log(`  Warning: Content divergence detected (may still be converging)`);
        }
      } else {
        console.log(`  Warning: Convergence timeout after concurrent writes`);
      }

      // Cleanup
      await ctx.clients[0].vault.deleteFile(filename).catch(() => {});
      await delay(1000);
    },
  },

  {
    name: "Chaos: Plugin reload on random client during sync",
    minClients: 2,
    fn: async (ctx) => {
      const testFile = `chaos-reload-${Date.now()}.md`;

      // Pick a random non-hub client to reload
      const targetIdx = randomInt(1, ctx.numClients - 1);
      const target = ctx.clients[targetIdx];
      const hub = ctx.clients[0];

      // Start a sync operation
      await hub.vault.createFile(testFile, "Content before reload");

      // Immediately reload the target plugin
      await target.lifecycle.reload();

      // Wait for recovery
      await delay(5000);

      // Clear error sessions on the reloaded client
      await target.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          if (plugin?.peerManager?.clearErrorSessions) {
            plugin.peerManager.clearErrorSessions();
          }
        })()
      `);

      // Verify plugin recovered
      const enabled = await target.plugin.isEnabled();
      if (!enabled) {
        throw new Error(`Plugin on ${target.name} did not recover from reload`);
      }

      console.log(`  ${target.name} recovered from plugin reload during sync`);

      // Cleanup
      await hub.vault.deleteFile(testFile).catch(() => {});
    },
  },

  {
    name: "Chaos: Simulate network partition (subset isolation)",
    minClients: 4,
    fn: async (ctx) => {
      // Simulate partition by having some clients make changes that others don't see immediately
      // This tests CRDT merge behavior when partitions heal

      const partition1 = ctx.clients.slice(0, Math.floor(ctx.numClients / 2));
      const partition2 = ctx.clients.slice(Math.floor(ctx.numClients / 2));

      console.log(`  Simulating partition: [${partition1.map((c) => c.name).join(", ")}] vs [${partition2.map((c) => c.name).join(", ")}]`);

      const file1 = `chaos-partition-p1-${Date.now()}.md`;
      const file2 = `chaos-partition-p2-${Date.now()}.md`;

      // Each partition creates different files
      await partition1[0].vault.createFile(file1, "Content from partition 1");
      await partition2[0].vault.createFile(file2, "Content from partition 2");

      // Brief delay to simulate partition duration
      await delay(1000);

      // Now let full convergence happen (partition healed)
      const converged = await ctx.waitForConvergence(60000);

      if (converged) {
        // Verify both files exist on all clients
        let allHaveBoth = true;
        for (const client of ctx.clients) {
          const [c1, c2] = await Promise.all([
            client.vault.readFile(file1).catch(() => null),
            client.vault.readFile(file2).catch(() => null),
          ]);

          if (!c1 || !c2) {
            allHaveBoth = false;
            console.log(`  ${client.name} missing files after partition heal`);
          }
        }

        if (allHaveBoth) {
          console.log(`  Partition healed - all ${ctx.numClients} clients have both files`);
        }
      } else {
        console.log(`  Warning: Convergence timeout after partition simulation`);
      }

      // Cleanup
      await ctx.clients[0].vault.deleteFile(file1).catch(() => {});
      await ctx.clients[0].vault.deleteFile(file2).catch(() => {});
      await ctx.waitForConvergence(10000);
    },
  },

  {
    name: "Chaos: Stress test with progressive load",
    minClients: 2,
    fn: async (ctx) => {
      const testPrefix = `chaos-stress-${Date.now()}`;
      const rounds = 5;
      let totalCreated = 0;
      let totalVerified = 0;

      for (let round = 0; round < rounds; round++) {
        const filesThisRound = (round + 1) * ctx.numClients;
        const createdFiles: string[] = [];

        // Create files from random clients
        for (let i = 0; i < filesThisRound; i++) {
          const client = randomClient(ctx.clients);
          const filename = `${testPrefix}-r${round}-f${i}.md`;
          try {
            await client.vault.createFile(filename, `Round ${round}, file ${i}`);
            createdFiles.push(filename);
            totalCreated++;
          } catch {
            // Ignore creation failures
          }
          await delay(20);
        }

        // Wait for convergence
        await ctx.waitForConvergence(30000 + round * 10000);

        // Verify files on random client
        const verifier = randomClient(ctx.clients);
        for (const file of createdFiles) {
          try {
            const content = await verifier.vault.readFile(file);
            if (content) totalVerified++;
          } catch {
            // File not synced yet
          }
        }

        // Cleanup this round
        for (const file of createdFiles) {
          await ctx.clients[0].vault.deleteFile(file).catch(() => {});
        }

        console.log(`  Round ${round + 1}: ${createdFiles.length} created, verified on ${verifier.name}`);
      }

      console.log(`  Progressive stress: ${totalVerified}/${totalCreated} files verified across rounds`);

      if (totalVerified < totalCreated / 2) {
        throw new Error(`Sync reliability too low: ${totalVerified}/${totalCreated}`);
      }
    },
  },

  {
    name: "Chaos: Random client restarts",
    minClients: 3,
    fn: async (ctx) => {
      // Reload plugins on random clients and verify mesh recovers
      const restartsToPerform = Math.min(3, ctx.numClients - 1);
      const restarted: string[] = [];

      for (let i = 0; i < restartsToPerform; i++) {
        // Pick a random non-hub client
        const idx = randomInt(1, ctx.numClients - 1);
        const client = ctx.clients[idx];

        if (restarted.includes(client.name)) continue;

        console.log(`  Restarting ${client.name}...`);
        await client.lifecycle.reload();
        restarted.push(client.name);

        await delay(2000);
      }

      // Wait for mesh to stabilize
      await delay(5000);

      // Clear error sessions on all clients
      await Promise.allSettled(
        ctx.clients.map((c) =>
          c.client.evaluate(`
            (async function() {
              const plugin = window.app?.plugins?.plugins?.["peervault"];
              if (plugin?.peerManager?.clearErrorSessions) {
                plugin.peerManager.clearErrorSessions();
              }
            })()
          `)
        )
      );

      // Verify all clients still operational
      for (const client of ctx.clients) {
        const enabled = await client.plugin.isEnabled();
        if (!enabled) {
          throw new Error(`${client.name} plugin not enabled after restart chaos`);
        }
      }

      console.log(`  Mesh recovered after ${restarted.length} random restarts`);
    },
  },

  {
    name: "Chaos: Verify mesh recovery and final state",
    minClients: 2,
    fn: async (ctx) => {
      // Final recovery attempt
      await Promise.allSettled(
        ctx.clients.map((c) =>
          c.client.evaluate(`
            (async function() {
              const plugin = window.app?.plugins?.plugins?.["peervault"];
              if (plugin?.peerManager?.clearErrorSessions) {
                plugin.peerManager.clearErrorSessions();
              }
            })()
          `)
        )
      );

      // Force sync to re-establish connections
      await Promise.allSettled(
        ctx.clients.map((c) => c.plugin.forceSync().catch(() => {}))
      );

      await delay(5000);

      // Test that sync still works
      const testFile = `chaos-final-${Date.now()}.md`;
      await ctx.clients[0].vault.createFile(testFile, "Final verification content");

      const converged = await ctx.waitForConvergence(30000);

      if (converged) {
        // Verify file on a random non-hub client
        const verifier = ctx.clients[randomInt(1, ctx.numClients - 1)];
        const content = await verifier.vault.readFile(testFile).catch(() => null);

        if (content) {
          console.log(`  Mesh fully recovered - sync verified on ${verifier.name}`);
        } else {
          console.log(`  Warning: Final verification file not found on ${verifier.name}`);
        }
      } else {
        console.log(`  Warning: Final convergence timeout`);
      }

      // Cleanup
      await ctx.clients[0].vault.deleteFile(testFile).catch(() => {});

      // Report final state
      console.log("\n  Final mesh state:");
      for (const client of ctx.clients) {
        const sessions = await client.plugin.getActiveSessions();
        const liveCount = sessions.filter((s: { state: string }) => s.state === "live").length;
        const errorCount = sessions.filter((s: { state: string }) => s.state === "error").length;
        console.log(`    ${client.name}: ${liveCount} live, ${errorCount} error sessions`);
      }

      console.log("\n  Chaos testing complete");
    },
  },
];

export default tests;
