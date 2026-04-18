#!/usr/bin/env bun
/**
 * E2E Test Runner
 *
 * Main orchestrator for running E2E tests against Obsidian vaults.
 * Usage: bun run test:e2e [--suite=<suite-name>] [--verbose] [--restart]
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { config, getConfig, delay } from "./config";
import {
  createTestContext,
  TestReporter,
  runTest,
  type TestContext,
  type TestResult,
} from "./lib/context";
import { printDiscoveredVaults, discoverVaults } from "./lib/cdp-discovery";
import { StateValidator, formatIssues } from "./lib/state-validator";
import { IsolationManager, createIsolationManager } from "./lib/isolation-manager";

// Test suites in execution order
const TEST_SUITES = [
  "00-setup",
  "01-pairing",
  "02-sync-basic",
  "03-sync-advanced",
  "04-conflicts",
  "05-error-recovery",
  "06-edge-cases",
  "07-transport",
  "08-mesh-sync", // Requires 3 vaults (TEST, TEST2, TEST3)
  "09-cloud-sync", // Cloud sync API tests (no S3 bucket required)
  "10-chaos", // Chaos/resilience testing
  "11-mobile", // Mobile-specific tests
  "12-benchmarks", // Performance benchmarks
];

// Suites that require 3-vault context
const THREE_VAULT_SUITES = ["08-mesh-sync"];

/** Test function signature */
type TestFn = (ctx: TestContext) => Promise<void>;

/** Hook function signature */
type HookFn = (ctx: TestContext) => Promise<void>;

/** Test definition */
interface TestDef {
  name: string;
  fn: TestFn;
  skip?: boolean;
  /** If true, this test can run in parallel with other parallel tests */
  parallel?: boolean;
  /** Number of retry attempts for flaky tests (0 = no retries) */
  retryOnFailure?: number;
  /** Tags for filtering tests (e.g., ["smoke", "slow", "protocol"]) */
  tags?: string[];
  /** Run before this specific test */
  beforeEach?: HookFn;
  /** Run after this specific test (success or failure) */
  afterEach?: HookFn;
  /** Skip automatic cleanup for this test (useful for cleanup tests themselves) */
  skipAutoCleanup?: boolean;
}

/** Common test tags */
export const TestTags = {
  SMOKE: "smoke",        // Quick sanity checks
  SLOW: "slow",          // Long-running tests
  PROTOCOL: "protocol",  // Sync protocol tests
  TRANSPORT: "transport", // Transport layer tests
  CONFLICT: "conflict",  // Conflict resolution tests
  RECOVERY: "recovery",  // Error recovery tests
  EDGE_CASE: "edge-case", // Edge case tests
} as const;

/** Test file module */
interface TestModule {
  default?: TestDef[];
  tests?: TestDef[];
}

/** Suite module with hooks */
interface SuiteModule {
  default?: TestDef[];
  tests?: TestDef[];
  /** Run once before all tests in this suite */
  beforeAll?: HookFn;
  /** Run once after all tests in this suite */
  afterAll?: HookFn;
  /** Run before each test in this suite (overridden by test-level beforeEach) */
  beforeEach?: HookFn;
  /** Run after each test in this suite (overridden by test-level afterEach) */
  afterEach?: HookFn;
  /** Enable automatic file cleanup after each test */
  autoCleanup?: boolean;
}

/**
 * Parse command line arguments.
 */
/** Transport mode for testing */
type TransportMode = "iroh" | "hybrid" | "mock";

function parseArgs(): {
  suite?: string;
  verbose: boolean;
  discover: boolean;
  restart: boolean;
  fresh: boolean;
  sequential: boolean;
  failFast: boolean;
  help: boolean;
  tags: string[];
  excludeTags: string[];
  validateState: boolean;
  strict: boolean;
  transport: TransportMode;
  keep: boolean;
  autoCleanup: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    suite: undefined as string | undefined,
    verbose: false,
    discover: false,
    restart: false,
    fresh: false,
    sequential: false,
    failFast: true, // Default: abort after 3 consecutive failures
    help: false,
    tags: [] as string[],
    excludeTags: [] as string[],
    validateState: true, // Default: enabled
    strict: false,
    transport: "hybrid" as TransportMode, // Default: hybrid
    keep: false, // Default: shutdown after tests
    autoCleanup: true, // Default: enabled
  };

  for (const arg of args) {
    if (arg.startsWith("--suite=")) {
      result.suite = arg.slice(8);
    } else if (arg.startsWith("--tags=")) {
      result.tags = arg.slice(7).split(",").map(t => t.trim()).filter(Boolean);
    } else if (arg.startsWith("--exclude-tags=")) {
      result.excludeTags = arg.slice(15).split(",").map(t => t.trim()).filter(Boolean);
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
    } else if (arg === "--discover") {
      result.discover = true;
    } else if (arg === "--restart" || arg === "-r") {
      result.restart = true;
    } else if (arg === "--fresh" || arg === "-f") {
      result.fresh = true;
      result.restart = true; // --fresh implies --restart
    } else if (arg === "--sequential" || arg === "-s") {
      result.sequential = true;
    } else if (arg === "--no-fail-fast") {
      result.failFast = false;
    } else if (arg === "--no-validate-state") {
      result.validateState = false;
    } else if (arg === "--strict") {
      result.strict = true;
    } else if (arg === "--mock") {
      result.transport = "mock";
    } else if (arg.startsWith("--transport=")) {
      const value = arg.slice(12);
      if (value === "iroh" || value === "hybrid" || value === "mock") {
        result.transport = value;
      } else {
        console.error(`Invalid transport: ${value}. Use: iroh, hybrid, or mock`);
        process.exit(1);
      }
    } else if (arg === "--keep" || arg === "-k") {
      result.keep = true;
    } else if (arg === "--no-auto-cleanup") {
      result.autoCleanup = false;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    }
  }

  return result;
}

