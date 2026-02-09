/**
 * Sync Session
 *
 * Manages the sync protocol state machine for a single peer connection.
 */

import type { SyncStream } from "../transport";
import type { DocumentManager } from "../core/document-manager";
import type { BlobStore } from "../core/blob-store";
import type { Logger } from "../utils/logger";
import { SyncErrors, TransportErrors } from "../errors";
import { protocolTracer } from "../utils/protocol-tracer";
import {
  SyncMessageType,
  SyncErrorCode,
  SYNC_PROTOCOL_VERSION,
  type SyncSessionState,
  type AnySyncMessage,
  type VersionInfoMessage,
  type UpdatesMessage,
  type BlobHashesMessage,
  type BlobRequestMessage,
  type BlobDataMessage,
  type PeerRemovedMessage,
  type PeerAnnouncementMessage,
  type PeerRequestMessage,
  type PeerLeftMessage,
  type KnownPeerInfo,
  type WebRTCOfferMessage,
  type WebRTCAnswerMessage,
  type WebRTCIceCandidateMessage,
  type KeyExchangeRequestMessage,
  type KeyExchangeResponseMessage,
} from "./types";
import {
  serializeMessage,
  deserializeMessage,
  createVersionInfoMessage,
  createUpdatesMessage,
  createSyncCompleteMessage,
  createPingMessage,
  createPongMessage,
  createErrorMessage,
  createBlobHashesMessage,
  createBlobRequestMessage,
  createBlobDataMessage,
  createBlobSyncCompleteMessage,
  createPeerRemovedMessage,
  createPeerAnnouncementMessage,
  createPeerRequestMessage,
  createPeerLeftMessage,
  createWebRTCOfferMessage,
  createWebRTCAnswerMessage,
  createWebRTCIceCandidateMessage,
  createWebRTCReadyMessage,
  createWebRTCFailedMessage,
  createKeyExchangeRequestMessage,
  createKeyExchangeResponseMessage,
} from "./messages";
import { EventEmitter } from "../utils/events";

/** Maximum length for peer hostname/nickname to prevent abuse */
const MAX_PEER_NAME_LENGTH = 64;

/** Number of blobs to load in parallel from disk during sync */
const BLOB_BATCH_SIZE = 8;

/** Maximum retries for individual blob operations */
const BLOB_MAX_RETRIES = 3;

/** Delay between blob retry attempts (ms) */
const BLOB_RETRY_DELAY_MS = 500;

/** Delay before attempting WebRTC upgrade after entering live mode (ms) */
const WEBRTC_UPGRADE_DELAY_MS = 2000;

/** Timeout for WebRTC connection attempt (ms) */
const WEBRTC_CONNECTION_TIMEOUT_MS = 30000;

/** Delay before retrying WebRTC upgrade after failure (ms) */
const WEBRTC_RETRY_DELAY_MS = 60000;

/** Maximum WebRTC upgrade attempts before giving up */
const WEBRTC_MAX_ATTEMPTS = 3;

/** WebRTC upgrade state */
type WebRTCUpgradeState = "none" | "initiating" | "responding" | "connected" | "failed";

/**
 * Sanitize peer-provided string to prevent excessively long values.
 * Truncates and removes control characters.
 */
function sanitizePeerString(value: string | undefined, maxLength: number = MAX_PEER_NAME_LENGTH): string | undefined {
  if (!value) return undefined;
  // Remove control characters and trim
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (cleaned.length === 0) return undefined;
  // Truncate if too long
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + "…" : cleaned;
}

/** Sync session configuration */
export interface SyncSessionConfig {
  /** Ping interval in ms */
  pingInterval?: number;

  /** Ping timeout in ms */
  pingTimeout?: number;

  /** Receive timeout in ms (max time to wait for a message from peer) */
  receiveTimeout?: number;

  /** Max retry attempts for sync */
  maxRetries?: number;

  /** If true, don't import updates from this peer (they can only receive) */
  peerIsReadOnly?: boolean;

  /** If true, adopt peer's vault ID on first sync instead of rejecting on mismatch */
  allowVaultAdoption?: boolean;

  /**
   * Callback to confirm vault adoption before proceeding.
   * Called when vault IDs mismatch and allowVaultAdoption is true.
   * Return true to adopt peer's vault ID, false to abort sync.
   * If not provided and allowVaultAdoption is true, auto-adopts without confirmation.
   */
  onVaultAdoptionNeeded?: (peerVaultId: string, ourVaultId: string) => Promise<boolean>;

  /** Our connection ticket to send to peer */
  ourTicket: string;

  /** Our hostname to send to peer (from system) */
  ourHostname: string;

  /** Our nickname to send to peer (optional, user-defined) */
  ourNickname?: string;

  /** Our plugin version (e.g., "0.2.53") - must match peer's version to sync */
  ourPluginVersion?: string;

  /** Groups this peer belongs to (for peer discovery) */
  ourGroupIds?: string[];

  /** Callback to get known peers for discovery */
  getKnownPeers?: () => KnownPeerInfo[];

  /** Callback when peer discovery info is received */
  onPeerDiscoveryInfo?: (groupIds: string[], knownPeers: KnownPeerInfo[]) => void;

  /** Callback when peer announcement is received during live mode */
  onPeerAnnouncement?: (peers: KnownPeerInfo[], reason: "joined" | "discovered" | "updated") => void;

  /** Callback when a peer left notification is received */
  onPeerLeft?: (nodeId: string, groupIds: string[], reason: "removed" | "disconnected" | "left") => void;

  /** Whether to attempt WebRTC upgrade for direct connection */
  enableWebRTC?: boolean;

  /** Our node ID (used for deterministic initiator selection) */
  ourNodeId?: string;

  /** Callback when WebRTC connection state changes */
  onWebRTCStateChange?: (state: WebRTCUpgradeState) => void;

  // Vault key exchange (gossip) configuration
  /** Whether we have the vault encryption key */
  hasVaultKey?: boolean;

  /** Our public key for vault key exchange (32 bytes Curve25519) */
  vaultKeyExchangePublicKey?: Uint8Array;

  /**
   * Called when peer needs the vault key (they sent KEY_EXCHANGE_REQUEST).
   * Should encrypt our vault key for the peer's public key.
   * Returns the encrypted key bundle, or null if we don't have the key.
   */
  onPeerNeedsVaultKey?: (peerPublicKey: Uint8Array) => Promise<{ encryptedKey: Uint8Array; isNewKey: boolean } | null>;

  /**
   * Called when we receive a vault key from peer (KEY_EXCHANGE_RESPONSE).
   * Should decrypt and store the vault key.
   * Returns true if successfully stored.
   */
  onVaultKeyReceived?: (encryptedKey: Uint8Array, isNewKey: boolean) => Promise<boolean>;

  /**
   * Called when we receive peer's hasVaultKey status and we need the key.
   * Should be used to trigger a key exchange request.
   */
  onPeerHasVaultKey?: (peerHasVaultKey: boolean) => void;
}

const DEFAULT_CONFIG: Omit<
  Required<SyncSessionConfig>,
  | "ourTicket"
  | "ourHostname"
  | "ourNickname"
  | "ourPluginVersion"
  | "onVaultAdoptionNeeded"
  | "ourGroupIds"
  | "getKnownPeers"
  | "onPeerDiscoveryInfo"
  | "onPeerAnnouncement"
  | "onPeerLeft"
  | "ourNodeId"
  | "onWebRTCStateChange"
  | "hasVaultKey"
  | "vaultKeyExchangePublicKey"
  | "onPeerNeedsVaultKey"
  | "onVaultKeyReceived"
  | "onPeerHasVaultKey"
> & {
  peerIsReadOnly: boolean;
  allowVaultAdoption: boolean;
  enableWebRTC: boolean;
} = {
  pingInterval: 15000, // Reduced from 30000 for faster stale detection
  pingTimeout: 10000,
  receiveTimeout: 30000, // 30 seconds default receive timeout
  maxRetries: 3,
  peerIsReadOnly: false,
  allowVaultAdoption: false,
  enableWebRTC: false, // Disabled by default - enable when stable
};

/** Sync progress information */
export interface SyncProgress {
  /** Current sync phase */
  phase: "connecting" | "exchanging_versions" | "syncing_documents" | "syncing_blobs" | "live";
  /** Number of blobs to send */
  blobsToSend: number;
  /** Number of blobs sent so far */
  blobsSent: number;
  /** Number of blobs to receive */
  blobsToReceive: number;
  /** Number of blobs received so far */
  blobsReceived: number;
  /** Bytes sent in this session */
  bytesSent: number;
  /** Bytes received in this session */
  bytesReceived: number;
}

/** Sync session events */
interface SyncSessionEvents extends Record<string, unknown> {
  "state:change": SyncSessionState;
  "sync:complete": void;
  "sync:progress": SyncProgress;
  "ticket:received": string;
  "peer:info": { hostname: string; nickname?: string };
  "peer:removed": string | undefined; // reason
  "blob:received": string; // blob hash
  "live:updates": void; // CRDT updates imported during live mode
  "vaultKey:received": void; // vault key received from peer during live mode
  error: Error;
}

/**
 * Manages sync protocol with a single peer.
 */
