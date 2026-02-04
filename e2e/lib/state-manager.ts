/**
 * State Manager
 *
 * Handles resetting vault and plugin state between tests.
 * Ensures clean slate for each test suite.
 */

import type { CDPClient } from "./cdp-client";
import { VaultController, type DeleteAllResult } from "./vault-controller";
import { PluginAPI } from "./plugin-api";
import { PluginLifecycleManager } from "./plugin-lifecycle";

/**
 * Manager for test state cleanup and reset.
 */
export class StateManager {
  private vault: VaultController;
  private plugin: PluginAPI;
  private lifecycle: PluginLifecycleManager;

  constructor(
    private client: CDPClient,
    public readonly vaultName: string
  ) {
    this.vault = new VaultController(client, vaultName);
    this.plugin = new PluginAPI(client, vaultName);
    this.lifecycle = new PluginLifecycleManager(client, vaultName);
  }

  /**
   * Delete all user files from the vault (preserves .obsidian folder).
   */
  async resetVaultFiles(): Promise<DeleteAllResult> {
    return await this.vault.deleteAllFiles();
  }

  /**
   * Clear all peers and pending pairing requests.
   */
  async resetPeers(): Promise<void> {
    // First clear via the plugin API
    await this.plugin.clearAllPeers();

    // Then force-clear storage directly to handle race conditions
    // (when both vaults are connected, clearing one sends PEER_REMOVED to the other)
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm) return;

        // Clear pending pairing requests
        if (pm.pendingPairingRequests) {
          pm.pendingPairingRequests.clear();
        }

        // Force-clear the peers map and save to storage
        pm.peers.clear();
        pm.sessions.clear();
        pm.reconnectAttempts.clear();

        // Force save empty peers to storage
        if (pm.storage) {
          const data = new TextEncoder().encode(JSON.stringify([]));
          await pm.storage.write("peervault-peers", data);
        }
      })()
    `);
  }

  /**
   * Reset the CRDT document state.
   * This clears the CRDT storage completely so a fresh doc is created on reload.
   */
  async resetCrdtState(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin) return;

        const dm = plugin.documentManager;
        const pm = plugin.peerManager;

        // Close any active sessions first
        if (pm?.sessions) {
          for (const [id, session] of pm.sessions) {
            try {
              await session.close();
            } catch (e) {
              console.warn("Failed to close session:", id, e);
            }
          }
          pm.sessions.clear();
        }

        // Delete all CRDT-related storage using Obsidian's adapter
        const adapter = window.app.vault.adapter;
        const basePath = window.app.vault.configDir + "/plugins/peervault/peervault-storage";

        try {
          // Delete the entire storage directory
          if (await adapter.exists(basePath)) {
            const listing = await adapter.list(basePath);
            // Delete all files in the directory
            for (const file of listing.files) {
              await adapter.remove(file);
              console.log("[E2E] Deleted storage file:", file);
            }
            // Delete the directory itself
            await adapter.rmdir(basePath, true);
            console.log("[E2E] Deleted peervault-storage directory");
          }
        } catch (e) {
          console.log("[E2E] Error deleting storage:", e);
        }

        // Also clear the blob store data directory
        const blobPath = window.app.vault.configDir + "/plugins/peervault/blobs";
        try {
          if (await adapter.exists(blobPath)) {
            const listing = await adapter.list(blobPath);
            for (const file of listing.files) {
              await adapter.remove(file);
            }
            await adapter.rmdir(blobPath, true);
            console.log("[E2E] Deleted blobs directory");
          }
        } catch (e) {
          console.log("[E2E] Error deleting blobs:", e);
        }
      })()
    `);
  }

  /**
   * Reset plugin settings to defaults.
   */
  async resetSettings(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.loadSettings || !plugin?.saveSettings) return;

        // Reset to defaults
        plugin.settings = {
          autoSync: true,
          syncInterval: 0,
          excludedFolders: [],
          excludedExtensions: [],
          maxFileSize: 104857600, // 100MB
          showStatusBar: true,
          debugMode: false,
          deviceNickname: "",
          showDeviceList: true,
          relayUrl: "https://use1-1.relay.n0.iroh-canary.iroh.link./",
        };

        await plugin.saveSettings();
      })()
    `);
  }

  /**
   * Full reset - clears files, peers, CRDT state.
   */
  async resetAll(): Promise<DeleteAllResult> {
    // Order matters: clear peers first to prevent sync during cleanup
    await this.resetPeers();

    // Then reset CRDT state
    await this.resetCrdtState();

    // Finally delete files
    return await this.resetVaultFiles();
  }

  /**
   * Reload the plugin to pick up fresh state.
   */
  async reloadPlugin(): Promise<void> {
    await this.lifecycle.reload();
  }

  /**
   * Get current state summary for debugging.
   */
  async getStateSummary(): Promise<{
    fileCount: number;
    peerCount: number;
    sessionCount: number;
    crdtFileCount: number;
    pendingPairingCount: number;
  }> {
    return await this.client.evaluate<{
      fileCount: number;
      peerCount: number;
      sessionCount: number;
      crdtFileCount: number;
      pendingPairingCount: number;
    }>(`
      (function() {
        const vault = window.app.vault;
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        const dm = plugin?.documentManager;

        return {
          fileCount: vault.getFiles().filter(f => !f.path.startsWith('.obsidian/')).length,
          peerCount: pm?.peers?.size || 0,
          sessionCount: pm?.sessions?.size || 0,
          crdtFileCount: dm?.listAllPaths?.()?.length || 0,
          pendingPairingCount: pm?.pendingPairingRequests?.size || 0,
        };
      })()
    `);
  }

  /**
   * Wait for vault to be in a clean state.
   */
  async waitForCleanState(timeoutMs: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const state = await this.getStateSummary();

      if (
        state.fileCount === 0 &&
        state.peerCount === 0 &&
        state.sessionCount === 0 &&
        state.pendingPairingCount === 0
      ) {
        return;
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    const finalState = await this.getStateSummary();
    throw new Error(
      `Vault not clean after ${timeoutMs}ms. ` +
        `Files: ${finalState.fileCount}, ` +
        `Peers: ${finalState.peerCount}, ` +
        `Sessions: ${finalState.sessionCount}, ` +
        `Pending: ${finalState.pendingPairingCount}`
    );
  }

  /**
   * Verify vault is truly empty (no user files).
   */
  async verifyEmpty(): Promise<boolean> {
    const files = await this.vault.listFiles();
    return files.length === 0;
  }

  /**
   * Verify no peers are configured.
   */
  async verifyNoPeers(): Promise<boolean> {
    const peers = await this.plugin.getConnectedPeers();
    return peers.length === 0;
  }
}

/**
 * Create state managers for both test vaults.
 */
export function createStateManagers(
  client1: CDPClient,
  client2: CDPClient,
  vault1Name: string,
  vault2Name: string
): { vault1: StateManager; vault2: StateManager } {
  return {
    vault1: new StateManager(client1, vault1Name),
    vault2: new StateManager(client2, vault2Name),
  };
}