/** Maximum consecutive failures before aborting (fail-fast) */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Global fail-fast state */
let consecutiveFailures = 0;
let failFastEnabled = true;
let failFastTriggered = false;

/** Global tag filters */
let includeTags: string[] = [];
let excludeTags: string[] = [];

/** Global state validator */
let stateValidator: StateValidator | null = null;

/** Global isolation manager */
let isolationManager: IsolationManager | null = null;

/** Whether auto-cleanup is enabled globally */
let autoCleanupEnabled = true;

/**
 * Check if a test should run based on tag filters.
 * - If includeTags is set, test must have at least one matching tag
 * - If excludeTags is set, test must not have any matching tags
 */
function shouldRunTest(test: TestDef): boolean {
  const testTags = test.tags ?? [];

  // Check exclude tags first (higher priority)
  if (excludeTags.length > 0) {
    if (testTags.some(t => excludeTags.includes(t))) {
      return false;
    }
  }

  // Check include tags
  if (includeTags.length > 0) {
    // Test must have at least one matching tag
    if (!testTags.some(t => includeTags.includes(t))) {
      return false;
    }
  }

  return true;
}

/** Check if we should abort due to consecutive failures */
function shouldAbort(): boolean {
  return failFastEnabled && failFastTriggered;
}

/** Record a test result for fail-fast tracking */
function recordTestResult(passed: boolean): void {
  if (passed) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      failFastTriggered = true;
      console.log(`\n❌ ABORTING: ${MAX_CONSECUTIVE_FAILURES} consecutive test failures\n`);
    }
  }
}

/** Options for running a test with hooks */
interface RunTestOptions {
  /** Suite-level beforeEach hook */
  suiteBeforeEach?: HookFn;
  /** Suite-level afterEach hook */
  suiteAfterEach?: HookFn;
  /** Whether this suite has auto-cleanup enabled */
  suiteAutoCleanup?: boolean;
}

/**
 * Run a test with retry support, hooks, and state validation.
 * Retries the test up to `maxRetries` times on failure.
 * Validates state before and after test execution.
 * Runs beforeEach/afterEach hooks.
 * Performs automatic cleanup if enabled.
 * Returns the result of the final attempt with retry info.
 */
