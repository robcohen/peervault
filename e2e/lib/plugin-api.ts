/**
 * Plugin API Wrapper for WASM-based PeerVault
 *
 * Provides typed access to PeerVault plugin methods via CDP.
 * Uses the new simplified API: plugin.client (PeerVaultClient)
 */

import type { CDPClient } from "./cdp-client";

/** Peer information */
export interface PeerInfo {
  id: string;
  name: string;
  ticket: string;
  lastSeen: number;
  isConnected: boolean;
}

/** Plugin settings */
export interface PluginSettings {
  deviceName: string;
  autoSync: boolean;
  autoSyncInterval: number;
  relayUrl: string;
}

/**
 * Wrapper for PeerVault plugin API.
 */
export class PluginAPI {
  constructor(
    private client: CDPClient,
    public readonly vaultName: string
  ) {}

  /**
   * Check if the plugin is installed and enabled.
   */
  async isEnabled(): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return !!plugin;
      })()
    `);
  }

  /**
   * Check if the plugin client is initialized and ready.
   */
  async isReady(): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.client?.isInitialized ?? false;
      })()
    `);
  }

  /**
   * Get the plugin version.
   */
  async getVersion(): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.manifest?.version || "unknown";
      })()
    `);
  }

  /**
   * Get the node ID for this vault.
   */
  async getNodeId(): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.client?.nodeId || "";
      })()
    `);
  }

  /**
   * Get a pairing ticket (includes encryption key).
   */
  async getPairingTicket(): Promise<string> {
    return await this.client.evaluate<string>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.getPairingTicket) {
          throw new Error("Plugin not available or getPairingTicket not found");
        }
        return await plugin.client.getPairingTicket();
      })()
    `);
  }

  /**
   * Get a transport-only ticket.
   */
  async getTicket(): Promise<string> {
    return await this.client.evaluate<string>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.getTicket) {
          throw new Error("Plugin not available or getTicket not found");
        }
        return await plugin.client.getTicket();
      })()
    `);
  }

  /**
   * Add a peer using a pairing ticket.
   */
  async addPeer(ticket: string, name?: string): Promise<string> {
    return await this.client.evaluate<string>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.addPeer) {
          throw new Error("Plugin not available or addPeer not found");
        }
        return await plugin.client.addPeer(${JSON.stringify(ticket)}, ${name ? JSON.stringify(name) : "undefined"});
      })()
    `);
  }

  /**
   * Remove a peer.
   */
  async removePeer(peerId: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.removePeer) {
          throw new Error("Plugin not available or removePeer not found");
        }
        await plugin.client.removePeer(${JSON.stringify(peerId)});
      })()
    `);
  }

  /**
   * Get connected peers.
   */
  async getPeers(): Promise<PeerInfo[]> {
    return await this.client.evaluate<PeerInfo[]>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.client?.getPeers?.() || [];
      })()
    `);
  }

  /**
   * Trigger sync with all peers.
   */
  async syncAll(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.syncAll) {
          throw new Error("Plugin not available or syncAll not found");
        }
        await plugin.client.syncAll();
      })()
    `);
  }

  /**
   * List files in the CRDT store.
   */
  async listFiles(prefix?: string): Promise<string[]> {
    return await this.client.evaluate<string[]>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.listFiles) {
          return [];
        }
        return await plugin.client.listFiles(${prefix ? JSON.stringify(prefix) : "undefined"});
      })()
    `);
  }

  /**
   * Get file content from CRDT store.
   */
  async getFile(path: string): Promise<Uint8Array | null> {
    const result = await this.client.evaluate<number[] | null>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.getFile) {
          return null;
        }
        const data = await plugin.client.getFile(${JSON.stringify(path)});
        return data ? Array.from(data) : null;
      })()
    `);
    return result ? new Uint8Array(result) : null;
  }

  /**
   * Set file content in CRDT store.
   */
  async setFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string"
      ? Array.from(new TextEncoder().encode(content))
      : Array.from(content);

    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.setFile) {
          throw new Error("Plugin not available or setFile not found");
        }
        await plugin.client.setFile(${JSON.stringify(path)}, new Uint8Array(${JSON.stringify(bytes)}));
      })()
    `);
  }

  /**
   * Delete file from CRDT store.
   */
  async deleteFile(path: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.deleteFile) {
          throw new Error("Plugin not available or deleteFile not found");
        }
        await plugin.client.deleteFile(${JSON.stringify(path)});
      })()
    `);
  }

  /**
   * Check if encryption key is set.
   */
  async hasEncryptionKey(): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.hasEncryptionKey) {
          return false;
        }
        return await plugin.client.hasEncryptionKey();
      })()
    `);
  }

  /**
   * Generate a new encryption key.
   */
  async generateEncryptionKey(): Promise<string> {
    return await this.client.evaluate<string>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.generateEncryptionKey) {
          throw new Error("Plugin not available or generateEncryptionKey not found");
        }
        return await plugin.client.generateEncryptionKey();
      })()
    `);
  }

  /**
   * Set encryption key from hex string.
   */
  async setEncryptionKey(keyHex: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.client?.setEncryptionKey) {
          throw new Error("Plugin not available or setEncryptionKey not found");
        }
        await plugin.client.setEncryptionKey(${JSON.stringify(keyHex)});
      })()
    `);
  }

  /**
   * Get plugin settings.
   */
  async getSettings(): Promise<PluginSettings> {
    return await this.client.evaluate<PluginSettings>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const settings = plugin?.settings || {};
        return {
          deviceName: settings.deviceName ?? "",
          autoSync: settings.autoSync ?? true,
          autoSyncInterval: settings.autoSyncInterval ?? 5,
          relayUrl: settings.relayUrl ?? "",
        };
      })()
    `);
  }

  /**
   * Set plugin settings and save them.
   */
  async setSettings(settings: Partial<PluginSettings>): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin) throw new Error("Plugin not available");

        const newSettings = ${JSON.stringify(settings)};
        Object.assign(plugin.settings, newSettings);
        await plugin.saveSettings();
      })()
    `);
  }

  /**
   * Set the relay URL and reload the plugin to apply.
   * This is needed because the relay URL is only read at startup.
   */
  async setRelayUrl(relayUrl: string): Promise<void> {
    await this.setSettings({ relayUrl });
  }

  /**
   * Reload the plugin (disable + enable).
   */
  async reload(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugins = window.app?.plugins;
        if (!plugins) return;

        await plugins.disablePlugin("peervault");
        await new Promise(r => setTimeout(r, 500));
        await plugins.enablePlugin("peervault");
        await new Promise(r => setTimeout(r, 1000));
      })()
    `);
  }

  /**
   * Wait for plugin to be ready.
   */
  async waitForReady(timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (await this.isReady()) {
        return true;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  /**
   * Get diagnostic info for debugging.
   */
  async getDiagnostics(): Promise<{
    enabled: boolean;
    ready: boolean;
    nodeId: string;
    peerCount: number;
    fileCount: number;
    hasEncryptionKey: boolean;
  }> {
    return await this.client.evaluate<{
      enabled: boolean;
      ready: boolean;
      nodeId: string;
      peerCount: number;
      fileCount: number;
      hasEncryptionKey: boolean;
    }>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const client = plugin?.client;

        if (!plugin) {
          return {
            enabled: false,
            ready: false,
            nodeId: "",
            peerCount: 0,
            fileCount: 0,
            hasEncryptionKey: false,
          };
        }

        const files = client?.listFiles ? await client.listFiles() : [];
        const hasKey = client?.hasEncryptionKey ? await client.hasEncryptionKey() : false;

        return {
          enabled: true,
          ready: client?.isInitialized ?? false,
          nodeId: client?.nodeId ?? "",
          peerCount: client?.getPeers?.()?.length ?? 0,
          fileCount: files.length,
          hasEncryptionKey: hasKey,
        };
      })()
    `);
  }

  /**
   * Clear all peers.
   */
  async clearAllPeers(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const client = plugin?.client;
        if (!client?.getPeers || !client?.removePeer) return;

        const peers = client.getPeers();
        for (const peer of peers) {
          try {
            await client.removePeer(peer.id);
          } catch (e) {
            console.warn("Failed to remove peer:", peer.id, e);
          }
        }
      })()
    `);
  }

  // === Legacy API compatibility methods ===

  /**
   * Get transport type (legacy - always returns "iroh").
   */
  async getTransportType(): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.settings?.transportType || "iroh";
      })()
    `);
  }

  /**
   * Get connected peers (legacy - same as getPeers).
   */
  async getConnectedPeers(): Promise<PeerInfo[]> {
    return this.getPeers();
  }

  /**
   * Generate invite (legacy - alias for getPairingTicket).
   */
  async generateInvite(): Promise<string> {
    return this.getPairingTicket();
  }

  /**
   * Force sync (legacy - alias for syncAll).
   */
  async forceSync(): Promise<void> {
    return this.syncAll();
  }

  /**
   * Get active sessions.
   * Returns peers with their connection status as pseudo-sessions.
   */
  async getActiveSessions(): Promise<Array<{ peerId: string; state: string; isLive: boolean }>> {
    return await this.client.evaluate<Array<{ peerId: string; state: string; isLive: boolean }>>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const peers = plugin?.client?.getPeers?.() || [];
        return peers.map(p => ({
          peerId: p.id,
          state: p.isConnected ? "live" : "disconnected",
          isLive: p.isConnected
        }));
      })()
    `);
  }

  /**
   * Get pending pairing requests (legacy - not applicable with new API).
   */
  async getPendingPairingRequests(): Promise<Array<{ nodeId: string }>> {
    // New WASM API doesn't have pending pairing requests
    // Pairing is done via tickets directly
    return [];
  }

  /**
   * Accept pairing request (legacy - no-op with new API).
   */
  async acceptPairingRequest(_nodeId: string): Promise<void> {
    // New WASM API doesn't require explicit acceptance
    // Pairing is done via tickets directly
  }
}
