/**
 * Advanced Sync Tests - Bulk Operations
 *
 * Tests syncing many files and large operations.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
  assertFileCount,
  assertVaultsInSync,
} from "../../lib/assertions";
import {
  loadFixturesByName,
  createStandardTestSet,
  loadInlineFixtures,
} from "../../lib/fixtures";

export default [
  {
    name: "Sync 20 files created in rapid succession",
    async fn(ctx: TestContext) {
      const fileCount = 20;
      const files: Array<{ path: string; content: string }> = [];

      // Create files rapidly
      for (let i = 0; i < fileCount; i++) {
        const path = `bulk/rapid-${i.toString().padStart(2, "0")}.md`;
        const content = `# Rapid File ${i}\n\nCreated in bulk test.`;
        files.push({ path, content });
        await ctx.test.vault.createFile(path, content);
      }
      console.log(`  Created ${fileCount} files in TEST`);

      // Wait for last file to sync
      await ctx.test2.sync.waitForFile(files[files.length - 1].path, {
        timeoutMs: 60000,
      });

      // Verify all files exist
      for (const file of files) {
        await assertFileExists(ctx.test2.vault, file.path);
      }
      console.log(`  All ${fileCount} files synced to TEST2`);
    },
  },

  {
    name: "Sync standard test fixture set",
    async fn(ctx: TestContext) {
      // Load standard fixtures into TEST2
      const fixtures = createStandardTestSet();
      const count = await loadInlineFixtures(ctx.test2.vault, fixtures);
      console.log(`  Loaded ${count} fixtures into TEST2`);

      // Wait for all to sync to TEST
      for (const fixture of fixtures) {
        await ctx.test.sync.waitForFile(fixture.path, { timeoutMs: 60000 });
      }
      console.log(`  All fixtures synced to TEST`);
    },
  },

  {
    name: "Sync files from fixtures/text directory",
    async fn(ctx: TestContext) {
      // Load text fixtures
      const count = await loadFixturesByName(ctx.test.vault, "text");
      console.log(`  Loaded ${count} text fixtures into TEST`);

      // Wait for sync by checking for a specific file
      await ctx.test2.sync.waitForFile("simple.md", { timeoutMs: 30000 });
      console.log("  Text fixtures synced");
    },
  },

  {
    name: "Sync deeply nested folder structure",
    async fn(ctx: TestContext) {
      // Create deep nesting
      let path = "";
      const depth = 8;

      for (let i = 1; i <= depth; i++) {
        path = path ? `${path}/level-${i}` : `deep/level-${i}`;
        await ctx.test.vault.createFile(
          `${path}/file.md`,
          `# Level ${i}\n\nNested ${i} levels deep.`
        );
      }
      console.log(`  Created ${depth}-level deep structure`);

      // Wait for deepest file
      await ctx.test2.sync.waitForFile(`${path}/file.md`, { timeoutMs: 60000 });
      console.log("  Deep structure synced");
    },
  },

  {
    name: "Bulk delete syncs correctly",
    async fn(ctx: TestContext) {
      // Delete the bulk folder we created earlier
      await ctx.test.vault.deleteFolder("bulk");
      console.log("  Deleted bulk folder from TEST");

      // Wait for deletion
      await ctx.test2.sync.waitForFileDeletion("bulk/rapid-00.md", {
        timeoutMs: 30000,
      });
      console.log("  Bulk deletion synced");
    },
  },

  {
    name: "CRDT file lists match after bulk operations",
    async fn(ctx: TestContext) {
      await ctx.waitForFileListMatch(60000);
      console.log("  CRDT file lists match");
    },
  },

  {
    name: "CRDT versions converge after bulk operations",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(60000);
      console.log("  CRDT versions converged");
    },
  },
];
