/**
 * Fixtures Loader
 *
 * Loads and manages test fixtures from the fixtures directory.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import type { VaultController } from "./vault-controller";

// Resolve fixtures path relative to this file
const FIXTURES_DIR = join(dirname(import.meta.dir), "fixtures");

/** Fixture file data */
export interface FixtureFile {
  path: string; // Relative path within vault
  content: string | Uint8Array;
  isBinary: boolean;
}

/** Fixture set */
export interface FixtureSet {
  name: string;
  files: FixtureFile[];
}

// Binary file extensions
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
]);

/**
 * Load all files from a directory recursively.
 */
async function loadDirectory(
  dirPath: string,
  basePath: string = ""
): Promise<FixtureFile[]> {
  const files: FixtureFile[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const subFiles = await loadDirectory(fullPath, relativePath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      const isBinary = BINARY_EXTENSIONS.has(ext);

      const content = isBinary
        ? new Uint8Array(await readFile(fullPath))
        : await readFile(fullPath, "utf-8");

      files.push({
        path: relativePath,
        content,
        isBinary,
      });
    }
  }

  return files;
}

/**
 * Load a fixture set by name.
 */
export async function loadFixtureSet(name: string): Promise<FixtureSet> {
  const fixturePath = join(FIXTURES_DIR, name);
  const files = await loadDirectory(fixturePath);

  return {
    name,
    files,
  };
}

/**
 * Load all available fixture sets.
 */
export async function loadAllFixtureSets(): Promise<FixtureSet[]> {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const sets: FixtureSet[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const set = await loadFixtureSet(entry.name);
      sets.push(set);
    }
  }

  return sets;
}

/**
 * Load fixtures into a vault.
 *
 * @param overwrite - If true, overwrites existing files. Defaults to true.
 */
export async function loadFixturesIntoVault(
  vault: VaultController,
  fixtureSet: FixtureSet,
  overwrite = true
): Promise<number> {
  let loaded = 0;

  for (const file of fixtureSet.files) {
    await vault.createFile(file.path, file.content, overwrite);
    loaded++;
  }

  return loaded;
}

/**
 * Load fixtures into a vault by set name.
 */
export async function loadFixturesByName(
  vault: VaultController,
  setName: string
): Promise<number> {
  const set = await loadFixtureSet(setName);
  return loadFixturesIntoVault(vault, set);
}

// ============ Predefined fixtures ============

/**
 * Create a simple markdown file.
 */
export function createMarkdownFixture(
  filename: string,
  content: string
): FixtureFile {
  return {
    path: filename,
    content,
    isBinary: false,
  };
}

/**
 * Create a markdown file with frontmatter.
 */
export function createMarkdownWithFrontmatter(
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string
): FixtureFile {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");

  const content = `---\n${yaml}\n---\n\n${body}`;

  return {
    path: filename,
    content,
    isBinary: false,
  };
}

/**
 * Generate a large file with specified size.
 */
export function createLargeFile(
  filename: string,
  sizeKB: number
): FixtureFile {
  const line = "This is a line of text for testing large file sync. ".repeat(2);
  const linesNeeded = Math.ceil((sizeKB * 1024) / line.length);
  const content = Array(linesNeeded).fill(line).join("\n");

  return {
    path: filename,
    content: content.slice(0, sizeKB * 1024),
    isBinary: false,
  };
}

/**
 * Generate test files with unicode names.
 */
export function createUnicodeFixtures(): FixtureFile[] {
  return [
    createMarkdownFixture("unicode-日本語.md", "# Japanese filename test\n\nContent here."),
    createMarkdownFixture("unicode-中文.md", "# Chinese filename test\n\nContent here."),
    createMarkdownFixture("unicode-한국어.md", "# Korean filename test\n\nContent here."),
    createMarkdownFixture("unicode-emoji-🎉.md", "# Emoji filename test\n\nContent here."),
    createMarkdownFixture("unicode-symbols-αβγ.md", "# Greek symbols test\n\nContent here."),
  ];
}

/**
 * Generate deeply nested directory structure.
 */
export function createDeepNestingFixtures(depth: number = 10): FixtureFile[] {
  const files: FixtureFile[] = [];
  let path = "";

  for (let i = 1; i <= depth; i++) {
    path = path ? `${path}/level-${i}` : `level-${i}`;
    files.push(
      createMarkdownFixture(`${path}/file.md`, `# Level ${i}\n\nNested ${i} levels deep.`)
    );
  }

  return files;
}

/**
 * Generate files with special characters in names.
 */
export function createSpecialCharFixtures(): FixtureFile[] {
  return [
    createMarkdownFixture("file with spaces.md", "# Spaces in filename"),
    createMarkdownFixture("file-with-dashes.md", "# Dashes in filename"),
    createMarkdownFixture("file_with_underscores.md", "# Underscores in filename"),
    createMarkdownFixture("file.multiple.dots.md", "# Multiple dots in filename"),
    createMarkdownFixture("file (with parens).md", "# Parentheses in filename"),
    createMarkdownFixture("file [with brackets].md", "# Brackets in filename"),
    createMarkdownFixture("file {with braces}.md", "# Braces in filename"),
  ];
}

/**
 * Generate a standard test set with various file types.
 */
export function createStandardTestSet(): FixtureFile[] {
  return [
    // Basic files
    createMarkdownFixture("test-1.md", "# Test File 1\n\nSimple content."),
    createMarkdownFixture("test-2.md", "# Test File 2\n\nMore content here."),
    createMarkdownFixture("test-3.md", "# Test File 3\n\nEven more content."),

    // With frontmatter
    createMarkdownWithFrontmatter(
      "with-frontmatter.md",
      { title: "Frontmatter Test", tags: ["test", "sync"], date: "2024-01-15" },
      "# Frontmatter Test\n\nThis file has YAML frontmatter."
    ),

    // With internal links
    createMarkdownFixture(
      "with-links.md",
      "# Links Test\n\nThis links to [[test-1]] and [[test-2]].\n\nAlso [[test-3|with alias]]."
    ),

    // With embeds
    createMarkdownFixture(
      "with-embeds.md",
      "# Embeds Test\n\nEmbedding another note:\n\n![[test-1]]\n\nDone."
    ),

    // In folder
    createMarkdownFixture(
      "folder/nested-file.md",
      "# Nested File\n\nThis is inside a folder."
    ),

    // Deep folder
    createMarkdownFixture(
      "folder/subfolder/deep-file.md",
      "# Deep File\n\nThis is two levels deep."
    ),
  ];
}

/**
 * Load fixtures inline (without filesystem).
 *
 * @param overwrite - If true, overwrites existing files. Defaults to true.
 */
export async function loadInlineFixtures(
  vault: VaultController,
  fixtures: FixtureFile[],
  overwrite = true
): Promise<number> {
  for (const fixture of fixtures) {
    await vault.createFile(fixture.path, fixture.content, overwrite);
  }
  return fixtures.length;
}
