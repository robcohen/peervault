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
import {
  SyncMessageType,
  SyncErrorCode,
  type SyncSessionState,
  type AnySyncMessage,
  type VersionInfoMessage,
  type UpdatesMessage,
  type BlobHashesMessage,
  type BlobRequestMessage,
  type BlobDataMessage,
  type PeerRemovedMessage,
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
} from "./messages";
import { EventEmitter } from "../utils/events";

/** Maximum length for peer hostname/nickname to prevent abuse */
const MAX_PEER_NAME_LENGTH = 64;

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
}

const DEFAULT_CONFIG: Omit<Required<SyncSessionConfig>, "ourTicket" | "ourHostname" | "ourNickname" | "onVaultAdoptionNeeded"> & {
  peerIsReadOnly: boolean;
  allowVaultAdoption: boolean;
} = {
  pingInterval: 15000, // Reduced from 30000 for faster stale detection
  pingTimeout: 10000,
  receiveTimeout: 30000, // 30 seconds default receive timeout
  maxRetries: 3,
  peerIsReadOnly: false,
  allowVaultAdoption: false,
};

/** Sync session events */
interface SyncSessionEvents extends Record<string, unknown> {
  "state:change": SyncSessionState;
  "sync:complete": void;
  "ticket:received": string;
  "peer:info": { hostname: string; nickname?: string };
  "peer:removed": string | undefined; // reason
  "blob:received": string; // blob hash
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
  private config: Omit<Required<SyncSessionConfig>, "ourTicket" | "ourHostname" | "ourNickname" | "onVaultAdoptionNeeded"> & {
    ourTicket: string;
    ourHostname: string;
    ourNickname?: string;
    onVaultAdoptionNeeded?: (peerVaultId: string, ourVaultId: string) => Promise<boolean>;
  };
  private aborted = false;
  private unsubscribeLocalUpdates: (() => void) | null = null;

  // Micro-batching for reduced latency
  private pendingUpdates: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_DELAY_MS = 15;
  private readonly MAX_PENDING_UPDATES = 100;
  private readonly MAX_PENDING_BYTES = 1024 * 1024; // 1MB
  private pendingBytes = 0;

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
    this.setState("exchanging_versions");

