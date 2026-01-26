/**
 * Peer Manager
 *
 * Manages peer connections, sync sessions, and coordination between
 * the transport layer and document manager.
 */

import type { Transport, PeerConnection } from "../transport";
import type { DocumentManager } from "../core/document-manager";
import type { BlobStore } from "../core/blob-store";
import type { Logger } from "../utils/logger";
import type { StorageAdapter } from "../types";
import { SyncSession } from "../sync/sync-session";
import { EventEmitter } from "../utils/events";
import type {
  PeerInfo,
  StoredPeerInfo,
  PeerState,
  PeerManagerConfig,
} from "./types";
import { PeerGroupManager, DEFAULT_GROUP_ID } from "./groups";

const PEERS_STORAGE_KEY = "peervault-peers";

const DEFAULT_CONFIG: Required<PeerManagerConfig> = {
  autoSyncInterval: 60000, // 1 minute
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectBackoff: 1000,
};

/** Events from peer manager */
interface PeerManagerEvents extends Record<string, unknown> {
  "peer:connected": PeerInfo;
  "peer:disconnected": { nodeId: string; reason?: string };
  "peer:synced": string;
  "peer:error": { nodeId: string; error: Error };
  "status:change": "idle" | "syncing" | "offline" | "error";
}

/**
 * Manages peer connections and sync sessions.
 */
export class PeerManager extends EventEmitter<PeerManagerEvents> {
  private peers = new Map<string, PeerInfo>();
  private sessions = new Map<string, SyncSession>();
  private reconnectAttempts = new Map<string, number>();
  private config: Required<PeerManagerConfig>;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private status: "idle" | "syncing" | "offline" | "error" = "idle";
  private groupManager!: PeerGroupManager;

