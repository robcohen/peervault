/**
 * Peer Manager
 *
 * Manages peer connections, sync sessions, and coordination between
 * the transport layer and document manager.
 */

import type { Transport, PeerConnection, SyncStream } from "../transport";
import type { DocumentManager } from "../core/document-manager";
import type { BlobStore } from "../core/blob-store";
import type { Logger } from "../utils/logger";
import type { StorageAdapter } from "../types";
import { SyncSession } from "../sync/sync-session";
import { EventEmitter } from "../utils/events";
import { protocolTracer } from "../utils/protocol-tracer";
import type {
  PeerInfo,
  StoredPeerInfo,
  PeerState,
  PeerManagerConfig,
  PairingRequest,
  ConnectionHealth,
  ConnectionQuality,
} from "./types";
import { PeerGroupManager, DEFAULT_GROUP_ID } from "./groups";
import { PeerErrors } from "../errors";

const PEERS_STORAGE_KEY = "peervault-peers";

/** Rate limiting config for pairing requests */
const PAIRING_RATE_LIMIT = {
  /** Max pending requests from different peers */
  maxPendingRequests: 10,
  /** Max requests from same peer in window */
  maxRequestsPerPeer: 3,
  /** Time window for per-peer rate limiting (ms) */
  windowMs: 60000, // 1 minute
  /** Base backoff after denial (ms) */
  denialBackoffBase: 30000, // 30 seconds
  /** Maximum backoff after repeated denials (ms) */
  denialBackoffMax: 3600000, // 1 hour
  /** Max unique peers to track in history (prevents unbounded growth) */
  maxTrackedPeers: 100,
};

const DEFAULT_CONFIG: Omit<Required<PeerManagerConfig>, "hostname" | "nickname"> = {
  autoSyncInterval: 30000, // Reduced from 60s for more frequent sync checks
  autoReconnect: true,
  maxReconnectAttempts: 10,
  reconnectBackoff: 500, // Reduced from 1000 for faster reconnection
};

/** Vault adoption request for user confirmation */
export interface VaultAdoptionRequest {
  nodeId: string;
  peerVaultId: string;
  ourVaultId: string;
  /** Call to respond to the adoption request */
  respond: (accept: boolean) => void;
}

/** Events from peer manager */
interface PeerManagerEvents extends Record<string, unknown> {
  "peer:connected": PeerInfo;
  "peer:disconnected": { nodeId: string; reason?: string };
  "peer:synced": string;
  "peer:error": { nodeId: string; error: Error };
  "peer:pairing-request": PairingRequest;
  "peer:pairing-accepted": string;
  "peer:pairing-denied": string;
  "vault:adoption-request": VaultAdoptionRequest;
  "status:change": "idle" | "syncing" | "offline" | "error";
  "blob:received": string; // blob hash - used to retry binary file writes
}

/**
 * Manages peer connections and sync sessions.
 */
export class PeerManager extends EventEmitter<PeerManagerEvents> {
  private peers = new Map<string, PeerInfo>();
  private sessions = new Map<string, SyncSession>();
  private reconnectAttempts = new Map<string, { count: number; lastAttempt: number }>();
  private pendingPairingRequests = new Map<string, {
    request: PairingRequest;
    connection: PeerConnection;
    unsubscribeStateChange: () => void;
  }>();
  /** Rate limiting for pairing requests: nodeId -> array of request timestamps */
  private pairingRequestHistory = new Map<string, number[]>();
  /** Denial tracking for exponential backoff: nodeId -> { count, lastDenied } */
  private pairingDenialHistory = new Map<string, { count: number; lastDenied: number }>();
  private config: Omit<Required<PeerManagerConfig>, "hostname" | "nickname"> & { hostname: string; nickname?: string };
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private initialSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Pending reconnect timers by nodeId - tracked so they can be cancelled on shutdown */
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private status: "idle" | "syncing" | "offline" | "error" = "idle";
  private groupManager!: PeerGroupManager;
  /** Unsubscribe from incoming connection events */
  private unsubscribeIncoming: (() => void) | null = null;
  /** Whether initialize() has been called */
  private initialized = false;
  /** Whether shutdown() is in progress */
  private shuttingDown = false;
  /** Tickets currently being processed by addPeer to prevent duplicate calls */
  private pendingAddPeerTickets = new Set<string>();

