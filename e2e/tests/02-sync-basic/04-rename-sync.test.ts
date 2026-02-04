/**
 * Basic Sync Tests - File Rename/Move
 *
 * Tests syncing renamed and moved files between vaults.
 */

import type { TestContext } from "../../lib/context";
import {
  assertFileExists,
  assertFileNotExists,
  assertFileContent,
} from "../../lib/assertions";

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
    async fn(ctx: TestContext) {
      const oldPath = "move-test.md";
      const newPath = "moved-folder/move-test.md";
      const content = "# Move Test\n\nThis file will be moved.";

      await ctx.test.vault.createFile(oldPath, content);
      await ctx.test2.sync.waitForFile(oldPath);

      await ctx.test.vault.renameFile(oldPath, newPath);
      console.log("  Moved to folder in TEST");

      await Promise.all([
        ctx.test2.sync.waitForFile(newPath),
        ctx.test2.sync.waitForFileDeletion(oldPath),
      ]);

      await assertFileContent(ctx.test2.vault, newPath, content);
      console.log("  Move synced correctly");
    },
  },

  {
    name: "Move file out of folder in TEST2 syncs to TEST",
    parallel: true,
    async fn(ctx: TestContext) {
      const oldPath = "source-folder/nested-file.md";
      const newPath = "nested-file-moved.md";
      const content = "# Nested File\n\nMoving out of folder.";

      await ctx.test2.vault.createFile(oldPath, content);
      await ctx.test.sync.waitForFile(oldPath);

      await ctx.test2.vault.renameFile(oldPath, newPath);
      console.log("  Moved out of folder in TEST2");

      await Promise.all([
        ctx.test.sync.waitForFile(newPath),
        ctx.test.sync.waitForFileDeletion(oldPath),
      ]);

      console.log("  Move synced to TEST");
    },
  },

  {
    name: "Rename with content change syncs correctly",
    parallel: true,
    async fn(ctx: TestContext) {
      const oldPath = "rename-modify-old.md";
      const newPath = "rename-modify-new.md";
      const oldContent = "# Old Content\n\nOriginal.";
      const newContent = "# New Content\n\nModified during rename.";

      await ctx.test.vault.createFile(oldPath, oldContent);
      await ctx.test2.sync.waitForFile(oldPath);

      // Simulate rename+modify by delete+create
      await ctx.test.vault.deleteFile(oldPath);
      // Small delay to ensure delete is processed before create
      await new Promise((r) => setTimeout(r, 200));
      await ctx.test.vault.createFile(newPath, newContent);

      await Promise.all([
        ctx.test2.sync.waitForFile(newPath),
        ctx.test2.sync.waitForFileDeletion(oldPath),
      ]);

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
