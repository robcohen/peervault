#!/usr/bin/env bun
/**
 * Scaled E2E Test Runner
 *
 * Runs tests against N Docker containers, each running a single Obsidian vault.
 * Usage: bun run test:e2e:scaled [--clients=N] [--suite=<suite-name>] [--verbose]
 *
 * Environment variables:
 *   E2E_CDP_ENDPOINTS - Comma-separated list of host:port pairs for CDP connections
 *                       Example: "localhost:9222,localhost:9223,localhost:9224"
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getConfig, getCDPEndpoints, delay, isScaledMode } from "./config";
import { createScaledContext, type ScaledTestContext, type ClientContext } from "./lib/scaled-context";

// Scaled test suites
const SCALED_TEST_SUITES = [
  "scaled-00-setup",
  "scaled-01-mesh",
  "scaled-02-stress",
  "scaled-03-benchmarks",
  "scaled-04-chaos",
];

/** Test function signature for scaled tests */
type ScaledTestFn = (ctx: ScaledTestContext) => Promise<void>;

/** Scaled test definition */
interface ScaledTestDef {
  name: string;
  fn: ScaledTestFn;
  skip?: boolean;
  /** Minimum number of clients required for this test */
  minClients?: number;
  /** Tags for filtering */
  tags?: string[];
}

/** Test result */
interface TestResult {
  name: string;
  suite: string;
  passed: boolean;
  skipped?: boolean;
  error?: Error;
  duration: number;
}

/** Suite result */
interface SuiteResult {
  name: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  duration: number;
}

/**
 * Parse command line arguments.
 */
