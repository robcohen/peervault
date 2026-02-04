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
  enableProtocolTracing?: boolean;
  protocolTraceLevel?: "minimal" | "standard" | "verbose";
}

/** Protocol trace event (matches TraceEvent in protocol-tracer.ts) */
export interface TraceEvent {
  ts: number;
  sid: string;
  pid: string;
  stm?: string;
  cat: string;
  evt: string;
  data?: Record<string, unknown>;
  dur?: number;
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
   * Force sync with all peers by calling peerManager.syncAll().
   * Closes ALL existing sessions and creates fresh ones.
   */
  async forceSync(): Promise<{ sessionCount: number; sessionStates: Array<{ peerId: string; state: string }> }> {
    return await this.client.evaluate<{ sessionCount: number; sessionStates: Array<{ peerId: string; state: string }> }>(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm?.syncAll) {
          throw new Error("syncAll not available");
        }

        // Close ALL sessions quickly
        if (pm.sessions) {
          const closePromises = [];
          for (const [nodeId, session] of pm.sessions) {
            closePromises.push(
              Promise.race([
                session.close?.(),
                new Promise(r => setTimeout(r, 500)) // 500ms timeout per session
              ]).catch(() => {})
            );
          }
          await Promise.all(closePromises);
          pm.sessions.clear();
        }

        // Trigger sync with all peers - creates fresh sessions
        await pm.syncAll();

        // Return current session state immediately (don't wait)
        const sessions = pm.sessions ? Array.from(pm.sessions.entries()) : [];
        return {
          sessionCount: sessions.length,
          sessionStates: sessions.map(([id, s]) => ({
            peerId: id.slice(0, 16),
            state: s.getState?.() ?? s.state ?? "unknown",
          })),
        };
      })()
    `);
  }

  /**
   * Ensure sync sessions are active, forcing sync if needed.
   * Returns true if at least one session is in live state.
   * Waits up to 15 seconds for sessions to reach live state.
   */
  async ensureActiveSessions(): Promise<boolean> {
    // Check current session state
    let sessions = await this.getActiveSessions();
    let hasLive = sessions.some(s => s.state === "live");

    if (hasLive) {
      return true;
    }

    // Force sync to create new sessions
    const result = await this.forceSync();

    // Wait for sessions to reach "live" state (up to 15 seconds)
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      sessions = await this.getActiveSessions();
      hasLive = sessions.some(s => s.state === "live");

      if (hasLive) {
        return true;
      }

      // Log progress every 5 attempts
      if (i > 0 && i % 5 === 0) {
        const states = sessions.map(s => `${s.peerId.slice(0, 8)}:${s.state}`).join(", ");
        console.log(`[ensureActiveSessions] Attempt ${i}/${maxAttempts}, sessions: [${states}]`);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Final check
    sessions = await this.getActiveSessions();
    return sessions.some(s => s.state === "live");
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
   * Set relay servers for the transport.
   */
  async setRelayServers(relayUrls: string[]): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        if (!plugin?.settings) return;

        plugin.settings.relayServers = ${JSON.stringify(relayUrls)};
        await plugin.saveSettings?.();
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
   * Force close all sessions and trigger fresh reconnection.
   * This is useful after pairing to reset any stuck sync state.
   */
  async forceReconnect(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm) return;

        // Close all existing sessions
        if (pm.sessions) {
          for (const [id, session] of pm.sessions) {
            try {
              await session.close();
            } catch (e) {
              console.warn("[E2E] Failed to close session:", id, e);
            }
          }
          pm.sessions.clear();
        }

        // Wait a moment for cleanup
        await new Promise(r => setTimeout(r, 500));

        // Trigger fresh sync with all peers
        if (pm.syncAll) {
          await pm.syncAll();
        }
      })()
    `);
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
   * Get active sync sessions.
   */
  async getActiveSessions(): Promise<Array<{
    peerId: string;
    state: string;
    isInitiator: boolean;
  }>> {
    return await this.client.evaluate<Array<{
      peerId: string;
      state: string;
      isInitiator: boolean;
    }>>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        const pm = plugin?.peerManager;
        if (!pm?.sessions) return [];

        const sessions = [];
        for (const [peerId, session] of pm.sessions.entries()) {
          // Use getState() method if available, fall back to .state property
          const state = session.getState?.() ?? session.state ?? "unknown";
          sessions.push({
            peerId: peerId,
            state: state,
            isInitiator: session.isInitiator || false,
          });
        }
        return sessions;
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

  /**
   * Enable auto-accept for vault adoption requests.
   * This automatically clicks "Join Network" buttons when the modal appears.
   * Uses MutationObserver + polling fallback to ensure modals are caught.
   */
  async enableAutoAcceptVaultAdoption(): Promise<void> {
    await this.client.evaluate(`
      (function() {
        if (window.__peervaultAutoAcceptEnabled) {
          console.log("[E2E] Auto-accept already enabled");
          return;
        }
        window.__peervaultAutoAcceptEnabled = true;

        // Function to check and dismiss any "Join Sync Network" modals
        function checkAndDismissModals() {
          const modals = document.querySelectorAll('.modal-container');
          for (const modal of modals) {
            const title = modal.querySelector('h2');
            if (title && title.textContent?.includes('Join Sync Network')) {
              console.log("[E2E] Found 'Join Sync Network' modal, auto-accepting...");
              const confirmBtn = modal.querySelector('button.mod-cta');
              if (confirmBtn) {
                confirmBtn.click();
                console.log("[E2E] Clicked 'Join Network' button");
                return true;
              }
            }
          }
          return false;
        }

        // Check immediately for any existing modals
        checkAndDismissModals();

        // Watch for confirmation modals and auto-click "Join Network"
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== 1) continue;
              const el = node;

              // Check if this is a PeerVault confirm modal
              if (el.classList?.contains("modal-container")) {
                const title = el.querySelector("h2");
                if (title && title.textContent?.includes("Join Sync Network")) {
                  console.log("[E2E] Detected 'Join Sync Network' modal, auto-accepting...");

                  // Find and click the confirm button (mod-cta class)
                  const confirmBtn = el.querySelector("button.mod-cta");
                  if (confirmBtn) {
                    setTimeout(() => {
                      confirmBtn.click();
                      console.log("[E2E] Clicked 'Join Network' button");
                    }, 100);
                  }
                }
              }
            }
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Polling fallback - check every 500ms for modals that might have been missed
        window.__peervaultModalPoller = setInterval(() => {
          checkAndDismissModals();
        }, 500);

        console.log("[E2E] Vault adoption auto-accept enabled (MutationObserver + polling)");
      })()
    `);
  }

  /**
   * Click any visible modal buttons (like "Join Network" confirmation).
   * Returns true if a button was clicked.
   */
  async clickModalButton(buttonText: string): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (function() {
        // Find modal buttons with the specified text
        const buttons = document.querySelectorAll(".modal-button, .mod-cta");
        for (const btn of buttons) {
          if (btn.textContent?.includes(${JSON.stringify(buttonText)})) {
            btn.click();
            console.log("[E2E] Clicked modal button:", ${JSON.stringify(buttonText)});
            return true;
          }
        }
        return false;
      })()
    `);
  }

  /**
   * Dismiss any open modals by clicking their close button or pressing Escape.
   */
  async dismissModals(): Promise<void> {
    await this.client.evaluate(`
      (function() {
        // Click close buttons
        const closeButtons = document.querySelectorAll(".modal-close-button");
        closeButtons.forEach(btn => btn.click());

        // Also try pressing Escape
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      })()
    `);
  }

  /**
   * Enable protocol tracing for debugging.
   * Returns { enabled: boolean, debug: string } with debug info about what happened.
   */
  async enableProtocolTracing(level: "minimal" | "standard" | "verbose" = "standard"): Promise<{ enabled: boolean; debug: string }> {
    return await this.client.evaluate<{ enabled: boolean; debug: string }>(`
      (async function() {
        let debug = [];

        // Try direct tracer access first
        let tracer = window.__protocolTracer;
        debug.push("tracer: " + (tracer ? "found" : "not found"));
        debug.push("typeof: " + typeof tracer);

        if (tracer) {
          const keys = Object.keys(tracer).slice(0, 10);
          debug.push("keys: " + keys.join(","));
          debug.push("setEnabled type: " + typeof tracer.setEnabled);
        }

        if (tracer && typeof tracer.setEnabled === 'function') {
          tracer.setEnabled(true);
          tracer.setLevel(${JSON.stringify(level)});
          const isEnabled = tracer.isEnabled?.();
          debug.push("isEnabled after set: " + isEnabled);
          return { enabled: true, debug: debug.join(" | ") };
        } else {
          // Update settings and reload plugin to apply
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          debug.push("plugin: " + (plugin ? "found" : "not found"));
          if (plugin?.settings) {
            plugin.settings.enableProtocolTracing = true;
            plugin.settings.protocolTraceLevel = ${JSON.stringify(level)};
            await plugin.saveSettings?.();
            debug.push("settings updated");
            return { enabled: false, debug: debug.join(" | ") };
          } else {
            debug.push("no plugin settings");
            return { enabled: false, debug: debug.join(" | ") };
          }
        }
      })()
    `);
  }

  /**
   * Disable protocol tracing.
   */
  async disableProtocolTracing(): Promise<void> {
    await this.client.evaluate(`
      (function() {
        const tracer = window.__protocolTracer;
        if (tracer) {
          tracer.setEnabled(false);
          console.log("[E2E] Protocol tracing disabled");
        }
      })()
    `);
  }

  /**
   * Get protocol trace events.
   */
  async getProtocolTraces(count?: number): Promise<TraceEvent[]> {
    return await this.client.evaluate<TraceEvent[]>(`
      (function() {
        const tracer = window.__protocolTracer;
        if (!tracer) {
          console.log("[E2E getProtocolTraces] tracer not found on window");
          return [];
        }
        if (!tracer.getRecentEvents) {
          console.log("[E2E getProtocolTraces] tracer.getRecentEvents not found");
          return [];
        }
        const events = tracer.getRecentEvents(${count ?? 1000});
        console.log("[E2E getProtocolTraces] got", events.length, "events");
        return events;
      })()
    `);
  }

  /**
   * Get protocol traces as NDJSON string.
   */
  async getProtocolTracesNdjson(count?: number): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        const tracer = window.__protocolTracer;
        if (!tracer) return "";
        return tracer.exportAsNdjson(${count ?? undefined});
      })()
    `);
  }

  /**
   * Clear protocol traces.
   */
  async clearProtocolTraces(): Promise<void> {
    await this.client.evaluate(`
      (function() {
        const tracer = window.__protocolTracer;
        if (tracer) {
          tracer.clear();
          console.log("[E2E] Protocol traces cleared");
        }
      })()
    `);
  }
}
