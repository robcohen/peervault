/**
 * Isolation Manager
 *
 * Manages test isolation by capturing and restoring vault state between tests.
 * Provides automatic cleanup of test files to prevent cross-test contamination.
 */

import type { TestContext, VaultContext } from "./context";

/** File state snapshot for a vault */
interface VaultFileSnapshot {
  files: Set<string>;
  capturedAt: number;
}

/** Full state snapshot */
export interface IsolationSnapshot {
  test: VaultFileSnapshot;
  test2: VaultFileSnapshot;
  test3?: VaultFileSnapshot;
}

/** Common test file patterns to clean up */
const DEFAULT_CLEANUP_PATTERNS: RegExp[] = [
  /^sync-test-\d+\.md$/,
  /^frontmatter-test\.md$/,
  /^links-test\.md$/,
  /^batch\//,
  /^rapid-modify\.md$/,
  /^append-test\.md$/,
  /^prepend-test\.md$/,
  /^large-modify\.md$/,
  /^recreate-test\.md$/,
  /^rename-test.*\.md$/,
  /^move-test\.md$/,
  /^concurrent-.*\.md$/,
  /^same-name-.*\.md$/,
  /^edit-delete-.*\.md$/,
  /^source-folder\//,
  /^moved-folder\//,
  /^folder-a\//,
  /^folder-b\//,
  /^nested-file.*\.md$/,
  /^rename-modify.*\.md$/,
  /^folder\//,
  /^deep-nest\//,
  /^stress\//,
  /^test-\d+\.md$/,
  /^test-image\.png$/,
  /^inline-binary\.png$/,
  /^pre-reload\.md$/,
  /^post-reload\.md$/,
  /^after-both-reload\.md$/,
  /^during-disconnect\.md$/,
  /^during-disconnect-2\.md$/,
  /^special-chars.*\.md$/,
  /^unicode-.*\.md$/,
  /^empty-file\.md$/,
  /^whitespace-.*\.md$/,
  /^mesh-test-.*\.md$/,
];

/**
 * IsolationManager manages test isolation.
 *
 * Features:
 * - Capture file state before tests
 * - Restore file state after tests (remove created files)
 * - Clean up known test file patterns
 * - Track files across test boundaries
 */
export class IsolationManager {
  private baselineSnapshot: IsolationSnapshot | null = null;
  private testSnapshot: IsolationSnapshot | null = null;
  private cleanupPatterns: RegExp[] = DEFAULT_CLEANUP_PATTERNS;

  /**
   * Capture the baseline file state.
   * Call this once at the start of a test suite.
   */
  async captureBaseline(ctx: TestContext): Promise<void> {
    this.baselineSnapshot = await this.captureSnapshot(ctx);
  }

  /**
   * Capture state before a test runs.
   */
  async captureBeforeTest(ctx: TestContext): Promise<void> {
    this.testSnapshot = await this.captureSnapshot(ctx);
  }

  /**
   * Clean up files created during a test.
   * Removes any files that weren't present in the pre-test snapshot.
   */
  async cleanupAfterTest(ctx: TestContext): Promise<{ cleaned: number }> {
    if (!this.testSnapshot) {
      return { cleaned: 0 };
    }

    let cleaned = 0;

    // Get current files
    const currentFiles = await this.getVaultFiles(ctx);

    // Find and delete files created during the test
    const vaults: Array<{
      context: VaultContext;
      before: Set<string>;
      current: string[];
    }> = [
      {
        context: ctx.test,
        before: this.testSnapshot.test.files,
        current: currentFiles.test,
      },
      {
        context: ctx.test2,
        before: this.testSnapshot.test2.files,
        current: currentFiles.test2,
      },
    ];

    if (ctx.test3 && this.testSnapshot.test3) {
      vaults.push({
        context: ctx.test3,
        before: this.testSnapshot.test3.files,
        current: currentFiles.test3 || [],
      });
    }

    for (const { context, before, current } of vaults) {
      for (const file of current) {
        // Delete if file was created during test (not in pre-test snapshot)
        if (!before.has(file)) {
          try {
            await context.vault.deleteFile(file);
            cleaned++;
          } catch {
            // File may already be deleted or inaccessible
          }
        }
      }
    }

    return { cleaned };
  }

