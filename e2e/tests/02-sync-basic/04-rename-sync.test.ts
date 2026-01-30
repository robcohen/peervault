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
    async fn(ctx: TestContext) {
      const oldPath = "rename-test-old.md";
      const newPath = "rename-test-new.md";
      const content = "# Rename Test\n\nThis file will be renamed.";

      // Create file
      await ctx.test.vault.createFile(oldPath, content);
      await ctx.test2.sync.waitForFile(oldPath, { timeoutMs: 30000 });
      console.log("  Created original file");

      // Rename in TEST
      await ctx.test.vault.renameFile(oldPath, newPath);
      console.log("  Renamed in TEST");

      // Wait for new file to appear in TEST2
      await ctx.test2.sync.waitForFile(newPath, { timeoutMs: 30000 });

      // Old file should be gone
      await ctx.test2.sync.waitForFileDeletion(oldPath, { timeoutMs: 30000 });

      // Verify content preserved
      await assertFileContent(ctx.test2.vault, newPath, content);
      console.log("  Rename synced with content preserved");
    },
  },

  {
    name: "Move file to folder in TEST syncs to TEST2",
    async fn(ctx: TestContext) {
      const oldPath = "move-test.md";
      const newPath = "moved-folder/move-test.md";
      const content = "# Move Test\n\nThis file will be moved.";

      // Create file
      await ctx.test.vault.createFile(oldPath, content);
      await ctx.test2.sync.waitForFile(oldPath, { timeoutMs: 30000 });

      // Move in TEST
      await ctx.test.vault.renameFile(oldPath, newPath);
      console.log("  Moved to folder in TEST");

      // Wait for new location
      await ctx.test2.sync.waitForFile(newPath, { timeoutMs: 30000 });

      // Old location should be gone
      await ctx.test2.sync.waitForFileDeletion(oldPath, { timeoutMs: 30000 });

      // Verify content
      await assertFileContent(ctx.test2.vault, newPath, content);
      console.log("  Move synced correctly");
    },
  },

  {
    name: "Move file out of folder in TEST2 syncs to TEST",
    async fn(ctx: TestContext) {
      const oldPath = "source-folder/nested-file.md";
      const newPath = "nested-file-moved.md";
      const content = "# Nested File\n\nMoving out of folder.";

      // Create file in folder
      await ctx.test2.vault.createFile(oldPath, content);
      await ctx.test.sync.waitForFile(oldPath, { timeoutMs: 30000 });

      // Move out of folder in TEST2
      await ctx.test2.vault.renameFile(oldPath, newPath);
      console.log("  Moved out of folder in TEST2");

      // Wait for new location in TEST
      await ctx.test.sync.waitForFile(newPath, { timeoutMs: 30000 });

      // Old location should be gone
      await ctx.test.sync.waitForFileDeletion(oldPath, { timeoutMs: 30000 });

      console.log("  Move synced to TEST");
    },
  },

  {
    name: "Rename with content change syncs correctly",
    async fn(ctx: TestContext) {
      const oldPath = "rename-modify-old.md";
      const newPath = "rename-modify-new.md";
      const oldContent = "# Old Content\n\nOriginal.";
      const newContent = "# New Content\n\nModified during rename.";

      // Create file
      await ctx.test.vault.createFile(oldPath, oldContent);
      await ctx.test2.sync.waitForFile(oldPath, { timeoutMs: 30000 });

      // Delete old, create new with different content (simulating rename+modify)
      await ctx.test.vault.deleteFile(oldPath);
      await ctx.test.vault.createFile(newPath, newContent);

      // Wait for sync
      await ctx.test2.sync.waitForFile(newPath, { timeoutMs: 30000 });
      await ctx.test2.sync.waitForFileDeletion(oldPath, { timeoutMs: 30000 });

      // Verify new content
      await assertFileContent(ctx.test2.vault, newPath, newContent);
      console.log("  Rename with content change synced");
    },
  },

  {
    name: "Move between folders syncs correctly",
    async fn(ctx: TestContext) {
      const oldPath = "folder-a/cross-folder.md";
      const newPath = "folder-b/cross-folder.md";
      const content = "# Cross-folder Move\n\nMoving between folders.";

      // Create in folder-a
      await ctx.test.vault.createFile(oldPath, content);
      await ctx.test2.sync.waitForFile(oldPath, { timeoutMs: 30000 });

      // Move to folder-b
      await ctx.test.vault.renameFile(oldPath, newPath);

      // Wait for sync
      await ctx.test2.sync.waitForFile(newPath, { timeoutMs: 30000 });
      await ctx.test2.sync.waitForFileDeletion(oldPath, { timeoutMs: 30000 });

      // Verify
      await assertFileContent(ctx.test2.vault, newPath, content);
      console.log("  Cross-folder move synced");
    },
  },

  {
    name: "CRDT versions converge after renames",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(30000);
      console.log("  CRDT versions converged");
    },
  },
];
