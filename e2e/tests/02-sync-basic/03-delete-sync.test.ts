/**
 * Basic Sync Tests - File Deletion
 *
 * Tests syncing deleted files between vaults.
 */

import type { TestContext } from "../../lib/context";
import {
  assertFileExists,
  assertFileNotExists,
  assertNotInCrdt,
} from "../../lib/assertions";

export default [
  {
    name: "Delete file in TEST removes from TEST2",
    async fn(ctx: TestContext) {
      const path = "delete-test-1.md";
      const content = "# Delete Test 1\n\nThis file will be deleted.";

      // Create file
      await ctx.test.vault.createFile(path, content);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Verify exists in both
      await assertFileExists(ctx.test.vault, path);
      await assertFileExists(ctx.test2.vault, path);
      console.log("  File exists in both vaults");

      // Delete in TEST
      await ctx.test.vault.deleteFile(path);
      console.log("  Deleted from TEST");

      // Wait for deletion to sync
      await ctx.test2.sync.waitForFileDeletion(path, { timeoutMs: 30000 });
      console.log("  Deletion synced to TEST2");

      // Verify gone from both
      await assertFileNotExists(ctx.test.vault, path);
      await assertFileNotExists(ctx.test2.vault, path);
    },
  },

  {
    name: "Delete file in TEST2 removes from TEST",
    async fn(ctx: TestContext) {
      const path = "delete-test-2.md";
      const content = "# Delete Test 2\n\nThis file will be deleted from TEST2.";

      // Create file
      await ctx.test2.vault.createFile(path, content);
      await ctx.test.sync.waitForFile(path, { timeoutMs: 30000 });

      // Delete in TEST2
      await ctx.test2.vault.deleteFile(path);
      console.log("  Deleted from TEST2");

      // Wait for deletion to sync
      await ctx.test.sync.waitForFileDeletion(path, { timeoutMs: 30000 });
      console.log("  Deletion synced to TEST");
    },
  },

  {
    name: "Delete folder removes all contents on both vaults",
    async fn(ctx: TestContext) {
      // Create folder with files
      await ctx.test.vault.createFile("delete-folder/file-1.md", "File 1");
      await ctx.test.vault.createFile("delete-folder/file-2.md", "File 2");
      await ctx.test.vault.createFile("delete-folder/sub/file-3.md", "File 3");

      // Wait for sync
      await ctx.test2.sync.waitForFile("delete-folder/sub/file-3.md", {
        timeoutMs: 30000,
      });
      console.log("  Folder synced to TEST2");

      // Delete folder in TEST
      await ctx.test.vault.deleteFolder("delete-folder");
      console.log("  Deleted folder from TEST");

      // Wait for all files to be deleted in TEST2
      await ctx.test2.sync.waitForFileDeletion("delete-folder/file-1.md", {
        timeoutMs: 30000,
      });
      await ctx.test2.sync.waitForFileDeletion("delete-folder/file-2.md", {
        timeoutMs: 30000,
      });
      await ctx.test2.sync.waitForFileDeletion("delete-folder/sub/file-3.md", {
        timeoutMs: 30000,
      });
      console.log("  Folder deletion synced to TEST2");
    },
  },

  {
    name: "Deleted files removed from CRDT",
    async fn(ctx: TestContext) {
      const path = "crdt-delete-test.md";

      // Create and sync
      await ctx.test.vault.createFile(path, "Test content");
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Delete
      await ctx.test.vault.deleteFile(path);
      await ctx.test2.sync.waitForFileDeletion(path, { timeoutMs: 30000 });

      // Wait for CRDT to update
      await new Promise((r) => setTimeout(r, 2000));

      // Verify not in CRDT
      await assertNotInCrdt(ctx.test.plugin, path);
      await assertNotInCrdt(ctx.test2.plugin, path);
      console.log("  Deleted file removed from CRDT on both vaults");
    },
  },

  {
    name: "Create file with same name after delete",
    async fn(ctx: TestContext) {
      const path = "recreate-test.md";

      // Create initial file
      await ctx.test.vault.createFile(path, "Version 1");
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Delete
      await ctx.test.vault.deleteFile(path);
      await ctx.test2.sync.waitForFileDeletion(path, { timeoutMs: 30000 });

      // Wait a moment
      await new Promise((r) => setTimeout(r, 1000));

      // Create new file with same name
      await ctx.test2.vault.createFile(path, "Version 2 - Recreated");
      await ctx.test.sync.waitForFile(path, { timeoutMs: 30000 });

      // Verify new content
      const content = await ctx.test.vault.readFile(path);
      if (!content.includes("Version 2")) {
        throw new Error(`Expected "Version 2", got: ${content}`);
      }
      console.log("  Recreated file synced correctly");
    },
  },

  {
    name: "CRDT versions converge after deletions",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(30000);
      console.log("  CRDT versions converged");
    },
  },
];