export class SyncSession extends EventEmitter<SyncSessionEvents> {
  private state: SyncSessionState = "idle";
  private stream: SyncStream | null = null;
  private pingSeq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private config: Omit<
    Required<SyncSessionConfig>,
    | "ourTicket"
    | "ourHostname"
    | "ourNickname"
    | "ourPluginVersion"
    | "onVaultAdoptionNeeded"
    | "ourGroupIds"
    | "getKnownPeers"
    | "onPeerDiscoveryInfo"
    | "onPeerAnnouncement"
    | "onPeerLeft"
    | "ourNodeId"
    | "onWebRTCStateChange"
    | "hasVaultKey"
    | "vaultKeyExchangePublicKey"
    | "onPeerNeedsVaultKey"
    | "onVaultKeyReceived"
    | "onPeerHasVaultKey"
  > & {
    ourTicket: string;
    ourHostname: string;
    ourNickname?: string;
    ourPluginVersion?: string;
    onVaultAdoptionNeeded?: (peerVaultId: string, ourVaultId: string) => Promise<boolean>;
    ourGroupIds?: string[];
    getKnownPeers?: () => KnownPeerInfo[];
    onPeerDiscoveryInfo?: (groupIds: string[], knownPeers: KnownPeerInfo[]) => void;
    onPeerAnnouncement?: (peers: KnownPeerInfo[], reason: "joined" | "discovered" | "updated") => void;
    onPeerLeft?: (nodeId: string, groupIds: string[], reason: "removed" | "disconnected" | "left") => void;
    ourNodeId?: string;
    onWebRTCStateChange?: (state: WebRTCUpgradeState) => void;
    hasVaultKey?: boolean;
    vaultKeyExchangePublicKey?: Uint8Array;
    onPeerNeedsVaultKey?: (peerPublicKey: Uint8Array) => Promise<{ encryptedKey: Uint8Array; isNewKey: boolean } | null>;
    onVaultKeyReceived?: (encryptedKey: Uint8Array, isNewKey: boolean) => Promise<boolean>;
    onPeerHasVaultKey?: (peerHasVaultKey: boolean) => void;
  };
  private aborted = false;
  private unsubscribeLocalUpdates: (() => void) | null = null;

