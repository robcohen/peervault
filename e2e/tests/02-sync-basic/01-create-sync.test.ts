/**
 * Basic Sync Tests - File Creation
 *
 * Tests syncing newly created files between vaults.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
  assertFileContent,
  assertInCrdt,
} from "../../lib/assertions";

export default [
  {
    name: "Initial sync to establish CRDT state",
    async fn(ctx: TestContext) {
      // TEST2 has TEST as a peer, so TEST2 initiates sync
      console.log("  Checking peers before sync...");
      const peers1 = await ctx.test.plugin.getPeers();
      const peers2 = await ctx.test2.plugin.getPeers();
      console.log(`  TEST peers: ${peers1.length}, TEST2 peers: ${peers2.length}`);

      if (peers2.length === 0) {
        throw new Error("TEST2 has no peers - pairing may have failed");
      }

      // Get peer details
      for (const p of peers2) {
        console.log(`  TEST2 peer: ${p.name} (${p.id.slice(0, 8)}) ticket=${p.ticket.slice(0, 30)}...`);
      }

      console.log("  TEST2 calling syncAll...");
      try {
        await ctx.test2.plugin.syncAll();
        console.log("  syncAll completed");
      } catch (e) {
        console.log(`  syncAll failed: ${e}`);
        throw e;
      }

      // Wait for sync
      await new Promise(r => setTimeout(r, 2000));

      const test1Files = await ctx.test.plugin.listFiles();
      const test2Files = await ctx.test2.plugin.listFiles();
      const list1 = Array.isArray(test1Files) ? test1Files : [];
      const list2 = Array.isArray(test2Files) ? test2Files : [];
      console.log(`  TEST CRDT: ${list1.length} files, TEST2 CRDT: ${list2.length} files`);
      if (list1.length > 0) {
        console.log(`  TEST files: ${list1.slice(0, 5).join(", ")}...`);
      }
      if (list2.length > 0) {
        console.log(`  TEST2 files: ${list2.slice(0, 5).join(", ")}...`);
      }
    },
  },

  {
    name: "Create file in TEST syncs to TEST2",
    async fn(ctx: TestContext) {
      const path = "sync-test-1.md";
      const content = "# Sync Test 1\n\nCreated in TEST, should sync to TEST2.";

      await ctx.test.vault.createFile(path, content);
      console.log(`  Created ${path} in TEST`);

      // Wait for file to be in TEST's CRDT (debounce + processing)
      await new Promise(r => setTimeout(r, 1500));

      // Check TEST CRDT has the file
      const testFiles = await ctx.test.plugin.listFiles();
      const testList = Array.isArray(testFiles) ? testFiles : [];
      console.log(`  TEST CRDT files: ${testList.length} - includes ${path}: ${testList.includes(path)}`);

      // TEST2 has TEST as peer - trigger sync from TEST2
      console.log("  Triggering sync from TEST2...");

      // Get version vectors before sync
      const testVV = await ctx.test.client.evaluate<string>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const vv = await plugin?.client?.vault?.getVersionVector?.();
          return vv ? vv.length + " bytes" : "N/A";
        })()
      `);
      const test2VVBefore = await ctx.test2.client.evaluate<string>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const vv = await plugin?.client?.vault?.getVersionVector?.();
          return vv ? vv.length + " bytes" : "N/A";
        })()
      `);
      console.log(`  TEST VV: ${testVV}`);
      console.log(`  TEST2 VV before sync: ${test2VVBefore}`);

      // Check what updates TEST would export (since empty VV)
      const testUpdates = await ctx.test.client.evaluate<string>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          if (!plugin?.client?.vault) return "vault not ready";
          // Export all updates (since empty VV)
          const emptyVV = new Uint8Array([0,0,0,0,0,0,0,0,0,0]);
          try {
            const store = await plugin.client.vault.export?.();
            return store ? store.length + " bytes exported snapshot" : "no export method";
          } catch (e) {
            return "error: " + e;
          }
        })()
      `);
      console.log(`  TEST export snapshot: ${testUpdates}`);

      await ctx.test2.plugin.syncAll();
      console.log("  syncAll returned");

      // Wait for sync to complete
      await new Promise(r => setTimeout(r, 2000));

      // Get version vectors after sync
      const vvAfter = await ctx.test2.client.evaluate<string>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const vv = await plugin?.client?.vault?.getVersionVector?.();
          return vv ? JSON.stringify(Array.from(vv)) : "N/A";
        })()
      `);
      console.log(`  TEST2 VV after sync: ${vvAfter?.slice(0, 50)}...`);

      // Check if file is in TEST2 CRDT
      const test2Files = await ctx.test2.plugin.listFiles();
      const fileList = Array.isArray(test2Files) ? test2Files : [];
      console.log(`  TEST2 CRDT files: ${fileList.length} - includes ${path}: ${fileList.includes(path)}`);
      if (fileList.length > 0) {
        console.log(`  TEST2 files: ${fileList.slice(0, 5).join(", ")}`);
      }

      // Manually trigger CRDT -> disk sync on TEST2
      console.log("  Triggering disk sync on TEST2...");
      await ctx.test2.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          if (plugin?.syncCrdtToDisk) {
            await plugin.syncCrdtToDisk();
          }
        })()
      `);

      // Check if file appeared in vault filesystem
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 10000 });
      console.log("  File appeared in TEST2");

      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Content matches");
    },
  },

  {
    name: "Create file in TEST2 syncs to TEST",
    async fn(ctx: TestContext) {
      const path = "sync-test-2.md";
      const content = "# Sync Test 2\n\nCreated in TEST2, should sync to TEST.";

      await ctx.test2.vault.createFile(path, content);
      console.log(`  Created ${path} in TEST2`);

      // Wait for file to be in TEST2's CRDT
      await new Promise(r => setTimeout(r, 1500));

      // TEST2 has TEST as peer - sync sends TEST2's CRDT to TEST
      console.log("  Triggering sync from TEST2...");
      await ctx.test2.plugin.syncAll();

      // Wait for sync to complete
      await new Promise(r => setTimeout(r, 2000));

      // Check if file appeared in TEST vault filesystem
      await ctx.test.sync.waitForFile(path, { timeoutMs: 10000 });
      console.log("  File appeared in TEST");

      await assertFileContent(ctx.test.vault, path, content);
      console.log("  Content matches");
    },
  },

  {
    name: "Multiple files created quickly sync correctly",
    // Note: Not parallel - syncAll calls can race
    async fn(ctx: TestContext) {
      const files = [
        { path: "batch/file-1.md", content: "Batch file 1" },
        { path: "batch/file-2.md", content: "Batch file 2" },
        { path: "batch/file-3.md", content: "Batch file 3" },
      ];

      for (const file of files) {
        await ctx.test.vault.createFile(file.path, file.content);
      }
      console.log(`  Created ${files.length} files in TEST`);

      // Wait for files to be in CRDT, then trigger sync
      await new Promise(r => setTimeout(r, 1500));
      await ctx.test2.plugin.syncAll();
      await new Promise(r => setTimeout(r, 2000));

      for (const file of files) {
        await ctx.test2.sync.waitForFile(file.path, { timeoutMs: 10000 });
      }
      console.log("  All files appeared in TEST2");

      for (const file of files) {
        await assertFileContent(ctx.test2.vault, file.path, file.content);
      }
      console.log("  All contents match");
    },
  },

  {
    name: "File with frontmatter syncs correctly",
    // Note: Not parallel - syncAll calls can race
    async fn(ctx: TestContext) {
      const path = "frontmatter-test.md";
      const content = `---
title: Frontmatter Test
tags:
  - sync
  - test
date: 2024-01-15
---

# Frontmatter Test

This file has YAML frontmatter.`;

      await ctx.test.vault.createFile(path, content);

      // Wait for file to be in CRDT, then trigger sync
      await new Promise(r => setTimeout(r, 1500));
      await ctx.test2.plugin.syncAll();
      await new Promise(r => setTimeout(r, 2000));

      await ctx.test2.sync.waitForFile(path, { timeoutMs: 10000 });
      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Frontmatter preserved correctly");
    },
  },

  {
    name: "File with internal links syncs correctly",
    // Note: Not parallel - syncAll calls can race
    async fn(ctx: TestContext) {
      const path = "links-test.md";
      const content = `# Links Test

This links to [[sync-test-1]] and [[sync-test-2]].

Also [[batch/file-1|with alias]].

And an embed: ![[sync-test-1]]`;

      await ctx.test2.vault.createFile(path, content);

      // Wait for file to be in CRDT, then trigger sync (TEST2 -> TEST)
      await new Promise(r => setTimeout(r, 1500));
      await ctx.test2.plugin.syncAll();
      await new Promise(r => setTimeout(r, 2000));

      await ctx.test.sync.waitForFile(path, { timeoutMs: 10000 });
      await assertFileContent(ctx.test.vault, path, content);
      console.log("  Internal links preserved correctly");
    },
  },

  {
    name: "Files appear in CRDT on both vaults",
    async fn(ctx: TestContext) {
      // Check TEST CRDT
      await assertInCrdt(ctx.test.plugin, "sync-test-1.md");
      await assertInCrdt(ctx.test.plugin, "sync-test-2.md");
      await assertInCrdt(ctx.test.plugin, "links-test.md");

      // Check TEST2 CRDT
      await assertInCrdt(ctx.test2.plugin, "sync-test-1.md");
      await assertInCrdt(ctx.test2.plugin, "sync-test-2.md");
      await assertInCrdt(ctx.test2.plugin, "links-test.md");

      console.log("  All files tracked in CRDT on both vaults");
    },
  },

  {
    name: "CRDT versions converge",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence();
      console.log("  CRDT versions have converged");
    },
  },
];
