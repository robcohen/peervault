/**
 * PeerVault - P2P sync for Obsidian
 *
 * Main plugin entry point.
 */

import { Plugin, Notice } from "obsidian";
import { getDeviceHostname, nodeIdToWords } from "./utils/device";
import type { PeerVaultSettings, SyncStatus, PeerInfo } from "./types";
import { DEFAULT_SETTINGS, UI_LIMITS, migrateSettings } from "./types";
import { DocumentManager, waitForLoroWasm } from "./core/document-manager";
import { ObsidianStorageAdapter } from "./core/storage-adapter";
import { BlobStore } from "./core/blob-store";
import { VaultSync } from "./core/vault-sync";
import { EventEmitter } from "./utils/events";
import { Logger } from "./utils/logger";
import {
  PeerVaultSettingsTab,
  PeerVaultStatusModal,
  MergeHistoryModal,
  recordMerge,
  ConnectionStatusManager,
  recordSyncError,
  updateSyncProgress,
  FileHistoryModal,
  ConflictModal,
  showConfirm,
} from "./ui";
import {
  initConflictTracker,
  getConflictTracker,
} from "./core/conflict-tracker";
import { formatUserError } from "./utils/validation";
import {
  IrohTransport,
  HybridTransport,
  MockTransport,
  initIrohWasm,
  type Transport,
  type TransportStorage,
} from "./transport";
import { PeerManager } from "./peer";
import { MigrationRunner, MIGRATIONS } from "./core/migration";
import { GarbageCollector } from "./core/gc";
import { ConfigErrors } from "./errors";
import { protocolTracer } from "./utils/protocol-tracer";
import { VaultKeyManager, deriveDeviceSecret, PairingKeyExchange } from "./crypto";
import { CloudSync, createCloudSync } from "./cloud";

export default class PeerVaultPlugin extends Plugin {
  settings!: PeerVaultSettings;
  documentManager!: DocumentManager;
  storage!: ObsidianStorageAdapter;
  blobStore!: BlobStore;
  vaultSync!: VaultSync;
  transport!: Transport;
  peerManager!: PeerManager;
  gc!: GarbageCollector;
  events = new EventEmitter();
  logger!: Logger;
  private vaultKeyManager: VaultKeyManager | null = null;
  private pairingKeyExchange: PairingKeyExchange | null = null;
  private cloudSync: CloudSync | null = null;

  private connectionStatus: ConnectionStatusManager | null = null;
  private syncStatus: SyncStatus = "idle";
  private peerManagerUnsubscribes: Array<() => void> = [];