  // WebRTC upgrade state
  private webrtcState: WebRTCUpgradeState = "none";
  private webrtcPeerConnection: RTCPeerConnection | null = null;
  private webrtcDataChannel: RTCDataChannel | null = null;
  private webrtcUpgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private webrtcAttempts = 0;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];

  // Micro-batching for reduced latency
  private pendingUpdates: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_DELAY_MS = 15;
  private readonly MAX_PENDING_UPDATES = 100;
  private readonly MAX_PENDING_BYTES = 1024 * 1024; // 1MB
  private pendingBytes = 0;

  // Bandwidth tracking
  private _bytesSent = 0;
  private _bytesReceived = 0;

  // Protocol tracing session ID
  private traceSessionId = "";

  // Progress tracking
  private _progressPhase: SyncProgress["phase"] = "connecting";
  private _blobsToSend = 0;
  private _blobsSent = 0;
  private _blobsToReceive = 0;

  // Vault key exchange state
  private _peerHasVaultKey: boolean | undefined = undefined;
  private _vaultKeyExchangeInProgress = false;
  private _blobsReceived = 0;

  constructor(
    private peerId: string,
    private documentManager: DocumentManager,
    private logger: Logger,
    config: SyncSessionConfig,
    private blobStore?: BlobStore,
  ) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      ourTicket: config.ourTicket,
      ourHostname: config.ourHostname,
    };
  }

  /**
   * Get current session state.
   */
  getState(): SyncSessionState {
    return this.state;
  }

  /**
   * Get bandwidth statistics for this session.
   */
  getBandwidthStats(): { bytesSent: number; bytesReceived: number } {
    return {
      bytesSent: this._bytesSent,
      bytesReceived: this._bytesReceived,
    };
  }

  /**
   * Get current sync progress.
   */
  getProgress(): SyncProgress {
    return {
      phase: this._progressPhase,
      blobsToSend: this._blobsToSend,
      blobsSent: this._blobsSent,
      blobsToReceive: this._blobsToReceive,
      blobsReceived: this._blobsReceived,
      bytesSent: this._bytesSent,
      bytesReceived: this._bytesReceived,
    };
  }

  /**
   * Update and emit progress.
   */
  private emitProgress(phase?: SyncProgress["phase"]): void {
    if (phase) {
      this._progressPhase = phase;
    }
    this.emit("sync:progress", this.getProgress());
  }

  /**
   * Start sync with the given stream.
   */
  async startSync(stream: SyncStream): Promise<void> {
    if (!stream) {
      throw SyncErrors.protocolError("Stream is required to start sync");
    }
    if (this.state !== "idle" && this.state !== "error") {
      throw SyncErrors.protocolError(`Cannot start sync in state: ${this.state}`);
    }

    this.stream = stream;
    this.aborted = false;

    // Start protocol trace session
    this.traceSessionId = protocolTracer.startSession(this.peerId);
    protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "session.started", {
      role: "initiator",
      streamId: stream.id,
    });

    this.setState("exchanging_versions");
    this.emitProgress("exchanging_versions");

    try {
      // Step 1: Exchange version vectors
      this.logger.debug("[SYNC-TRACE] Starting version exchange (initiator)");
      await this.exchangeVersions();
      this.logger.debug("[SYNC-TRACE] Version exchange complete (initiator)");

      if (this.aborted) return;

      // Step 2: Sync document updates
      this.setState("syncing");
      this.emitProgress("syncing_documents");
      this.logger.debug("[SYNC-TRACE] Starting document sync (initiator)");
      await this.syncUpdates();
      this.logger.debug("[SYNC-TRACE] Document sync complete (initiator)");

      if (this.aborted) return;

      // Step 3: Sync blobs (if blob store available)
      if (this.blobStore) {
        this.emitProgress("syncing_blobs");
        this.logger.debug("[SYNC-TRACE] Starting blob sync (initiator)");
        await this.syncBlobs();
        this.logger.debug("[SYNC-TRACE] Blob sync complete (initiator)");
        if (this.aborted) return;
      }

      // Step 4: Enter live mode
      this.logger.debug("[SYNC-TRACE] Entering live mode (initiator)");
      this.setState("live");
      this.emitProgress("live");
      this.startPingTimer();
      this.subscribeToLocalUpdates();

      // Automatically request vault key if we don't have it but peer does
      this.tryVaultKeyGossip();
      this.scheduleWebRTCUpgrade(); // Attempt WebRTC upgrade for direct connection
      this.startLiveLoop().catch((err) => {
        this.logger.error("Live loop error:", err);
        this.emit("error", err as Error);
      });

      this.emit("sync:complete", undefined);
    } catch (error) {
      this.logger.error("Sync session error:", error);
      protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "error", {
        message: error instanceof Error ? error.message : String(error),
        phase: this._progressPhase,
      });
      this.setState("error");
      this.emit("error", error as Error);
    }
  }

  /**
   * Handle incoming sync from a peer (we accepted their connection).
   */
  async handleIncomingSync(stream: SyncStream): Promise<void> {
    if (this.state !== "idle") {
      throw SyncErrors.protocolError(`Cannot handle incoming sync in state: ${this.state}`);
    }

    this.stream = stream;
    this.aborted = false;

    // Start protocol trace session
    this.traceSessionId = protocolTracer.startSession(this.peerId);
    protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "session.started", {
      role: "acceptor",
      streamId: stream.id,
    });

    this.setState("exchanging_versions");
    this.emitProgress("exchanging_versions");

    try {
      // Wait for peer's version info first
      this.logger.debug("[SYNC-TRACE] Waiting for VERSION_INFO (acceptor)");
      const peerMessage = await this.receiveMessage();
      this.logger.debug("[SYNC-TRACE] Received message type:", peerMessage.type, "(acceptor)");

      if (peerMessage.type !== SyncMessageType.VERSION_INFO) {
        throw SyncErrors.protocolError(`Expected VERSION_INFO, got: ${peerMessage.type}`);
      }

      const peerVersionInfo = peerMessage as VersionInfoMessage;

      // Validate plugin version first - must be exact match
      const ourVersion = this.config.ourPluginVersion;
      const peerVersion = peerVersionInfo.pluginVersion;
      if (ourVersion && peerVersion && ourVersion !== peerVersion) {
        const errorMsg = `Version mismatch: you have v${ourVersion}, peer has v${peerVersion}. All devices must use the same PeerVault version.`;
        await this.sendMessage(
          createErrorMessage(SyncErrorCode.VERSION_MISMATCH, errorMsg),
        );
        throw SyncErrors.protocolError(errorMsg);
      }

      // Emit peer's ticket (for bidirectional reconnection)
      this.emit("ticket:received", peerVersionInfo.ticket);

      // Emit peer's info (for display) - sanitize to prevent abuse
      this.emit("peer:info", {
        hostname: sanitizePeerString(peerVersionInfo.hostname ?? "") ?? "",
        nickname: sanitizePeerString(peerVersionInfo.nickname ?? ""),
      });

      // Validate vault ID
      let ourVaultId = this.documentManager.getVaultId();
      if (peerVersionInfo.vaultId !== ourVaultId) {
        if (this.config.allowVaultAdoption) {
          // Check for user confirmation if callback provided
          if (this.config.onVaultAdoptionNeeded) {
            this.logger.info(
              `Vault ID mismatch - requesting user confirmation to adopt: ${peerVersionInfo.vaultId}`,
            );
            const confirmed = await this.config.onVaultAdoptionNeeded(
              peerVersionInfo.vaultId,
              ourVaultId,
            );
            if (!confirmed) {
              this.logger.info("User denied vault adoption, aborting sync");
              await this.sendMessage(
                createErrorMessage(SyncErrorCode.VAULT_MISMATCH, "Vault adoption denied by user"),
              );
              throw SyncErrors.vaultMismatch(ourVaultId, peerVersionInfo.vaultId);
            }
          }
          // User confirmed (or no callback) - adopt their vault ID
          this.logger.info(
            `Adopting peer's vault ID: ${peerVersionInfo.vaultId} (was: ${ourVaultId})`,
          );
          this.documentManager.setVaultId(peerVersionInfo.vaultId);
          ourVaultId = peerVersionInfo.vaultId;
        } else {
          await this.sendMessage(
            createErrorMessage(SyncErrorCode.VAULT_MISMATCH, "Vault ID mismatch"),
          );
          throw SyncErrors.vaultMismatch(ourVaultId, peerVersionInfo.vaultId);
        }
      }

      // Handle peer discovery info (protocol v2+)
      if (peerVersionInfo.protocolVersion && peerVersionInfo.protocolVersion >= 2) {
        const peerGroupIds = peerVersionInfo.groupIds || [];
        const peerKnownPeers = peerVersionInfo.knownPeers || [];
        if (this.config.onPeerDiscoveryInfo && (peerGroupIds.length > 0 || peerKnownPeers.length > 0)) {
          this.config.onPeerDiscoveryInfo(peerGroupIds, peerKnownPeers);
        }

        // Track peer's vault key status for gossip
        this._peerHasVaultKey = peerVersionInfo.hasVaultKey;
        if (this.config.onPeerHasVaultKey && peerVersionInfo.hasVaultKey !== undefined) {
          this.config.onPeerHasVaultKey(peerVersionInfo.hasVaultKey);
        }
      }

      // Get known peers for discovery (if callback provided)
      const knownPeers = this.config.getKnownPeers?.() || [];

      // Send our version info with group discovery data
      await this.sendMessage(
        createVersionInfoMessage(
          ourVaultId,
          this.documentManager.getVersionBytes(),
          this.config.ourTicket,
          this.config.ourHostname,
          this.config.ourNickname,
          this.config.ourGroupIds,
          knownPeers,
          SYNC_PROTOCOL_VERSION,
          this.config.ourPluginVersion,
          this.config.hasVaultKey,
        ),
      );

      if (this.aborted) return;

      // Step 2: Sync document updates
      this.setState("syncing");
      this.emitProgress("syncing_documents");
      this.logger.debug("[SYNC-TRACE] Starting document sync (acceptor)");
      await this.syncUpdatesAsReceiver(peerVersionInfo.versionBytes);
      this.logger.debug("[SYNC-TRACE] Document sync complete (acceptor)");

      if (this.aborted) return;

      // Step 3: Sync blobs (if blob store available)
      if (this.blobStore) {
        this.emitProgress("syncing_blobs");
        this.logger.debug("[SYNC-TRACE] Starting blob sync (acceptor)");
        await this.syncBlobsAsReceiver();
        this.logger.debug("[SYNC-TRACE] Blob sync complete (acceptor)");
        if (this.aborted) return;
      }

      // Step 4: Enter live mode
      this.logger.debug("[SYNC-TRACE] Entering live mode (acceptor)");
      this.setState("live");
      this.emitProgress("live");
      this.startPingTimer();
      this.subscribeToLocalUpdates();

      // Automatically request vault key if we don't have it but peer does
      this.tryVaultKeyGossip();
      this.scheduleWebRTCUpgrade(); // Attempt WebRTC upgrade for direct connection
      this.startLiveLoop().catch((err) => {
        this.logger.error("Live loop error:", err);
        this.emit("error", err as Error);
      });

      this.emit("sync:complete", undefined);
    } catch (error) {
      this.logger.error("Incoming sync session error:", error);
      protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "error", {
        message: error instanceof Error ? error.message : String(error),
        phase: this._progressPhase,
      });
      this.setState("error");
      this.emit("error", error as Error);
    }
  }

  /**
   * Send a local update to the peer (for live sync).
   * Uses micro-batching to combine rapid updates within 15ms window.
   */
  async sendUpdate(updates: Uint8Array): Promise<void> {
    if (this.state !== "live" || !this.stream) {
      this.logger.warn("Cannot send update: not in live state");
      return;
    }

    // Add to pending batch
    this.pendingUpdates.push(updates);
    this.pendingBytes += updates.length;

    // Flush immediately if limits exceeded
    if (
      this.pendingUpdates.length >= this.MAX_PENDING_UPDATES ||
      this.pendingBytes >= this.MAX_PENDING_BYTES
    ) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await this.flushUpdates();
      return;
    }

    // Schedule flush if not already scheduled
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushUpdates().catch((err) => {
          this.logger.error("Failed to flush updates:", err);
        });
      }, this.BATCH_DELAY_MS);
    }
  }

  /**
   * Flush all pending updates.
   * Each Loro update is sent as a separate message because Loro updates
   * are self-contained binary blobs that cannot be concatenated.
   */
  private async flushUpdates(): Promise<void> {
    this.flushTimer = null;

    if (this.pendingUpdates.length === 0 || this.state !== "live" || !this.stream) {
      return;
    }

    // Send each update separately - Loro updates cannot be concatenated
    // as they have internal checksums and headers
    const updates = this.pendingUpdates;
    this.pendingUpdates = [];
    this.pendingBytes = 0;

    try {
      for (const update of updates) {
        await this.sendMessage(createUpdatesMessage(update, 0));
      }
    } catch (error) {
      this.logger.error("Failed to send batched update:", error);
    }
  }

  /**
   * Notify the peer that we are removing them.
   */
  async sendPeerRemoved(reason?: string): Promise<void> {
    if (!this.stream) {
      this.logger.warn("Cannot send peer removed: no stream");
      return;
    }

    try {
      await this.sendMessage(createPeerRemovedMessage(reason));
    } catch (error) {
      this.logger.error("Failed to send peer removed:", error);
    }
  }

  /**
   * Announce peers to this session's peer (for peer discovery/gossip).
   * Used to propagate newly connected peers to all group members.
   */
  async sendPeerAnnouncement(
    peers: KnownPeerInfo[],
    reason: "joined" | "discovered" | "updated" = "joined"
  ): Promise<void> {
    if (!this.stream || this.state !== "live") {
      this.logger.debug("Cannot send peer announcement: session not in live mode");
      return;
    }

    if (peers.length === 0) {
      return;
    }

    try {
      this.logger.info(`Announcing ${peers.length} peer(s) to ${this.peerId} (${reason})`);
      await this.sendMessage(createPeerAnnouncementMessage(peers, reason));
    } catch (error) {
      this.logger.error("Failed to send peer announcement:", error);
    }
  }

  /**
   * Request peers for specific groups from this session's peer.
   */
  async sendPeerRequest(groupIds: string[]): Promise<void> {
    if (!this.stream || this.state !== "live") {
      this.logger.debug("Cannot send peer request: session not in live mode");
      return;
    }

    if (groupIds.length === 0) {
      return;
    }

    try {
      this.logger.debug(`Requesting peers for groups: ${groupIds.join(", ")}`);
      await this.sendMessage(createPeerRequestMessage(groupIds));
    } catch (error) {
      this.logger.error("Failed to send peer request:", error);
    }
  }

  /**
   * Notify this session's peer that another peer has left.
   * Used for mesh cleanup when a peer is removed or disconnects.
   */
  async sendPeerLeft(
    nodeId: string,
    groupIds: string[],
    reason: "removed" | "disconnected" | "left"
  ): Promise<void> {
    if (!this.stream || this.state !== "live") {
      this.logger.debug("Cannot send peer left: session not in live mode");
      return;
    }

    try {
      this.logger.info(`Notifying ${this.peerId.slice(0, 8)} that peer ${nodeId.slice(0, 8)} left (${reason})`);
      await this.sendMessage(createPeerLeftMessage(nodeId, groupIds, reason));
    } catch (error) {
      this.logger.error("Failed to send peer left notification:", error);
    }
  }

  /**
   * Close the sync session.
   */
  async close(): Promise<void> {
    // End protocol trace session
    protocolTracer.endSession(this.traceSessionId, this.state);

    this.aborted = true;
    this.stopPingTimer();
    this.stopLocalUpdateSubscription();

    // Clear WebRTC upgrade timer and clean up WebRTC resources
    if (this.webrtcUpgradeTimer) {
      clearTimeout(this.webrtcUpgradeTimer);
      this.webrtcUpgradeTimer = null;
    }
    this.cleanupWebRTC();

    // Clear micro-batch timer and flush any pending updates
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Try to flush pending updates before closing
    if (this.pendingUpdates.length > 0 && this.stream) {
      try {
        await this.flushUpdates();
      } catch {
        // Ignore flush errors on close
      }
    }
    this.pendingUpdates = [];
    this.pendingBytes = 0;

    if (this.stream) {
      try {
        await this.stream.close();
      } catch {
        // Ignore close errors
      }
      this.stream = null;
    }

    this.setState("closed");
  }

  // ===========================================================================
  // Private: State Machine
  // ===========================================================================

  private setState(state: SyncSessionState): void {
    if (this.state === state) return;

    const prevState = this.state;
    this.logger.debug(`Sync session ${this.peerId}: ${prevState} -> ${state}`);
    this.state = state;

    // Trace state change
    protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "state.changed", {
      from: prevState,
      to: state,
    });

    this.emit("state:change", state);
  }

  // ===========================================================================
  // Private: Version Exchange
  // ===========================================================================

  /**
   * Exchange version vectors with peer (initiator role).
   *
   * Protocol flow:
   * 1. Send our VERSION_INFO (vault ID, version vector, ticket, identity)
   * 2. Receive peer's VERSION_INFO
   * 3. Validate vault IDs match
   * 4. Emit peer's ticket and identity info for connection management
   *
   * @throws SyncErrors.vaultMismatch if vault IDs don't match
   * @throws SyncErrors.protocolError if unexpected message received
   */
  private async exchangeVersions(): Promise<void> {
    const vaultId = this.documentManager.getVaultId();
    const versionBytes = this.documentManager.getVersionBytes();

    // Get known peers for discovery (if callback provided)
    const knownPeers = this.config.getKnownPeers?.() || [];

    // Send our version info with group discovery data
    await this.sendMessage(
      createVersionInfoMessage(
        vaultId,
        versionBytes,
        this.config.ourTicket,
        this.config.ourHostname,
        this.config.ourNickname,
        this.config.ourGroupIds,
        knownPeers,
        SYNC_PROTOCOL_VERSION,
        this.config.ourPluginVersion,
        this.config.hasVaultKey,
      ),
    );

    // Wait for peer's version info
    const peerMessage = await this.receiveMessage();

    if (peerMessage.type !== SyncMessageType.VERSION_INFO) {
      throw SyncErrors.protocolError(`Expected VERSION_INFO, got: ${peerMessage.type}`);
    }

    const peerVersionInfo = peerMessage as VersionInfoMessage;

    // Validate vault ID
    if (peerVersionInfo.vaultId !== vaultId) {
      await this.sendMessage(
        createErrorMessage(SyncErrorCode.VAULT_MISMATCH, "Vault ID mismatch"),
      );
      throw SyncErrors.vaultMismatch(vaultId, peerVersionInfo.vaultId);
    }

    // Validate plugin version - must be exact match
    const ourVersion = this.config.ourPluginVersion;
    const peerVersion = peerVersionInfo.pluginVersion;
    if (ourVersion && peerVersion && ourVersion !== peerVersion) {
      const errorMsg = `Version mismatch: you have v${ourVersion}, peer has v${peerVersion}. All devices must use the same PeerVault version.`;
      await this.sendMessage(
        createErrorMessage(SyncErrorCode.VERSION_MISMATCH, errorMsg),
      );
      throw SyncErrors.protocolError(errorMsg);
    }

    // Emit peer's ticket (for bidirectional reconnection)
    this.emit("ticket:received", peerVersionInfo.ticket);

    // Emit peer's info (for display) - sanitize to prevent abuse
    this.emit("peer:info", {
      hostname: sanitizePeerString(peerVersionInfo.hostname ?? "") ?? "",
      nickname: sanitizePeerString(peerVersionInfo.nickname ?? ""),
    });

    // Handle peer discovery info (protocol v2+)
    if (peerVersionInfo.protocolVersion && peerVersionInfo.protocolVersion >= 2) {
      const peerGroupIds = peerVersionInfo.groupIds || [];
      const peerKnownPeers = peerVersionInfo.knownPeers || [];
      if (this.config.onPeerDiscoveryInfo && (peerGroupIds.length > 0 || peerKnownPeers.length > 0)) {
        this.config.onPeerDiscoveryInfo(peerGroupIds, peerKnownPeers);
      }

      // Track peer's vault key status for gossip
      this._peerHasVaultKey = peerVersionInfo.hasVaultKey;
      if (this.config.onPeerHasVaultKey && peerVersionInfo.hasVaultKey !== undefined) {
        this.config.onPeerHasVaultKey(peerVersionInfo.hasVaultKey);
      }
    }

    this.logger.debug("Version exchange complete");
  }

  // ===========================================================================
  // Private: Update Sync (Initiator)
  // ===========================================================================

  /**
   * Sync document updates with peer (initiator role).
   *
   * Protocol flow:
   * 1. Export our CRDT updates (changes since initial state)
   * 2. Send UPDATES message with our changes
   * 3. Receive peer's UPDATES message
   * 4. Import peer's changes (unless peer is read-only)
   *
   * Uses Loro CRDT's automatic conflict resolution - concurrent edits
   * are merged deterministically without data loss.
   */
  private async syncUpdates(): Promise<void> {
    // Initiator: send first, then receive
    this.logger.debug("[SYNC-TRACE] syncUpdates: sending our updates");
    await this.sendOurUpdates();
    this.logger.debug("[SYNC-TRACE] syncUpdates: sent, now receiving");
    await this.receiveAndImportUpdates();
    this.logger.debug("[SYNC-TRACE] syncUpdates: received, now exchanging complete");
    await this.exchangeSyncComplete(true);
    this.logger.debug("[SYNC-TRACE] syncUpdates: done");
  }

  // ===========================================================================
  // Private: Update Sync (Receiver)
  // ===========================================================================

  private async syncUpdatesAsReceiver(
    _peerVersionBytes: Uint8Array,
  ): Promise<void> {
    // Receiver: receive first, then send
    this.logger.debug("[SYNC-TRACE] syncUpdatesAsReceiver: receiving updates");
    await this.receiveAndImportUpdates();
    this.logger.debug("[SYNC-TRACE] syncUpdatesAsReceiver: received, now sending ours");
    await this.sendOurUpdates();
    this.logger.debug("[SYNC-TRACE] syncUpdatesAsReceiver: sent, now exchanging complete");
    await this.exchangeSyncComplete(false);
    this.logger.debug("[SYNC-TRACE] syncUpdatesAsReceiver: done");
  }

  // ===========================================================================
  // Private: Update Sync Helpers
  // ===========================================================================

  /**
   * Send our document updates to the peer.
   */
  private async sendOurUpdates(): Promise<void> {
    const ourUpdates = this.documentManager.exportUpdates();
    await this.sendMessage(createUpdatesMessage(ourUpdates, 0));
  }

  /**
   * Receive and import updates from the peer.
   * Handles the UPDATES message type and respects read-only peer settings.
   */
  private async receiveAndImportUpdates(): Promise<void> {
    this.logger.debug("[SYNC-TRACE] receiveAndImportUpdates: waiting for UPDATES");
    const peerMessage = await this.receiveMessage();
    this.logger.debug("[SYNC-TRACE] receiveAndImportUpdates: received type", peerMessage.type);

    if (peerMessage.type === SyncMessageType.UPDATES) {
      const updatesMsg = peerMessage as UpdatesMessage;
      if (updatesMsg.updates.length > 0) {
        if (this.config.peerIsReadOnly) {
          this.logger.debug("Skipping updates from read-only peer");
        } else {
          this.documentManager.importUpdates(updatesMsg.updates);
          this.logger.debug("Imported updates from peer");
        }
      }
    } else if (peerMessage.type === SyncMessageType.ERROR) {
      throw SyncErrors.protocolError(
        `Peer error: ${(peerMessage as { message: string }).message}`,
      );
    }
  }

  /**
   * Exchange SYNC_COMPLETE messages to finalize the sync.
   * @param sendFirst - If true, send our complete message first; otherwise receive first.
   */
  private async exchangeSyncComplete(sendFirst: boolean): Promise<void> {
    const finalVersion = this.documentManager.getVersionBytes();
    this.logger.debug("[SYNC-TRACE] exchangeSyncComplete: sendFirst=", sendFirst);

    if (sendFirst) {
      this.logger.debug("[SYNC-TRACE] exchangeSyncComplete: sending SYNC_COMPLETE");
      await this.sendMessage(createSyncCompleteMessage(finalVersion));
      this.logger.debug("[SYNC-TRACE] exchangeSyncComplete: waiting for peer SYNC_COMPLETE");
      const completeMsg = await this.receiveMessage();
      this.logger.debug("[SYNC-TRACE] exchangeSyncComplete: received type", completeMsg.type);
      if (completeMsg.type !== SyncMessageType.SYNC_COMPLETE) {
        this.logger.warn("Expected SYNC_COMPLETE, got:", completeMsg.type);
      }
    } else {
      this.logger.debug("[SYNC-TRACE] exchangeSyncComplete: waiting for peer SYNC_COMPLETE");
      const completeMsg = await this.receiveMessage();
      this.logger.debug("[SYNC-TRACE] exchangeSyncComplete: received type", completeMsg.type);
      if (completeMsg.type !== SyncMessageType.SYNC_COMPLETE) {
        this.logger.warn("Expected SYNC_COMPLETE, got:", completeMsg.type);
      }
      this.logger.debug("[SYNC-TRACE] exchangeSyncComplete: sending SYNC_COMPLETE");
      await this.sendMessage(createSyncCompleteMessage(finalVersion));
    }
    this.logger.debug("[SYNC-TRACE] exchangeSyncComplete: done");
  }

  // ===========================================================================
  // Private: Blob Sync (Initiator)
  // ===========================================================================

  /**
   * Sync blobs with peer (initiator side).
   * 1. Send our blob hashes
   * 2. Receive peer's blob hashes
   * 3. Request missing blobs from peer
   * 4. Respond to peer's blob requests
   * 5. Exchange blob sync complete
   */
  private async syncBlobs(): Promise<void> {
    if (!this.blobStore) return;

    // Get our blob hashes
    const ourHashes = await this.blobStore.list();
    this.logger.debug("[SYNC-TRACE] syncBlobs: we have", ourHashes.length, "blobs");

    // Send our blob hashes
    this.logger.debug("[SYNC-TRACE] syncBlobs: sending BLOB_HASHES");
    await this.sendMessage(createBlobHashesMessage(ourHashes));

    // Receive peer's blob hashes
    this.logger.debug("[SYNC-TRACE] syncBlobs: waiting for peer BLOB_HASHES");
    const peerMessage = await this.receiveMessage();
    this.logger.debug("[SYNC-TRACE] syncBlobs: received message type", peerMessage.type);
    if (peerMessage.type !== SyncMessageType.BLOB_HASHES) {
      throw SyncErrors.protocolError(`Expected BLOB_HASHES, got: ${peerMessage.type}`);
    }

    const peerHashes = (peerMessage as BlobHashesMessage).hashes;
    this.logger.debug("[SYNC-TRACE] syncBlobs: peer has", peerHashes.length, "blobs");

    // Find blobs we're missing
    const missingFromUs = await this.blobStore.getMissing(peerHashes);
    this.logger.debug("Missing from us:", missingFromUs.length);
    this._blobsToReceive = missingFromUs.length;
    this.emitProgress();

    // Find blobs peer is missing
    const peerSet = new Set(peerHashes);
    const missingFromPeer = ourHashes.filter((h) => !peerSet.has(h));
    this.logger.debug("Missing from peer:", missingFromPeer.length);

    // Request blobs we're missing
    if (missingFromUs.length > 0) {
      await this.sendMessage(createBlobRequestMessage(missingFromUs));
    } else {
      await this.sendMessage(createBlobRequestMessage([]));
    }

    // Wait for peer's blob request
    const peerRequest = await this.receiveMessage();
    if (peerRequest.type !== SyncMessageType.BLOB_REQUEST) {
      throw SyncErrors.protocolError(`Expected BLOB_REQUEST, got: ${peerRequest.type}`);
    }

    const peerWants = (peerRequest as BlobRequestMessage).hashes;
    this.logger.debug("Peer wants:", peerWants.length);
    this._blobsToSend = peerWants.length;
    this.emitProgress();

    // Send blobs peer wants (parallel load, sequential send)
    await this.sendBlobsParallel(peerWants);

    // Send blob sync complete (we're done sending)
    await this.sendMessage(createBlobSyncCompleteMessage(peerWants.length));

    // Receive blobs we requested
    let received = 0;
    let storeFailed = 0;
    while (received < missingFromUs.length) {
      const msg = await this.receiveMessage();
      if (msg.type === SyncMessageType.BLOB_DATA) {
        const blobMsg = msg as BlobDataMessage;
        // Retry storing blob on failure
        let stored = false;
        for (let attempt = 1; attempt <= BLOB_MAX_RETRIES && !stored; attempt++) {
          try {
            // Verify blob integrity before storing
            const verified = await this.blobStore.verifyAndAdd(
              blobMsg.data,
              blobMsg.hash,
              blobMsg.mimeType,
            );
            if (!verified) {
              this.logger.warn(`Blob integrity check failed for ${blobMsg.hash.slice(0, 8)}`);
              storeFailed++;
              break; // Don't retry on integrity failure - data is corrupted
            }
            stored = true;
          } catch (err) {
            if (attempt < BLOB_MAX_RETRIES) {
              this.logger.debug(`Blob store failed (attempt ${attempt}/${BLOB_MAX_RETRIES}), retrying:`, blobMsg.hash.slice(0, 8));
              await new Promise(r => setTimeout(r, BLOB_RETRY_DELAY_MS * attempt));
            } else {
              this.logger.warn(`Failed to store blob after ${BLOB_MAX_RETRIES} attempts:`, blobMsg.hash.slice(0, 8));
              storeFailed++;
            }
          }
        }
        received++;
        this._blobsReceived = received;
        this.emitProgress();
        this.logger.debug("Received blob:", blobMsg.hash);
      } else if (msg.type === SyncMessageType.BLOB_SYNC_COMPLETE) {
        // Peer is done sending
        break;
      } else {
        throw SyncErrors.protocolError(`Unexpected message during blob sync: ${msg.type}`);
      }
    }
    if (storeFailed > 0) {
      this.logger.warn(`Blob receive completed with ${storeFailed} store failure(s)`);
    }

    // Wait for peer's blob sync complete if we haven't received it
    if (received === missingFromUs.length) {
      const completeMsg = await this.receiveMessage();
      if (completeMsg.type !== SyncMessageType.BLOB_SYNC_COMPLETE) {
        this.logger.warn("Expected BLOB_SYNC_COMPLETE, got:", completeMsg.type);
      }
    }

    this.logger.debug("Blob sync complete");
  }

  // ===========================================================================
  // Private: Blob Sync (Receiver)
  // ===========================================================================

  /**
   * Sync blobs with peer (receiver side).
   * 1. Receive peer's blob hashes
   * 2. Send our blob hashes
   * 3. Receive peer's blob requests
   * 4. Request missing blobs from peer
   * 5. Exchange blobs
   */
  private async syncBlobsAsReceiver(): Promise<void> {
    if (!this.blobStore) return;

    // Wait for peer's blob hashes
    const peerMessage = await this.receiveMessage();
    if (peerMessage.type !== SyncMessageType.BLOB_HASHES) {
      throw SyncErrors.protocolError(`Expected BLOB_HASHES, got: ${peerMessage.type}`);
    }

    const peerHashes = (peerMessage as BlobHashesMessage).hashes;
    this.logger.debug("Peer has blobs:", peerHashes.length);

    // Get our blob hashes and send them
    const ourHashes = await this.blobStore.list();
    await this.sendMessage(createBlobHashesMessage(ourHashes));
    this.logger.debug("We have blobs:", ourHashes.length);

    // Wait for peer's blob request
    const peerRequest = await this.receiveMessage();
    if (peerRequest.type !== SyncMessageType.BLOB_REQUEST) {
      throw SyncErrors.protocolError(`Expected BLOB_REQUEST, got: ${peerRequest.type}`);
    }

    const peerWants = (peerRequest as BlobRequestMessage).hashes;
    this.logger.debug("Peer wants:", peerWants.length);

    // Find blobs we're missing and request them
    const missingFromUs = await this.blobStore.getMissing(peerHashes);
    this.logger.debug("Missing from us:", missingFromUs.length);
    this._blobsToReceive = missingFromUs.length;
    this._blobsToSend = peerWants.length;
    this.emitProgress();

    if (missingFromUs.length > 0) {
      await this.sendMessage(createBlobRequestMessage(missingFromUs));
    } else {
      await this.sendMessage(createBlobRequestMessage([]));
    }

    // Receive blobs from peer first (peer sends their requested blobs first)
    let received = 0;
    let storeFailed = 0;
    while (received < missingFromUs.length) {
      const msg = await this.receiveMessage();
      if (msg.type === SyncMessageType.BLOB_DATA) {
        const blobMsg = msg as BlobDataMessage;
        // Retry storing blob on failure
        let stored = false;
        for (let attempt = 1; attempt <= BLOB_MAX_RETRIES && !stored; attempt++) {
          try {
            // Verify blob integrity before storing
            const verified = await this.blobStore.verifyAndAdd(
              blobMsg.data,
              blobMsg.hash,
              blobMsg.mimeType,
            );
            if (!verified) {
              this.logger.warn(`Blob integrity check failed for ${blobMsg.hash.slice(0, 8)}`);
              storeFailed++;
              break; // Don't retry on integrity failure - data is corrupted
            }
            stored = true;
          } catch (err) {
            if (attempt < BLOB_MAX_RETRIES) {
              this.logger.debug(`Blob store failed (attempt ${attempt}/${BLOB_MAX_RETRIES}), retrying:`, blobMsg.hash.slice(0, 8));
              await new Promise(r => setTimeout(r, BLOB_RETRY_DELAY_MS * attempt));
            } else {
              this.logger.warn(`Failed to store blob after ${BLOB_MAX_RETRIES} attempts:`, blobMsg.hash.slice(0, 8));
              storeFailed++;
            }
          }
        }
        received++;
        this._blobsReceived = received;
        this.emitProgress();
        this.logger.debug("Received blob:", blobMsg.hash);
      } else if (msg.type === SyncMessageType.BLOB_SYNC_COMPLETE) {
        // Peer is done sending
        break;
      } else {
        throw SyncErrors.protocolError(`Unexpected message during blob sync: ${msg.type}`);
      }
    }
    if (storeFailed > 0) {
      this.logger.warn(`Blob receive completed with ${storeFailed} store failure(s)`);
    }

    // Wait for peer's blob sync complete if we haven't received it
    if (received === missingFromUs.length && missingFromUs.length > 0) {
      const completeMsg = await this.receiveMessage();
      if (completeMsg.type !== SyncMessageType.BLOB_SYNC_COMPLETE) {
        this.logger.warn("Expected BLOB_SYNC_COMPLETE, got:", completeMsg.type);
      }
    }

    // Now send blobs peer wants (parallel load, sequential send)
    await this.sendBlobsParallel(peerWants);

    // Send our blob sync complete
    await this.sendMessage(createBlobSyncCompleteMessage(peerWants.length));

    this.logger.debug("Blob sync complete (receiver)");
  }

  /**
   * Send blobs with parallel disk loading for better performance.
   * Loads blobs in batches from disk, then sends sequentially.
   * Individual blob failures are retried and logged but don't abort the sync.
   */
  private async sendBlobsParallel(hashes: string[]): Promise<void> {
    if (!this.blobStore || hashes.length === 0) return;

    const failedBlobs: string[] = [];

    for (let i = 0; i < hashes.length; i += BLOB_BATCH_SIZE) {
      const batch = hashes.slice(i, i + BLOB_BATCH_SIZE);

      // Load batch in parallel
      const blobsWithData = await Promise.all(
        batch.map(async (hash) => {
          try {
            const data = await this.blobStore!.get(hash);
            const meta = data ? await this.blobStore!.getMeta(hash) : null;
            return { hash, data, mimeType: meta?.mimeType, error: null };
          } catch (err) {
            this.logger.warn(`Failed to load blob ${hash.slice(0, 8)}:`, err);
            return { hash, data: null, mimeType: undefined, error: err };
          }
        }),
      );

      // Send loaded blobs sequentially with retry
      for (const blob of blobsWithData) {
        if (!blob.data) {
          failedBlobs.push(blob.hash);
          continue;
        }

        let sent = false;
        for (let attempt = 1; attempt <= BLOB_MAX_RETRIES && !sent; attempt++) {
          try {
            await this.sendMessage(
              createBlobDataMessage(blob.hash, blob.data, blob.mimeType),
            );
            sent = true;
            this._blobsSent++;
            this.emitProgress();
          } catch (err) {
            if (attempt < BLOB_MAX_RETRIES) {
              this.logger.debug(`Blob send failed (attempt ${attempt}/${BLOB_MAX_RETRIES}), retrying:`, blob.hash.slice(0, 8));
              await new Promise(r => setTimeout(r, BLOB_RETRY_DELAY_MS * attempt));
            } else {
              this.logger.warn(`Failed to send blob after ${BLOB_MAX_RETRIES} attempts:`, blob.hash.slice(0, 8));
              failedBlobs.push(blob.hash);
            }
          }
        }
      }
    }

    if (failedBlobs.length > 0) {
      this.logger.warn(`Blob sync completed with ${failedBlobs.length} failed blob(s)`);
    }
  }

  /**
   * Check for missing blobs after receiving a live update and request them.
   * This handles the case where a binary file is created/modified during live sync.
   */
  private async requestMissingBlobsLive(): Promise<void> {
    if (!this.blobStore) return;

    // Get all blob hashes referenced in the document
    const referencedHashes = this.documentManager.getAllBlobHashes();
    if (referencedHashes.length === 0) return;

    // Find which ones we're missing
    const missingHashes = await this.blobStore.getMissing(referencedHashes);
    if (missingHashes.length === 0) return;

    this.logger.debug("Requesting missing blobs in live mode:", missingHashes.length);

    // Request the missing blobs
    await this.sendMessage(createBlobRequestMessage(missingHashes));
  }

  // ===========================================================================
  // Private: Live Sync
  // ===========================================================================

  private async startLiveLoop(): Promise<void> {
    // Exponential backoff for transient errors
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 500;
    const MAX_DELAY_MS = 30000;
    let consecutiveErrors = 0;

    while (this.state === "live" && this.stream && !this.aborted) {
      try {
        // Use infinite timeout for live loop - ping/pong handles liveness
        const message = await this.receiveMessage(Infinity);

        // Reset error count on successful message
        consecutiveErrors = 0;

        switch (message.type) {
          case SyncMessageType.UPDATES: {
            const updatesMsg = message as UpdatesMessage;
            if (updatesMsg.updates.length > 0) {
              if (this.config.peerIsReadOnly) {
                this.logger.debug("Skipping live update from read-only peer");
              } else {
                this.documentManager.importUpdates(updatesMsg.updates);
                this.logger.debug("Imported live update from peer");
                // Emit event so VaultSync can reconcile after CRDT merge
                this.emit("live:updates", undefined);
                // Check for missing blobs and request them
                await this.requestMissingBlobsLive();
              }
            }
            break;
          }

          case SyncMessageType.BLOB_REQUEST: {
            // Peer is requesting blobs - send them
            const requestMsg = message as BlobRequestMessage;
            this.logger.debug("Peer requesting blobs in live mode:", requestMsg.hashes.length);
            await this.sendBlobsParallel(requestMsg.hashes);
            break;
          }

          case SyncMessageType.BLOB_DATA: {
            // Peer is sending blob data - verify and store it
            const blobMsg = message as BlobDataMessage;
            if (this.blobStore) {
              const verified = await this.blobStore.verifyAndAdd(
                blobMsg.data,
                blobMsg.hash,
                blobMsg.mimeType,
              );
              if (verified) {
                this.logger.debug("Received blob in live mode:", blobMsg.hash.slice(0, 16));
                // Emit event so VaultSync can retry writing the file
                this.emit("blob:received", blobMsg.hash);
              } else {
                this.logger.warn("Blob integrity check failed in live mode:", blobMsg.hash.slice(0, 16));
              }
            }
            break;
          }

          case SyncMessageType.PING: {
            const pingMsg = message as { seq: number };
            await this.sendMessage(createPongMessage(pingMsg.seq));
            break;
          }

          case SyncMessageType.PONG: {
            // Received pong, connection is alive
            break;
          }

          case SyncMessageType.ERROR: {
            const errorMsg = message as { message: string };
            this.logger.error("Peer error:", errorMsg.message);
            this.setState("error");
            return;
          }

          case SyncMessageType.PEER_REMOVED: {
            const removedMsg = message as PeerRemovedMessage;
            this.logger.info("Peer removed us:", removedMsg.reason || "no reason given");
            this.emit("peer:removed", removedMsg.reason);
            this.setState("closed");
            return;
          }

          case SyncMessageType.PEER_ANNOUNCEMENT: {
            const announcementMsg = message as PeerAnnouncementMessage;
            this.logger.info(
              `Received peer announcement (${announcementMsg.reason}):`,
              announcementMsg.peers.length,
              "peers"
            );
            if (this.config.onPeerAnnouncement) {
              this.config.onPeerAnnouncement(announcementMsg.peers, announcementMsg.reason);
            }
            break;
          }

          case SyncMessageType.PEER_REQUEST: {
            const requestMsg = message as PeerRequestMessage;
            this.logger.debug("Received peer request for groups:", requestMsg.groupIds);
            // Respond with known peers for the requested groups
            if (this.config.getKnownPeers) {
              const allKnownPeers = this.config.getKnownPeers();
              // Filter to peers that share at least one requested group
              const relevantPeers = allKnownPeers.filter(peer =>
                peer.groupIds.some(gid => requestMsg.groupIds.includes(gid))
              );
              if (relevantPeers.length > 0) {
                this.logger.debug("Responding with", relevantPeers.length, "known peers");
                await this.sendMessage(createPeerAnnouncementMessage(relevantPeers, "discovered"));
              }
            }
            break;
          }

          case SyncMessageType.PEER_LEFT: {
            const leftMsg = message as PeerLeftMessage;
            this.logger.info(
              `Peer left notification: ${leftMsg.nodeId.slice(0, 8)} (${leftMsg.reason})`,
              leftMsg.groupIds.length > 0 ? `groups: ${leftMsg.groupIds.join(", ")}` : "all groups"
            );
            if (this.config.onPeerLeft) {
              this.config.onPeerLeft(leftMsg.nodeId, leftMsg.groupIds, leftMsg.reason);
            }
            break;
          }

          // WebRTC signaling messages (in-band signaling for direct connection upgrade)
          case SyncMessageType.WEBRTC_OFFER: {
            const offerMsg = message as WebRTCOfferMessage;
            this.logger.info("Received WebRTC offer from peer");
            await this.handleWebRTCOffer(offerMsg.sdp);
            break;
          }

          case SyncMessageType.WEBRTC_ANSWER: {
            const answerMsg = message as WebRTCAnswerMessage;
            this.logger.info("Received WebRTC answer from peer");
            await this.handleWebRTCAnswer(answerMsg.sdp);
            break;
          }

          case SyncMessageType.WEBRTC_ICE_CANDIDATE: {
            const iceMsg = message as WebRTCIceCandidateMessage;
            this.logger.debug("Received ICE candidate from peer");
            await this.handleWebRTCIceCandidate(iceMsg);
            break;
          }

          case SyncMessageType.WEBRTC_READY: {
            this.logger.info("Peer confirmed WebRTC is ready");
            this.setWebRTCState("connected");
            break;
          }

          case SyncMessageType.WEBRTC_FAILED: {
            this.logger.info("Peer reported WebRTC failed:", (message as { reason: string }).reason);
            this.setWebRTCState("failed");
            this.scheduleWebRTCRetry();
            break;
          }

          // Vault key exchange messages (for key gossip during live mode)
          case SyncMessageType.KEY_EXCHANGE_REQUEST: {
            const keyRequest = message as KeyExchangeRequestMessage;
            this.logger.info("Received vault key exchange request from peer");
            await this.handleVaultKeyRequest(keyRequest);
            break;
          }

          case SyncMessageType.KEY_EXCHANGE_RESPONSE: {
            const keyResponse = message as KeyExchangeResponseMessage;
            this.logger.info("Received vault key exchange response from peer");
            await this.handleVaultKeyResponse(keyResponse);
            break;
          }

          default:
            this.logger.warn("Unexpected message in live mode:", message.type);
        }
      } catch (error) {
        if (this.aborted) {
          return;
        }

        consecutiveErrors++;
        const isTransient = this.isTransientError(error);

        if (isTransient && consecutiveErrors <= MAX_RETRIES) {
          // Exponential backoff with jitter for transient errors
          const delay = Math.min(
            BASE_DELAY_MS * Math.pow(2, consecutiveErrors - 1) + Math.random() * 100,
            MAX_DELAY_MS,
          );
          this.logger.warn(
            `Live loop transient error (attempt ${consecutiveErrors}/${MAX_RETRIES}), retrying in ${delay.toFixed(0)}ms:`,
            error,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue; // Retry the loop
        }

        // Non-transient error or max retries exceeded
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        this.logger.error(
          `Live loop error (non-recoverable, transient=${isTransient}, attempts=${consecutiveErrors}): ${errorMessage}`,
          errorStack ? `\nStack: ${errorStack}` : "",
        );
        this.setState("error");
        this.emit("error", error as Error);
        return;
      }
    }
  }

  // ===========================================================================
  // Private: Keep-alive
  // ===========================================================================

  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this.state === "live" && this.stream) {
        this.sendMessage(createPingMessage(++this.pingSeq)).catch((err) => {
          this.logger.error("Failed to send ping:", err);
        });
      }
    }, this.config.pingInterval);
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Subscribe to local document updates and push them to the peer.
   */
  private subscribeToLocalUpdates(): void {
    // Unsubscribe from any existing subscription
    if (this.unsubscribeLocalUpdates) {
      this.unsubscribeLocalUpdates();
    }

    protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "localUpdates.subscribing", {});

    // Subscribe to local updates and send them to peer
    this.unsubscribeLocalUpdates = this.documentManager.subscribeLocalUpdates(
      (updates: Uint8Array) => {
        protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "localUpdates.received", {
          bytes: updates.length,
          state: this.state,
          hasStream: !!this.stream,
          aborted: this.aborted,
        });

        if (this.state === "live" && this.stream && !this.aborted) {
          this.sendUpdate(updates).catch((err) => {
            this.logger.error("Failed to push local update:", err);
          });
        }
      },
    );

    protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "localUpdates.subscribed", {});
  }

  private stopLocalUpdateSubscription(): void {
    if (this.unsubscribeLocalUpdates) {
      this.unsubscribeLocalUpdates();
      this.unsubscribeLocalUpdates = null;
    }
  }

  // ===========================================================================
  // Private: Message I/O
  // ===========================================================================

  private async sendMessage(message: AnySyncMessage): Promise<void> {
    if (!this.stream) {
      throw TransportErrors.streamClosed("sync-session");
    }

    const bytes = serializeMessage(message);
    this._bytesSent += bytes.length;

    // Trace message send
    protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "message.sending", {
      type: SyncMessageType[message.type] || message.type,
      bytes: bytes.length,
    });

    const startTime = Date.now();
    await this.stream.send(bytes);
    const durationMs = Date.now() - startTime;

    protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "message.sent", {
      type: SyncMessageType[message.type] || message.type,
      bytes: bytes.length,
    }, durationMs);
  }

  /**
   * Receive a message from the peer with timeout.
   *
   * @param timeoutMs - Optional timeout override. Uses config.receiveTimeout by default.
   *                    Pass 0 or Infinity to disable timeout (for live sync loop).
   * @throws TransportErrors.streamClosed if stream is closed
   * @throws SyncErrors.timeout if receive times out
   */
  private async receiveMessage(timeoutMs?: number): Promise<AnySyncMessage> {
    if (!this.stream) {
      throw TransportErrors.streamClosed("sync-session");
    }

    const timeout = timeoutMs ?? this.config.receiveTimeout;
    const startTime = Date.now();

    // Trace that we're starting to receive
    protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "message.receiving", {
      timeoutMs: timeout === Infinity ? "infinite" : timeout,
    });

    // No timeout (e.g., during live loop where we wait indefinitely)
    if (timeout <= 0 || timeout === Infinity) {
      const bytes = await this.stream.receive();
      this._bytesReceived += bytes.length;
      const message = deserializeMessage(bytes);
      const durationMs = Date.now() - startTime;

      protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "message.received", {
        type: SyncMessageType[message.type] || message.type,
        bytes: bytes.length,
      }, durationMs);

      return message;
    }

    // Race between receive and timeout with guaranteed cleanup
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      const receivePromise = this.stream.receive();

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const waitedMs = Date.now() - startTime;
          protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "message.timeout", {
            waitedMs,
            timeoutMs: timeout,
          });
          reject(SyncErrors.timeout(`Receive timeout after ${timeout}ms`));
        }, timeout);
      });

      const bytes = await Promise.race([receivePromise, timeoutPromise]);
      this._bytesReceived += bytes.length;
      const message = deserializeMessage(bytes);
      const durationMs = Date.now() - startTime;

      protocolTracer.trace(this.traceSessionId, this.peerId, "sync", "message.received", {
        type: SyncMessageType[message.type] || message.type,
        bytes: bytes.length,
      }, durationMs);

      return message;
    } finally {
      // Always clean up timer, regardless of success or failure
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Determine if an error is transient and should be retried.
   * Transient errors include timeouts and network issues.
   * Non-transient errors include protocol errors and peer removal.
   */
  private isTransientError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();

    // Non-transient: protocol errors, vault mismatch, explicit errors
    // Check these first as they should never be retried
    if (
      message.includes("protocol") ||
      message.includes("mismatch") ||
      message.includes("invalid") ||
      message.includes("denied") ||
      message.includes("removed") ||
      message.includes("vault id")
    ) {
      return false;
    }

    // Transient: timeout, network, connection issues
    if (
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("connection") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("enotconn") ||
      message.includes("ehostunreach") ||
      message.includes("enetunreach") ||
      message.includes("epipe") ||
      message.includes("temporarily") ||
      message.includes("stream") ||
      message.includes("closed unexpectedly") ||
      message.includes("aborted") ||
      message.includes("reset by peer") ||
      message.includes("broken pipe")
    ) {
      return true;
    }

    // Default: assume transient for unknown errors
    return true;
  }

  // ===========================================================================
  // Private: WebRTC Upgrade
  // ===========================================================================

  /**
   * Schedule WebRTC upgrade attempt after entering live mode.
   * Uses deterministic initiator selection based on node IDs.
   */
  private scheduleWebRTCUpgrade(): void {
    if (!this.config.enableWebRTC) {
      return;
    }

    if (this.webrtcAttempts >= WEBRTC_MAX_ATTEMPTS) {
      this.logger.debug("WebRTC max attempts reached, not scheduling upgrade");
      return;
    }

    // Clear any existing timer
    if (this.webrtcUpgradeTimer) {
      clearTimeout(this.webrtcUpgradeTimer);
    }

    const delay = this.webrtcAttempts === 0 ? WEBRTC_UPGRADE_DELAY_MS : WEBRTC_RETRY_DELAY_MS;
    this.logger.debug(`Scheduling WebRTC upgrade in ${delay}ms (attempt ${this.webrtcAttempts + 1})`);

    this.webrtcUpgradeTimer = setTimeout(() => {
      this.webrtcUpgradeTimer = null;
      this.attemptWebRTCUpgradeInternal().catch((err) => {
        this.logger.error("WebRTC upgrade error:", err);
        this.setWebRTCState("failed");
        this.scheduleWebRTCRetry();
      });
    }, delay);
  }

  /**
   * Schedule a retry of WebRTC upgrade after failure.
   */
  private scheduleWebRTCRetry(): void {
    if (!this.config.enableWebRTC) return;
    if (this.webrtcAttempts >= WEBRTC_MAX_ATTEMPTS) {
      this.logger.info("WebRTC upgrade failed after max attempts, giving up");
      return;
    }

    this.webrtcAttempts++;
    this.scheduleWebRTCUpgrade();
  }

  /**
   * Attempt to upgrade to WebRTC (internal).
   * Only the "initiator" (lower node ID) creates the offer.
   */
  private async attemptWebRTCUpgradeInternal(): Promise<void> {
    if (this.webrtcState !== "none" && this.webrtcState !== "failed") {
      this.logger.debug("WebRTC upgrade already in progress or connected");
      return;
    }

    if (!this.config.ourNodeId) {
      this.logger.debug("No node ID configured, skipping WebRTC upgrade");
      return;
    }

    // Deterministic initiator selection: lower node ID creates offer
    const weAreInitiator = this.config.ourNodeId < this.peerId;
    if (!weAreInitiator) {
      this.logger.debug("We are not the initiator for WebRTC, waiting for offer");
      return;
    }

    this.logger.info("Initiating WebRTC upgrade");
    this.setWebRTCState("initiating");

    try {
      // Create peer connection
      this.webrtcPeerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });

      // Set up ICE candidate handling
      this.webrtcPeerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendWebRTCIceCandidate(event.candidate).catch((err) => {
            this.logger.error("Failed to send ICE candidate:", err);
          });
        }
      };

      // Set up connection state handling
      this.webrtcPeerConnection.onconnectionstatechange = () => {
        const state = this.webrtcPeerConnection?.connectionState;
        this.logger.debug("WebRTC connection state:", state);
        if (state === "connected") {
          this.onWebRTCConnected();
        } else if (state === "failed" || state === "disconnected") {
          this.onWebRTCFailed("Connection " + state);
        }
      };

      // Create data channel
      this.webrtcDataChannel = this.webrtcPeerConnection.createDataChannel("sync", {
        ordered: true,
      });
      this.setupDataChannel(this.webrtcDataChannel);

      // Create and send offer
      const offer = await this.webrtcPeerConnection.createOffer();
      await this.webrtcPeerConnection.setLocalDescription(offer);

      if (offer.sdp) {
        await this.sendMessage(createWebRTCOfferMessage(offer.sdp));
      }

      // Set timeout for connection
      setTimeout(() => {
        if (this.webrtcState === "initiating") {
          this.onWebRTCFailed("Connection timeout");
        }
      }, WEBRTC_CONNECTION_TIMEOUT_MS);

    } catch (err) {
      this.logger.error("Failed to create WebRTC offer:", err);
      this.onWebRTCFailed(err instanceof Error ? err.message : "Unknown error");
    }
  }

  /**
   * Handle incoming WebRTC offer from peer.
   */
  private async handleWebRTCOffer(sdp: string): Promise<void> {
    if (!this.config.enableWebRTC) {
      await this.sendMessage(createWebRTCFailedMessage("WebRTC not enabled"));
      return;
    }

    if (this.webrtcState === "connected") {
      this.logger.debug("Already connected via WebRTC, ignoring offer");
      return;
    }

    this.logger.info("Responding to WebRTC offer");
    this.setWebRTCState("responding");

    try {
      // Create peer connection
      this.webrtcPeerConnection = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });

      // Set up ICE candidate handling
      this.webrtcPeerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendWebRTCIceCandidate(event.candidate).catch((err) => {
            this.logger.error("Failed to send ICE candidate:", err);
          });
        }
      };

      // Set up connection state handling
      this.webrtcPeerConnection.onconnectionstatechange = () => {
        const state = this.webrtcPeerConnection?.connectionState;
        this.logger.debug("WebRTC connection state:", state);
        if (state === "connected") {
          this.onWebRTCConnected();
        } else if (state === "failed" || state === "disconnected") {
          this.onWebRTCFailed("Connection " + state);
        }
      };

      // Handle incoming data channel
      this.webrtcPeerConnection.ondatachannel = (event) => {
        this.webrtcDataChannel = event.channel;
        this.setupDataChannel(this.webrtcDataChannel);
      };

      // Set remote description (the offer)
      await this.webrtcPeerConnection.setRemoteDescription({
        type: "offer",
        sdp,
      });

      // Add any pending ICE candidates
      for (const candidate of this.pendingIceCandidates) {
        await this.webrtcPeerConnection.addIceCandidate(candidate);
      }
      this.pendingIceCandidates = [];

      // Create and send answer
      const answer = await this.webrtcPeerConnection.createAnswer();
      await this.webrtcPeerConnection.setLocalDescription(answer);

      if (answer.sdp) {
        await this.sendMessage(createWebRTCAnswerMessage(answer.sdp));
      }

    } catch (err) {
      this.logger.error("Failed to handle WebRTC offer:", err);
      this.onWebRTCFailed(err instanceof Error ? err.message : "Unknown error");
    }
  }

  /**
   * Handle incoming WebRTC answer from peer.
   */
  private async handleWebRTCAnswer(sdp: string): Promise<void> {
    if (!this.webrtcPeerConnection) {
      this.logger.warn("Received WebRTC answer but no peer connection");
      return;
    }

    try {
      await this.webrtcPeerConnection.setRemoteDescription({
        type: "answer",
        sdp,
      });

      // Add any pending ICE candidates
      for (const candidate of this.pendingIceCandidates) {
        await this.webrtcPeerConnection.addIceCandidate(candidate);
      }
      this.pendingIceCandidates = [];

    } catch (err) {
      this.logger.error("Failed to handle WebRTC answer:", err);
      this.onWebRTCFailed(err instanceof Error ? err.message : "Unknown error");
    }
  }

  /**
   * Handle incoming ICE candidate from peer.
   */
  private async handleWebRTCIceCandidate(msg: WebRTCIceCandidateMessage): Promise<void> {
    const candidate: RTCIceCandidateInit = {
      candidate: msg.candidate,
      sdpMid: msg.sdpMid,
      sdpMLineIndex: msg.sdpMLineIndex,
    };

    if (!this.webrtcPeerConnection || !this.webrtcPeerConnection.remoteDescription) {
      // Queue candidate until we have remote description
      this.pendingIceCandidates.push(candidate);
      return;
    }

    try {
      await this.webrtcPeerConnection.addIceCandidate(candidate);
    } catch (err) {
      this.logger.error("Failed to add ICE candidate:", err);
    }
  }

  /**
   * Send an ICE candidate to the peer.
   */
  private async sendWebRTCIceCandidate(candidate: RTCIceCandidate): Promise<void> {
    await this.sendMessage(
      createWebRTCIceCandidateMessage(
        candidate.candidate,
        candidate.sdpMid,
        candidate.sdpMLineIndex,
      ),
    );
  }

  /**
   * Set up data channel event handlers.
   */
  private setupDataChannel(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      this.logger.info("WebRTC data channel opened");
    };

    channel.onclose = () => {
      this.logger.info("WebRTC data channel closed");
      if (this.webrtcState === "connected") {
        this.setWebRTCState("failed");
        this.scheduleWebRTCRetry();
      }
    };

    channel.onerror = (event) => {
      this.logger.error("WebRTC data channel error:", event);
    };

    channel.onmessage = (event) => {
      // Handle incoming messages from WebRTC data channel
      // For now, we don't use the data channel for receiving
      // All sync messages still come through Iroh
      this.logger.debug("Received message on WebRTC data channel:", event.data.byteLength, "bytes");
    };
  }

  /**
   * Called when WebRTC connection is established.
   */
  private onWebRTCConnected(): void {
    this.logger.info("WebRTC connection established");
    this.setWebRTCState("connected");
    this.webrtcAttempts = 0; // Reset attempts on success

    // Notify peer that we're ready
    this.sendMessage(createWebRTCReadyMessage()).catch((err) => {
      this.logger.error("Failed to send WebRTC ready:", err);
    });
  }

  /**
   * Called when WebRTC connection fails.
   */
  private onWebRTCFailed(reason: string): void {
    this.logger.warn("WebRTC connection failed:", reason);
    this.cleanupWebRTC();
    this.setWebRTCState("failed");

    // Notify peer
    this.sendMessage(createWebRTCFailedMessage(reason)).catch((err) => {
      this.logger.error("Failed to send WebRTC failed:", err);
    });

    this.scheduleWebRTCRetry();
  }

  /**
   * Clean up WebRTC resources.
   */
  private cleanupWebRTC(): void {
    if (this.webrtcDataChannel) {
      try {
        this.webrtcDataChannel.close();
      } catch {
        // Ignore
      }
      this.webrtcDataChannel = null;
    }

    if (this.webrtcPeerConnection) {
      try {
        this.webrtcPeerConnection.close();
      } catch {
        // Ignore
      }
      this.webrtcPeerConnection = null;
    }

    this.pendingIceCandidates = [];
  }

  /**
   * Update WebRTC state and notify callback.
   */
  private setWebRTCState(state: WebRTCUpgradeState): void {
    if (this.webrtcState === state) return;

    this.logger.debug(`WebRTC state: ${this.webrtcState} -> ${state}`);
    this.webrtcState = state;

    if (this.config.onWebRTCStateChange) {
      this.config.onWebRTCStateChange(state);
    }
  }

  /**
   * Get current WebRTC state.
   */
  getWebRTCState(): WebRTCUpgradeState {
    return this.webrtcState;
  }

  /**
   * Check if WebRTC is connected and ready for use.
   */
  isWebRTCConnected(): boolean {
    return (
      this.webrtcState === "connected" &&
      this.webrtcDataChannel !== null &&
      this.webrtcDataChannel.readyState === "open"
    );
  }

  /**
   * Manually trigger a WebRTC upgrade attempt.
   * @returns true if upgrade was initiated, false if not possible
   */
  attemptWebRTCUpgrade(): boolean {
    if (!this.config.enableWebRTC) {
      return false;
    }
    if (this.state !== "live") {
      return false;
    }
    if (this.webrtcState === "connected") {
      return false; // Already connected
    }
    if (this.webrtcState === "initiating" || this.webrtcState === "responding") {
      return false; // Already in progress
    }

    // Clear any existing retry timer
    if (this.webrtcUpgradeTimer) {
      clearTimeout(this.webrtcUpgradeTimer);
      this.webrtcUpgradeTimer = null;
    }

    // Attempt upgrade immediately
    this.attemptWebRTCUpgradeInternal().catch((err) => {
      this.logger.error("Manual WebRTC upgrade error:", err);
      this.setWebRTCState("failed");
    });

    return true;
  }

  // ===========================================================================
  // Vault Key Exchange (Gossip)
  // ===========================================================================

  /**
   * Request the vault key from peer.
   * Call this during live mode if we don't have the vault key but peer does.
   * @returns true if request was sent, false if not possible
   */
  async requestVaultKey(): Promise<boolean> {
    if (this.state !== "live") {
      this.logger.warn("Cannot request vault key: not in live mode");
      return false;
    }

    if (this.config.hasVaultKey) {
      this.logger.debug("Not requesting vault key: we already have it");
      return false;
    }

    if (!this._peerHasVaultKey) {
      this.logger.debug("Not requesting vault key: peer doesn't have it");
      return false;
    }

    if (this._vaultKeyExchangeInProgress) {
      this.logger.debug("Not requesting vault key: exchange already in progress");
      return false;
    }

    if (!this.config.vaultKeyExchangePublicKey) {
      this.logger.warn("Cannot request vault key: no public key configured");
      return false;
    }

    this._vaultKeyExchangeInProgress = true;
    this.logger.info("Requesting vault key from peer");

    try {
      await this.sendMessage(
        createKeyExchangeRequestMessage(
          this.config.vaultKeyExchangePublicKey,
          false, // We don't have an existing key
        ),
      );
      return true;
    } catch (error) {
      this._vaultKeyExchangeInProgress = false;
      this.logger.error("Failed to request vault key:", error);
      return false;
    }
  }

  /**
   * Handle incoming vault key request from peer.
   */
  private async handleVaultKeyRequest(request: KeyExchangeRequestMessage): Promise<void> {
    if (!this.config.onPeerNeedsVaultKey) {
      this.logger.warn("Received vault key request but no handler configured");
      return;
    }

    try {
      const result = await this.config.onPeerNeedsVaultKey(request.publicKey);

      if (!result) {
        this.logger.info("No vault key to share with peer (we don't have it)");
        return;
      }

      // Send the encrypted vault key
      await this.sendMessage(
        createKeyExchangeResponseMessage(result.encryptedKey, result.isNewKey),
      );
      this.logger.info("Sent vault key to peer");
    } catch (error) {
      this.logger.error("Failed to handle vault key request:", error);
    }
  }

  /**
   * Handle incoming vault key response from peer.
   */
  private async handleVaultKeyResponse(response: KeyExchangeResponseMessage): Promise<void> {
    this._vaultKeyExchangeInProgress = false;

    if (!this.config.onVaultKeyReceived) {
      this.logger.warn("Received vault key but no handler configured");
      return;
    }

    try {
      const success = await this.config.onVaultKeyReceived(
        response.encryptedKey,
        response.isNewKey,
      );

      if (success) {
        this.logger.info("Successfully received and stored vault key from peer");
        // Emit an event so other parts of the system know we now have the key
        this.emit("vaultKey:received", undefined);
      } else {
        this.logger.error("Failed to store vault key from peer");
      }
    } catch (error) {
      this.logger.error("Failed to handle vault key response:", error);
    }
  }

  /**
   * Get whether the peer has the vault key.
   */
  getPeerHasVaultKey(): boolean | undefined {
    return this._peerHasVaultKey;
  }

  /**
   * Try to initiate vault key gossip.
   * Called when entering live mode to automatically request the key if needed.
   */
  private tryVaultKeyGossip(): void {
    // Check if we need to request the vault key
    if (!this.config.hasVaultKey && this._peerHasVaultKey && this.config.vaultKeyExchangePublicKey) {
      this.logger.info("Peer has vault key, requesting it via gossip...");
      this.requestVaultKey().catch((err) => {
        this.logger.error("Failed to request vault key via gossip:", err);
      });
    }
  }
}
