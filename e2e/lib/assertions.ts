/**
 * Custom Assertions
 *
 * Test assertion helpers for E2E tests.
 * Simplified for the new WASM-based plugin architecture.
 */

import type { VaultController } from "./vault-controller";
import type { PluginAPI, PeerInfo } from "./plugin-api";

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
 * Assert that the plugin is enabled.
 */
export async function assertPluginEnabled(plugin: PluginAPI): Promise<void> {
  const enabled = await plugin.isEnabled();
  if (!enabled) {
    throw new AssertionError("Plugin is not enabled");
  }
}

/**
 * Assert that the plugin is ready.
 */
export async function assertPluginReady(plugin: PluginAPI): Promise<void> {
  const ready = await plugin.isReady();
  if (!ready) {
    throw new AssertionError("Plugin is not ready");
  }
}

/**
 * Assert that the plugin has no peers.
 */
export async function assertNoPeers(plugin: PluginAPI): Promise<void> {
  const peers = await plugin.getPeers();
  if (peers.length > 0) {
    throw new AssertionError(
      `Expected no peers, but found ${peers.length}: ${peers.map((p) => p.id.slice(0, 8)).join(", ")}`
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
  const peers = await plugin.getPeers();
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
  peerId: string
): Promise<void> {
  const peers = await plugin.getPeers();
  const peer = peers.find(
    (p) => p.id === peerId || p.id.startsWith(peerId.slice(0, 8))
  );

  if (!peer) {
    throw new AssertionError(`Peer ${peerId.slice(0, 8)} not found`);
  }

  if (!peer.isConnected) {
    throw new AssertionError(
      `Peer ${peerId.slice(0, 8)} is not connected`
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
  const files = await plugin.listFiles();
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
  const files = await plugin.listFiles();
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

// ============ Retry and Polling assertions ============

/** Options for retry helpers */
export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  message?: string;
}

/**
 * Retry an async assertion function multiple times until it passes.
 */
export async function assertWithRetry(
  fn: () => Promise<void>,
  options: RetryOptions = {}
): Promise<{ attempts: number }> {
  const { maxAttempts = 3, delayMs = 1000, message } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return { attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  const errorMsg = message || `Assertion failed after ${maxAttempts} attempts`;
  throw new AssertionError(
    `${errorMsg}: ${lastError?.message || "unknown error"}`
  );
}

/**
 * Retry a check function until it returns true or max attempts reached.
 */
export async function retryCheck<T>(
  check: () => Promise<T>,
  validate: (result: T) => boolean,
  options: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await check();
    if (validate(result)) {
      return result;
    }

    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Return final result even if validation failed
  return check();
}

/** Options for assertEventually */
export interface AssertEventuallyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  message?: string;
}

/**
 * Assert that an async condition becomes true within a timeout.
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
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const errorMsg = message || "Condition did not become true";
  const details = lastError ? ` (last error: ${lastError.message})` : "";
  throw new AssertionError(`${errorMsg} after ${timeoutMs}ms${details}`);
}

/**
 * Assert that both vaults have the same CRDT file list.
 */
export async function assertFileListConverges(
  plugin1: PluginAPI,
  plugin2: PluginAPI,
  options: {
    timeoutMs?: number;
    stableChecks?: number;
  } = {}
): Promise<{ files: string[]; duration: number }> {
  const { timeoutMs = 20000, stableChecks = 3 } = options;

  const startTime = Date.now();
  const pollIntervalMs = 500;
  let matchCount = 0;
  let lastMatchedList: string[] | null = null;
  let lastFiles1: string[] = [];
  let lastFiles2: string[] = [];

  while (Date.now() - startTime < timeoutMs) {
    const [files1, files2] = await Promise.all([
      plugin1.listFiles(),
      plugin2.listFiles(),
    ]);

    lastFiles1 = files1.sort();
    lastFiles2 = files2.sort();

    const list1Str = JSON.stringify(lastFiles1);
    const list2Str = JSON.stringify(lastFiles2);

    if (list1Str === list2Str) {
      const currentList = JSON.stringify(lastFiles1);
      if (lastMatchedList === currentList) {
        matchCount++;
      } else {
        lastMatchedList = currentList;
        matchCount = 1;
      }

      if (matchCount >= stableChecks) {
        return { files: lastFiles1, duration: Date.now() - startTime };
      }
    } else {
      matchCount = 0;
      lastMatchedList = null;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const only1 = lastFiles1.filter((f) => !lastFiles2.includes(f));
  const only2 = lastFiles2.filter((f) => !lastFiles1.includes(f));

  throw new AssertionError(
    `CRDT file lists did not converge after ${timeoutMs}ms.\n` +
      `Only in plugin1: [${only1.join(", ")}]\n` +
      `Only in plugin2: [${only2.join(", ")}]`
  );
}

/**
 * Assert that a file converges to the same content in both vaults.
 */
export async function assertConvergesTo(
  vault1: VaultController,
  vault2: VaultController,
  path: string,
  options: { timeoutMs?: number; stableChecks?: number } = {}
): Promise<{ content: string; duration: number }> {
  const { timeoutMs = 30000, stableChecks = 2 } = options;

  const startTime = Date.now();
  const pollIntervalMs = 500;
  let matchCount = 0;
  let lastMatchedContent: string | null = null;
  let lastContent1 = "";
  let lastContent2 = "";

  while (Date.now() - startTime < timeoutMs) {
    try {
      const [content1, content2] = await Promise.all([
        vault1.readFile(path),
        vault2.readFile(path),
      ]);

      lastContent1 = content1;
      lastContent2 = content2;

      if (content1 === content2) {
        if (lastMatchedContent === content1) {
          matchCount++;
        } else {
          lastMatchedContent = content1;
          matchCount = 1;
        }

        if (matchCount >= stableChecks) {
          return { content: content1, duration: Date.now() - startTime };
        }
      } else {
        matchCount = 0;
        lastMatchedContent = null;
      }
    } catch {
      matchCount = 0;
      lastMatchedContent = null;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new AssertionError(
    `File "${path}" did not converge after ${timeoutMs}ms.\n` +
      `Vault1: "${lastContent1.slice(0, 150)}${lastContent1.length > 150 ? "..." : ""}"\n` +
      `Vault2: "${lastContent2.slice(0, 150)}${lastContent2.length > 150 ? "..." : ""}"`
  );
}
