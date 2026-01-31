/**
 * Plugin API Wrapper
 *
 * Provides typed access to PeerVault plugin methods via CDP.
 * Wraps window.app.plugins.plugins["peervault"] calls.
 */

import type { CDPClient } from "./cdp-client";

/** Sync status */
export type SyncStatus = "idle" | "syncing" | "offline" | "error";

/** Peer connection state */
export type ConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error";

/** Peer information */
export interface PeerInfo {
  nodeId: string;
  hostname?: string;
  nickname?: string;
  connectionState: ConnectionState;
  trusted: boolean;
  lastSeen?: number;
  lastSynced?: number;
}

/** Plugin settings (subset for testing) */
export interface PluginSettings {
  autoSync: boolean;
  syncInterval: number;
  excludedFolders: string[];
  maxFileSize: number;
  showStatusBar: boolean;
  debugMode: boolean;
  deviceNickname?: string;
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
   * Get the current sync status.
   */
  async getStatus(): Promise<SyncStatus> {
    return await this.client.evaluate<SyncStatus>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.getStatus?.() || "offline";
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
        return plugin?.getNodeId?.() || "";
      })()
    `);
  }

  /**
   * Get connected peers.
   */
  async getConnectedPeers(): Promise<PeerInfo[]> {
    return await this.client.evaluate<PeerInfo[]>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const peers = plugin?.getConnectedPeers?.() || [];
        return peers.map(p => ({
          nodeId: p.nodeId,
          hostname: p.hostname,
          nickname: p.nickname,
          connectionState: p.connectionState,
          trusted: p.trusted,
          lastSeen: p.lastSeen,
          lastSynced: p.lastSynced,
        }));
      })()
    `);
  }

  /**
   * Generate an invite ticket.
   */
  async generateInvite(): Promise<string> {
    return await this.client.evaluate<string>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.generateInvite) {
          throw new Error("Plugin not available or generateInvite not found");
        }
        return await plugin.generateInvite();
      })()
    `);
  }

  /**
   * Add a peer using an invite ticket.
   */
  async addPeer(ticket: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.addPeer) {
          throw new Error("Plugin not available or addPeer not found");
        }
        await plugin.addPeer(${JSON.stringify(ticket)});
      })()
    `);
  }

  /**
   * Trigger a sync with all peers.
   */
  async sync(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.sync) {
          throw new Error("Plugin not available or sync not found");
        }
        await plugin.sync();
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
          autoSync: settings.autoSync ?? true,
          syncInterval: settings.syncInterval ?? 0,
          excludedFolders: settings.excludedFolders ?? [],
          maxFileSize: settings.maxFileSize ?? 104857600,
          showStatusBar: settings.showStatusBar ?? true,
          debugMode: settings.debugMode ?? false,
          deviceNickname: settings.deviceNickname,
        };
      })()
    `);
  }

  /**
   * Get a content-based hash of the CRDT state.
   *
   * This computes a hash of (sorted file list + each file's content hash),
   * which represents the actual sync state rather than Loro's internal
   * version vector (which can differ even when content is identical).
   */
  async getDocumentVersion(): Promise<string> {
    return await this.client.evaluate<string>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const dm = plugin?.documentManager;
        if (!dm?.listAllPaths) return "";

        // Get sorted file list
        const files = dm.listAllPaths().sort();
        if (files.length === 0) return "empty";

        // Build a content fingerprint: file paths + content lengths
        // (Using lengths instead of full hashes for speed)
        const fingerprint = [];
        for (const path of files) {
          const content = dm.getFileContent?.(path);
          const len = content ? content.length : 0;
          fingerprint.push(path + ":" + len);
        }

        // Simple hash of the fingerprint
        const str = fingerprint.join("|");
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          const char = str.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash; // Convert to 32bit integer
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
      })()
    `);
  }

  /**
   * Get all files tracked in the CRDT.
   */
  async getCrdtFiles(): Promise<string[]> {
    return await this.client.evaluate<string[]>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const dm = plugin?.documentManager;
        if (!dm?.listAllPaths) return [];
        return dm.listAllPaths();
      })()
    `);
  }

  /**
   * Get blob store diagnostic info.
   */
  async getBlobStoreInfo(): Promise<{
    blobCount: number;
    referencedHashes: string[];
    missingHashes: string[];
  }> {
    return await this.client.evaluate<{
      blobCount: number;
      referencedHashes: string[];
      missingHashes: string[];
    }>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const blobStore = plugin?.blobStore;
        const dm = plugin?.documentManager;

        if (!blobStore || !dm) {
          return { blobCount: -1, referencedHashes: [], missingHashes: [] };
        }

        const blobs = blobStore.list ? await blobStore.list() : [];
        const referencedHashes = dm.getAllBlobHashes ? dm.getAllBlobHashes() : [];
        const missingHashes = blobStore.getMissing ? await blobStore.getMissing(referencedHashes) : [];

        return {
          blobCount: blobs.length,
          referencedHashes,
          missingHashes,
        };
      })()
    `);
  }

  /**
   * Get blob:received event count (debug).
   */
  async getBlobReceivedCount(): Promise<number> {
    return await this.client.evaluate<number>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.getBlobReceivedCount?.() ?? -1;
      })()
    `);
  }

  /**
   * Get the vault ID.
   */
  async getVaultId(): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const dm = plugin?.documentManager;
        return dm?.getVaultId?.() || "";
      })()
    `);
  }

  /**
   * Get active sync session states.
   */
  async getSessionStates(): Promise<Array<{ peerId: string; state: string }>> {
    return await this.client.evaluate<Array<{ peerId: string; state: string }>>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm?.sessions) return [];
        return Array.from(pm.sessions.entries()).map(([id, session]) => ({
          peerId: id,
          state: session.getState?.() || "unknown",
        }));
      })()
    `);
  }

  /**
   * Force a sync with all peers.
   * This clears any error sessions and creates new ones.
   */
  async forceSync(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm) throw new Error("PeerManager not available");

        // Close any error sessions first
        if (pm.sessions) {
          for (const [nodeId, session] of pm.sessions) {
            if (session.getState?.() === "error") {
              try {
                await session.close();
              } catch (e) {
                console.warn("Failed to close error session:", e);
              }
              pm.sessions.delete(nodeId);
            }
          }
        }

        // Trigger sync with all peers
        if (pm.syncAll) {
          await pm.syncAll();
        }
      })()
    `);
  }

  /**
   * Check if session with peer is healthy (in live state).
   */
  async isSessionHealthy(peerId: string): Promise<boolean> {
    const sessions = await this.getSessionStates();
    const session = sessions.find(
      (s) => s.peerId === peerId || s.peerId.startsWith(peerId.slice(0, 8))
    );
    return session?.state === "live";
  }

  /**
   * Accept a pending pairing request.
   */
  async acceptPairingRequest(nodeId: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm?.acceptPairingRequest) {
          throw new Error("acceptPairingRequest not available");
        }
        await pm.acceptPairingRequest(${JSON.stringify(nodeId)});
      })()
    `);
  }

  /**
   * Deny a pending pairing request.
   */
  async denyPairingRequest(nodeId: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm?.denyPairingRequest) {
          throw new Error("denyPairingRequest not available");
        }
        await pm.denyPairingRequest(${JSON.stringify(nodeId)});
      })()
    `);
  }

  /**
   * Get pending pairing requests.
   */
  async getPendingPairingRequests(): Promise<
    Array<{ nodeId: string; timestamp: number }>
  > {
    return await this.client.evaluate<Array<{ nodeId: string; timestamp: number }>>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm?.pendingPairingRequests) return [];
        return Array.from(pm.pendingPairingRequests.values()).map(p => ({
          nodeId: p.request.nodeId,
          timestamp: p.request.timestamp,
        }));
      })()
    `);
  }

  /**
   * Remove a peer.
   */
  async removePeer(nodeId: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm?.removePeer) {
          throw new Error("removePeer not available");
        }
        await pm.removePeer(${JSON.stringify(nodeId)});
      })()
    `);
  }

  /**
   * Get connection info for a peer, including WebRTC status.
   */
  async getConnectionInfo(peerId: string): Promise<{
    connected: boolean;
    transportType: "iroh" | "hybrid";
    webrtcActive: boolean;
    webrtcDirect: boolean;
    rttMs?: number;
  } | null> {
    return await this.client.evaluate<{
      connected: boolean;
      transportType: "iroh" | "hybrid";
      webrtcActive: boolean;
      webrtcDirect: boolean;
      rttMs?: number;
    } | null>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.getConnectionInfo) return null;
        return plugin.getConnectionInfo(${JSON.stringify(peerId)});
      })()
    `);
  }

  /**
   * Check if WebRTC is available in this environment.
   */
  async isWebRTCAvailable(): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.isWebRTCAvailable?.() ?? false;
      })()
    `);
  }

  /**
   * Clear all peers and reset sync state.
   */
  async clearAllPeers(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm?.peers) return;

        // Get all peer IDs
        const peerIds = Array.from(pm.peers.keys());

        // Remove each peer
        for (const id of peerIds) {
          try {
            await pm.removePeer(id);
          } catch (e) {
            console.warn("Failed to remove peer:", id, e);
          }
        }
      })()
    `);
  }
}
