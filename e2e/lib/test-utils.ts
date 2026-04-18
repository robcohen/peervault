/**
 * Test Utilities
 *
 * Common test helper functions to reduce boilerplate in test files.
 * These encapsulate frequently used test patterns.
 */

import type { TestContext, VaultContext } from "./context";
import { config } from "../config";

/**
 * Wait for both vaults to have live sync sessions.
 * This is a prerequisite for most sync tests.
 */
export async function waitForLiveSessions(
  ctx: TestContext,
  timeoutMs: number = config.sync.liveSessionTimeout
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    const [sessions1, sessions2] = await Promise.all([
      ctx.test.plugin.getActiveSessions(),
      ctx.test2.plugin.getActiveSessions(),
    ]);

    const hasLive1 = sessions1.some((s) => s.state === "live");
    const hasLive2 = sessions2.some((s) => s.state === "live");

    if (hasLive1 && hasLive2) {
      return;
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // Final check with detailed error
  const [sessions1, sessions2] = await Promise.all([
    ctx.test.plugin.getActiveSessions(),
    ctx.test2.plugin.getActiveSessions(),
  ]);

  const states1 = sessions1.map((s) => s.state).join(", ") || "none";
  const states2 = sessions2.map((s) => s.state).join(", ") || "none";

  throw new Error(
    `Sessions not live after ${timeoutMs}ms. ` +
      `TEST: [${states1}], TEST2: [${states2}]`
  );
}

/**
 * Verify bidirectional sync is working.
 * Creates a file on one vault, verifies it appears on the other, then vice versa.
 * Cleans up test files after verification.
 */
export async function verifyBidirectionalSync(
  ctx: TestContext,
  options: {
    timeoutMs?: number;
    cleanupAfter?: boolean;
  } = {}
): Promise<{ test1ToTest2: number; test2ToTest1: number }> {
  const { timeoutMs = config.sync.defaultTimeout, cleanupAfter = true } =
    options;
  const timestamp = Date.now();

  // Test 1 -> Test 2
  const file1 = `_bidirectional-test-1-${timestamp}.md`;
  const content1 = `Test content from TEST at ${timestamp}`;

  const start1 = Date.now();
  await ctx.test.vault.createFile(file1, content1);
  await ctx.test2.sync.waitForContent(file1, content1, { timeoutMs });
  const test1ToTest2 = Date.now() - start1;

  // Test 2 -> Test 1
  const file2 = `_bidirectional-test-2-${timestamp}.md`;
  const content2 = `Test content from TEST2 at ${timestamp}`;

  const start2 = Date.now();
  await ctx.test2.vault.createFile(file2, content2);
  await ctx.test.sync.waitForContent(file2, content2, { timeoutMs });
  const test2ToTest1 = Date.now() - start2;

  // Cleanup
  if (cleanupAfter) {
    await Promise.all([
      ctx.test.vault.deleteFile(file1).catch(() => {}),
      ctx.test2.vault.deleteFile(file2).catch(() => {}),
    ]);
    // Wait for deletes to sync
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { test1ToTest2, test2ToTest1 };
}

/**
 * Ensure the test context is in a synced state.
 * Verifies peers are connected and sessions are live.
 * Use at the start of tests that depend on sync being operational.
 */
export async function ensureSyncedState(
  ctx: TestContext,
  options: {
    timeoutMs?: number;
    verifyBidirectional?: boolean;
  } = {}
): Promise<void> {
  const { timeoutMs = config.sync.liveSessionTimeout, verifyBidirectional = false } =
    options;

  // Check peer connection
  const [peers1, peers2] = await Promise.all([
    ctx.test.plugin.getPeers(),
    ctx.test2.plugin.getPeers(),
  ]);

  if (peers1.length === 0 || peers2.length === 0) {
    throw new Error(
      `Peers not connected. TEST has ${peers1.length} peers, TEST2 has ${peers2.length}`
    );
  }

  // Wait for live sessions
  await waitForLiveSessions(ctx, timeoutMs);

  // Optionally verify bidirectional sync works
  if (verifyBidirectional) {
    await verifyBidirectionalSync(ctx, { timeoutMs, cleanupAfter: true });
  }
}

/**
 * Create a unique test file with timestamp to avoid collisions.
 * Returns the path and content for verification.
 */
export function createTestFile(
  prefix: string
): { path: string; content: string } {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const path = `${prefix}-${timestamp}-${random}.md`;
  const content = `# Test File\n\nCreated at ${new Date().toISOString()}\nRandom: ${random}`;
  return { path, content };
}

/**
 * Wait for a condition to be true, with polling.
 * More flexible than specific waitFor* methods.
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    description?: string;
  } = {}
): Promise<void> {
  const {
    timeoutMs = config.sync.defaultTimeout,
    pollIntervalMs = 500,
    description = "condition",
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
}

/**
 * Run a function with retry on failure.
 * Useful for operations that may fail transiently.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    delayMs?: number;
    description?: string;
  } = {}
): Promise<T> {
  const { maxRetries = 3, delayMs = 1000, description = "operation" } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw new Error(
    `${description} failed after ${maxRetries + 1} attempts: ${lastError?.message}`
  );
}

/**
 * Measure how long an operation takes.
 * Returns the result and duration.
 */
export async function measureTime<T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

/**
 * Clean up test files that match a pattern.
 * Useful for post-test cleanup.
 */
export async function cleanupTestFiles(
  ctx: TestContext,
  pattern: RegExp
): Promise<number> {
  let cleaned = 0;

  for (const vault of [ctx.test, ctx.test2]) {
    try {
      const files = await vault.vault.listFiles();
      const toDelete = files.filter((f) => pattern.test(f));

      for (const file of toDelete) {
        try {
          await vault.vault.deleteFile(file);
          cleaned++;
        } catch {
          // Ignore deletion errors
        }
      }
    } catch {
      // Ignore list errors
    }
  }

  return cleaned;
}

/**
 * Get a summary of the current sync state for debugging.
 */
export async function getSyncStateSummary(
  ctx: TestContext
): Promise<{
  test: { peers: number; sessions: string[]; files: number };
  test2: { peers: number; sessions: string[]; files: number };
}> {
  const [peers1, peers2, sessions1, sessions2, files1, files2] =
    await Promise.all([
      ctx.test.plugin.getPeers(),
      ctx.test2.plugin.getPeers(),
      ctx.test.plugin.getActiveSessions(),
      ctx.test2.plugin.getActiveSessions(),
      ctx.test.plugin.getCrdtFiles(),
      ctx.test2.plugin.getCrdtFiles(),
    ]);

  return {
    test: {
      peers: peers1.length,
      sessions: sessions1.map((s) => s.state),
      files: files1.length,
    },
    test2: {
      peers: peers2.length,
      sessions: sessions2.map((s) => s.state),
      files: files2.length,
    },
  };
}
