/**
 * Edge Case Tests - Special Files
 *
 * Tests syncing files with special names, unicode, deep nesting, etc.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertFileExists,
  assertFileContent,
} from "../../lib/assertions";
import { loadFixturesByName } from "../../lib/fixtures";

export default [
  {
    name: "Sync files with spaces in names",
    async fn(ctx: TestContext) {
      const path = "file with spaces.md";
      const content = "# File With Spaces\n\nThis filename has spaces.";

      await ctx.test.vault.createFile(path, content);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });
      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Spaces in filename synced");
    },
  },

  {
    name: "Sync files with unicode names",
    async fn(ctx: TestContext) {
      const files = [
        { path: "日本語ファイル.md", content: "# Japanese filename" },
        { path: "中文文件.md", content: "# Chinese filename" },
        { path: "한국어파일.md", content: "# Korean filename" },
        { path: "αβγδ-greek.md", content: "# Greek letters" },
      ];

      for (const file of files) {
        await ctx.test.vault.createFile(file.path, file.content);
      }
      console.log(`  Created ${files.length} unicode-named files`);

      for (const file of files) {
        await ctx.test2.sync.waitForFile(file.path, { timeoutMs: 30000 });
        await assertFileContent(ctx.test2.vault, file.path, file.content);
      }
      console.log("  All unicode filenames synced");
    },
  },

  {
    name: "Sync files with special characters in names",
    async fn(ctx: TestContext) {
      const files = [
        { path: "file-with-dashes.md", content: "Dashes" },
        { path: "file_with_underscores.md", content: "Underscores" },
        { path: "file.multiple.dots.md", content: "Multiple dots" },
        { path: "file (with parens).md", content: "Parentheses" },
        { path: "file [with brackets].md", content: "Brackets" },
      ];

      for (const file of files) {
        await ctx.test2.vault.createFile(file.path, file.content);
      }

      for (const file of files) {
        await ctx.test.sync.waitForFile(file.path, { timeoutMs: 30000 });
      }
      console.log("  Special character filenames synced");
    },
  },

  {
    name: "Sync edge-cases fixtures",
    async fn(ctx: TestContext) {
      const count = await loadFixturesByName(ctx.test.vault, "edge-cases");
      console.log(`  Loaded ${count} edge-case fixtures`);

      // Wait for deep file
      await ctx.test2.sync.waitForFile(
        "deep/nested/folder/structure/file.md",
        { timeoutMs: 60000 }
      );
      console.log("  Edge-case fixtures synced");
    },
  },

  {
    name: "Sync empty file",
    async fn(ctx: TestContext) {
      const path = "empty-file.md";

      await ctx.test.vault.createFile(path, "");
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });

      const content = await ctx.test2.vault.readFile(path);
      assert(content === "", `Expected empty file, got: "${content}"`);
      console.log("  Empty file synced");
    },
  },

  {
    name: "Sync file with only whitespace",
    async fn(ctx: TestContext) {
      const path = "whitespace-only.md";
      const content = "   \n\n\t\t\n   ";

      await ctx.test2.vault.createFile(path, content);
      await ctx.test.sync.waitForFile(path, { timeoutMs: 30000 });
      await assertFileContent(ctx.test.vault, path, content);
      console.log("  Whitespace-only file synced");
    },
  },

  {
    name: "Sync file with unicode content",
    async fn(ctx: TestContext) {
      const path = "unicode-content.md";
      const content = `# Unicode Content Test

Emoji: 🎉 🚀 💡 ✨ 🔥

Japanese: こんにちは世界
Chinese: 你好世界
Korean: 안녕하세요
Arabic: مرحبا بالعالم
Hebrew: שלום עולם
Greek: Γειά σου Κόσμε
Russian: Привет мир

Math: ∑ ∏ ∫ √ ∞ ≠ ≈

Symbols: © ® ™ § ¶ † ‡ • ◦`;

      await ctx.test.vault.createFile(path, content);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });
      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Unicode content synced correctly");
    },
  },

  {
    name: "Sync file with very long lines",
    async fn(ctx: TestContext) {
      const path = "long-lines.md";
      const longLine = "x".repeat(5000);
      const content = `# Long Lines\n\n${longLine}\n\nEnd.`;

      await ctx.test.vault.createFile(path, content);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 30000 });
      await assertFileContent(ctx.test2.vault, path, content);
      console.log("  Long lines synced");
    },
  },

  {
    name: "Sync file with many short lines",
    async fn(ctx: TestContext) {
      const path = "many-lines.md";
      const lines = Array(1000)
        .fill(null)
        .map((_, i) => `Line ${i + 1}`);
      const content = lines.join("\n");

      await ctx.test2.vault.createFile(path, content);
      await ctx.test.sync.waitForFile(path, { timeoutMs: 30000 });

      const synced = await ctx.test.vault.readFile(path);
      assert(
        synced.split("\n").length === 1000,
        `Expected 1000 lines, got ${synced.split("\n").length}`
      );
      console.log("  Many lines synced");
    },
  },

  {
    name: "Sync deeply nested folder path",
    async fn(ctx: TestContext) {
      const depth = 10;
      let path = "very";
      for (let i = 1; i <= depth; i++) {
        path += `/deep/level-${i}`;
      }
      path += "/file.md";

      await ctx.test.vault.createFile(path, `# Depth ${depth}`);
      await ctx.test2.sync.waitForFile(path, { timeoutMs: 60000 });
      console.log(`  ${depth}-level deep path synced`);
    },
  },

  {
    name: "CRDT versions converge after edge cases",
    async fn(ctx: TestContext) {
      await ctx.waitForConvergence(60000);
      console.log("  CRDT versions converged");
    },
  },
];