  constructor(
    private transport: Transport,
    private documentManager: DocumentManager,
    private storage: StorageAdapter,
    private logger: Logger,
    config?: PeerManagerConfig,
    private blobStore?: BlobStore,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get the peer group manager.
   */
  getGroupManager(): PeerGroupManager {
    return this.groupManager;
  }

  /**
   * Initialize the peer manager.
   * Loads stored peers and sets up connection handlers.
   */
  async initialize(): Promise<void> {
    // Initialize group manager
    this.groupManager = new PeerGroupManager(
      this.documentManager.getLoro(),
      this.logger,
    );

    // Load stored peers
    await this.loadPeers();

    // Handle incoming connections
    this.transport.onIncomingConnection(async (conn) => {
      await this.handleIncomingConnection(conn);
    });

    // Start auto-sync if enabled
    if (this.config.autoSyncInterval > 0) {
      this.startAutoSync();
    }

    this.logger.info("PeerManager initialized");
  }

  /**
   * Shut down the peer manager.
   */
  async shutdown(): Promise<void> {
    this.stopAutoSync();

    // Close all sessions
    for (const session of this.sessions.values()) {
      await session.close();
    }
    this.sessions.clear();

    // Save peer state
    await this.savePeers();

    this.logger.info("PeerManager shut down");
  }

  // ===========================================================================
  // Peer Operations
  // ===========================================================================

  /**
   * Add a new peer using their connection ticket.
   */
  async addPeer(ticket: string, name?: string): Promise<PeerInfo> {
    try {
      this.setStatus("syncing");

      // Connect to peer
      const connection = await this.transport.connectWithTicket(ticket);
      const nodeId = connection.peerId;

      // Check if peer already exists
      let peer = this.peers.get(nodeId);
      if (peer) {
        // Update existing peer
        peer.ticket = ticket;
        if (name) peer.name = name;
        peer.lastSeen = Date.now();
      } else {
        // Create new peer
        peer = {
          nodeId,
          name,
          state: "connecting",
          ticket,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          trusted: true, // New peers are trusted by default
          groupIds: [DEFAULT_GROUP_ID], // Add to default group
        };
        this.peers.set(nodeId, peer);

        // Also add to the group manager
        this.groupManager.addPeerToGroup(DEFAULT_GROUP_ID, nodeId);
      }

      // Start sync session
      await this.startSyncSession(connection, peer);

      await this.savePeers();
      this.emit("peer:connected", peer);

      return peer;
    } catch (error) {
      this.logger.error("Failed to add peer:", error);
      this.setStatus("error");
      throw error;
    }
  }

  /**
   * Remove a peer.
   */
  async removePeer(nodeId: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (session) {
      await session.close();
      this.sessions.delete(nodeId);
    }

    this.peers.delete(nodeId);
    this.reconnectAttempts.delete(nodeId);

    await this.savePeers();
    this.logger.info("Removed peer:", nodeId);
  }

  /**
   * Get all known peers.
   */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get a specific peer.
   */
  getPeer(nodeId: string): PeerInfo | undefined {
    return this.peers.get(nodeId);
  }

  /**
   * Update peer name.
   */
  async renamePeer(nodeId: string, name: string): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.name = name;
      await this.savePeers();
    }
  }

  /**
   * Set peer trust level.
   */
  async setTrusted(nodeId: string, trusted: boolean): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.trusted = trusted;
      await this.savePeers();
    }
  }

  /**
   * Get sync state information for all peers.
   * Used by GarbageCollector for peer consensus checking.
   */
  getPeerSyncStates(): Array<{
    peerId: string;
    peerName?: string;
    lastSyncTime: number;
    isConnected: boolean;
  }> {
    return Array.from(this.peers.values()).map((peer) => ({
      peerId: peer.nodeId,
      peerName: peer.name,
      lastSyncTime: peer.lastSynced ?? peer.firstSeen,
      isConnected: peer.state === "synced" || peer.state === "syncing",
    }));
  }

  /**
   * Get the union of excluded folders from all connected peers' group policies.
   * Used to filter which remote files should be written to the local vault.
   */
  getConnectedPeersExcludedFolders(): string[] {
    const excludedFolders = new Set<string>();

    for (const peer of this.peers.values()) {
      // Only consider connected/synced peers
      if (peer.state !== "synced" && peer.state !== "syncing") {
        continue;
      }

      const policy = this.groupManager.getEffectiveSyncPolicy(peer.nodeId);
      for (const folder of policy.excludedFolders) {
        excludedFolders.add(folder);
      }
    }

    return Array.from(excludedFolders);
  }

  /**
   * Generate a ticket for others to connect to us.
   */
  async generateInvite(): Promise<string> {
    return this.transport.generateTicket();
  }

  /**
   * Get our node ID.
   */
  getNodeId(): string {
    return this.transport.getNodeId();
  }

  /**
   * Get current sync status.
   */
  getStatus(): "idle" | "syncing" | "offline" | "error" {
    return this.status;
  }

  // ===========================================================================
  // Manual Sync
  // ===========================================================================

  /**
   * Manually trigger sync with all connected peers.
   */
  async syncAll(): Promise<void> {
    this.setStatus("syncing");

    const promises = [];
    for (const peer of this.peers.values()) {
      if (peer.state === "synced" || peer.state === "offline") {
        promises.push(this.syncPeer(peer.nodeId));
      }
    }

    try {
      await Promise.allSettled(promises);
      this.setStatus("idle");
    } catch {
      this.setStatus("error");
    }
  }

  /**
   * Sync with a specific peer.
   */
  async syncPeer(nodeId: string): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (!peer) {
      throw new Error(`Unknown peer: ${nodeId}`);
    }

    // Check for existing session
    const existingSession = this.sessions.get(nodeId);
    if (existingSession?.getState() === "live") {
      // Already synced and in live mode
      return;
    }

    // Try to connect if we have a ticket
    if (peer.ticket) {
      try {
        const connection = await this.transport.connectWithTicket(peer.ticket);
        await this.startSyncSession(connection, peer);
      } catch (error) {
        this.logger.error("Failed to sync with peer:", nodeId, error);
        this.updatePeerState(nodeId, "error");
        throw error;
      }
    } else {
      throw new Error(`No ticket for peer: ${nodeId}`);
    }
  }

  // ===========================================================================
  // Private: Connection Handling
  // ===========================================================================

  private async handleIncomingConnection(
    connection: PeerConnection,
  ): Promise<void> {
    const nodeId = connection.peerId;
    this.logger.info("Incoming connection from:", nodeId);

    // Get or create peer info
    let peer = this.peers.get(nodeId);
    if (!peer) {
      peer = {
        nodeId,
        state: "connecting",
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        trusted: false, // Incoming peers need explicit trust
      };
      this.peers.set(nodeId, peer);
      this.emit("peer:connected", peer);
    }

    peer.lastSeen = Date.now();

    // Handle incoming sync
    await this.handleIncomingSyncSession(connection, peer);
  }

  // ===========================================================================
  // Private: Sync Sessions
  // ===========================================================================

  private async startSyncSession(
    connection: PeerConnection,
    peer: PeerInfo,
  ): Promise<void> {
    // Close existing session if any
    const existingSession = this.sessions.get(peer.nodeId);
    if (existingSession) {
      await existingSession.close();
    }

    // Get effective sync policy for this peer
    const syncPolicy = this.groupManager.getEffectiveSyncPolicy(peer.nodeId);

    // Create new session with blob store for binary sync
    const session = new SyncSession(
      peer.nodeId,
      this.documentManager,
      this.logger,
      { peerIsReadOnly: syncPolicy.readOnly },
      this.blobStore,
    );

    // Set up event handlers
    session.on("state:change", (state) => {
      this.logger.debug(`Sync session ${peer.nodeId} state:`, state);
      if (state === "live") {
        this.updatePeerState(peer.nodeId, "synced");
      } else if (state === "error") {
        this.updatePeerState(peer.nodeId, "error");
        this.handleSyncError(peer.nodeId);
      } else if (state === "closed") {
        this.updatePeerState(peer.nodeId, "offline");
      }
    });

    session.on("sync:complete", () => {
      peer.lastSynced = Date.now();
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peers:", err),
      );
      this.emit("peer:synced", peer.nodeId);
      this.reconnectAttempts.set(peer.nodeId, 0);
    });

    session.on("error", (error) => {
      this.emit("peer:error", { nodeId: peer.nodeId, error });
    });

    this.sessions.set(peer.nodeId, session);
    this.updatePeerState(peer.nodeId, "syncing");

    // Open stream and start sync
    const stream = await connection.openStream();
    await session.startSync(stream);
  }

  private async handleIncomingSyncSession(
    connection: PeerConnection,
    peer: PeerInfo,
  ): Promise<void> {
    // Close existing session if any
    const existingSession = this.sessions.get(peer.nodeId);
    if (existingSession) {
      await existingSession.close();
    }

    // Get effective sync policy for this peer
    const syncPolicy = this.groupManager.getEffectiveSyncPolicy(peer.nodeId);

    // Create new session with blob store for binary sync
    const session = new SyncSession(
      peer.nodeId,
      this.documentManager,
      this.logger,
      { peerIsReadOnly: syncPolicy.readOnly },
      this.blobStore,
    );

    // Set up event handlers (same as above)
    session.on("state:change", (state) => {
      if (state === "live") {
        this.updatePeerState(peer.nodeId, "synced");
      } else if (state === "error") {
        this.updatePeerState(peer.nodeId, "error");
      } else if (state === "closed") {
        this.updatePeerState(peer.nodeId, "offline");
      }
    });

    session.on("sync:complete", () => {
      peer.lastSynced = Date.now();
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peers:", err),
      );
      this.emit("peer:synced", peer.nodeId);
    });

    session.on("error", (error) => {
      this.emit("peer:error", { nodeId: peer.nodeId, error });
    });

    this.sessions.set(peer.nodeId, session);
    this.updatePeerState(peer.nodeId, "syncing");

    // Accept stream and handle incoming sync
    const stream = await connection.acceptStream();
    await session.handleIncomingSync(stream);
  }

  private handleSyncError(nodeId: string): void {
    if (!this.config.autoReconnect) return;

    const attempts = (this.reconnectAttempts.get(nodeId) ?? 0) + 1;
    this.reconnectAttempts.set(nodeId, attempts);

    if (attempts > this.config.maxReconnectAttempts) {
      this.logger.warn(`Max reconnect attempts reached for peer: ${nodeId}`);
      return;
    }

    // Exponential backoff
    const delay = this.config.reconnectBackoff * Math.pow(2, attempts - 1);
    this.logger.info(
      `Reconnecting to ${nodeId} in ${delay}ms (attempt ${attempts})`,
    );

    setTimeout(() => {
      this.syncPeer(nodeId).catch((err) => {
        this.logger.error("Reconnect failed:", err);
      });
    }, delay);
  }

  // ===========================================================================
  // Private: State Management
  // ===========================================================================

  private updatePeerState(nodeId: string, state: PeerState): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.state = state;
    }
  }

  private setStatus(status: "idle" | "syncing" | "offline" | "error"): void {
    if (this.status !== status) {
      this.status = status;
      this.emit("status:change", status);
    }
  }

  // ===========================================================================
  // Private: Auto Sync
  // ===========================================================================

  private startAutoSync(): void {
    this.autoSyncTimer = setInterval(() => {
      this.syncAll().catch((err) => {
        this.logger.error("Auto sync failed:", err);
      });
    }, this.config.autoSyncInterval);
  }

  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ===========================================================================
  // Private: Persistence
  // ===========================================================================

  private async loadPeers(): Promise<void> {
    try {
      const data = await this.storage.read(PEERS_STORAGE_KEY);
      if (data) {
        const stored: StoredPeerInfo[] = JSON.parse(
          new TextDecoder().decode(data),
        );
        for (const sp of stored) {
          this.peers.set(sp.nodeId, {
            ...sp,
            state: "offline", // All peers start offline
          });
        }
        this.logger.debug(`Loaded ${this.peers.size} stored peers`);
      }
    } catch (error) {
      this.logger.warn("Failed to load peers:", error);
    }
  }

  private async savePeers(): Promise<void> {
    const stored: StoredPeerInfo[] = Array.from(this.peers.values()).map(
      (p) => ({
        nodeId: p.nodeId,
        name: p.name,
        ticket: p.ticket,
        firstSeen: p.firstSeen,
        lastSynced: p.lastSynced,
        lastSeen: p.lastSeen,
        trusted: p.trusted,
      }),
    );

    const data = new TextEncoder().encode(JSON.stringify(stored));
    await this.storage.write(PEERS_STORAGE_KEY, data);
  }
}
