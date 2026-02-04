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
    name: "Ensure active sync sessions before testing",
    async fn(ctx: TestContext) {
      // Ensure both vaults have active sync sessions
      // This handles the case where sessions errored out between test suites
      const test1Active = await ctx.test.plugin.ensureActiveSessions();
      const test2Active = await ctx.test2.plugin.ensureActiveSessions();

      assert(
        test1Active,
        "TEST should have an active sync session after force sync"
      );
      assert(
        test2Active,
        "TEST2 should have an active sync session after force sync"
      );

      console.log("  Active sync sessions confirmed on both vaults");
    },
  },

  {
    name: "Create file in TEST syncs to TEST2",
    parallel: true, // Independent file
    async fn(ctx: TestContext) {
      const path = "sync-test-1.md";
      const content = "# Sync Test 1\n\nCreated in TEST, should sync to TEST2.";

      await ctx.test.vault.createFile(path, content);
      console.log(`  Created ${path} in TEST`);

      await ctx.test2.sync.waitForFile(path);
      console.log("  File appeared in TEST2");

      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Content matches");
    },
  },

  {
    name: "Create file in TEST2 syncs to TEST",
    parallel: true, // Independent file
    async fn(ctx: TestContext) {
      const path = "sync-test-2.md";
      const content = "# Sync Test 2\n\nCreated in TEST2, should sync to TEST.";

      await ctx.test2.vault.createFile(path, content);
      console.log(`  Created ${path} in TEST2`);

      await ctx.test.sync.waitForFile(path);
      console.log("  File appeared in TEST");

      await assertFileContent(ctx.test.vault, path, content);
      console.log("  Content matches");
    },
  },

  {
    name: "Multiple files created quickly sync correctly",
    parallel: true, // Independent files
    async fn(ctx: TestContext) {
      const files = [
        { path: "batch/file-1.md", content: "Batch file 1" },
        { path: "batch/file-2.md", content: "Batch file 2" },
        { path: "batch/file-3.md", content: "Batch file 3" },
      ];

      for (const file of files) {
        await ctx.test.vault.createFile(file.path, file.content);
      }
      console.log(`  Created ${files.length} files in TEST`);

      for (const file of files) {
        await ctx.test2.sync.waitForFile(file.path);
      }
      console.log("  All files appeared in TEST2");

      for (const file of files) {
        await assertFileContent(ctx.test2.vault, file.path, file.content);
      }
      console.log("  All contents match");
    },
  },

  {
    name: "File with frontmatter syncs correctly",
    parallel: true, // Independent file
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

      await ctx.test.vault.createFile(path, content);
      await ctx.test2.sync.waitForFile(path);
      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Frontmatter preserved correctly");
    },
  },

  {
    name: "File with internal links syncs correctly",
    parallel: true, // Independent file
    async fn(ctx: TestContext) {
      const path = "links-test.md";
      const content = `# Links Test

This links to [[sync-test-1]] and [[sync-test-2]].

Also [[batch/file-1|with alias]].

And an embed: ![[sync-test-1]]`;

      await ctx.test2.vault.createFile(path, content);
      await ctx.test.sync.waitForFile(path);
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
      await ctx.waitForConvergence();
      console.log("  CRDT versions have converged");
    },
  },
];
