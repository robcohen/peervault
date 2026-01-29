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
  PairingRequest,
} from "./types";
import { PeerGroupManager, DEFAULT_GROUP_ID } from "./groups";
import { PeerErrors } from "../errors";

const PEERS_STORAGE_KEY = "peervault-peers";

const DEFAULT_CONFIG: Omit<Required<PeerManagerConfig>, "hostname"> = {
  autoSyncInterval: 60000, // 1 minute
  autoReconnect: true,
  maxReconnectAttempts: 10,
  reconnectBackoff: 1000,
};

/** Events from peer manager */
interface PeerManagerEvents extends Record<string, unknown> {
  "peer:connected": PeerInfo;
  "peer:disconnected": { nodeId: string; reason?: string };
  "peer:synced": string;
  "peer:error": { nodeId: string; error: Error };
  "peer:pairing-request": PairingRequest;
  "peer:pairing-accepted": string;
  "peer:pairing-denied": string;
  "status:change": "idle" | "syncing" | "offline" | "error";
}

/**
 * Manages peer connections and sync sessions.
 */
export class PeerManager extends EventEmitter<PeerManagerEvents> {
  private peers = new Map<string, PeerInfo>();
  private sessions = new Map<string, SyncSession>();
  private reconnectAttempts = new Map<string, number>();
  private pendingPairingRequests = new Map<string, { request: PairingRequest; connection: PeerConnection }>();
  private config: Omit<Required<PeerManagerConfig>, "hostname"> & { hostname?: string };
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
  async addPeer(ticket: string, nickname?: string): Promise<PeerInfo> {
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
        if (nickname) peer.nickname = nickname;
        peer.lastSeen = Date.now();
      } else {
        // Create new peer
        peer = {
          nodeId,
          nickname,
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
   * Remove a peer and notify them.
   */
  async removePeer(nodeId: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (session) {
      // Notify the peer before closing
      await session.sendPeerRemoved("User removed peer");
      await session.close();
      this.sessions.delete(nodeId);
    }

    this.peers.delete(nodeId);
    this.reconnectAttempts.delete(nodeId);

    await this.savePeers();
    this.emit("peer:disconnected", { nodeId, reason: "removed" });
    this.logger.info("Removed peer:", nodeId);
  }

  /**
   * Remove a peer locally without notifying them.
   * Used when we receive a PEER_REMOVED message from the peer.
   */
  private async removePeerLocally(nodeId: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (session) {
      await session.close();
      this.sessions.delete(nodeId);
    }

    this.peers.delete(nodeId);
    this.reconnectAttempts.delete(nodeId);

    await this.savePeers();
    this.emit("peer:disconnected", { nodeId, reason: "removed by peer" });
    this.logger.info("Peer removed us:", nodeId);
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
   * Update peer nickname.
   */
  async setNickname(nodeId: string, nickname: string): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.nickname = nickname;
      await this.savePeers();
    }
  }

  /**
   * Get pending pairing requests.
   */
  getPendingPairingRequests(): PairingRequest[] {
    return Array.from(this.pendingPairingRequests.values()).map((p) => p.request);
  }

  /**
   * Accept a pairing request from an unknown peer.
   */
  async acceptPairingRequest(nodeId: string, nickname?: string): Promise<PeerInfo> {
    const pending = this.pendingPairingRequests.get(nodeId);
    if (!pending) {
      throw PeerErrors.unknownPeer(nodeId);
    }

    const { connection } = pending;
    this.pendingPairingRequests.delete(nodeId);

    // Create peer info
    const peer: PeerInfo = {
      nodeId,
      nickname,
      state: "connecting",
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      trusted: true,
      groupIds: [DEFAULT_GROUP_ID],
    };
    this.peers.set(nodeId, peer);
    this.groupManager.addPeerToGroup(DEFAULT_GROUP_ID, nodeId);

    this.logger.info("Accepted pairing request from:", nodeId);
    this.emit("peer:pairing-accepted", nodeId);

    // Save the peer first
    await this.savePeers();
    this.emit("peer:connected", peer);

    // Continue with the existing connection - the initiator already opened
    // a stream and is waiting for us to accept it and respond.
    // We become the acceptor in this sync session.
    try {
      await this.handleIncomingSyncSession(connection, peer);
    } catch (error) {
      this.logger.error("Failed to start sync after accepting pairing:", error);
      this.updatePeerState(nodeId, "error");
    }

    return peer;
  }

  /**
   * Deny a pairing request.
   */
  async denyPairingRequest(nodeId: string): Promise<void> {
    const pending = this.pendingPairingRequests.get(nodeId);
    if (!pending) {
      return; // Already handled or expired
    }

    const { connection } = pending;
    this.pendingPairingRequests.delete(nodeId);

    this.logger.info("Denied pairing request from:", nodeId);
    await connection.close();
    this.emit("peer:pairing-denied", nodeId);
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
    peerHostname?: string;
    peerNickname?: string;
    lastSyncTime: number;
    isConnected: boolean;
  }> {
    return Array.from(this.peers.values()).map((peer) => ({
      peerId: peer.nodeId,
      peerHostname: peer.hostname,
      peerNickname: peer.nickname,
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
      throw PeerErrors.unknownPeer(nodeId);
    }

    // Check for existing session
    const existingSession = this.sessions.get(nodeId);
    if (existingSession?.getState() === "live") {
      // Already synced and in live mode
      return;
    }

    // First, try to use an existing connection
    let connection = this.transport.getConnection(nodeId);

    // If no existing connection, try to create a new one with the ticket
    if (!connection && peer.ticket) {
      try {
        this.logger.debug("No existing connection, connecting with ticket...");
        connection = await this.transport.connectWithTicket(peer.ticket);
      } catch (error) {
        this.logger.error("Failed to connect to peer:", nodeId, error);
        this.updatePeerState(nodeId, "error");
        throw error;
      }
    }

    if (!connection) {
      throw PeerErrors.notFound(nodeId);
    }

    try {
      await this.startSyncSession(connection, peer);
    } catch (error) {
      this.logger.error("Failed to sync with peer:", nodeId, error);
      this.updatePeerState(nodeId, "error");
      throw error;
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

    // Check if peer is known
    const peer = this.peers.get(nodeId);
    if (!peer) {
      // Unknown peer - emit pairing request instead of rejecting
      this.logger.info("Pairing request from unknown peer:", nodeId);

      const request: PairingRequest = {
        nodeId,
        timestamp: Date.now(),
      };

      // Store the connection so we can accept/deny later
      this.pendingPairingRequests.set(nodeId, { request, connection });

      // Emit event for UI to show the request
      this.emit("peer:pairing-request", request);
      return;
    }

    // Verify peer is trusted before accepting sync
    if (!peer.trusted) {
      this.logger.warn("Rejected untrusted peer:", nodeId);
      await connection.close();
      return;
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

    // Generate our ticket for bidirectional reconnection
    const ourTicket = await this.transport.generateTicket();

    // Create new session with blob store for binary sync
    const session = new SyncSession(
      peer.nodeId,
      this.documentManager,
      this.logger,
      { peerIsReadOnly: syncPolicy.readOnly, ourTicket, ourHostname: this.config.hostname },
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
        this.handleSyncError(peer.nodeId, true); // Reconnect on clean disconnect
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

    // Store peer's ticket when received (for bidirectional reconnection)
    session.on("ticket:received", (ticket) => {
      this.logger.debug(`Received ticket from peer ${peer.nodeId.slice(0, 8)}`);
      peer.ticket = ticket;
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peer ticket:", err),
      );
    });

    // Store peer's hostname when received (for display)
    session.on("hostname:received", (hostname) => {
      this.logger.debug(`Received hostname from peer ${peer.nodeId.slice(0, 8)}: ${hostname}`);
      peer.hostname = hostname;
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peer hostname:", err),
      );
    });

    // Handle peer removing us
    session.on("peer:removed", () => {
      this.removePeerLocally(peer.nodeId).catch((err) =>
        this.logger.error("Failed to remove peer locally:", err),
      );
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

    // Allow vault adoption on first sync (peer has never synced before)
    const isFirstSync = peer.lastSynced === undefined;

    // Generate our ticket for bidirectional reconnection
    const ourTicket = await this.transport.generateTicket();

    // Create new session with blob store for binary sync
    const session = new SyncSession(
      peer.nodeId,
      this.documentManager,
      this.logger,
      { peerIsReadOnly: syncPolicy.readOnly, allowVaultAdoption: isFirstSync, ourTicket, ourHostname: this.config.hostname },
      this.blobStore,
    );

    // Set up event handlers (same as above)
    session.on("state:change", (state) => {
      if (state === "live") {
        this.updatePeerState(peer.nodeId, "synced");
      } else if (state === "error") {
        this.updatePeerState(peer.nodeId, "error");
        this.handleSyncError(peer.nodeId);
      } else if (state === "closed") {
        this.updatePeerState(peer.nodeId, "offline");
        this.handleSyncError(peer.nodeId, true); // Reconnect on clean disconnect
      }
    });

    session.on("sync:complete", () => {
      peer.lastSynced = Date.now();
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peers:", err),
      );
      this.emit("peer:synced", peer.nodeId);
    });

    // Store peer's ticket when received (for bidirectional reconnection)
    session.on("ticket:received", (ticket) => {
      this.logger.debug(`Received ticket from peer ${peer.nodeId.slice(0, 8)}`);
      peer.ticket = ticket;
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peer ticket:", err),
      );
    });

    // Store peer's hostname when received (for display)
    session.on("hostname:received", (hostname) => {
      this.logger.debug(`Received hostname from peer ${peer.nodeId.slice(0, 8)}: ${hostname}`);
      peer.hostname = hostname;
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peer hostname:", err),
      );
    });

    // Handle peer removing us
    session.on("peer:removed", () => {
      this.removePeerLocally(peer.nodeId).catch((err) =>
        this.logger.error("Failed to remove peer locally:", err),
      );
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

  private handleSyncError(nodeId: string, isCleanDisconnect = false): void {
    if (!this.config.autoReconnect) return;

    // Only increment counter for errors, not clean disconnects
    // This prevents sleep/wake cycles from exhausting retry limit
    const attempts = isCleanDisconnect
      ? (this.reconnectAttempts.get(nodeId) ?? 0)
      : (this.reconnectAttempts.get(nodeId) ?? 0) + 1;

    if (!isCleanDisconnect) {
      this.reconnectAttempts.set(nodeId, attempts);
    }

    if (attempts > this.config.maxReconnectAttempts) {
      this.logger.warn(`Max reconnect attempts reached for peer: ${nodeId}`);
      return;
    }

    // Exponential backoff for errors, fixed 5s delay for clean disconnects
    const delay = isCleanDisconnect
      ? 5000
      : Math.min(this.config.reconnectBackoff * Math.pow(2, attempts - 1), 30000);

    this.logger.info(
      `Reconnecting to ${nodeId} in ${delay}ms${isCleanDisconnect ? ' (clean disconnect)' : ` (attempt ${attempts})`}`,
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
    // Sync after a short delay on startup to allow incoming connections to arrive first
    setTimeout(() => {
      this.syncAll().catch((err) => {
        this.logger.error("Initial auto sync failed:", err);
      });
    }, 3000);

    // Then sync periodically
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
        const stored = JSON.parse(new TextDecoder().decode(data)) as Array<
          StoredPeerInfo & { name?: string }
        >;
        for (const sp of stored) {
          // Migrate old 'name' field to 'nickname'
          const nickname = sp.nickname ?? sp.name;
          this.peers.set(sp.nodeId, {
            nodeId: sp.nodeId,
            hostname: sp.hostname,
            nickname,
            state: "offline", // All peers start offline
            ticket: sp.ticket,
            firstSeen: sp.firstSeen,
            lastSynced: sp.lastSynced,
            lastSeen: sp.lastSeen,
            trusted: sp.trusted,
            groupIds: sp.groupIds,
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
        hostname: p.hostname,
        nickname: p.nickname,
        ticket: p.ticket,
        firstSeen: p.firstSeen,
        lastSynced: p.lastSynced,
        lastSeen: p.lastSeen,
        trusted: p.trusted,
        groupIds: p.groupIds,
      }),
    );

    const data = new TextEncoder().encode(JSON.stringify(stored));
    await this.storage.write(PEERS_STORAGE_KEY, data);
  }
}