  override async onload(): Promise<void> {
    // Initialize logger
    this.logger = new Logger(
      "PeerVault",
      () => this.settings?.debugMode ?? false,
    );
    this.logger.info("Loading PeerVault plugin...");

    // Wait for loro-crdt WASM to initialize (required for mobile compatibility)
    // On mobile, WASM must be loaded asynchronously due to 4KB sync compilation limit
    this.logger.debug("Waiting for WASM initialization...");
    await waitForLoroWasm();
    this.logger.debug("WASM initialized");

    // Load settings
    await this.loadSettings();

    // Initialize protocol tracer
    protocolTracer.initialize(this.app);
    protocolTracer.setEnabled(this.settings.enableProtocolTracing);
    protocolTracer.setLevel(this.settings.protocolTraceLevel);
    // Expose for E2E tests
    (window as unknown as { __protocolTracer: typeof protocolTracer }).__protocolTracer = protocolTracer;

    // Debug: log trace to verify tracer is working
    protocolTracer.trace("", "", "plugin", "initialized", {
      tracingEnabled: this.settings.enableProtocolTracing,
      eventCount: (protocolTracer as unknown as { events: unknown[] }).events?.length,
    });

    // Initialize storage adapter
    this.storage = new ObsidianStorageAdapter(this);

    // Run schema migrations if needed
    const migrationRunner = new MigrationRunner(
      this.storage,
      MIGRATIONS,
      this.logger,
    );
    const migrationResult = await migrationRunner.run((percent, message) => {
      this.logger.debug(
        `Migration progress: ${percent.toFixed(0)}% - ${message}`,
      );
    });

    if (migrationResult.status === "failed") {
      this.logger.error("Migration failed:", migrationResult.error);
      new Notice(
        `PeerVault: Migration failed - ${migrationResult.error}. Please check the console for details.`,
      );
      // Continue loading anyway to allow manual recovery
    } else if (migrationResult.migrationsRun.length > 0) {
      this.logger.info(
        `Migrations completed: ${migrationResult.migrationsRun.join(", ")}`,
      );
    }

    // Initialize document manager
    this.documentManager = new DocumentManager(this.storage, this.logger);

    // Load or create document
    await this.documentManager.initialize();

    // Initialize blob store for binary files
    this.blobStore = new BlobStore(this.storage, this.logger);

    // Initialize conflict tracker
    initConflictTracker(this.logger);

    // Initialize vault sync service
    this.vaultSync = new VaultSync(
      this.app,
      this.documentManager,
      this.blobStore,
      this.logger,
      {
        maxFileSize: 100 * 1024 * 1024, // 100 MB
        debounceMs: 500,
      },
    );

    // Initialize transport based on settings
    const transportStorage: TransportStorage = {
      loadSecretKey: async () => {
        const data = await this.storage.read("peervault-transport-key");
        return data;
      },
      saveSecretKey: async (key: Uint8Array) => {
        await this.storage.write("peervault-transport-key", key);
      },
    };

    const transportConfig = {
      storage: transportStorage,
      logger: this.logger,
      debug: this.settings.debugMode,
      relayUrls:
        this.settings.relayServers.length > 0
          ? this.settings.relayServers
          : undefined,
    };

    // Create transport based on settings
    if (this.settings.transportType === "mock") {
      // Mock transport for testing - no WASM needed
      this.logger.info("Initializing Mock transport (for testing)...");
      this.transport = new MockTransport({
        ...transportConfig,
        crossWindow: true, // Enable cross-window registry for E2E tests
      });
    } else {
      // Initialize Iroh WASM module (bundled inline) - only needed for real transports
      await initIrohWasm();

      if (this.settings.transportType === "hybrid" && this.settings.enableWebRTC) {
        // Only use HybridTransport when WebRTC is actually enabled
        // HybridTransport wraps connections in HybridConnection which adds complexity
        // for stream detection and can cause race conditions
        this.logger.info("Initializing Hybrid transport (Iroh + WebRTC)...");
        this.transport = new HybridTransport({
          ...transportConfig,
          enableWebRTC: true,
          autoUpgradeToWebRTC: this.settings.autoWebRTCUpgrade,
          webrtcUpgradeTimeout: this.settings.webrtcUpgradeTimeout,
        });
      } else {
        // Use plain IrohTransport when WebRTC is disabled
        // This avoids the HybridConnection wrapper and its stream detection complexity
        this.logger.info("Initializing Iroh transport...");
        this.transport = new IrohTransport(transportConfig);
      }
    }
    this.logger.info("Transport initialized successfully");

    try {
      await this.transport.initialize();
    } catch (err) {
      // Check for WASM memory errors and show user-friendly message
      const errStr = String(err);
      if (errStr.includes("Out of memory") || errStr.includes("memory")) {
        new Notice(
          "PeerVault: Cannot start - WASM memory exhausted. " +
          "This can happen after reloading plugins multiple times. " +
          "Please restart Obsidian to free memory.",
          15000
        );
        this.logger.error("WASM memory exhausted - restart Obsidian to free memory:", err);
      }
      throw err;
    }

    // Initialize vault key manager and pairing key exchange for encryption
    // Uses the Iroh secret key to derive a device-specific secret
    const transportSecretKey = await this.getTransportSecretKey();
    if (transportSecretKey) {
      const deviceSecret = deriveDeviceSecret(transportSecretKey);
      this.vaultKeyManager = new VaultKeyManager(this.storage, deviceSecret);
      // Try to load the vault key into cache
      const existingKey = await this.vaultKeyManager.getKey();
      if (existingKey) {
        this.logger.debug("Vault key loaded from storage");
      } else {
        this.logger.debug("No existing vault key found");
      }

      // Create pairing key exchange handler for vault key sharing during pairing
      this.pairingKeyExchange = new PairingKeyExchange(this.storage, transportSecretKey);
      this.logger.debug("Pairing key exchange handler initialized");
    } else {
      this.logger.warn("Could not get transport secret key - vault key manager not initialized");
    }

    // Initialize peer manager with blob store for binary sync
    // Get hostname - uses os.hostname() on desktop, platform/model detection on mobile
    const hostname = getDeviceHostname();

    // Use user-defined nickname, or auto-generate from node ID (e.g., "bold-fox-rain")
    const nodeId = this.transport.getNodeId();
    const nickname = this.settings.deviceNickname || nodeIdToWords(nodeId);

    this.peerManager = new PeerManager(
      this.transport,
      this.documentManager,
      this.storage,
      this.logger,
      {
        autoSyncInterval: this.settings.syncInterval * 1000,
        autoReconnect: true,
        hostname,
        nickname,
        pluginVersion: this.manifest.version,
        enableWebRTC: this.settings.enableWebRTC,
      },
      this.blobStore,
    );

    await this.peerManager.initialize();

    // Set up pairing key exchange on peer manager for vault key sharing
    if (this.pairingKeyExchange) {
      this.peerManager.setPairingKeyExchange(this.pairingKeyExchange);
    }

    // Initialize cloud sync
    this.cloudSync = createCloudSync(this.documentManager, this.storage, this.logger);
    this.cloudSync.setBlobStore(this.blobStore);
    await this.cloudSync.initialize();

    // Set vault key for cloud encryption if available
    const hasVaultKeyManager = !!this.vaultKeyManager;
    const hasVaultKey = hasVaultKeyManager && await this.vaultKeyManager!.hasKey();
    this.logger.info(`Vault key check: manager=${hasVaultKeyManager}, hasKey=${hasVaultKey}`);

    const vaultKey = await this.vaultKeyManager?.getKey();
    if (vaultKey) {
      this.logger.info("Vault key loaded, setting on CloudSync");
      this.cloudSync.setVaultKey(vaultKey);
      // Re-check CRDT for cloud config now that we have the key to decrypt it
      // (initialize() couldn't decrypt it because vault key wasn't set yet)
      await this.cloudSync.checkForConfigUpdate();
    } else {
      this.logger.info("No vault key available - cloud config decryption will not work");
    }

    // Start auto-sync if enabled (check again after potential config update)
    if (this.settings.cloudAutoSync && this.cloudSync.isConfigured()) {
      const intervalMs = (this.settings.cloudAutoSyncInterval ?? 5) * 60 * 1000;
      this.cloudSync.startAutoSync(intervalMs);
    }

    // Listen for cloud config updates from peers
    this.cloudSync.on("config:updated", ({ source }) => {
      if (source === "peer") {
        new Notice("Cloud sync configured from another device");
        this.logger.info("Cloud sync auto-configured from peer");
        // Start auto-sync if enabled in settings
        if (this.settings.cloudAutoSync && this.cloudSync?.isConfigured()) {
          const intervalMs = (this.settings.cloudAutoSyncInterval ?? 5) * 60 * 1000;
          this.cloudSync.startAutoSync(intervalMs);
        }
      }
    });

    // Connect peer manager events to plugin status
    // Store unsubscribe functions for cleanup on plugin unload
    this.peerManagerUnsubscribes.push(
      this.peerManager.on("status:change", (status) => {
        if (status === "syncing") {
          this.setSyncStatus("syncing");
        } else if (status === "idle") {
          this.setSyncStatus("idle");
        } else if (status === "error") {
          this.setSyncStatus("error");
        } else if (status === "offline") {
          this.setSyncStatus("offline");
        }
      }),
    );

    this.peerManagerUnsubscribes.push(
      this.peerManager.on("peer:synced", async (nodeId) => {
      this.logger.info("Synced with peer:", nodeId);
      updateSyncProgress(null); // Clear progress

      // Get peer info for notification
      const peer = this.peerManager.getPeers().find((p) => p.nodeId === nodeId);
      const peerName = peer?.hostname
        ? (peer.nickname ? `${peer.hostname} (${peer.nickname})` : peer.hostname)
        : "Unknown Device";

      // Record edits for conflict tracking
      const tracker = getConflictTracker();
      const changedPaths = this.documentManager.listAllPaths();
      for (const path of changedPaths.slice(0, UI_LIMITS.maxTrackedChangedFiles)) {
        tracker.recordEdit(path, nodeId, peerName);
      }

      // Check if we need to sync files from document to vault
      // This happens when a new device joins and receives files from peers
      if (this.vaultSync.hasDocumentContent()) {
        this.logger.info("Document has content, syncing to vault...");
        updateSyncProgress({
          operation: "Writing files to vault",
          progress: 0,
        });
        try {
          const stats = await this.vaultSync.syncFromDocument();
          updateSyncProgress(null);

          // Record merge event
          if (stats.created > 0 || stats.updated > 0 || stats.failed > 0) {
            const changedPaths = this.documentManager.listAllPaths();
            recordMerge(
              {
                changedFiles: changedPaths.slice(0, UI_LIMITS.maxMergeNotificationFiles),
                peerName,
                peerId: nodeId,
                timestamp: Date.now(),
                filesCreated: stats.created,
                filesUpdated: stats.updated,
                filesDeleted: 0,
              },
              this.app,
            );
          }
        } catch (err) {
          this.logger.error("Failed to sync from document:", err);
          updateSyncProgress(null);
        }
      }

      // Save document after sync
      this.documentManager.save().catch((err) => {
        this.logger.error("Failed to save after sync:", err);
      });

      // Check if cloud config was received from peer
      if (this.cloudSync) {
        this.cloudSync.checkForConfigUpdate().catch((err) => {
          this.logger.debug("Failed to check cloud config update:", err);
        });
      }
    }),
    );

    // Handle peer disconnection
    this.peerManagerUnsubscribes.push(
      this.peerManager.on("peer:disconnected", ({ nodeId }) => {
        this.logger.info("Peer disconnected:", nodeId);
      }),
    );

    // Handle peer errors
    this.peerManagerUnsubscribes.push(
      this.peerManager.on("peer:error", ({ nodeId, error }) => {
        this.logger.error("Peer error:", nodeId, error);
        const errorMsg = error.message || String(error);

        // Show user-friendly notification for version mismatch
        if (errorMsg.includes("protocol v") || errorMsg.includes("upgrade")) {
          new Notice(errorMsg, 10000); // Show for 10 seconds
        }

        recordSyncError({
          message: errorMsg,
          peerId: nodeId,
          timestamp: Date.now(),
          retryable: !errorMsg.includes("protocol v"), // Version mismatch is not retryable
        });
      }),
    );

    // Handle vault key received from peer (during pairing)
    this.peerManagerUnsubscribes.push(
      this.peerManager.on("vault:key-received", (vaultKey) => {
        this.logger.info("Vault key received from peer, updating CloudSync");
        if (this.cloudSync) {
          this.cloudSync.setVaultKey(vaultKey);
          // Check if cloud config was synced from peer
          this.cloudSync.checkForConfigUpdate().catch((err) => {
            this.logger.debug("Failed to check cloud config after key received:", err);
          });
        }
      }),
    );

    // Handle blob received - retry syncing binary files that were missing blobs
    this.peerManagerUnsubscribes.push(
      this.peerManager.on("blob:received", async (hash) => {
        this.logger.debug("Blob received:", hash.slice(0, 16) + "...");
        // Trigger a sync from document to retry writing binary files
        // that were previously skipped due to missing blobs
        try {
          await this.vaultSync.syncFromDocument();
        } catch (err) {
          this.logger.error("Failed to sync after blob received:", err);
        }
      }),
    );

    // Handle live updates - track when updates are received for convergence detection
    // Note: We don't auto-reconcile here because syncFromDocument() can interfere
    // with incremental updates. Reconciliation happens on peer:synced (initial sync)
    // and when explicitly triggered by the user or tests.
    this.peerManagerUnsubscribes.push(
      this.peerManager.on("live:updates", () => {
        // Just log for debugging - reconciliation is handled by the event-based system
        this.logger.debug("Live updates received from peer");
      }),
    );

    // Handle vault adoption requests - show confirmation before adopting peer's vault ID
    this.peerManagerUnsubscribes.push(
      this.peerManager.on("vault:adoption-request", async ({ nodeId, peerVaultId, ourVaultId, respond }) => {
      const peer = this.peerManager.getPeers().find(p => p.nodeId === nodeId);
      const peerName = peer?.hostname || nodeId.slice(0, 8) + "...";

      this.logger.info(`Vault adoption request from ${peerName}: ${peerVaultId.slice(0, 8)}...`);

      const confirmed = await showConfirm(this.app, {
        title: "Join Sync Network?",
        message: `The peer "${peerName}" belongs to a different sync network.

To sync with this peer, this vault will join their sync network. This is required for the first connection between devices.

Your vault ID: ${ourVaultId.slice(0, 12)}...
Peer's network ID: ${peerVaultId.slice(0, 12)}...

Only accept if you trust this peer and want to sync with them.`,
        confirmText: "Join Network",
        cancelText: "Deny",
        isDestructive: false,
      });

      if (confirmed) {
        this.logger.info(`User accepted vault adoption from ${peerName}`);
      } else {
        this.logger.info(`User denied vault adoption from ${peerName}`);
      }

      respond(confirmed);
    }),
    );

    // Initialize garbage collector
    this.gc = new GarbageCollector(
      this.documentManager,
      this.blobStore,
      this.storage,
      this.logger,
      this.peerManager, // Provides getPeerSyncStates()
      {
        enabled: this.settings.gcEnabled,
        maxDocSizeMB: this.settings.gcMaxDocSizeMB,
        minHistoryDays: this.settings.gcMinHistoryDays,
        requirePeerConsensus: this.settings.gcRequirePeerConsensus,
      },
    );

    // Set up UI
    this.setupStatusBar();
    this.setupCommands();
    this.setupSettingsTab();

    // Set up file watcher
    this.setupFileWatcher();

    // Start vault sync service
    this.vaultSync.start();

    this.logger.info("PeerVault plugin loaded successfully");
    this.logger.info("Node ID:", this.transport.getNodeId());
  }

