/**
 * Sync Waiter
 *
 * Utilities for waiting on sync completion between vaults.
 * Uses version vector comparison and file existence checks.
 * Features adaptive exponential backoff for efficient polling.
 */

import type { CDPClient } from "./cdp-client";
import { VaultController } from "./vault-controller";
import { PluginAPI } from "./plugin-api";
import { config } from "../config";

export interface SyncWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Exponential backoff polling utility.
 * Starts fast (minInterval) and backs off to maxInterval.
 * Returns early as soon as condition is met.
 */
async function pollWithBackoff<T>(
  check: () => Promise<T>,
  isComplete: (result: T) => boolean,
  options: {
    timeoutMs: number;
    minInterval?: number;
    maxInterval?: number;
    multiplier?: number;
  }
): Promise<{ success: true; result: T } | { success: false; lastResult: T | undefined }> {
  const {
    timeoutMs,
    minInterval = config.sync.minPollInterval,
    maxInterval = config.sync.maxPollInterval,
    multiplier = config.sync.backoffMultiplier,
  } = options;

  const startTime = Date.now();
  let currentInterval = minInterval;
  let lastResult: T | undefined;

  while (Date.now() - startTime < timeoutMs) {
    const result = await check();
    lastResult = result;

    if (isComplete(result)) {
      return { success: true, result };
    }

    await new Promise((r) => setTimeout(r, currentInterval));
    currentInterval = Math.min(currentInterval * multiplier, maxInterval);
  }

  return { success: false, lastResult };
}

/**
 * Waiter for sync operations between vaults.
 */
export class SyncWaiter {
  private vault: VaultController;
  private plugin: PluginAPI;

  constructor(
    private client: CDPClient,
    public readonly vaultName: string
  ) {
    this.vault = new VaultController(client, vaultName);
    this.plugin = new PluginAPI(client, vaultName);
  }

  /**
   * Wait for a specific file to appear in the vault.
   */
  async waitForFile(
    path: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const { timeoutMs = config.sync.defaultTimeout } = options;

    const result = await pollWithBackoff(
      () => this.vault.fileExists(path),
      (exists) => exists,
      { timeoutMs }
    );

    if (!result.success) {
      throw new Error(
        `File "${path}" not found in vault "${this.vaultName}" after ${timeoutMs}ms`
      );
    }
  }

  /**
   * Wait for a file to have specific content.
   */
  async waitForContent(
    path: string,
    expectedContent: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const { timeoutMs = config.sync.defaultTimeout } = options;

    let lastError: Error | undefined;
    let lastContent: string | undefined;

    const result = await pollWithBackoff(
      async () => {
        try {
          const content = await this.vault.readFile(path);
          lastContent = content;
          lastError = undefined;
          return { found: true, content };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const isFileNotFound = lastError.message.includes("not found");
          if (!isFileNotFound) {
            console.warn(`[SyncWaiter] Unexpected error reading ${path}:`, lastError.message);
          }
          return { found: false, content: undefined };
        }
      },
      (r) => r.found && r.content === expectedContent,
      { timeoutMs }
    );

    if (!result.success) {
      let details = "";
      if (lastContent !== undefined) {
        details = `Got: "${lastContent.slice(0, 100)}${lastContent.length > 100 ? "..." : ""}"`;
      } else if (lastError) {
        details = `Error: ${lastError.message}`;
      } else {
        details = "File not found";
      }

      throw new Error(
        `File "${path}" content mismatch after ${timeoutMs}ms. ` +
          `Expected: "${expectedContent.slice(0, 100)}${expectedContent.length > 100 ? "..." : ""}". ` +
          details
      );
    }
  }