async function runTestWithRetry(
  test: TestDef,
  suiteName: string,
  ctx: TestContext,
  options?: RunTestOptions
): Promise<TestResult> {
  const maxRetries = test.retryOnFailure ?? 0;
  let lastResult: TestResult | null = null;
  const startTime = Date.now();

  // Determine which hooks to use (test-level overrides suite-level)
  const beforeEachHook = test.beforeEach ?? options?.suiteBeforeEach;
  const afterEachHook = test.afterEach ?? options?.suiteAfterEach;

  // Determine if auto-cleanup is enabled for this test
  const shouldAutoCleanup =
    !test.skipAutoCleanup &&
    autoCleanupEnabled &&
    (options?.suiteAutoCleanup ?? false);

  // Capture state before test
  if (stateValidator) {
    await stateValidator.captureBeforeTest(ctx);
  }

  // Capture file state for cleanup
  if (shouldAutoCleanup && isolationManager) {
    await isolationManager.captureBeforeTest(ctx);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const isRetry = attempt > 0;

    if (isRetry) {
      console.log(`  ↺ Retrying "${test.name}" (attempt ${attempt + 1}/${maxRetries + 1})...`);
      // Small delay between retries to let things settle
      await delay(1000);
    }

    // Run beforeEach hook
    if (beforeEachHook) {
      try {
        await beforeEachHook(ctx);
      } catch (err) {
        console.log(`  ⚠ beforeEach hook failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const result = await runTest(test.name, suiteName, () => test.fn(ctx), ctx);
    lastResult = result;

    // Run afterEach hook (always, even on failure)
    if (afterEachHook) {
      try {
        await afterEachHook(ctx);
      } catch (err) {
        console.log(`  ⚠ afterEach hook failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (result.passed) {
      // Test passed - validate state
      const totalDuration = Date.now() - startTime;
      const finalResult: TestResult = {
        ...result,
        duration: totalDuration,
        retriesAttempted: attempt,
        passedAfterRetry: isRetry,
      };

      // Validate state after successful test
      if (stateValidator) {
        const validation = await stateValidator.validateAfterTest(ctx, test.name);
        if (validation.issues.length > 0) {
          console.log(formatIssues(validation.issues));
        }
      }

      // Clean up files created during this test
      if (shouldAutoCleanup && isolationManager) {
        const cleanup = await isolationManager.cleanupAfterTest(ctx);
        if (cleanup.cleaned > 0) {
          console.log(`  🧹 Cleaned up ${cleanup.cleaned} test file(s)`);
        }
      }

      return finalResult;
    }

    // Test failed - log error but continue retrying
    if (isRetry || maxRetries > 0) {
      console.log(`    Attempt ${attempt + 1} failed: ${result.error?.message?.slice(0, 100) ?? "unknown error"}`);
    }
  }

  // All attempts failed - still validate state and clean up
  if (stateValidator) {
    const validation = await stateValidator.validateAfterTest(ctx, test.name);
    if (validation.issues.length > 0) {
      console.log(formatIssues(validation.issues));
    }
  }

  // Clean up even after failure
  if (shouldAutoCleanup && isolationManager) {
    const cleanup = await isolationManager.cleanupAfterTest(ctx);
    if (cleanup.cleaned > 0) {
      console.log(`  🧹 Cleaned up ${cleanup.cleaned} test file(s)`);
    }
  }

  const totalDuration = Date.now() - startTime;
  return {
    ...lastResult!,
    duration: totalDuration,
    retriesAttempted: maxRetries,
    passedAfterRetry: false,
  };
}

/**
 * Print usage help.
 */
function printHelp(): void {
  console.log(`
E2E Test Runner for PeerVault

Usage: bun run test:e2e [options]

Options:
  --suite=<name>     Run only the specified test suite
  --tags=<t1,t2>     Only run tests with ANY of these tags
  --exclude-tags=<t> Skip tests with ANY of these tags
  --transport=<mode> Set transport mode: iroh, hybrid (default), or mock
  --mock             Shorthand for --transport=mock
  --verbose, -v      Enable verbose output
  --discover         Only discover vaults, don't run tests
  --restart, -r      Kill and restart Obsidian before tests
  --fresh, -f        Full reset: delete plugins, restart, reinstall via BRAT,
                     uninstall and shutdown after tests complete
  --keep, -k         Keep Obsidian running after tests (use with --fresh for debugging)
  --sequential, -s   Disable parallel test execution
  --slow             Use longer timeouts for debugging
  --no-fail-fast     Don't abort after consecutive failures (default: abort after 3)
  --no-validate-state  Disable state validation between tests
  --no-auto-cleanup  Disable automatic cleanup of test files
  --strict           Strict mode: fail on any state warnings (not just errors)
  --help, -h         Show this help message

Test Lifecycle:
  Default mode:      Assumes Obsidian is running with vaults and plugin installed
  --restart mode:    Restarts Obsidian before tests, keeps running after
  --fresh mode:      Complete self-contained run:
                     1. Deletes existing plugins
                     2. Starts Obsidian and opens vaults
                     3. Installs plugins via BRAT
                     4. Runs tests
                     5. Uninstalls plugins
                     6. Shuts down Obsidian
  --fresh --keep:    Same as --fresh but keeps Obsidian running after tests

Transport modes:
  mock        In-memory mock transport (fast, no network)
  iroh        Iroh relay transport only
  hybrid      Iroh + optional WebRTC upgrade (default)

Available tags:
  smoke       Quick sanity checks (fast subset for CI)
  slow        Long-running tests (skip for quick iteration)
  protocol    Sync protocol tests
  transport   Transport layer tests
  conflict    Conflict resolution tests
  recovery    Error recovery tests
  edge-case   Edge case tests

Available suites:
${TEST_SUITES.map((s) => `  - ${s}`).join("\n")}

Prerequisites (if not using --restart or --fresh):
  1. Obsidian must be running with DevTools enabled:
     obsidian --remote-debugging-port=9222
  2. Both TEST and TEST2 vaults must be open
  3. PeerVault plugin must be installed in both vaults

Environment variables:
  CDP_PORT          Override CDP port (default: 9222)
  TEST_VAULT_PATH   Override TEST vault path
  TEST2_VAULT_PATH  Override TEST2 vault path
`);
}

/**
 * Kill all running Obsidian processes.
 */
function killObsidian(): void {
  console.log("Killing Obsidian processes...");

  // Kill by process name (works on Linux)
  spawnSync("pkill", ["-f", "obsidian"], { stdio: "ignore" });

  // Also try killall as backup
  spawnSync("killall", ["obsidian"], { stdio: "ignore" });

  // Wait a moment for processes to die
  spawnSync("sleep", ["2"]);

  console.log("Obsidian processes killed.");
}

/**
 * Start Obsidian in dev mode with test vaults.
 */
async function startObsidian(cfg: ReturnType<typeof getConfig>, includeTest3: boolean = false): Promise<void> {
  console.log("Starting Obsidian in dev mode...");

  const cdpHost = cfg.cdp.host;
  const cdpPort = cfg.cdp.port;

  // Start Obsidian with remote debugging enabled
  const proc = Bun.spawn(["obsidian", `--remote-debugging-port=${cdpPort}`], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();

  console.log(`Started Obsidian with CDP port ${cdpPort}`);

  // Immediately open TEST vault via URI to avoid vault selector modal
  // Small delay to let Obsidian register its URI handler
  await new Promise((r) => setTimeout(r, 500));
  console.log("Opening TEST vault...");
  const openTest = Bun.spawn(["xdg-open", `obsidian://open?vault=TEST`], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  openTest.unref();

  // Wait for Obsidian to be responsive with TEST vault
  const maxWait = 30000;
  const pollInterval = 1000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval));
    elapsed += pollInterval;

    try {
      const vaultsMap = await discoverVaults(cdpHost, cdpPort);
      const vaults = Array.from(vaultsMap.values());
      const hasTest = vaults.some((v) => v.title.includes("TEST") && !v.title.includes("TEST2") && !v.title.includes("TEST3"));

      if (hasTest) {
        console.log(`TEST vault ready after ${elapsed}ms`);

        // Now open the second vault
        console.log("Opening TEST2 vault...");

        const openProc = Bun.spawn(["xdg-open", `obsidian://open?vault=TEST2`], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        openProc.unref();

        // Wait for second vault to appear
        let vault2Elapsed = 0;
        while (vault2Elapsed < 15000) {
          await new Promise((r) => setTimeout(r, pollInterval));
          vault2Elapsed += pollInterval;

          const vaults2Map = await discoverVaults(cdpHost, cdpPort);
          const vaults2 = Array.from(vaults2Map.values());
          const hasTest2 = vaults2.some((v) => v.title.includes("TEST2"));

          if (hasTest2) {
            console.log(`TEST and TEST2 ready after ${elapsed + vault2Elapsed}ms total`);

            // If we need TEST3, open it too
            if (includeTest3) {
              console.log("Opening TEST3 vault...");
              const openTest3 = Bun.spawn(["xdg-open", `obsidian://open?vault=TEST3`], {
                stdout: "ignore",
                stderr: "ignore",
                stdin: "ignore",
              });
              openTest3.unref();

              // Wait for TEST3 to appear
              let vault3Elapsed = 0;
              while (vault3Elapsed < 15000) {
                await new Promise((r) => setTimeout(r, pollInterval));
                vault3Elapsed += pollInterval;

                const vaults3Map = await discoverVaults(cdpHost, cdpPort);
                const vaults3 = Array.from(vaults3Map.values());
                const hasTest3 = vaults3.some((v) => v.title.includes("TEST3"));

                if (hasTest3) {
                  console.log(`All 3 vaults ready after ${elapsed + vault2Elapsed + vault3Elapsed}ms total`);
                  break;
                }
              }
            }

            // Give plugins time to initialize
            console.log("Waiting for plugins to initialize...");
            await delay(5000);
            return;
          }
        }

        throw new Error("TEST2 vault did not open within 15s");
      }
    } catch (err) {
      // CDP not ready yet, continue waiting
      if (elapsed % 5000 === 0) {
        console.log(`Still waiting for Obsidian... (${elapsed}ms)`);
      }
    }
  }

  throw new Error(`Obsidian did not start within ${maxWait}ms`);
}

/**
 * Delete peervault plugin from a vault.
 */
async function deletePlugin(vaultPath: string): Promise<void> {
  const pluginPath = join(vaultPath, ".obsidian", "plugins", "peervault");
  try {
    const { rmSync } = await import("node:fs");
    rmSync(pluginPath, { recursive: true, force: true });
    console.log(`  Deleted plugin from ${vaultPath}`);
  } catch (err) {
    // Ignore if doesn't exist
  }
}

/**
 * Enable peervault in community-plugins.json.
 */
async function enablePluginInConfig(vaultPath: string): Promise<void> {
  const configPath = join(vaultPath, ".obsidian", "community-plugins.json");
  const { readFileSync, writeFileSync } = await import("node:fs");

  let plugins: string[] = [];
  try {
    plugins = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    plugins = [];
  }

  if (!plugins.includes("peervault")) {
    plugins.push("peervault");
  }

  writeFileSync(configPath, JSON.stringify(plugins, null, 2));
  console.log(`  Enabled peervault in ${vaultPath}`);
}

/**
 * Install peervault via BRAT in a vault.
 */
async function installViaBrat(
  cdpHost: string,
  cdpPort: number,
  vaultTitle: string
): Promise<void> {
  // Find the vault's CDP target
  const list = await fetch(`http://${cdpHost}:${cdpPort}/json/list`).then(r => r.json()) as Array<{title: string; webSocketDebuggerUrl: string}>;
  const target = list.find(t => t.title.includes(vaultTitle) && !t.title.includes(vaultTitle + "2"));

  if (!target) {
    throw new Error(`Vault ${vaultTitle} not found in CDP targets`);
  }

  console.log(`  Installing peervault via BRAT in ${vaultTitle}...`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("BRAT installation timeout"));
    }, 60000);

    ws.onopen = () => {
      // Call BRAT's addPlugin method
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: `
            (async function() {
              const brat = window.app?.plugins?.plugins?.["obsidian42-brat"];
              if (!brat || !brat.betaPlugins) {
                throw new Error("BRAT plugin not available");
              }

              // Add the plugin via BRAT's betaPlugins
              const repo = "robcohen/peervault";

              // addPlugin params: (repositoryPath, updatePluginFiles, seeIfUpdatedOnly, reportIfNotUpdted, specifyVersion, forceReinstall, enableAfterInstall)
              console.log("Installing PeerVault via BRAT...");
              const result = await brat.betaPlugins.addPlugin(
                repo,   // repositoryPath
                false,  // updatePluginFiles
                false,  // seeIfUpdatedOnly
                false,  // reportIfNotUpdted
                "",     // specifyVersion
                true,   // forceReinstall
                true    // enableAfterInstall
              );

              if (!result) {
                throw new Error("BRAT addPlugin returned false");
              }

              // Wait for plugin to initialize
              await new Promise(r => setTimeout(r, 3000));

              return { success: true };
            })()
          `,
          returnByValue: true,
          awaitPromise: true,
        }
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      if (msg.id === 1) {
        clearTimeout(timeout);
        ws.close();

        if (msg.result?.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.exception?.description || "BRAT installation failed"));
        } else {
          console.log(`  PeerVault installed in ${vaultTitle}`);
          resolve();
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${err}`));
    };
  });
}

/**
 * Perform fresh install: delete plugins and reinstall via BRAT.
 */
async function freshInstall(cfg: ReturnType<typeof getConfig>, includeTest3: boolean = false): Promise<void> {
  console.log("\n=== Fresh Install Mode ===");

  // Delete plugins from all vaults
  console.log("Deleting existing peervault plugins...");
  await deletePlugin(cfg.vaults.TEST.path);
  await deletePlugin(cfg.vaults.TEST2.path);
  if (includeTest3 && cfg.vaults.TEST3) {
    await deletePlugin(cfg.vaults.TEST3.path);
  }

  // Ensure plugins are enabled in config (so Obsidian knows to load them after BRAT installs)
  console.log("Updating plugin configs...");
  await enablePluginInConfig(cfg.vaults.TEST.path);
  await enablePluginInConfig(cfg.vaults.TEST2.path);
  if (includeTest3 && cfg.vaults.TEST3) {
    await enablePluginInConfig(cfg.vaults.TEST3.path);
  }
}

/**
 * Wait for plugin to be fully ready in a vault via CDP.
 */
async function waitForPluginReady(
  cdpHost: string,
  cdpPort: number,
  vaultTitle: string,
  timeoutMs: number = 30000
): Promise<boolean> {
  const list = await fetch(`http://${cdpHost}:${cdpPort}/json/list`).then(r => r.json()) as Array<{title: string; webSocketDebuggerUrl: string}>;
  const target = list.find(t => t.title.includes(vaultTitle) && !t.title.includes(vaultTitle + "2") && !t.title.includes(vaultTitle + "3"));

  if (!target) {
    console.log(`  Vault ${vaultTitle} not found, cannot verify plugin`);
    return false;
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pollInterval = 500;
  let elapsed = 0;

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      console.log(`  Plugin not ready in ${vaultTitle} after ${timeoutMs}ms`);
      resolve(false);
    }, timeoutMs);

    const checkReady = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: `
            (function() {
              const plugin = window.app?.plugins?.plugins?.["peervault"];
              if (!plugin) return { ready: false, reason: "not found" };
              if (!plugin.client) return { ready: false, reason: "no client" };
              if (!plugin.client.isInitialized) return { ready: false, reason: "not initialized" };
              if (!plugin.client.nodeId) return { ready: false, reason: "no nodeId" };
              return { ready: true, nodeId: plugin.client.nodeId.slice(0, 8) };
            })()
          `,
          returnByValue: true,
        }
      }));
    };

    ws.onopen = () => {
      checkReady();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      if (msg.id === 1) {
        const result = msg.result?.result?.value;
        if (result?.ready) {
          clearTimeout(timeout);
          ws.close();
          console.log(`  ${vaultTitle} plugin ready (node: ${result.nodeId}...)`);
          resolve(true);
        } else {
          elapsed += pollInterval;
          if (elapsed < timeoutMs) {
            setTimeout(checkReady, pollInterval);
          }
        }
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
  });
}

