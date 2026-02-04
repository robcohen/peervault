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
import { config, getConfig } from "./config";
import {
  createTestContext,
  TestReporter,
  runTest,
  type TestContext,
  type TestResult,
} from "./lib/context";
import { printDiscoveredVaults, discoverVaults } from "./lib/cdp-discovery";

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
];

/** Test function signature */
type TestFn = (ctx: TestContext) => Promise<void>;

/** Test definition */
interface TestDef {
  name: string;
  fn: TestFn;
  skip?: boolean;
  /** If true, this test can run in parallel with other parallel tests */
  parallel?: boolean;
}

/** Test file module */
interface TestModule {
  default?: TestDef[];
  tests?: TestDef[];
}

/**
 * Parse command line arguments.
 */
function parseArgs(): {
  suite?: string;
  verbose: boolean;
  discover: boolean;
  restart: boolean;
  fresh: boolean;
  sequential: boolean;
  failFast: boolean;
  help: boolean;
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
  };

  for (const arg of args) {
    if (arg.startsWith("--suite=")) {
      result.suite = arg.slice(8);
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

/**
 * Print usage help.
 */
function printHelp(): void {
  console.log(`
E2E Test Runner for PeerVault

Usage: bun run test:e2e [options]

Options:
  --suite=<name>     Run only the specified test suite
  --verbose, -v      Enable verbose output
  --discover         Only discover vaults, don't run tests
  --restart, -r      Kill and restart Obsidian before tests
  --fresh, -f        Full reset: delete plugins, restart, reinstall via BRAT
  --sequential, -s   Disable parallel test execution
  --slow             Use longer timeouts for debugging
  --no-fail-fast     Don't abort after consecutive failures (default: abort after 3)
  --help, -h         Show this help message

Available suites:
${TEST_SUITES.map((s) => `  - ${s}`).join("\n")}

Prerequisites (if not using --restart):
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
 * Start Obsidian in dev mode with both test vaults.
 */
async function startObsidian(cfg: ReturnType<typeof getConfig>): Promise<void> {
  console.log("Starting Obsidian in dev mode...");

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
      const vaultsMap = await discoverVaults(cdpPort);
      const vaults = Array.from(vaultsMap.values());
      const hasTest = vaults.some((v) => v.title.includes("TEST") && !v.title.includes("TEST2"));

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

          const vaults2Map = await discoverVaults(cdpPort);
          const vaults2 = Array.from(vaults2Map.values());
          const hasTest2 = vaults2.some((v) => v.title.includes("TEST2"));

          if (hasTest2) {
            console.log(`Both vaults ready after ${elapsed + vault2Elapsed}ms total`);

            // Give plugins time to initialize
            console.log("Waiting for plugins to initialize...");
            await new Promise((r) => setTimeout(r, 5000));
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
  cdpPort: number,
  vaultTitle: string
): Promise<void> {
  // Find the vault's CDP target
  const list = await fetch(`http://localhost:${cdpPort}/json/list`).then(r => r.json()) as Array<{title: string; webSocketDebuggerUrl: string}>;
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
async function freshInstall(cfg: ReturnType<typeof getConfig>): Promise<void> {
  console.log("\n=== Fresh Install Mode ===");

  // Delete plugins from both vaults
  console.log("Deleting existing peervault plugins...");
  await deletePlugin(cfg.vaults.TEST.path);
  await deletePlugin(cfg.vaults.TEST2.path);

  // Ensure plugins are enabled in config (so Obsidian knows to load them after BRAT installs)
  console.log("Updating plugin configs...");
  await enablePluginInConfig(cfg.vaults.TEST.path);
  await enablePluginInConfig(cfg.vaults.TEST2.path);
}

/**
 * Install plugins after Obsidian starts.
 */
async function installPluginsViaBrat(cfg: ReturnType<typeof getConfig>): Promise<void> {
  console.log("Installing peervault via BRAT...");

  // Install in TEST first, then TEST2
  await installViaBrat(cfg.cdp.port, "TEST");

  // Small delay between installations
  await new Promise(r => setTimeout(r, 2000));

  await installViaBrat(cfg.cdp.port, "TEST2");

  console.log("Plugin installation complete. Waiting for initialization...");
  await new Promise(r => setTimeout(r, 5000));
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
        const module: TestModule = await import(filePath);
        const tests = module.default || module.tests || [];
        for (const test of tests) {
          allTests.push({ test, file });
        }
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

    // Run tests, batching parallel ones together
    let parallelBatch: Array<{ test: TestDef; file: string }> = [];

    const runParallelBatch = async (): Promise<boolean> => {
      if (parallelBatch.length === 0) return true;
      if (shouldAbort()) return false;

      if (parallelBatch.length === 1 || sequentialMode) {
        // Just run sequentially if only one test or sequential mode
        for (const { test } of parallelBatch) {
          if (shouldAbort()) break;
          const result = await runTest(test.name, suiteName, () => test.fn(ctx));
          reporter.addTest(result);
          recordTestResult(result.passed);
          ctx.cleanupBetweenTests();
        }
      } else {
        // Run in parallel
        console.log(`  ⚡ Running ${parallelBatch.length} tests in parallel...`);
        const promises = parallelBatch.map(async ({ test }) => {
          const result = await runTest(test.name, suiteName, () => test.fn(ctx));
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

        // Run this test
        const result = await runTest(test.name, suiteName, () => test.fn(ctx));
        reporter.addTest(result);
        recordTestResult(result.passed);
        ctx.cleanupBetweenTests();

        if (shouldAbort()) break;
      }
    }

    // Flush any remaining parallel tests
    await runParallelBatch();

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

  const cfg = getConfig();
  console.log("PeerVault E2E Test Runner");
  console.log("=".repeat(60));
  console.log(`CDP Port: ${cfg.cdp.port}`);
  console.log(`Test Vault: ${cfg.vaults.TEST.name}`);
  console.log(`Test2 Vault: ${cfg.vaults.TEST2.name}`);
  console.log(`Mode: ${args.sequential ? "sequential" : "parallel"}`);
  console.log(`Timeouts: ${process.argv.includes("--slow") ? "slow" : "fast"}`);
  console.log(`Fail-fast: ${args.failFast ? `enabled (${MAX_CONSECUTIVE_FAILURES} failures)` : "disabled"}`);


  if (args.discover) {
    console.log("\nDiscovering vaults...\n");
    await printDiscoveredVaults(cfg.cdp.port);
    process.exit(0);
  }

  // Handle fresh flag - delete plugins before restart
  if (args.fresh) {
    await freshInstall(cfg);
  }

  // Handle restart flag - kill and restart Obsidian before tests
  if (args.restart) {
    killObsidian();
    await startObsidian(cfg);

    // If fresh install, reinstall plugins via BRAT after Obsidian starts
    if (args.fresh) {
      await installPluginsViaBrat(cfg);
    }
  }

  // Determine which suites to run
  let suitesToRun = TEST_SUITES;
  if (args.suite) {
    if (!TEST_SUITES.includes(args.suite)) {
      console.error(`Unknown suite: ${args.suite}`);
      console.error(`Available: ${TEST_SUITES.join(", ")}`);
      process.exit(1);
    }
    suitesToRun = [args.suite];
  }

  console.log(`\nSuites to run: ${suitesToRun.join(", ")}`);
  console.log("=".repeat(60));

  // Create test context
  let ctx: TestContext;
  try {
    ctx = await createTestContext();
  } catch (err) {
    console.error("\nFailed to create test context:");
    console.error(err instanceof Error ? err.message : err);
    console.error("\nMake sure:");
    console.error("  1. Obsidian is running with --remote-debugging-port=9222");
    console.error("  2. Both TEST and TEST2 vaults are open");
    process.exit(1);
  }

  const reporter = new TestReporter();
  const startTime = Date.now();

  try {
    // If running a single suite (not 00-setup or 01-pairing), ensure peers are connected
    // Suites 02+ depend on pairing being complete
    const isIsolatedRun = args.suite !== undefined;
    const needsPairing = isIsolatedRun &&
      args.suite !== "00-setup" &&
      args.suite !== "01-pairing";

    if (needsPairing) {
      console.log("\nRunning isolated suite - checking peer connection...");
      try {
        const peers = await ctx.test.plugin.getConnectedPeers();
        if (peers.length === 0) {
          console.warn("Warning: No peers connected. Sync tests may fail.");
          console.warn("Run full test suite or 01-pairing first to establish peers.");
        } else {
          console.log(`Found ${peers.length} connected peer(s)`);
        }
      } catch (err) {
        console.warn("Warning: Could not check peer status:", err);
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
  console.log(`\nTotal time: ${totalTime}ms`);

  // Exit with appropriate code
  process.exit(reporter.hasFailures() ? 1 : 0);
}

// Run
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
