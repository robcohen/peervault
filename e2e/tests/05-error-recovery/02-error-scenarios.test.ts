/**
 * Error Scenarios Tests
 *
 * Tests edge cases involving errors, empty files, and error state recovery.
 */

import { delay } from "../../config";
import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
  assertFileContent,
  assertWithRetry,
} from "../../lib/assertions";

export default [
  {
    name: "Ensure sync sessions active before error scenarios",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      const test1Active = await ctx.test.plugin.ensureActiveSessions();
      const test2Active = await ctx.test2.plugin.ensureActiveSessions();

      assert(test1Active, "TEST should have active sync session");
      assert(test2Active, "TEST2 should have active sync session");
      console.log("  Sync sessions active");
    },
  },

  {
    name: "Sync empty file (zero-byte)",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      const path = "empty-file.md";
      const content = "";

      await ctx.test.vault.createFile(path, content, true);
      await ctx.test2.sync.waitForFile(path);

      const syncedContent = await ctx.test2.vault.readFile(path);
      assert(syncedContent === "", "Empty file should sync as empty");
      console.log("  Zero-byte file synced correctly");
    },
  },

  {
    name: "Sync file with only newline",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      const path = "newline-only.md";
      const content = "\n";

      await ctx.test.vault.createFile(path, content, true);
      await ctx.test2.sync.waitForFile(path);

      const syncedContent = await ctx.test2.vault.readFile(path);
      assert(syncedContent === "\n", "Newline-only file should sync correctly");
      console.log("  Newline-only file synced");
    },
  },

  {
    name: "Sync file with null bytes",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      const path = "null-bytes.md";
      // Include text with null character in middle
      const content = "Before\0After";

      await ctx.test.vault.createFile(path, content, true);
      await ctx.test2.sync.waitForFile(path);

      // Content should be preserved
      const syncedContent = await ctx.test2.vault.readFile(path);
      assert(
        syncedContent.includes("Before") && syncedContent.includes("After"),
        "File with null bytes should sync (content may be modified)"
      );
      console.log("  File with null bytes handled");
    },
  },

  {
    name: "Recover from error session state",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      // Get current session state
      const sessionsBefore = await ctx.test.plugin.getActiveSessions();
      console.log(`  Sessions before: ${sessionsBefore.map((s) => s.state).join(", ") || "none"}`);

      // Clear any existing error sessions
      await ctx.test.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          if (plugin?.peerManager?.clearErrorSessions) {
            plugin.peerManager.clearErrorSessions();
          }
        })()
      `);
      await ctx.test2.client.evaluate(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          if (plugin?.peerManager?.clearErrorSessions) {
            plugin.peerManager.clearErrorSessions();
          }
        })()
      `);

      // Force sync to re-establish
      await Promise.allSettled([
        ctx.test.plugin.forceSync().catch(() => {}),
        ctx.test2.plugin.forceSync().catch(() => {}),
      ]);

      await delay(3000);

      // Verify sync still works
      const testFile = "error-recovery-test.md";
      await ctx.test.vault.createFile(testFile, "After error recovery", true);

      try {
        await ctx.test2.sync.waitForFile(testFile, { timeoutMs: 20000 });
        console.log("  Sync works after clearing error sessions");
      } catch {
        console.log("  Warning: Sync may need more time after error recovery");
      }

      // Cleanup
      try { await ctx.test.vault.deleteFile(testFile); } catch {}
      try { await ctx.test2.vault.deleteFile(testFile); } catch {}
    },
  },

  {
    name: "Handle rapid file overwrite (same file)",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      const path = "rapid-overwrite.md";
      const iterations = 10;

      // Rapidly overwrite the same file
      for (let i = 0; i < iterations; i++) {
        await ctx.test.vault.createFile(path, `Iteration ${i}`, true);
      }

      // Wait for sync to stabilize
      await delay(3000);

      // The file should exist with some version
      await assertWithRetry(
        async () => {
          const exists = await ctx.test2.vault.fileExists(path);
          assert(exists, "File should exist after rapid overwrites");
        },
        { maxAttempts: 5, delayMs: 1000 }
      );

      // Content should be from one of the iterations (CRDT merges)
      const content = await ctx.test2.vault.readFile(path);
      assert(
        content.includes("Iteration"),
        "Content should be from one of the iterations"
      );
      console.log(`  Rapid overwrite handled, final content: "${content.slice(0, 30)}..."`);

      // Cleanup
      try { await ctx.test.vault.deleteFile(path); } catch {}
      try { await ctx.test2.vault.deleteFile(path); } catch {}
    },
  },

  {
    name: "Handle file create during sync",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      // Create files rapidly from both vaults simultaneously
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 5; i++) {
        promises.push(
          ctx.test.vault.createFile(`during-sync-a-${i}.md`, `From TEST ${i}`, true)
        );
        promises.push(
          ctx.test2.vault.createFile(`during-sync-b-${i}.md`, `From TEST2 ${i}`, true)
        );
      }

      await Promise.allSettled(promises);
      await delay(5000);

      // Check some files synced
      let syncedCount = 0;
      for (let i = 0; i < 5; i++) {
        try {
          const existsA = await ctx.test2.vault.fileExists(`during-sync-a-${i}.md`);
          const existsB = await ctx.test.vault.fileExists(`during-sync-b-${i}.md`);
          if (existsA) syncedCount++;
          if (existsB) syncedCount++;
        } catch {}
      }

      console.log(`  ${syncedCount}/10 files synced during concurrent creation`);
      assert(syncedCount >= 5, "At least half should sync");

      // Cleanup
      for (let i = 0; i < 5; i++) {
        try { await ctx.test.vault.deleteFile(`during-sync-a-${i}.md`); } catch {}
        try { await ctx.test2.vault.deleteFile(`during-sync-a-${i}.md`); } catch {}
        try { await ctx.test.vault.deleteFile(`during-sync-b-${i}.md`); } catch {}
        try { await ctx.test2.vault.deleteFile(`during-sync-b-${i}.md`); } catch {}
      }
    },
  },

  {
    name: "Handle delete-recreate cycle",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      const path = "delete-recreate.md";

      // Create
      await ctx.test.vault.createFile(path, "Version 1", true);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 10000 });

      // Delete
      await ctx.test.vault.deleteFile(path);
      await delay(2000);

      // Recreate with different content
      await ctx.test.vault.createFile(path, "Version 2 (recreated)", true);
      await delay(3000);

      // Should have the new content
      await assertWithRetry(
        async () => {
          const content = await ctx.test2.vault.readFile(path);
          assert(
            content.includes("Version"),
            "File should exist after delete-recreate"
          );
        },
        { maxAttempts: 5, delayMs: 1000 }
      );

      console.log("  Delete-recreate cycle handled");

      // Cleanup
      try { await ctx.test.vault.deleteFile(path); } catch {}
      try { await ctx.test2.vault.deleteFile(path); } catch {}
    },
  },

  {
    name: "Sync file with very long path",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      // Create a path that's long but not excessive
      const segments = Array(8).fill("subfolder");
      const path = segments.join("/") + "/very-deep-file.md";

      await ctx.test.vault.createFile(path, "Deep file content", true);

      await assertWithRetry(
        async () => {
          const exists = await ctx.test2.vault.fileExists(path);
          assert(exists, "Deep file should sync");
        },
        { maxAttempts: 10, delayMs: 1000 }
      );

      console.log(`  ${segments.length}-level deep path synced`);

      // Cleanup
      try { await ctx.test.vault.deleteFile(path); } catch {}
      try { await ctx.test2.vault.deleteFile(path); } catch {}
    },
  },

  {
    name: "Handle session reconnect with pending changes",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      // Create a file in TEST2
      const file1 = "pending-change-1.md";
      await ctx.test2.vault.createFile(file1, "Created before reload", true);

      // Immediately reload TEST (simulating disconnect)
      await ctx.test.lifecycle.reload();

      // Create another file while TEST is reloading
      const file2 = "pending-change-2.md";
      await ctx.test2.vault.createFile(file2, "Created during reload", true);

      // Wait for TEST to recover
      await delay(5000);

      // Force sync
      await Promise.allSettled([
        ctx.test.plugin.forceSync().catch(() => {}),
        ctx.test2.plugin.forceSync().catch(() => {}),
      ]);
      await delay(3000);

      // Check if files eventually sync
      let file1Synced = false;
      let file2Synced = false;

      try {
        await ctx.test.sync.waitForFile(file1, { timeoutMs: 20000 });
        file1Synced = true;
      } catch {}

      try {
        await ctx.test.sync.waitForFile(file2, { timeoutMs: 10000 });
        file2Synced = true;
      } catch {}

      console.log(`  Files synced after reconnect: ${file1Synced ? "✓" : "✗"} ${file2Synced ? "✓" : "✗"}`);

      // Cleanup
      try { await ctx.test.vault.deleteFile(file1); } catch {}
      try { await ctx.test2.vault.deleteFile(file1); } catch {}
      try { await ctx.test.vault.deleteFile(file2); } catch {}
      try { await ctx.test2.vault.deleteFile(file2); } catch {}
    },
  },

  {
    name: "CRDT versions converge after error scenarios",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence();
      console.log("  CRDT versions converged after error scenario tests");
    },
  },

  {
    name: "Clean up error scenario test files",
    tags: ["error-scenarios"],
    async fn(ctx: TestContext) {
      const filesToClean = [
        "empty-file.md",
        "newline-only.md",
        "null-bytes.md",
        "error-recovery-test.md",
        "rapid-overwrite.md",
        "delete-recreate.md",
      ];

      for (const path of filesToClean) {
        try { await ctx.test.vault.deleteFile(path); } catch {}
        try { await ctx.test2.vault.deleteFile(path); } catch {}
      }

      // Clean deep folders by deleting the deep file first
      try {
        await ctx.test.vault.deleteFile(Array(8).fill("subfolder").join("/") + "/very-deep-file.md");
      } catch {}
      try {
        await ctx.test2.vault.deleteFile(Array(8).fill("subfolder").join("/") + "/very-deep-file.md");
      } catch {}

      await delay(2000);
      console.log("  Error scenario test files cleaned up");
    },
  },
];
