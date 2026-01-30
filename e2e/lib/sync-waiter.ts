/**
 * Sync Waiter
 *
 * Utilities for waiting on sync completion between vaults.
 * Uses version vector comparison and file existence checks.
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
    const {
      timeoutMs = config.sync.defaultTimeout,
      pollIntervalMs = config.sync.pollInterval,
    } = options;

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const exists = await this.vault.fileExists(path);
      if (exists) return;

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      `File "${path}" not found in vault "${this.vaultName}" after ${timeoutMs}ms`
    );
  }

  /**
   * Wait for a file to have specific content.
   */
  async waitForContent(
    path: string,
    expectedContent: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const {
      timeoutMs = config.sync.defaultTimeout,
      pollIntervalMs = config.sync.pollInterval,
    } = options;

    const startTime = Date.now();
    let lastError: Error | undefined;
    let lastContent: string | undefined;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const content = await this.vault.readFile(path);
        lastContent = content;
        lastError = undefined; // Clear error once file exists
        if (content === expectedContent) return;
      } catch (err) {
        // Track the error - "File not found" is transient (expected), others are not
        lastError = err instanceof Error ? err : new Error(String(err));
        const isFileNotFound = lastError.message.includes("not found");
        if (!isFileNotFound) {
          // Non-transient error - log it for debugging
          console.warn(`[SyncWaiter] Unexpected error reading ${path}:`, lastError.message);
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Build detailed error message
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

  /**
   * Wait for a file to contain a substring.
   */
  async waitForContentContains(
    path: string,
    substring: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const {
      timeoutMs = config.sync.defaultTimeout,
      pollIntervalMs = config.sync.pollInterval,
    } = options;

    const startTime = Date.now();
    let lastError: Error | undefined;
    let lastContent: string | undefined;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const content = await this.vault.readFile(path);
        lastContent = content;
        lastError = undefined;
        if (content.includes(substring)) return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isFileNotFound = lastError.message.includes("not found");
        if (!isFileNotFound) {
          console.warn(`[SyncWaiter] Unexpected error reading ${path}:`, lastError.message);
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

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

  /**
   * Wait for a file to be deleted from the vault.
   */
  async waitForFileDeletion(
    path: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const {
      timeoutMs = config.sync.defaultTimeout,
      pollIntervalMs = config.sync.pollInterval,
    } = options;

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const exists = await this.vault.fileExists(path);
      if (!exists) return;

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(
      `File "${path}" still exists in vault "${this.vaultName}" after ${timeoutMs}ms`
    );
  }

  /**
   * Wait for plugin status to be a specific value.
   */
  async waitForStatus(
    status: "idle" | "syncing" | "offline" | "error",
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const {
      timeoutMs = config.sync.defaultTimeout,
      pollIntervalMs = config.sync.pollInterval,
    } = options;

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const currentStatus = await this.plugin.getStatus();
      if (currentStatus === status) return;

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const finalStatus = await this.plugin.getStatus();
    throw new Error(
      `Plugin status not "${status}" after ${timeoutMs}ms. Current: "${finalStatus}"`
    );
  }

  /**
   * Wait for sync to complete (status returns to idle).
   */
  async waitForSyncComplete(options: SyncWaitOptions = {}): Promise<void> {
    const {
      timeoutMs = config.sync.defaultTimeout,
      pollIntervalMs = config.sync.pollInterval,
    } = options;

    const startTime = Date.now();

    // First wait for syncing to start (if not already)
    let sawSyncing = false;
    while (Date.now() - startTime < timeoutMs) {
      const status = await this.plugin.getStatus();

      if (status === "syncing") {
        sawSyncing = true;
      } else if (sawSyncing && status === "idle") {
        // Sync completed
        return;
      } else if (status === "idle") {
        // Already idle, might be syncing via live mode
        // Give it a moment then check again
        await new Promise((r) => setTimeout(r, pollIntervalMs * 2));
        const checkStatus = await this.plugin.getStatus();
        if (checkStatus === "idle") return;
      } else if (status === "error") {
        throw new Error("Sync failed with error status");
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`Sync did not complete after ${timeoutMs}ms`);
  }

  /**
   * Wait for a peer to be connected.
   */
  async waitForPeerConnected(
    nodeId: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const {
      timeoutMs = config.sync.defaultTimeout,
      pollIntervalMs = config.sync.pollInterval,
    } = options;

    const startTime = Date.now();
    const shortId = nodeId.slice(0, 8);

    while (Date.now() - startTime < timeoutMs) {
      const peers = await this.plugin.getConnectedPeers();
      const peer = peers.find(
        (p) => p.nodeId === nodeId || p.nodeId.startsWith(shortId)
      );

      if (peer?.connectionState === "connected") return;

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`Peer ${shortId} not connected after ${timeoutMs}ms`);
  }

  /**
   * Wait for a session to reach a specific state.
   */
  async waitForSessionState(
    peerId: string,
    targetState: string,
    options: SyncWaitOptions = {}
  ): Promise<void> {
    const {
      timeoutMs = config.sync.defaultTimeout,
      pollIntervalMs = config.sync.pollInterval,
    } = options;

    const startTime = Date.now();
    const shortId = peerId.slice(0, 8);

    while (Date.now() - startTime < timeoutMs) {
      const sessions = await this.plugin.getSessionStates();
      const session = sessions.find(
        (s) => s.peerId === peerId || s.peerId.startsWith(shortId)
      );

      if (session?.state === targetState) return;

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const finalSessions = await this.plugin.getSessionStates();
    throw new Error(
      `Session for ${shortId} not in state "${targetState}" after ${timeoutMs}ms. ` +
        `Sessions: ${JSON.stringify(finalSessions)}`
    );
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
  const {
    timeoutMs = config.sync.defaultTimeout,
    pollIntervalMs = config.sync.pollInterval,
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const [version1, version2] = await Promise.all([
      waiter1.getVersion(),
      waiter2.getVersion(),
    ]);

    // Versions should be non-empty and match
    if (version1 && version2 && version1 === version2) {
      return;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const [finalV1, finalV2] = await Promise.all([
    waiter1.getVersion(),
    waiter2.getVersion(),
  ]);

  throw new Error(
    `Versions did not converge after ${timeoutMs}ms. ` +
      `${waiter1.vaultName}: ${finalV1}, ` +
      `${waiter2.vaultName}: ${finalV2}`
  );
}

/**
 * Wait for two vaults to have the same files in CRDT.
 */
export async function waitForFileListConvergence(
  waiter1: SyncWaiter,
  waiter2: SyncWaiter,
  options: SyncWaitOptions = {}
): Promise<void> {
  const {
    timeoutMs = config.sync.defaultTimeout,
    pollIntervalMs = config.sync.pollInterval,
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const [files1, files2] = await Promise.all([
      waiter1.getCrdtFiles(),
      waiter2.getCrdtFiles(),
    ]);

    // Sort and compare
    const sorted1 = [...files1].sort();
    const sorted2 = [...files2].sort();

    if (JSON.stringify(sorted1) === JSON.stringify(sorted2)) {
      return;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const [finalFiles1, finalFiles2] = await Promise.all([
    waiter1.getCrdtFiles(),
    waiter2.getCrdtFiles(),
  ]);

  // Find differences
  const only1 = finalFiles1.filter((f) => !finalFiles2.includes(f));
  const only2 = finalFiles2.filter((f) => !finalFiles1.includes(f));

  throw new Error(
    `File lists did not converge after ${timeoutMs}ms. ` +
      `Only in ${waiter1.vaultName}: [${only1.join(", ")}], ` +
      `Only in ${waiter2.vaultName}: [${only2.join(", ")}]`
  );
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
