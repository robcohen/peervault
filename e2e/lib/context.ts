/**
 * Test Context
 *
 * Factory for creating test context with all managers and utilities.
 * Simplified for the new WASM-based plugin architecture.
 */

import { config } from "../config";
import { CDPClient } from "./cdp-client";
import { waitForVaults, type VaultPage } from "./cdp-discovery";
import { VaultController } from "./vault-controller";
import { PluginAPI } from "./plugin-api";
import { PluginLifecycleManager } from "./plugin-lifecycle";
import { StateManager } from "./state-manager";
import { SyncWaiter, waitForFileListConvergence } from "./sync-waiter";

/** Test vault context */
export interface VaultContext {
  name: string;
  page: VaultPage;
  client: CDPClient;
  vault: VaultController;
  plugin: PluginAPI;
  lifecycle: PluginLifecycleManager;
  state: StateManager;
  sync: SyncWaiter;
}

/** Options for creating test context */
export interface CreateTestContextOptions {
  /** Include TEST3 vault (for 3-way sync tests) */
  includeTest3?: boolean;
}

/** Full test context with vaults */
export interface TestContext {
  test: VaultContext;
  test2: VaultContext;
  /** Third vault for 3-way sync tests (optional) */
  test3?: VaultContext;

  // Convenience references
  vaults: {
    test: VaultContext;
    test2: VaultContext;
    test3?: VaultContext;
  };

  // Cross-vault utilities
  waitForConvergence: (timeoutMs?: number) => Promise<void>;
  waitForFileListMatch: (timeoutMs?: number) => Promise<void>;

  // Cleanup
  cleanupBetweenTests: () => void;
  resetFiles: () => Promise<void>;
  resetAll: () => Promise<void>;
  close: () => Promise<void>;
}

/** Test result */
export interface TestResult {
  name: string;
  suite: string;
  passed: boolean;
  skipped?: boolean;
  error?: Error;
  duration: number;
  retriesAttempted?: number;
  passedAfterRetry?: boolean;
}

/** Test suite result */
export interface SuiteResult {
  name: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  duration: number;
}

/**
 * Create test context for vaults.
 */
export async function createTestContext(options?: CreateTestContextOptions): Promise<TestContext> {
  const includeTest3 = options?.includeTest3 ?? false;

  console.log(`Discovering vaults... (includeTest3: ${includeTest3})`);

  // Wait for vaults to be available
  const vaultNames = [config.vaults.TEST.name, config.vaults.TEST2.name];
  if (includeTest3 && config.vaults.TEST3) {
    vaultNames.push(config.vaults.TEST3.name);
  }

  const pages = await waitForVaults(vaultNames, {
    port: config.cdp.port,
    timeoutMs: 30000,
  });

  const testPage = pages.get(config.vaults.TEST.name)!;
  const test2Page = pages.get(config.vaults.TEST2.name)!;
  const test3Page = includeTest3 && config.vaults.TEST3 ? pages.get(config.vaults.TEST3.name) : undefined;

  console.log(`Found vault: ${testPage.name} (${testPage.id})`);
  console.log(`Found vault: ${test2Page.name} (${test2Page.id})`);
  if (test3Page) {
    console.log(`Found vault: ${test3Page.name} (${test3Page.id})`);
  }

  // Create CDP clients
  console.log("Connecting to vaults via CDP...");

  const testClient = new CDPClient(testPage.wsUrl, {
    connectionTimeout: config.cdp.connectionTimeout,
    evaluateTimeout: config.cdp.evaluateTimeout,
  });

  const test2Client = new CDPClient(test2Page.wsUrl, {
    connectionTimeout: config.cdp.connectionTimeout,
    evaluateTimeout: config.cdp.evaluateTimeout,
  });

  const test3Client = test3Page ? new CDPClient(test3Page.wsUrl, {
    connectionTimeout: config.cdp.connectionTimeout,
    evaluateTimeout: config.cdp.evaluateTimeout,
  }) : undefined;

  const connectPromises = [testClient.connect(), test2Client.connect()];
  if (test3Client) {
    connectPromises.push(test3Client.connect());
  }
  await Promise.all(connectPromises);

  // Enable console capture for debugging
  const enablePromises = [testClient.enableConsole(), test2Client.enableConsole()];
  if (test3Client) {
    enablePromises.push(test3Client.enableConsole());
  }
  await Promise.all(enablePromises);

  console.log(`Connected to ${includeTest3 ? "all three" : "both"} vaults`);

  // Create vault contexts
  const testContext = createVaultContext(testPage, testClient);
  const test2Context = createVaultContext(test2Page, test2Client);
  const test3Context = test3Page && test3Client ? createVaultContext(test3Page, test3Client) : undefined;

  // Create full context
  const context: TestContext = {
    test: testContext,
    test2: test2Context,
    test3: test3Context,
    vaults: {
      test: testContext,
      test2: test2Context,
      test3: test3Context,
    },
    waitForConvergence: async (timeoutMs?: number) => {
      // Wait for file lists to converge
      await waitForFileListConvergence(testContext.sync, test2Context.sync, {
        timeoutMs: timeoutMs ?? config.sync.defaultTimeout,
      });
      // Brief delay for filesystem sync
      await new Promise(r => setTimeout(r, 500));
    },
    waitForFileListMatch: async (timeoutMs?: number) => {
      await waitForFileListConvergence(testContext.sync, test2Context.sync, {
        timeoutMs: timeoutMs ?? config.sync.defaultTimeout,
      });
    },
    cleanupBetweenTests: () => {
      // Clear console message buffers to prevent memory buildup
      testClient.clearConsoleMessages();
      test2Client.clearConsoleMessages();
      if (test3Client) {
        test3Client.clearConsoleMessages();
      }
    },
    resetFiles: async () => {
      // Delete all files but keep peer connections
      const resetPromises = [
        testContext.state.resetVaultFiles(),
        test2Context.state.resetVaultFiles(),
      ];
      if (test3Context) {
        resetPromises.push(test3Context.state.resetVaultFiles());
      }
      await Promise.all(resetPromises);
    },
    resetAll: async () => {
      // Full reset - clears peers, CRDT state, and files
      const resetPromises = [
        testContext.state.resetAll(),
        test2Context.state.resetAll(),
      ];
      if (test3Context) {
        resetPromises.push(test3Context.state.resetAll());
      }
      await Promise.all(resetPromises);
    },
    close: async () => {
      const closePromises = [testClient.close(), test2Client.close()];
      if (test3Client) {
        closePromises.push(test3Client.close());
      }
      await Promise.all(closePromises);
    },
  };

  return context;
}