/**
 * Install plugins after Obsidian starts.
 */
async function installPluginsViaBrat(cfg: ReturnType<typeof getConfig>, includeTest3: boolean = false): Promise<void> {
  console.log("Installing peervault via BRAT...");

  // Install in TEST first, then TEST2
  await installViaBrat(cfg.cdp.host, cfg.cdp.port, "TEST");

  // Small delay between installations
  await delay(2000);

  await installViaBrat(cfg.cdp.host, cfg.cdp.port, "TEST2");

  if (includeTest3) {
    await delay(2000);
    await installViaBrat(cfg.cdp.host, cfg.cdp.port, "TEST3");
  }

  console.log("Plugin installation complete. Waiting for plugins to be ready...");

  // Wait for all plugins to be fully ready
  const vaults = ["TEST", "TEST2"];
  if (includeTest3) vaults.push("TEST3");

  let allReady = true;
  for (const vault of vaults) {
    const ready = await waitForPluginReady(cfg.cdp.host, cfg.cdp.port, vault);
    if (!ready) allReady = false;
  }

  if (allReady) {
    console.log("All plugins ready.");
  } else {
    console.log("Some plugins not fully ready - will be fixed by reinstall tests.");
    // Give extra time for plugins to stabilize
    await delay(5000);
  }
}