  override onunload(): void {
    this.logger.info("Unloading PeerVault plugin...");

    // Unsubscribe from peer manager events (synchronous, prevents listener accumulation)
    for (const unsubscribe of this.peerManagerUnsubscribes) {
      try {
        unsubscribe();
      } catch (err) {
        this.logger.debug("Error unsubscribing from peer manager:", err);
      }
    }
    this.peerManagerUnsubscribes = [];

    // Stop cloud sync auto-sync (synchronous)
    if (this.cloudSync) {
      this.cloudSync.stopAutoSync();
    }

    // Stop vault sync (synchronous)
    if (this.vaultSync) {
      this.vaultSync.stop();
    }

    // Clean up UI (synchronous)
    this.connectionStatus?.destroy();

    // Fire-and-forget async cleanup
    // Obsidian's onunload() is synchronous, so we can't await
    void (async () => {
      try {
        // Shut down peer manager
        if (this.peerManager) {
          await this.peerManager.shutdown();
        }

        // Shut down transport
        if (this.transport) {
          await this.transport.shutdown();
        }

        // Save and destroy document manager
        if (this.documentManager) {
          await this.documentManager.save();
          this.documentManager.destroy();
        }

        this.logger.info("PeerVault async cleanup complete");
      } catch (err) {
        this.logger.error("Error during async cleanup:", err);
      }
    })();

    this.logger.info("PeerVault plugin unloaded");
  }