/**
 * Create context for a single vault.
 */
function createVaultContext(page: VaultPage, client: CDPClient): VaultContext {
  return {
    name: page.name,
    page,
    client,
    vault: new VaultController(client, page.name),
    plugin: new PluginAPI(client, page.name),
    lifecycle: new PluginLifecycleManager(client, page.name),
    state: new StateManager(client, page.name),
    sync: new SyncWaiter(client, page.name),
  };
}

/**
 * Test reporter for tracking results.
 */
export class TestReporter {
  private suites: SuiteResult[] = [];
  private currentSuite: SuiteResult | null = null;

  startSuite(name: string): void {
    this.currentSuite = {
      name,
      tests: [],
      passed: 0,
      failed: 0,
      duration: 0,
    };
  }

  endSuite(): SuiteResult | null {
    if (!this.currentSuite) return null;

    this.currentSuite.passed = this.currentSuite.tests.filter(
      (t) => t.passed
    ).length;
    this.currentSuite.failed = this.currentSuite.tests.filter(
      (t) => !t.passed
    ).length;
    this.currentSuite.duration = this.currentSuite.tests.reduce(
      (sum, t) => sum + t.duration,
      0
    );

    this.suites.push(this.currentSuite);
    const result = this.currentSuite;
    this.currentSuite = null;
    return result;
  }

  addTest(result: TestResult): void {
    if (this.currentSuite) {
      this.currentSuite.tests.push(result);
    }

    const status = result.passed ? "✓" : "✗";
    const duration = `(${result.duration}ms)`;

    let retryInfo = "";
    if (result.passedAfterRetry && result.retriesAttempted) {
      retryInfo = ` [passed after ${result.retriesAttempted} retry${result.retriesAttempted > 1 ? "ies" : ""}]`;
    } else if (!result.passed && result.retriesAttempted) {
      retryInfo = ` [failed after ${result.retriesAttempted} retry${result.retriesAttempted > 1 ? "ies" : ""}]`;
    }

    const message = result.passed
      ? `${status} ${result.name} ${duration}${retryInfo}`
      : `${status} ${result.name} ${duration}${retryInfo}\n    Error: ${result.error?.message}`;

    console.log(message);
  }

  printSummary(): void {
    console.log("\n" + "=".repeat(60));
    console.log("TEST SUMMARY");
    console.log("=".repeat(60));

    let totalPassed = 0;
    let totalFailed = 0;
    let totalDuration = 0;

    for (const suite of this.suites) {
      const status = suite.failed === 0 ? "✓" : "✗";
      console.log(
        `\n${status} ${suite.name}: ${suite.passed}/${suite.tests.length} passed (${suite.duration}ms)`
      );

      const failed = suite.tests.filter((t) => !t.passed);
      for (const test of failed) {
        console.log(`    ✗ ${test.name}: ${test.error?.message}`);
      }

      totalPassed += suite.passed;
      totalFailed += suite.failed;
      totalDuration += suite.duration;
    }

    console.log("\n" + "-".repeat(60));
    console.log(
      `Total: ${totalPassed}/${totalPassed + totalFailed} passed (${totalDuration}ms)`
    );

    if (totalFailed > 0) {
      console.log(`\n${totalFailed} test(s) failed`);
    } else {
      console.log(`\nAll tests passed!`);
    }
  }