    try {
      // Step 1: Exchange version vectors
      await this.exchangeVersions();

      if (this.aborted) return;

      // Step 2: Sync document updates
      this.setState("syncing");
      await this.syncUpdates();

      if (this.aborted) return;

      // Step 3: Sync blobs (if blob store available)
      if (this.blobStore) {
        await this.syncBlobs();
        if (this.aborted) return;
      }

      // Step 4: Enter live mode
      this.setState("live");
      this.startPingTimer();
      this.subscribeToLocalUpdates();
      this.startLiveLoop().catch((err) => {
        this.logger.error("Live loop error:", err);
        this.emit("error", err as Error);
      });

      this.emit("sync:complete", undefined);
    } catch (error) {
      this.logger.error("Sync session error:", error);
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
    this.setState("exchanging_versions");

    try {
      // Wait for peer's version info first
      const peerMessage = await this.receiveMessage();

      if (peerMessage.type !== SyncMessageType.VERSION_INFO) {
        throw SyncErrors.protocolError(`Expected VERSION_INFO, got: ${peerMessage.type}`);
      }

      const peerVersionInfo = peerMessage as VersionInfoMessage;

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

      // Send our version info
      await this.sendMessage(
        createVersionInfoMessage(
          ourVaultId,
          this.documentManager.getVersionBytes(),
          this.config.ourTicket,
          this.config.ourHostname,
          this.config.ourNickname,
        ),
      );

      if (this.aborted) return;

      // Step 2: Sync document updates
      this.setState("syncing");
      await this.syncUpdatesAsReceiver(peerVersionInfo.versionBytes);

      if (this.aborted) return;

      // Step 3: Sync blobs (if blob store available)
      if (this.blobStore) {
        await this.syncBlobsAsReceiver();
        if (this.aborted) return;
      }

      // Step 4: Enter live mode
      this.setState("live");
      this.startPingTimer();
      this.subscribeToLocalUpdates();
      this.startLiveLoop().catch((err) => {
        this.logger.error("Live loop error:", err);
        this.emit("error", err as Error);
      });

      this.emit("sync:complete", undefined);
    } catch (error) {
      this.logger.error("Incoming sync session error:", error);
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
   * Close the sync session.
   */
  async close(): Promise<void> {
    this.aborted = true;
    this.stopPingTimer();
    this.stopLocalUpdateSubscription();

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

    this.logger.debug(`Sync session ${this.peerId}: ${this.state} -> ${state}`);
    this.state = state;
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

    // Send our version info
    await this.sendMessage(
      createVersionInfoMessage(
        vaultId,
        versionBytes,
        this.config.ourTicket,
        this.config.ourHostname,
        this.config.ourNickname,
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

    // Emit peer's ticket (for bidirectional reconnection)
    this.emit("ticket:received", peerVersionInfo.ticket);

    // Emit peer's info (for display) - sanitize to prevent abuse
    this.emit("peer:info", {
      hostname: sanitizePeerString(peerVersionInfo.hostname ?? "") ?? "",
      nickname: sanitizePeerString(peerVersionInfo.nickname ?? ""),
    });

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
    await this.sendOurUpdates();
    await this.receiveAndImportUpdates();
    await this.exchangeSyncComplete(true);
    this.logger.debug("Sync complete");
  }

  // ===========================================================================
  // Private: Update Sync (Receiver)
  // ===========================================================================

  private async syncUpdatesAsReceiver(
    _peerVersionBytes: Uint8Array,
  ): Promise<void> {
    // Receiver: receive first, then send
    await this.receiveAndImportUpdates();
    await this.sendOurUpdates();
    await this.exchangeSyncComplete(false);
    this.logger.debug("Sync complete (receiver)");
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
    const peerMessage = await this.receiveMessage();

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

    if (sendFirst) {
      await this.sendMessage(createSyncCompleteMessage(finalVersion));
      const completeMsg = await this.receiveMessage();
      if (completeMsg.type !== SyncMessageType.SYNC_COMPLETE) {
        this.logger.warn("Expected SYNC_COMPLETE, got:", completeMsg.type);
      }
    } else {
      const completeMsg = await this.receiveMessage();
      if (completeMsg.type !== SyncMessageType.SYNC_COMPLETE) {
        this.logger.warn("Expected SYNC_COMPLETE, got:", completeMsg.type);
      }
      await this.sendMessage(createSyncCompleteMessage(finalVersion));
    }
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
    this.logger.debug("Syncing blobs, we have:", ourHashes.length);

    // Send our blob hashes
    await this.sendMessage(createBlobHashesMessage(ourHashes));

    // Receive peer's blob hashes
    const peerMessage = await this.receiveMessage();
    if (peerMessage.type !== SyncMessageType.BLOB_HASHES) {
      throw SyncErrors.protocolError(`Expected BLOB_HASHES, got: ${peerMessage.type}`);
    }

    const peerHashes = (peerMessage as BlobHashesMessage).hashes;
    this.logger.debug("Peer has blobs:", peerHashes.length);

    // Find blobs we're missing
    const missingFromUs = await this.blobStore.getMissing(peerHashes);
    this.logger.debug("Missing from us:", missingFromUs.length);

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

    // Send blobs peer wants (parallel load, sequential send)
    await this.sendBlobsParallel(peerWants);

    // Send blob sync complete (we're done sending)
    await this.sendMessage(createBlobSyncCompleteMessage(peerWants.length));

    // Receive blobs we requested
    let received = 0;
    while (received < missingFromUs.length) {
      const msg = await this.receiveMessage();
      if (msg.type === SyncMessageType.BLOB_DATA) {
        const blobMsg = msg as BlobDataMessage;
        await this.blobStore.add(blobMsg.data, blobMsg.mimeType);
        received++;
        this.logger.debug("Received blob:", blobMsg.hash);
      } else if (msg.type === SyncMessageType.BLOB_SYNC_COMPLETE) {
        // Peer is done sending
        break;
      } else {
        throw SyncErrors.protocolError(`Unexpected message during blob sync: ${msg.type}`);
      }
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

    if (missingFromUs.length > 0) {
      await this.sendMessage(createBlobRequestMessage(missingFromUs));
    } else {
      await this.sendMessage(createBlobRequestMessage([]));
    }

    // Receive blobs from peer first (peer sends their requested blobs first)
    let received = 0;
    while (received < missingFromUs.length) {
      const msg = await this.receiveMessage();
      if (msg.type === SyncMessageType.BLOB_DATA) {
        const blobMsg = msg as BlobDataMessage;
        await this.blobStore.add(blobMsg.data, blobMsg.mimeType);
        received++;
        this.logger.debug("Received blob:", blobMsg.hash);
      } else if (msg.type === SyncMessageType.BLOB_SYNC_COMPLETE) {
        // Peer is done sending
        break;
      } else {
        throw SyncErrors.protocolError(`Unexpected message during blob sync: ${msg.type}`);
      }
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
   * Loads blobs in batches of 4 from disk, then sends sequentially.
   */
  private async sendBlobsParallel(hashes: string[]): Promise<void> {
    if (!this.blobStore || hashes.length === 0) return;

    const BATCH_SIZE = 4;

    for (let i = 0; i < hashes.length; i += BATCH_SIZE) {
      const batch = hashes.slice(i, i + BATCH_SIZE);

      // Load batch in parallel
      const blobsWithData = await Promise.all(
        batch.map(async (hash) => {
          const data = await this.blobStore!.get(hash);
          const meta = data ? await this.blobStore!.getMeta(hash) : null;
          return { hash, data, mimeType: meta?.mimeType };
        }),
      );

      // Send loaded blobs sequentially (protocol requires ordered messages)
      for (const blob of blobsWithData) {
        if (blob.data) {
          await this.sendMessage(
            createBlobDataMessage(blob.hash, blob.data, blob.mimeType),
          );
        }
      }
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
            // Peer is sending blob data - store it
            const blobMsg = message as BlobDataMessage;
            if (this.blobStore) {
              await this.blobStore.add(blobMsg.data, blobMsg.mimeType);
              this.logger.debug("Received blob in live mode:", blobMsg.hash.slice(0, 16));
              // Emit event so VaultSync can retry writing the file
              this.emit("blob:received", blobMsg.hash);
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

    // Subscribe to local updates and send them to peer
    this.unsubscribeLocalUpdates = this.documentManager.subscribeLocalUpdates(
      (updates: Uint8Array) => {
        if (this.state === "live" && this.stream && !this.aborted) {
          this.sendUpdate(updates).catch((err) => {
            this.logger.error("Failed to push local update:", err);
          });
        }
      },
    );
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
    await this.stream.send(bytes);
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

    // No timeout (e.g., during live loop where we wait indefinitely)
    if (timeout <= 0 || timeout === Infinity) {
      const bytes = await this.stream.receive();
      return deserializeMessage(bytes);
    }

    // Race between receive and timeout with guaranteed cleanup
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    try {
      const receivePromise = this.stream.receive();

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(SyncErrors.timeout(`Receive timeout after ${timeout}ms`));
        }, timeout);
      });

      const bytes = await Promise.race([receivePromise, timeoutPromise]);
      return deserializeMessage(bytes);
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

    // Transient: timeout, network, connection issues
    if (
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("connection") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("epipe") ||
      message.includes("temporarily")
    ) {
      return true;
    }

    // Non-transient: protocol errors, vault mismatch, explicit errors
    if (
      message.includes("protocol") ||
      message.includes("mismatch") ||
      message.includes("invalid") ||
      message.includes("denied") ||
      message.includes("removed")
    ) {
      return false;
    }

    // Default: assume transient for unknown errors
    return true;
  }
}
