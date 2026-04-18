# PeerVault E2E Testing Guide

This guide explains the E2E test suite for PeerVault, including how to run tests, write new tests, and troubleshoot issues.

## Overview

The E2E test suite runs against real Obsidian instances via Chrome DevTools Protocol (CDP). It tests the full sync flow between two vaults (TEST and TEST2) to verify:

- Plugin connectivity and initialization
- Peer pairing and authentication
- File creation, modification, deletion, and rename sync
- CRDT conflict resolution
- Error recovery and reconnection
- Edge cases (unicode, binary files, special characters)

## Prerequisites

1. **Obsidian** installed with two test vaults: `TEST` and `TEST2`
2. **PeerVault plugin** installed in both vaults (via BRAT or manual install)
3. **Bun** runtime installed

## Running Tests

### Basic Usage

```bash
# Start Obsidian with CDP enabled (required)
obsidian --remote-debugging-port=9222

# Open both TEST and TEST2 vaults in Obsidian

# Run all tests
bun run test:e2e

# Run with auto-restart (kills and restarts Obsidian)
bun run test:e2e --restart

# Fresh install (deletes plugins and reinstalls via BRAT)
bun run test:e2e --fresh
```

### Filtering Tests

```bash
# Run specific suite
bun run test:e2e --suite=02-sync-basic

# Run tests by tag
bun run test:e2e --tags=smoke           # Quick sanity checks
bun run test:e2e --tags=protocol        # Sync protocol tests
bun run test:e2e --tags=conflict        # Conflict resolution tests

# Exclude slow tests
bun run test:e2e --exclude-tags=slow

# Combine filters
bun run test:e2e --suite=04-conflicts --tags=conflict
```

### Available Tags

| Tag | Description |
|-----|-------------|
| `smoke` | Quick sanity checks (fast CI subset) |
| `slow` | Long-running tests (skip for quick iteration) |
| `protocol` | Sync protocol tests |
| `transport` | Transport layer tests |
| `conflict` | Conflict resolution tests |
| `recovery` | Error recovery tests |
| `edge-case` | Edge case tests |

### Other Options

```bash
--verbose, -v         # Enable verbose output
--sequential, -s      # Disable parallel test execution
--slow                # Use longer timeouts for debugging
--no-fail-fast        # Continue after failures (default: abort after 3)
--no-validate-state   # Disable state validation between tests
--no-auto-cleanup     # Disable automatic cleanup of test files
--strict              # Strict mode: fail on any state warnings
--discover            # List available vaults without running tests
--help, -h            # Show help
```

### Environment Variables

```bash
CDP_PORT=9222              # Override CDP port
TEST_VAULT_PATH=/path      # Override TEST vault path
TEST2_VAULT_PATH=/path     # Override TEST2 vault path
E2E_TIMEOUT_MULTIPLIER=2   # Scale all timeouts (useful for slow machines)
```

## Test Structure

### Directory Layout

```
e2e/
├── config.ts           # Test configuration (timeouts, paths)
├── runner.ts           # Main test runner
├── TESTING.md          # This file
├── lib/
│   ├── assertions.ts   # Test assertions
│   ├── cdp-client.ts   # CDP WebSocket client
│   ├── cdp-discovery.ts # Vault discovery via CDP
│   ├── context.ts      # Test context and reporter
│   ├── isolation-manager.ts # Test isolation and cleanup
│   ├── plugin-api.ts   # Plugin interaction API
│   ├── state-manager.ts # Test state management
│   ├── state-validator.ts # State validation between tests
│   ├── sync-waiter.ts  # Sync waiting utilities
│   ├── test-utils.ts   # Common test helpers
│   └── vault-controller.ts # Vault file operations
├── fixtures/           # Test fixture files
└── tests/
    ├── 00-setup/       # Connection and plugin verification
    ├── 01-pairing/     # Peer pairing tests
    ├── 02-sync-basic/  # Basic sync operations
    ├── 03-sync-advanced/ # Bulk, binary, stress tests
    ├── 04-conflicts/   # Conflict resolution
    ├── 05-error-recovery/ # Recovery tests
    ├── 06-edge-cases/  # Unicode, special files
    └── 07-transport/   # Transport layer tests
```

