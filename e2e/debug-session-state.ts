#!/usr/bin/env bun
/**
 * Debug script to check session state and sync behavior
 */

import { createTestContext } from "./lib/context";

async function getSessionInfo(ctx: any, name: string) {
  return await ctx.client.evaluate<{
    sessionCount: number;
    sessions: Array<{ peerId: string; state: string }>;
    peerCount: number;
    peers: Array<{ nodeId: string; state: string }>;
  }>(`
    (function() {
      const plugin = window.app?.plugins?.plugins?.["peervault"];
      const pm = plugin?.peerManager;
      const sessions = [];
      const peers = [];

      if (pm?.sessions) {
        for (const [peerId, session] of pm.sessions) {
          sessions.push({
            peerId: peerId.slice(0, 8),
            state: session.getState?.() || "unknown"
          });
        }
      }

      if (pm?.peers) {
        for (const [nodeId, peer] of pm.peers) {
          peers.push({
            nodeId: nodeId.slice(0, 8),
            state: peer.state
          });
        }
      }

      return {
        sessionCount: pm?.sessions?.size || 0,
        sessions,
        peerCount: pm?.peers?.size || 0,
        peers
      };
    })()
  `);
}

async function getCrdtVersion(ctx: any) {
  return await ctx.client.evaluate<string>(`
    (function() {
      const plugin = window.app?.plugins?.plugins?.["peervault"];
      const dm = plugin?.documentManager;
      if (!dm) return "no-dm";
      const bytes = dm.getVersionBytes();
      if (!bytes || bytes.length === 0) return "empty";
      // Convert to hex
      return Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
    })()
  `);
}

async function debug() {
  console.log("Creating test context...");
  const ctx = await createTestContext();

  try {
    console.log("\n=== Initial State ===");
    const test1Info = await getSessionInfo(ctx.test, "TEST");
    const test2Info = await getSessionInfo(ctx.test2, "TEST2");
    const test1Version = await getCrdtVersion(ctx.test);
    const test2Version = await getCrdtVersion(ctx.test2);

    console.log("TEST:", JSON.stringify(test1Info, null, 2));
    console.log("TEST version:", test1Version);
    console.log("\nTEST2:", JSON.stringify(test2Info, null, 2));
    console.log("TEST2 version:", test2Version);

    // Create a file in TEST
    console.log("\n=== Creating file in TEST ===");
    await ctx.test.vault.createFile("debug-state-1.md", "# Debug State 1\n\nCreated in TEST.");
    await new Promise(r => setTimeout(r, 3000));

    const v1After = await getCrdtVersion(ctx.test);
    const v2After = await getCrdtVersion(ctx.test2);
    const exists2 = await ctx.test2.vault.fileExists("debug-state-1.md");
    console.log("File exists in TEST2:", exists2);
    console.log("TEST version:", v1After);
    console.log("TEST2 version:", v2After);
    console.log("Versions match:", v1After === v2After);

    // Create a file in TEST2
    console.log("\n=== Creating file in TEST2 ===");
    await ctx.test2.vault.createFile("debug-state-2.md", "# Debug State 2\n\nCreated in TEST2.");
    await new Promise(r => setTimeout(r, 5000));

    const v1After2 = await getCrdtVersion(ctx.test);
    const v2After2 = await getCrdtVersion(ctx.test2);
    const exists1 = await ctx.test.vault.fileExists("debug-state-2.md");
    console.log("File exists in TEST:", exists1);
    console.log("TEST version:", v1After2);
    console.log("TEST2 version:", v2After2);
    console.log("Versions match:", v1After2 === v2After2);

    // Check session state after creates
    console.log("\n=== Session State After Creates ===");
    const test1Info2 = await getSessionInfo(ctx.test, "TEST");
    const test2Info2 = await getSessionInfo(ctx.test2, "TEST2");
    console.log("TEST:", JSON.stringify(test1Info2, null, 2));
    console.log("TEST2:", JSON.stringify(test2Info2, null, 2));

    // Modify file in TEST
    console.log("\n=== Modifying file in TEST ===");
    await ctx.test.vault.modifyFile("debug-state-1.md", "# Debug State 1 - Modified\n\nModified in TEST.");
    await new Promise(r => setTimeout(r, 3000));

    const content2 = await ctx.test2.vault.readFile("debug-state-1.md");
    console.log("TEST2 content after TEST modify:", content2.slice(0, 50) + "...");

    // Modify file in TEST2
    console.log("\n=== Modifying file in TEST2 ===");
    await ctx.test2.vault.modifyFile("debug-state-2.md", "# Debug State 2 - Modified\n\nModified in TEST2.");
    await new Promise(r => setTimeout(r, 10000));

    const content1 = await ctx.test.vault.readFile("debug-state-2.md");
    console.log("TEST content after TEST2 modify:", content1.slice(0, 50) + "...");

    const v1Final = await getCrdtVersion(ctx.test);
    const v2Final = await getCrdtVersion(ctx.test2);
    console.log("\n=== Final Versions ===");
    console.log("TEST version:", v1Final);
    console.log("TEST2 version:", v2Final);
    console.log("Versions match:", v1Final === v2Final);

    // Clean up
    console.log("\n=== Cleanup ===");
    await ctx.test.vault.deleteFile("debug-state-1.md").catch(() => {});
    await ctx.test.vault.deleteFile("debug-state-2.md").catch(() => {});
    await ctx.test2.vault.deleteFile("debug-state-1.md").catch(() => {});
    await ctx.test2.vault.deleteFile("debug-state-2.md").catch(() => {});

  } finally {
    await ctx.close();
  }
}

debug().catch(err => {
  console.error("Debug failed:", err);
  process.exit(1);
});
