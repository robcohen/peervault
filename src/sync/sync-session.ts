/**
 * Sync Session
 *
 * Manages the sync protocol state machine for a single peer connection.
 */

import type { SyncStream } from "../transport";
import type { DocumentManager } from "../core/document-manager";
import type { BlobStore } from "../core/blob-store";
import type { Logger } from "../utils/logger";
import type { EncryptionService } from "../crypto";
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

/** Sync session configuration */
export interface SyncSessionConfig {
  /** Ping interval in ms */
  pingInterval?: number;

  /** Ping timeout in ms */
  pingTimeout?: number;

  /** Max retry attempts for sync */
  maxRetries?: number;

  /** Encryption service for E2E encryption */
  encryption?: EncryptionService;

  /** If true, don't import updates from this peer (they can only receive) */
  peerIsReadOnly?: boolean;

  /** If true, adopt peer's vault ID on first sync instead of rejecting on mismatch */
  allowVaultAdoption?: boolean;

  /** Our connection ticket to send to peer for bidirectional reconnection */
  ourTicket?: string;
}

const DEFAULT_CONFIG: Omit<Required<SyncSessionConfig>, "encryption" | "ourTicket"> & {
  peerIsReadOnly: boolean;
  allowVaultAdoption: boolean;
} = {
  pingInterval: 30000,
  pingTimeout: 10000,
  maxRetries: 3,
  peerIsReadOnly: false,
  allowVaultAdoption: false,
};

/** Sync session events */
interface SyncSessionEvents extends Record<string, unknown> {
  "state:change": SyncSessionState;
  "sync:complete": void;
  "ticket:received": string;
  "peer:removed": string | undefined; // reason
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
  private config: Omit<Required<SyncSessionConfig>, "encryption" | "ourTicket"> & {
    encryption?: EncryptionService;
    ourTicket?: string;
  };
  private aborted = false;
  private unsubscribeLocalUpdates: (() => void) | null = null;