  /**
   * Wait for a file to contain a substring.
   */
  async waitForContentContains(
    path: string,
    substring: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const { timeoutMs = config.sync.defaultTimeout } = options;

    let lastError: Error | undefined;
    let lastContent: string | undefined;

    const result = await pollWithBackoff(
      async () => {
        try {
          const content = await this.vault.readFile(path);
          lastContent = content;
          lastError = undefined;
          return { found: true, contains: content.includes(substring) };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const isFileNotFound = lastError.message.includes("not found");
          if (!isFileNotFound) {
            console.warn(`[SyncWaiter] Unexpected error reading ${path}:`, lastError.message);
          }
          return { found: false, contains: false };
        }
      },
      (r) => r.found && r.contains,
      { timeoutMs }
    );

    if (!result.success) {
      let details = "";
      if (lastContent !== undefined) {
        details = ` Current content: "${lastContent.slice(0, 100)}${lastContent.length > 100 ? "..." : ""}"`;
      } else if (lastError) {
        details = ` Error: ${lastError.message}`;
      }

      throw new Error(
        `File "${path}" does not contain "${substring}" after ${timeoutMs}ms.${details}`
      );
    }
  }

  /**
   * Wait for a file to be deleted from the vault.
   */
  async waitForFileDeletion(
    path: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const { timeoutMs = config.sync.defaultTimeout } = options;

    const result = await pollWithBackoff(
      () => this.vault.fileExists(path),
      (exists) => !exists,
      { timeoutMs }
    );

    if (!result.success) {
      throw new Error(
        `File "${path}" still exists in vault "${this.vaultName}" after ${timeoutMs}ms`
      );
    }
  }

  /**
   * Wait for plugin status to be a specific value.
   */
  async waitForStatus(
    status: "idle" | "syncing" | "offline" | "error",
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const { timeoutMs = config.sync.defaultTimeout } = options;

    const result = await pollWithBackoff(
      () => this.plugin.getStatus(),
      (current) => current === status,
      { timeoutMs }
    );

    if (result.success === false) {
      throw new Error(
        `Plugin status not "${status}" after ${timeoutMs}ms. Current: "${result.lastResult}"`
      );
    }
  }

  /**
   * Wait for sync to complete (status returns to idle).
   */
  async waitForSyncComplete(options: SyncWaitOptions = {}): Promise<void> {
    const { timeoutMs = config.sync.defaultTimeout } = options;

    let sawSyncing = false;
    let idleChecks = 0;

    const result = await pollWithBackoff(
      async () => {
        const status = await this.plugin.getStatus();

        if (status === "syncing") {
          sawSyncing = true;
          return { done: false, error: false };
        } else if (sawSyncing && status === "idle") {
          return { done: true, error: false };
        } else if (status === "idle") {
          // Already idle - wait a bit to confirm not just between syncs
          idleChecks++;
          if (idleChecks >= 2) return { done: true, error: false };
          return { done: false, error: false };
        } else if (status === "error") {
          return { done: false, error: true };
        }
        return { done: false, error: false };
      },
      (r) => r.done || r.error,
      { timeoutMs }
    );

    if (result.success && result.result.error) {
      throw new Error("Sync failed with error status");
    }

    if (!result.success) {
      throw new Error(`Sync did not complete after ${timeoutMs}ms`);
    }
  }

  /**
   * Wait for a peer to be connected.
   */
  async waitForPeerConnected(
    nodeId: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const { timeoutMs = config.sync.defaultTimeout } = options;
    const shortId = nodeId.slice(0, 8);

    const result = await pollWithBackoff(
      async () => {
        const peers = await this.plugin.getConnectedPeers();
        const peer = peers.find(
          (p) => p.nodeId === nodeId || p.nodeId.startsWith(shortId)
        );
        return peer?.connectionState === "connected";
      },
      (connected) => connected,
      { timeoutMs }
    );

    if (!result.success) {
      throw new Error(`Peer ${shortId} not connected after ${timeoutMs}ms`);
    }
  }

  /**
   * Wait for a session to reach a specific state.
   */
  async waitForSessionState(
    peerId: string,
    targetState: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const { timeoutMs = config.sync.defaultTimeout } = options;
    const shortId = peerId.slice(0, 8);

    const result = await pollWithBackoff(
      async () => {
        const sessions = await this.plugin.getSessionStates();
        const session = sessions.find(
          (s) => s.peerId === peerId || s.peerId.startsWith(shortId)
        );
        return { found: !!session, state: session?.state, sessions };
      },
      (r) => r.found && r.state === targetState,
      { timeoutMs }
    );

    if (result.success === false) {
      const sessions = result.lastResult?.sessions ?? [];
      throw new Error(
        `Session for ${shortId} not in state "${targetState}" after ${timeoutMs}ms. ` +
          `Sessions: ${JSON.stringify(sessions)}`
      );
    }
  }

