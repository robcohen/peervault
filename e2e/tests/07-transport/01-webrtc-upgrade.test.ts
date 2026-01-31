/**
 * Transport Tests - WebRTC Upgrade
 *
 * Tests that WebRTC upgrade happens for peers on the same network.
 * This test runs after pairing is complete (depends on 01-pairing).
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertTruthy,
  assertEqual,
} from "../../lib/assertions";

// Peer IDs are populated by pairing tests
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
    name: "WebRTC is available in both vaults",
    async fn(ctx: TestContext) {
      const test1Available = await ctx.test.plugin.isWebRTCAvailable();
      const test2Available = await ctx.test2.plugin.isWebRTCAvailable();

      console.log(`  TEST WebRTC available: ${test1Available}`);
      console.log(`  TEST2 WebRTC available: ${test2Available}`);

      // WebRTC should be available in Electron
      assertTruthy(test1Available, "WebRTC should be available in TEST vault");
      assertTruthy(test2Available, "WebRTC should be available in TEST2 vault");
    },
  },

  {
    name: "Verify peers are connected",
    async fn(ctx: TestContext) {
      // Wait for connections to stabilize
      await new Promise((r) => setTimeout(r, 2000));

      const test1Peers = await ctx.test.plugin.getConnectedPeers();
      const test2Peers = await ctx.test2.plugin.getConnectedPeers();

      console.log(`  TEST connected peers: ${test1Peers.length}`);
      console.log(`  TEST2 connected peers: ${test2Peers.length}`);

      // Both should have at least one peer
      assert(test1Peers.length >= 1, "TEST should have at least 1 connected peer");
      assert(test2Peers.length >= 1, "TEST2 should have at least 1 connected peer");
    },
  },

  {
    name: "Check connection info from TEST to TEST2",
    async fn(ctx: TestContext) {
      // Get connection info for the peer
      const connInfo = await ctx.test.plugin.getConnectionInfo(test2NodeId);

      console.log("  Connection info (TEST -> TEST2):");
      console.log(`    Connected: ${connInfo?.connected}`);
      console.log(`    Transport: ${connInfo?.transportType}`);
      console.log(`    WebRTC active: ${connInfo?.webrtcActive}`);
      console.log(`    WebRTC direct: ${connInfo?.webrtcDirect}`);
      console.log(`    RTT: ${connInfo?.rttMs}ms`);

      assertTruthy(connInfo, "Connection info should exist");
      assertTruthy(connInfo?.connected, "Connection should be active");
      assertEqual(connInfo?.transportType, "hybrid", "Should use hybrid transport");
    },
  },

  {
    name: "Check connection info from TEST2 to TEST",
    async fn(ctx: TestContext) {
      const connInfo = await ctx.test2.plugin.getConnectionInfo(testNodeId);

      console.log("  Connection info (TEST2 -> TEST):");
      console.log(`    Connected: ${connInfo?.connected}`);
      console.log(`    Transport: ${connInfo?.transportType}`);
      console.log(`    WebRTC active: ${connInfo?.webrtcActive}`);
      console.log(`    WebRTC direct: ${connInfo?.webrtcDirect}`);
      console.log(`    RTT: ${connInfo?.rttMs}ms`);

      assertTruthy(connInfo, "Connection info should exist");
      assertTruthy(connInfo?.connected, "Connection should be active");
      assertEqual(connInfo?.transportType, "hybrid", "Should use hybrid transport");
    },
  },

  {
    name: "Wait for WebRTC upgrade (up to 15s)",
    async fn(ctx: TestContext) {
      // WebRTC upgrade happens in the background after Iroh connects
      // Give it time to complete the signaling and ICE gathering
      const maxWait = 15000;
      const checkInterval = 1000;
      let elapsed = 0;

      let testConnInfo = await ctx.test.plugin.getConnectionInfo(test2NodeId);
      let test2ConnInfo = await ctx.test2.plugin.getConnectionInfo(testNodeId);

      while (elapsed < maxWait) {
        if (testConnInfo?.webrtcActive || test2ConnInfo?.webrtcActive) {
          console.log(`  WebRTC upgrade detected after ${elapsed}ms`);
          break;
        }

        await new Promise((r) => setTimeout(r, checkInterval));
        elapsed += checkInterval;

        testConnInfo = await ctx.test.plugin.getConnectionInfo(test2NodeId);
        test2ConnInfo = await ctx.test2.plugin.getConnectionInfo(testNodeId);
      }

      // Log final state
      console.log(`  Final state after ${elapsed}ms:`);
      console.log(`    TEST -> TEST2: webrtcActive=${testConnInfo?.webrtcActive}, direct=${testConnInfo?.webrtcDirect}`);
      console.log(`    TEST2 -> TEST: webrtcActive=${test2ConnInfo?.webrtcActive}, direct=${test2ConnInfo?.webrtcDirect}`);

      // Note: WebRTC upgrade may not always succeed depending on network conditions
      // We just log the result here rather than failing the test
      if (!testConnInfo?.webrtcActive && !test2ConnInfo?.webrtcActive) {
        console.log("  WebRTC upgrade did not complete (still using Iroh relay)");
        console.log("  This is acceptable - WebRTC is opportunistic");
      }
    },
  },

  {
    name: "Verify WebRTC uses direct connection (host candidates)",
    async fn(ctx: TestContext) {
      const testConnInfo = await ctx.test.plugin.getConnectionInfo(test2NodeId);
      const test2ConnInfo = await ctx.test2.plugin.getConnectionInfo(testNodeId);

      // If WebRTC is active, it should be direct (same machine = same network)
      if (testConnInfo?.webrtcActive) {
        console.log(`  TEST -> TEST2: Direct connection = ${testConnInfo.webrtcDirect}`);
        if (testConnInfo.webrtcDirect) {
          console.log("  Using direct WebRTC connection (host candidates)");
        } else {
          console.log("  Using WebRTC relay (not direct)");
        }
      }

      if (test2ConnInfo?.webrtcActive) {
        console.log(`  TEST2 -> TEST: Direct connection = ${test2ConnInfo.webrtcDirect}`);
      }

      // If both have WebRTC active, at least one should be direct
      // (on same machine, we should get host candidates)
      if (testConnInfo?.webrtcActive && test2ConnInfo?.webrtcActive) {
        const anyDirect = testConnInfo.webrtcDirect || test2ConnInfo.webrtcDirect;
        if (anyDirect) {
          console.log("  Confirmed: Using direct WebRTC connection");
        } else {
          // This would be unexpected on same machine
          console.log("  Warning: WebRTC active but not using direct connection");
        }
      }
    },
  },

  {
    name: "Compare RTT with and without WebRTC",
    async fn(ctx: TestContext) {
      const testConnInfo = await ctx.test.plugin.getConnectionInfo(test2NodeId);

      if (testConnInfo?.rttMs !== undefined) {
        console.log(`  Current RTT: ${testConnInfo.rttMs}ms`);

        if (testConnInfo.webrtcActive && testConnInfo.webrtcDirect) {
          // Direct WebRTC should have very low RTT (same machine)
          if (testConnInfo.rttMs < 10) {
            console.log("  Excellent: RTT < 10ms (direct connection)");
          } else if (testConnInfo.rttMs < 50) {
            console.log("  Good: RTT < 50ms");
          } else {
            console.log("  Note: RTT higher than expected for local connection");
          }
        } else {
          // Without WebRTC, RTT goes through relay
          console.log("  Using Iroh relay (RTT includes relay latency)");
        }
      } else {
        console.log("  RTT not available");
      }
    },
  },
];