  constructor(
    private peerId: string,
    private documentManager: DocumentManager,
    private logger: Logger,
    config?: SyncSessionConfig,
    private blobStore?: BlobStore,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the encryption service (can be set after construction).
   */
  setEncryption(encryption: EncryptionService | undefined): void {
    this.config.encryption = encryption;
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
      this.startLiveLoop();

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

      // Emit peer's ticket if received (for bidirectional reconnection)
      if (peerVersionInfo.ticket) {
        this.emit("ticket:received", peerVersionInfo.ticket);
      }

      // Validate vault ID
      let ourVaultId = this.documentManager.getVaultId();
      if (peerVersionInfo.vaultId !== ourVaultId) {
        if (this.config.allowVaultAdoption) {
          // First sync with this peer - adopt their vault ID
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

      // Send our version info (include our ticket for bidirectional reconnection)
      await this.sendMessage(
        createVersionInfoMessage(
          ourVaultId,
          this.documentManager.getVersionBytes(),
          this.config.ourTicket,
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
      this.startLiveLoop();

      this.emit("sync:complete", undefined);
    } catch (error) {
      this.logger.error("Incoming sync session error:", error);
      this.setState("error");
      this.emit("error", error as Error);
    }
  }

  /**
   * Send a local update to the peer (for live sync).
   */
  async sendUpdate(updates: Uint8Array): Promise<void> {
    if (this.state !== "live" || !this.stream) {
      this.logger.warn("Cannot send update: not in live state");
      return;
    }

    try {
      await this.sendMessage(createUpdatesMessage(updates, 0)); // opCount unknown
    } catch (error) {
      this.logger.error("Failed to send update:", error);
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

  private async exchangeVersions(): Promise<void> {
    const vaultId = this.documentManager.getVaultId();
    const versionBytes = this.documentManager.getVersionBytes();

    // Send our version info (include our ticket for bidirectional reconnection)
    await this.sendMessage(
      createVersionInfoMessage(vaultId, versionBytes, this.config.ourTicket),
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

    // Emit peer's ticket if received (for bidirectional reconnection)
    if (peerVersionInfo.ticket) {
      this.emit("ticket:received", peerVersionInfo.ticket);
    }

    this.logger.debug("Version exchange complete");
  }

  // ===========================================================================
  // Private: Update Sync (Initiator)
  // ===========================================================================

  private async syncUpdates(): Promise<void> {
    // Get our current version
    const ourVersion = this.documentManager.getVersion();

    // Export updates we have
    const ourUpdates = this.documentManager.exportUpdates();

    // Send our updates
    if (ourUpdates.length > 0) {
      await this.sendMessage(createUpdatesMessage(ourUpdates, 0));
    }

    // Wait for peer's updates
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

    // Send sync complete
    const finalVersion = this.documentManager.getVersionBytes();
    await this.sendMessage(createSyncCompleteMessage(finalVersion));

    // Wait for peer's sync complete
    const completeMsg = await this.receiveMessage();
    if (completeMsg.type !== SyncMessageType.SYNC_COMPLETE) {
      this.logger.warn("Expected SYNC_COMPLETE, got:", completeMsg.type);
    }

    this.logger.debug("Sync complete");
  }

  // ===========================================================================
  // Private: Update Sync (Receiver)
  // ===========================================================================

  private async syncUpdatesAsReceiver(
    peerVersionBytes: Uint8Array,
  ): Promise<void> {
    // Wait for peer's updates first
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

    // Send our updates
    const ourUpdates = this.documentManager.exportUpdates();
    if (ourUpdates.length > 0) {
      await this.sendMessage(createUpdatesMessage(ourUpdates, 0));
    } else {
      // Send empty updates
      await this.sendMessage(createUpdatesMessage(new Uint8Array(0), 0));
    }

    // Wait for sync complete
    const completeMsg = await this.receiveMessage();
    if (completeMsg.type !== SyncMessageType.SYNC_COMPLETE) {
      this.logger.warn("Expected SYNC_COMPLETE, got:", completeMsg.type);
    }

    // Send our sync complete
    const finalVersion = this.documentManager.getVersionBytes();
    await this.sendMessage(createSyncCompleteMessage(finalVersion));

    this.logger.debug("Sync complete (receiver)");
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

    // Send blobs peer wants
    for (const hash of peerWants) {
      const data = await this.blobStore.get(hash);
      if (data) {
        const meta = await this.blobStore.getMeta(hash);
        await this.sendMessage(
          createBlobDataMessage(hash, data, meta?.mimeType),
        );
      }
    }

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

    // Now send blobs peer wants
    for (const hash of peerWants) {
      const data = await this.blobStore.get(hash);
      if (data) {
        const meta = await this.blobStore.getMeta(hash);
        await this.sendMessage(
          createBlobDataMessage(hash, data, meta?.mimeType),
        );
      }
    }

    // Send our blob sync complete
    await this.sendMessage(createBlobSyncCompleteMessage(peerWants.length));

    this.logger.debug("Blob sync complete (receiver)");
  }

  // ===========================================================================
  // Private: Live Sync
  // ===========================================================================

  private async startLiveLoop(): Promise<void> {
    while (this.state === "live" && this.stream && !this.aborted) {
      try {
        const message = await this.receiveMessage();

        switch (message.type) {
          case SyncMessageType.UPDATES: {
            const updatesMsg = message as UpdatesMessage;
            if (updatesMsg.updates.length > 0) {
              if (this.config.peerIsReadOnly) {
                this.logger.debug("Skipping live update from read-only peer");
              } else {
                this.documentManager.importUpdates(updatesMsg.updates);
                this.logger.debug("Imported live update from peer");
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

          default:
            this.logger.warn("Unexpected message in live mode:", message.type);
        }
      } catch (error) {
        if (!this.aborted) {
          this.logger.error("Live loop error:", error);
          this.setState("error");
          this.emit("error", error as Error);
        }
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

    let bytes = serializeMessage(message);

    // Encrypt if encryption is enabled
    if (this.config.encryption?.isEnabled()) {
      bytes = await this.config.encryption.encrypt(bytes);
    }

    await this.stream.send(bytes);
  }

  private async receiveMessage(): Promise<AnySyncMessage> {
    if (!this.stream) {
      throw TransportErrors.streamClosed("sync-session");
    }

    let bytes = await this.stream.receive();

    // Decrypt if encryption is enabled
    if (this.config.encryption?.isEnabled()) {
      bytes = await this.config.encryption.decrypt(bytes);
    }

    return deserializeMessage(bytes);
  }
}