/**
 * Uninstall peervault plugin from a vault via CDP.
 */
async function uninstallPlugin(
  cdpHost: string,
  cdpPort: number,
  vaultTitle: string
): Promise<void> {
  // Find the vault's CDP target
  const list = await fetch(`http://${cdpHost}:${cdpPort}/json/list`).then(r => r.json()) as Array<{title: string; webSocketDebuggerUrl: string}>;
  const target = list.find(t => t.title.includes(vaultTitle) && !t.title.includes(vaultTitle + "2") && !t.title.includes(vaultTitle + "3"));

  if (!target) {
    console.log(`  Vault ${vaultTitle} not found, skipping uninstall`);
    return;
  }

  console.log(`  Uninstalling peervault from ${vaultTitle}...`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Plugin uninstall timeout"));
    }, 30000);

    ws.onopen = () => {
      // Disable and uninstall the plugin
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: `
            (async function() {
              const app = window.app;
              if (!app?.plugins) {
                throw new Error("Obsidian app not available");
              }

              // Check if plugin is installed
              const plugin = app.plugins.plugins["peervault"];
              if (!plugin) {
                console.log("PeerVault not installed, nothing to uninstall");
                return { success: true, message: "not installed" };
              }

              // Disable the plugin first
              console.log("Disabling PeerVault...");
              await app.plugins.disablePlugin("peervault");

              // Uninstall via manifest management
              console.log("Uninstalling PeerVault...");
              await app.plugins.uninstallPlugin("peervault");

              return { success: true };
            })()
          `,
          returnByValue: true,
          awaitPromise: true,
        }
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      if (msg.id === 1) {
        clearTimeout(timeout);
        ws.close();

        if (msg.result?.exceptionDetails) {
          // Log but don't fail - plugin might already be uninstalled
          console.log(`  Warning: ${msg.result.exceptionDetails.exception?.description || "Uninstall warning"}`);
          resolve();
        } else {
          console.log(`  PeerVault uninstalled from ${vaultTitle}`);
          resolve();
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      // Log but don't fail
      console.log(`  Warning: WebSocket error during uninstall: ${err}`);
      resolve();
    };
  });
}

