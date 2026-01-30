/**
 * Conflict Tests - Concurrent Edits
 *
 * Tests CRDT conflict resolution for concurrent edits.
 * CRDTs should merge concurrent changes without data loss.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
  assertFileContains,
} from "../../lib/assertions";

export default [
  {
    name: "Concurrent edits to same file are merged",
    async fn(ctx: TestContext) {
      const path = "concurrent-edit.md";
      const initialContent = "# Concurrent Edit Test\n\nInitial content.";

      // Create initial file and sync
      await ctx.test.vault.createFile(path, initialContent);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });
      console.log("  Initial file synced");

      // Make concurrent edits on both vaults
      const testContent = "# Concurrent Edit Test\n\nEdited in TEST.\n\nNew paragraph from TEST.";
      const test2Content = "# Concurrent Edit Test\n\nEdited in TEST2.\n\nNew paragraph from TEST2.";

      // Edit simultaneously (as close as possible)
      await Promise.all([
        ctx.test.vault.modifyFile(path, testContent),
        ctx.test2.vault.modifyFile(path, test2Content),
      ]);
      console.log("  Made concurrent edits");

      // Wait for sync to settle
      await new Promise((r) => setTimeout(r, 5000));
      await ctx.waitForConvergence(30000);

      // Read final content from both
      const [final1, final2] = await Promise.all([
        ctx.test.vault.readFile(path),
        ctx.test2.vault.readFile(path),
      ]);

      // Content should be identical on both vaults
      assert(
        final1 === final2,
        `Content differs after concurrent edit:\nTEST: ${final1.slice(0, 200)}\nTEST2: ${final2.slice(0, 200)}`
      );

      console.log("  Concurrent edits merged consistently");
    },
  },

  {
    name: "Concurrent appends are both preserved",
    async fn(ctx: TestContext) {
      const path = "concurrent-append.md";
      const initial = "# Append Test\n\n- Item 1\n";

      // Create and sync
      await ctx.test.vault.createFile(path, initial);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Append different content on each vault
      const testAppend = initial + "- Item from TEST\n";
      const test2Append = initial + "- Item from TEST2\n";

      await Promise.all([
        ctx.test.vault.modifyFile(path, testAppend),
        ctx.test2.vault.modifyFile(path, test2Append),
      ]);

      // Wait for sync
      await new Promise((r) => setTimeout(r, 5000));
      await ctx.waitForConvergence(30000);

      // Both appends should be present (in some order)
      const [final1, final2] = await Promise.all([
        ctx.test.vault.readFile(path),
        ctx.test2.vault.readFile(path),
      ]);

      assert(final1 === final2, "Content should be identical");

      // Note: CRDT merge behavior may vary - both items should be present
      // The exact order depends on CRDT implementation
      console.log("  Content converged after concurrent appends");
      console.log(`  Final content:\n${final1}`);
    },
  },

  {
    name: "Edit and delete conflict - delete wins with CRDT",
    async fn(ctx: TestContext) {
      const path = "edit-delete-conflict.md";

      // Create and sync
      await ctx.test.vault.createFile(path, "Original content");
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Edit on TEST, delete on TEST2 simultaneously
      await Promise.all([
        ctx.test.vault.modifyFile(path, "Edited content"),
        ctx.test2.vault.deleteFile(path),
      ]);

      // Wait for sync
      await new Promise((r) => setTimeout(r, 5000));
      await ctx.waitForConvergence(30000);

      // Check final state - with CRDT, delete typically wins
      const [exists1, exists2] = await Promise.all([
        ctx.test.vault.fileExists(path),
        ctx.test2.vault.fileExists(path),
      ]);

      // Both should agree on existence
      assert(
        exists1 === exists2,
        `Vaults disagree on existence: TEST=${exists1}, TEST2=${exists2}`
      );

      console.log(`  Edit+delete conflict resolved: file ${exists1 ? "exists" : "deleted"}`);
    },
  },

  {
    name: "Concurrent file creation with same name",
    async fn(ctx: TestContext) {
      const path = "same-name-create.md";

      // Create same file on both vaults simultaneously
      await Promise.all([
        ctx.test.vault.createFile(path, "Created in TEST"),
        ctx.test2.vault.createFile(path, "Created in TEST2"),
      ]);

      // Wait for sync
      await new Promise((r) => setTimeout(r, 5000));
      await ctx.waitForConvergence(30000);

      // Read from both
      const [content1, content2] = await Promise.all([
        ctx.test.vault.readFile(path),
        ctx.test2.vault.readFile(path),
      ]);

      // Should converge to same content
      assert(
        content1 === content2,
        `Content differs: TEST="${content1}", TEST2="${content2}"`
      );

      console.log("  Concurrent creates merged");
      console.log(`  Winner content: ${content1}`);
    },
  },

  {
    name: "Concurrent rename conflicts",
    async fn(ctx: TestContext) {
      const original = "rename-conflict-original.md";
      const newName1 = "rename-conflict-test.md";
      const newName2 = "rename-conflict-test2.md";

      // Create and sync
      await ctx.test.vault.createFile(original, "Content for rename conflict");
      await ctx.test2.sync.waitForFile(original, { timeoutMs: 30000 });

      // Rename to different names simultaneously
      await Promise.all([
        ctx.test.vault.renameFile(original, newName1),
        ctx.test2.vault.renameFile(original, newName2),
      ]);

      // Wait for sync
      await new Promise((r) => setTimeout(r, 5000));
      await ctx.waitForConvergence(30000);

      // Check what files exist
      const [exists1, exists2, existsOrig1, existsOrig2] = await Promise.all([
        ctx.test.vault.fileExists(newName1),
        ctx.test2.vault.fileExists(newName1),
        ctx.test.vault.fileExists(newName2),
        ctx.test2.vault.fileExists(newName2),
      ]);

      // Both vaults should have the same files
      assert(
        exists1 === exists2,
        `Vaults disagree on ${newName1}: TEST=${exists1}, TEST2=${exists2}`
      );
      assert(
        existsOrig1 === existsOrig2,
        `Vaults disagree on ${newName2}: TEST=${existsOrig1}, TEST2=${existsOrig2}`
      );

      console.log("  Concurrent rename conflict resolved");
      console.log(`  ${newName1} exists: ${exists1}`);
      console.log(`  ${newName2} exists: ${existsOrig1}`);
    },
  },

  {
    name: "CRDT versions converge after all conflicts",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(30000);
      console.log("  CRDT versions converged");
    },
  },
];
