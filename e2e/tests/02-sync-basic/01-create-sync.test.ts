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
    name: "Create file in TEST syncs to TEST2",
    async fn(ctx: TestContext) {
      const path = "sync-test-1.md";
      const content = "# Sync Test 1\n\nCreated in TEST, should sync to TEST2.";

      // Create file in TEST
      await ctx.test.vault.createFile(path, content);
      console.log(`  Created ${path} in TEST`);

      // Wait for sync
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });
      console.log("  File appeared in TEST2");

      // Verify content
      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Content matches");
    },
  },

  {
    name: "Create file in TEST2 syncs to TEST",
    async fn(ctx: TestContext) {
      const path = "sync-test-2.md";
      const content = "# Sync Test 2\n\nCreated in TEST2, should sync to TEST.";

      // Create file in TEST2
      await ctx.test2.vault.createFile(path, content);
      console.log(`  Created ${path} in TEST2`);

      // Wait for sync
      await ctx.test.sync.waitForFile(path, { timeoutMs: 30000 });
      console.log("  File appeared in TEST");

      // Verify content
      await assertFileContent(ctx.test.vault, path, content);
      console.log("  Content matches");
    },
  },

  {
    name: "Multiple files created quickly sync correctly",
    async fn(ctx: TestContext) {
      const files = [
        { path: "batch/file-1.md", content: "Batch file 1" },
        { path: "batch/file-2.md", content: "Batch file 2" },
        { path: "batch/file-3.md", content: "Batch file 3" },
      ];

      // Create all files in TEST
      for (const file of files) {
        await ctx.test.vault.createFile(file.path, file.content);
      }
      console.log(`  Created ${files.length} files in TEST`);

      // Wait for all files to appear in TEST2
      for (const file of files) {
        await ctx.test2.sync.waitForFile(file.path, { timeoutMs: 30000 });
      }
      console.log("  All files appeared in TEST2");

      // Verify contents
      for (const file of files) {
        await assertFileContent(ctx.test2.vault, file.path, file.content);
      }
      console.log("  All contents match");
    },
  },

  {
    name: "File with frontmatter syncs correctly",
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

      // Create in TEST
      await ctx.test.vault.createFile(path, content);

      // Wait for sync
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      // Verify content
      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Frontmatter preserved correctly");
    },
  },

  {
    name: "File with internal links syncs correctly",
    async fn(ctx: TestContext) {
      const path = "links-test.md";
      const content = `# Links Test

This links to [[sync-test-1]] and [[sync-test-2]].

Also [[batch/file-1|with alias]].

And an embed: ![[sync-test-1]]`;

      // Create in TEST2
      await ctx.test2.vault.createFile(path, content);

      // Wait for sync
      await ctx.test.sync.waitForFile(path, { timeoutMs: 30000 });

      // Verify content
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
      // Wait for version convergence
      await ctx.waitForConvergence(30000);
      console.log("  CRDT versions have converged");
    },
  },
];
