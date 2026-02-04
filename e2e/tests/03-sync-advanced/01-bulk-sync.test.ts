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

      for (let i = 0; i < fileCount; i++) {
        const path = `bulk/rapid-${i.toString().padStart(2, "0")}.md`;
        const content = `# Rapid File ${i}\n\nCreated in bulk test.`;
        files.push({ path, content });
        await ctx.test.vault.createFile(path, content);
      }
      console.log(`  Created ${fileCount} files in TEST`);

      // Wait for last file to sync
      await ctx.test2.sync.waitForFile(files[files.length - 1].path, {
        timeoutMs: 30000,
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
      const fixtures = createStandardTestSet();
      const count = await loadInlineFixtures(ctx.test2.vault, fixtures);
      console.log(`  Loaded ${count} fixtures into TEST2`);

      for (const fixture of fixtures) {
        await ctx.test.sync.waitForFile(fixture.path, { timeoutMs: 30000 });
      }
      console.log(`  All fixtures synced to TEST`);
    },
  },

  {
    name: "Sync files from fixtures/text directory",
    async fn(ctx: TestContext) {
      const count = await loadFixturesByName(ctx.test.vault, "text");
      console.log(`  Loaded ${count} text fixtures into TEST`);

      await ctx.test2.sync.waitForFile("simple.md");
      console.log("  Text fixtures synced");
    },
  },

  {
    name: "Sync deeply nested folder structure",
    async fn(ctx: TestContext) {
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

      await ctx.test2.sync.waitForFile(`${path}/file.md`, { timeoutMs: 30000 });
      console.log("  Deep structure synced");
    },
  },

  {
    name: "Bulk delete syncs correctly",
    async fn(ctx: TestContext) {
      await ctx.test.vault.deleteFolder("bulk");
      console.log("  Deleted bulk folder from TEST");

      await ctx.test2.sync.waitForFileDeletion("bulk/rapid-00.md");
      console.log("  Bulk deletion synced");
    },
  },

  {
    name: "CRDT file lists match after bulk operations",
    async fn(ctx: TestContext) {
      await ctx.waitForFileListMatch(30000);
      console.log("  CRDT file lists match");
    },
  },

  {
    name: "CRDT versions converge after bulk operations",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence();
      console.log("  CRDT versions converged");
    },
  },
];