/**
 * Uninstall plugins from all vaults.
 */
async function uninstallPlugins(cfg: ReturnType<typeof getConfig>, includeTest3: boolean = false): Promise<void> {
  console.log("\nUninstalling plugins from all vaults...");

  try {
    await uninstallPlugin(cfg.cdp.host, cfg.cdp.port, "TEST");
    await delay(1000);
    await uninstallPlugin(cfg.cdp.host, cfg.cdp.port, "TEST2");
    if (includeTest3) {
      await delay(1000);
      await uninstallPlugin(cfg.cdp.host, cfg.cdp.port, "TEST3");
    }
    console.log("Plugin uninstallation complete.");
  } catch (err) {
    console.log(`Warning: Plugin uninstallation failed: ${err}`);
    // Don't throw - we want to continue with shutdown even if uninstall fails
  }
}

/**
 * Shutdown Obsidian gracefully.
 */
function shutdownObsidian(): void {
  console.log("\nShutting down Obsidian...");
  killObsidian();
  console.log("Obsidian shutdown complete.");
}

/** Track whether sequential mode is enabled */
let sequentialMode = false;

/**
 * Set sequential mode (disables parallel test execution).
 */
export function setSequentialMode(enabled: boolean): void {
  sequentialMode = enabled;
}

/**
 * Load and run tests from a suite directory.
 * Supports parallel execution for tests marked with `parallel: true`.
 */
