/**
 * PeerVault - P2P Vault Sync for Obsidian
 *
 * Minimal plugin entry point. All sync logic is in Rust WASM.
 */

import { Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, TAbstractFile, debounce } from "obsidian";
import { PeerVaultClient, type ClientConfig, type ClientEvent, type PeerInfo } from "./core/peer-vault-client";

// =============================================================================
// Settings
// =============================================================================

interface PeerVaultSettings {
  deviceName: string;
  autoSync: boolean;
  autoSyncInterval: number; // minutes
  relayUrl: string; // Custom relay URL (empty = use default)
}

const DEFAULT_SETTINGS: PeerVaultSettings = {
  deviceName: "",
  autoSync: true,
  autoSyncInterval: 5,
  relayUrl: "",
};

/** Default relay URL shown in UI */
const DEFAULT_RELAY_URL = "https://use1-1.relay.n0.computer";

// =============================================================================
// Plugin
// =============================================================================

export default class PeerVaultPlugin extends Plugin {
  settings: PeerVaultSettings = DEFAULT_SETTINGS;
  client: PeerVaultClient | null = null;
  private autoSyncTimer: number | null = null;
  // Per-file debounce timers to handle rapid changes to different files
  private fileChangeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly FILE_CHANGE_DEBOUNCE_MS = 500;

