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
    parallel: true,
    async fn(ctx: TestContext) {
      const path = "sync-test-1.md";
      const newContent = "# Sync Test 1 - Modified\n\nThis content was updated in TEST.";

      await ctx.test.vault.modifyFile(path, newContent);
      console.log(`  Modified ${path} in TEST`);

      await ctx.test2.sync.waitForContent(path, newContent);
      console.log("  Modification synced to TEST2");
    },
  },

  {
    name: "Modify file in TEST2 syncs to TEST",
    parallel: true,
    async fn(ctx: TestContext) {
      const path = "sync-test-2.md";
      const newContent = "# Sync Test 2 - Modified\n\nThis content was updated in TEST2.";

      await ctx.test2.vault.modifyFile(path, newContent);
      console.log(`  Modified ${path} in TEST2`);

      await ctx.test.sync.waitForContent(path, newContent);
      console.log("  Modification synced to TEST");
    },
  },

  {
    name: "Multiple rapid modifications sync correctly",
    parallel: true,
    async fn(ctx: TestContext) {
      const path = "rapid-modify.md";

      await ctx.test.vault.createFile(path, "Version 0");
      await ctx.test2.sync.waitForFile(path);

      // Make rapid modifications with shorter delay
      for (let i = 1; i <= 5; i++) {
        await ctx.test.vault.modifyFile(path, `Version ${i}`);
        await new Promise((r) => setTimeout(r, 200));
      }

      await ctx.test2.sync.waitForContent(path, "Version 5");
      console.log("  Rapid modifications synced correctly");
    },
  },

  {
    name: "Append content syncs correctly",
    parallel: true,
    async fn(ctx: TestContext) {
      const path = "append-test.md";
      const initialContent = "# Append Test\n\nInitial content.";

      await ctx.test.vault.createFile(path, initialContent);
      await ctx.test2.sync.waitForFile(path);

      const appendedContent = initialContent + "\n\n## Added Section\n\nAppended in TEST.";
      await ctx.test.vault.modifyFile(path, appendedContent);

      await ctx.test2.sync.waitForContent(path, appendedContent);
      console.log("  Appended content synced");
    },
  },

  {
    name: "Prepend content syncs correctly",
    parallel: true,
    async fn(ctx: TestContext) {
      const path = "prepend-test.md";
      const initialContent = "# Prepend Test\n\nOriginal content.";

      await ctx.test2.vault.createFile(path, initialContent);
      await ctx.test.sync.waitForFile(path);

      const prependedContent = "---\ntags: [prepend, test]\n---\n\n" + initialContent;
      await ctx.test2.vault.modifyFile(path, prependedContent);

      await ctx.test.sync.waitForContent(path, prependedContent);
      console.log("  Prepended content synced");
    },
  },

  {
    name: "Large modification syncs correctly",
    async fn(ctx: TestContext) {
      const path = "large-modify.md";

      await ctx.test.vault.createFile(path, "Initial small content");
      await ctx.test2.sync.waitForFile(path);

      // Create large content (100KB)
      const line = "This is a line of content for testing large modifications. ";
      const largeContent = Array(2000).fill(line).join("\n");

      await ctx.test.vault.modifyFile(path, largeContent);

      // Use longer timeout for large files
      await ctx.test2.sync.waitForContentContains(path, "large modifications", {
        timeoutMs: 30000,
      });

      await assertFileContent(ctx.test2.vault, path, largeContent);
      console.log(`  Large modification (${largeContent.length} bytes) synced`);
    },
  },

  {
    name: "CRDT versions converge after modifications",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence();
      console.log("  CRDT versions converged");
    },
  },
];
