/**
 * Cloud Sync Service
 *
 * Manages encrypted sync between local CRDT state and S3-compatible cloud storage.
 * Supports any S3-compatible backend: AWS S3, MinIO, Backblaze B2, Cloudflare R2, etc.
 *
 * Features:
 * - Encrypted delta upload/download (XSalsa20-Poly1305)
 * - Intentional commits (Radicle-style version control)
 * - Incremental sync (only transfer changes)
 * - Offline-first (queue uploads when offline, sync when back online)
 * - Automatic retry with exponential backoff for transient failures
 * - Parallel delta downloads for improved performance
 * - Conflict detection and resolution (merge, local, remote, manual strategies)
 * - Binary blob sync with encryption
 * - Storage usage statistics
 * - Progress events for UI feedback
 *
 * Network Resilience:
 * - Monitors online/offline status via browser events
 * - Queues changes locally when offline
 * - Auto-syncs pending changes when connection restored
 * - Retries transient failures (5xx, network errors) up to 3 times
 * - Schedules background retry after consecutive failures
 *
 * Usage:
 *   const cloudSync = createCloudSync(documentManager, storage, logger);
 *   await cloudSync.initialize();
 *   await cloudSync.configure({ endpoint, bucket, accessKeyId, secretAccessKey });
 *   cloudSync.setVaultKey(encryptionKey);
 *   await cloudSync.sync();
 */

import type { Logger } from "../utils/logger";
import type { DocumentManager } from "../core/document-manager";
import type { StorageAdapter } from "../types";
import { S3Client, S3Error, createS3Client } from "./s3-client";
import { encrypt, decrypt } from "../crypto";
import type {
  CloudStorageConfig,
  CloudSyncState,
  CloudSyncStatus,
  Commit,
  CommitOptions,
  DeltaIndex,
  DeltaMeta,
  SyncResult,
  VaultManifest,
  BlobIndex,
  CloudBlobMeta,
  CloudConflict,
  ConflictResolutionStrategy,
  ConflictResolution,
  SyncProgress,
  TransferProgress,
} from "./types";
import type { BlobStore } from "../core/blob-store";
import { EventEmitter } from "../utils/events";

/** Storage key for local cloud sync state */
const CLOUD_STATE_KEY = "peervault-cloud-state";
const CLOUD_CONFIG_KEY = "peervault-cloud-config";
const PENDING_DELTAS_KEY = "peervault-pending-deltas";

/** Retry configuration */
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/** Check if an error is retryable (transient) */
function isRetryableError(error: unknown): boolean {
  if (error instanceof S3Error) {
    // Retryable S3 errors
    const retryableCodes = [
      "SlowDown",
      "ServiceUnavailable",
      "InternalError",
      "RequestTimeout",
      "RequestTimeTooSkewed",
    ];
    if (error.code && retryableCodes.includes(error.code)) {
      return true;
    }
    // Retryable HTTP status codes
    if (error.statusCode >= 500 || error.statusCode === 429) {
      return true;
    }
  }

  if (error instanceof TypeError) {
    // Network errors from fetch
    return true;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("network") ||
      msg.includes("fetch") ||
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound")
    ) {
      return true;
    }
  }

  return false;
}

/** Events emitted by cloud sync */
interface CloudSyncEvents extends Record<string, unknown> {
  "status:change": CloudSyncStatus;
  "sync:complete": SyncResult;
  "sync:error": Error;
  "sync:retry": { attempt: number; maxAttempts: number; delayMs: number; error: string };
  "commit:created": Commit;
  "progress:sync": SyncProgress;
  "progress:transfer": TransferProgress;
  "conflict:detected": CloudConflict;
  "conflict:resolved": ConflictResolution;
  "network:offline": void;
  "network:online": void;
  "config:updated": { source: "peer" | "local" };
}

/**
 * Local delta waiting to be uploaded.
 */
interface PendingDelta {
  id: string;
  timestamp: number;
  data: Uint8Array;
  version: Uint8Array;
}

/**
 * Cloud Sync Service.
 */
export class CloudSync extends EventEmitter<CloudSyncEvents> {
  private client: S3Client | null = null;
  private config: CloudStorageConfig | null = null;
  private state: CloudSyncState = {
    status: "disabled",
    pendingUploads: 0,
    pendingDownloads: 0,
  };
  private vaultKey: Uint8Array | null = null;
  private pendingDeltas: PendingDelta[] = [];
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncInProgress = false;
  private blobStore: BlobStore | null = null;
  private localHeadCommit: string | null = null;
  private conflictStrategy: ConflictResolutionStrategy = "merge";
  private isOnline = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;

  constructor(
    private documentManager: DocumentManager,
    private storage: StorageAdapter,
    private logger: Logger,
  ) {
    super();
  }

  /**
   * Set the blob store for binary file sync.
   */
  setBlobStore(blobStore: BlobStore): void {
    this.blobStore = blobStore;
    this.logger.debug("Blob store set for cloud sync");
  }

  /**
   * Set the conflict resolution strategy.
   */
  setConflictStrategy(strategy: ConflictResolutionStrategy): void {
    this.conflictStrategy = strategy;
    this.logger.debug(`Conflict resolution strategy set to: ${strategy}`);
  }

  /**
   * Initialize cloud sync.
   * Loads configuration from storage and CRDT, preferring the newer one.
   * Also loads pending deltas.
   */
  async initialize(): Promise<void> {
    // Load configuration from local storage
    let localConfig: CloudStorageConfig | null = null;
    let localConfigTime = 0;

    const configData = await this.storage.read(CLOUD_CONFIG_KEY);
    if (configData) {
      try {
        const configJson = new TextDecoder().decode(configData);
        localConfig = JSON.parse(configJson);
        // Try to get timestamp from a separate key
        const timeData = await this.storage.read(CLOUD_CONFIG_KEY + "-time");
        if (timeData) {
          localConfigTime = parseInt(new TextDecoder().decode(timeData), 10) || 0;
        }
        this.logger.debug("Cloud sync config loaded from local storage");
      } catch (err) {
        this.logger.warn("Failed to parse local cloud config:", err);
      }
    }

    // Check CRDT for config (may have been synced from another peer)
    const crdtConfig = await this.loadConfigFromCRDT();
    const crdtConfigTime = this.documentManager.getCloudConfigUpdatedAt() || 0;

    // Use the newer config (CRDT wins if timestamps are equal - peer config takes precedence)
    if (crdtConfig && crdtConfigTime >= localConfigTime) {
      this.config = crdtConfig;
      this.client = createS3Client(this.config);
      // Also update local storage for faster loading next time
      await this.storage.write(CLOUD_CONFIG_KEY, new TextEncoder().encode(JSON.stringify(crdtConfig)));
      await this.storage.write(CLOUD_CONFIG_KEY + "-time", new TextEncoder().encode(String(crdtConfigTime)));
      this.logger.info("Cloud sync config loaded from CRDT (synced from peer)");
    } else if (localConfig) {
      this.config = localConfig;
      this.client = createS3Client(this.config);
      this.logger.debug("Cloud sync config loaded from local storage");
    }

    // Load pending deltas
    const pendingData = await this.storage.read(PENDING_DELTAS_KEY);
    const pendingJson = pendingData ? new TextDecoder().decode(pendingData) : null;
    if (pendingJson) {
      try {
        const pending = JSON.parse(pendingJson);
        // Convert base64 back to Uint8Array
        this.pendingDeltas = pending.map((d: { id: string; timestamp: number; data: string; version: string }) => ({
          id: d.id,
          timestamp: d.timestamp,
          data: this.base64ToUint8Array(d.data),
          version: this.base64ToUint8Array(d.version),
        }));
        this.state.pendingUploads = this.pendingDeltas.length;
        this.logger.debug(`Loaded ${this.pendingDeltas.length} pending deltas`);
      } catch (err) {
        this.logger.warn("Failed to parse pending deltas:", err);
      }
    }

    // Update status
    if (this.config && this.client) {
      this.setStatus("idle");
    }

    // Set up network status monitoring (browser environment)
    if (typeof window !== "undefined") {
      this.isOnline = navigator.onLine;

      window.addEventListener("online", () => {
        if (!this.isOnline) {
          this.isOnline = true;
          this.logger.info("Network back online");
          this.emit("network:online", undefined);
          // Trigger sync if we have pending uploads
          if (this.pendingDeltas.length > 0 && this.isConfigured()) {
            this.logger.info("Syncing pending changes after coming back online");
            this.sync().catch((err) => {
              this.logger.warn("Failed to sync after coming online:", err);
            });
          }
        }
      });

      window.addEventListener("offline", () => {
        if (this.isOnline) {
          this.isOnline = false;
          this.logger.info("Network went offline");
          this.emit("network:offline", undefined);
        }
      });
    }
  }

