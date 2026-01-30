/**
 * Basic Sync Tests - File Modification
 *
 * Tests syncing modified files between vaults.
 */

import type { TestContext } from "../../lib/context";
import {
  assertFileContent,
  assertFileContains,
} from "../../lib/assertions";

export default [
  {
    name: "Modify file in TEST syncs to TEST2",
    async fn(ctx: TestContext) {
      const path = "sync-test-1.md";
      const newContent = "# Sync Test 1 - Modified\n\nThis content was updated in TEST.";

      // Modify file in TEST
      await ctx.test.vault.modifyFile(path, newContent);
      console.log(`  Modified ${path} in TEST`);

      // Wait for content to sync
      await ctx.test2.sync.waitForContent(path, newContent, { timeoutMs: 30000 });
      console.log("  Modification synced to TEST2");
    },
  },

  {
    name: "Modify file in TEST2 syncs to TEST",
    async fn(ctx: TestContext) {
      const path = "sync-test-2.md";
      const newContent = "# Sync Test 2 - Modified\n\nThis content was updated in TEST2.";

      // Modify file in TEST2
      await ctx.test2.vault.modifyFile(path, newContent);
      console.log(`  Modified ${path} in TEST2`);

      // Wait for content to sync
      await ctx.test.sync.waitForContent(path, newContent, { timeoutMs: 30000 });
      console.log("  Modification synced to TEST");
    },
  },

  {
    name: "Multiple rapid modifications sync correctly",
    async fn(ctx: TestContext) {
      const path = "rapid-modify.md";

      // Create initial file
      await ctx.test.vault.createFile(path, "Version 0");
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Make rapid modifications
      for (let i = 1; i <= 5; i++) {
        await ctx.test.vault.modifyFile(path, `Version ${i}`);
        await new Promise((r) => setTimeout(r, 500));
      }

      // Wait for final version
      await ctx.test2.sync.waitForContent(path, "Version 5", { timeoutMs: 30000 });
      console.log("  Rapid modifications synced correctly");
    },
  },

  {
    name: "Append content syncs correctly",
    async fn(ctx: TestContext) {
      const path = "append-test.md";
      const initialContent = "# Append Test\n\nInitial content.";

      // Create initial file
      await ctx.test.vault.createFile(path, initialContent);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Append content in TEST
      const appendedContent = initialContent + "\n\n## Added Section\n\nAppended in TEST.";
      await ctx.test.vault.modifyFile(path, appendedContent);

      // Verify in TEST2
      await ctx.test2.sync.waitForContent(path, appendedContent, { timeoutMs: 30000 });
      console.log("  Appended content synced");
    },
  },

  {
    name: "Prepend content syncs correctly",
    async fn(ctx: TestContext) {
      const path = "prepend-test.md";
      const initialContent = "# Prepend Test\n\nOriginal content.";

      // Create initial file
      await ctx.test2.vault.createFile(path, initialContent);
      await ctx.test.sync.waitForFile(path, { timeoutMs: 30000 });

      // Prepend content in TEST2
      const prependedContent = "---\ntags: [prepend, test]\n---\n\n" + initialContent;
      await ctx.test2.vault.modifyFile(path, prependedContent);

      // Verify in TEST
      await ctx.test.sync.waitForContent(path, prependedContent, { timeoutMs: 30000 });
      console.log("  Prepended content synced");
    },
  },

  {
    name: "Large modification syncs correctly",
    async fn(ctx: TestContext) {
      const path = "large-modify.md";

      // Create initial file
      await ctx.test.vault.createFile(path, "Initial small content");
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Create large content (100KB)
      const line = "This is a line of content for testing large modifications. ";
      const largeContent = Array(2000).fill(line).join("\n");

      await ctx.test.vault.modifyFile(path, largeContent);

      // Wait for sync
      await ctx.test2.sync.waitForContentContains(path, "large modifications", {
        timeoutMs: 60000,
      });

      // Verify full content
      await assertFileContent(ctx.test2.vault, path, largeContent);
      console.log(`  Large modification (${largeContent.length} bytes) synced`);
    },
  },

  {
    name: "CRDT versions converge after modifications",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(30000);
      console.log("  CRDT versions converged");
    },
  },
];