async function runSuite(
  suiteName: string,
  ctx: TestContext,
  reporter: TestReporter
): Promise<void> {
  const suitePath = join(import.meta.dir, "tests", suiteName);

  reporter.startSuite(suiteName);

  // Collect suite-level hooks from all files in the suite
  let suiteBeforeAll: HookFn | undefined;
  let suiteAfterAll: HookFn | undefined;
  let suiteBeforeEach: HookFn | undefined;
  let suiteAfterEach: HookFn | undefined;
  let suiteAutoCleanup = false;

  try {
    // Find all test files
    const entries = await readdir(suitePath, { withFileTypes: true });
    const testFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
      .map((e) => e.name)
      .sort();

    if (testFiles.length === 0) {
      console.log(`  No test files found in ${suiteName}`);
      reporter.endSuite();
      return;
    }

    // Collect all tests from all files
    const allTests: Array<{ test: TestDef; file: string }> = [];

    for (const file of testFiles) {
      const filePath = join(suitePath, file);
      try {
        const module: SuiteModule = await import(filePath);
        const tests = module.default || module.tests || [];
        for (const test of tests) {
          allTests.push({ test, file });
        }

        // Collect suite-level hooks (first file with hooks wins)
        if (!suiteBeforeAll && module.beforeAll) suiteBeforeAll = module.beforeAll;
        if (!suiteAfterAll && module.afterAll) suiteAfterAll = module.afterAll;
        if (!suiteBeforeEach && module.beforeEach) suiteBeforeEach = module.beforeEach;
        if (!suiteAfterEach && module.afterEach) suiteAfterEach = module.afterEach;
        if (module.autoCleanup) suiteAutoCleanup = true;
      } catch (err) {
        reporter.addTest({
          name: `[Load ${file}]`,
          suite: suiteName,
          passed: false,
          error: err instanceof Error ? err : new Error(String(err)),
          duration: 0,
        });
      }
    }

    // Run suite beforeAll hook
    if (suiteBeforeAll) {
      console.log(`  ⚙ Running suite beforeAll hook...`);
      try {
        await suiteBeforeAll(ctx);
      } catch (err) {
        console.log(`  ⚠ Suite beforeAll hook failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Prepare options for test execution
    const runOptions: RunTestOptions = {
      suiteBeforeEach,
      suiteAfterEach,
      suiteAutoCleanup,
    };

    // Run tests, batching parallel ones together
    let parallelBatch: Array<{ test: TestDef; file: string }> = [];

    const runParallelBatch = async (): Promise<boolean> => {
      if (parallelBatch.length === 0) return true;
      if (shouldAbort()) return false;

      if (parallelBatch.length === 1 || sequentialMode) {
        // Just run sequentially if only one test or sequential mode
        for (const { test } of parallelBatch) {
          if (shouldAbort()) break;
          const result = await runTestWithRetry(test, suiteName, ctx, runOptions);
          reporter.addTest(result);
          recordTestResult(result.passed);
          ctx.cleanupBetweenTests();
        }
      } else {
        // Run in parallel (note: retries disabled for parallel tests to avoid complexity)
        console.log(`  ⚡ Running ${parallelBatch.length} tests in parallel...`);
        const promises = parallelBatch.map(async ({ test }) => {
          const result = await runTestWithRetry(test, suiteName, ctx, runOptions);
          return result;
        });

        const results = await Promise.all(promises);
        for (const result of results) {
          reporter.addTest(result);
          recordTestResult(result.passed);
        }
        ctx.cleanupBetweenTests();
      }

      parallelBatch = [];
      return !shouldAbort();
    };

    for (const { test, file } of allTests) {
      if (shouldAbort()) break;

      // Check tag filters
      if (!shouldRunTest(test)) {
        // Silently skip tests that don't match tag filters
        continue;
      }

      if (test.skip) {
        // Flush any pending parallel tests first
        if (!await runParallelBatch()) break;

        reporter.addTest({
          name: test.name,
          suite: suiteName,
          passed: true,
          skipped: true,
          duration: 0,
        });
        console.log(`⊘ ${test.name} (skipped)`);
        continue;
      }

      if (test.parallel && !sequentialMode) {
        // Add to parallel batch
        parallelBatch.push({ test, file });
      } else {
        // Sequential test - flush parallel batch first
        if (!await runParallelBatch()) break;

        // Run this test (with retry support)
        const result = await runTestWithRetry(test, suiteName, ctx, runOptions);
        reporter.addTest(result);
        recordTestResult(result.passed);
        ctx.cleanupBetweenTests();

        if (shouldAbort()) break;
      }
    }

    // Flush any remaining parallel tests
    await runParallelBatch();

    // Run suite afterAll hook
    if (suiteAfterAll) {
      console.log(`  ⚙ Running suite afterAll hook...`);
      try {
        await suiteAfterAll(ctx);
      } catch (err) {
        console.log(`  ⚠ Suite afterAll hook failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Clean up any leftover test files using pattern matching
    if (isolationManager && autoCleanupEnabled) {
      try {
        const cleanup = await isolationManager.cleanupPatternMatches(ctx);
        if (cleanup.cleaned > 0) {
          console.log(`  🧹 Suite cleanup: removed ${cleanup.cleaned} test file(s)`);
        }
      } catch (err) {
        // Don't fail suite for cleanup errors
        console.log(`  ⚠ Suite cleanup failed: ${err instanceof Error ? err.message : err}`);
      }
    }

  } catch (err) {
    reporter.addTest({
      name: `[Suite ${suiteName}]`,
      suite: suiteName,
      passed: false,
      error: err instanceof Error ? err : new Error(String(err)),
      duration: 0,
    });
  }

  reporter.endSuite();
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Set sequential mode if requested
  if (args.sequential) {
    setSequentialMode(true);
  }

  // Set fail-fast mode
  failFastEnabled = args.failFast;

  // Set tag filters
  includeTags = args.tags;
  excludeTags = args.excludeTags;

  const cfg = getConfig();
  console.log("PeerVault E2E Test Runner");
  console.log("=".repeat(60));
  console.log(`CDP Port: ${cfg.cdp.port}`);
  console.log(`Test Vault: ${cfg.vaults.TEST.name}`);
  console.log(`Test2 Vault: ${cfg.vaults.TEST2.name}`);
  console.log(`Mode: ${args.sequential ? "sequential" : "parallel"}`);
  console.log(`Transport: ${args.transport}`);
  const timeoutMode = process.argv.includes("--slow") ? "slow" :
                       (args.transport === "mock" ? "mock-fast" : "normal");
  console.log(`Timeouts: ${timeoutMode}`);
  console.log(`Fail-fast: ${args.failFast ? `enabled (${MAX_CONSECUTIVE_FAILURES} failures)` : "disabled"}`);
  console.log(`State validation: ${args.validateState ? (args.strict ? "strict" : "enabled") : "disabled"}`);
  console.log(`Auto-cleanup: ${args.autoCleanup ? "enabled" : "disabled"}`);
  if (args.tags.length > 0) {
    console.log(`Tags: ${args.tags.join(", ")}`);
  }
  if (args.excludeTags.length > 0) {
    console.log(`Exclude tags: ${args.excludeTags.join(", ")}`);
  }

  // Initialize state validator
  if (args.validateState) {
    stateValidator = new StateValidator({
      enabled: true,
      strict: args.strict,
    });
  }

  // Initialize isolation manager
  if (args.autoCleanup) {
    isolationManager = createIsolationManager();
    autoCleanupEnabled = true;
  } else {
    autoCleanupEnabled = false;
  }

  if (args.discover) {
    console.log("\nDiscovering vaults...\n");
    await printDiscoveredVaults(cfg.cdp.host, cfg.cdp.port);
    process.exit(0);
  }

  // Determine which suites to run EARLY (needed for 3-vault detection before starting Obsidian)
  let suitesToRun = TEST_SUITES;
  if (args.suite) {
    if (!TEST_SUITES.includes(args.suite)) {
      console.error(`Unknown suite: ${args.suite}`);
      console.error(`Available: ${TEST_SUITES.join(", ")}`);
      process.exit(1);
    }
    suitesToRun = [args.suite];
  }

  // Skip slow suites for mock transport (unless explicitly requested)
  const SLOW_SUITES = ["05-error-recovery", "06-edge-cases", "07-transport"];
  if (args.transport === "mock" && !args.suite) {
    const skipped = suitesToRun.filter(s => SLOW_SUITES.includes(s));
    suitesToRun = suitesToRun.filter(s => !SLOW_SUITES.includes(s));
    if (skipped.length > 0) {
      console.log(`\nSkipping slow suites for mock transport: ${skipped.join(", ")}`);
      console.log(`(Use --suite=<name> to run specific slow suites)`);
    }
    // Also exclude tests tagged "slow" for mock transport
    if (!args.excludeTags.includes("slow")) {
      args.excludeTags.push("slow");
      console.log(`Auto-excluding tests tagged "slow" for mock transport`);
    }
  }

  // Check if any suites require 3-vault context
  const needsThreeVaults = suitesToRun.some(suite => THREE_VAULT_SUITES.includes(suite));
  if (needsThreeVaults) {
    console.log(`\n⚠️  Running 3-vault suites: TEST3 vault required`);
  }

  // Track if we started Obsidian (for cleanup at end)
  let startedObsidian = false;

  // Handle fresh flag - delete plugins before restart
  if (args.fresh) {
    await freshInstall(cfg, needsThreeVaults);
  }

  // Handle restart flag - kill and restart Obsidian before tests
  if (args.restart) {
    killObsidian();
    await startObsidian(cfg, needsThreeVaults);
    startedObsidian = true;

    // If fresh install, reinstall plugins via BRAT after Obsidian starts
    if (args.fresh) {
      await installPluginsViaBrat(cfg, needsThreeVaults);
    }
  }

  console.log(`\nSuites to run: ${suitesToRun.join(", ")}`);
  console.log("=".repeat(60));

  // Create test context
  let ctx: TestContext;
  try {
    ctx = await createTestContext({ includeTest3: needsThreeVaults });
  } catch (err) {
    console.error("\nFailed to create test context:");
    console.error(err instanceof Error ? err.message : err);
    console.error("\nMake sure:");
    console.error("  1. Obsidian is running with --remote-debugging-port=9222");
    console.error("  2. Both TEST and TEST2 vaults are open");
    if (needsThreeVaults) {
      console.error("  3. TEST3 vault is open (required for mesh-sync tests)");
    }
    process.exit(1);
  }

  // Transport mode is now fixed in the new plugin architecture - no configuration needed

  const reporter = new TestReporter();
  const startTime = Date.now();

  try {
    // If running a single suite (not 00-setup or 01-pairing), ensure peers are connected
    // Suites 02+ depend on pairing being complete
    const isIsolatedRun = args.suite !== undefined;
    const needsPairing = isIsolatedRun &&
      args.suite !== "00-setup" &&
      args.suite !== "01-pairing";

    // Check if we need to clean up test files (for sync suites)
    const needsCleanup = suitesToRun.some(s =>
      s.startsWith("02-") || s.startsWith("03-") || s.startsWith("04-")
    );

    if (needsPairing) {
      console.log("\nRunning isolated suite - checking peer connection...");
      try {
        const peers = await ctx.test.plugin.getPeers();
        if (peers.length === 0) {
          console.warn("Warning: No peers connected. Sync tests may fail.");
          console.warn("Run full test suite or 01-pairing first to establish peers.");
        } else {
          console.log(`Found ${peers.length} peer(s)`);
        }
      } catch (err) {
        console.warn("Warning: Could not check peer status:", err);
      }
    }

    // Clean up leftover test files before running sync suites
    if (needsCleanup) {
      console.log("\nCleaning up leftover test files...");
      try {
        const testFiles = await ctx.test.vault.listFiles();
        const test2Files = await ctx.test2.vault.listFiles();

        // Delete common test file patterns
        const testPatterns = [
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
        ];

        // Delete files matching patterns (includes folder contents)
        let cleanedCount = 0;
        for (const file of testFiles) {
          if (testPatterns.some(p => p.test(file))) {
            try { await ctx.test.vault.deleteFile(file); cleanedCount++; } catch {}
          }
        }
        for (const file of test2Files) {
          if (testPatterns.some(p => p.test(file))) {
            try { await ctx.test2.vault.deleteFile(file); cleanedCount++; } catch {}
          }
        }
        console.log(`Cleanup complete (${cleanedCount} files removed)`);
      } catch (err) {
        console.warn("Warning: Cleanup failed:", err);
      }
    }

    // Run suites in order
    for (const suite of suitesToRun) {
      if (shouldAbort()) {
        console.log(`\nSkipping remaining suites due to fail-fast abort`);
        break;
      }

      console.log(`\n${"=".repeat(60)}`);
      console.log(`Suite: ${suite}`);
      console.log("=".repeat(60));

      await runSuite(suite, ctx, reporter);
    }
  } finally {
    // Clean up
    await ctx.close();
  }

  const totalTime = Date.now() - startTime;

  // Print summary
  reporter.printSummary();

  // Print state validation summary
  if (stateValidator) {
    console.log("\n" + "-".repeat(60));
    console.log(stateValidator.getSummary());

    // In strict mode, state errors cause exit failure
    if (args.strict && stateValidator.hasErrors()) {
      console.log("\n❌ State validation errors detected (strict mode)");
    }
  }

  console.log(`\nTotal time: ${totalTime}ms`);

  // Clean up if we did a fresh install (unless --keep is set)
  if (args.fresh && startedObsidian && !args.keep) {
    console.log("\n" + "=".repeat(60));
    console.log("CLEANUP: Uninstalling plugins and shutting down Obsidian");
    console.log("=".repeat(60));

    try {
      await uninstallPlugins(cfg, needsThreeVaults);
    } catch (err) {
      console.log(`Warning: Plugin uninstall failed: ${err}`);
    }

    shutdownObsidian();
  } else if (args.fresh && args.keep) {
    console.log("\n--keep flag set: Obsidian kept running with plugins installed");
  }

  // Exit with appropriate code
  const hasTestFailures = reporter.hasFailures();
  const hasStateErrors = args.strict && stateValidator?.hasErrors();
  process.exit(hasTestFailures || hasStateErrors ? 1 : 0);
}

// Run
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
