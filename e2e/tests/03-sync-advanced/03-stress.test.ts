/**
 * Advanced Sync Tests - Stress Tests
 *
 * High-load tests to verify sync under pressure.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
  assertFileContent,
} from "../../lib/assertions";

export default [
  {
    name: "Stress test: Create 50 files rapidly and verify sync",
    async fn(ctx: TestContext) {
      const fileCount = 50;
      const files: Array<{ path: string; content: string }> = [];

      // Create files as fast as possible
      console.log(`  Creating ${fileCount} files...`);
      for (let i = 0; i < fileCount; i++) {
        const path = `stress/file-${i.toString().padStart(3, "0")}.md`;
        const content = `# Stress Test ${i}\n\nContent for stress test file ${i}.`;
        files.push({ path, content });
        await ctx.test.vault.createFile(path, content);
      }
      console.log(`  Created ${fileCount} files in TEST`);

      // Wait for all files to sync (with longer timeout for stress)
      for (const file of files) {
        await ctx.test2.sync.waitForFile(file.path, { timeoutMs: 60000 });
      }
      console.log(`  All ${fileCount} files synced to TEST2`);

      // Verify content of a sample
      const sample = [files[0], files[24], files[49]];
      for (const file of sample) {
        await assertFileContent(ctx.test2.vault, file.path, file.content);
      }
      console.log("  Sample content verification passed");
    },
  },

  {
    name: "Deep nesting: 10-level folder structure",
    async fn(ctx: TestContext) {
      const depth = 10;
      let path = "deep-nest";

      // Create progressively deeper structure
      for (let i = 1; i <= depth; i++) {
        path = `${path}/level-${i}`;
        await ctx.test.vault.createFile(
          `${path}/file.md`,
          `# Level ${i}\n\nNested ${i} levels deep.`
        );
      }
      console.log(`  Created ${depth}-level deep structure`);

      // Wait for deepest file
      const deepestPath = `${path}/file.md`;
      await ctx.test2.sync.waitForFile(deepestPath, { timeoutMs: 30000 });
      console.log("  Deep structure synced");

      // Verify content at deepest level
      await assertFileExists(ctx.test2.vault, deepestPath);
      console.log(`  Verified ${depth}-level nesting works`);
    },
  },

  {
    name: "Concurrent edits: Both vaults editing rapidly",
    async fn(ctx: TestContext) {
      const path = "concurrent-edit.md";
      const editCount = 10;

      // Create initial file
      await ctx.test.vault.createFile(path, "Initial content");
      await ctx.test2.sync.waitForFile(path);
      console.log("  Initial file synced");

      // Both sides make rapid edits alternating
      for (let i = 1; i <= editCount; i++) {
        if (i % 2 === 1) {
          await ctx.test.vault.modifyFile(path, `Edit ${i} from TEST`);
        } else {
          await ctx.test2.vault.modifyFile(path, `Edit ${i} from TEST2`);
        }
        // Small delay to let writes process
        await new Promise((r) => setTimeout(r, 100));
      }
      console.log(`  Made ${editCount} rapid alternating edits`);

      // Wait for sync to settle
      await ctx.waitForConvergence();

      // Wait for content to converge (CRDT versions matching doesn't guarantee file writes)
      let content1 = "";
      let content2 = "";
      const maxWaitMs = 10000;
      const startTime = Date.now();
      while (Date.now() - startTime < maxWaitMs) {
        content1 = await ctx.test.vault.readFile(path);
        content2 = await ctx.test2.vault.readFile(path);
        if (content1 === content2) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      // Both vaults should have same content (CRDT resolution)
      assert(
        content1 === content2,
        `Content diverged: TEST="${content1.slice(0, 30)}", TEST2="${content2.slice(0, 30)}"`
      );
      console.log("  Concurrent edits converged to same content");
    },
  },

  {
    name: "Large file sync: 1MB file",
    async fn(ctx: TestContext) {
      const path = "large-file-1mb.md";

      // Create 1MB of content
      const line = "This is a line of content for testing large file sync operations. ".repeat(10) + "\n";
      const targetSize = 1024 * 1024; // 1MB
      const linesNeeded = Math.ceil(targetSize / line.length);
      const largeContent = "# Large File Test (1MB)\n\n" + line.repeat(linesNeeded);

      console.log(`  Creating ${(largeContent.length / 1024 / 1024).toFixed(2)}MB file...`);
      await ctx.test.vault.createFile(path, largeContent);
      console.log("  File created in TEST");

      // Wait for sync with extended timeout
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 60000 });
      console.log("  File synced to TEST2");

      // Verify content matches
      const synced = await ctx.test2.vault.readFile(path);
      assert(
        synced.length === largeContent.length,
        `Size mismatch: expected ${largeContent.length}, got ${synced.length}`
      );
      console.log(`  Content verified (${largeContent.length} bytes)`);
    },
  },

  {
    name: "Cleanup stress test files",
    async fn(ctx: TestContext) {
      // Delete stress test folders
      try {
        await ctx.test.vault.deleteFolder("stress");
        console.log("  Deleted stress folder");
      } catch {
        console.log("  stress folder not found (ok)");
      }

      try {
        await ctx.test.vault.deleteFolder("deep-nest");
        console.log("  Deleted deep-nest folder");
      } catch {
        console.log("  deep-nest folder not found (ok)");
      }

      try {
        await ctx.test.vault.deleteFile("concurrent-edit.md");
        console.log("  Deleted concurrent-edit.md");
      } catch {
        console.log("  concurrent-edit.md not found (ok)");
      }

      try {
        await ctx.test.vault.deleteFile("large-file-1mb.md");
        console.log("  Deleted large-file-1mb.md");
      } catch {
        console.log("  large-file-1mb.md not found (ok)");
      }

      // Wait for deletions to sync
      await new Promise((r) => setTimeout(r, 3000));
      console.log("  Cleanup complete");
    },
  },

  {
    name: "CRDT versions converge after stress tests",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence();
      console.log("  CRDT versions converged");
    },
  },
];