  override async onload(): Promise<void> {
    await this.loadSettings();

    // Set device name if not set
    if (!this.settings.deviceName) {
      this.settings.deviceName = `Obsidian-${Math.random().toString(36).slice(2, 8)}`;
      await this.saveSettings();
    }

    // Add settings tab
    this.addSettingTab(new PeerVaultSettingTab(this.app, this));

    // Add commands
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncNow(),
    });

    this.addCommand({
      id: "copy-ticket",
      name: "Copy connection ticket",
      callback: () => this.copyTicket(),
    });

    this.addCommand({
      id: "add-peer",
      name: "Add peer from ticket",
      callback: () => this.promptAddPeer(),
    });

    // Initialize client
    await this.initializeClient();

    // Watch for file changes
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.scheduleFileSync(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          this.scheduleFileSync(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.onFileDelete(file);
        } else if (file instanceof TFolder) {
          this.onFolderDelete(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          this.onFileRename(file, oldPath);
        } else if (file instanceof TFolder) {
          this.onFolderRename(file, oldPath);
        }
      })
    );

    // Start auto-sync if enabled
    if (this.settings.autoSync && this.settings.autoSyncInterval > 0) {
      this.startAutoSync();
    }
  }

  override async onunload(): Promise<void> {
    this.stopAutoSync();
    if (this.client) {
      await this.client.shutdown();
      this.client = null;
    }
  }

  // ===========================================================================
  // Client Management
  // ===========================================================================

  private async initializeClient(): Promise<void> {
    try {
      // Generate vault ID from vault path
      const vaultId = await this.generateVaultId();

      const config: ClientConfig = {
        vaultId,
        deviceName: this.settings.deviceName,
        relayUrl: this.settings.relayUrl || undefined,
      };

      this.client = new PeerVaultClient(this.app, config);

      // Listen for events
      this.client.on((event) => this.handleClientEvent(event));

      await this.client.initialize();

      console.log(`[PeerVault] Initialized with node ID: ${this.client.nodeId}`);

      // Check if we need to do initial vault scan
      const existingFiles = await this.client.listFiles();
      if (existingFiles.length === 0) {
        console.log("[PeerVault] No synced files found, performing initial vault scan...");
        await this.scanVault();
      }
    } catch (e) {
      console.error("[PeerVault] Failed to initialize:", e);
      new Notice(`PeerVault: Failed to initialize - ${e}`);
    }
  }

  private async scanVault(): Promise<void> {
    if (!this.client?.isInitialized) return;

    const startTime = Date.now();
    let fileCount = 0;
    let errorCount = 0;

    // Get all files in vault
    const files = this.app.vault.getFiles();

    for (const file of files) {
      // Skip plugin data
      if (file.path.startsWith(".obsidian/")) continue;

      try {
        const content = await this.app.vault.readBinary(file);
        await this.client.setFile(file.path, new Uint8Array(content));
        fileCount++;
      } catch (e) {
        console.error(`[PeerVault] Failed to scan file: ${file.path}`, e);
        errorCount++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[PeerVault] Vault scan complete: ${fileCount} files in ${duration}ms (${errorCount} errors)`);

    if (fileCount > 0) {
      new Notice(`PeerVault: Synced ${fileCount} files from vault`);
    }
  }

  private handleClientEvent(event: ClientEvent): void {
    switch (event.type) {
      case "initialized":
        console.log(`[PeerVault] Initialized: ${event.nodeId}`);
        break;

      case "peer-connected":
        new Notice(`PeerVault: Connected to ${event.peerName}`);
        break;

      case "peer-disconnected":
        console.log(`[PeerVault] Disconnected from ${event.peerId}: ${event.reason}`);
        break;

      case "sync-started":
        console.log(`[PeerVault] Sync started with ${event.peerId}`);
        break;

      case "sync-complete":
        if (event.result.success) {
          new Notice(`PeerVault: Synced with ${event.peerId} (${event.result.updatesReceived} received, ${event.result.updatesSent} sent)`);
          // Apply all CRDT files to disk after sync
          if (event.result.updatesReceived > 0) {
            this.syncCrdtToDisk();
          }
        }
        break;

      case "sync-error":
        console.error(`[PeerVault] Sync error with ${event.peerId}: ${event.error}`);
        break;

      case "file-changed":
        if (event.source === "remote") {
          this.applyRemoteChange(event.path);
        }
        break;

      case "pairing-request":
        // For now, auto-accept known peers, show notice for unknown
        new Notice(`PeerVault: Connection request from ${event.peerName}. Add them as a peer to sync.`);
        break;

      case "error":
        console.error(`[PeerVault] Error: ${event.message}`);
        break;
    }
  }

  private async generateVaultId(): Promise<string> {
    // Use vault path to generate consistent ID
    const vaultPath = (this.app.vault.adapter as any).basePath || this.app.vault.getName();
    const encoder = new TextEncoder();
    const data = encoder.encode(vaultPath);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ===========================================================================
  // File Sync
  // ===========================================================================

  private scheduleFileSync(file: TFile): void {
    // Cancel any pending sync for this file
    const existing = this.fileChangeTimers.get(file.path);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule new sync with debounce
    const timer = setTimeout(() => {
      this.fileChangeTimers.delete(file.path);
      this.onFileChange(file);
    }, this.FILE_CHANGE_DEBOUNCE_MS);

    this.fileChangeTimers.set(file.path, timer);
  }

  private async onFileChange(file: TFile): Promise<void> {
    if (!this.client?.isInitialized) return;

    // Skip plugin data
    if (file.path.startsWith(".obsidian/")) return;

    try {
      const content = await this.app.vault.readBinary(file);
      await this.client.setFile(file.path, new Uint8Array(content));
    } catch (e) {
      console.error(`[PeerVault] Failed to sync file change: ${file.path}`, e);
    }
  }

  private async onFileDelete(file: TFile): Promise<void> {
    if (!this.client?.isInitialized) return;
    if (file.path.startsWith(".obsidian/")) return;

    try {
      await this.client.deleteFile(file.path);
    } catch (e) {
      console.error(`[PeerVault] Failed to sync file delete: ${file.path}`, e);
    }
  }

  private async onFileRename(file: TFile, oldPath: string): Promise<void> {
    if (!this.client?.isInitialized) return;

    // Skip plugin data
    const isOldPluginData = oldPath.startsWith(".obsidian/");
    const isNewPluginData = file.path.startsWith(".obsidian/");

    // If moved into .obsidian, delete from sync
    if (!isOldPluginData && isNewPluginData) {
      try {
        await this.client.deleteFile(oldPath);
      } catch (e) {
        console.error(`[PeerVault] Failed to sync file move to .obsidian: ${oldPath}`, e);
      }
      return;
    }

    // If moved out of .obsidian, treat as new file
    if (isOldPluginData && !isNewPluginData) {
      try {
        const content = await this.app.vault.readBinary(file);
        await this.client.setFile(file.path, new Uint8Array(content));
      } catch (e) {
        console.error(`[PeerVault] Failed to sync file move from .obsidian: ${file.path}`, e);
      }
      return;
    }

    // Skip if both in .obsidian
    if (isOldPluginData && isNewPluginData) return;

    // Normal rename: delete old, create new
    try {
      await this.client.deleteFile(oldPath);
      const content = await this.app.vault.readBinary(file);
      await this.client.setFile(file.path, new Uint8Array(content));
    } catch (e) {
      console.error(`[PeerVault] Failed to sync file rename: ${oldPath} -> ${file.path}`, e);
    }
  }

  private async onFolderDelete(folder: TFolder): Promise<void> {
    if (!this.client?.isInitialized) return;
    if (folder.path.startsWith(".obsidian/")) return;

    try {
      // Get all files with this folder prefix and delete them
      const prefix = folder.path + "/";
      const files = await this.client.listFiles(prefix);

      for (const filePath of files) {
        await this.client.deleteFile(filePath);
      }

      console.log(`[PeerVault] Deleted ${files.length} files from folder: ${folder.path}`);
    } catch (e) {
      console.error(`[PeerVault] Failed to sync folder delete: ${folder.path}`, e);
    }
  }

  private async onFolderRename(folder: TFolder, oldPath: string): Promise<void> {
    if (!this.client?.isInitialized) return;

    // Skip plugin data
    const isOldPluginData = oldPath.startsWith(".obsidian/");
    const isNewPluginData = folder.path.startsWith(".obsidian/");

    // If moved into .obsidian, delete all files from sync
    if (!isOldPluginData && isNewPluginData) {
      try {
        const prefix = oldPath + "/";
        const files = await this.client.listFiles(prefix);
        for (const filePath of files) {
          await this.client.deleteFile(filePath);
        }
      } catch (e) {
        console.error(`[PeerVault] Failed to sync folder move to .obsidian: ${oldPath}`, e);
      }
      return;
    }

    // If moved out of .obsidian, add all files to sync
    if (isOldPluginData && !isNewPluginData) {
      try {
        const files = this.getAllFilesInFolder(folder);
        for (const file of files) {
          const content = await this.app.vault.readBinary(file);
          await this.client.setFile(file.path, new Uint8Array(content));
        }
      } catch (e) {
        console.error(`[PeerVault] Failed to sync folder move from .obsidian: ${folder.path}`, e);
      }
      return;
    }

    // Skip if both in .obsidian
    if (isOldPluginData && isNewPluginData) return;

    // Normal rename: update all file paths
    try {
      const oldPrefix = oldPath + "/";
      const newPrefix = folder.path + "/";
      const files = await this.client.listFiles(oldPrefix);

      for (const oldFilePath of files) {
        const newFilePath = newPrefix + oldFilePath.slice(oldPrefix.length);
        const content = await this.client.getFile(oldFilePath);
        if (content) {
          await this.client.deleteFile(oldFilePath);
          await this.client.setFile(newFilePath, content);
        }
      }

      console.log(`[PeerVault] Renamed ${files.length} files in folder: ${oldPath} -> ${folder.path}`);
    } catch (e) {
      console.error(`[PeerVault] Failed to sync folder rename: ${oldPath} -> ${folder.path}`, e);
    }
  }

  private getAllFilesInFolder(folder: TFolder): TFile[] {
    const files: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) {
        files.push(child);
      } else if (child instanceof TFolder) {
        files.push(...this.getAllFilesInFolder(child));
      }
    }
    return files;
  }

  private async applyRemoteChange(path: string): Promise<void> {
    if (!this.client?.isInitialized) return;

    try {
      const content = await this.client.getFile(path);
      if (content) {
        // Ensure parent directory exists
        const dir = path.substring(0, path.lastIndexOf("/"));
        if (dir) {
          try {
            await this.app.vault.adapter.mkdir(dir);
          } catch {
            // Directory might already exist
          }
        }
        await this.app.vault.adapter.writeBinary(path, content.buffer as ArrayBuffer);
      } else {
        // File was deleted remotely
        try {
          await this.app.vault.adapter.remove(path);
        } catch {
          // May not exist locally
        }
      }
    } catch (e) {
      console.error(`[PeerVault] Failed to apply remote change: ${path}`, e);
    }
  }

  /**
   * Sync all CRDT files to disk.
   * Called after receiving updates to ensure all files are written.
   */
  private async syncCrdtToDisk(): Promise<void> {
    if (!this.client?.isInitialized) return;

    try {
      const crdtFiles = await this.client.listFiles();
      console.log(`[PeerVault] Syncing ${crdtFiles.length} CRDT files to disk`);

      for (const path of crdtFiles) {
        // Skip internal CRDT metadata
        if (path.startsWith("_crdt/")) continue;

        await this.applyRemoteChange(path);
      }
    } catch (e) {
      console.error("[PeerVault] Failed to sync CRDT to disk:", e);
    }
  }

  // ===========================================================================
  // Commands
  // ===========================================================================

  async syncNow(): Promise<void> {
    if (!this.client?.isInitialized) {
      new Notice("PeerVault: Not initialized");
      return;
    }

    new Notice("PeerVault: Syncing...");
    await this.client.syncAll();
  }

  async copyTicket(): Promise<void> {
    if (!this.client?.isInitialized) {
      new Notice("PeerVault: Not initialized");
      return;
    }

    try {
      // Use pairing ticket which includes transport + encryption key
      const ticket = await this.client.getPairingTicket();
      await navigator.clipboard.writeText(ticket);
      new Notice("PeerVault: Pairing ticket copied to clipboard");
    } catch (e) {
      new Notice(`PeerVault: Failed to copy ticket - ${e}`);
    }
  }

  async promptAddPeer(): Promise<void> {
    if (!this.client?.isInitialized) {
      new Notice("PeerVault: Not initialized");
      return;
    }

    // Use Obsidian's prompt (simple text input)
    const ticket = await this.promptForText("Paste peer ticket:");
    if (!ticket) return;

    try {
      const peerId = await this.client.addPeer(ticket.trim());
      new Notice(`PeerVault: Connected to peer ${peerId.slice(0, 8)}`);
    } catch (e) {
      new Notice(`PeerVault: Failed to add peer - ${e}`);
    }
  }

  promptForText(message: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new TextInputModal(this.app, message, resolve);
      modal.open();
    });
  }

  confirm(message: string, confirmText = "Confirm"): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, message, confirmText, resolve);
      modal.open();
    });
  }

  // ===========================================================================
  // Auto Sync
  // ===========================================================================

  private startAutoSync(): void {
    if (this.autoSyncTimer) return;

    const interval = this.settings.autoSyncInterval * 60 * 1000;
    this.autoSyncTimer = window.setInterval(() => {
      if (this.client?.isInitialized) {
        this.client.syncAll().catch((e) => {
          console.error("[PeerVault] Auto-sync error:", e);
        });
      }
    }, interval);
  }

  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
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
}

// =============================================================================
// Simple Text Input Modal
// =============================================================================

import { Modal, TextComponent } from "obsidian";

class TextInputModal extends Modal {
  private result: string = "";
  private onSubmit: (result: string | null) => void;
  private message: string;

  constructor(app: any, message: string, onSubmit: (result: string | null) => void) {
    super(app);
    this.message = message;
    this.onSubmit = onSubmit;
  }

  override onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("p", { text: this.message });

    const input = new TextComponent(contentEl);
    input.inputEl.style.width = "100%";
    input.onChange((value) => {
      this.result = value;
    });
    input.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.close();
        this.onSubmit(this.result);
      }
    });

    const buttonDiv = contentEl.createDiv({ cls: "modal-button-container" });
    buttonDiv.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.close();
      this.onSubmit(null);
    });
    buttonDiv.createEl("button", { text: "Add", cls: "mod-cta" }).addEventListener("click", () => {
      this.close();
      this.onSubmit(this.result);
    });

    input.inputEl.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// =============================================================================
// Confirm Modal
// =============================================================================

class ConfirmModal extends Modal {
  private onSubmit: (confirmed: boolean) => void;
  private message: string;
  private confirmText: string;

  constructor(app: any, message: string, confirmText: string, onSubmit: (confirmed: boolean) => void) {
    super(app);
    this.message = message;
    this.confirmText = confirmText;
    this.onSubmit = onSubmit;
  }

  override onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("p", { text: this.message });

    const buttonDiv = contentEl.createDiv({ cls: "modal-button-container" });
    buttonDiv.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.close();
      this.onSubmit(false);
    });
    buttonDiv.createEl("button", { text: this.confirmText, cls: "mod-warning" }).addEventListener("click", () => {
      this.close();
      this.onSubmit(true);
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// =============================================================================
// Settings Tab
// =============================================================================

class PeerVaultSettingTab extends PluginSettingTab {
  plugin: PeerVaultPlugin;
  private hasEncryptionKey = false;

  constructor(app: any, plugin: PeerVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    // Check encryption status
    this.hasEncryptionKey = (await this.plugin.client?.hasEncryptionKey()) ?? false;

    containerEl.createEl("h2", { text: "PeerVault Settings" });

    // Device name
    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Friendly name for this device")
      .addText((text) =>
        text
          .setPlaceholder("My Laptop")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value;
            await this.plugin.saveSettings();
          })
      );

    // Encryption section
    containerEl.createEl("h3", { text: "Encryption" });

    // Encryption status
    const statusSetting = new Setting(containerEl)
      .setName("Encryption key")
      .setDesc(this.hasEncryptionKey
        ? "✓ Vault is encrypted"
        : "⚠ No encryption key set - data will not be encrypted");

    if (!this.hasEncryptionKey) {
      // Generate key button
      statusSetting.addButton((btn) =>
        btn
          .setButtonText("Generate Key")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.client?.generateEncryptionKey();
              new Notice("PeerVault: Encryption key generated");
              this.display();
            } catch (e) {
              new Notice(`PeerVault: Failed to generate key - ${e}`);
            }
          })
      );
    }

    // Backup key button
    if (this.hasEncryptionKey) {
      new Setting(containerEl)
        .setName("Backup encryption key")
        .setDesc("Copy key to clipboard for safekeeping")
        .addButton((btn) =>
          btn.setButtonText("Copy Key").onClick(async () => {
            try {
              const key = await this.plugin.client?.getEncryptionKey();
              if (key) {
                await navigator.clipboard.writeText(key);
                new Notice("PeerVault: Encryption key copied to clipboard");
              }
            } catch (e) {
              new Notice(`PeerVault: Failed to copy key - ${e}`);
            }
          })
        );
    }

    // Set from passphrase
    new Setting(containerEl)
      .setName("Set key from passphrase")
      .setDesc("Derive encryption key from a memorable passphrase")
      .addButton((btn) =>
        btn.setButtonText("Set Passphrase").onClick(async () => {
          // Confirm if replacing existing key
          if (this.hasEncryptionKey) {
            const confirmed = await this.plugin.confirm(
              "This will replace your current encryption key. Make sure you have a backup! Continue?",
              "Replace Key"
            );
            if (!confirmed) return;
          }

          const passphrase = await this.plugin.promptForText("Enter passphrase (min 8 characters):");
          if (!passphrase) return;
          if (passphrase.length < 8) {
            new Notice("PeerVault: Passphrase must be at least 8 characters");
            return;
          }
          try {
            await this.plugin.client?.deriveEncryptionKey(passphrase);
            new Notice("PeerVault: Encryption key set from passphrase");
            this.display();
          } catch (e) {
            new Notice(`PeerVault: Failed to set key - ${e}`);
          }
        })
      );

    // Import raw key (advanced)
    new Setting(containerEl)
      .setName("Import raw key")
      .setDesc("Restore a previously backed up hex key (advanced)")
      .addButton((btn) =>
        btn.setButtonText("Import").onClick(async () => {
          // Confirm if replacing existing key
          if (this.hasEncryptionKey) {
            const confirmed = await this.plugin.confirm(
              "This will replace your current encryption key. Make sure you have a backup! Continue?",
              "Replace Key"
            );
            if (!confirmed) return;
          }

          const key = await this.plugin.promptForText("Paste encryption key (hex):");
          if (!key) return;
          try {
            await this.plugin.client?.setEncryptionKey(key.trim());
            new Notice("PeerVault: Encryption key imported");
            this.display();
          } catch (e) {
            new Notice(`PeerVault: Invalid key - ${e}`);
          }
        })
      );

    // Auto sync
    new Setting(containerEl)
      .setName("Auto sync")
      .setDesc("Automatically sync with peers")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        })
      );

    // Auto sync interval
    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Minutes between auto syncs")
      .addSlider((slider) =>
        slider
          .setLimits(1, 60, 1)
          .setValue(this.plugin.settings.autoSyncInterval)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.autoSyncInterval = value;
            await this.plugin.saveSettings();
          })
      );

    // Connection section
    containerEl.createEl("h3", { text: "Connection" });

    // Relay URL
    new Setting(containerEl)
      .setName("Relay server")
      .setDesc(`Custom relay URL (leave empty to use default: ${DEFAULT_RELAY_URL}). Requires plugin reload to take effect.`)
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_RELAY_URL)
          .setValue(this.plugin.settings.relayUrl)
          .onChange(async (value) => {
            this.plugin.settings.relayUrl = value;
            await this.plugin.saveSettings();
          })
      );

    // Node ID
    if (this.plugin.client?.nodeId) {
      new Setting(containerEl)
        .setName("Node ID")
        .setDesc(this.plugin.client.nodeId.slice(0, 16) + "...");
    }

    // Copy ticket button
    new Setting(containerEl)
      .setName("Share connection ticket")
      .setDesc("Copy ticket to share with other devices")
      .addButton((btn) =>
        btn.setButtonText("Copy Ticket").onClick(async () => {
          await this.plugin.copyTicket();
        })
      );

    // Add peer button
    new Setting(containerEl)
      .setName("Add peer")
      .setDesc("Connect to another device using their ticket")
      .addButton((btn) =>
        btn.setButtonText("Add Peer").onClick(async () => {
          await this.plugin.promptAddPeer();
        })
      );

    // Peers section
    containerEl.createEl("h3", { text: "Connected Peers" });

    const peers = this.plugin.client?.getPeers() ?? [];
    if (peers.length === 0) {
      containerEl.createEl("p", { text: "No peers connected", cls: "setting-item-description" });
    } else {
      for (const peer of peers) {
        new Setting(containerEl)
          .setName(peer.name)
          .setDesc(`${peer.isConnected ? "🟢 Connected" : "⚪ Disconnected"} • Last seen: ${new Date(peer.lastSeen).toLocaleString()}`)
          .addButton((btn) =>
            btn
              .setButtonText("Remove")
              .setWarning()
              .onClick(async () => {
                await this.plugin.client?.removePeer(peer.id);
                this.display(); // Refresh
              })
          );
      }
    }

    // Sync now button
    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Sync Now")
        .setCta()
        .onClick(async () => {
          await this.plugin.syncNow();
        })
    );
  }
}