  /**
   * Clean up files matching known test patterns.
   * More aggressive cleanup for use between test suites.
   */
  async cleanupPatternMatches(ctx: TestContext): Promise<{ cleaned: number }> {
    let cleaned = 0;

    const currentFiles = await this.getVaultFiles(ctx);

    const vaults: Array<{ context: VaultContext; files: string[] }> = [
      { context: ctx.test, files: currentFiles.test },
      { context: ctx.test2, files: currentFiles.test2 },
    ];

    if (ctx.test3) {
      vaults.push({ context: ctx.test3, files: currentFiles.test3 || [] });
    }

    for (const { context, files } of vaults) {
      for (const file of files) {
        if (this.matchesCleanupPattern(file)) {
          try {
            await context.vault.deleteFile(file);
            cleaned++;
          } catch {
            // Ignore deletion errors
          }
        }
      }
    }

    return { cleaned };
  }

  /**
   * Restore to baseline state.
   * Removes all files not present in the baseline snapshot.
   */
  async restoreToBaseline(ctx: TestContext): Promise<{ removed: number }> {
    if (!this.baselineSnapshot) {
      return { removed: 0 };
    }

    let removed = 0;

    const currentFiles = await this.getVaultFiles(ctx);

    const vaults: Array<{
      context: VaultContext;
      baseline: Set<string>;
      current: string[];
    }> = [
      {
        context: ctx.test,
        baseline: this.baselineSnapshot.test.files,
        current: currentFiles.test,
      },
      {
        context: ctx.test2,
        baseline: this.baselineSnapshot.test2.files,
        current: currentFiles.test2,
      },
    ];

    if (ctx.test3 && this.baselineSnapshot.test3) {
      vaults.push({
        context: ctx.test3,
        baseline: this.baselineSnapshot.test3.files,
        current: currentFiles.test3 || [],
      });
    }

    for (const { context, baseline, current } of vaults) {
      for (const file of current) {
        if (!baseline.has(file)) {
          try {
            await context.vault.deleteFile(file);
            removed++;
          } catch {
            // Ignore deletion errors
          }
        }
      }
    }

    return { removed };
  }

  /**
   * Add custom cleanup patterns.
   */
  addCleanupPatterns(patterns: RegExp[]): void {
    this.cleanupPatterns = [...this.cleanupPatterns, ...patterns];
  }

  /**
   * Check if a file matches any cleanup pattern.
   */
  private matchesCleanupPattern(file: string): boolean {
    return this.cleanupPatterns.some((pattern) => pattern.test(file));
  }

  /**
   * Capture current file state snapshot.
   */
  private async captureSnapshot(ctx: TestContext): Promise<IsolationSnapshot> {
    const currentFiles = await this.getVaultFiles(ctx);

    const snapshot: IsolationSnapshot = {
      test: {
        files: new Set(currentFiles.test),
        capturedAt: Date.now(),
      },
      test2: {
        files: new Set(currentFiles.test2),
        capturedAt: Date.now(),
      },
    };

    if (ctx.test3) {
      snapshot.test3 = {
        files: new Set(currentFiles.test3 || []),
        capturedAt: Date.now(),
      };
    }

    return snapshot;
  }

  /**
   * Get current vault files.
   */
  private async getVaultFiles(
    ctx: TestContext
  ): Promise<{ test: string[]; test2: string[]; test3?: string[] }> {
    const [testFiles, test2Files] = await Promise.all([
      ctx.test.vault.listFiles(),
      ctx.test2.vault.listFiles(),
    ]);

    const result: { test: string[]; test2: string[]; test3?: string[] } = {
      test: testFiles,
      test2: test2Files,
    };

    if (ctx.test3) {
      result.test3 = await ctx.test3.vault.listFiles();
    }

    return result;
  }
}

/**
 * Create a new isolation manager with default settings.
 */
export function createIsolationManager(): IsolationManager {
  return new IsolationManager();
}
