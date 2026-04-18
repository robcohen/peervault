/**
 * Sync Waiter
 *
 * Utilities for waiting on sync completion between vaults.
 * Simplified for the new WASM-based plugin architecture.
 */

import type { CDPClient } from "./cdp-client";
import { VaultController } from "./vault-controller";
import { PluginAPI } from "./plugin-api";
import { getConfig } from "../config";

export interface SyncWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Exponential backoff polling utility.
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
    minInterval = getConfig().sync.minPollInterval,
    maxInterval = getConfig().sync.maxPollInterval,
    multiplier = getConfig().sync.backoffMultiplier,
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
    const { timeoutMs = getConfig().sync.defaultTimeout } = options;

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
    const { timeoutMs = getConfig().sync.defaultTimeout } = options;

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
    const { timeoutMs = getConfig().sync.defaultTimeout } = options;

    let lastContent: string | undefined;

    const result = await pollWithBackoff(
      async () => {
        try {
          const content = await this.vault.readFile(path);
          lastContent = content;
          return { found: true, contains: content.includes(substring) };
        } catch {
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
    const { timeoutMs = getConfig().sync.defaultTimeout } = options;

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
   * Wait for plugin to be ready (initialized).
   */
  async waitForReady(options: SyncWaitOptions = {}): Promise<void> {
    const { timeoutMs = getConfig().sync.defaultTimeout } = options;

    const result = await pollWithBackoff(
      () => this.plugin.isReady(),
      (ready) => ready,
      { timeoutMs }
    );

    if (!result.success) {
      throw new Error(
        `Plugin not ready in "${this.vaultName}" after ${timeoutMs}ms`
      );
    }
  }

  /**
   * Wait for a peer to be connected.
   */
  async waitForPeerConnected(
    peerId: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const { timeoutMs = getConfig().sync.defaultTimeout } = options;
    const shortId = peerId.slice(0, 8);

    const result = await pollWithBackoff(
      async () => {
        const peers = await this.plugin.getPeers();
        const peer = peers.find(
          (p) => p.id === peerId || p.id.startsWith(shortId)
        );
        return peer?.isConnected ?? false;
      },
      (connected) => connected,
      { timeoutMs }
    );

    if (!result.success) {
      throw new Error(`Peer ${shortId} not connected after ${timeoutMs}ms`);
    }
  }

  /**
   * Get files from the CRDT store.
   */
  async getCrdtFiles(): Promise<string[]> {
    return await this.plugin.listFiles();
  }

  /**
   * Wait for vault sync (placeholder for compatibility).
   * In the new architecture, syncs happen immediately via CRDT.
   */
  async waitForVaultSync(timeoutMs?: number): Promise<void> {
    // Just wait a bit for any pending operations
    await new Promise(r => setTimeout(r, timeoutMs ?? 500));
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
  const { timeoutMs = getConfig().sync.defaultTimeout } = options;

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