### Test File Format

Tests are TypeScript files exporting an array of test definitions:

```typescript
import type { TestContext } from "../../lib/context";
import { assert, assertFileExists } from "../../lib/assertions";

export default [
  {
    name: "My test name",
    tags: ["smoke", "protocol"],    // Optional: for filtering
    retryOnFailure: 1,              // Optional: retry on failure
    parallel: true,                 // Optional: can run in parallel
    skip: false,                    // Optional: skip this test
    skipAutoCleanup: false,         // Optional: skip auto-cleanup for this test
    async fn(ctx: TestContext) {
      // Test implementation
      await ctx.test.vault.createFile("test.md", "content");
      await ctx.test2.sync.waitForFile("test.md");
      await assertFileExists(ctx.test2.vault, "test.md");
    },
    // Optional: test-level beforeEach hook
    beforeEach: async (ctx: TestContext) => {
      console.log("Running before this test");
    },
    // Optional: test-level afterEach hook
    afterEach: async (ctx: TestContext) => {
      console.log("Running after this test");
    },
  },
];
```

### Suite-Level Hooks

Test files can export suite-level hooks for setup/teardown:

```typescript
import type { TestContext } from "../../lib/context";

// Run once before all tests in this suite
export async function beforeAll(ctx: TestContext): Promise<void> {
  console.log("Suite setup");
}

// Run once after all tests in this suite
export async function afterAll(ctx: TestContext): Promise<void> {
  console.log("Suite teardown - cleaning up files");
  await ctx.test.vault.deleteFolder("test-data");
}

// Run before each test in this suite (can be overridden by test-level beforeEach)
export async function beforeEach(ctx: TestContext): Promise<void> {
  console.log("Before each test");
}

// Run after each test in this suite (can be overridden by test-level afterEach)
export async function afterEach(ctx: TestContext): Promise<void> {
  console.log("After each test");
}

// Enable automatic cleanup of files created during each test
export const autoCleanup = true;

export default [
  // ... test definitions
];
```

## Writing Tests

### Test Context

Every test receives a `TestContext` with access to both vaults:

```typescript
interface TestContext {
  test: VaultContext;    // TEST vault
  test2: VaultContext;   // TEST2 vault

  // Cross-vault utilities
  waitForConvergence(timeoutMs?: number): Promise<void>;
  waitForFileListMatch(timeoutMs?: number): Promise<void>;

  // Cleanup
  cleanupBetweenTests(): void;
  resetFiles(): Promise<void>;
  resetAll(): Promise<void>;
  close(): Promise<void>;
}

interface VaultContext {
  name: string;
  vault: VaultController;  // File operations
  plugin: PluginAPI;       // Plugin interactions
  sync: SyncWaiter;        // Sync waiting utilities
  state: StateManager;     // State management
}
```

### Common Patterns

#### Create and verify sync

```typescript
// Create file on TEST, verify it syncs to TEST2
await ctx.test.vault.createFile("new-file.md", "content");
await ctx.test2.sync.waitForFile("new-file.md");
await assertFileContent(ctx.test2.vault, "new-file.md", "content");
```

#### Wait for CRDT convergence

```typescript
// Wait for both vaults to have same CRDT version
await ctx.waitForConvergence();

// Or with timeout
await ctx.waitForConvergence(30000);
```

#### Verify bidirectional sync

```typescript
import { verifyBidirectionalSync } from "../../lib/test-utils";

const timing = await verifyBidirectionalSync(ctx);
console.log(`Sync times: TEST->TEST2: ${timing.test1ToTest2}ms, TEST2->TEST1: ${timing.test2ToTest1}ms`);
```

#### Wait for live sessions

```typescript
import { waitForLiveSessions } from "../../lib/test-utils";

await waitForLiveSessions(ctx, 60000);
```

### Available Assertions

#### Basic assertions

