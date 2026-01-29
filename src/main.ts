/**
 * PeerVault - P2P sync for Obsidian
 *
 * Main plugin entry point.
 */

import { Plugin, Notice } from "obsidian";
import { getDeviceHostname } from "./utils/device";
import type { PeerVaultSettings, SyncStatus, PeerInfo } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { DocumentManager, waitForLoroWasm } from "./core/document-manager";
import { ObsidianStorageAdapter } from "./core/storage-adapter";
import { EncryptedStorageAdapter } from "./core/encrypted-storage-adapter";
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
  SelectiveSyncModal,
  EncryptionModal,
  ConflictModal,
} from "./ui";
import { getEncryptionService } from "./crypto";
import {
  initConflictTracker,
  getConflictTracker,
} from "./core/conflict-tracker";
import {
  IrohTransport,
  initIrohWasm,
  type Transport,
  type TransportStorage,
} from "./transport";
import { PeerManager } from "./peer";
import { MigrationRunner, MIGRATIONS } from "./core/migration";
import { GarbageCollector } from "./core/gc";
import { ConfigErrors } from "./errors";

export default class PeerVaultPlugin extends Plugin {
  settings!: PeerVaultSettings;
  documentManager!: DocumentManager;
  storage!: EncryptedStorageAdapter;
  private baseStorage!: ObsidianStorageAdapter;
  blobStore!: BlobStore;
  vaultSync!: VaultSync;
  transport!: Transport;
  peerManager!: PeerManager;
  gc!: GarbageCollector;
  events = new EventEmitter();
  logger!: Logger;

  private connectionStatus: ConnectionStatusManager | null = null;
  private syncStatus: SyncStatus = "idle";

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

    // Initialize storage adapters
    this.baseStorage = new ObsidianStorageAdapter(this);

    // Wrap with encrypted storage adapter
    // The encryption service will be unlocked later via the UI if needed
    const encryptionService = getEncryptionService();
    this.storage = new EncryptedStorageAdapter(
      this.baseStorage,
      encryptionService,
    );

    // Run schema migrations if needed (uses encrypted storage)
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
        excludedFolders: this.settings.excludedFolders,
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

    // Initialize Iroh WASM module (bundled inline)
    this.logger.info("Initializing Iroh transport...");
    await initIrohWasm();
    this.transport = new IrohTransport(transportConfig);
    this.logger.info("Iroh transport initialized successfully");

    await this.transport.initialize();

    // Initialize peer manager with blob store for binary sync
    // Get hostname - uses os.hostname() on desktop, platform/model detection on mobile
    const hostname = getDeviceHostname();

    this.peerManager = new PeerManager(
      this.transport,
      this.documentManager,
      this.storage,
      this.logger,
      {
        autoSyncInterval: this.settings.syncInterval * 1000,
        autoReconnect: true,
        hostname,
        nickname: this.settings.deviceNickname,
      },
      this.blobStore,
    );

    await this.peerManager.initialize();

    // Connect peer manager events to plugin status
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
    });

    this.peerManager.on("peer:synced", async (nodeId) => {
      this.logger.info("Synced with peer:", nodeId);
      updateSyncProgress(null); // Clear progress

      // Update vault sync with peer exclusions
      this.updateVaultSyncPeerExclusions();

      // Get peer info for notification
      const peer = this.peerManager.getPeers().find((p) => p.nodeId === nodeId);
      const peerName = peer?.hostname
        ? (peer.nickname ? `${peer.hostname} (${peer.nickname})` : peer.hostname)
        : "Unknown Device";

      // Record edits for conflict tracking
      const tracker = getConflictTracker();
      const changedPaths = this.documentManager.listAllPaths();
      for (const path of changedPaths.slice(0, 50)) {
        // Limit for performance
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
                changedFiles: changedPaths.slice(0, 100), // Limit to 100 files
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
    });

    // Handle peer disconnection
    this.peerManager.on("peer:disconnected", ({ nodeId }) => {
      this.logger.info("Peer disconnected:", nodeId);
      // Update vault sync exclusions when a peer disconnects
      this.updateVaultSyncPeerExclusions();
    });

    // Handle peer errors
    this.peerManager.on("peer:error", ({ nodeId, error }) => {
      this.logger.error("Peer error:", nodeId, error);
      recordSyncError({
        message: error.message || String(error),
        peerId: nodeId,
        timestamp: Date.now(),
        retryable: true,
      });
    });

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

        // Save document state
        if (this.documentManager) {
          await this.documentManager.save();
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("peervault");
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

    // Selective sync command
    this.addCommand({
      id: "selective-sync",
      name: "Configure selective sync",
      callback: () => {
        new SelectiveSyncModal(this.app, this).open();
      },
    });

    // Encryption settings command
    this.addCommand({
      id: "encryption-settings",
      name: "Encryption settings",
      callback: () => {
        new EncryptionModal(this.app, this).open();
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
          new Notice(`PeerVault: GC failed - ${error}`);
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
      new Notice(`PeerVault: Sync failed - ${error}`);
    }
  }

  /**
   * Add a peer using a connection ticket.
   */
  async addPeer(ticket: string, name?: string): Promise<void> {
    if (!this.peerManager) {
      throw ConfigErrors.invalid("peerManager", "Peer manager not initialized");
    }

    await this.peerManager.addPeer(ticket, name);
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
   * Update vault sync with peer group exclusions.
   * Called when peer connections change or group policies are updated.
   */
  private updateVaultSyncPeerExclusions(): void {
    if (!this.peerManager || !this.vaultSync) {
      return;
    }

    const excludedFolders = this.peerManager.getConnectedPeersExcludedFolders();
    this.vaultSync.updatePeerExcludedFolders(excludedFolders);
  }
}