  /**
   * Check if currently online.
   */
  isNetworkOnline(): boolean {
    return this.isOnline;
  }

  /**
   * Configure cloud sync with S3 credentials.
   * Saves config to both local storage (for quick access) and CRDT (for peer sync).
   */
  async configure(config: CloudStorageConfig): Promise<boolean> {
    // Test connection first
    const testClient = createS3Client(config);
    const connected = await testClient.testConnection();

    if (!connected) {
      this.logger.error("Failed to connect to cloud storage");
      return false;
    }

    // Save configuration
    this.config = config;
    this.client = testClient;

    const now = Date.now();

    // Save to local storage (for quick loading on restart)
    await this.storage.write(CLOUD_CONFIG_KEY, new TextEncoder().encode(JSON.stringify(config)));
    await this.storage.write(CLOUD_CONFIG_KEY + "-time", new TextEncoder().encode(String(now)));

    // Save to CRDT (encrypted, for peer sync)
    await this.saveConfigToCRDT(config);

    this.setStatus("idle");
    this.logger.info("Cloud sync configured successfully (will sync to peers)");
    return true;
  }

  /**
   * Load cloud config from CRDT metadata.
   * Decrypts the config using the vault key.
   * @returns Config or null if not found or decryption fails
   */
  private async loadConfigFromCRDT(): Promise<CloudStorageConfig | null> {
    if (!this.vaultKey) {
      this.logger.debug("Cannot load CRDT cloud config: vault key not set");
      return null;
    }

    const encryptedConfig = this.documentManager.getCloudConfig();
    if (!encryptedConfig) {
      return null;
    }

    try {
      const decryptedBytes = decrypt(encryptedConfig, this.vaultKey);
      if (!decryptedBytes) {
        this.logger.warn("Failed to decrypt cloud config from CRDT: decryption returned null");
        return null;
      }
      const configJson = new TextDecoder().decode(decryptedBytes);
      const config = JSON.parse(configJson) as CloudStorageConfig;
      this.logger.debug("Decrypted cloud config from CRDT");
      return config;
    } catch (err) {
      this.logger.warn("Failed to decrypt cloud config from CRDT:", err);
      return null;
    }
  }

  /**
   * Save cloud config to CRDT metadata (encrypted).
   * This allows the config to sync to other peers.
   */
  private async saveConfigToCRDT(config: CloudStorageConfig): Promise<void> {
    if (!this.vaultKey) {
      this.logger.warn("Cannot save cloud config to CRDT: vault key not set");
      return;
    }

    try {
      const configJson = JSON.stringify(config);
      const configBytes = new TextEncoder().encode(configJson);
      const encryptedConfig = encrypt(configBytes, this.vaultKey);
      this.documentManager.setCloudConfig(encryptedConfig);
      this.logger.info("Cloud config saved to CRDT (encrypted, will sync to peers)");
    } catch (err) {
      this.logger.error("Failed to save cloud config to CRDT:", err);
    }
  }

  /**
   * Check if cloud config has been updated from peer sync.
   * Call this after CRDT sync to pick up config changes.
   * @returns true if config was updated
   */
  async checkForConfigUpdate(): Promise<boolean> {
    const crdtConfig = await this.loadConfigFromCRDT();
    const crdtConfigTime = this.documentManager.getCloudConfigUpdatedAt() || 0;

    // Get local config timestamp
    const timeData = await this.storage.read(CLOUD_CONFIG_KEY + "-time");
    const localConfigTime = timeData ? parseInt(new TextDecoder().decode(timeData), 10) || 0 : 0;

    // If CRDT config is newer, apply it
    if (crdtConfig && crdtConfigTime > localConfigTime) {
      this.logger.info("Cloud config updated from peer sync");

      // Test the new config
      const testClient = createS3Client(crdtConfig);
      const connected = await testClient.testConnection();

      if (connected) {
        this.config = crdtConfig;
        this.client = testClient;

        // Update local storage
        await this.storage.write(CLOUD_CONFIG_KEY, new TextEncoder().encode(JSON.stringify(crdtConfig)));
        await this.storage.write(CLOUD_CONFIG_KEY + "-time", new TextEncoder().encode(String(crdtConfigTime)));

        this.setStatus("idle");
        this.logger.info("Cloud sync auto-configured from peer");
        this.emit("config:updated", { source: "peer" });
        return true;
      } else {
        this.logger.warn("Cloud config from peer failed connection test");
      }
    }

    return false;
  }

  /**
   * Disable cloud sync.
   * Clears config from both local storage and CRDT.
   */
  async disable(): Promise<void> {
    this.stopAutoSync();
    this.config = null;
    this.client = null;

    // Clear from local storage
    await this.storage.delete(CLOUD_CONFIG_KEY);
    await this.storage.delete(CLOUD_CONFIG_KEY + "-time");

    // Clear from CRDT (will sync to peers)
    this.documentManager.setCloudConfig(null);

    this.setStatus("disabled");
    this.logger.info("Cloud sync disabled (will sync to peers)");
  }

  /**
   * Set the vault encryption key.
   */
  setVaultKey(key: Uint8Array): void {
    this.vaultKey = key;
    this.logger.debug("Vault key set for cloud encryption");
  }

  /**
   * Get current sync state.
   */
  getState(): CloudSyncState {
    return {
      ...this.state,
      hasVaultKey: this.vaultKey !== null,
    };
  }

  /**
   * Check if cloud sync is configured.
   */
  isConfigured(): boolean {
    return this.config !== null && this.client !== null;
  }

