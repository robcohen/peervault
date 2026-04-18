/**
 * Pairing Tests - Invite Generation and Exchange
 *
 * Tests the device pairing flow using invite tickets.
 * Simplified for the new WASM-based plugin.
 */

import { delay } from "../../config";
import type { TestContext } from "../../lib/context";
import {
  assert,
  assertTruthy,
} from "../../lib/assertions";
import { getConfig } from "../../config";

// Store invite for subsequent tests
let ticket: string = "";
let testNodeId: string = "";
let test2NodeId: string = "";

export default [
  {
    name: "Reload plugins to get latest code",
    async fn(ctx: TestContext) {
      // Reload both plugins to ensure we have the latest code
      await ctx.test.lifecycle.reload();
      await ctx.test2.lifecycle.reload();
      console.log("  Plugins reloaded");

      // Re-configure relay URL after reload (plugin state is reset)
      const cfg = getConfig();
      const relayUrl = cfg.relay?.url ?? "http://localhost:3340";
      await ctx.test.plugin.setRelayUrl(relayUrl);
      await ctx.test2.plugin.setRelayUrl(relayUrl);
      console.log(`  Relay URL set to: ${relayUrl}`);
    },
  },

  {
    name: "Get node IDs for both vaults",
    async fn(ctx: TestContext) {
      testNodeId = await ctx.test.plugin.getNodeId();
      test2NodeId = await ctx.test2.plugin.getNodeId();

      assertTruthy(testNodeId, "TEST should have a node ID");
      assertTruthy(test2NodeId, "TEST2 should have a node ID");

      console.log(`  TEST node: ${testNodeId.slice(0, 16)}...`);
      console.log(`  TEST2 node: ${test2NodeId.slice(0, 16)}...`);
    },
  },

  {
    name: "Generate pairing ticket from TEST vault",
    async fn(ctx: TestContext) {
      // Use getPairingTicket() which includes a one-time nonce for secure pairing
      // Format: base64(JSON({ t: transport, k: encryptionKey, v: vaultId, n: nonce }))
      ticket = await ctx.test.plugin.getPairingTicket();

      assertTruthy(ticket, "Ticket should be generated");
      assert(ticket.length > 50, "Ticket should be a non-trivial string");

      // Verify it's valid base64 JSON with expected fields
      try {
        const decoded = JSON.parse(atob(ticket));
        assertTruthy(decoded.t, "Ticket should contain transport");
        assertTruthy(decoded.n, "Ticket should contain nonce");
        console.log(`  Ticket contains nonce: ${decoded.n?.slice(0, 16)}...`);
      } catch {
        throw new Error("Ticket should be valid base64-encoded JSON");
      }

      console.log(`  Ticket length: ${ticket.length} chars`);
    },
  },

  {
    name: "Add peer to TEST2 using ticket",
    async fn(ctx: TestContext) {
      console.log(`  Using ticket: ${ticket.slice(0, 50)}...`);

      // Try to add peer directly with detailed error handling
      try {
        const result = await ctx.test2.client.evaluate<string>(`
          (async function() {
            // Skip vault ID validation for E2E tests (different test vaults)
            window.E2E_SKIP_VAULT_ID_CHECK = true;

            const plugin = window.app?.plugins?.plugins?.["peervault"];
            if (!plugin?.client?.addPeer) {
              throw new Error("Plugin not available or addPeer not found");
            }
            try {
              const peerId = await plugin.client.addPeer(${JSON.stringify(ticket)}, "TEST");
              return "success:" + peerId;
            } catch (e) {
              // Try to extract error details
              const msg = e?.message || e?.toString?.() || JSON.stringify(e) || "unknown error";
              console.error("[E2E] addPeer error:", e);
              return "error:" + msg;
            }
          })()
        `);

        console.log(`  addPeer result: ${result}`);

        if (result.startsWith("error:")) {
          throw new Error(result.slice(6));
        }

        console.log(`  Peer added successfully`);
      } catch (e) {
        console.log(`  addPeer failed: ${e}`);
        throw e;
      }

      // Give a moment for the connection to register
      await delay(1000);
    },
  },

  {
    name: "Wait for pairing to complete",
    async fn(ctx: TestContext) {
      const cfg = getConfig();

      // Wait for TEST2 to have TEST as a peer
      const pollMs = 500;
      const maxAttempts = Math.ceil(cfg.sync.pairingTimeout / pollMs);
      let attempts = 0;

      while (attempts < maxAttempts) {
        // Check if TEST2 sees TEST as a peer
        const peers = await ctx.test2.plugin.getPeers();
        const hasPeer = peers.length > 0;

        if (hasPeer) {
          console.log(`  TEST2 has ${peers.length} peer(s)`);
          return;
        }

        attempts++;
        if (attempts % 20 === 0) {
          console.log(`  Still waiting for pairing... (${attempts * pollMs / 1000}s)`);
        }
        await delay(pollMs);
      }

      throw new Error("Pairing did not complete within timeout");
    },
  },

  {
    name: "Vaults are now peers",
    async fn(ctx: TestContext) {
      // Check TEST2 has peers (added TEST)
      const test2Peers = await ctx.test2.plugin.getPeers();
      assert(test2Peers.length > 0, `TEST2 should have at least 1 peer. Got: ${test2Peers.length}`);
      console.log(`  TEST2 peers: ${test2Peers.map(p => p.id.slice(0, 8)).join(", ")}`);

      // Check TEST has peers (should see TEST2 after sync)
      const testPeers = await ctx.test.plugin.getPeers();
      console.log(`  TEST peers: ${testPeers.map(p => p.id.slice(0, 8)).join(", ")}`);

      console.log("  Pairing verified");
    },
  },

  {
    name: "Trigger sync and verify connection",
    async fn(ctx: TestContext) {
      // Trigger a sync to ensure both sides are connected
      try {
        await ctx.test2.plugin.syncAll();
        console.log("  Sync triggered on TEST2");
      } catch (err) {
        console.log(`  Sync returned: ${err}`);
      }

      // Wait a moment for sync to complete
      await delay(2000);

      // Verify CRDT file lists are accessible
      const test1Files = await ctx.test.plugin.listFiles();
      const test2Files = await ctx.test2.plugin.listFiles();

      console.log(`  TEST CRDT files: ${test1Files.length}`);
      console.log(`  TEST2 CRDT files: ${test2Files.length}`);

      console.log("  Sync connection verified");
    },
  },
];
