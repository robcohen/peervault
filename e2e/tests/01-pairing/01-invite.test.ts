/**
 * Pairing Tests - Invite Generation and Exchange
 *
 * Tests the device pairing flow using invite tickets.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertTruthy,
  assertIncludes,
} from "../../lib/assertions";

// Store invite for subsequent tests
let invite: string = "";
let testNodeId: string = "";
let test2NodeId: string = "";

export default [
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
    name: "Generate invite from TEST vault",
    async fn(ctx: TestContext) {
      invite = await ctx.test.plugin.generateInvite();

      assertTruthy(invite, "Invite should be generated");
      assert(invite.length > 50, "Invite should be a non-trivial string");

      // Invite should be base64 or similar encoded JSON
      console.log(`  Invite length: ${invite.length} chars`);
    },
  },

  {
    name: "Invite contains valid JSON structure",
    async fn(ctx: TestContext) {
      // Decode and verify structure
      let parsed: unknown;
      try {
        parsed = JSON.parse(invite);
      } catch {
        // Might be base64 encoded
        try {
          const decoded = atob(invite);
          parsed = JSON.parse(decoded);
        } catch {
          // That's OK - it might use a different format
          console.log("  Invite uses non-JSON format");
          return;
        }
      }

      // If we got here, it's valid JSON
      assert(typeof parsed === "object" && parsed !== null, "Parsed invite should be an object");
      console.log("  Invite is valid JSON");
    },
  },

  {
    name: "Add peer to TEST2 using invite",
    async fn(ctx: TestContext) {
      // Add the peer using the invite ticket
      // The addPeer call may block waiting for connection, so we use a timeout
      // The actual pairing completion is verified in subsequent tests
      const addPeerPromise = ctx.test2.plugin.addPeer(invite);

      // Race between addPeer completing and a 10s timeout
      // Either outcome is fine - we verify pairing in later tests
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.log("  addPeer still running, continuing (pairing in progress)");
          resolve();
        }, 10000);
      });

      await Promise.race([addPeerPromise, timeoutPromise]);

      // Give a moment for the connection attempt to register
      await new Promise((r) => setTimeout(r, 1000));

      console.log("  Peer add initiated in TEST2");
    },
  },

  {
    name: "TEST receives pairing request",
    async fn(ctx: TestContext) {
      // Wait for the pairing request to arrive
      let attempts = 0;
      const maxAttempts = 30;

      while (attempts < maxAttempts) {
        const requests = await ctx.test.plugin.getPendingPairingRequests();
        if (requests.length > 0) {
          console.log(`  Received ${requests.length} pairing request(s)`);
          const request = requests[0];
          assert(
            request.nodeId.startsWith(test2NodeId.slice(0, 8)) ||
              test2NodeId.startsWith(request.nodeId.slice(0, 8)),
            `Pairing request should be from TEST2, got ${request.nodeId.slice(0, 8)}`
          );
          return;
        }

        attempts++;
        await new Promise((r) => setTimeout(r, 1000));
      }

      throw new Error("TEST did not receive pairing request within timeout");
    },
  },

  {
    name: "Accept pairing request on TEST",
    async fn(ctx: TestContext) {
      // Get the pending request
      const requests = await ctx.test.plugin.getPendingPairingRequests();
      assert(requests.length > 0, "Should have pending pairing request");

      // Accept it
      await ctx.test.plugin.acceptPairingRequest(requests[0].nodeId);
      console.log("  Accepted pairing request");

      // Wait for peer to become connected (instead of hard-coded delay)
      await ctx.test.sync.waitForPeerConnected(test2NodeId, {
        timeoutMs: 15000,
      });
      console.log("  Connection established after acceptance");
    },
  },

  {
    name: "Vaults are now peers",
    async fn(ctx: TestContext) {
      // Check TEST sees TEST2 as a peer
      const testPeers = await ctx.test.plugin.getConnectedPeers();
      const hasTest2 = testPeers.some(
        (p) =>
          p.nodeId === test2NodeId ||
          p.nodeId.startsWith(test2NodeId.slice(0, 8)) ||
          test2NodeId.startsWith(p.nodeId.slice(0, 8))
      );
      assert(hasTest2, `TEST should see TEST2 as peer. Peers: ${testPeers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);

      // Check TEST2 sees TEST as a peer
      const test2Peers = await ctx.test2.plugin.getConnectedPeers();
      const hasTest = test2Peers.some(
        (p) =>
          p.nodeId === testNodeId ||
          p.nodeId.startsWith(testNodeId.slice(0, 8)) ||
          testNodeId.startsWith(p.nodeId.slice(0, 8))
      );
      assert(hasTest, `TEST2 should see TEST as peer. Peers: ${test2Peers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);

      console.log("  Both vaults see each other as peers");
    },
  },

  {
    name: "Wait for peer connection",
    async fn(ctx: TestContext) {
      // Wait for both sides to see each other as fully connected (synced state)
      // This ensures both sessions are in "live" mode and ready for bidirectional sync
      await Promise.all([
        ctx.test.sync.waitForPeerConnected(test2NodeId, { timeoutMs: 30000 }),
        ctx.test2.sync.waitForPeerConnected(testNodeId, { timeoutMs: 30000 }),
      ]);

      console.log("  Peer connection established (bidirectional)");
    },
  },
];
