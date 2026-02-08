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
import type { KnownPeerInfo, KeyExchangeRequestMessage } from "../sync/types";
import { SyncMessageType } from "../sync/types";
import { PeerErrors } from "../errors";
import {
  PairingKeyExchange,
  isKeyExchangeMessage,
  parseKeyExchangeMessage,
} from "../crypto";

/**
 * A stream wrapper that can prepend buffered data to the first receive() call.
 * Used when we need to peek at stream data for protocol detection.
 */
class BufferedStream implements SyncStream {
  private bufferedData: Uint8Array | null;
  private inner: SyncStream;

  constructor(inner: SyncStream, bufferedData: Uint8Array) {
    this.inner = inner;
    this.bufferedData = bufferedData;
  }

  get id(): string {
    return this.inner.id;
  }

  async send(data: Uint8Array): Promise<void> {
    return this.inner.send(data);
  }

  async receive(): Promise<Uint8Array> {
    // Return buffered data on first call
    if (this.bufferedData) {
      const data = this.bufferedData;
      this.bufferedData = null;
      return data;
    }
    return this.inner.receive();
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  isOpen(): boolean {
    return this.inner.isOpen();
  }
}

const PEERS_STORAGE_KEY = "peervault-peers";
const DISCOVERED_PEERS_STORAGE_KEY = "peervault-discovered-peers";
const TOMBSTONES_STORAGE_KEY = "peervault-peer-tombstones";

/** Stored format for discovered peers */
interface StoredDiscoveredPeer {
  peer: KnownPeerInfo;
  discoveredAt: number;
}

/** Tombstone for removed peers - prevents re-discovery */
interface PeerTombstone {
  nodeId: string;
  removedAt: number;
  reason: "removed" | "left";
}

/**
 * Global cleanup coordination for PeerManager instances.
 * When a PeerManager is shutting down, new instances must wait for it to complete.
 * This prevents race conditions when plugins are rapidly disabled/enabled.
 */
let pendingPeerManagerCleanup: Promise<void> | null = null;

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

const DEFAULT_CONFIG: Omit<Required<PeerManagerConfig>, "hostname" | "nickname" | "pluginVersion"> = {
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
  "peer:discovered": KnownPeerInfo; // Peer discovered via gossip
  "vault:adoption-request": VaultAdoptionRequest;
  "vault:key-received": Uint8Array; // Vault key received from peer during pairing
  "status:change": "idle" | "syncing" | "offline" | "error";
  "blob:received": string; // blob hash - used to retry binary file writes
  "live:updates": void; // CRDT updates received during live mode
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
  /** Discovered peers from announcements - waiting for them to connect to us */
  private discoveredPeers = new Map<string, { peer: KnownPeerInfo; discoveredAt: number }>();
  /** Queue of discovered peers to connect to (rate-limited) */
  private discoveryQueue: KnownPeerInfo[] = [];
  /** Currently active discovery connection attempts */
  private activeDiscoveryConnections = 0;
  /** Max concurrent discovery connections to prevent storms */
  private static readonly MAX_CONCURRENT_DISCOVERY = 3;
  /** Base delay between discovery connection attempts (ms) */
  private static readonly DISCOVERY_BASE_DELAY = 500;
  /** Whether discovery queue is being processed */
  private processingDiscoveryQueue = false;
  /** Retry tracking for failed discovery connections */
  private discoveryRetries = new Map<string, { count: number; lastAttempt: number; peer: KnownPeerInfo }>();
  /** Max retry attempts for discovery connections */
  private static readonly MAX_DISCOVERY_RETRIES = 3;
  /** Base retry delay for discovery connections (ms) - doubles each attempt */
  private static readonly DISCOVERY_RETRY_BASE_DELAY = 2000;
  /** TTL for discovered peers waiting for incoming connections (ms) */
  private static readonly DISCOVERED_PEER_TTL = 5 * 60 * 1000; // 5 minutes
  /** Cleanup interval for stale discovered peers (ms) */
  private static readonly DISCOVERY_CLEANUP_INTERVAL = 60 * 1000; // 1 minute
  /** Timer for cleaning up stale discovered peers */
  private discoveryCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Tombstones for removed peers - prevents re-discovery */
  private peerTombstones = new Map<string, PeerTombstone>();
  /** TTL for peer tombstones (ms) - after this, peer can be re-discovered */
  private static readonly TOMBSTONE_TTL = 60 * 60 * 1000; // 1 hour
  /** Timer for periodic re-announcements */
  private reAnnouncementTimer: ReturnType<typeof setInterval> | null = null;
  /** Interval for periodic re-announcements (ms) */
  private static readonly RE_ANNOUNCEMENT_INTERVAL = 2 * 60 * 1000; // 2 minutes
  /** Seen announcement hashes for deduplication */
  private seenAnnouncements = new Set<string>();
  /** TTL for seen announcements (ms) */
  private static readonly SEEN_ANNOUNCEMENT_TTL = 5 * 60 * 1000; // 5 minutes
  /** Timestamps for seen announcements (for cleanup) */
  private seenAnnouncementTimestamps = new Map<string, number>();
  /** Rate limiting for announcements: nodeId -> array of timestamps */
  private announcementRateLimit = new Map<string, number[]>();
  /** Max announcements per peer per window */
  private static readonly MAX_ANNOUNCEMENTS_PER_PEER = 20;
  /** Time window for announcement rate limiting (ms) */
  private static readonly ANNOUNCEMENT_RATE_WINDOW = 60 * 1000; // 1 minute
  /** Timer for peer list reconciliation */
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  /** Interval for peer list reconciliation (ms) */
  private static readonly RECONCILIATION_INTERVAL = 5 * 60 * 1000; // 5 minutes
  /** Timer for connection repair */
  private connectionRepairTimer: ReturnType<typeof setInterval> | null = null;
  /** Interval for connection repair (ms) */
  private static readonly CONNECTION_REPAIR_INTERVAL = 30 * 1000; // 30 seconds
  /** Minimum time since last seen before attempting repair (ms) */
  private static readonly REPAIR_STALE_THRESHOLD = 60 * 1000; // 1 minute
  private config: Omit<Required<PeerManagerConfig>, "hostname" | "nickname" | "pluginVersion"> & { hostname: string; nickname?: string; pluginVersion?: string };
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private initialSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Pending reconnect timers by nodeId - tracked so they can be cancelled on shutdown */
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private status: "idle" | "syncing" | "offline" | "error" = "idle";
  /** Unsubscribe from incoming connection events */
  private unsubscribeIncoming: (() => void) | null = null;
  /** Whether initialize() has been called */
  private initialized = false;
  /** Whether shutdown() is in progress */
  private shuttingDown = false;
  /** Tickets currently being processed by addPeer to prevent duplicate calls */
  private pendingAddPeerTickets = new Set<string>();
  /** Key exchange handler for vault key sharing during pairing */
  private pairingKeyExchange: PairingKeyExchange | null = null;

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
   * Set the pairing key exchange handler.
   * This should be called after the transport is initialized with the Iroh secret key.
   */
  setPairingKeyExchange(keyExchange: PairingKeyExchange): void {
    this.pairingKeyExchange = keyExchange;
    this.logger.debug("Pairing key exchange handler configured");
  }

  /**
   * Get the pairing key exchange handler.
   */
  getPairingKeyExchange(): PairingKeyExchange | null {
    return this.pairingKeyExchange;
  }

  /**
   * Request vault key from a peer.
   * Opens a new stream for key exchange and requests the vault key.
   * Only called by initiator during first pairing.
   */
  async requestVaultKeyFromPeer(connection: PeerConnection, peer: PeerInfo): Promise<void> {
    if (!this.pairingKeyExchange) {
      this.logger.debug("No PairingKeyExchange configured, skipping key exchange");
      return;
    }

    // Only request if we don't already have a vault key
    const hasKey = await this.pairingKeyExchange.hasVaultKey();
    if (hasKey) {
      this.logger.debug("Already have vault key, skipping key exchange request");
      return;
    }

    try {
      this.logger.info(`Requesting vault key from peer ${peer.nodeId.slice(0, 8)}`);

      // Open a new stream for key exchange
      const stream = await Promise.race([
        connection.openStream(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Key exchange stream open timeout")), 30000)
        ),
      ]);

      // Request vault key from peer
      const result = await this.pairingKeyExchange.requestKeyFromPeer(stream);

      if (result.success && result.vaultKey) {
        this.logger.info(`Received vault key from peer ${peer.nodeId.slice(0, 8)}`);
        // Notify listeners (e.g., main.ts) so CloudSync can be updated
        this.emit("vault:key-received", result.vaultKey);
      } else {
        this.logger.warn(`Key exchange failed: ${result.error}`);
      }

      // Close the key exchange stream
      await stream.close().catch(() => {});
    } catch (error) {
      this.logger.warn("Failed to request vault key from peer:", error);
    }
  }

  /**
   * Initialize the peer manager.
   * Loads stored peers and sets up connection handlers.
   */
  async initialize(): Promise<void> {
    // Wait for any pending cleanup from a previous instance
    // This prevents race conditions when plugins are rapidly disabled/enabled
    if (pendingPeerManagerCleanup) {
      this.logger.debug("Waiting for previous PeerManager cleanup to complete...");
      await pendingPeerManagerCleanup;
      this.logger.debug("Previous PeerManager cleanup complete");
    }

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
    // (this is a safety net - normally pendingPeerManagerCleanup handles this)
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

    // Load stored peers
    await this.loadPeers();

    // Load discovered peers and tombstones from storage
    await this.loadDiscoveredPeers();
    await this.loadTombstones();

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

    // Start cleanup timer for stale discovered peers
    this.startDiscoveryCleanup();

    // Start periodic re-announcements for mesh consistency
    this.startReAnnouncements();

    // Start periodic peer list reconciliation (anti-entropy)
    this.startReconciliation();

    // Start periodic connection repair for peers without live sessions
    this.startConnectionRepair();

    this.logger.info("PeerManager initialized");
  }

  /**
   * Shut down the peer manager.
   * Tracks cleanup globally so new instances wait for it to complete.
   */
  async shutdown(): Promise<void> {
    // Guard against concurrent shutdown or shutdown when not initialized
    if (this.shuttingDown) {
      this.logger.warn("PeerManager already shutting down, skipping");
      // Return the existing cleanup promise so callers can await it
      if (pendingPeerManagerCleanup) {
        await pendingPeerManagerCleanup;
      }
      return;
    }
    this.shuttingDown = true;

    // Track this cleanup globally so new instances wait for it
    const cleanupPromise = this.performShutdown();
    pendingPeerManagerCleanup = cleanupPromise;

    try {
      await cleanupPromise;
    } finally {
      // Clear the global tracker when done
      if (pendingPeerManagerCleanup === cleanupPromise) {
        pendingPeerManagerCleanup = null;
      }
    }
  }

  /**
   * Internal shutdown implementation.
   */
  private async performShutdown(): Promise<void> {
    this.stopAutoSync();

    // Stop discovery cleanup timer
    if (this.discoveryCleanupTimer) {
      clearInterval(this.discoveryCleanupTimer);
      this.discoveryCleanupTimer = null;
    }

    // Stop re-announcement timer
    if (this.reAnnouncementTimer) {
      clearInterval(this.reAnnouncementTimer);
      this.reAnnouncementTimer = null;
    }

    // Stop reconciliation timer
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }

    // Stop connection repair timer
    if (this.connectionRepairTimer) {
      clearInterval(this.connectionRepairTimer);
      this.connectionRepairTimer = null;
    }

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

    // Save discovered peers and tombstones for persistence across restarts
    await this.saveDiscoveredPeers();
    await this.saveTombstones();

    // Clean up pending pairing request listeners before clearing
    for (const pending of this.pendingPairingRequests.values()) {
      pending.unsubscribeStateChange();
    }

    // Clear all tracking maps to prevent memory leaks
    this.reconnectAttempts.clear();
    this.pairingRequestHistory.clear();
    this.pairingDenialHistory.clear();
    this.pendingPairingRequests.clear();
    this.discoveredPeers.clear();
    this.discoveryQueue.length = 0;
    this.discoveryRetries.clear();
    this.peerTombstones.clear();
    this.seenAnnouncements.clear();
    this.seenAnnouncementTimestamps.clear();
    this.announcementRateLimit.clear();

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
   * @param ticket - The connection ticket for the peer
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

      // Check for duplicate session - if we already have an active session, skip
      const existingSession = this.sessions.get(nodeId);
      if (existingSession) {
        const state = existingSession.getState();
        if (state === "live" || state === "syncing" || state === "exchanging_versions") {
          this.logger.debug(`Already have active session with ${nodeId.slice(0, 8)} (state: ${state}), skipping addPeer`);
          // Update peer's lastSeen but don't start another session
          const peer = this.peers.get(nodeId);
          if (peer) {
            peer.lastSeen = Date.now();
            await this.savePeers();
            return peer;
          }
        }
      }

      // Check if peer already exists (for key exchange decision)
      const existingPeerBefore = this.peers.has(nodeId);
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
        };
        this.peers.set(nodeId, peer);
      }

      // Start sync session
      await this.startSyncSession(connection, peer);

      // Request vault key from peer if this is a new peer (first pairing)
      // and we don't already have a vault key
      if (!existingPeerBefore) {
        await this.requestVaultKeyFromPeer(connection, peer);
      }

      await this.savePeers();
      this.emit("peer:connected", peer);

      // Announce the new peer to other peers (for mesh discovery)
      this.announcePeerToAll(peer).catch(err => {
        this.logger.warn("Failed to announce peer:", err);
      });

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

    // Create tombstone to prevent re-discovery
    this.createTombstone(nodeId, "removed");

    // Announce the removal to other peers (mesh cleanup)
    this.announcePeerLeft(nodeId, "removed").catch(err => {
      this.logger.warn("Failed to announce peer removal:", err);
    });

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
   * Get the connection type for a peer (direct, relay, mixed, or none).
   * @param nodeId Peer's node ID
   * @returns Connection type or undefined if not connected
   */
  getPeerConnectionType(nodeId: string): import("../transport/types").ConnectionType | undefined {
    const connection = this.transport.getConnection(nodeId);
    return connection?.getConnectionType();
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
   * @param nodeId - The peer's node ID
   * @param nickname - Optional nickname for the peer
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
    };
    this.peers.set(nodeId, peer);

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
      this.handleIncomingStream(stream, connection, peer).catch((err: Error) => {
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

    // Announce the new peer to all other peers (for mesh discovery)
    this.announcePeerToAll(peer).catch((err: Error) => {
      this.logger.warn("Failed to announce peer:", err);
    });

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

  /**
   * Clear all sessions in error state.
   * Used for recovery after reconnection failures.
   */
  clearErrorSessions(): void {
    const toDelete: string[] = [];

    for (const [nodeId, session] of this.sessions) {
      if (session.getState() === "error") {
        toDelete.push(nodeId);
      }
    }

    for (const nodeId of toDelete) {
      this.logger.debug(`Clearing error session for ${nodeId.slice(0, 8)}`);
      const session = this.sessions.get(nodeId);
      if (session) {
        try {
          session.close();
        } catch {
          // Ignore close errors
        }
      }
      this.sessions.delete(nodeId);
    }

    if (toDelete.length > 0) {
      this.logger.info(`Cleared ${toDelete.length} error session(s)`);
    }
  }

  // ===========================================================================
  // Peer Discovery (Group-Based)
  // ===========================================================================

  /**
   * Get all known peers as KnownPeerInfo for protocol discovery exchange.
   * Only includes peers that are trusted and have tickets.
   */
  getKnownPeersInfo(): KnownPeerInfo[] {
    const result: KnownPeerInfo[] = [];
    const ourNodeId = this.transport.getNodeId();

    for (const peer of this.peers.values()) {
      // Skip self and untrusted peers
      if (peer.nodeId === ourNodeId || !peer.trusted) {
        continue;
      }

      // Only include peers with tickets (required for discovery)
      if (!peer.ticket) {
        continue;
      }

      result.push({
        nodeId: peer.nodeId,
        ticket: peer.ticket,
        groupIds: [], // Groups removed - all peers share the vault
        lastSeen: peer.lastSeen || Date.now(),
      });
    }

    return result;
  }

  /**
   * Handle peer discovery info received during VERSION_INFO exchange.
   * This processes known peers sent by the remote peer.
   */
  handlePeerDiscoveryInfo(
    fromPeerId: string,
    _groupIds: string[], // Ignored - groups removed
    knownPeers: KnownPeerInfo[]
  ): void {
    this.logger.info(
      `Received discovery info from ${fromPeerId.slice(0, 8)}: ${knownPeers.length} peers`
    );

    // Process discovered peers
    for (const discovered of knownPeers) {
      this.processDiscoveredPeer(discovered, fromPeerId);
    }
  }

  /**
   * Handle peer announcement received during live mode.
   * This processes newly joined/discovered peers announced by group members.
   */
  handlePeerAnnouncement(
    fromPeerId: string,
    peers: KnownPeerInfo[],
    reason: "joined" | "discovered" | "updated"
  ): void {
    // Rate limit announcements per peer
    if (!this.checkAnnouncementRateLimit(fromPeerId)) {
      this.logger.warn(
        `Rate limiting announcements from ${fromPeerId.slice(0, 8)} - too many in short time`
      );
      return;
    }

    this.logger.info(
      `Received peer announcement from ${fromPeerId.slice(0, 8)} (${reason}): ${peers.length} peer(s)`
    );

    for (const announced of peers) {
      // Check for duplicate announcements
      const announcementHash = this.computeAnnouncementHash(announced, fromPeerId);
      if (this.isAnnouncementSeen(announcementHash)) {
        this.logger.debug(
          `Skipping duplicate announcement for ${announced.nodeId.slice(0, 8)} from ${fromPeerId.slice(0, 8)}`
        );
        continue;
      }

      // Mark as seen
      this.markAnnouncementSeen(announcementHash);

      // Process the peer
      this.processDiscoveredPeer(announced, fromPeerId);
    }
  }

  /**
   * Compute a hash for announcement deduplication.
   * Uses nodeId and source to identify unique announcements.
   */
  private computeAnnouncementHash(peer: KnownPeerInfo, sourceNodeId: string): string {
    return `${peer.nodeId}:${sourceNodeId}`;
  }

  /**
   * Check if an announcement has been seen recently.
   */
  private isAnnouncementSeen(hash: string): boolean {
    return this.seenAnnouncements.has(hash);
  }

  /**
   * Mark an announcement as seen.
   */
  private markAnnouncementSeen(hash: string): void {
    this.seenAnnouncements.add(hash);
    this.seenAnnouncementTimestamps.set(hash, Date.now());
  }

  /**
   * Check announcement rate limit for a peer.
   * Returns true if allowed, false if rate limited.
   */
  private checkAnnouncementRateLimit(nodeId: string): boolean {
    const now = Date.now();
    const windowStart = now - PeerManager.ANNOUNCEMENT_RATE_WINDOW;

    let history = this.announcementRateLimit.get(nodeId) ?? [];

    // Remove old entries outside the window
    history = history.filter(ts => ts > windowStart);

    if (history.length >= PeerManager.MAX_ANNOUNCEMENTS_PER_PEER) {
      return false;
    }

    // Record this announcement
    history.push(now);
    this.announcementRateLimit.set(nodeId, history);

    return true;
  }

  /**
   * Process a discovered peer and optionally connect to it.
   */
  private processDiscoveredPeer(discovered: KnownPeerInfo, sourceNodeId: string): void {
    const ourNodeId = this.transport.getNodeId();

    // Skip self
    if (discovered.nodeId === ourNodeId) {
      return;
    }

    // Skip tombstoned peers (recently removed)
    const tombstone = this.peerTombstones.get(discovered.nodeId);
    if (tombstone) {
      const age = Date.now() - tombstone.removedAt;
      if (age < PeerManager.TOMBSTONE_TTL) {
        this.logger.debug(
          `Ignoring tombstoned peer ${discovered.nodeId.slice(0, 8)} (removed ${Math.floor(age / 1000)}s ago)`
        );
        return;
      }
      // Tombstone expired, remove it
      this.peerTombstones.delete(discovered.nodeId);
    }

    // Check if we already know this peer
    const existingPeer = this.peers.get(discovered.nodeId);

    if (existingPeer) {
      // Update existing peer's ticket if we didn't have one
      if (!existingPeer.ticket && discovered.ticket) {
        existingPeer.ticket = discovered.ticket;
        this.logger.debug(`Updated ticket for known peer ${discovered.nodeId.slice(0, 8)}`);
        this.savePeers().catch(err => this.logger.error("Failed to save peers:", err));
      }
      return;
    }

    // This is a new peer sharing the vault - emit discovery event
    this.logger.info(
      `Discovered new peer ${discovered.nodeId.slice(0, 8)} via ${sourceNodeId.slice(0, 8)}`
    );
    this.emit("peer:discovered", discovered);

    // Auto-connect to discovered peer if we have their ticket
    if (discovered.ticket) {
      this.connectToDiscoveredPeer(discovered);
    }
  }

  /**
   * Queue a discovered peer for connection (rate-limited).
   * Uses deterministic ordering to prevent dual-initiator deadlock.
   */
  private connectToDiscoveredPeer(discovered: KnownPeerInfo): void {
    // Don't connect if already connecting or connected
    if (this.peers.has(discovered.nodeId)) {
      return;
    }

    // Don't connect during shutdown
    if (this.shuttingDown) {
      return;
    }

    // Check if already in queue
    if (this.discoveryQueue.some(p => p.nodeId === discovered.nodeId)) {
      return;
    }

    // Use deterministic ordering: only the device with smaller node ID initiates.
    // This prevents both devices from trying to connect to each other simultaneously.
    const ourNodeId = this.transport.getNodeId();
    if (ourNodeId > discovered.nodeId) {
      this.logger.debug(
        `Not initiating connection to ${discovered.nodeId.slice(0, 8)} - waiting for them to connect (node ID ordering)`
      );
      // Store the discovered peer with timestamp so we auto-accept when they connect
      this.discoveredPeers.set(discovered.nodeId, { peer: discovered, discoveredAt: Date.now() });
      return;
    }

    // Add to discovery queue
    this.discoveryQueue.push(discovered);
    this.logger.debug(`Queued discovered peer ${discovered.nodeId.slice(0, 8)} for connection (queue size: ${this.discoveryQueue.length})`);

    // Start processing queue if not already running
    this.processDiscoveryQueueAsync();
  }

  /**
   * Process the discovery queue with rate limiting.
   * Connects to discovered peers with staggered delays to prevent connection storms.
   */
  private processDiscoveryQueueAsync(): void {
    if (this.processingDiscoveryQueue) {
      return;
    }
    this.processingDiscoveryQueue = true;

    // Use setImmediate to not block the current call stack
    setTimeout(() => this.processDiscoveryQueue(), 0);
  }

  /**
   * Internal: Process discovery queue items with rate limiting.
   */
  private async processDiscoveryQueue(): Promise<void> {
    while (this.discoveryQueue.length > 0 && !this.shuttingDown) {
      // Wait if at max concurrent connections
      while (this.activeDiscoveryConnections >= PeerManager.MAX_CONCURRENT_DISCOVERY && !this.shuttingDown) {
        await new Promise(r => setTimeout(r, 100));
      }

      if (this.shuttingDown) break;

      const discovered = this.discoveryQueue.shift();
      if (!discovered) continue;

      // Skip if already connected while waiting in queue
      if (this.peers.has(discovered.nodeId)) {
        continue;
      }

      // Add staggered delay based on node ID hash to spread out connection storms
      // When multiple devices discover each other simultaneously, this helps prevent
      // all connections from being attempted at the exact same moment
      const staggerDelay = this.calculateStaggerDelay(discovered.nodeId);
      if (staggerDelay > 0) {
        await new Promise(r => setTimeout(r, staggerDelay));
      }

      // Check again after delay
      if (this.peers.has(discovered.nodeId) || this.shuttingDown) {
        continue;
      }

      this.activeDiscoveryConnections++;
      const retryInfo = this.discoveryRetries.get(discovered.nodeId);
      const attemptNum = (retryInfo?.count ?? 0) + 1;
      this.logger.info(`Auto-connecting to discovered peer ${discovered.nodeId.slice(0, 8)} (attempt ${attemptNum}, active: ${this.activeDiscoveryConnections})`);

      try {
        // Use addPeer which handles all the connection logic
        await this.addPeer(discovered.ticket!);
        // Success - clear retry tracking
        this.discoveryRetries.delete(discovered.nodeId);
      } catch (error) {
        // Don't propagate error - this is a background operation
        this.logger.warn(`Failed to auto-connect to discovered peer:`, error);
        // Track retry for exponential backoff
        this.discoveryRetries.set(discovered.nodeId, {
          count: attemptNum,
          lastAttempt: Date.now(),
          peer: discovered,
        });
      } finally {
        this.activeDiscoveryConnections--;
      }
    }

    this.processingDiscoveryQueue = false;
  }

  /**
   * Calculate a stagger delay based on node IDs to spread out connection attempts.
   * Uses XOR of our node ID and peer node ID to get deterministic but distributed delays.
   */
  private calculateStaggerDelay(peerNodeId: string): number {
    const ourNodeId = this.transport.getNodeId();

    // XOR first 4 bytes of each node ID to get a semi-random value
    let xorValue = 0;
    for (let i = 0; i < Math.min(8, ourNodeId.length, peerNodeId.length); i++) {
      xorValue ^= ourNodeId.charCodeAt(i) ^ peerNodeId.charCodeAt(i);
    }

    // Convert to delay: 0-500ms based on XOR value
    return (xorValue % 256) * (PeerManager.DISCOVERY_BASE_DELAY / 256);
  }

  /**
   * Announce a peer to all connected peers.
   * Called when a new peer successfully connects and syncs.
   */
  async announcePeerToAll(peer: PeerInfo): Promise<void> {
    if (!peer.ticket) {
      this.logger.debug(`Cannot announce peer ${peer.nodeId.slice(0, 8)} - no ticket`);
      return;
    }

    const announcement: KnownPeerInfo = {
      nodeId: peer.nodeId,
      ticket: peer.ticket,
      groupIds: [], // Groups removed - all peers share the vault
      lastSeen: peer.lastSeen || Date.now(),
    };

    // Collect existing peers to announce to the new peer
    const existingPeersForNewPeer: KnownPeerInfo[] = [];

    // Find all live sessions
    let announcedCount = 0;
    for (const [sessionNodeId, session] of this.sessions) {
      // Don't announce to the peer itself
      if (sessionNodeId === peer.nodeId) {
        continue;
      }

      // Only announce if session is live
      if (session.getState() !== "live") {
        continue;
      }

      const sessionPeer = this.peers.get(sessionNodeId);
      if (!sessionPeer) {
        continue;
      }

      // Announce the new peer to this session
      try {
        await session.sendPeerAnnouncement([announcement], "joined");
        announcedCount++;
      } catch (err) {
        this.logger.warn(`Failed to announce peer to ${sessionNodeId.slice(0, 8)}:`, err);
      }

      // Collect this existing peer for announcement to the new peer
      if (sessionPeer.ticket) {
        existingPeersForNewPeer.push({
          nodeId: sessionPeer.nodeId,
          ticket: sessionPeer.ticket,
          groupIds: [], // Groups removed
          lastSeen: sessionPeer.lastSeen || Date.now(),
        });
      }
    }

    if (announcedCount > 0) {
      this.logger.info(`Announced peer ${peer.nodeId.slice(0, 8)} to ${announcedCount} peer(s)`);
    }

    // Now announce existing peers to the new peer
    if (existingPeersForNewPeer.length > 0) {
      const newPeerSession = this.sessions.get(peer.nodeId);
      if (newPeerSession && newPeerSession.getState() === "live") {
        try {
          await newPeerSession.sendPeerAnnouncement(existingPeersForNewPeer, "discovered");
          this.logger.info(
            `Announced ${existingPeersForNewPeer.length} existing peer(s) to new peer ${peer.nodeId.slice(0, 8)}`
          );
        } catch (err) {
          this.logger.warn(`Failed to announce existing peers to new peer:`, err);
        }
      }
    }
  }

  /**
   * Announce that a peer has left to all other peers.
   * Called when a peer is removed or disconnects.
   */
  async announcePeerLeft(
    nodeId: string,
    reason: "removed" | "disconnected" | "left"
  ): Promise<void> {
    let announcedCount = 0;

    for (const [sessionNodeId, session] of this.sessions) {
      // Don't notify the peer that left
      if (sessionNodeId === nodeId) {
        continue;
      }

      // Only notify if session is live
      if (session.getState() !== "live") {
        continue;
      }

      // Notify about the peer leaving
      try {
        await session.sendPeerLeft(nodeId, [], reason);
        announcedCount++;
      } catch (err) {
        this.logger.warn(`Failed to announce peer left to ${sessionNodeId.slice(0, 8)}:`, err);
      }
    }

    if (announcedCount > 0) {
      this.logger.info(`Announced peer ${nodeId.slice(0, 8)} left to ${announcedCount} peer(s)`);
    }
  }

  /**
   * Handle peer left notification from another peer.
   * Used for mesh cleanup when a peer is removed elsewhere.
   */
  handlePeerLeft(
    nodeId: string,
    _groupIds: string[], // Ignored - groups removed
    reason: "removed" | "disconnected" | "left"
  ): void {
    // Remove from discovered peers (if waiting for them to connect)
    this.discoveredPeers.delete(nodeId);

    // Remove from discovery queue
    const queueIndex = this.discoveryQueue.findIndex(p => p.nodeId === nodeId);
    if (queueIndex !== -1) {
      this.discoveryQueue.splice(queueIndex, 1);
    }

    // Create tombstone to prevent re-discovery (for "removed" and "left" reasons)
    if (reason === "removed" || reason === "left") {
      this.createTombstone(nodeId, reason === "removed" ? "removed" : "left");
    }

    // If we're connected to this peer, we should also disconnect
    const peer = this.peers.get(nodeId);
    if (peer && reason === "removed") {
      this.logger.info(`Peer ${nodeId.slice(0, 8)} was removed by another peer`);
      // Note: Don't cascade the removal announcement to avoid infinite loops
      // Just close the session and clean up locally
      const session = this.sessions.get(nodeId);
      if (session) {
        this.sessions.delete(nodeId);
        session.close().catch(err => {
          this.logger.warn("Error closing session after peer left:", err);
        });
      }
      this.peers.delete(nodeId);
      this.savePeers().catch(err => this.logger.error("Failed to save peers:", err));
      this.emit("peer:disconnected", { nodeId, reason: "removed" });
    }
  }

  // ===========================================================================
  // Manual Sync
  // ===========================================================================

  /**
   * Manually trigger sync with all connected peers.
   */
  async syncAll(): Promise<void> {
    // Clear any stale error sessions before syncing
    this.clearErrorSessions();

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

    // Register persistent stream listener for this connection.
    // This is critical for WebRTC upgrade - the peer may send signaling streams
    // even when we're the sync initiator.
    // NOTE: onStream is idempotent - it won't re-register if already registered.
    const unsubscribeStream = connection.onStream((stream) => {
      this.logger.debug(`[syncPeer] onStream callback fired for peer ${peer.nodeId.slice(0, 8)}, stream ${stream.id}`);
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
    let peer = this.peers.get(nodeId);
    if (!peer) {
      // Check if this is a discovered peer from a group announcement
      const discoveredEntry = this.discoveredPeers.get(nodeId);
      if (discoveredEntry) {
        this.logger.info(`Auto-accepting connection from discovered peer ${nodeId.slice(0, 8)}`);
        this.discoveredPeers.delete(nodeId);
        // Also clear any retry state
        this.discoveryRetries.delete(nodeId);

        const discoveredPeer = discoveredEntry.peer;

        // Create peer info from discovered peer data
        const now = Date.now();
        peer = {
          nodeId,
          nickname: undefined,
          trusted: true,
          ticket: discoveredPeer.ticket,
          state: "connecting" as const,
          firstSeen: now,
          lastSeen: now,
        };

        this.peers.set(nodeId, peer);
        await this.savePeers();
        this.emit("peer:connected", peer);
        // Continue to the normal sync flow below
      } else {
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
    }

    // At this point, peer is guaranteed to be defined (either from peers map or discovered)
    const knownPeer = peer!;

    // Verify peer is trusted before accepting sync
    if (!knownPeer.trusted) {
      this.logger.warn("Rejected untrusted peer:", nodeId);
      await connection.close();
      return;
    }

    knownPeer.lastSeen = Date.now();

    // Register persistent stream listener for this connection.
    // This allows the peer to initiate new sync sessions at any time.
    const unsubscribe = connection.onStream((stream) => {
      this.handleIncomingStream(stream, connection, knownPeer).catch((err) => {
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
    this.processPendingStreams(connection, knownPeer);
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
        // Reset global status to idle when we have a live session
        // This clears any transient "error" status from failed operations
        if (this.status === "error" || this.status === "syncing") {
          this.setStatus("idle");
        }
        // Announce the peer to other peers now that session is live
        this.announcePeerToAll(peer).catch((err: Error) => {
          this.logger.warn("Failed to announce peer on live state:", err);
        });
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

    session.on("live:updates", () => {
      this.emit("live:updates", undefined);
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

    // Generate our ticket for bidirectional reconnection
    const ourTicket = await this.transport.generateTicket();

    // Create new session with blob store for binary sync
    // All peers have the default sync policy: not read-only, can sync everything
    const session = new SyncSession(
      peer.nodeId,
      this.documentManager,
      this.logger,
      {
        peerIsReadOnly: false, // Groups removed - all peers can sync
        ourTicket,
        ourHostname: this.config.hostname,
        ourNickname: this.config.nickname,
        ourPluginVersion: this.config.pluginVersion,
        // Peer discovery (groups removed - empty array)
        ourGroupIds: [],
        getKnownPeers: () => this.getKnownPeersInfo(),
        onPeerDiscoveryInfo: (groupIds, knownPeers) => {
          this.handlePeerDiscoveryInfo(peer.nodeId, groupIds, knownPeers);
        },
        onPeerAnnouncement: (peers, reason) => {
          this.handlePeerAnnouncement(peer.nodeId, peers, reason);
        },
        onPeerLeft: (nodeId, groupIds, reason) => {
          this.handlePeerLeft(nodeId, groupIds, reason);
        },
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
    // All peers have the default sync policy: not read-only, can sync everything
    const session = new SyncSession(
      peer.nodeId,
      this.documentManager,
      this.logger,
      {
        peerIsReadOnly: false, // Groups removed - all peers can sync
        allowVaultAdoption: isFirstSync,
        onVaultAdoptionNeeded: isFirstSync ? onVaultAdoptionNeeded : undefined,
        ourTicket,
        ourHostname: this.config.hostname,
        ourNickname: this.config.nickname,
        ourPluginVersion: this.config.pluginVersion,
        // Peer discovery (groups removed - empty array)
        ourGroupIds: [],
        getKnownPeers: () => this.getKnownPeersInfo(),
        onPeerDiscoveryInfo: (groupIds, knownPeers) => {
          this.handlePeerDiscoveryInfo(peer.nodeId, groupIds, knownPeers);
        },
        onPeerAnnouncement: (peers, reason) => {
          this.handlePeerAnnouncement(peer.nodeId, peers, reason);
        },
        onPeerLeft: (nodeId, groupIds, reason) => {
          this.handlePeerLeft(nodeId, groupIds, reason);
        },
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
   * Handle a key exchange stream.
   * Receives vault key request and responds with our vault key.
   */
  private async handleKeyExchangeStream(
    stream: SyncStream,
    firstMessage: Uint8Array,
    peer: PeerInfo,
  ): Promise<void> {
    this.logger.info(`[handleKeyExchangeStream] Handling key exchange from peer ${peer.nodeId.slice(0, 8)}`);

    if (!this.pairingKeyExchange) {
      this.logger.warn("Key exchange stream received but no PairingKeyExchange configured");
      return;
    }

    try {
      // Parse the key exchange message
      const message = parseKeyExchangeMessage(firstMessage);
      if (!message) {
        this.logger.warn("Failed to parse key exchange message");
        return;
      }

      if (message.type === SyncMessageType.KEY_EXCHANGE_REQUEST) {
        // We received a request - respond with our vault key
        const result = await this.pairingKeyExchange.respondToKeyRequest(
          stream,
          message as KeyExchangeRequestMessage,
        );

        if (result.success) {
          this.logger.info(`Key exchange completed - shared vault key with peer ${peer.nodeId.slice(0, 8)}`);
        } else {
          this.logger.warn(`Key exchange failed: ${result.error}`);
        }
      } else {
        this.logger.warn(`Unexpected key exchange message type: ${message.type}`);
      }
    } catch (error) {
      this.logger.error("Error handling key exchange stream:", error);
    }
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

    // Read first message to detect stream type (key exchange vs sync)
    let firstMessage: Uint8Array;
    try {
      firstMessage = await Promise.race([
        stream.receive(),
        new Promise<Uint8Array>((_, reject) =>
          setTimeout(() => reject(new Error("Stream type detection timeout")), 10000)
        ),
      ]);
    } catch (err) {
      this.logger.warn(`Failed to read first message from stream ${stream.id}:`, err);
      return;
    }

    // Check if this is a key exchange stream
    if (isKeyExchangeMessage(firstMessage)) {
      this.logger.debug(`Stream ${stream.id} is a key exchange stream`);
      await this.handleKeyExchangeStream(stream, firstMessage, peer);
      return;
    }

    // Not key exchange - proceed with sync protocol
    // Wrap stream to return the first message on next receive()
    const bufferedStream = new BufferedStream(stream, firstMessage);

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
        peerIsReadOnly: false, // Groups removed - all peers can read/write
        allowVaultAdoption: isFirstSync,
        onVaultAdoptionNeeded: isFirstSync ? onVaultAdoptionNeeded : undefined,
        ourTicket,
        ourHostname: this.config.hostname,
        ourNickname: this.config.nickname,
        ourPluginVersion: this.config.pluginVersion,
      },
      this.blobStore,
    );

    // Set up event handlers
    this.attachSessionHandlers(session, peer, false);

    this.sessions.set(peer.nodeId, session);
    this.updatePeerState(peer.nodeId, "syncing");

    // Handle the incoming sync with the buffered stream (contains first message)
    await session.handleIncomingSync(bufferedStream);
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
      // Clear any stale error sessions before syncing
      this.clearErrorSessions();

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

  /**
   * Start cleanup timer for stale discovered peers.
   * Removes discovered peers that haven't connected within the TTL.
   */
  private startDiscoveryCleanup(): void {
    this.discoveryCleanupTimer = setInterval(() => {
      this.cleanupStaleDiscoveredPeers();
    }, PeerManager.DISCOVERY_CLEANUP_INTERVAL);
  }

  /**
   * Clean up discovered peers that have exceeded their TTL.
   * Also re-queues failed discoveries that are ready for retry.
   * Also cleans up expired tombstones.
   */
  private cleanupStaleDiscoveredPeers(): void {
    const now = Date.now();

    // Clean up stale discovered peers
    for (const [nodeId, entry] of this.discoveredPeers) {
      const age = now - entry.discoveredAt;
      if (age > PeerManager.DISCOVERED_PEER_TTL) {
        this.logger.debug(
          `Removing stale discovered peer ${nodeId.slice(0, 8)} (waited ${Math.floor(age / 1000)}s for incoming connection)`
        );
        this.discoveredPeers.delete(nodeId);
      }
    }

    // Clean up expired tombstones
    let expiredTombstones = 0;
    for (const [nodeId, tombstone] of this.peerTombstones) {
      if (now - tombstone.removedAt > PeerManager.TOMBSTONE_TTL) {
        this.peerTombstones.delete(nodeId);
        expiredTombstones++;
      }
    }
    if (expiredTombstones > 0) {
      this.logger.debug(`Cleaned up ${expiredTombstones} expired tombstone(s)`);
      // Save updated tombstones
      this.saveTombstones().catch(err => {
        this.logger.warn("Failed to save tombstones after cleanup:", err);
      });
    }

    // Clean up stale seen announcements
    let expiredAnnouncements = 0;
    for (const [hash, timestamp] of this.seenAnnouncementTimestamps) {
      if (now - timestamp > PeerManager.SEEN_ANNOUNCEMENT_TTL) {
        this.seenAnnouncements.delete(hash);
        this.seenAnnouncementTimestamps.delete(hash);
        expiredAnnouncements++;
      }
    }
    if (expiredAnnouncements > 0) {
      this.logger.debug(`Cleaned up ${expiredAnnouncements} stale seen announcement(s)`);
    }

    // Clean up stale announcement rate limit entries
    for (const [nodeId, history] of this.announcementRateLimit) {
      const windowStart = now - PeerManager.ANNOUNCEMENT_RATE_WINDOW;
      const filtered = history.filter(ts => ts > windowStart);
      if (filtered.length === 0) {
        this.announcementRateLimit.delete(nodeId);
      } else if (filtered.length !== history.length) {
        this.announcementRateLimit.set(nodeId, filtered);
      }
    }

    // Re-queue retries that are due
    for (const [nodeId, retryInfo] of this.discoveryRetries) {
      // Skip if already connected
      if (this.peers.has(nodeId)) {
        this.discoveryRetries.delete(nodeId);
        continue;
      }

      // Skip if already in queue
      if (this.discoveryQueue.some(p => p.nodeId === nodeId)) {
        continue;
      }

      // Calculate retry delay (exponential backoff)
      const retryDelay = PeerManager.DISCOVERY_RETRY_BASE_DELAY * Math.pow(2, retryInfo.count - 1);
      const readyAt = retryInfo.lastAttempt + retryDelay;

      if (now >= readyAt) {
        if (retryInfo.count >= PeerManager.MAX_DISCOVERY_RETRIES) {
          // Max retries reached, give up
          this.logger.debug(
            `Giving up on discovered peer ${nodeId.slice(0, 8)} after ${retryInfo.count} failed attempts`
          );
          this.discoveryRetries.delete(nodeId);
        } else {
          // Re-queue for retry
          this.logger.debug(
            `Re-queuing discovered peer ${nodeId.slice(0, 8)} for retry (attempt ${retryInfo.count + 1})`
          );
          this.discoveryQueue.push(retryInfo.peer);
          this.processDiscoveryQueueAsync();
        }
      }
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
        bandwidth: p.bandwidth,
      }),
    );

    const data = new TextEncoder().encode(JSON.stringify(stored));
    await this.storage.write(PEERS_STORAGE_KEY, data);
  }

  /**
   * Load discovered peers from storage.
   * Filters out stale entries that have exceeded TTL.
   */
  private async loadDiscoveredPeers(): Promise<void> {
    try {
      const data = await this.storage.read(DISCOVERED_PEERS_STORAGE_KEY);
      if (data) {
        const stored = JSON.parse(new TextDecoder().decode(data)) as StoredDiscoveredPeer[];
        const now = Date.now();
        let loadedCount = 0;
        let staleCount = 0;

        for (const entry of stored) {
          // Skip entries that have exceeded TTL
          if (now - entry.discoveredAt > PeerManager.DISCOVERED_PEER_TTL) {
            staleCount++;
            continue;
          }

          // Skip if we already know this peer
          if (this.peers.has(entry.peer.nodeId)) {
            continue;
          }

          // Skip if tombstoned
          if (this.peerTombstones.has(entry.peer.nodeId)) {
            continue;
          }

          this.discoveredPeers.set(entry.peer.nodeId, entry);
          loadedCount++;
        }

        if (loadedCount > 0 || staleCount > 0) {
          this.logger.debug(`Loaded ${loadedCount} discovered peers (${staleCount} stale)`);
        }
      }
    } catch (error) {
      this.logger.warn("Failed to load discovered peers:", error);
    }
  }

  /**
   * Save discovered peers to storage.
   */
  private async saveDiscoveredPeers(): Promise<void> {
    try {
      const stored: StoredDiscoveredPeer[] = Array.from(this.discoveredPeers.values());
      const data = new TextEncoder().encode(JSON.stringify(stored));
      await this.storage.write(DISCOVERED_PEERS_STORAGE_KEY, data);
    } catch (error) {
      this.logger.warn("Failed to save discovered peers:", error);
    }
  }

  /**
   * Load tombstones from storage.
   * Filters out expired tombstones.
   */
  private async loadTombstones(): Promise<void> {
    try {
      const data = await this.storage.read(TOMBSTONES_STORAGE_KEY);
      if (data) {
        const stored = JSON.parse(new TextDecoder().decode(data)) as PeerTombstone[];
        const now = Date.now();
        let loadedCount = 0;
        let expiredCount = 0;

        for (const tombstone of stored) {
          // Skip expired tombstones
          if (now - tombstone.removedAt > PeerManager.TOMBSTONE_TTL) {
            expiredCount++;
            continue;
          }

          this.peerTombstones.set(tombstone.nodeId, tombstone);
          loadedCount++;
        }

        if (loadedCount > 0 || expiredCount > 0) {
          this.logger.debug(`Loaded ${loadedCount} tombstones (${expiredCount} expired)`);
        }
      }
    } catch (error) {
      this.logger.warn("Failed to load tombstones:", error);
    }
  }

  /**
   * Save tombstones to storage.
   */
  private async saveTombstones(): Promise<void> {
    try {
      const stored: PeerTombstone[] = Array.from(this.peerTombstones.values());
      const data = new TextEncoder().encode(JSON.stringify(stored));
      await this.storage.write(TOMBSTONES_STORAGE_KEY, data);
    } catch (error) {
      this.logger.warn("Failed to save tombstones:", error);
    }
  }

  /**
   * Create a tombstone for a removed peer.
   * Prevents the peer from being re-discovered for TOMBSTONE_TTL.
   */
  private createTombstone(nodeId: string, reason: "removed" | "left"): void {
    const tombstone: PeerTombstone = {
      nodeId,
      removedAt: Date.now(),
      reason,
    };
    this.peerTombstones.set(nodeId, tombstone);
    this.logger.debug(`Created tombstone for peer ${nodeId.slice(0, 8)} (reason: ${reason})`);

    // Save tombstones asynchronously
    this.saveTombstones().catch(err => {
      this.logger.warn("Failed to save tombstones:", err);
    });
  }

  /**
   * Start periodic re-announcements for mesh consistency.
   */
  private startReAnnouncements(): void {
    this.reAnnouncementTimer = setInterval(() => {
      this.reAnnounceAllPeers().catch(err => {
        this.logger.warn("Failed to re-announce peers:", err);
      });
    }, PeerManager.RE_ANNOUNCEMENT_INTERVAL);
  }

  /**
   * Re-announce all connected peers to ensure mesh consistency.
   * This helps recover from missed gossip messages.
   */
  private async reAnnounceAllPeers(): Promise<void> {
    // Collect all connected peers with tickets
    const peersToAnnounce: KnownPeerInfo[] = [];

    for (const peer of this.peers.values()) {
      if (!peer.ticket || !peer.trusted) {
        continue;
      }

      // Only announce peers with active sessions
      const session = this.sessions.get(peer.nodeId);
      if (!session || session.getState() !== "live") {
        continue;
      }

      peersToAnnounce.push({
        nodeId: peer.nodeId,
        ticket: peer.ticket,
        groupIds: [], // Groups removed
        lastSeen: peer.lastSeen || Date.now(),
      });
    }

    if (peersToAnnounce.length === 0) {
      return;
    }

    // Announce to all live sessions
    let announcedCount = 0;
    for (const [sessionNodeId, session] of this.sessions) {
      if (session.getState() !== "live") {
        continue;
      }

      // Filter out the peer we're announcing to
      const peersForSession = peersToAnnounce.filter(p => p.nodeId !== sessionNodeId);
      if (peersForSession.length === 0) {
        continue;
      }

      try {
        await session.sendPeerAnnouncement(peersForSession, "discovered");
        announcedCount++;
      } catch (err) {
        this.logger.debug(`Failed to re-announce to ${sessionNodeId.slice(0, 8)}:`, err);
      }
    }

    if (announcedCount > 0) {
      this.logger.debug(`Re-announced ${peersToAnnounce.length} peer(s) to ${announcedCount} session(s)`);
    }
  }

  /**
   * Start periodic peer list reconciliation (anti-entropy).
   * This ensures peer lists eventually converge even if announcements are missed.
   */
  private startReconciliation(): void {
    this.reconciliationTimer = setInterval(() => {
      this.reconcilePeerLists().catch(err => {
        this.logger.warn("Failed to reconcile peer lists:", err);
      });
    }, PeerManager.RECONCILIATION_INTERVAL);
  }

  /**
   * Reconcile peer lists with all connected peers.
   * Sends our full known peer list and processes any new peers discovered.
   * This is more thorough than re-announcements as it includes ALL known peers.
   */
  private async reconcilePeerLists(): Promise<void> {
    // Get ALL known peers (not just those with active sessions)
    const allKnownPeers = this.getKnownPeersInfo();

    if (allKnownPeers.length === 0) {
      return;
    }

    // Send full peer list to all live sessions
    let reconcileCount = 0;
    for (const [sessionNodeId, session] of this.sessions) {
      if (session.getState() !== "live") {
        continue;
      }

      // Filter out the peer we're sending to
      const peersForSession = allKnownPeers.filter(p => p.nodeId !== sessionNodeId);
      if (peersForSession.length === 0) {
        continue;
      }

      try {
        // Use "updated" reason to indicate this is a reconciliation
        await session.sendPeerAnnouncement(peersForSession, "updated");
        reconcileCount++;
      } catch (err) {
        this.logger.debug(`Failed to reconcile with ${sessionNodeId.slice(0, 8)}:`, err);
      }
    }

    if (reconcileCount > 0) {
      this.logger.debug(`Reconciled peer list (${allKnownPeers.length} peers) with ${reconcileCount} session(s)`);
    }
  }

  /**
   * Request peer list from a specific peer for reconciliation.
   * Used when we suspect our peer list is out of sync.
   */
  async requestPeerListReconciliation(nodeId: string): Promise<void> {
    const session = this.sessions.get(nodeId);
    if (!session || session.getState() !== "live") {
      this.logger.debug(`Cannot request reconciliation from ${nodeId.slice(0, 8)} - no live session`);
      return;
    }

    // Send our peer list to trigger a response
    const allKnownPeers = this.getKnownPeersInfo().filter(p => p.nodeId !== nodeId);
    if (allKnownPeers.length > 0) {
      try {
        await session.sendPeerAnnouncement(allKnownPeers, "updated");
        this.logger.debug(`Sent peer list reconciliation request to ${nodeId.slice(0, 8)}`);
      } catch (err) {
        this.logger.warn(`Failed to send reconciliation request to ${nodeId.slice(0, 8)}:`, err);
      }
    }
  }

  /**
   * Start periodic connection repair.
   * Detects peers without live sessions and attempts to reconnect.
   */
  private startConnectionRepair(): void {
    this.connectionRepairTimer = setInterval(() => {
      this.repairConnections().catch(err => {
        this.logger.warn("Failed to repair connections:", err);
      });
    }, PeerManager.CONNECTION_REPAIR_INTERVAL);
  }

  /**
   * Repair connections to peers that don't have live sessions.
   * This handles cases where:
   * - Discovery race conditions left peers without sessions
   * - Sessions died but weren't properly restarted
   * - Network issues caused temporary disconnections
   */
  private async repairConnections(): Promise<void> {
    const now = Date.now();
    const peersToRepair: PeerInfo[] = [];

    for (const peer of this.peers.values()) {
      // Skip untrusted peers
      if (!peer.trusted) {
        continue;
      }

      // Skip peers without tickets (can't reconnect)
      if (!peer.ticket) {
        continue;
      }

      // Check if peer has a live session
      const session = this.sessions.get(peer.nodeId);
      const hasLiveSession = session && session.getState() === "live";

      if (hasLiveSession) {
        continue;
      }

      // Check if peer is stale (hasn't been seen recently)
      const timeSinceLastSeen = now - (peer.lastSeen || 0);
      if (timeSinceLastSeen < PeerManager.REPAIR_STALE_THRESHOLD) {
        // Recently active, might be in the middle of connecting
        continue;
      }

      // Check if already being reconnected
      if (this.reconnectTimers.has(peer.nodeId)) {
        continue;
      }

      // Check if in discovery queue
      if (this.discoveryQueue.some(p => p.nodeId === peer.nodeId)) {
        continue;
      }

      peersToRepair.push(peer);
    }

    if (peersToRepair.length === 0) {
      return;
    }

    this.logger.info(`Connection repair: found ${peersToRepair.length} peer(s) without live sessions`);

    // Attempt to repair each peer
    for (const peer of peersToRepair) {
      // Use deterministic ordering - only initiate if we have lower node ID
      const ourNodeId = this.transport.getNodeId();
      if (ourNodeId > peer.nodeId) {
        // Wait for them to connect to us
        this.logger.debug(
          `Repair: waiting for ${peer.nodeId.slice(0, 8)} to connect (node ID ordering)`
        );
        // Update peer state to show we're aware it's disconnected
        if (peer.state !== "offline" && peer.state !== "error") {
          this.updatePeerState(peer.nodeId, "offline");
        }
        continue;
      }

      // We initiate - attempt reconnection
      this.logger.debug(`Repair: initiating reconnection to ${peer.nodeId.slice(0, 8)}`);

      // Update state
      this.updatePeerState(peer.nodeId, "syncing");

      // Attempt to sync with this peer
      this.syncPeer(peer.nodeId).catch(err => {
        this.logger.debug(`Repair: failed to reconnect to ${peer.nodeId.slice(0, 8)}:`, err);
        // handleSyncError will schedule a retry with backoff
      });
    }
  }
}