```typescript
assert(condition, message);           // Basic assertion
assertEqual(actual, expected);        // Equality check
assertNotEqual(actual, expected);     // Inequality check
```

#### File assertions

```typescript
assertFileExists(vault, path);        // File exists
assertFileNotExists(vault, path);     // File doesn't exist
assertFileContent(vault, path, content); // Exact content match
assertFileContains(vault, path, substring); // Contains substring
assertFileCount(vault, count);        // File count
assertVaultEmpty(vault);              // Vault has no files
```

#### Sync assertions

```typescript
assertVaultsInSync(vault1, vault2);   // Same file lists
assertFileInSync(vault1, vault2, path); // Same content
assertBinaryFileInSync(vault1, vault2, path); // Binary match
```

#### Cross-vault assertions (with polling)

```typescript
assertFileListConverges(plugin1, plugin2);  // CRDT file lists match
assertSessionsLive(plugin1, plugin2);       // Both have live sessions
assertCrdtConverged(plugin1, plugin2);      // CRDT versions match
assertNoPendingWrites(plugin);              // No pending writes
assertNoErrorSessions(plugin1, plugin2);    // No error sessions
```

#### Polling assertions

```typescript
// Wait for condition to become true
await assertEventually(
  async () => await vault.fileExists("test.md"),
  { timeoutMs: 5000, message: "File should exist" }
);

// Wait for file content to converge between vaults
await assertConvergesTo(vault1, vault2, "test.md", { timeoutMs: 10000 });

// Wait for value to stabilize
await assertEventuallyStable(
  () => plugin.getStatus(),
  "idle",
  { stableDurationMs: 2000 }
);
```

### Test Utilities

```typescript
import {
  waitForLiveSessions,
  verifyBidirectionalSync,
  ensureSyncedState,
  createTestFile,
  waitFor,
  withRetry,
  measureTime,
  cleanupTestFiles,
  getSyncStateSummary,
} from "../../lib/test-utils";

// Ensure sync is operational before test
await ensureSyncedState(ctx, { verifyBidirectional: true });

// Create unique test file
const { path, content } = createTestFile("my-test");

// Measure operation time
const { result, durationMs } = await measureTime(() =>
  ctx.test.vault.createFile(path, content)
);

// Retry flaky operation
await withRetry(() => riskyOperation(), { maxRetries: 3 });

// Clean up test files
await cleanupTestFiles(ctx, /^_test-/);

// Get sync state for debugging
const state = await getSyncStateSummary(ctx);
console.log(state);
```

## Test Isolation

The test runner provides features to ensure tests don't interfere with each other:

### Automatic Cleanup

Enable automatic cleanup to remove files created during each test:

```typescript
// In your test file
export const autoCleanup = true;

export default [
  {
    name: "My test",
    async fn(ctx: TestContext) {
      // Files created here will be automatically deleted after the test
      await ctx.test.vault.createFile("temp.md", "content");
    },
  },
];
```

The isolation manager captures file state before each test and removes any new files after.

Disable for specific tests:

```typescript
{
  name: "Test that needs files to persist",
  skipAutoCleanup: true,  // Files won't be auto-cleaned
  async fn(ctx: TestContext) {
    // ...
  },
}
```

### Manual Cleanup with Hooks

For suites where tests depend on each other, use `afterAll` for cleanup:

```typescript
/** Files to clean up after the suite */
const SUITE_FILES = ["test-1.md", "test-2.md", "folder/test.md"];

export async function afterAll(ctx: TestContext): Promise<void> {
  for (const file of SUITE_FILES) {
    try { await ctx.test.vault.deleteFile(file); } catch {}
    try { await ctx.test2.vault.deleteFile(file); } catch {}
  }
}
```

### Disabling Auto-Cleanup

```bash
# Disable auto-cleanup globally
bun run test:e2e --no-auto-cleanup
```

### Isolation Manager

The isolation manager (`e2e/lib/isolation-manager.ts`) provides:

- `captureBaseline()` - Capture baseline state at start of suite
- `captureBeforeTest()` - Capture state before each test
- `cleanupAfterTest()` - Remove files created during test
- `cleanupPatternMatches()` - Remove files matching known test patterns
- `restoreToBaseline()` - Restore to baseline state

