/**
 * Custom Assertions
 *
 * Test assertion helpers for E2E tests.
 */

import type { VaultController } from "./vault-controller";
import type { PluginAPI, PeerInfo, SyncStatus } from "./plugin-api";

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Assert that a condition is true.
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new AssertionError(message);
  }
}

/**
 * Assert that two values are equal.
 */
export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);

  if (actualStr !== expectedStr) {
    throw new AssertionError(
      message || `Expected ${expectedStr}, got ${actualStr}`
    );
  }
}

/**
 * Assert that two values are not equal.
 */
export function assertNotEqual<T>(actual: T, notExpected: T, message?: string): void {
  const actualStr = JSON.stringify(actual);
  const notExpectedStr = JSON.stringify(notExpected);

  if (actualStr === notExpectedStr) {
    throw new AssertionError(
      message || `Expected value to not equal ${notExpectedStr}`
    );
  }
}

/**
 * Assert that a value is truthy.
 */
export function assertTruthy<T>(value: T, message?: string): asserts value {
  if (!value) {
    throw new AssertionError(message || `Expected truthy value, got ${value}`);
  }
}

/**
 * Assert that a value is falsy.
 */
export function assertFalsy(value: unknown, message?: string): void {
  if (value) {
    throw new AssertionError(message || `Expected falsy value, got ${value}`);
  }
}

/**
 * Assert that an array contains a value.
 */
export function assertContains<T>(array: T[], value: T, message?: string): void {
  if (!array.includes(value)) {
    throw new AssertionError(
      message || `Expected array to contain ${JSON.stringify(value)}`
    );
  }
}

/**
 * Assert that an array does not contain a value.
 */
export function assertNotContains<T>(array: T[], value: T, message?: string): void {
  if (array.includes(value)) {
    throw new AssertionError(
      message || `Expected array to not contain ${JSON.stringify(value)}`
    );
  }
}

/**
 * Assert that a string contains a substring.
 */
export function assertIncludes(str: string, substring: string, message?: string): void {
  if (!str.includes(substring)) {
    throw new AssertionError(
      message || `Expected "${str}" to include "${substring}"`
    );
  }
}

/**
 * Assert that a string matches a regex.
 */
export function assertMatches(str: string, regex: RegExp, message?: string): void {
  if (!regex.test(str)) {
    throw new AssertionError(
      message || `Expected "${str}" to match ${regex}`
    );
  }
}

/**
 * Assert that a number is greater than a value.
 */
export function assertGreaterThan(actual: number, expected: number, message?: string): void {
  if (actual <= expected) {
    throw new AssertionError(
      message || `Expected ${actual} to be greater than ${expected}`
    );
  }
}

/**
 * Assert that a number is less than a value.
 */
export function assertLessThan(actual: number, expected: number, message?: string): void {
  if (actual >= expected) {
    throw new AssertionError(
      message || `Expected ${actual} to be less than ${expected}`
    );
  }
}

/**
 * Assert that an async function throws.
 */
export async function assertThrows(
  fn: () => Promise<unknown>,
  expectedMessage?: string
): Promise<void> {
  let threw = false;
  let error: Error | null = null;

  try {
    await fn();
  } catch (e) {
    threw = true;
    error = e instanceof Error ? e : new Error(String(e));
  }

  if (!threw) {
    throw new AssertionError("Expected function to throw");
  }

  if (expectedMessage && error && !error.message.includes(expectedMessage)) {
    throw new AssertionError(
      `Expected error message to include "${expectedMessage}", got "${error.message}"`
    );
  }
}

// ============ Vault-specific assertions ============

/**
 * Assert that a file exists in the vault.
 */
export async function assertFileExists(
  vault: VaultController,
  path: string
): Promise<void> {
  const exists = await vault.fileExists(path);
  if (!exists) {
    throw new AssertionError(`File "${path}" does not exist in vault`);
  }
}

/**
 * Assert that a file does not exist in the vault.
 */
export async function assertFileNotExists(
  vault: VaultController,
  path: string
): Promise<void> {
  const exists = await vault.fileExists(path);
  if (exists) {
    throw new AssertionError(`File "${path}" exists in vault but should not`);
  }
}

