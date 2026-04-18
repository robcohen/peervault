/**
 * State Manager
 *
 * Handles resetting vault and plugin state between tests.
 * Simplified for the new WASM-based plugin architecture.
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
   * Clear all peers.
   */
  async resetPeers(): Promise<void> {
    await this.plugin.clearAllPeers();
  }

  /**
   * Clear the encryption key.
   * This allows the vault to adopt a peer's key during pairing.
   */
  async clearEncryptionKey(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const client = plugin?.client;
        if (!client?.clearEncryptionKey) {
          console.log("[E2E] clearEncryptionKey not available, skipping");
          return;
        }
        await client.clearEncryptionKey();
        console.log("[E2E] Cleared encryption key");
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
        const adapter = window.app.vault.adapter;
        const basePath = window.app.vault.configDir + "/plugins/peervault/data";

        try {
          // Delete the entire data directory
          if (await adapter.exists(basePath)) {
            const listing = await adapter.list(basePath);
            // Delete all files in the directory
            for (const file of listing.files) {
              await adapter.remove(file);
              console.log("[E2E] Deleted storage file:", file);
            }
            // Delete the directory itself
            await adapter.rmdir(basePath, true);
            console.log("[E2E] Deleted peervault data directory");
          }
        } catch (e) {
          console.log("[E2E] Error deleting storage:", e);
        }
      })()
    `);

    // Reload the plugin to pick up fresh state from disk
    await this.lifecycle.reload();
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
          deviceName: "",
          autoSync: true,
          autoSyncInterval: 5,
        };

        await plugin.saveSettings();
      })()
    `);
  }

  /**
   * Full reset - clears files, peers, CRDT state, and encryption key.
   */
  async resetAll(): Promise<DeleteAllResult> {
    // Order matters: clear peers first to prevent sync during cleanup
    await this.resetPeers();

    // Clear encryption key so vaults can exchange keys during pairing
    await this.clearEncryptionKey();

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
    crdtFileCount: number;
  }> {
    return await this.client.evaluate<{
      fileCount: number;
      peerCount: number;
      crdtFileCount: number;
    }>(`
      (async function() {
        const vault = window.app.vault;
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const client = plugin?.client;

        const crdtFiles = client?.listFiles ? await client.listFiles() : [];
        const peers = client?.getPeers?.() || [];

        return {
          fileCount: vault.getFiles().filter(f => !f.path.startsWith('.obsidian/')).length,
          peerCount: peers.length,
          crdtFileCount: crdtFiles.length,
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
        state.peerCount === 0
      ) {
        return;
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    const finalState = await this.getStateSummary();
    throw new Error(
      `Vault not clean after ${timeoutMs}ms. ` +
        `Files: ${finalState.fileCount}, ` +
        `Peers: ${finalState.peerCount}`
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
    const peers = await this.plugin.getPeers();
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
