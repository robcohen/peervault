#!/usr/bin/env bun
/**
 * E2E Test Runner
 *
 * Main orchestrator for running E2E tests against Obsidian vaults.
 * Usage: bun run test:e2e [--suite=<suite-name>] [--verbose]
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { config, getConfig } from "./config";
import {
  createTestContext,
  TestReporter,
  runTest,
  type TestContext,
  type TestResult,
} from "./lib/context";
import { printDiscoveredVaults } from "./lib/cdp-discovery";

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
  help: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    suite: undefined as string | undefined,
    verbose: false,
    discover: false,
    help: false,
  };

  for (const arg of args) {
    if (arg.startsWith("--suite=")) {
      result.suite = arg.slice(8);
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
    } else if (arg === "--discover") {
      result.discover = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    }
  }

  return result;
}

/**
 * Print usage help.
 */
function printHelp(): void {
  console.log(`
E2E Test Runner for PeerVault

Usage: bun run test:e2e [options]

Options:
  --suite=<name>   Run only the specified test suite
  --verbose, -v    Enable verbose output
  --discover       Only discover vaults, don't run tests
  --help, -h       Show this help message

Available suites:
${TEST_SUITES.map((s) => `  - ${s}`).join("\n")}

Prerequisites:
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
 * Load and run tests from a suite directory.
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

    // Run each test file
    for (const file of testFiles) {
      const filePath = join(suitePath, file);

      try {
        const module: TestModule = await import(filePath);
        const tests = module.default || module.tests || [];

        for (const test of tests) {
          if (test.skip) {
            // Report skipped test
            reporter.addTest({
              name: test.name,
              suite: suiteName,
              passed: true, // Skipped tests count as passed
              skipped: true,
              duration: 0,
            });
            console.log(`⊘ ${test.name} (skipped)`);
            continue;
          }

          const result = await runTest(test.name, suiteName, () =>
            test.fn(ctx)
          );
          reporter.addTest(result);

          // Clean up between tests (clear console buffers, etc.)
          ctx.cleanupBetweenTests();

          // Small delay between tests
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        // Failed to load/run test file
        reporter.addTest({
          name: `[Load ${file}]`,
          suite: suiteName,
          passed: false,
          error: err instanceof Error ? err : new Error(String(err)),
          duration: 0,
        });
      }
    }
  } catch (err) {
    // Failed to read suite directory
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

  const cfg = getConfig();
  console.log("PeerVault E2E Test Runner");
  console.log("=".repeat(60));
  console.log(`CDP Port: ${cfg.cdp.port}`);
  console.log(`Test Vault: ${cfg.vaults.TEST.name}`);
  console.log(`Test2 Vault: ${cfg.vaults.TEST2.name}`);

  if (args.discover) {
    console.log("\nDiscovering vaults...\n");
    await printDiscoveredVaults(cfg.cdp.port);
    process.exit(0);
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