## State Validation

The test runner automatically validates state between tests to detect issues:

### What It Checks

- **Error sessions**: Any sync session in error state
- **Stuck sessions**: Sessions stuck in `exchanging_versions`, `syncing`, or `connecting`
- **Pending writes**: Unfinished write operations
- **CRDT divergence**: Version mismatch between vaults
- **File count mismatch**: Different file counts in CRDT
- **Peer asymmetry**: Different peer counts between vaults
- **Plugin error status**: Plugin in error state

### Modes

```bash
# Default: enabled, logs warnings/errors but doesn't fail
bun run test:e2e

# Strict mode: fail if any state issues detected
bun run test:e2e --strict

# Disabled: skip state validation entirely
bun run test:e2e --no-validate-state
```

### Output

After each test, state issues are logged:

```
  State warnings (2):
    ⚠ [session] TEST has 1 potentially stuck session(s)
    ⚠ [crdt] CRDT versions differ between vaults
```

At the end of the run, a summary shows all issues:

```
------------------------------------------------------------
State validation issues:

  After "Concurrent edits to same file are merged":
    ⚠ [crdt] CRDT versions differ between vaults

Total: 0 errors, 1 warnings
```

### Using in Tests

You can also validate state programmatically:

```typescript
import { validateState, captureStateSnapshot } from "../../lib/state-validator";

// Capture state before operation
const before = await captureStateSnapshot(ctx);

// ... perform operation ...

// Validate state
const result = await validateState(ctx);
if (!result.valid) {
  console.log("State issues:", result.issues);
}
```

## Debugging

### Debug Output

Failed tests automatically capture debug output to `e2e/debug-output/`:

- `error.txt` - Error message and stack trace
- `traces-TEST.json` - Protocol traces from TEST vault
- `traces-TEST2.json` - Protocol traces from TEST2 vault
- `sessions.json` - Session states
- `crdt-files.json` - CRDT file lists
- `vault-files.json` - Vault file lists

### Manual Debugging

```bash
# List available vaults
bun run test:e2e --discover

# Run single suite with verbose output
bun run test:e2e --suite=04-conflicts --verbose

# Use longer timeouts
E2E_TIMEOUT_MULTIPLIER=3 bun run test:e2e --slow

# Disable fail-fast to see all failures
bun run test:e2e --no-fail-fast
```

### Common Issues

#### "Vault not found" error

1. Ensure Obsidian is running with `--remote-debugging-port=9222`
2. Ensure both TEST and TEST2 vaults are open
3. Run `bun run test:e2e --discover` to verify vault visibility

#### Tests timing out

1. Check network connectivity (relay servers)
2. Increase timeouts: `E2E_TIMEOUT_MULTIPLIER=2`
3. Check for error sessions in plugin settings

#### Sync not working

1. Verify peers are paired (Settings > PeerVault > Devices)
2. Check for error states in session list
3. Try plugin reload: Settings > Community plugins > Toggle PeerVault

#### "Sessions not live" errors

1. Sessions may be stuck in `exchanging_versions` state
2. Try running `00-setup` and `01-pairing` suites first
3. Check debug output for protocol traces

## Best Practices

1. **Use unique file names** - Include timestamps or random strings to avoid collisions
2. **Clean up after tests** - Delete test files to prevent state accumulation
3. **Wait for convergence** - Always wait for sync to complete before assertions
4. **Use stability checks** - Important values should be stable for multiple checks
5. **Tag appropriately** - Use `smoke` for quick tests, `slow` for long ones
6. **Add retries for flaky tests** - Use `retryOnFailure: 1` for timing-sensitive tests
7. **Document test purpose** - Add comments explaining what the test verifies

## Adding New Test Suites

1. Create directory: `e2e/tests/NN-suite-name/`
2. Add test files: `01-test-name.test.ts`
3. Register in `runner.ts` `TEST_SUITES` array
4. Add tags for filtering
5. Document in this guide
