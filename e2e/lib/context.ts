/**
 * Test Context
 *
 * Factory for creating test context with all managers and utilities.
 * Provides a unified interface for test suites.
 */

import { config } from "../config";
import { CDPClient } from "./cdp-client";
import { discoverVaults, waitForVaults, type VaultPage } from "./cdp-discovery";
import { VaultController } from "./vault-controller";
import { PluginAPI } from "./plugin-api";
import { PluginLifecycleManager } from "./plugin-lifecycle";
import { BRATManager } from "./brat";
import { StateManager } from "./state-manager";
import { SyncWaiter, waitForVersionConvergence, waitForFileListConvergence } from "./sync-waiter";

/** Test vault context */
export interface VaultContext {
  name: string;
  page: VaultPage;
  client: CDPClient;
  vault: VaultController;
  plugin: PluginAPI;
  lifecycle: PluginLifecycleManager;
  brat: BRATManager;
  state: StateManager;
  sync: SyncWaiter;
}

/** Full test context with both vaults */
export interface TestContext {
  test: VaultContext;
  test2: VaultContext;

  // Convenience references
  vaults: {
    test: VaultContext;
    test2: VaultContext;
  };

  // Cross-vault utilities
  waitForConvergence: (timeoutMs?: number) => Promise<void>;
  waitForFileListMatch: (timeoutMs?: number) => Promise<void>;

  // Cleanup
  /**
   * Clean up state between tests.
   * Clears console messages to avoid memory buildup.
   */
  cleanupBetweenTests: () => void;

  /**
   * Reset files in both vaults (keeps peer connections).
   * Use between tests that need a clean file state but maintain pairing.
   */
  resetFiles: () => Promise<void>;

  /**
   * Full state reset in both vaults (clears peers, files, CRDT).
   * Use between test suites or when starting fresh.
   */
  resetAll: () => Promise<void>;

  /**
   * Close all connections (call at end of test run).
   */
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
 * Create test context for both vaults.
 */
export async function createTestContext(): Promise<TestContext> {
  console.log("Discovering vaults...");

  // Wait for both vaults to be available
  const vaultNames = [config.vaults.TEST.name, config.vaults.TEST2.name];
  const pages = await waitForVaults(vaultNames, {
    port: config.cdp.port,
    timeoutMs: 30000,
  });

  const testPage = pages.get(config.vaults.TEST.name)!;
  const test2Page = pages.get(config.vaults.TEST2.name)!;

  console.log(`Found vault: ${testPage.name} (${testPage.id})`);
  console.log(`Found vault: ${test2Page.name} (${test2Page.id})`);

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

  await Promise.all([testClient.connect(), test2Client.connect()]);

  console.log("Connected to both vaults");

  // Create vault contexts
  const testContext = createVaultContext(testPage, testClient);
  const test2Context = createVaultContext(test2Page, test2Client);

  // Enable auto-accept for vault adoption requests on both vaults
  // This handles the "Join Sync Network?" modal that appears on first pairing
  console.log("Enabling auto-accept for vault adoption...");
  await Promise.all([
    testContext.plugin.enableAutoAcceptVaultAdoption(),
    test2Context.plugin.enableAutoAcceptVaultAdoption(),
  ]);
  console.log("Auto-accept enabled on both vaults");

  // Create full context
  const context: TestContext = {
    test: testContext,
    test2: test2Context,
    vaults: {
      test: testContext,
      test2: test2Context,
    },
    waitForConvergence: async (timeoutMs?: number) => {
      await waitForVersionConvergence(testContext.sync, test2Context.sync, {
        timeoutMs: timeoutMs ?? config.sync.defaultTimeout,
      });
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
    },
    resetFiles: async () => {
      // Delete all files but keep peer connections
      await Promise.all([
        testContext.state.resetVaultFiles(),
        test2Context.state.resetVaultFiles(),
      ]);
    },
    resetAll: async () => {
      // Full reset - clears peers, CRDT state, and files
      await Promise.all([
        testContext.state.resetAll(),
        test2Context.state.resetAll(),
      ]);
    },
    close: async () => {
      await Promise.all([testClient.close(), test2Client.close()]);
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
    brat: new BRATManager(client, page.name),
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

    // Calculate totals
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

    // Log result
    const status = result.passed ? "✓" : "✗";
    const duration = `(${result.duration}ms)`;
    const message = result.passed
      ? `${status} ${result.name} ${duration}`
      : `${status} ${result.name} ${duration}\n    Error: ${result.error?.message}`;

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

      // Show failed tests
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
      console.log(`\n❌ ${totalFailed} test(s) failed`);
    } else {
      console.log(`\n✅ All tests passed!`);
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
 * Run a test function and capture result.
 */
export async function runTest(
  name: string,
  suite: string,
  fn: () => Promise<void>
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
    return {
      name,
      suite,
      passed: false,
      error: error instanceof Error ? error : new Error(String(error)),
      duration: Date.now() - startTime,
    };
  }
}