/**
 * Assert that a file has specific content.
 */
export async function assertFileContent(
  vault: VaultController,
  path: string,
  expectedContent: string
): Promise<void> {
  const content = await vault.readFile(path);
  if (content !== expectedContent) {
    throw new AssertionError(
      `File "${path}" content mismatch.\n` +
        `Expected: "${expectedContent.slice(0, 200)}${expectedContent.length > 200 ? "..." : ""}"\n` +
        `Got: "${content.slice(0, 200)}${content.length > 200 ? "..." : ""}"`
    );
  }
}

/**
 * Assert that a file contains a substring.
 */
export async function assertFileContains(
  vault: VaultController,
  path: string,
  substring: string
): Promise<void> {
  const content = await vault.readFile(path);
  if (!content.includes(substring)) {
    throw new AssertionError(
      `File "${path}" does not contain "${substring}"`
    );
  }
}

/**
 * Assert that the vault has a specific number of files.
 */
export async function assertFileCount(
  vault: VaultController,
  expectedCount: number
): Promise<void> {
  const files = await vault.listFiles();
  if (files.length !== expectedCount) {
    throw new AssertionError(
      `Expected ${expectedCount} files, got ${files.length}`
    );
  }
}

/**
 * Assert that a vault is empty (no user files).
 */
export async function assertVaultEmpty(vault: VaultController): Promise<void> {
  const files = await vault.listFiles();
  if (files.length > 0) {
    throw new AssertionError(
      `Vault is not empty. Found files: ${files.join(", ")}`
    );
  }
}

// ============ Plugin-specific assertions ============

/**
 * Assert that the plugin has a specific status.
 */
export async function assertPluginStatus(
  plugin: PluginAPI,
  expectedStatus: SyncStatus
): Promise<void> {
  const status = await plugin.getStatus();
  if (status !== expectedStatus) {
    throw new AssertionError(
      `Expected plugin status "${expectedStatus}", got "${status}"`
    );
  }
}

/**
 * Assert that the plugin has no peers.
 */
export async function assertNoPeers(plugin: PluginAPI): Promise<void> {
  const peers = await plugin.getConnectedPeers();
  if (peers.length > 0) {
    throw new AssertionError(
      `Expected no peers, but found ${peers.length}: ${peers.map((p) => p.nodeId.slice(0, 8)).join(", ")}`
    );
  }
}

/**
 * Assert that the plugin has a specific number of peers.
 */
export async function assertPeerCount(
  plugin: PluginAPI,
  expectedCount: number
): Promise<void> {
  const peers = await plugin.getConnectedPeers();
  if (peers.length !== expectedCount) {
    throw new AssertionError(
      `Expected ${expectedCount} peers, got ${peers.length}`
    );
  }
}

/**
 * Assert that a peer is connected.
 */
export async function assertPeerConnected(
  plugin: PluginAPI,
  nodeId: string
): Promise<void> {
  const peers = await plugin.getConnectedPeers();
  const peer = peers.find(
    (p) => p.nodeId === nodeId || p.nodeId.startsWith(nodeId.slice(0, 8))
  );

  if (!peer) {
    throw new AssertionError(`Peer ${nodeId.slice(0, 8)} not found`);
  }

  if (peer.connectionState !== "connected") {
    throw new AssertionError(
      `Peer ${nodeId.slice(0, 8)} is not connected (state: ${peer.connectionState})`
    );
  }
}

/**
 * Assert that the plugin is enabled.
 */
export async function assertPluginEnabled(plugin: PluginAPI): Promise<void> {
  const enabled = await plugin.isEnabled();
  if (!enabled) {
    throw new AssertionError("Plugin is not enabled");
  }
}

/**
 * Assert that plugin version matches expected.
 */
export async function assertPluginVersion(
  plugin: PluginAPI,
  expectedVersion: string
): Promise<void> {
  const version = await plugin.getVersion();
  if (version !== expectedVersion) {
    throw new AssertionError(
      `Expected plugin version "${expectedVersion}", got "${version}"`
    );
  }
}