  constructor(
    private transport: Transport,
    private documentManager: DocumentManager,
    private storage: StorageAdapter,
    private logger: Logger,
    config: PeerManagerConfig,
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
    // Guard against multiple initialization or initialization during shutdown
    if (this.initialized) {
      this.logger.warn("PeerManager already initialized, skipping");
      return;
    }
    if (this.shuttingDown) {
      this.logger.warn("PeerManager is shutting down, cannot initialize");
      return;
    }
    this.initialized = true;

    // Clear any stale sessions from previous plugin instance
    // (async cleanup from previous onunload may not have completed)
    if (this.sessions.size > 0) {
      this.logger.warn(`Clearing ${this.sessions.size} stale sessions from previous instance`);
      for (const [nodeId, session] of this.sessions) {
        try {
          await session.close();
        } catch (err) {
          this.logger.debug(`Error closing stale session for ${nodeId.slice(0, 8)}:`, err);
        }
      }
      this.sessions.clear();
    }

    // Initialize group manager
    this.groupManager = new PeerGroupManager(
      this.documentManager.getLoro(),
      this.logger,
    );

    // Load stored peers
    await this.loadPeers();

    // Clean up stale peer IDs from groups
    const validPeerIds = new Set(this.peers.keys());
    const cleaned = this.groupManager.cleanupStalePeers(validPeerIds);
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} stale peer(s) from groups`);
    }

    // Handle incoming connections (store unsubscribe for cleanup)
    this.unsubscribeIncoming = this.transport.onIncomingConnection(async (conn) => {
      await this.handleIncomingConnection(conn);
    });

    // Always do initial sync on startup to reconnect to peers
    // Periodic sync is optional and controlled by autoSyncInterval
    this.startInitialSync();
    if (this.config.autoSyncInterval > 0) {
      this.startPeriodicSync();
    }

    this.logger.info("PeerManager initialized");
  }

  /**
   * Shut down the peer manager.
   */
  async shutdown(): Promise<void> {
    // Guard against concurrent shutdown or shutdown when not initialized
    if (this.shuttingDown) {
      this.logger.warn("PeerManager already shutting down, skipping");
      return;
    }
    this.shuttingDown = true;

    this.stopAutoSync();

    // Cancel all pending reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    // Unsubscribe from transport events
    if (this.unsubscribeIncoming) {
      this.unsubscribeIncoming();
      this.unsubscribeIncoming = null;
    }

    // Close all sessions
    for (const session of this.sessions.values()) {
      await session.close();
    }
    this.sessions.clear();

    // Save peer state
    await this.savePeers();

    // Clean up pending pairing request listeners before clearing
    for (const pending of this.pendingPairingRequests.values()) {
      pending.unsubscribeStateChange();
    }

    // Clear all tracking maps to prevent memory leaks
    this.reconnectAttempts.clear();
    this.pairingRequestHistory.clear();
    this.pairingDenialHistory.clear();
    this.pendingPairingRequests.clear();

    // Remove all event listeners
    this.removeAllListeners();

    this.initialized = false;
    this.shuttingDown = false;
    this.logger.info("PeerManager shut down");
  }

  // ===========================================================================
  // Peer Operations
  // ===========================================================================

  /**
   * Add a new peer using their connection ticket.
   */
  async addPeer(ticket: string): Promise<PeerInfo> {
    // Guard against duplicate concurrent calls with the same ticket
    if (this.pendingAddPeerTickets.has(ticket)) {
      this.logger.warn("addPeer already in progress for this ticket, ignoring duplicate call");
      throw PeerErrors.unknownPeer("Duplicate addPeer call");
    }
    this.pendingAddPeerTickets.add(ticket);

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
        peer.lastSeen = Date.now();
      } else {
        // Create new peer (hostname/nickname will be received during sync)
        peer = {
          nodeId,
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
    } finally {
      this.pendingAddPeerTickets.delete(ticket);
    }
  }

  /**
   * Remove a peer and notify them.
   */
  async removePeer(nodeId: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (session) {
      // Always remove from map first to prevent stale references
      this.sessions.delete(nodeId);
      try {
        // Notify the peer before closing
        await session.sendPeerRemoved("User removed peer");
        await session.close();
      } catch (err) {
        this.logger.warn("Error closing session during peer removal:", err);
      }
    }

    this.peers.delete(nodeId);
    this.reconnectAttempts.delete(nodeId);
    this.groupManager.removePeerFromAllGroups(nodeId);

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
      // Always remove from map first to prevent stale references
      this.sessions.delete(nodeId);
      try {
        await session.close();
      } catch (err) {
        this.logger.warn("Error closing session during local peer removal:", err);
      }
    }

    this.peers.delete(nodeId);
    this.reconnectAttempts.delete(nodeId);
    this.groupManager.removePeerFromAllGroups(nodeId);

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
   * Get the round-trip time (RTT) in milliseconds for a peer.
   */
  getPeerRtt(nodeId: string): number | undefined {
    const connection = this.transport.getConnection(nodeId);
    return connection?.getRttMs();
  }

  /**
   * Record a ping result for connection health monitoring.
   * @param nodeId Peer's node ID
   * @param rttMs RTT in milliseconds, or undefined if ping failed
   */
  recordPingResult(nodeId: string, rttMs: number | undefined): void {
    const peer = this.peers.get(nodeId);
    if (!peer) return;

    // Initialize health if not present
    if (!peer.health) {
      peer.health = {
        quality: "good",
        avgRttMs: 0,
        jitterMs: 0,
        failedPings: 0,
        successfulPings: 0,
        rttHistory: [],
      };
    }

    const previousQuality = peer.health.quality;

    if (rttMs !== undefined) {
      // Successful ping
      peer.health.failedPings = 0;
      peer.health.successfulPings++;
      peer.health.lastPingAt = Date.now();

      // Update RTT history (keep last 20 samples)
      peer.health.rttHistory.push(rttMs);
      if (peer.health.rttHistory.length > 20) {
        peer.health.rttHistory.shift();
      }

      // Calculate average RTT
      const sum = peer.health.rttHistory.reduce((a, b) => a + b, 0);
      peer.health.avgRttMs = sum / peer.health.rttHistory.length;

      // Calculate jitter (standard deviation)
      if (peer.health.rttHistory.length > 1) {
        const variance = peer.health.rttHistory.reduce(
          (acc, val) => acc + Math.pow(val - peer.health!.avgRttMs, 2),
          0,
        ) / peer.health.rttHistory.length;
        peer.health.jitterMs = Math.sqrt(variance);
      }
    } else {
      // Failed ping
      peer.health.failedPings++;
    }

    // Assess quality
    peer.health.quality = this.assessConnectionQuality(peer.health);

    // Emit event if quality changed
    if (peer.health.quality !== previousQuality) {
      this.logger.event("info", "peer.health_change", {
        nodeId: nodeId.slice(0, 8),
        quality: peer.health.quality,
        previousQuality,
        avgRttMs: peer.health.avgRttMs,
        jitterMs: peer.health.jitterMs,
        failedPings: peer.health.failedPings,
      }, `Connection quality changed: ${previousQuality} → ${peer.health.quality}`);

      this.emit("peer:health-change", {
        nodeId,
        quality: peer.health.quality,
        previousQuality,
      });
    }
  }

  /**
   * Assess connection quality based on health metrics.
   */
  private assessConnectionQuality(health: ConnectionHealth): ConnectionQuality {
    // Disconnected if many consecutive failures
    if (health.failedPings >= 5) {
      return "disconnected";
    }

    // Poor if recent failures
    if (health.failedPings >= 2) {
      return "poor";
    }

    // Need some data to assess
    if (health.rttHistory.length === 0) {
      return "good"; // Default until we have data
    }

    const avgRtt = health.avgRttMs;
    const jitter = health.jitterMs;

    // Excellent: low RTT and low jitter
    if (avgRtt < 50 && jitter < 10) {
      return "excellent";
    }

    // Good: reasonable RTT and jitter
    if (avgRtt < 150 && jitter < 30) {
      return "good";
    }

    // Fair: higher RTT or jitter
    if (avgRtt < 300 && jitter < 60) {
      return "fair";
    }

    // Poor: high RTT or jitter
    return "poor";
  }

  /**
   * Get connection health for a peer.
   */
  getConnectionHealth(nodeId: string): ConnectionHealth | undefined {
    return this.peers.get(nodeId)?.health;
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

    const { connection, unsubscribeStateChange } = pending;
    unsubscribeStateChange(); // Clean up state change listener
    this.pendingPairingRequests.delete(nodeId);
    this.clearPairingRateLimit(nodeId);

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

    // Register persistent stream listener for this connection.
    // This allows the peer to initiate new sync sessions at any time.
    this.logger.info(`[acceptPairingRequest] Registering onStream callback for peer ${peer.nodeId.slice(0, 8)}`);
    const unsubscribeStream = connection.onStream((stream) => {
      this.logger.info(`[acceptPairingRequest] onStream callback fired for peer ${peer.nodeId.slice(0, 8)}, stream ${stream.id}`);
      this.handleIncomingStream(stream, connection, peer).catch((err) => {
        this.logger.error("Error handling incoming stream:", err);
      });
    });

    // Clean up listener when connection closes
    connection.onStateChange((state) => {
      if (state === "disconnected" || state === "error") {
        unsubscribeStream();
      }
    });

    // Continue with the existing connection - the initiator already opened
    // a stream and is waiting for us to accept it and respond.
    // We become the acceptor in this sync session.
    // Process any pending streams (the initiator's stream is likely already queued)
    // Add timeout to prevent blocking the UI thread indefinitely
    try {
      await Promise.race([
        this.processPendingStreams(connection, peer),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("processPendingStreams timeout")), 10000)
        ),
      ]);
    } catch (error) {
      this.logger.warn("Failed to process pending streams after accepting pairing:", error);
      // Don't set error state - the initiator (peer) will retry and we'll accept then
      // Setting up the stream listener above ensures we can accept future streams
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

    const { connection, unsubscribeStateChange } = pending;
    unsubscribeStateChange(); // Clean up state change listener
    this.pendingPairingRequests.delete(nodeId);
    this.pairingRequestHistory.delete(nodeId);
    // Record denial for exponential backoff (don't clear denial history!)
    this.recordPairingDenial(nodeId);

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

  /**
   * Set the local device's display nickname.
   */
  setOwnNickname(nickname: string | undefined): void {
    this.config.nickname = nickname;
  }

  /**
   * Close the sync session for a specific peer.
   */
  async closeSession(nodeId: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (session) {
      await session.close();
      this.sessions.delete(nodeId);
    }
  }

  /**
   * Get aggregated sync progress from all active sessions.
   */
  getSyncProgress(): {
    activeSessions: number;
    totalBlobsToSend: number;
    totalBlobsSent: number;
    totalBlobsToReceive: number;
    totalBlobsReceived: number;
    totalBytesSent: number;
    totalBytesReceived: number;
  } {
    let totalBlobsToSend = 0;
    let totalBlobsSent = 0;
    let totalBlobsToReceive = 0;
    let totalBlobsReceived = 0;
    let totalBytesSent = 0;
    let totalBytesReceived = 0;

    for (const session of this.sessions.values()) {
      const progress = session.getProgress();
      totalBlobsToSend += progress.blobsToSend;
      totalBlobsSent += progress.blobsSent;
      totalBlobsToReceive += progress.blobsToReceive;
      totalBlobsReceived += progress.blobsReceived;
      totalBytesSent += progress.bytesSent;
      totalBytesReceived += progress.bytesReceived;
    }

    return {
      activeSessions: this.sessions.size,
      totalBlobsToSend,
      totalBlobsSent,
      totalBlobsToReceive,
      totalBlobsReceived,
      totalBytesSent,
      totalBytesReceived,
    };
  }

  // ===========================================================================
  // Manual Sync
  // ===========================================================================

  /**
   * Manually trigger sync with all connected peers.
   */
  async syncAll(): Promise<void> {
    this.setStatus("syncing");

    const syncTasks: Array<{ nodeId: string; promise: Promise<void> }> = [];
    for (const peer of this.peers.values()) {
      // Sync peers in synced, offline, or error state
      // Error peers need reconnection attempts too
      if (peer.state === "synced" || peer.state === "offline" || peer.state === "error") {
        syncTasks.push({
          nodeId: peer.nodeId,
          promise: this.syncPeer(peer.nodeId),
        });
      }
    }

    const results = await Promise.allSettled(syncTasks.map((t) => t.promise));

    // Log any failures with peer IDs for diagnostics
    let hasFailures = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const syncTask = syncTasks[i];
      if (result && result.status === "rejected" && syncTask) {
        hasFailures = true;
        const nodeId = syncTask.nodeId;
        this.logger.debug(
          `Sync failed for peer ${nodeId.slice(0, 8)}:`,
          (result as PromiseRejectedResult).reason,
        );
      }
    }

    this.setStatus(hasFailures ? "error" : "idle");
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
    if (existingSession) {
      const state = existingSession.getState();
      // Preserve sessions that are actively working or just created
      // "idle" means the session was just created and sync is about to start
      if (state === "idle" || state === "live" || state === "exchanging_versions" || state === "syncing") {
        this.logger.debug(`Session for ${nodeId.slice(0, 8)} already active (state: ${state}), skipping`);
        return;
      }
      // Session exists but in error or closed state - close it
      this.logger.debug(`Closing stale session for peer ${nodeId.slice(0, 8)} (state: ${state})`);
      try {
        await Promise.race([
          existingSession.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Session close timeout")), 5000)
          ),
        ]);
      } catch (err) {
        this.logger.warn(`Failed to close stale session for ${nodeId.slice(0, 8)}:`, err);
      }
      this.sessions.delete(nodeId);
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
        // Schedule retry for connection failures (peer may be temporarily unavailable)
        this.handleSyncError(nodeId);
        throw error;
      }
    }

    if (!connection) {
      throw PeerErrors.notFound(nodeId);
    }

    // Check if peer has pending streams for us - if so, handle those first
    // This prevents the race condition where both sides try to initiate simultaneously
    const pendingCount = connection.getPendingStreamCount();
    if (pendingCount > 0) {
      this.logger.debug(`Peer ${nodeId.slice(0, 8)} has ${pendingCount} pending stream(s), handling as acceptor`);
      await this.processPendingStreams(connection, peer);
      // Check if we now have an active session from handling the pending stream
      const session = this.sessions.get(nodeId);
      if (session && session.getState() !== "error") {
        return; // Session created from incoming stream, don't also initiate
      }
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

    protocolTracer.trace("", nodeId, "peer", "incoming.connection", {
      peerCount: this.peers.size,
      hasPeer: this.peers.has(nodeId),
    });

    // Check if peer is known
    const peer = this.peers.get(nodeId);
    if (!peer) {
      // Unknown peer - check rate limits before accepting pairing request
      const rateLimited = !this.checkPairingRateLimit(nodeId);
      protocolTracer.trace("", nodeId, "peer", "pairing.creating", {
        rateLimited,
      });

      if (rateLimited) {
        this.logger.warn("Pairing request rate limited:", nodeId);
        await connection.close();
        return;
      }

      this.logger.info("Pairing request from unknown peer:", nodeId);

      const request: PairingRequest = {
        nodeId,
        timestamp: Date.now(),
      };

      // Clean up pending request if connection disconnects before user responds
      const unsubscribeStateChange = connection.onStateChange((state) => {
        if (state === "disconnected" || state === "error") {
          const pending = this.pendingPairingRequests.get(nodeId);
          if (pending && pending.connection === connection) {
            this.logger.debug("Pairing request connection lost:", nodeId);
            pending.unsubscribeStateChange(); // Clean up the listener
            this.pendingPairingRequests.delete(nodeId);
          }
        }
      });

      // Store the connection and unsubscribe so we can accept/deny later
      this.pendingPairingRequests.set(nodeId, { request, connection, unsubscribeStateChange });

      protocolTracer.trace("", nodeId, "peer", "pairing.stored", {
        pendingCount: this.pendingPairingRequests.size,
      });

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

    // Register persistent stream listener for this connection.
    // This allows the peer to initiate new sync sessions at any time.
    const unsubscribe = connection.onStream((stream) => {
      this.handleIncomingStream(stream, connection, peer).catch((err) => {
        this.logger.error("Error handling incoming stream:", err);
      });
    });

    // Clean up listener when connection closes
    connection.onStateChange((state) => {
      if (state === "disconnected" || state === "error") {
        unsubscribe();
      }
    });

    // Also process any streams that arrived before we registered the listener
    // (they're queued in pendingStreams)
    this.processPendingStreams(connection, peer);
  }

  // ===========================================================================
  // Private: Sync Sessions
  // ===========================================================================

  /**
   * Attach common event handlers to a sync session.
   * @param session - The sync session to attach handlers to
   * @param peer - The peer info for this session
   * @param isInitiator - Whether we initiated this connection (affects reconnect handling)
   */
  private attachSessionHandlers(
    session: SyncSession,
    peer: PeerInfo,
    isInitiator: boolean,
  ): void {
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

      // Collect bandwidth stats from this session
      const sessionStats = session.getBandwidthStats();
      const now = Date.now();
      if (!peer.bandwidth) {
        peer.bandwidth = {
          bytesSent: 0,
          bytesReceived: 0,
          lastSessionBytesSent: 0,
          lastSessionBytesReceived: 0,
          lastUpdated: now,
        };
      }
      // Accumulate totals and record last session stats
      peer.bandwidth.bytesSent += sessionStats.bytesSent;
      peer.bandwidth.bytesReceived += sessionStats.bytesReceived;
      peer.bandwidth.lastSessionBytesSent = sessionStats.bytesSent;
      peer.bandwidth.lastSessionBytesReceived = sessionStats.bytesReceived;
      peer.bandwidth.lastUpdated = now;

      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peers:", err),
      );
      this.emit("peer:synced", peer.nodeId);
      // Reset reconnect counter on successful sync (only for initiator to avoid double-reset)
      if (isInitiator) {
        this.reconnectAttempts.delete(peer.nodeId);
      }
    });

    // Store peer's ticket when received (for bidirectional reconnection)
    session.on("ticket:received", (ticket) => {
      this.logger.debug(`Received ticket from peer ${peer.nodeId.slice(0, 8)}`);
      peer.ticket = ticket;
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peer ticket:", err),
      );
    });

    // Store peer's info when received (for display)
    session.on("peer:info", ({ hostname, nickname }) => {
      this.logger.debug(`Received info from peer ${peer.nodeId.slice(0, 8)}: ${hostname}${nickname ? ` (${nickname})` : ""}`);
      peer.hostname = hostname;
      peer.nickname = nickname;
      this.savePeers().catch((err) =>
        this.logger.error("Failed to save peer info:", err),
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

    // Handle blob received - emit event so VaultSync can retry binary file writes
    session.on("blob:received", (hash) => {
      this.emit("blob:received", hash);
    });
  }

  private async startSyncSession(
    connection: PeerConnection,
    peer: PeerInfo,
  ): Promise<void> {
    // Close existing session if any (with timeout to prevent blocking)
    const existingSession = this.sessions.get(peer.nodeId);
    if (existingSession) {
      try {
        await Promise.race([
          existingSession.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Session close timeout")), 5000)
          ),
        ]);
      } catch (err) {
        this.logger.warn(`Failed to close existing session for ${peer.nodeId.slice(0, 8)}:`, err);
      }
      this.sessions.delete(peer.nodeId);
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
      {
        peerIsReadOnly: syncPolicy.readOnly,
        ourTicket,
        ourHostname: this.config.hostname,
        ourNickname: this.config.nickname,
      },
      this.blobStore,
    );

    // Set up event handlers
    this.attachSessionHandlers(session, peer, true);

    this.sessions.set(peer.nodeId, session);
    this.updatePeerState(peer.nodeId, "syncing");

    // Open stream and start sync with timeout to prevent indefinite blocking
    const stream = await Promise.race([
      connection.openStream(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("openStream timeout")), 30000)
      ),
    ]);
    await session.startSync(stream);
  }

  private async handleIncomingSyncSession(
    connection: PeerConnection,
    peer: PeerInfo,
  ): Promise<void> {
    // Close existing session if any (with timeout to prevent blocking)
    const existingSession = this.sessions.get(peer.nodeId);
    if (existingSession) {
      try {
        await Promise.race([
          existingSession.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Session close timeout")), 5000)
          ),
        ]);
      } catch (err) {
        this.logger.warn(`Failed to close existing session for ${peer.nodeId.slice(0, 8)}:`, err);
      }
      this.sessions.delete(peer.nodeId);
    }

    // Get effective sync policy for this peer
    const syncPolicy = this.groupManager.getEffectiveSyncPolicy(peer.nodeId);

    // Allow vault adoption on first sync (peer has never synced before)
    const isFirstSync = peer.lastSynced === undefined;

    // Generate our ticket for bidirectional reconnection
    const ourTicket = await this.transport.generateTicket();

    // Create vault adoption confirmation callback with timeout to prevent indefinite hanging
    const VAULT_ADOPTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const onVaultAdoptionNeeded = async (peerVaultId: string, ourVaultId: string): Promise<boolean> => {
      return new Promise((resolve) => {
        let resolved = false;
        const respond = (accept: boolean) => {
          if (!resolved) {
            resolved = true;
            resolve(accept);
          }
        };

        // Timeout after 5 minutes - reject adoption if no response
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.logger.warn("Vault adoption request timed out, rejecting");
            resolve(false);
          }
        }, VAULT_ADOPTION_TIMEOUT_MS);

        this.emit("vault:adoption-request", {
          nodeId: peer.nodeId,
          peerVaultId,
          ourVaultId,
          respond: (accept: boolean) => {
            clearTimeout(timeout);
            respond(accept);
          },
        });
      });
    };

    // Create new session with blob store for binary sync
    const session = new SyncSession(
      peer.nodeId,
      this.documentManager,
      this.logger,
      {
        peerIsReadOnly: syncPolicy.readOnly,
        allowVaultAdoption: isFirstSync,
        onVaultAdoptionNeeded: isFirstSync ? onVaultAdoptionNeeded : undefined,
        ourTicket,
        ourHostname: this.config.hostname,
        ourNickname: this.config.nickname,
      },
      this.blobStore,
    );

    // Set up event handlers
    this.attachSessionHandlers(session, peer, false);

    this.sessions.set(peer.nodeId, session);
    this.updatePeerState(peer.nodeId, "syncing");

    // Accept stream and handle incoming sync
    const stream = await connection.acceptStream();
    await session.handleIncomingSync(stream);
  }

  /**
   * Handle an incoming stream as a sync request.
   * This is called by the onStream callback for each new stream.
   */
  private async handleIncomingStream(
    stream: SyncStream,
    connection: PeerConnection,
    peer: PeerInfo,
  ): Promise<void> {
    this.logger.info(`[handleIncomingStream] Starting for peer ${peer.nodeId.slice(0, 8)}, stream ${stream.id}`);

    // Trace stream handling
    protocolTracer.traceStream("", peer.nodeId, stream.id, "peer", "stream.handling", {
      existingSession: this.sessions.has(peer.nodeId),
    });

    // Close existing session if any (with timeout to prevent blocking)
    // IMPORTANT: When a peer opens a NEW stream to us, it means their old session died
    // (e.g., they reloaded their plugin). We must close our old session and accept the new one.
    const existingSession = this.sessions.get(peer.nodeId);
    if (existingSession) {
      const state = existingSession.getState();

      // Handle the case where both sides try to initiate simultaneously
      // Use deterministic tie-breaking: lower node ID wins (becomes initiator)
      if (state === "exchanging_versions") {
        const ourNodeId = this.transport.getNodeId();
        const weAreInitiator = ourNodeId < peer.nodeId;

        if (weAreInitiator) {
          // We have lower node ID - we should be initiator
          // Ignore incoming stream, peer should accept our stream instead
          this.logger.debug(
            `Ignoring incoming stream - we are initiator (our ID < peer ID), peer should accept our stream`
          );
          return;
        } else {
          // Peer has lower node ID - they should be initiator
          // Close our initiator session and become acceptor
          this.logger.debug(
            `Abandoning our initiator session - peer has lower node ID, becoming acceptor`
          );
        }
      } else {
        // Peer is reconnecting - their old session died, ours is stale
        this.logger.debug(
          `Peer reconnecting - closing existing session (state: ${state}) to accept new stream`
        );
      }

      // Close the existing session to accept the new incoming stream
      try {
        await Promise.race([
          existingSession.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Session close timeout")), 5000)
          ),
        ]);
      } catch (err) {
        this.logger.warn(`Failed to close existing session for ${peer.nodeId.slice(0, 8)}:`, err);
      }
      this.sessions.delete(peer.nodeId);
    }

    // Get effective sync policy for this peer
    const syncPolicy = this.groupManager.getEffectiveSyncPolicy(peer.nodeId);

    // Allow vault adoption on first sync (peer has never synced before)
    const isFirstSync = peer.lastSynced === undefined;

    // Generate our ticket for bidirectional reconnection
    const ourTicket = await this.transport.generateTicket();

    // Create vault adoption confirmation callback
    const VAULT_ADOPTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const onVaultAdoptionNeeded = async (peerVaultId: string, ourVaultId: string): Promise<boolean> => {
      return new Promise((resolve) => {
        let resolved = false;
        const respond = (accept: boolean) => {
          if (!resolved) {
            resolved = true;
            resolve(accept);
          }
        };

        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.logger.warn("Vault adoption request timed out, rejecting");
            resolve(false);
          }
        }, VAULT_ADOPTION_TIMEOUT_MS);

        this.emit("vault:adoption-request", {
          nodeId: peer.nodeId,
          peerVaultId,
          ourVaultId,
          respond: (accept: boolean) => {
            clearTimeout(timeout);
            respond(accept);
          },
        });
      });
    };

    // Create new session
    const session = new SyncSession(
      peer.nodeId,
      this.documentManager,
      this.logger,
      {
        peerIsReadOnly: syncPolicy.readOnly,
        allowVaultAdoption: isFirstSync,
        onVaultAdoptionNeeded: isFirstSync ? onVaultAdoptionNeeded : undefined,
        ourTicket,
        ourHostname: this.config.hostname,
        ourNickname: this.config.nickname,
      },
      this.blobStore,
    );

    // Set up event handlers
    this.attachSessionHandlers(session, peer, false);

    this.sessions.set(peer.nodeId, session);
    this.updatePeerState(peer.nodeId, "syncing");

    // Handle the incoming sync with the provided stream
    await session.handleIncomingSync(stream);
  }

  /**
   * Process any pending streams that arrived before the listener was registered.
   * Uses getPendingStreamCount() to avoid blocking on acceptStream() when empty.
   */
  private async processPendingStreams(
    connection: PeerConnection,
    peer: PeerInfo,
  ): Promise<void> {
    // Process all pending streams without blocking
    // We check the count first to avoid adding orphaned pendingAccepts entries
    const initialCount = connection.getPendingStreamCount();
    this.logger.debug(`[processPendingStreams ${peer.nodeId.slice(0, 8)}] Starting with ${initialCount} pending streams`);

    let processed = 0;
    while (connection.getPendingStreamCount() > 0) {
      try {
        this.logger.debug(`[processPendingStreams ${peer.nodeId.slice(0, 8)}] Accepting stream ${processed + 1}...`);
        const stream = await connection.acceptStream();
        this.logger.debug(`[processPendingStreams ${peer.nodeId.slice(0, 8)}] Got stream ${stream.id}, handling...`);
        await this.handleIncomingStream(stream, connection, peer);
        processed++;
        this.logger.debug(`[processPendingStreams ${peer.nodeId.slice(0, 8)}] Stream ${stream.id} handled`);
      } catch (err) {
        this.logger.warn(`[processPendingStreams ${peer.nodeId.slice(0, 8)}] Error processing pending stream:`, err);
        break;
      }
    }
    this.logger.debug(`[processPendingStreams ${peer.nodeId.slice(0, 8)}] Done, processed ${processed} streams`);
  }

  private handleSyncError(nodeId: string, isCleanDisconnect = false): void {
    if (!this.config.autoReconnect) return;

    const now = Date.now();
    const existing = this.reconnectAttempts.get(nodeId);

    // Only increment counter for errors, not clean disconnects
    // This prevents sleep/wake cycles from exhausting retry limit
    const attempts = isCleanDisconnect
      ? (existing?.count ?? 0)
      : (existing?.count ?? 0) + 1;

    if (!isCleanDisconnect) {
      this.reconnectAttempts.set(nodeId, { count: attempts, lastAttempt: now });
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

    // Cancel any existing reconnect timer for this peer
    const existingTimer = this.reconnectTimers.get(nodeId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Track the timer so it can be cancelled on shutdown
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(nodeId);
      this.syncPeer(nodeId).catch((err) => {
        this.logger.error("Reconnect failed:", err);
      });
    }, delay);
    this.reconnectTimers.set(nodeId, timer);
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

  /**
   * Start initial sync after a short delay.
   * This always runs on startup to reconnect to stored peers.
   */
  private startInitialSync(): void {
    this.initialSyncTimeout = setTimeout(() => {
      this.initialSyncTimeout = null; // Clear reference after firing
      this.syncAll().catch((err) => {
        this.logger.error("Initial sync failed:", err);
      });
    }, 500); // Short delay to allow incoming connections to arrive first
  }

  /**
   * Start periodic sync timer.
   * Only runs if autoSyncInterval > 0.
   */
  private startPeriodicSync(): void {
    this.autoSyncTimer = setInterval(() => {
      this.syncAll().catch((err) => {
        this.logger.error("Periodic sync failed:", err);
      });
      // Periodically clean up stale entries to prevent memory leaks
      this.cleanupStaleEntries();
    }, this.config.autoSyncInterval);
  }

  /**
   * Clean up stale entries in tracking maps to prevent memory leaks.
   * Removes entries that haven't been updated in over 1 hour.
   */
  private cleanupStaleEntries(): void {
    const now = Date.now();
    const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

    // Clean up stale reconnect attempts
    for (const [nodeId, entry] of this.reconnectAttempts) {
      if (now - entry.lastAttempt > STALE_THRESHOLD_MS) {
        this.reconnectAttempts.delete(nodeId);
        this.logger.debug(`Cleaned up stale reconnect entry for ${nodeId}`);
      }
    }

    // Clean up stale pairing request history
    for (const [nodeId, timestamps] of this.pairingRequestHistory) {
      const recentTimestamps = timestamps.filter(
        (t) => now - t < PAIRING_RATE_LIMIT.windowMs,
      );
      if (recentTimestamps.length === 0) {
        this.pairingRequestHistory.delete(nodeId);
      } else if (recentTimestamps.length !== timestamps.length) {
        this.pairingRequestHistory.set(nodeId, recentTimestamps);
      }
    }

    // Clean up stale denial history (keep for backoff period, then remove)
    for (const [nodeId, entry] of this.pairingDenialHistory) {
      const backoffMs = Math.min(
        PAIRING_RATE_LIMIT.denialBackoffBase * Math.pow(2, entry.count - 1),
        PAIRING_RATE_LIMIT.denialBackoffMax,
      );
      if (now - entry.lastDenied > backoffMs + STALE_THRESHOLD_MS) {
        this.pairingDenialHistory.delete(nodeId);
        this.logger.debug(`Cleaned up stale denial entry for ${nodeId}`);
      }
    }
  }

  private stopAutoSync(): void {
    if (this.initialSyncTimeout) {
      clearTimeout(this.initialSyncTimeout);
      this.initialSyncTimeout = null;
    }
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ===========================================================================
  // Private: Rate Limiting
  // ===========================================================================

  /**
   * Check if a pairing request from this peer is allowed.
   * Returns true if allowed, false if rate limited.
   */
  private checkPairingRateLimit(nodeId: string): boolean {
    const now = Date.now();
    const windowStart = now - PAIRING_RATE_LIMIT.windowMs;

    // Check total pending requests limit
    if (this.pendingPairingRequests.size >= PAIRING_RATE_LIMIT.maxPendingRequests) {
      this.logger.debug("Too many pending pairing requests");
      return false;
    }

    // Check exponential backoff from previous denials
    const denial = this.pairingDenialHistory.get(nodeId);
    if (denial) {
      const backoffMs = Math.min(
        PAIRING_RATE_LIMIT.denialBackoffBase * Math.pow(2, denial.count - 1),
        PAIRING_RATE_LIMIT.denialBackoffMax,
      );
      const backoffEnds = denial.lastDenied + backoffMs;

      if (now < backoffEnds) {
        const remainingSec = Math.ceil((backoffEnds - now) / 1000);
        this.logger.debug(
          `Peer ${nodeId.slice(0, 8)} in denial backoff for ${remainingSec}s more`,
        );
        return false;
      }
    }

    // Check per-peer rate limit
    let history = this.pairingRequestHistory.get(nodeId) ?? [];

    // Remove old entries outside the time window
    history = history.filter((ts) => ts > windowStart);

    if (history.length >= PAIRING_RATE_LIMIT.maxRequestsPerPeer) {
      this.logger.debug(`Peer ${nodeId.slice(0, 8)} exceeded pairing request limit`);
      return false;
    }

    // Enforce max unique peers limit before adding new entry
    if (
      !this.pairingRequestHistory.has(nodeId) &&
      this.pairingRequestHistory.size >= PAIRING_RATE_LIMIT.maxTrackedPeers
    ) {
      // Remove oldest entry (first in Map iteration order)
      const oldestKey = this.pairingRequestHistory.keys().next().value;
      if (oldestKey !== undefined) {
        this.pairingRequestHistory.delete(oldestKey);
        this.logger.debug(`Pruned oldest pairing history for ${oldestKey.slice(0, 8)}`);
      }
    }

    // Same limit for denial history
    if (
      !this.pairingDenialHistory.has(nodeId) &&
      this.pairingDenialHistory.size >= PAIRING_RATE_LIMIT.maxTrackedPeers
    ) {
      const oldestKey = this.pairingDenialHistory.keys().next().value;
      if (oldestKey !== undefined) {
        this.pairingDenialHistory.delete(oldestKey);
        this.logger.debug(`Pruned oldest denial history for ${oldestKey.slice(0, 8)}`);
      }
    }

    // Record this request
    history.push(now);
    this.pairingRequestHistory.set(nodeId, history);

    return true;
  }

  /**
   * Record a pairing denial for exponential backoff.
   */
  private recordPairingDenial(nodeId: string): void {
    const existing = this.pairingDenialHistory.get(nodeId);
    this.pairingDenialHistory.set(nodeId, {
      count: (existing?.count ?? 0) + 1,
      lastDenied: Date.now(),
    });
  }

  /**
   * Clear rate limit history for a peer (e.g., after accepting).
   */
  private clearPairingRateLimit(nodeId: string): void {
    this.pairingRequestHistory.delete(nodeId);
    this.pairingDenialHistory.delete(nodeId);
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
            bandwidth: sp.bandwidth,
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
        bandwidth: p.bandwidth,
      }),
    );

    const data = new TextEncoder().encode(JSON.stringify(stored));
    await this.storage.write(PEERS_STORAGE_KEY, data);
  }
}
