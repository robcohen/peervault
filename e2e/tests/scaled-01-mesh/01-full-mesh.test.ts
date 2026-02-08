/**
 * Scaled Mesh Tests - Full Mesh Pairing
 *
 * Create a full mesh network where all clients are paired with each other.
 */

import type { ScaledTestContext } from "../../lib/scaled-context";
import { delay } from "../../config";

interface ScaledTestDef {
  name: string;
  fn: (ctx: ScaledTestContext) => Promise<void>;
  skip?: boolean;
  minClients?: number;
}

const tests: ScaledTestDef[] = [
  {
    name: "Create full mesh network",
    minClients: 2,
    fn: async (ctx) => {
      await ctx.createFullMesh();

      // Verify all clients have the expected number of peers
      const expectedPeers = ctx.numClients - 1;
      let allConnected = true;

      for (const client of ctx.clients) {
        const peers = await client.plugin.getConnectedPeers();
        if (peers.length < expectedPeers) {
          console.log(`  Warning: ${client.name} has ${peers.length}/${expectedPeers} peers`);
          allConnected = false;
        }
      }

      if (!allConnected) {
        // Wait a bit more and recheck
        await delay(5000);

        for (const client of ctx.clients) {
          const peers = await client.plugin.getConnectedPeers();
          if (peers.length < expectedPeers) {
            throw new Error(
              `${client.name} only has ${peers.length}/${expectedPeers} peers after waiting`
            );
          }
        }
      }

      console.log(`  Full mesh created with ${ctx.numClients} clients`);
    },
  },

  {
    name: "All sessions reach live state",
    minClients: 2,
    fn: async (ctx) => {
      const maxWait = 30000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        let allLive = true;

        for (const client of ctx.clients) {
          const sessions = await client.plugin.getActiveSessions();
          const liveSessions = sessions.filter((s: { state: string }) => s.state === "live");

          if (liveSessions.length < ctx.numClients - 1) {
            allLive = false;
            break;
          }
        }

        if (allLive) {
          console.log("  All sessions in live state");
          return;
        }

        await delay(500);
      }

      // Log final state for debugging
      for (const client of ctx.clients) {
        const sessions = await client.plugin.getActiveSessions();
        const states = sessions.map((s: { state: string }) => s.state).join(", ");
        console.log(`  ${client.name} sessions: ${states || "(none)"}`);
      }

      throw new Error("Not all sessions reached live state within timeout");
    },
  },

  {
    name: "Mesh sync test file",
    minClients: 2,
    fn: async (ctx) => {
      // Create file on first client
      const testFile = `mesh-test-${Date.now()}.md`;
      const testContent = `# Mesh Test\n\nCreated by ${ctx.clients[0].name}\nClients: ${ctx.numClients}`;

      await ctx.clients[0].vault.createFile(testFile, testContent);
      console.log(`  Created ${testFile} on ${ctx.clients[0].name}`);

      // Wait for convergence
      const converged = await ctx.waitForConvergence(30000);
      if (!converged) {
        throw new Error("CRDT versions did not converge");
      }

      // Verify file exists on all clients
      await delay(2000);

      for (let i = 1; i < ctx.clients.length; i++) {
        const client = ctx.clients[i];
        const content = await client.vault.readFile(testFile);

        if (!content) {
          throw new Error(`File not found on ${client.name}`);
        }

        if (content !== testContent) {
          throw new Error(
            `Content mismatch on ${client.name}: expected "${testContent.slice(0, 50)}...", got "${content.slice(0, 50)}..."`
          );
        }
      }

      console.log(`  File synced to all ${ctx.numClients} clients`);

      // Cleanup
      await ctx.clients[0].vault.deleteFile(testFile);
      await ctx.waitForConvergence(10000);
    },
  },
];

export default tests;