/**
 * Assert that a file is tracked in the CRDT.
 */
export async function assertInCrdt(
  plugin: PluginAPI,
  path: string
): Promise<void> {
  const files = await plugin.getCrdtFiles();
  if (!files.includes(path)) {
    throw new AssertionError(`File "${path}" not found in CRDT`);
  }
}

/**
 * Assert that a file is not tracked in the CRDT.
 */
export async function assertNotInCrdt(
  plugin: PluginAPI,
  path: string
): Promise<void> {
  const files = await plugin.getCrdtFiles();
  if (files.includes(path)) {
    throw new AssertionError(`File "${path}" should not be in CRDT but is`);
  }
}

// ============ Sync assertions ============

/**
 * Assert that two vaults have the same files.
 */
export async function assertVaultsInSync(
  vault1: VaultController,
  vault2: VaultController
): Promise<void> {
  const [files1, files2] = await Promise.all([
    vault1.listFiles(),
    vault2.listFiles(),
  ]);

  const sorted1 = [...files1].sort();
  const sorted2 = [...files2].sort();

  if (JSON.stringify(sorted1) !== JSON.stringify(sorted2)) {
    const only1 = files1.filter((f) => !files2.includes(f));
    const only2 = files2.filter((f) => !files1.includes(f));

    throw new AssertionError(
      `Vaults are not in sync.\n` +
        `Only in vault1: [${only1.join(", ")}]\n` +
        `Only in vault2: [${only2.join(", ")}]`
    );
  }
}

/**
 * Assert that a file has the same content in both vaults.
 */
export async function assertFileInSync(
  vault1: VaultController,
  vault2: VaultController,
  path: string
): Promise<void> {
  const [content1, content2] = await Promise.all([
    vault1.readFile(path),
    vault2.readFile(path),
  ]);

  if (content1 !== content2) {
    throw new AssertionError(
      `File "${path}" content differs between vaults.\n` +
        `Vault1: "${content1.slice(0, 100)}..."\n` +
        `Vault2: "${content2.slice(0, 100)}..."`
    );
  }
}

// ============ Polling assertions ============

/** Options for assertEventually */
export interface AssertEventuallyOptions {
  /** Timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Poll interval in milliseconds (default: 200) */
  pollIntervalMs?: number;
  /** Custom message on failure */
  message?: string;
}

/**
 * Assert that an async condition becomes true within a timeout.
 * Polls the condition function repeatedly until it returns true or times out.
 *
 * @param condition - Async function that returns true when condition is met
 * @param options - Timeout and polling options
 *
 * @example
 * // Wait for file to exist
 * await assertEventually(
 *   async () => await vault.fileExists("test.md"),
 *   { timeoutMs: 5000, message: "File should exist" }
 * );
 *
 * @example
 * // Wait for peer count
 * await assertEventually(
 *   async () => (await plugin.getConnectedPeers()).length >= 1,
 *   { timeoutMs: 30000 }
 * );
 */
export async function assertEventually(
  condition: () => Promise<boolean>,
  options: AssertEventuallyOptions = {}
): Promise<void> {
  const { timeoutMs = 10000, pollIntervalMs = 200, message } = options;

  const startTime = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await condition();
      if (result) return;
    } catch (err) {
      // Store the error for reporting but continue polling
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const errorMsg = message || "Condition did not become true";
  const details = lastError ? ` (last error: ${lastError.message})` : "";
  throw new AssertionError(`${errorMsg} after ${timeoutMs}ms${details}`);
}

/**
 * Assert that an async condition stays true for a duration.
 * Useful for verifying stability (e.g., no unexpected state changes).
 *
 * @param condition - Async function that should remain true
 * @param options - Duration and polling options
 */
export async function assertStable(
  condition: () => Promise<boolean>,
  options: { durationMs?: number; pollIntervalMs?: number; message?: string } = {}
): Promise<void> {
  const { durationMs = 2000, pollIntervalMs = 200, message } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < durationMs) {
    const result = await condition();
    if (!result) {
      throw new AssertionError(
        message || `Condition became false after ${Date.now() - startTime}ms`
      );
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