  /**
   * Get the current CRDT version for comparison.
   */
  async getVersion(): Promise<string> {
    return await this.plugin.getDocumentVersion();
  }

  /**
   * Get all files tracked in the CRDT.
   */
  async getCrdtFiles(): Promise<string[]> {
    return await this.plugin.getCrdtFiles();
  }
}

/**
 * Wait for two vaults to have the same CRDT version (converged).
 */
export async function waitForVersionConvergence(
  waiter1: SyncWaiter,
  waiter2: SyncWaiter,
  options: SyncWaitOptions = {}
): Promise<void> {
  const { timeoutMs = config.sync.defaultTimeout } = options;

  const result = await pollWithBackoff(
    async () => {
      const [version1, version2] = await Promise.all([
        waiter1.getVersion(),
        waiter2.getVersion(),
      ]);
      return { version1, version2 };
    },
    (r) => !!(r.version1 && r.version2 && r.version1 === r.version2),
    { timeoutMs }
  );

  if (result.success === false) {
    const v1 = result.lastResult?.version1 ?? "unknown";
    const v2 = result.lastResult?.version2 ?? "unknown";
    throw new Error(
      `Versions did not converge after ${timeoutMs}ms. ` +
        `${waiter1.vaultName}: ${v1}, ` +
        `${waiter2.vaultName}: ${v2}`
    );
  }
}

/**
 * Wait for two vaults to have the same files in CRDT.
 */
export async function waitForFileListConvergence(
  waiter1: SyncWaiter,
  waiter2: SyncWaiter,
  options: SyncWaitOptions = {}
): Promise<void> {
  const { timeoutMs = config.sync.defaultTimeout } = options;

  const result = await pollWithBackoff(
    async () => {
      const [files1, files2] = await Promise.all([
        waiter1.getCrdtFiles(),
        waiter2.getCrdtFiles(),
      ]);
      const sorted1 = [...files1].sort();
      const sorted2 = [...files2].sort();
      return { files1: sorted1, files2: sorted2 };
    },
    (r) => JSON.stringify(r.files1) === JSON.stringify(r.files2),
    { timeoutMs }
  );

  if (result.success === false) {
    const files1 = result.lastResult?.files1 ?? [];
    const files2 = result.lastResult?.files2 ?? [];
    const only1 = files1.filter((f: string) => !files2.includes(f));
    const only2 = files2.filter((f: string) => !files1.includes(f));

    throw new Error(
      `File lists did not converge after ${timeoutMs}ms. ` +
        `Only in ${waiter1.vaultName}: [${only1.join(", ")}], ` +
        `Only in ${waiter2.vaultName}: [${only2.join(", ")}]`
    );
  }
}

/**
 * Wait for a file to sync from one vault to another.
 */
export async function waitForFileSync(
  sourceWaiter: SyncWaiter,
  targetWaiter: SyncWaiter,
  path: string,
  options: SyncWaitOptions = {}
): Promise<void> {
  // First verify file is in source CRDT
  const sourceFiles = await sourceWaiter.getCrdtFiles();
  if (!sourceFiles.includes(path)) {
    throw new Error(`File "${path}" not found in source CRDT`);
  }

  // Wait for it to appear in target
  await targetWaiter.waitForFile(path, options);
}

/**
 * Create sync waiters for both test vaults.
 */
export function createSyncWaiters(
  client1: CDPClient,
  client2: CDPClient,
  vault1Name: string,
  vault2Name: string
): { vault1: SyncWaiter; vault2: SyncWaiter } {
  return {
    vault1: new SyncWaiter(client1, vault1Name),
    vault2: new SyncWaiter(client2, vault2Name),
  };
}