function parseArgs(): {
  suite?: string;
  verbose: boolean;
  help: boolean;
  numClients: number;
} {
  const args = process.argv.slice(2);
  const result = {
    suite: undefined as string | undefined,
    verbose: false,
    help: false,
    numClients: 3,
  };

  for (const arg of args) {
    if (arg.startsWith("--suite=")) {
      result.suite = arg.slice(8);
    } else if (arg.startsWith("--clients=")) {
      result.numClients = parseInt(arg.slice(10), 10) || 3;
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
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
Scaled E2E Test Runner for PeerVault

Usage: bun run test:e2e:scaled [options]

Options:
  --clients=N        Number of clients to test with (default: 3)
  --suite=<name>     Run only the specified test suite
  --verbose, -v      Enable verbose output
  --help, -h         Show this help message

Environment variables:
  E2E_CDP_ENDPOINTS  Comma-separated CDP endpoints (host:port,host:port,...)
                     If not set, uses localhost:9222, localhost:9223, etc.

Available suites:
${SCALED_TEST_SUITES.map((s) => `  - ${s}`).join("\n")}

Docker setup:
  1. Generate docker-compose with N clients:
     ./docker/e2e/generate-compose.sh N docker/e2e/docker-compose.generated.yml

  2. Start containers:
     docker compose -f docker/e2e/docker-compose.generated.yml up -d

  3. Wait for containers to be healthy, then run tests:
     bun run test:e2e:scaled --clients=N
`);
}

/**
 * Test reporter for tracking results.
 */
class TestReporter {
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

    this.currentSuite.passed = this.currentSuite.tests.filter((t) => t.passed).length;
    this.currentSuite.failed = this.currentSuite.tests.filter((t) => !t.passed).length;
    this.currentSuite.duration = this.currentSuite.tests.reduce((sum, t) => sum + t.duration, 0);

    this.suites.push(this.currentSuite);
    const result = this.currentSuite;
    this.currentSuite = null;
    return result;
  }

  addTest(result: TestResult): void {
    if (this.currentSuite) {
      this.currentSuite.tests.push(result);
    }

    const status = result.passed ? "✓" : result.skipped ? "⊘" : "✗";
    const duration = `(${result.duration}ms)`;

    if (result.skipped) {
      console.log(`${status} ${result.name} (skipped)`);
    } else if (result.passed) {
      console.log(`${status} ${result.name} ${duration}`);
    } else {
      console.log(`${status} ${result.name} ${duration}\n    Error: ${result.error?.message}`);
    }
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

      const failed = suite.tests.filter((t) => !t.passed && !t.skipped);
      for (const test of failed) {
        console.log(`    ✗ ${test.name}: ${test.error?.message}`);
      }

      totalPassed += suite.passed;
      totalFailed += suite.failed;
      totalDuration += suite.duration;
    }

    console.log("\n" + "-".repeat(60));
    console.log(`Total: ${totalPassed}/${totalPassed + totalFailed} passed (${totalDuration}ms)`);

    if (totalFailed > 0) {
      console.log(`\n❌ ${totalFailed} test(s) failed`);
    } else {
      console.log(`\n✅ All tests passed!`);
    }
  }

  hasFailures(): boolean {
    return this.suites.some((s) => s.failed > 0);
  }
}

/**
 * Run a single test.
 */
async function runTest(
  test: ScaledTestDef,
  suite: string,
  ctx: ScaledTestContext
): Promise<TestResult> {
  const startTime = Date.now();

  // Check minimum client requirement
  if (test.minClients && ctx.numClients < test.minClients) {
    return {
      name: test.name,
      suite,
      passed: true,
      skipped: true,
      duration: 0,
    };
  }

  try {
    await test.fn(ctx);
    return {
      name: test.name,
      suite,
      passed: true,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      name: test.name,
      suite,
      passed: false,
      error: error instanceof Error ? error : new Error(String(error)),
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Load and run tests from a suite directory.
 */
async function runSuite(
  suiteName: string,
  ctx: ScaledTestContext,
  reporter: TestReporter
): Promise<void> {
  const suitePath = join(import.meta.dir, "tests", suiteName);

  reporter.startSuite(suiteName);

  try {
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

    for (const file of testFiles) {
      const filePath = join(suitePath, file);
      try {
        const module = await import(filePath);
        const tests: ScaledTestDef[] = module.default || module.tests || [];

        for (const test of tests) {
          if (test.skip) {
            reporter.addTest({
              name: test.name,
              suite: suiteName,
              passed: true,
              skipped: true,
              duration: 0,
            });
            continue;
          }

          const result = await runTest(test, suiteName, ctx);
          reporter.addTest(result);
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

  const endpoints = getCDPEndpoints();
  const config = getConfig();

  console.log("PeerVault Scaled E2E Test Runner");
  console.log("=".repeat(60));
  console.log(`Clients: ${endpoints.length}`);
  console.log(`CDP Endpoints:`);
  for (const ep of endpoints) {
    console.log(`  - ${ep.name}: ${ep.host}:${ep.port}`);
  }
  console.log("=".repeat(60));

  // Create scaled context
  let ctx: ScaledTestContext;
  try {
    ctx = await createScaledContext();
  } catch (err) {
    console.error("\nFailed to create scaled context:");
    console.error(err instanceof Error ? err.message : err);
    console.error("\nMake sure:");
    console.error("  1. Docker containers are running and healthy");
    console.error("  2. CDP ports are exposed and reachable");
    console.error("  3. E2E_CDP_ENDPOINTS is set correctly (or use --clients=N)");
    process.exit(1);
  }

  // Determine suites to run
  let suitesToRun = SCALED_TEST_SUITES;
  if (args.suite) {
    if (!SCALED_TEST_SUITES.includes(args.suite)) {
      console.error(`Unknown suite: ${args.suite}`);
      console.error(`Available: ${SCALED_TEST_SUITES.join(", ")}`);
      process.exit(1);
    }
    suitesToRun = [args.suite];
  }

  console.log(`\nSuites to run: ${suitesToRun.join(", ")}`);
  console.log("=".repeat(60));

  const reporter = new TestReporter();
  const startTime = Date.now();

  try {
    for (const suite of suitesToRun) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Suite: ${suite}`);
      console.log("=".repeat(60));

      await runSuite(suite, ctx, reporter);
    }
  } finally {
    await ctx.close();
  }

  const totalTime = Date.now() - startTime;

  reporter.printSummary();
  console.log(`\nTotal time: ${totalTime}ms`);

  process.exit(reporter.hasFailures() ? 1 : 0);
}

// Run
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