  getTotals(): { passed: number; failed: number; duration: number } {
    let totalPassed = 0;
    let totalFailed = 0;
    let totalDuration = 0;

    for (const suite of this.suites) {
      totalPassed += suite.passed;
      totalFailed += suite.failed;
      totalDuration += suite.duration;
    }

    return { passed: totalPassed, failed: totalFailed, duration: totalDuration };
  }

  hasFailures(): boolean {
    return this.suites.some((s) => s.failed > 0);
  }
}

/**
 * Capture debug output on test failure.
 */
async function captureDebugOutput(
  ctx: TestContext | undefined,
  testName: string,
  suiteName: string,
  error: Error
): Promise<string | undefined> {
  if (!ctx) return undefined;

  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = testName.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
    const debugDir = `e2e/debug-output/${suiteName}-${safeName}-${timestamp}`;

    mkdirSync(debugDir, { recursive: true });

    // Capture error details
    writeFileSync(`${debugDir}/error.txt`, `Test: ${testName}\nSuite: ${suiteName}\n\nError: ${error.message}\n\nStack:\n${error.stack}`);

    // Capture diagnostics from vaults
    try {
      const diag1 = await ctx.test.plugin.getDiagnostics();
      const diag2 = await ctx.test2.plugin.getDiagnostics();
      const diag3 = ctx.test3 ? await ctx.test3.plugin.getDiagnostics() : undefined;
      const diagData: Record<string, unknown> = { TEST: diag1, TEST2: diag2 };
      if (diag3 !== undefined) diagData.TEST3 = diag3;
      writeFileSync(`${debugDir}/diagnostics.json`, JSON.stringify(diagData, null, 2));
    } catch { /* ignore */ }

    // Capture CRDT file lists
    try {
      const files1 = await ctx.test.plugin.listFiles();
      const files2 = await ctx.test2.plugin.listFiles();
      const files3 = ctx.test3 ? await ctx.test3.plugin.listFiles() : undefined;
      const filesData: Record<string, unknown> = { TEST: files1, TEST2: files2 };
      if (files3 !== undefined) filesData.TEST3 = files3;
      writeFileSync(`${debugDir}/crdt-files.json`, JSON.stringify(filesData, null, 2));
    } catch { /* ignore */ }

    // Capture vault file lists
    try {
      const vaultFiles1 = await ctx.test.vault.listFiles();
      const vaultFiles2 = await ctx.test2.vault.listFiles();
      const vaultFiles3 = ctx.test3 ? await ctx.test3.vault.listFiles() : undefined;
      const vaultFilesData: Record<string, unknown> = { TEST: vaultFiles1, TEST2: vaultFiles2 };
      if (vaultFiles3 !== undefined) vaultFilesData.TEST3 = vaultFiles3;
      writeFileSync(`${debugDir}/vault-files.json`, JSON.stringify(vaultFilesData, null, 2));
    } catch { /* ignore */ }

    // Capture all console logs from both vaults
    try {
      // Get all messages, then filter for relevant ones
      const allLogs1 = ctx.test.client.getConsoleMessages();
      const allLogs2 = ctx.test2.client.getConsoleMessages();
      // Filter to PeerVault and WASM related logs
      const relevant1 = allLogs1.filter(m =>
        m.text.includes("PeerVault") || m.text.includes("WASM") || m.text.includes("[sync")
      );
      const relevant2 = allLogs2.filter(m =>
        m.text.includes("PeerVault") || m.text.includes("WASM") || m.text.includes("[sync")
      );
      console.log(`  [Debug] Total console msgs: TEST=${allLogs1.length}, TEST2=${allLogs2.length}`);
      console.log(`  [Debug] Relevant console logs: TEST=${relevant1.length}, TEST2=${relevant2.length}`);
      const logsData: Record<string, unknown> = {
        total: { TEST: allLogs1.length, TEST2: allLogs2.length },
        TEST: relevant1.map(m => `[${m.type}] ${m.text}`),
        TEST2: relevant2.map(m => `[${m.type}] ${m.text}`)
      };
      writeFileSync(`${debugDir}/console-logs.json`, JSON.stringify(logsData, null, 2));
    } catch (e) {
      console.error(`  [Debug] Failed to capture console logs: ${e}`);
    }

    return debugDir;
  } catch (e) {
    console.error("  Failed to capture debug output:", e);
    return undefined;
  }
}

/**
 * Run a test function and capture result.
 */
export async function runTest(
  name: string,
  suite: string,
  fn: () => Promise<void>,
  ctx?: TestContext
): Promise<TestResult> {
  const startTime = Date.now();

  try {
    await fn();
    return {
      name,
      suite,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Capture debug output on failure
    const debugDir = await captureDebugOutput(ctx, name, suite, err);
    if (debugDir) {
      console.log(`  Debug output saved to: ${debugDir}`);
    }

    return {
      name,
      suite,
      passed: false,
      error: err,
      duration: Date.now() - startTime,
    };
  }
}