  /**
   * Start automatic periodic sync.
   */
  startAutoSync(intervalMs = 60000): void {
    if (this.syncTimer) {
      this.stopAutoSync();
    }

    this.syncTimer = setInterval(() => {
      this.sync().catch((err) => {
        this.logger.error("Auto sync failed:", err);
      });
    }, intervalMs);

    this.logger.debug(`Auto sync started (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop automatic sync.
   */
  stopAutoSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      this.logger.debug("Auto sync stopped");
    }
  }

  /**
   * Queue a delta for upload.
   * Called when local CRDT state changes.
   */
  async queueDelta(deltaData: Uint8Array): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    const timestamp = Date.now();
    const hash = await this.hashData(deltaData);
    const id = `${timestamp}-${hash.slice(0, 16)}`;
    const version = this.documentManager.getVersionBytes();

    const delta: PendingDelta = {
      id,
      timestamp,
      data: deltaData,
      version,
    };

    this.pendingDeltas.push(delta);
    this.state.pendingUploads = this.pendingDeltas.length;
    await this.savePendingDeltas();

    this.logger.debug(`Queued delta ${id} for upload`);
  }

  /**
   * Perform a full sync with cloud storage, with automatic retry on transient failures.
   */
  async sync(): Promise<SyncResult> {
    // Check if offline
    if (!this.isOnline) {
      this.logger.debug("Sync skipped: offline");
      return {
        success: false,
        deltasUploaded: 0,
        deltasDownloaded: 0,
        blobsUploaded: 0,
        blobsDownloaded: 0,
        error: "Device is offline. Changes will sync when back online.",
      };
    }

    return this.syncWithRetry();
  }

  /**
   * Internal sync with retry logic.
   */
  private async syncWithRetry(attempt = 1): Promise<SyncResult> {
    if (!this.isConfigured()) {
      return { success: false, deltasUploaded: 0, deltasDownloaded: 0, blobsUploaded: 0, blobsDownloaded: 0, error: "Cloud sync not configured" };
    }

    if (!this.vaultKey) {
      return { success: false, deltasUploaded: 0, deltasDownloaded: 0, blobsUploaded: 0, blobsDownloaded: 0, error: "Vault key not set" };
    }

    if (this.syncInProgress) {
      return { success: false, deltasUploaded: 0, deltasDownloaded: 0, blobsUploaded: 0, blobsDownloaded: 0, error: "Sync already in progress" };
    }

    this.syncInProgress = true;
    this.setStatus("syncing");

    const progress: SyncProgress = {
      phase: "preparing",
      completed: 0,
      total: 0,
      bytesTransferred: 0,
      bytesTotal: 0,
    };

    try {
      // Get or create vault manifest
      const manifest = await this.getOrCreateManifest();

      // Check for conflicts
      const conflict = await this.detectConflict(manifest);
      if (conflict) {
        this.emit("conflict:detected", conflict);
        const resolution = await this.resolveConflict(conflict, manifest);
        if (!resolution) {
          return { success: false, deltasUploaded: 0, deltasDownloaded: 0, blobsUploaded: 0, blobsDownloaded: 0, error: "Conflict resolution failed" };
        }
        this.emit("conflict:resolved", resolution);
      }

      // Download new deltas from cloud
      progress.phase = "downloading";
      this.emit("progress:sync", { ...progress });
      this.setStatus("downloading");
      const downloaded = await this.downloadDeltas(manifest, progress);

      // Download missing blobs
      let blobsDownloaded = 0;
      if (this.blobStore) {
        blobsDownloaded = await this.downloadMissingBlobs(progress);
      }

      // Upload pending deltas
      progress.phase = "uploading";
      this.emit("progress:sync", { ...progress });
      this.setStatus("uploading");
      const uploaded = await this.uploadPendingDeltas(manifest, progress);

      // Upload local blobs not in cloud
      let blobsUploaded = 0;
      if (this.blobStore) {
        blobsUploaded = await this.uploadLocalBlobs(progress);
      }

      // Finalize
      progress.phase = "finalizing";
      this.emit("progress:sync", { ...progress });

      // Update manifest
      if (uploaded > 0 || downloaded > 0 || blobsUploaded > 0 || blobsDownloaded > 0) {
        await this.updateManifest(manifest);
      }

      this.setStatus("idle");
      this.state.lastSyncedAt = Date.now();

      const result: SyncResult = {
        success: true,
        deltasUploaded: uploaded,
        deltasDownloaded: downloaded,
        blobsUploaded,
        blobsDownloaded,
        newHead: manifest.headCommit || undefined,
      };

      // Reset consecutive failures on success
      this.consecutiveFailures = 0;
      this.emit("sync:complete", result);
      return result;
    } catch (error) {
      const errorMessage = this.formatError(error);
      this.logger.error(`Sync failed (attempt ${attempt}):`, error);

      // Check if we should retry
      if (isRetryableError(error) && attempt < RETRY_CONFIG.maxRetries) {
        this.syncInProgress = false; // Allow retry

        // Calculate delay with exponential backoff
        const delayMs = Math.min(
          RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
          RETRY_CONFIG.maxDelayMs,
        );

        this.logger.info(`Retrying sync in ${delayMs}ms (attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries})`);
        this.emit("sync:retry", {
          attempt: attempt + 1,
          maxAttempts: RETRY_CONFIG.maxRetries,
          delayMs,
          error: errorMessage,
        });

        // Wait and retry
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this.syncWithRetry(attempt + 1);
      }

      // Max retries exceeded or non-retryable error
      this.consecutiveFailures++;
      this.setStatus("error");
      this.state.error = errorMessage;
      this.emit("sync:error", error instanceof Error ? error : new Error(errorMessage));

      // Schedule background retry if we have pending changes
      if (this.pendingDeltas.length > 0 && this.consecutiveFailures < 5) {
        this.scheduleBackgroundRetry();
      }

      return {
        success: false,
        deltasUploaded: 0,
        deltasDownloaded: 0,
        blobsUploaded: 0,
        blobsDownloaded: 0,
        error: errorMessage,
      };
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Schedule a background retry after consecutive failures.
   */
  private scheduleBackgroundRetry(): void {
    if (this.retryTimer) {
      return; // Already scheduled
    }

    // Exponential backoff based on consecutive failures
    const delayMs = Math.min(
      RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, this.consecutiveFailures),
      5 * 60 * 1000, // Max 5 minutes
    );

    this.logger.info(`Scheduling background retry in ${Math.round(delayMs / 1000)}s`);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.isOnline && this.pendingDeltas.length > 0) {
        this.sync().catch((err) => {
          this.logger.warn("Background retry failed:", err);
        });
      }
    }, delayMs);
  }

  /**
   * Create a commit (intentional snapshot).
   */
  async commit(options: CommitOptions): Promise<Commit | null> {
    if (!this.isConfigured() || !this.vaultKey) {
      return null;
    }

    try {
      // Get current manifest
      const manifest = await this.getOrCreateManifest();

      // Collect delta IDs since last commit
      const deltaIds = await this.getDeltaIdsSinceCommit(manifest.headCommit);

      // Create commit
      const commit: Commit = {
        hash: "", // Will be set after hashing
        message: options.message,
        timestamp: Date.now(),
        parent: manifest.headCommit,
        version: this.documentManager.getVersionBytes(),
        deltaIds,
        deviceId: this.documentManager.getVaultId(), // Use vault ID as device ID for now
      };

      // Calculate commit hash
      commit.hash = await this.hashCommit(commit);

      // Upload commit
      const commitJson = JSON.stringify(commit, (_, value) => {
        if (value instanceof Uint8Array) {
          return { __uint8array: true, data: this.uint8ArrayToBase64(value) };
        }
        return value;
      });
      await this.client!.putObject(
        `${this.documentManager.getVaultId()}/commits/${commit.hash}.json`,
        new TextEncoder().encode(commitJson),
        "application/json",
      );

      // Update HEAD reference
      await this.client!.putObject(
        `${this.documentManager.getVaultId()}/refs/HEAD`,
        new TextEncoder().encode(commit.hash),
        "text/plain",
      );

      // Update manifest
      manifest.headCommit = commit.hash;
      manifest.updatedAt = Date.now();
      await this.updateManifest(manifest);

      this.state.headCommit = commit.hash;
      this.logger.info(`Created commit ${commit.hash.slice(0, 8)}: ${options.message}`);
      this.emit("commit:created", commit);

      // Push if requested
      if (options.push) {
        await this.sync();
      }

      return commit;
    } catch (error) {
      this.logger.error("Failed to create commit:", error);
      return null;
    }
  }

  /**
   * Restore to a specific commit.
   * Downloads all deltas up to that commit and rebuilds the document state.
   *
   * @param commitHash The commit hash to restore to
   * @param options Restore options
   * @returns Result of the restore operation
   */
  async restoreToCommit(
    commitHash: string,
    options: { createBackup?: boolean } = {},
  ): Promise<{ success: boolean; error?: string; backupCommit?: string }> {
    if (!this.isConfigured() || !this.vaultKey) {
      return { success: false, error: "Cloud sync not configured or vault key not set" };
    }

    try {
      // Get the target commit
      const targetCommit = await this.getCommit(commitHash);
      if (!targetCommit) {
        return { success: false, error: `Commit ${commitHash} not found` };
      }

      this.logger.info(`Restoring to commit ${commitHash.slice(0, 8)}: ${targetCommit.message}`);

      // Create a backup commit first if requested
      let backupCommit: string | undefined;
      if (options.createBackup !== false) {
        const backup = await this.commit({
          message: `Backup before restore to ${commitHash.slice(0, 8)}`,
        });
        if (backup) {
          backupCommit = backup.hash;
          this.logger.info(`Created backup commit: ${backup.hash.slice(0, 8)}`);
        }
      }

      // Get all commits from target to root (reverse order)
      const commitsToApply: Commit[] = [];
      let currentHash: string | null = commitHash;
      while (currentHash) {
        const commit = await this.getCommit(currentHash);
        if (!commit) break;
        commitsToApply.unshift(commit); // Add to front for chronological order
        currentHash = commit.parent;
      }

      // Collect all delta IDs we need to download
      const deltaIds = new Set<string>();
      for (const commit of commitsToApply) {
        for (const deltaId of commit.deltaIds) {
          deltaIds.add(deltaId);
        }
      }

      this.logger.debug(`Need to download ${deltaIds.size} deltas for restore`);

      // Download and decrypt all deltas
      const deltas: Array<{ id: string; data: Uint8Array }> = [];
      for (const deltaId of deltaIds) {
        const encrypted = await this.client!.getObject(
          `${this.documentManager.getVaultId()}/deltas/${deltaId}.enc`,
        );
        if (!encrypted) {
          this.logger.warn(`Delta ${deltaId} not found in cloud`);
          continue;
        }

        const decrypted = decrypt(encrypted, this.vaultKey!);
        if (!decrypted) {
          this.logger.warn(`Failed to decrypt delta ${deltaId}`);
          continue;
        }

        deltas.push({ id: deltaId, data: decrypted });
      }

      // Sort deltas by timestamp (extracted from delta ID)
      deltas.sort((a, b) => {
        const tsA = parseInt(a.id.split("-")[0]!, 10);
        const tsB = parseInt(b.id.split("-")[0]!, 10);
        return tsA - tsB;
      });

      // Apply deltas to document manager
      // Since we're restoring, we import all deltas which will merge with current state
      // The CRDT will handle conflicts automatically
      for (const delta of deltas) {
        try {
          this.documentManager.importUpdates(delta.data);
        } catch (err) {
          this.logger.warn(`Failed to apply delta ${delta.id}:`, err);
        }
      }

      // Update local head to target commit
      this.localHeadCommit = commitHash;

      this.logger.info(`Restored to commit ${commitHash.slice(0, 8)} (${deltas.length} deltas applied)`);

      return { success: true, backupCommit };
    } catch (error) {
      this.logger.error("Failed to restore:", error);
      return { success: false, error: this.formatError(error) };
    }
  }

  /**
   * Get details of a specific commit.
   */
  async getCommitDetails(commitHash: string): Promise<Commit | null> {
    return this.getCommit(commitHash);
  }

  /**
   * Get commit history.
   */
  async getCommitHistory(limit = 50): Promise<Commit[]> {
    if (!this.isConfigured()) {
      return [];
    }

    const commits: Commit[] = [];
    const manifest = await this.getManifest();
    if (!manifest || !manifest.headCommit) {
      return [];
    }

    let currentHash: string | null = manifest.headCommit;
    while (currentHash && commits.length < limit) {
      const commit = await this.getCommit(currentHash);
      if (!commit) break;
      commits.push(commit);
      currentHash = commit.parent;
    }

    return commits;
  }

  /**
   * Get storage usage statistics.
   */
  async getStorageStats(): Promise<{
    totalBytes: number;
    deltaCount: number;
    blobCount: number;
    commitCount: number;
  }> {
    if (!this.isConfigured() || !this.client) {
      return { totalBytes: 0, deltaCount: 0, blobCount: 0, commitCount: 0 };
    }

    const vaultId = this.documentManager.getVaultId();

    try {
      // Get stats for each category
      const [deltaStats, blobStats, commitStats] = await Promise.all([
        this.client.getStorageUsage(`${vaultId}/deltas/`),
        this.client.getStorageUsage(`${vaultId}/blobs/`),
        this.client.getStorageUsage(`${vaultId}/commits/`),
      ]);

      return {
        totalBytes: deltaStats.totalBytes + blobStats.totalBytes + commitStats.totalBytes,
        deltaCount: deltaStats.objectCount,
        blobCount: blobStats.objectCount,
        commitCount: commitStats.objectCount,
      };
    } catch (error) {
      this.logger.warn("Failed to get storage stats:", error);
      return { totalBytes: 0, deltaCount: 0, blobCount: 0, commitCount: 0 };
    }
  }

  /**
   * Get a specific commit.
   */
  private async getCommit(hash: string): Promise<Commit | null> {
    try {
      const data = await this.client!.getObject(
        `${this.documentManager.getVaultId()}/commits/${hash}.json`,
      );
      if (!data) return null;

      const json = new TextDecoder().decode(data);
      return JSON.parse(json, (_, value) => {
        if (value && typeof value === "object" && value.__uint8array) {
          return this.base64ToUint8Array(value.data);
        }
        return value;
      });
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private setStatus(status: CloudSyncStatus): void {
    if (this.state.status !== status) {
      this.state.status = status;
      if (status !== "error") {
        this.state.error = undefined;
      }
      this.emit("status:change", status);
    }
  }

  private async getOrCreateManifest(): Promise<VaultManifest> {
    const existing = await this.getManifest();
    if (existing) {
      return existing;
    }

    // Create new manifest
    const manifest: VaultManifest = {
      version: 1,
      vaultId: this.documentManager.getVaultId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      headCommit: null,
      latestDeltaId: null,
      keyFingerprint: await this.getKeyFingerprint(),
    };

    await this.updateManifest(manifest);
    return manifest;
  }

  private async getManifest(): Promise<VaultManifest | null> {
    try {
      const data = await this.client!.getObject(
        `${this.documentManager.getVaultId()}/manifest.json`,
      );
      if (!data) return null;

      const json = new TextDecoder().decode(data);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  private async updateManifest(manifest: VaultManifest): Promise<void> {
    // Increment sequence number for optimistic concurrency control
    manifest.sequence = (manifest.sequence || 0) + 1;
    manifest.updatedAt = Date.now();

    const json = JSON.stringify(manifest, null, 2);
    await this.client!.putObject(
      `${this.documentManager.getVaultId()}/manifest.json`,
      new TextEncoder().encode(json),
      "application/json",
    );
  }

  /**
   * Check if remote manifest has been updated since we last read it.
   * Returns true if we need to re-fetch and merge.
   */
  private async checkManifestConflict(localManifest: VaultManifest): Promise<boolean> {
    const remote = await this.getManifest();
    if (!remote) return false;

    // If remote has higher sequence, there's a conflict
    const localSeq = localManifest.sequence || 0;
    const remoteSeq = remote.sequence || 0;

    if (remoteSeq > localSeq) {
      this.logger.info(`Manifest conflict detected: local=${localSeq}, remote=${remoteSeq}`);
      return true;
    }

    return false;
  }

  /** Concurrent download/upload limit */
  private static readonly CONCURRENT_TRANSFERS = 4;

  private async downloadDeltas(manifest: VaultManifest, progress: SyncProgress): Promise<number> {
    // List deltas in cloud
    const prefix = `${this.documentManager.getVaultId()}/deltas/`;
    const result = await this.client!.listObjects(prefix);

    const toDownload = result.keys.filter((key) => {
      const deltaId = key.replace(prefix, "").replace(".enc", "");
      return !this.hasDelta(deltaId);
    });

    progress.total = toDownload.length;
    progress.completed = 0;
    this.emit("progress:sync", { ...progress });

    if (toDownload.length === 0) {
      return 0;
    }

    // Download in parallel batches
    let downloaded = 0;
    for (let i = 0; i < toDownload.length; i += CloudSync.CONCURRENT_TRANSFERS) {
      const batch = toDownload.slice(i, i + CloudSync.CONCURRENT_TRANSFERS);

      const results = await Promise.allSettled(
        batch.map(async (key) => {
          const deltaId = key.replace(prefix, "").replace(".enc", "");

          // Download and decrypt
          const startTime = Date.now();
          const encrypted = await this.client!.getObject(key);
          if (!encrypted) {
            return null;
          }

          // Emit transfer progress
          const transferProgress: TransferProgress = {
            id: deltaId,
            direction: "download",
            bytesTransferred: encrypted.length,
            bytesTotal: encrypted.length,
            rate: encrypted.length / ((Date.now() - startTime) / 1000 || 1),
          };
          this.emit("progress:transfer", transferProgress);

          // Decrypt delta
          const decrypted = decrypt(encrypted, this.vaultKey!);
          if (!decrypted) {
            this.logger.warn(`Failed to decrypt delta ${deltaId}`);
            return null;
          }

          // Apply to document
          this.documentManager.importUpdates(decrypted);
          return deltaId;
        }),
      );

      // Count successful downloads
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          downloaded++;
        }
        progress.completed++;
      }

      progress.currentItem = batch[batch.length - 1]?.replace(prefix, "").replace(".enc", "");
      this.emit("progress:sync", { ...progress });
    }

    this.state.pendingDownloads = 0;
    return downloaded;
  }

  private async uploadPendingDeltas(manifest: VaultManifest, progress: SyncProgress): Promise<number> {
    progress.total = this.pendingDeltas.length;
    progress.completed = 0;
    this.emit("progress:sync", { ...progress });

    let uploaded = 0;

    while (this.pendingDeltas.length > 0) {
      const delta = this.pendingDeltas[0]!;
      progress.currentItem = delta.id;

      // Encrypt delta
      const encrypted = encrypt(delta.data, this.vaultKey!);

      // Upload with progress tracking
      const startTime = Date.now();
      const key = `${this.documentManager.getVaultId()}/deltas/${delta.id}.enc`;
      await this.client!.putObject(key, encrypted);

      // Emit transfer progress
      const transferProgress: TransferProgress = {
        id: delta.id,
        direction: "upload",
        bytesTransferred: encrypted.length,
        bytesTotal: encrypted.length,
        rate: encrypted.length / ((Date.now() - startTime) / 1000 || 1),
      };
      this.emit("progress:transfer", transferProgress);

      // Update manifest
      manifest.latestDeltaId = delta.id;

      // Remove from pending
      this.pendingDeltas.shift();
      this.state.pendingUploads = this.pendingDeltas.length;
      uploaded++;

      progress.completed++;
      progress.bytesTransferred += encrypted.length;
      this.emit("progress:sync", { ...progress });

      this.logger.debug(`Uploaded delta ${delta.id}`);
    }

    await this.savePendingDeltas();
    return uploaded;
  }

  // ============================================================================
  // Blob Sync Methods
  // ============================================================================

  /**
   * Get or create the blob index from cloud.
   */
  private async getOrCreateBlobIndex(): Promise<BlobIndex> {
    const existing = await this.getBlobIndex();
    if (existing) return existing;

    const index: BlobIndex = {
      version: 1,
      vaultId: this.documentManager.getVaultId(),
      blobs: {},
      updatedAt: Date.now(),
    };

    await this.updateBlobIndex(index);
    return index;
  }

  /**
   * Get blob index from cloud.
   */
  private async getBlobIndex(): Promise<BlobIndex | null> {
    try {
      const data = await this.client!.getObject(
        `${this.documentManager.getVaultId()}/blobs/index.json`,
      );
      if (!data) return null;
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return null;
    }
  }

  /**
   * Update blob index in cloud.
   */
  private async updateBlobIndex(index: BlobIndex): Promise<void> {
    index.updatedAt = Date.now();
    const json = JSON.stringify(index, null, 2);
    await this.client!.putObject(
      `${this.documentManager.getVaultId()}/blobs/index.json`,
      new TextEncoder().encode(json),
      "application/json",
    );
  }

  /**
   * Download blobs that are missing locally.
   */
  private async downloadMissingBlobs(progress: SyncProgress): Promise<number> {
    if (!this.blobStore) return 0;

    // Get blob index from cloud
    const blobIndex = await this.getBlobIndex();
    if (!blobIndex) return 0;

    // Find blobs we need
    const cloudHashes = Object.keys(blobIndex.blobs);
    const missing = await this.blobStore.getMissing(cloudHashes);

    if (missing.length === 0) return 0;

    progress.total += missing.length;
    this.emit("progress:sync", { ...progress });

    let downloaded = 0;
    for (const hash of missing) {
      progress.currentItem = hash.slice(0, 8);

      try {
        const startTime = Date.now();
        const encrypted = await this.client!.getObject(
          `${this.documentManager.getVaultId()}/blobs/${hash}.enc`,
        );

        if (!encrypted) {
          progress.completed++;
          continue;
        }

        // Emit transfer progress
        const transferProgress: TransferProgress = {
          id: hash,
          direction: "download",
          bytesTransferred: encrypted.length,
          bytesTotal: encrypted.length,
          rate: encrypted.length / ((Date.now() - startTime) / 1000 || 1),
        };
        this.emit("progress:transfer", transferProgress);

        // Decrypt blob
        const decrypted = decrypt(encrypted, this.vaultKey!);
        if (!decrypted) {
          this.logger.warn(`Failed to decrypt blob ${hash.slice(0, 8)}`);
          progress.completed++;
          continue;
        }

        // Verify and add to blob store
        const meta = blobIndex.blobs[hash];
        const success = await this.blobStore.verifyAndAdd(
          decrypted,
          hash,
          meta?.mimeType || "application/octet-stream",
        );

        if (success) {
          downloaded++;
          progress.bytesTransferred += encrypted.length;
          this.logger.debug(`Downloaded blob ${hash.slice(0, 8)}`);
        } else {
          this.logger.warn(`Blob integrity check failed for ${hash.slice(0, 8)}`);
        }
      } catch (err) {
        this.logger.warn(`Failed to download blob ${hash.slice(0, 8)}:`, err);
      }

      progress.completed++;
      this.emit("progress:sync", { ...progress });
    }

    return downloaded;
  }

  /**
   * Upload local blobs that are not in cloud.
   */
  private async uploadLocalBlobs(progress: SyncProgress): Promise<number> {
    if (!this.blobStore) return 0;

    // Get local blobs
    const localHashes = await this.blobStore.list();
    if (localHashes.length === 0) return 0;

    // Get blob index from cloud
    const blobIndex = await this.getOrCreateBlobIndex();

    // Find blobs not in cloud
    const toUpload = localHashes.filter((hash) => !blobIndex.blobs[hash]);

    if (toUpload.length === 0) return 0;

    progress.total += toUpload.length;
    this.emit("progress:sync", { ...progress });

    let uploaded = 0;
    for (const hash of toUpload) {
      progress.currentItem = hash.slice(0, 8);

      try {
        // Get blob from local store
        const content = await this.blobStore.get(hash);
        if (!content) {
          progress.completed++;
          continue;
        }

        const meta = await this.blobStore.getMeta(hash);

        // Encrypt blob
        const encrypted = encrypt(content, this.vaultKey!);

        // Upload
        const startTime = Date.now();
        await this.client!.putObject(
          `${this.documentManager.getVaultId()}/blobs/${hash}.enc`,
          encrypted,
        );

        // Emit transfer progress
        const transferProgress: TransferProgress = {
          id: hash,
          direction: "upload",
          bytesTransferred: encrypted.length,
          bytesTotal: encrypted.length,
          rate: encrypted.length / ((Date.now() - startTime) / 1000 || 1),
        };
        this.emit("progress:transfer", transferProgress);

        // Update index
        blobIndex.blobs[hash] = {
          hash,
          size: encrypted.length,
          mimeType: meta?.mimeType || "application/octet-stream",
          uploadedAt: Date.now(),
        };

        uploaded++;
        progress.bytesTransferred += encrypted.length;
        progress.completed++;
        this.emit("progress:sync", { ...progress });

        this.logger.debug(`Uploaded blob ${hash.slice(0, 8)}`);
      } catch (err) {
        this.logger.warn(`Failed to upload blob ${hash.slice(0, 8)}:`, err);
        progress.completed++;
        this.emit("progress:sync", { ...progress });
      }
    }

    // Save updated index
    if (uploaded > 0) {
      await this.updateBlobIndex(blobIndex);
    }

    return uploaded;
  }

  // ============================================================================
  // Conflict Detection & Resolution
  // ============================================================================

  /**
   * Detect conflicts between local and remote state.
   */
  private async detectConflict(manifest: VaultManifest): Promise<CloudConflict | null> {
    const remoteHead = manifest.headCommit;

    // No remote commits - no conflict possible
    if (!remoteHead) return null;

    // No local head tracked - check if we have any local changes
    if (!this.localHeadCommit) {
      // First sync - just use remote as base
      this.localHeadCommit = remoteHead;
      return null;
    }

    // Same head - no conflict
    if (this.localHeadCommit === remoteHead) return null;

    // Different heads - find common ancestor
    const localHistory = await this.getCommitHistorySet(this.localHeadCommit);
    const remoteHistory = await this.getCommitHistorySet(remoteHead);

    // Check if one is ancestor of the other (fast-forward)
    if (localHistory.has(remoteHead)) {
      // Remote is ancestor of local - local is ahead, no conflict
      return null;
    }
    if (remoteHistory.has(this.localHeadCommit)) {
      // Local is ancestor of remote - fast-forward
      this.localHeadCommit = remoteHead;
      return null;
    }

    // Find common ancestor
    let commonAncestor: string | null = null;
    for (const hash of localHistory) {
      if (remoteHistory.has(hash)) {
        commonAncestor = hash;
        break;
      }
    }

    // Determine divergent commits
    const localOnly: string[] = [];
    const remoteOnly: string[] = [];

    for (const hash of localHistory) {
      if (!remoteHistory.has(hash) && hash !== this.localHeadCommit) {
        localOnly.push(hash);
      }
    }
    for (const hash of remoteHistory) {
      if (!localHistory.has(hash) && hash !== remoteHead) {
        remoteOnly.push(hash);
      }
    }

    return {
      localHead: this.localHeadCommit,
      remoteHead,
      commonAncestor,
      localOnly,
      remoteOnly,
    };
  }

  /**
   * Get set of commit hashes in history.
   */
  private async getCommitHistorySet(startHash: string): Promise<Set<string>> {
    const history = new Set<string>();
    let currentHash: string | null = startHash;

    while (currentHash && history.size < 100) { // Limit depth
      history.add(currentHash);
      const commit = await this.getCommit(currentHash);
      if (!commit) break;
      currentHash = commit.parent;
    }

    return history;
  }

  /**
   * Resolve a detected conflict.
   */
  private async resolveConflict(
    conflict: CloudConflict,
    manifest: VaultManifest,
  ): Promise<ConflictResolution | null> {
    this.logger.info(`Resolving conflict: local=${conflict.localHead.slice(0, 8)}, remote=${conflict.remoteHead.slice(0, 8)}`);

    switch (this.conflictStrategy) {
      case "merge":
        return this.resolveWithMerge(conflict, manifest);
      case "local":
        return this.resolveWithLocal(conflict, manifest);
      case "remote":
        return this.resolveWithRemote(conflict, manifest);
      case "manual":
        // Manual requires user interaction - return null to stop sync
        this.logger.warn("Manual conflict resolution required");
        return null;
    }
  }

  /**
   * Create a merge commit combining both histories.
   */
  private async resolveWithMerge(
    conflict: CloudConflict,
    manifest: VaultManifest,
  ): Promise<ConflictResolution> {
    // With CRDTs, we can merge automatically since Loro handles conflicts
    // We create a merge commit that includes both parent commits

    const mergeCommit: Commit = {
      hash: "",
      message: `Merge: ${conflict.localHead.slice(0, 8)} + ${conflict.remoteHead.slice(0, 8)}`,
      timestamp: Date.now(),
      parent: conflict.remoteHead, // Use remote as primary parent
      version: this.documentManager.getVersionBytes(),
      deltaIds: [], // Merge commit doesn't add new deltas
      deviceId: this.documentManager.getVaultId(),
    };

    // Calculate commit hash
    mergeCommit.hash = await this.hashCommit(mergeCommit);

    // Upload merge commit
    const commitJson = JSON.stringify(mergeCommit, (_, value) => {
      if (value instanceof Uint8Array) {
        return { __uint8array: true, data: this.uint8ArrayToBase64(value) };
      }
      return value;
    });
    await this.client!.putObject(
      `${this.documentManager.getVaultId()}/commits/${mergeCommit.hash}.json`,
      new TextEncoder().encode(commitJson),
      "application/json",
    );

    // Update HEAD
    await this.client!.putObject(
      `${this.documentManager.getVaultId()}/refs/HEAD`,
      new TextEncoder().encode(mergeCommit.hash),
      "text/plain",
    );

    // Update manifest and local state
    manifest.headCommit = mergeCommit.hash;
    this.localHeadCommit = mergeCommit.hash;

    this.logger.info(`Created merge commit: ${mergeCommit.hash.slice(0, 8)}`);

    return {
      strategy: "merge",
      newHead: mergeCommit.hash,
      changesLost: false,
    };
  }

  /**
   * Keep local changes, force push to remote.
   */
  private async resolveWithLocal(
    conflict: CloudConflict,
    manifest: VaultManifest,
  ): Promise<ConflictResolution> {
    // Create a new commit on top of local that supersedes remote
    const forceCommit: Commit = {
      hash: "",
      message: `Force local: overriding ${conflict.remoteHead.slice(0, 8)}`,
      timestamp: Date.now(),
      parent: conflict.localHead,
      version: this.documentManager.getVersionBytes(),
      deltaIds: [],
      deviceId: this.documentManager.getVaultId(),
    };

    forceCommit.hash = await this.hashCommit(forceCommit);

    // Upload
    const commitJson = JSON.stringify(forceCommit, (_, value) => {
      if (value instanceof Uint8Array) {
        return { __uint8array: true, data: this.uint8ArrayToBase64(value) };
      }
      return value;
    });
    await this.client!.putObject(
      `${this.documentManager.getVaultId()}/commits/${forceCommit.hash}.json`,
      new TextEncoder().encode(commitJson),
      "application/json",
    );

    // Update HEAD
    await this.client!.putObject(
      `${this.documentManager.getVaultId()}/refs/HEAD`,
      new TextEncoder().encode(forceCommit.hash),
      "text/plain",
    );

    manifest.headCommit = forceCommit.hash;
    this.localHeadCommit = forceCommit.hash;

    this.logger.warn(`Force pushed local changes, remote changes may be orphaned`);

    return {
      strategy: "local",
      newHead: forceCommit.hash,
      changesLost: true, // Remote changes are orphaned
    };
  }

  /**
   * Accept remote changes, discard local commits.
   */
  private async resolveWithRemote(
    conflict: CloudConflict,
    manifest: VaultManifest,
  ): Promise<ConflictResolution> {
    // Simply update local head to remote
    this.localHeadCommit = conflict.remoteHead;

    this.logger.warn(`Accepted remote changes, local commits orphaned`);

    return {
      strategy: "remote",
      newHead: conflict.remoteHead,
      changesLost: true, // Local changes are orphaned
    };
  }

  private async getDeltaIdsSinceCommit(commitHash: string | null): Promise<string[]> {
    if (!commitHash) {
      // No previous commit - include all deltas
      const prefix = `${this.documentManager.getVaultId()}/deltas/`;
      const result = await this.client!.listObjects(prefix);
      return result.keys.map((k) => k.replace(prefix, "").replace(".enc", ""));
    }

    const commit = await this.getCommit(commitHash);
    if (!commit) {
      return [];
    }

    // List deltas and filter by timestamp
    const prefix = `${this.documentManager.getVaultId()}/deltas/`;
    const result = await this.client!.listObjects(prefix);

    return result.keys
      .map((k) => k.replace(prefix, "").replace(".enc", ""))
      .filter((id) => {
        const timestamp = parseInt(id.split("-")[0]!, 10);
        return timestamp > commit.timestamp;
      });
  }

  private hasDelta(deltaId: string): boolean {
    // Check if we have this delta locally (either pending or already applied)
    return this.pendingDeltas.some((d) => d.id === deltaId);
  }

  private async savePendingDeltas(): Promise<void> {
    // Convert to JSON-serializable format
    const pending = this.pendingDeltas.map((d) => ({
      id: d.id,
      timestamp: d.timestamp,
      data: this.uint8ArrayToBase64(d.data),
      version: this.uint8ArrayToBase64(d.version),
    }));
    await this.storage.write(PENDING_DELTAS_KEY, new TextEncoder().encode(JSON.stringify(pending)));
  }

  private async hashData(data: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async hashCommit(commit: Commit): Promise<string> {
    const data = JSON.stringify({
      message: commit.message,
      timestamp: commit.timestamp,
      parent: commit.parent,
      version: this.uint8ArrayToBase64(commit.version),
      deltaIds: commit.deltaIds,
      deviceId: commit.deviceId,
    });
    return this.hashData(new TextEncoder().encode(data));
  }

  private async getKeyFingerprint(): Promise<string> {
    if (!this.vaultKey) return "";
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(this.vaultKey));
    return Array.from(new Uint8Array(hash).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Format an error into a user-friendly message.
   */
  private formatError(error: unknown): string {
    if (error instanceof S3Error) {
      // Provide helpful messages for common S3 errors
      switch (error.code) {
        case "AccessDenied":
          return "Access denied. Check your credentials and bucket permissions.";
        case "NoSuchBucket":
          return "Bucket not found. Verify the bucket name exists.";
        case "NoSuchKey":
          return "Object not found in cloud storage.";
        case "InvalidAccessKeyId":
          return "Invalid access key. Check your S3 credentials.";
        case "SignatureDoesNotMatch":
          return "Authentication failed. Verify your secret key is correct.";
        case "RequestTimeTooSkewed":
          return "Your device clock is out of sync. Please check your system time.";
        case "SlowDown":
        case "ServiceUnavailable":
          return "Cloud storage is temporarily unavailable. Please try again later.";
        case "InternalError":
          return "Cloud storage encountered an error. Please try again.";
        case "NetworkingError":
          return "Network connection failed. Check your internet connection.";
        default:
          // Include the code for unknown S3 errors
          return error.code
            ? `Cloud storage error (${error.code}): ${error.message}`
            : `Cloud storage error: ${error.message}`;
      }
    }

    if (error instanceof TypeError && error.message.includes("fetch")) {
      return "Network connection failed. Check your internet connection.";
    }

    if (error instanceof Error) {
      // Check for common error patterns
      if (error.message.includes("NetworkError") || error.message.includes("Failed to fetch")) {
        return "Network connection failed. Check your internet connection.";
      }
      if (error.message.includes("timeout") || error.message.includes("Timeout")) {
        return "Request timed out. Please try again.";
      }
      if (error.message.includes("CORS")) {
        return "Cross-origin request blocked. The cloud storage endpoint may not support browser requests.";
      }
      return error.message;
    }

    return String(error);
  }

  // ============================================================================
  // Backup & Export
  // ============================================================================

  /**
   * Export all cloud data as a backup.
   * Returns a JSON structure containing all deltas, blobs, and metadata.
   * The backup is encrypted with the vault key.
   */
  async exportBackup(): Promise<{
    success: boolean;
    data?: Uint8Array;
    error?: string;
    stats?: { deltas: number; blobs: number; commits: number; totalBytes: number };
  }> {
    if (!this.isConfigured() || !this.vaultKey) {
      return { success: false, error: "Cloud sync not configured or vault key not set" };
    }

    try {
      this.logger.info("Starting backup export...");
      const vaultId = this.documentManager.getVaultId();

      // Get manifest
      const manifest = await this.getManifest();
      if (!manifest) {
        return { success: false, error: "No cloud data found" };
      }

      // Collect all deltas
      const deltas: Array<{ id: string; data: string }> = [];
      let continuationToken: string | undefined;
      do {
        const result = await this.client!.listObjects(`${vaultId}/deltas/`, continuationToken);
        for (const key of result.keys) {
          const deltaId = key.replace(`${vaultId}/deltas/`, "").replace(".enc", "");
          const encrypted = await this.client!.getObject(key);
          if (encrypted) {
            // Store as base64 (already encrypted)
            deltas.push({ id: deltaId, data: this.uint8ArrayToBase64(encrypted) });
          }
        }
        continuationToken = result.isTruncated ? result.continuationToken : undefined;
      } while (continuationToken);

      // Collect all blobs
      const blobs: Array<{ hash: string; data: string }> = [];
      continuationToken = undefined;
      do {
        const result = await this.client!.listObjects(`${vaultId}/blobs/`, continuationToken);
        for (const key of result.keys) {
          if (key.endsWith(".enc")) {
            const hash = key.replace(`${vaultId}/blobs/`, "").replace(".enc", "");
            const encrypted = await this.client!.getObject(key);
            if (encrypted) {
              blobs.push({ hash, data: this.uint8ArrayToBase64(encrypted) });
            }
          }
        }
        continuationToken = result.isTruncated ? result.continuationToken : undefined;
      } while (continuationToken);

      // Collect all commits
      const commits: Array<{ hash: string; data: string }> = [];
      continuationToken = undefined;
      do {
        const result = await this.client!.listObjects(`${vaultId}/commits/`, continuationToken);
        for (const key of result.keys) {
          if (key.endsWith(".json")) {
            const data = await this.client!.getObject(key);
            if (data) {
              const hash = key.replace(`${vaultId}/commits/`, "").replace(".json", "");
              commits.push({ hash, data: this.uint8ArrayToBase64(data) });
            }
          }
        }
        continuationToken = result.isTruncated ? result.continuationToken : undefined;
      } while (continuationToken);

      // Get blob index
      const blobIndex = await this.getBlobIndex();

      // Create backup structure
      const backup = {
        version: 1,
        exportedAt: Date.now(),
        vaultId,
        manifest,
        deltas,
        blobs,
        commits,
        blobIndex,
      };

      // Serialize and encrypt the entire backup
      const backupJson = JSON.stringify(backup);
      const backupData = new TextEncoder().encode(backupJson);
      const encrypted = encrypt(backupData, this.vaultKey);

      // Add a header to identify PeerVault backups
      const header = new TextEncoder().encode("PEERVAULT_BACKUP_V1\n");
      const fullBackup = new Uint8Array(header.length + encrypted.length);
      fullBackup.set(header);
      fullBackup.set(encrypted, header.length);

      this.logger.info(`Backup exported: ${deltas.length} deltas, ${blobs.length} blobs, ${commits.length} commits`);

      return {
        success: true,
        data: fullBackup,
        stats: {
          deltas: deltas.length,
          blobs: blobs.length,
          commits: commits.length,
          totalBytes: fullBackup.length,
        },
      };
    } catch (error) {
      this.logger.error("Backup export failed:", error);
      return { success: false, error: this.formatError(error) };
    }
  }

  /**
   * Import a backup to cloud storage.
   * This will overwrite any existing cloud data.
   */
  async importBackup(
    backupData: Uint8Array,
    options: { merge?: boolean } = {},
  ): Promise<{ success: boolean; error?: string; stats?: { deltas: number; blobs: number; commits: number } }> {
    if (!this.isConfigured() || !this.vaultKey) {
      return { success: false, error: "Cloud sync not configured or vault key not set" };
    }

    try {
      // Check header
      const headerStr = new TextDecoder().decode(backupData.slice(0, 20));
      if (!headerStr.startsWith("PEERVAULT_BACKUP_V1")) {
        return { success: false, error: "Invalid backup file format" };
      }

      // Find the newline and extract encrypted data
      const newlineIdx = backupData.indexOf(10); // '\n'
      if (newlineIdx === -1) {
        return { success: false, error: "Invalid backup file format" };
      }

      const encrypted = backupData.slice(newlineIdx + 1);

      // Decrypt
      const decrypted = decrypt(encrypted, this.vaultKey);
      if (!decrypted) {
        return { success: false, error: "Failed to decrypt backup. Wrong encryption key?" };
      }

      // Parse JSON
      const backupJson = new TextDecoder().decode(decrypted);
      const backup = JSON.parse(backupJson);

      if (backup.version !== 1) {
        return { success: false, error: `Unsupported backup version: ${backup.version}` };
      }

      this.logger.info(`Importing backup: ${backup.deltas.length} deltas, ${backup.blobs.length} blobs, ${backup.commits.length} commits`);

      const vaultId = this.documentManager.getVaultId();

      // Upload deltas (already encrypted in backup)
      for (const delta of backup.deltas) {
        const data = this.base64ToUint8Array(delta.data);
        await this.client!.putObject(`${vaultId}/deltas/${delta.id}.enc`, data);
      }

      // Upload blobs (already encrypted in backup)
      for (const blob of backup.blobs) {
        const data = this.base64ToUint8Array(blob.data);
        await this.client!.putObject(`${vaultId}/blobs/${blob.hash}.enc`, data);
      }

      // Upload commits
      for (const commit of backup.commits) {
        const data = this.base64ToUint8Array(commit.data);
        await this.client!.putObject(`${vaultId}/commits/${commit.hash}.json`, data, "application/json");
      }

      // Upload blob index
      if (backup.blobIndex) {
        await this.updateBlobIndex(backup.blobIndex);
      }

      // Upload manifest (update vault ID to match current)
      const manifest = backup.manifest;
      manifest.vaultId = vaultId;
      manifest.sequence = (manifest.sequence || 0) + 1;
      await this.updateManifest(manifest);

      // Update local state
      this.localHeadCommit = manifest.headCommit;

      this.logger.info("Backup import completed");

      return {
        success: true,
        stats: {
          deltas: backup.deltas.length,
          blobs: backup.blobs.length,
          commits: backup.commits.length,
        },
      };
    } catch (error) {
      this.logger.error("Backup import failed:", error);
      return { success: false, error: this.formatError(error) };
    }
  }

  /**
   * Download current CRDT state from cloud.
   * Useful for restoring a fresh device from cloud backup.
   */
  async downloadFullState(): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured() || !this.vaultKey) {
      return { success: false, error: "Cloud sync not configured or vault key not set" };
    }

    try {
      this.logger.info("Downloading full state from cloud...");

      // Get manifest
      const manifest = await this.getManifest();
      if (!manifest) {
        return { success: false, error: "No cloud data found" };
      }

      // Download all deltas in order
      const vaultId = this.documentManager.getVaultId();
      const allDeltas: Array<{ id: string; data: Uint8Array }> = [];

      let continuationToken: string | undefined;
      do {
        const result = await this.client!.listObjects(`${vaultId}/deltas/`, continuationToken);
        for (const key of result.keys) {
          const deltaId = key.replace(`${vaultId}/deltas/`, "").replace(".enc", "");
          const encrypted = await this.client!.getObject(key);
          if (encrypted) {
            const decrypted = decrypt(encrypted, this.vaultKey!);
            if (decrypted) {
              allDeltas.push({ id: deltaId, data: decrypted });
            }
          }
        }
        continuationToken = result.isTruncated ? result.continuationToken : undefined;
      } while (continuationToken);

      // Sort by timestamp
      allDeltas.sort((a, b) => {
        const tsA = parseInt(a.id.split("-")[0]!, 10);
        const tsB = parseInt(b.id.split("-")[0]!, 10);
        return tsA - tsB;
      });

      // Apply all deltas
      this.logger.info(`Applying ${allDeltas.length} deltas from cloud...`);
      for (const delta of allDeltas) {
        try {
          this.documentManager.importUpdates(delta.data);
        } catch (err) {
          this.logger.warn(`Failed to apply delta ${delta.id}:`, err);
        }
      }

      // Update local head
      this.localHeadCommit = manifest.headCommit;

      this.logger.info("Full state download completed");
      return { success: true };
    } catch (error) {
      this.logger.error("Full state download failed:", error);
      return { success: false, error: this.formatError(error) };
    }
  }
}

/**
 * Create a CloudSync instance.
 */
export function createCloudSync(
  documentManager: DocumentManager,
  storage: StorageAdapter,
  logger: Logger,
): CloudSync {
  return new CloudSync(documentManager, storage, logger);
}
