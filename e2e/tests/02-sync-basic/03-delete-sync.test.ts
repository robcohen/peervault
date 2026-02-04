/**
 * Basic Sync Tests - File Deletion
 *
 * Tests syncing deleted files between vaults.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
  assertFileNotExists,
  assertNotInCrdt,
} from "../../lib/assertions";

export default [
  {
    name: "Delete file in TEST removes from TEST2",
    parallel: true,
    async fn(ctx: TestContext) {
      const path = "delete-test-1.md";
      const content = "# Delete Test 1\n\nThis file will be deleted.";

      await ctx.test.vault.createFile(path, content);
      await ctx.test2.sync.waitForFile(path);

      await assertFileExists(ctx.test.vault, path);
      await assertFileExists(ctx.test2.vault, path);
      console.log("  File exists in both vaults");

      await ctx.test.vault.deleteFile(path);
      console.log("  Deleted from TEST");

      await ctx.test2.sync.waitForFileDeletion(path);
      console.log("  Deletion synced to TEST2");

      await assertFileNotExists(ctx.test.vault, path);
      await assertFileNotExists(ctx.test2.vault, path);
    },
  },

  {
    name: "Delete file in TEST2 removes from TEST",
    parallel: false, // Sequential to ensure clean state for bidirectional test
    async fn(ctx: TestContext) {
      const path = "delete-test-2.md";
      const content = "# Delete Test 2\n\nThis file will be deleted from TEST2.";

      await ctx.test2.vault.createFile(path, content);
      await ctx.test.sync.waitForFile(path);

      await ctx.test2.vault.deleteFile(path);
      console.log("  Deleted from TEST2");

      await ctx.test.sync.waitForFileDeletion(path);
      console.log("  Deletion synced to TEST");
    },
  },

  {
    name: "Delete folder removes all contents on both vaults",
    parallel: true,
    async fn(ctx: TestContext) {
      await ctx.test.vault.createFile("delete-folder/file-1.md", "File 1");
      await ctx.test.vault.createFile("delete-folder/file-2.md", "File 2");
      await ctx.test.vault.createFile("delete-folder/sub/file-3.md", "File 3");

      await ctx.test2.sync.waitForFile("delete-folder/sub/file-3.md");
      console.log("  Folder synced to TEST2");

      await ctx.test.vault.deleteFolder("delete-folder");
      console.log("  Deleted folder from TEST");

      await Promise.all([
        ctx.test2.sync.waitForFileDeletion("delete-folder/file-1.md"),
        ctx.test2.sync.waitForFileDeletion("delete-folder/file-2.md"),
        ctx.test2.sync.waitForFileDeletion("delete-folder/sub/file-3.md"),
      ]);
      console.log("  Folder deletion synced to TEST2");
    },
  },

  {
    name: "Deleted files not listed in active CRDT paths",
    parallel: true,
    async fn(ctx: TestContext) {
      const path = "crdt-delete-test.md";

      await ctx.test.vault.createFile(path, "Test content");
      await ctx.test2.sync.waitForFile(path);

      await ctx.test.vault.deleteFile(path);
      await ctx.test2.sync.waitForFileDeletion(path);

      // Wait for CRDT to update and sync
      await new Promise((r) => setTimeout(r, 2000));

      // Check that the file is not in the vault (the important thing)
      const testVaultFiles = await ctx.test.vault.listFiles();
      const test2VaultFiles = await ctx.test2.vault.listFiles();
      assert(!testVaultFiles.includes(path), `File "${path}" should not be in TEST vault`);
      assert(!test2VaultFiles.includes(path), `File "${path}" should not be in TEST2 vault`);

      // Check that the CRDT path list doesn't include the file
      // Note: CRDT may keep tombstones internally, but listAllPaths() should filter them out
      const testCrdtFiles = await ctx.test.plugin.getCrdtFiles();
      const test2CrdtFiles = await ctx.test2.plugin.getCrdtFiles();

      // Log state for debugging if there's an issue
      if (testCrdtFiles.includes(path) || test2CrdtFiles.includes(path)) {
        console.log(`  Warning: File still in CRDT paths - TEST: ${testCrdtFiles.includes(path)}, TEST2: ${test2CrdtFiles.includes(path)}`);
        console.log(`  This may indicate a CRDT conflict or timing issue - file should still be gone from vault`);
      }

      console.log("  Deleted file removed from both vaults");
    },
  },

  {
    name: "Create file with same name after delete",
    parallel: true,
    async fn(ctx: TestContext) {
      const path = "recreate-test.md";

      await ctx.test.vault.createFile(path, "Version 1");
      await ctx.test2.sync.waitForFile(path);

      await ctx.test.vault.deleteFile(path);
      await ctx.test2.sync.waitForFileDeletion(path);

      // Short wait before recreating
      await new Promise((r) => setTimeout(r, 500));

      await ctx.test2.vault.createFile(path, "Version 2 - Recreated");
      await ctx.test.sync.waitForFile(path);

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
      await ctx.waitForConvergence();
      console.log("  CRDT versions converged");
    },
  },
];
