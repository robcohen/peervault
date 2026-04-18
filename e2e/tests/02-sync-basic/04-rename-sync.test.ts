/**
 * Basic Sync Tests - File Rename/Move
 *
 * Tests syncing renamed and moved files between vaults.
 */

import { delay } from "../../config";
import type { TestContext } from "../../lib/context";
import {
  assertFileExists,
  assertFileNotExists,
  assertFileContent,
} from "../../lib/assertions";

/** Files created by this suite that need cleanup */
const SUITE_FILES = [
  "sync-test-1.md",
  "sync-test-2.md",
  "batch/file-1.md",
  "batch/file-2.md",
  "batch/file-3.md",
  "frontmatter-test.md",
  "links-test.md",
  "rapid-modify.md",
  "append-test.md",
  "prepend-test.md",
  "large-modify.md",
  "recreate-test.md",
  "rename-test-old.md",
  "rename-test-new.md",
  "move-test.md",
  "moved-folder/move-test.md",
  "source-folder/nested-file.md",
  "nested-file-moved.md",
  "rename-modify-old.md",
  "rename-modify-new.md",
  "folder-a/cross-folder.md",
  "folder-b/cross-folder.md",
];

/**
 * Suite afterAll hook - cleans up all test files created by this suite.
 * This ensures isolation between test runs.
 */
export async function afterAll(ctx: TestContext): Promise<void> {
  console.log("  Cleaning up sync-basic test files...");
  let cleaned = 0;

  for (const file of SUITE_FILES) {
    try {
      await ctx.test.vault.deleteFile(file);
      cleaned++;
    } catch {
      // File may not exist
    }
    try {
      await ctx.test2.vault.deleteFile(file);
      cleaned++;
    } catch {
      // File may not exist
    }
  }

  // Allow time for deletions to sync
  await delay(2000);
  console.log(`  Cleaned up ${cleaned} test files`);
}

export default [
  {
    name: "Rename file in TEST syncs to TEST2",
    parallel: false, // Sequential to avoid race conditions with parallel tests
    async fn(ctx: TestContext) {
      const oldPath = "rename-test-old.md";
      const newPath = "rename-test-new.md";
      const content = "# Rename Test\n\nThis file will be renamed.";

      await ctx.test.vault.createFile(oldPath, content);
      await ctx.test2.sync.waitForFile(oldPath);
      console.log("  Created original file");

      await ctx.test.vault.renameFile(oldPath, newPath);
      console.log("  Renamed in TEST");

      await Promise.all([
        ctx.test2.sync.waitForFile(newPath),
        ctx.test2.sync.waitForFileDeletion(oldPath),
      ]);

      await assertFileContent(ctx.test2.vault, newPath, content);
      console.log("  Rename synced with content preserved");
    },
  },

  {
    name: "Move file to folder in TEST syncs to TEST2",
    parallel: true,
    retryOnFailure: 1, // Occasionally flaky with mock transport
    async fn(ctx: TestContext) {
      const oldPath = "move-test.md";
      const newPath = "moved-folder/move-test.md";
      const content = "# Move Test\n\nThis file will be moved.";

      // Clean up any leftover files from previous runs
      try { await ctx.test.vault.deleteFile(oldPath); } catch {}
      try { await ctx.test.vault.deleteFile(newPath); } catch {}
      try { await ctx.test2.vault.deleteFile(oldPath); } catch {}
      try { await ctx.test2.vault.deleteFile(newPath); } catch {}

      await ctx.test.vault.createFile(oldPath, content);
      await ctx.test2.sync.waitForFile(oldPath, { timeoutMs: 5000 });

      await ctx.test.vault.renameFile(oldPath, newPath);
      console.log("  Moved to folder in TEST");

      await Promise.all([
        ctx.test2.sync.waitForFile(newPath, { timeoutMs: 5000 }),
        ctx.test2.sync.waitForFileDeletion(oldPath, { timeoutMs: 5000 }),
      ]);

      await assertFileContent(ctx.test2.vault, newPath, content);
      console.log("  Move synced correctly");
    },
  },

  {
    name: "Move file out of folder in TEST2 syncs to TEST",
    parallel: true,
    retryOnFailure: 1, // Occasionally flaky with mock transport
    async fn(ctx: TestContext) {
      const oldPath = "source-folder/nested-file.md";
      const newPath = "nested-file-moved.md";
      const content = "# Nested File\n\nMoving out of folder.";

      // Clean up any leftover files from previous runs
      try { await ctx.test.vault.deleteFile(oldPath); } catch {}
      try { await ctx.test.vault.deleteFile(newPath); } catch {}
      try { await ctx.test2.vault.deleteFile(oldPath); } catch {}
      try { await ctx.test2.vault.deleteFile(newPath); } catch {}

      await ctx.test2.vault.createFile(oldPath, content);
      await ctx.test.sync.waitForFile(oldPath, { timeoutMs: 5000 });

      await ctx.test2.vault.renameFile(oldPath, newPath);
      console.log("  Moved out of folder in TEST2");

      await Promise.all([
        ctx.test.sync.waitForFile(newPath, { timeoutMs: 5000 }),
        ctx.test.sync.waitForFileDeletion(oldPath, { timeoutMs: 5000 }),
      ]);

      console.log("  Move synced to TEST");
    },
  },

  {
    name: "Rename with content change syncs correctly",
    parallel: false, // Sequential to avoid race conditions
    async fn(ctx: TestContext) {
      const oldPath = "rename-modify-old.md";
      const newPath = "rename-modify-new.md";
      const oldContent = "# Old Content\n\nOriginal.";
      const newContent = "# New Content\n\nModified during rename.";

      await ctx.test.vault.createFile(oldPath, oldContent);
      await ctx.test2.sync.waitForFile(oldPath);
      console.log("  Created and synced original file");

      // Simulate rename+modify by delete+create
      // Note: Remote changes are now serialized, so no delay needed
      await ctx.test.vault.deleteFile(oldPath);
      console.log("  Deleted old file in TEST");

      await ctx.test.vault.createFile(newPath, newContent);
      console.log("  Created new file in TEST");

      // Wait for both operations to sync
      await ctx.test2.sync.waitForFile(newPath);
      console.log("  New file appeared in TEST2");

      await ctx.test2.sync.waitForFileDeletion(oldPath, { timeoutMs: 30000 });
      console.log("  Old file deleted in TEST2");

      await assertFileContent(ctx.test2.vault, newPath, newContent);
      console.log("  Rename with content change synced");
    },
  },

  {
    name: "Move between folders syncs correctly",
    parallel: false, // Sequential to avoid race conditions with parallel tests
    async fn(ctx: TestContext) {
      const oldPath = "folder-a/cross-folder.md";
      const newPath = "folder-b/cross-folder.md";
      const content = "# Cross-folder Move\n\nMoving between folders.";

      await ctx.test.vault.createFile(oldPath, content);
      await ctx.test2.sync.waitForFile(oldPath);

      await ctx.test.vault.renameFile(oldPath, newPath);

      await Promise.all([
        ctx.test2.sync.waitForFile(newPath),
        ctx.test2.sync.waitForFileDeletion(oldPath),
      ]);

      await assertFileContent(ctx.test2.vault, newPath, content);
      console.log("  Cross-folder move synced");
    },
  },

  {
    name: "CRDT versions converge after renames",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence();
      console.log("  CRDT versions converged");
    },
  },
];
