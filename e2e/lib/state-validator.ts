/**
 * State Validator
 *
 * Simplified state validation for the new WASM-based plugin.
 */

import type { TestContext } from "./context";

/** State validation issue */
export interface StateIssue {
  severity: "warning" | "error";
  category: "peer" | "file" | "crdt";
  message: string;
  details?: Record<string, unknown>;
  transient?: boolean;
}

/** State validation result */
export interface StateValidationResult {
  valid: boolean;
  issues: StateIssue[];
  snapshot: StateSnapshot;
}

/** State snapshot for comparison */
export interface StateSnapshot {
  timestamp: number;
  test: VaultStateSnapshot;
  test2: VaultStateSnapshot;
}

/** Single vault state */
interface VaultStateSnapshot {
  peerCount: number;
  crdtFileCount: number;
  ready: boolean;
}

/**
 * Capture current state snapshot from both vaults.
 */
export async function captureStateSnapshot(
  ctx: TestContext
): Promise<StateSnapshot> {
  const [peers1, peers2, files1, files2, ready1, ready2] = await Promise.all([
    ctx.test.plugin.getPeers(),
    ctx.test2.plugin.getPeers(),
    ctx.test.plugin.listFiles(),
    ctx.test2.plugin.listFiles(),
    ctx.test.plugin.isReady(),
    ctx.test2.plugin.isReady(),
  ]);

  return {
    timestamp: Date.now(),
    test: {
      peerCount: peers1.length,
      crdtFileCount: files1.length,
      ready: ready1,
    },
    test2: {
      peerCount: peers2.length,
      crdtFileCount: files2.length,
      ready: ready2,
    },
  };
}

/**
 * Validate current state for issues.
 */
export async function validateState(
  ctx: TestContext
): Promise<StateValidationResult> {
  const issues: StateIssue[] = [];
  const snapshot = await captureStateSnapshot(ctx);

  // Check for plugin not ready
  if (!snapshot.test.ready) {
    issues.push({
      severity: "error",
      category: "peer",
      message: "TEST plugin is not ready",
    });
  }

  if (!snapshot.test2.ready) {
    issues.push({
      severity: "error",
      category: "peer",
      message: "TEST2 plugin is not ready",
    });
  }

  // Check for file count mismatch
  if (snapshot.test.crdtFileCount !== snapshot.test2.crdtFileCount) {
    issues.push({
      severity: "warning",
      category: "crdt",
      message: `CRDT file counts differ: TEST=${snapshot.test.crdtFileCount}, TEST2=${snapshot.test2.crdtFileCount}`,
    });
  }

  // Check peer count asymmetry
  if (snapshot.test.peerCount !== snapshot.test2.peerCount) {
    issues.push({
      severity: "warning",
      category: "peer",
      message: `Peer counts asymmetric: TEST=${snapshot.test.peerCount}, TEST2=${snapshot.test2.peerCount}`,
    });
  }

  return {
    valid: issues.filter((i) => i.severity === "error").length === 0,
    issues,
    snapshot,
  };
}

/**
 * Format issues for display.
 */
export function formatIssues(
  issues: StateIssue[],
  showTransient: boolean = true
): string {
  const displayIssues = showTransient
    ? issues
    : issues.filter((i) => !i.transient);

  if (displayIssues.length === 0) return "";

  const lines: string[] = [];

  const errors = displayIssues.filter((i) => i.severity === "error");
  const warnings = displayIssues.filter((i) => i.severity === "warning");

  if (errors.length > 0) {
    lines.push(`  State errors (${errors.length}):`);
    for (const issue of errors) {
      lines.push(`    ✗ [${issue.category}] ${issue.message}`);
    }
  }

  if (warnings.length > 0) {
    lines.push(`  State warnings (${warnings.length}):`);
    for (const issue of warnings) {
      lines.push(`    ⚠ [${issue.category}] ${issue.message}`);
    }
  }

  return lines.join("\n");
}

/**
 * State validator that tracks state across tests.
 */
export class StateValidator {
  private lastSnapshot: StateSnapshot | null = null;
  private allIssues: Array<{ test: string; issues: StateIssue[] }> = [];
  private enabled: boolean = true;

  constructor(options: { enabled?: boolean } = {}) {
    this.enabled = options.enabled ?? true;
  }

  /**
   * Capture state before a test runs.
   */
  async captureBeforeTest(ctx: TestContext): Promise<void> {
    if (!this.enabled) return;
    this.lastSnapshot = await captureStateSnapshot(ctx);
  }

  /**
   * Validate state after a test runs.
   */
  async validateAfterTest(
    ctx: TestContext,
    testName: string
  ): Promise<{ valid: boolean; issues: StateIssue[] }> {
    if (!this.enabled) {
      return { valid: true, issues: [] };
    }

    const result = await validateState(ctx);
    const issues = [...result.issues];

    if (issues.length > 0) {
      this.allIssues.push({ test: testName, issues });
    }

    this.lastSnapshot = result.snapshot;

    const hasErrors = issues.some((i) => i.severity === "error");
    return { valid: !hasErrors, issues };
  }

  /**
   * Get summary of all issues found.
   */
  getSummary(): string {
    if (this.allIssues.length === 0) {
      return "No state issues detected";
    }

    const lines: string[] = ["State validation issues:"];

    for (const { test, issues } of this.allIssues) {
      lines.push(`\n  After "${test}":`);
      lines.push(formatIssues(issues));
    }

    return lines.join("\n");
  }

  /**
   * Check if any errors were found.
   */
  hasErrors(): boolean {
    return this.allIssues.some((i) =>
      i.issues.some((issue) => issue.severity === "error")
    );
  }

  /**
   * Reset tracked issues.
   */
  reset(): void {
    this.allIssues = [];
    this.lastSnapshot = null;
  }
}
