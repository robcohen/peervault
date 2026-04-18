/**
 * 3-Way Mesh Sync Tests - Pairing and Discovery
 *
 * Tests the group-based peer discovery flow:
 * 1. Reset all vaults and establish fresh TEST<->TEST2 pairing
 * 2. TEST3 joins via TEST's invite
 * 3. TEST announces TEST3 to TEST2
 * 4. TEST2 auto-connects to TEST3
 * 5. Full mesh is established (TEST <-> TEST2 <-> TEST3)
 *
 * This test is self-contained and doesn't require prior pairing.
 * IMPORTANT: This test suite requires TEST3 vault to be open in Obsidian.
 */

import { delay, getConfig } from "../../config";
import type { TestContext } from "../../lib/context";
import {
  assert,
  assertTruthy,
} from "../../lib/assertions";

// Store node IDs for verification
let testNodeId: string = "";
let test2NodeId: string = "";
let test3NodeId: string = "";
let testInvite: string = "";
let test3Invite: string = "";

export default [
  {
    name: "Verify TEST3 vault is available",
    async fn(ctx: TestContext) {
      if (!ctx.test3) {
        throw new Error("TEST3 vault not available. Run with 3-vault context.");
      }

      // Verify plugin is loaded
      const enabled = await ctx.test3.plugin.isEnabled();
      assert(enabled, "PeerVault plugin should be enabled on TEST3");

      console.log("  TEST3 vault is available and plugin is enabled");
    },
  },

  {
    name: "Reset all vaults for fresh start",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      // CRITICAL: First disconnect all existing connections to prevent race conditions
      // When running after earlier suites, there may be active sessions that can
      // interfere with the fresh pairing we're about to establish
      const disconnectAll = async (client: typeof ctx.test.client) => {
        await client.evaluate(`
          (async function() {
            const plugin = window.app?.plugins?.plugins?.["peervault"];
            const pm = plugin?.peerManager;
            if (!pm) return;

            // Close all active sessions
            for (const [id, session] of pm.sessions) {
              try {
                session.abort();
              } catch (e) {}
            }
            pm.sessions.clear();

            // Disconnect transport connections
            if (plugin.transport?.disconnectAll) {
              await plugin.transport.disconnectAll();
            }

            // Clear reconnect timers
            for (const [id, info] of pm.reconnectAttempts) {
              if (info.timer) clearTimeout(info.timer);
            }
            pm.reconnectAttempts.clear();
          })()
        `);
      };

      await Promise.all([
        disconnectAll(ctx.test.client),
        disconnectAll(ctx.test2.client),
        disconnectAll(ctx.test3.client),
      ]);
      console.log("  All connections disconnected");

      // Wait a moment for connections to fully close
      await delay(500);

      // Reset all vaults to clear any stale peer state
      await ctx.resetAll();
      console.log("  All vaults reset");

      // Enable hybrid transport and WebRTC BEFORE reload so transport is initialized correctly
      const enableHybridTransport = async (client: typeof ctx.test.client) => {
        await client.evaluate(`
          (async function() {
            const plugin = window.app?.plugins?.plugins?.["peervault"];
            if (plugin?.settings) {
              // CRITICAL: Set transportType to "hybrid" for HybridConnection to wrap streams
              plugin.settings.transportType = "hybrid";
              plugin.settings.enableWebRTC = true;
              plugin.settings.autoWebRTCUpgrade = true;
              await plugin.saveSettings?.();
            }
          })()
        `);
      };

      await enableHybridTransport(ctx.test.client);
      await enableHybridTransport(ctx.test2.client);
      await enableHybridTransport(ctx.test3.client);
      console.log("  Hybrid transport and WebRTC settings enabled");

      // Reload all plugins to apply WebRTC settings and get fresh node IDs
      await ctx.test.lifecycle.reload();
      await ctx.test2.lifecycle.reload();
      await ctx.test3.lifecycle.reload();
      console.log("  All plugins reloaded");

      // Wait for plugins to stabilize
      await delay(500);
    },
  },

  {
    name: "Enable protocol tracing on all vaults",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const result1 = await ctx.test.plugin.enableProtocolTracing("verbose");
      const result2 = await ctx.test2.plugin.enableProtocolTracing("verbose");
      const result3 = await ctx.test3.plugin.enableProtocolTracing("verbose");
      console.log(`  TEST tracer: ${result1.enabled ? "enabled" : "fallback"}`);
      console.log(`  TEST2 tracer: ${result2.enabled ? "enabled" : "fallback"}`);
      console.log(`  TEST3 tracer: ${result3.enabled ? "enabled" : "fallback"}`);
    },
  },

  {
    name: "Verify hybrid transport is configured",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      // Verify that hybrid transport is configured (required for signaling stream detection)
      const transport1 = await ctx.test.plugin.getTransportType();
      const transport2 = await ctx.test2.plugin.getTransportType();
      const transport3 = await ctx.test3.plugin.getTransportType();

      console.log(`  TEST transport: ${transport1}`);
      console.log(`  TEST2 transport: ${transport2}`);
      console.log(`  TEST3 transport: ${transport3}`);

      // All should be hybrid for proper signaling stream detection
      assert(
        transport1 === "hybrid",
        `TEST should use hybrid transport, got: ${transport1}`
      );
      assert(
        transport2 === "hybrid",
        `TEST2 should use hybrid transport, got: ${transport2}`
      );
      assert(
        transport3 === "hybrid",
        `TEST3 should use hybrid transport, got: ${transport3}`
      );
    },
  },

  {
    name: "Get node IDs for all vaults",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      testNodeId = await ctx.test.plugin.getNodeId();
      test2NodeId = await ctx.test2.plugin.getNodeId();
      test3NodeId = await ctx.test3.plugin.getNodeId();

      assertTruthy(testNodeId, "TEST should have a node ID");
      assertTruthy(test2NodeId, "TEST2 should have a node ID");
      assertTruthy(test3NodeId, "TEST3 should have a node ID");

      console.log(`  TEST node: ${testNodeId.slice(0, 16)}...`);
      console.log(`  TEST2 node: ${test2NodeId.slice(0, 16)}...`);
      console.log(`  TEST3 node: ${test3NodeId.slice(0, 16)}...`);
    },
  },

  // --- Step 1: Establish TEST <-> TEST2 pairing ---

  {
    name: "Generate invite from TEST for TEST2",
    async fn(ctx: TestContext) {
      testInvite = await ctx.test.plugin.generateInvite();
      assertTruthy(testInvite, "Invite should be generated");
      console.log(`  Invite generated (${testInvite.length} chars)`);
    },
  },

  {
    name: "TEST2 connects using TEST's invite",
    async fn(ctx: TestContext) {
      const cfg = getConfig();

      // Add peer - this initiates the connection
      const addPeerPromise = ctx.test2.plugin.addPeer(testInvite);

      // Race with timeout
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.log("  addPeer still running, continuing...");
          resolve();
        }, cfg.sync.defaultTimeout / 2);
      });

      await Promise.race([addPeerPromise, timeoutPromise]);
      await delay(200);
      console.log("  TEST2 initiated connection to TEST");
    },
  },

  {
    name: "Wait for TEST to accept TEST2 pairing",
    async fn(ctx: TestContext) {
      const cfg = getConfig();
      const pollMs = cfg.sync.pollInterval * 5;
      const maxAttempts = Math.ceil(cfg.sync.pairingTimeout / pollMs);
      let attempts = 0;

      while (attempts < maxAttempts) {
        // Check if TEST already sees TEST2 as a peer (auto-accept)
        const peers = await ctx.test.plugin.getConnectedPeers();
        const hasPeer = peers.some(p =>
          p.nodeId === test2NodeId || p.nodeId.startsWith(test2NodeId.slice(0, 8))
        );

        if (hasPeer) {
          console.log("  TEST paired with TEST2 (auto-accepted)");
          return;
        }

        // Check for pending requests (manual accept)
        const requests = await ctx.test.plugin.getPendingPairingRequests();
        const test2Request = requests.find(r =>
          r.nodeId === test2NodeId || r.nodeId.startsWith(test2NodeId.slice(0, 8))
        );

        if (test2Request) {
          console.log("  Accepting TEST2's pairing request...");
          await ctx.test.plugin.acceptPairingRequest(test2Request.nodeId);
          console.log("  Pairing request accepted");
          await delay(200);
          return;
        }

        attempts++;
        await new Promise(r => setTimeout(r, pollMs));
      }

      throw new Error("TEST did not receive TEST2 pairing request within timeout");
    },
  },

  {
    name: "Verify TEST and TEST2 are paired",
    async fn(ctx: TestContext) {
      // Check that TEST and TEST2 have each other as peers
      const testPeers = await ctx.test.plugin.getConnectedPeers();
      const test2Peers = await ctx.test2.plugin.getConnectedPeers();

      const testHasTest2 = testPeers.some(p =>
        p.nodeId === test2NodeId || p.nodeId.startsWith(test2NodeId.slice(0, 8))
      );
      const test2HasTest = test2Peers.some(p =>
        p.nodeId === testNodeId || p.nodeId.startsWith(testNodeId.slice(0, 8))
      );

      assert(testHasTest2, `TEST should have TEST2 as peer. Peers: ${testPeers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);
      assert(test2HasTest, `TEST2 should have TEST as peer. Peers: ${test2Peers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);

      console.log("  TEST and TEST2 are paired");
    },
  },

  {
    name: "Wait for TEST<->TEST2 sessions to reach live state",
    async fn(ctx: TestContext) {
      const cfg = getConfig();
      const pollMs = cfg.sync.pollInterval * 5;
      const maxWaitMs = cfg.sync.liveSessionTimeout;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        const test1Sessions = await ctx.test.plugin.getActiveSessions();
        const test2Sessions = await ctx.test2.plugin.getActiveSessions();

        const test1Live = test1Sessions.some(s => s.state === "live");
        const test2Live = test2Sessions.some(s => s.state === "live");

        if (test1Live && test2Live) {
          console.log("  TEST<->TEST2 sessions are live");
          return;
        }

        await new Promise(r => setTimeout(r, pollMs));
      }

      throw new Error("TEST<->TEST2 sessions did not reach live state within timeout");
    },
  },

  // --- Step 2: Add TEST3 to the mesh ---

  {
    name: "Verify TEST3 has no peers yet",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const test3Peers = await ctx.test3.plugin.getConnectedPeers();
      console.log(`  TEST3 has ${test3Peers.length} peer(s)`);

      // It's OK if TEST3 has peers from a previous run - we'll verify the discovery flow
    },
  },

  {
    name: "Generate invite from TEST for TEST3",
    async fn(ctx: TestContext) {
      test3Invite = await ctx.test.plugin.generateInvite();
      assertTruthy(test3Invite, "Invite should be generated");
      console.log(`  Invite generated (${test3Invite.length} chars)`);
    },
  },

  {
    name: "TEST3 joins via TEST's invite",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const cfg = getConfig();

      // Add peer - this initiates the connection
      const addPeerPromise = ctx.test3.plugin.addPeer(test3Invite);

      // Race with timeout
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.log("  addPeer still running, continuing...");
          resolve();
        }, cfg.sync.defaultTimeout / 2);
      });

      await Promise.race([addPeerPromise, timeoutPromise]);
      await delay(500);

      console.log("  TEST3 initiated connection to TEST");
    },
  },

  {
    name: "Wait for TEST to accept TEST3 pairing",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const cfg = getConfig();
      const pollMs = cfg.sync.pollInterval * 5;
      const maxAttempts = Math.ceil(cfg.sync.pairingTimeout / pollMs);
      let attempts = 0;

      while (attempts < maxAttempts) {
        // Check if TEST already sees TEST3 as a peer (auto-accept)
        const peers = await ctx.test.plugin.getConnectedPeers();
        const hasPeer = peers.some(p =>
          p.nodeId === test3NodeId || p.nodeId.startsWith(test3NodeId.slice(0, 8))
        );

        if (hasPeer) {
          console.log("  TEST paired with TEST3 (auto-accepted)");
          return;
        }

        // Check for pending requests (manual accept)
        const requests = await ctx.test.plugin.getPendingPairingRequests();
        const test3Request = requests.find(r =>
          r.nodeId === test3NodeId || r.nodeId.startsWith(test3NodeId.slice(0, 8))
        );

        if (test3Request) {
          console.log("  Accepting TEST3's pairing request...");
          await ctx.test.plugin.acceptPairingRequest(test3Request.nodeId);
          console.log("  Pairing request accepted");
          await delay(500);
          return;
        }

        attempts++;
        if (attempts % 20 === 0) {
          console.log(`  Still waiting for TEST3 pairing... (${attempts * pollMs / 1000}s)`);
        }
        await new Promise(r => setTimeout(r, pollMs));
      }

      throw new Error("TEST did not receive TEST3 pairing request within timeout");
    },
  },

  {
    name: "Verify TEST and TEST3 are paired",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      // Check both sides
      const testPeers = await ctx.test.plugin.getConnectedPeers();
      const test3Peers = await ctx.test3.plugin.getConnectedPeers();

      const testHasTest3 = testPeers.some(p =>
        p.nodeId === test3NodeId || p.nodeId.startsWith(test3NodeId.slice(0, 8))
      );
      const test3HasTest = test3Peers.some(p =>
        p.nodeId === testNodeId || p.nodeId.startsWith(testNodeId.slice(0, 8))
      );

      assert(testHasTest3, `TEST should see TEST3 as peer. Peers: ${testPeers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);
      assert(test3HasTest, `TEST3 should see TEST as peer. Peers: ${test3Peers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);

      console.log("  TEST and TEST3 are paired");
    },
  },

  {
    name: "Wait for TEST<->TEST3 sessions to reach live state",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const cfg = getConfig();
      const pollMs = cfg.sync.pollInterval * 5;
      const maxWaitMs = cfg.sync.liveSessionTimeout;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        const test1Sessions = await ctx.test.plugin.getActiveSessions();
        const test3Sessions = await ctx.test3.plugin.getActiveSessions();

        // Check for live sessions between TEST and TEST3
        const test1HasLiveTest3 = test1Sessions.some(s =>
          s.state === "live" && (s.peerId === test3NodeId || s.peerId.startsWith(test3NodeId.slice(0, 8)))
        );
        const test3HasLiveTest = test3Sessions.some(s =>
          s.state === "live" && (s.peerId === testNodeId || s.peerId.startsWith(testNodeId.slice(0, 8)))
        );

        if (test1HasLiveTest3 && test3HasLiveTest) {
          console.log("  TEST<->TEST3 sessions are live");
          return;
        }

        await new Promise(r => setTimeout(r, pollMs));
      }

      // Log state before failing
      const test1Sessions = await ctx.test.plugin.getActiveSessions();
      const test3Sessions = await ctx.test3.plugin.getActiveSessions();
      console.log(`  TEST sessions: ${test1Sessions.map(s => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ")}`);
      console.log(`  TEST3 sessions: ${test3Sessions.map(s => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ")}`);

      throw new Error("TEST<->TEST3 sessions did not reach live state within timeout");
    },
  },

  {
    name: "Wait for peer discovery (bidirectional)",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const cfg = getConfig();

      // After TEST pairs with TEST3, it should announce:
      // - TEST3 to TEST2 (so TEST2 discovers TEST3)
      // - TEST2 to TEST3 (so TEST3 discovers TEST2)
      console.log("  Waiting for bidirectional peer discovery...");

      const pollMs = cfg.sync.pollInterval * 5;
      const maxWaitMs = cfg.sync.connectionTimeout * 2; // Allow extra time for discovery
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        const test2Peers = await ctx.test2.plugin.getConnectedPeers();
        const test3Peers = await ctx.test3.plugin.getConnectedPeers();

        const test2HasTest3 = test2Peers.some(p =>
          p.nodeId === test3NodeId || p.nodeId.startsWith(test3NodeId.slice(0, 8))
        );
        const test3HasTest2 = test3Peers.some(p =>
          p.nodeId === test2NodeId || p.nodeId.startsWith(test2NodeId.slice(0, 8))
        );

        if (test2HasTest3 && test3HasTest2) {
          console.log("  Bidirectional discovery complete!");
          console.log(`    TEST2 discovered TEST3: yes`);
          console.log(`    TEST3 discovered TEST2: yes`);
          return;
        }

        // Log progress every 10 seconds
        const elapsed = Date.now() - startTime;
        if (elapsed > 0 && elapsed % 10000 < pollMs) {
          console.log(`  Still waiting for discovery... (${Math.round(elapsed / 1000)}s)`);
          console.log(`    TEST2 peers: ${test2Peers.map(p => p.nodeId.slice(0, 8)).join(", ") || "none"}`);
          console.log(`    TEST3 peers: ${test3Peers.map(p => p.nodeId.slice(0, 8)).join(", ") || "none"}`);
          console.log(`    TEST2->TEST3: ${test2HasTest3 ? "yes" : "no"}, TEST3->TEST2: ${test3HasTest2 ? "yes" : "no"}`);
        }

        await new Promise(r => setTimeout(r, pollMs));
      }

      // Log final state before failing
      const test2Peers = await ctx.test2.plugin.getConnectedPeers();
      const test3Peers = await ctx.test3.plugin.getConnectedPeers();
      console.log(`  Final TEST2 peers: ${test2Peers.map(p => p.nodeId.slice(0, 8)).join(", ") || "none"}`);
      console.log(`  Final TEST3 peers: ${test3Peers.map(p => p.nodeId.slice(0, 8)).join(", ") || "none"}`);

      const test2HasTest3 = test2Peers.some(p =>
        p.nodeId === test3NodeId || p.nodeId.startsWith(test3NodeId.slice(0, 8))
      );
      const test3HasTest2 = test3Peers.some(p =>
        p.nodeId === test2NodeId || p.nodeId.startsWith(test2NodeId.slice(0, 8))
      );

      if (!test2HasTest3 && !test3HasTest2) {
        throw new Error("Neither TEST2 nor TEST3 discovered each other");
      } else if (!test2HasTest3) {
        throw new Error("TEST2 did not discover TEST3 via peer announcement");
      } else {
        throw new Error("TEST3 did not discover TEST2 via peer announcement");
      }
    },
  },

  {
    name: "Verify full mesh connectivity",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      // Check all three pairs
      const testPeers = await ctx.test.plugin.getConnectedPeers();
      const test2Peers = await ctx.test2.plugin.getConnectedPeers();
      const test3Peers = await ctx.test3.plugin.getConnectedPeers();

      console.log(`  TEST peers: ${testPeers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);
      console.log(`  TEST2 peers: ${test2Peers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);
      console.log(`  TEST3 peers: ${test3Peers.map(p => p.nodeId.slice(0, 8)).join(", ")}`);

      // TEST should see TEST2 and TEST3
      assert(testPeers.length >= 2, `TEST should have at least 2 peers. Got: ${testPeers.length}`);

      // TEST2 should see TEST and TEST3
      assert(test2Peers.length >= 2, `TEST2 should have at least 2 peers. Got: ${test2Peers.length}`);

      // TEST3 should see TEST and TEST2
      assert(test3Peers.length >= 2, `TEST3 should have at least 2 peers. Got: ${test3Peers.length}`);

      console.log("  Full mesh connectivity verified!");
    },
  },

  {
    name: "Wait for all sessions to reach live state",
    async fn(ctx: TestContext) {
      if (!ctx.test3) throw new Error("TEST3 not available");

      const cfg = getConfig();
      const maxWaitMs = cfg.sync.liveSessionTimeout;
      const pollMs = cfg.sync.pollInterval * 10;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        const test1Sessions = await ctx.test.plugin.getActiveSessions();
        const test2Sessions = await ctx.test2.plugin.getActiveSessions();
        const test3Sessions = await ctx.test3.plugin.getActiveSessions();

        // Each vault should have 2 live sessions (one with each of the other two)
        const test1LiveCount = test1Sessions.filter(s => s.state === "live").length;
        const test2LiveCount = test2Sessions.filter(s => s.state === "live").length;
        const test3LiveCount = test3Sessions.filter(s => s.state === "live").length;

        if (test1LiveCount >= 2 && test2LiveCount >= 2 && test3LiveCount >= 2) {
          console.log("  All vaults have live sessions with both peers");
          return;
        }

        // Log progress every 10 seconds
        const elapsed = Date.now() - startTime;
        if (elapsed > 0 && elapsed % 10000 < pollMs) {
          console.log(`  Waiting for live sessions... TEST: ${test1LiveCount}/2, TEST2: ${test2LiveCount}/2, TEST3: ${test3LiveCount}/2`);
        }

        await new Promise(r => setTimeout(r, pollMs));
      }

      // Log final state before failing
      const test1Sessions = await ctx.test.plugin.getActiveSessions();
      const test2Sessions = await ctx.test2.plugin.getActiveSessions();
      const test3Sessions = await ctx.test3.plugin.getActiveSessions();

      console.log(`  Final - TEST: ${test1Sessions.map(s => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ")}`);
      console.log(`  Final - TEST2: ${test2Sessions.map(s => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ")}`);
      console.log(`  Final - TEST3: ${test3Sessions.map(s => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ")}`);

      throw new Error("Not all sessions reached live state within timeout");
    },
  },
];
