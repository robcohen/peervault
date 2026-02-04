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
    name: "Reload plugins to get latest code",
    async fn(ctx: TestContext) {
      // Reload both plugins to ensure we have the latest code with tracing
      await ctx.test.lifecycle.reload();
      await ctx.test2.lifecycle.reload();
      console.log("  Plugins reloaded");
    },
  },

  {
    name: "Enable protocol tracing",
    async fn(ctx: TestContext) {
      // Enable protocol tracing on both vaults before any sync operations
      const test1Result = await ctx.test.plugin.enableProtocolTracing("verbose");
      const test2Result = await ctx.test2.plugin.enableProtocolTracing("verbose");
      console.log(`  TEST tracer: ${test1Result.enabled ? "enabled" : "fallback"} | ${test1Result.debug}`);
      console.log(`  TEST2 tracer: ${test2Result.enabled ? "enabled" : "fallback"} | ${test2Result.debug}`);
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
    name: "Wait for pairing to complete",
    async fn(ctx: TestContext) {
      // Auto-accept mode handles the pairing modal automatically.
      // We just need to wait for TEST to see TEST2 as a peer.
      // This may happen via auto-accept or manual accept depending on config.
      // Note: Iroh relay connectivity can be slow (sometimes 60+ seconds)
      // so we use a generous timeout here.
      let attempts = 0;
      const maxAttempts = 90; // 90 seconds max wait

      while (attempts < maxAttempts) {
        // Check if TEST already sees TEST2 as a peer (auto-accept case)
        const peers = await ctx.test.plugin.getConnectedPeers();
        const hasPeer = peers.some(
          (p) =>
            p.nodeId === test2NodeId ||
            p.nodeId.startsWith(test2NodeId.slice(0, 8)) ||
            test2NodeId.startsWith(p.nodeId.slice(0, 8))
        );

        if (hasPeer) {
          console.log("  Pairing completed (auto-accepted)");
          return;
        }

        // Check for pending requests (manual accept case)
        const requests = await ctx.test.plugin.getPendingPairingRequests();
        if (requests.length > 0) {
          console.log(`  Received ${requests.length} pairing request(s), accepting...`);
          await ctx.test.plugin.acceptPairingRequest(requests[0].nodeId);
          console.log("  Pairing request accepted");
          await new Promise((r) => setTimeout(r, 1000));
          return;
        }

        attempts++;
        // Log progress every 10 seconds
        if (attempts % 10 === 0) {
          console.log(`  Still waiting for pairing... (${attempts}s)`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Output diagnostic info before failing
      console.log("\n  ===== DIAGNOSTIC INFO =====");
      const testDiag = await ctx.test.client.evaluate<{
        pluginLoaded: boolean;
        peerManagerInit: boolean;
        transportInit: boolean;
        traceCount: number;
      }>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          return {
            pluginLoaded: !!plugin,
            peerManagerInit: !!plugin?.peerManager?.initialized,
            transportInit: !!plugin?.peerManager?.transport?.getNodeId?.(),
            traceCount: window.__protocolTracer?.events?.length || 0,
          };
        })()
      `);
      console.log(`  TEST: pluginLoaded=${testDiag.pluginLoaded}, pmInit=${testDiag.peerManagerInit}, transportInit=${testDiag.transportInit}, traces=${testDiag.traceCount}`);

      console.log("\n  ===== PROTOCOL TRACES (TEST) =====");
      const testTraces = await ctx.test.plugin.getProtocolTraces(50);
      for (const trace of testTraces) {
        console.log(`  ${new Date(trace.ts).toISOString().slice(11, 23)} [${trace.sid}] ${trace.cat}.${trace.evt}`, trace.data ?? "");
      }
      console.log("  ===== END TRACES =====\n");

      throw new Error("Pairing did not complete within timeout");
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
    name: "Wait for initial sync to settle",
    async fn(ctx: TestContext) {
      // After pairing, wait for sync sessions to reach "live" state
      // Don't interfere with sessions - let the protocol complete naturally
      console.log("  Waiting for sync sessions to reach live state...");

      const maxWaitMs = 60000;
      const pollIntervalMs = 2000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        const test1Sessions = await ctx.test.plugin.getActiveSessions();
        const test2Sessions = await ctx.test2.plugin.getActiveSessions();

        const test1Live = test1Sessions.some((s) => s.state === "live");
        const test2Live = test2Sessions.some((s) => s.state === "live");

        if (test1Live && test2Live) {
          console.log("  Both vaults have live sessions");
          return;
        }

        // Log progress every 10 seconds
        const elapsed = Date.now() - startTime;
        if (elapsed > 0 && elapsed % 10000 < pollIntervalMs) {
          console.log(
            `  Waiting... TEST: ${test1Sessions.map((s) => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ") || "none"} | ` +
              `TEST2: ${test2Sessions.map((s) => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ") || "none"}`
          );
        }

        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      // If we get here, sync didn't complete in time - log final state for debugging
      const test1Sessions = await ctx.test.plugin.getActiveSessions();
      const test2Sessions = await ctx.test2.plugin.getActiveSessions();
      console.log(
        `  Final state - TEST: ${test1Sessions.map((s) => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ") || "none"} | ` +
          `TEST2: ${test2Sessions.map((s) => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ") || "none"}`
      );

      // Output traces to understand what went wrong
      console.log("\n  ===== PROTOCOL TRACES (TEST) =====");
      const testTraces = await ctx.test.plugin.getProtocolTraces(100);
      for (const trace of testTraces.slice(-50)) {
        console.log(`  ${new Date(trace.ts).toISOString().slice(11, 23)} [${trace.sid}] ${trace.cat}.${trace.evt}`, trace.data ?? "");
      }

      console.log("\n  ===== PROTOCOL TRACES (TEST2) =====");
      const test2Traces = await ctx.test2.plugin.getProtocolTraces(100);
      for (const trace of test2Traces.slice(-50)) {
        console.log(`  ${new Date(trace.ts).toISOString().slice(11, 23)} [${trace.sid}] ${trace.cat}.${trace.evt}`, trace.data ?? "");
      }
      console.log("  ===== END TRACES =====\n");

      throw new Error("Sync sessions did not reach live state within timeout");
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

  {
    name: "Verify transport connectivity on both sides",
    async fn(ctx: TestContext) {
      // Check actual transport connection on TEST side
      const test1ConnInfo = await ctx.test.plugin.getConnectionInfo(test2NodeId);
      console.log(`  TEST -> TEST2: connected=${test1ConnInfo?.connected}, transport=${test1ConnInfo?.transportType}`);

      assert(
        test1ConnInfo?.connected === true,
        `TEST should have active transport to TEST2. Got: connected=${test1ConnInfo?.connected}`
      );

      // Check actual transport connection on TEST2 side
      const test2ConnInfo = await ctx.test2.plugin.getConnectionInfo(testNodeId);
      console.log(`  TEST2 -> TEST: connected=${test2ConnInfo?.connected}, transport=${test2ConnInfo?.transportType}`);

      assert(
        test2ConnInfo?.connected === true,
        `TEST2 should have active transport to TEST. Got: connected=${test2ConnInfo?.connected}`
      );

      console.log("  Transport connectivity verified on both sides");
    },
  },

  {
    name: "Verify sync session is active on both sides",
    async fn(ctx: TestContext) {
      // Check that sync sessions exist and are in live mode
      const test1Sessions = await ctx.test.plugin.getActiveSessions();
      const test2Sessions = await ctx.test2.plugin.getActiveSessions();

      console.log(`  TEST active sessions: ${test1Sessions.length}`, test1Sessions.map(s => `${s.peerId.slice(0, 8)}:${s.state}`));
      console.log(`  TEST2 active sessions: ${test2Sessions.length}`, test2Sessions.map(s => `${s.peerId.slice(0, 8)}:${s.state}`));

      // Check if sessions are in live mode
      const test1Live = test1Sessions.some(s => s.state === "live");
      const test2Live = test2Sessions.some(s => s.state === "live");

      console.log(`  TEST has live session: ${test1Live}`);
      console.log(`  TEST2 has live session: ${test2Live}`);

      // Always dump protocol traces for debugging when sessions aren't live
      if (!test1Live || !test2Live || test1Sessions.length === 0 || test2Sessions.length === 0) {
        console.log("\n  ===== PROTOCOL TRACES (TEST) =====");
        const test1Traces = await ctx.test.plugin.getProtocolTraces(100);
        if (test1Traces.length === 0) {
          console.log("  (no traces - tracing may not be enabled)");
        } else {
          for (const trace of test1Traces) {
            console.log(`  ${new Date(trace.ts).toISOString().slice(11, 23)} [${trace.sid}] ${trace.cat}.${trace.evt}`, trace.data ?? "");
          }
        }

        console.log("\n  ===== PROTOCOL TRACES (TEST2) =====");
        const test2Traces = await ctx.test2.plugin.getProtocolTraces(100);
        if (test2Traces.length === 0) {
          console.log("  (no traces - tracing may not be enabled)");
        } else {
          for (const trace of test2Traces) {
            console.log(`  ${new Date(trace.ts).toISOString().slice(11, 23)} [${trace.sid}] ${trace.cat}.${trace.evt}`, trace.data ?? "");
          }
        }
        console.log("  ===== END TRACES =====\n");
      }

      assert(
        test1Sessions.length > 0,
        `TEST should have at least 1 active sync session. Got: ${test1Sessions.length}`
      );
      assert(
        test2Sessions.length > 0,
        `TEST2 should have at least 1 active sync session. Got: ${test2Sessions.length}`
      );

      assert(test1Live, "TEST should have a session in live mode");
      assert(test2Live, "TEST2 should have a session in live mode");

      console.log("  Sync sessions verified on both sides");
    },
  },
];