  // ===========================================================================
  // Settings
  // ===========================================================================

  async loadSettings(): Promise<void> {
    const savedData = await this.loadData();
    const { settings, migrated } = migrateSettings(savedData || {});
    this.settings = settings;

    // Save migrated settings if migration occurred
    if (migrated) {
      this.logger?.info("Settings migrated to new version");
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ===========================================================================
  // UI Setup
  // ===========================================================================

  private setupStatusBar(): void {
    if (!this.settings.showStatusBar) return;

    // Use the new ConnectionStatusManager for real-time updates
    this.connectionStatus = new ConnectionStatusManager(this, this.app);
    this.connectionStatus.initialize();
  }

  private setSyncStatus(status: SyncStatus): void {
    this.syncStatus = status;
    this.connectionStatus?.update();
    this.events.emit("status:change", { status });
  }

  private setupCommands(): void {
    // Force sync command
    this.addCommand({
      id: "force-sync",
      name: "Force sync now",
      callback: async () => {
        await this.sync();
      },
    });

    // Device management command - opens settings
    this.addCommand({
      id: "pair-device",
      name: "Manage devices (add/remove)",
      callback: () => {
        // Open settings tab
        this.app.setting.open();
        this.app.setting.openTabById("peervault");
      },
    });

    // Show status command
    this.addCommand({
      id: "show-status",
      name: "Show sync status",
      callback: () => {
        new PeerVaultStatusModal(this.app, this).open();
      },
    });

    // Show sync history command
    this.addCommand({
      id: "show-sync-history",
      name: "Show sync history",
      callback: () => {
        new MergeHistoryModal(this.app).open();
      },
    });

    // Show file history command
    this.addCommand({
      id: "show-history",
      name: "Show file history",
      callback: () => {
        new FileHistoryModal(this.app, this).open();
      },
    });


    // View conflicts command
    this.addCommand({
      id: "view-conflicts",
      name: "View concurrent edits",
      callback: () => {
        new ConflictModal(this.app, this).open();
      },
    });

    // Run garbage collection command
    this.addCommand({
      id: "run-gc",
      name: "Run garbage collection",
      callback: async () => {
        new Notice("PeerVault: Running garbage collection...");
        try {
          const stats = await this.gc.run((percent, message) => {
            this.logger.debug(
              `GC progress: ${percent.toFixed(0)}% - ${message}`,
            );
          });
          const savedMB = (
            (stats.beforeSize - stats.afterSize) /
            (1024 * 1024)
          ).toFixed(2);
          new Notice(
            `PeerVault: GC complete - saved ${savedMB} MB, removed ${stats.blobsRemoved} orphaned blobs`,
          );
        } catch (error) {
          this.logger.error("GC failed:", error);
          new Notice(`PeerVault: GC failed - ${formatUserError(error)}`);
        }
      },
    });
  }

  private setupSettingsTab(): void {
    this.addSettingTab(new PeerVaultSettingsTab(this.app, this));
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  private setupFileWatcher(): void {
    // Watch for file changes - route through VaultSync for content syncing
    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        this.logger.debug("File created:", file.path);
        await this.vaultSync.handleFileCreate(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        this.logger.debug("File modified:", file.path);
        await this.vaultSync.handleFileModify(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        this.logger.debug("File deleted:", file.path);
        await this.vaultSync.handleFileDelete(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        this.logger.debug("File renamed:", oldPath, "->", file.path);
        await this.vaultSync.handleFileRename(file, oldPath);
      }),
    );
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get the current sync status.
   */
  getStatus(): SyncStatus {
    return this.syncStatus;
  }

  /**
   * Get connected peers.
   */
  getConnectedPeers(): PeerInfo[] {
    if (!this.peerManager) return [];

    // Convert peer manager PeerInfo to types.ts PeerInfo
    return this.peerManager.getPeers().map((p) => ({
      nodeId: p.nodeId,
      hostname: p.hostname,
      nickname: p.nickname,
      deviceType: "unknown" as const,
      lastSeen: p.lastSeen ?? p.firstSeen,
      connectionState:
        p.state === "synced"
          ? "connected"
          : p.state === "syncing"
            ? "syncing"
            : p.state === "connecting"
              ? "connecting"
              : p.state === "error"
                ? "error"
                : "disconnected",
    }));
  }

  /**
   * Manually trigger a sync.
   */
  async sync(): Promise<void> {
    if (!this.peerManager) {
      this.logger.warn("Peer manager not initialized");
      return;
    }

    this.setSyncStatus("syncing");
    new Notice("PeerVault: Syncing...");

    try {
      await this.peerManager.syncAll();
      this.setSyncStatus("idle");
      new Notice("PeerVault: Sync complete");
    } catch (error) {
      this.logger.error("Sync failed:", error);
      this.setSyncStatus("error");
      new Notice(`PeerVault: Sync failed - ${formatUserError(error)}`);
    }
  }

  /**
   * Add a peer using a connection ticket.
   */
  async addPeer(ticket: string): Promise<void> {
    if (!this.peerManager) {
      throw ConfigErrors.invalid("peerManager", "Peer manager not initialized");
    }

    await this.peerManager.addPeer(ticket);
  }

  /**
   * Generate a connection ticket for this device.
   */
  async generateInvite(): Promise<string> {
    if (!this.peerManager) {
      throw ConfigErrors.invalid("peerManager", "Peer manager not initialized");
    }

    return this.peerManager.generateInvite();
  }

  /**
   * Get this device's node ID.
   */
  getNodeId(): string {
    if (!this.transport) {
      return "Not initialized";
    }
    return this.transport.getNodeId();
  }

  /**
   * Get the transport's secret key.
   * Used to derive the device secret for vault key encryption.
   */
  private async getTransportSecretKey(): Promise<Uint8Array | null> {
    try {
      const key = await this.storage.read("peervault-transport-key");
      return key;
    } catch {
      return null;
    }
  }

  // ============================================================================
  // Vault Key Management
  // ============================================================================

  /**
   * Check if we have a vault encryption key.
   */
  hasVaultKey(): boolean {
    if (!this.vaultKeyManager) {
      return false;
    }
    // Note: This is a sync check that returns cached state
    // The actual async check happens during initialization
    return (this.vaultKeyManager as unknown as { cachedKey: Uint8Array | null }).cachedKey !== null;
  }

  /**
   * Get the vault encryption key.
   */
  async getVaultKey(): Promise<Uint8Array | null> {
    if (!this.vaultKeyManager) {
      return null;
    }
    return this.vaultKeyManager.getKey();
  }

  /**
   * Create a new vault encryption key.
   */
  async createVaultKey(): Promise<Uint8Array> {
    if (!this.vaultKeyManager) {
      throw new Error("Vault key manager not initialized");
    }
    return this.vaultKeyManager.generateAndStoreKey();
  }

  /**
   * Import a vault encryption key (e.g., from a passphrase backup).
   */
  async importVaultKey(key: Uint8Array): Promise<void> {
    if (!this.vaultKeyManager) {
      throw new Error("Vault key manager not initialized");
    }
    // Clear existing key first if present
    if (await this.vaultKeyManager.hasKey()) {
      await this.vaultKeyManager.clearKey();
    }
    await this.vaultKeyManager.storeKey(key);
  }

  /**
   * Get the VaultKeyManager instance.
   * Used by PairingKeyExchange for key sharing during pairing.
   */
  getVaultKeyManager(): VaultKeyManager | null {
    return this.vaultKeyManager;
  }

  /**
   * Get the CloudSync instance.
   * Used by settings UI for cloud storage configuration.
   */
  getCloudSync(): CloudSync | null {
    return this.cloudSync;
  }

  /**
   * Get connection info for a peer, including WebRTC status.
   * Used by E2E tests to verify transport upgrades.
   */
  getConnectionInfo(peerId: string): {
    connected: boolean;
    transportType: "iroh" | "hybrid";
    webrtcActive: boolean;
    webrtcDirect: boolean;
    rttMs?: number;
  } | null {
    if (!this.transport) return null;

    const conn = this.transport.getConnection(peerId);
    if (!conn) return null;

    // Check if this is a HybridConnection with WebRTC info
    const hybridConn = conn as {
      isWebRTCActive?: () => boolean;
      isDirectConnection?: () => boolean;
    };

    const isHybrid = typeof hybridConn.isWebRTCActive === "function";

    return {
      connected: conn.isConnected(),
      transportType: isHybrid ? "hybrid" : "iroh",
      webrtcActive: isHybrid ? hybridConn.isWebRTCActive!() : false,
      webrtcDirect: isHybrid ? hybridConn.isDirectConnection!() : false,
      rttMs: conn.getRttMs(),
    };
  }

  /**
   * Check if WebRTC is available in this environment.
   */
  isWebRTCAvailable(): boolean {
    return typeof RTCPeerConnection !== "undefined";
  }

  /**
   * Get recent plugin logs (for debugging).
   * Filters to only include WebRTC/Hybrid related logs.
   */
  getRecentLogs(count: number = 50): string[] {
    // Import dynamically to avoid circular deps
    const { getLogsAsJson } = require("./utils/logger");
    const logs = getLogsAsJson(count * 2) as Array<{
      timestamp: string;
      level: string;
      prefix: string;
      message: string;
    }>;

    return logs
      .filter((log) => {
        const fullMsg = `${log.prefix} ${log.message}`;
        return (
          fullMsg.includes("Hybrid") ||
          fullMsg.includes("WebRTC") ||
          fullMsg.includes("webrtc") ||
          fullMsg.includes("upgrade")
        );
      })
      .slice(-count)
      .map((log) => `[${log.level}] ${log.prefix} ${log.message}`);
  }

  /**
   * Force attempt WebRTC upgrade for a peer.
   * Returns debug info about the attempt.
   */
  async forceWebRTCUpgrade(peerId: string): Promise<{
    attempted: boolean;
    success: boolean;
    error?: string;
    debugInfo: string[];
  }> {
    const debugInfo: string[] = [];

    if (!this.transport) {
      return { attempted: false, success: false, error: "No transport", debugInfo };
    }

    const conn = this.transport.getConnection(peerId);
    if (!conn) {
      return { attempted: false, success: false, error: "No connection for peer", debugInfo };
    }

    // Check if this is a HybridConnection
    const hybridConn = conn as {
      isWebRTCActive?: () => boolean;
      attemptWebRTCUpgrade?: (isInitiator: boolean) => Promise<boolean>;
    };

    if (!hybridConn.attemptWebRTCUpgrade) {
      return { attempted: false, success: false, error: "Not a hybrid connection", debugInfo };
    }

    if (hybridConn.isWebRTCActive?.()) {
      debugInfo.push("WebRTC already active");
      return { attempted: false, success: true, debugInfo };
    }

    // Determine if we should be initiator
    const myNodeId = this.transport.getNodeId();
    const shouldInitiate = myNodeId < peerId;
    debugInfo.push(`myNodeId: ${myNodeId.slice(0, 8)}, peerId: ${peerId.slice(0, 8)}`);
    debugInfo.push(`shouldInitiate: ${shouldInitiate}`);

    try {
      debugInfo.push("Attempting WebRTC upgrade...");
      debugInfo.push(`WebRTC enabled in conn: ${(hybridConn as any).webrtcEnabled}`);
      debugInfo.push(`Iroh connected: ${(hybridConn as any).irohConn?.isConnected?.()}`);
      const success = await hybridConn.attemptWebRTCUpgrade(shouldInitiate);
      debugInfo.push(`Result: ${success}`);

      // Get internal debug info from the connection
      const connDebug = (hybridConn as any).lastAttemptDebug as string[] | undefined;
      if (connDebug) {
        debugInfo.push("--- Connection internal debug ---");
        for (const line of connDebug) {
          debugInfo.push(`  ${line}`);
        }
      }

      // After attempt, check connection state
      const isActive = hybridConn.isWebRTCActive?.() ?? false;
      debugInfo.push(`WebRTC active after attempt: ${isActive}`);

      return { attempted: true, success, debugInfo };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      debugInfo.push(`Error: ${errMsg}`);
      return { attempted: true, success: false, error: errMsg, debugInfo };
    }
  }
}
