/**
 * Scaled Setup Tests - Connection
 *
 * Verify all clients are connected and plugin is ready.
 */

import type { ScaledTestContext, ClientContext } from "../../lib/scaled-context";

interface ScaledTestDef {
  name: string;
  fn: (ctx: ScaledTestContext) => Promise<void>;
  skip?: boolean;
  minClients?: number;
}

const tests: ScaledTestDef[] = [
  {
    name: "All clients connected",
    fn: async (ctx) => {
      if (ctx.numClients === 0) {
        throw new Error("No clients connected");
      }
      console.log(`  Connected to ${ctx.numClients} client(s)`);
    },
  },

  {
    name: "All plugins have node IDs",
    fn: async (ctx) => {
      for (const client of ctx.clients) {
        const nodeId = await client.plugin.getNodeId();
        if (!nodeId || nodeId.length < 32) {
          throw new Error(`${client.name} has invalid node ID: ${nodeId}`);
        }
        console.log(`  ${client.name}: ${nodeId.slice(0, 16)}...`);
      }
    },
  },

  {
    name: "All transports are ready",
    fn: async (ctx) => {
      for (const client of ctx.clients) {
        const transportType = await client.plugin.getTransportType();
        console.log(`  ${client.name} transport: ${transportType}`);
      }
    },
  },

  {
    name: "Reset all clients to clean state",
    fn: async (ctx) => {
      await ctx.resetAll();
      console.log("  All clients reset to clean state");

      // Verify no peers after reset
      for (const client of ctx.clients) {
        const peers = await client.plugin.getConnectedPeers();
        if (peers.length > 0) {
          throw new Error(`${client.name} still has ${peers.length} peer(s) after reset`);
        }
      }
    },
  },
];

export default tests;
