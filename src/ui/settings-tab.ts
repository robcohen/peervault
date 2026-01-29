/**
 * Settings Tab
 *
 * Plugin settings UI for PeerVault configuration.
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type PeerVaultPlugin from "../main";
import { getDeviceHostname, nodeIdToWords } from "../utils/device";
import { getEncryptionService } from "../crypto";
import { getConflictTracker } from "../core/conflict-tracker";
import { EncryptionModal } from "./encryption-modal";
import { SelectiveSyncModal } from "./selective-sync-modal";
import { ConflictModal } from "./conflict-modal";
import { FileHistoryModal } from "./file-history-modal";
import { GroupModal, GroupPeersModal } from "./group-modal";
import { showConfirm } from "./confirm-modal";
import { STATUS_ICONS } from "./status-icons";
import { DEFAULT_GROUP_ID } from "../peer/groups";

export class PeerVaultSettingsTab extends PluginSettingTab {
  plugin: PeerVaultPlugin;
  private eventCleanup: (() => void)[] = [];
  private refreshTimeout?: number;

  // Pairing state
  private showMyQR = false;
  private showAddDevice = false;
  private myTicket = "";
  private ticketInput = "";

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    // Subscribe to peer events for auto-refresh
    this.subscribeToEvents();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("peervault-settings");

    containerEl.createEl("h2", { text: "PeerVault Settings" });

    // Quick Actions Section
    this.renderQuickActions(containerEl);

    // Status Section
    this.renderStatusSection(containerEl);

    // Devices Section
    this.renderDevicesSection(containerEl);

    // Peer Groups Section
    this.renderPeerGroupsSection(containerEl);

    // Security Section
    this.renderSecuritySection(containerEl);

    // Sync Section
    this.renderSyncSection(containerEl);

    // Storage & Maintenance Section
    this.renderStorageSection(containerEl);

    // Advanced Section
    this.renderAdvancedSection(containerEl);

    // Danger Zone
    this.renderDangerZone(containerEl);
  }

  override hide(): void {
    // Clear debounce timeout
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }

    // Unsubscribe from all events
    for (const cleanup of this.eventCleanup) {
      cleanup();
    }
    this.eventCleanup = [];
  }

  private subscribeToEvents(): void {
    // Clean up any existing subscriptions first
    for (const cleanup of this.eventCleanup) {
      cleanup();
    }
    this.eventCleanup = [];

    const peerManager = this.plugin.peerManager;
    if (!peerManager) return;

    // Refresh UI on these events
    const events = [
      "peer:connected",
      "peer:disconnected",
      "peer:pairing-request",
      "peer:pairing-accepted",
      "peer:pairing-denied",
      "peer:synced",
      "peer:sync-error",
    ] as const;

    const refresh = () => {
      // Debounce rapid events - only refresh once per 200ms
      if (this.refreshTimeout) {
        clearTimeout(this.refreshTimeout);
      }
      this.refreshTimeout = window.setTimeout(() => {
        this.display();
        this.refreshTimeout = undefined;
      }, 200);
    };

    for (const event of events) {
      peerManager.on(event, refresh);
      this.eventCleanup.push(() => peerManager.off(event, refresh));
    }
  }

  private renderQuickActions(container: HTMLElement): void {
    const section = container.createDiv({
      cls: "peervault-quick-actions-section",
    });

    new Setting(section)
      .setName("Quick Actions")
      .setDesc("Common tasks")
      .addButton((btn) =>
        btn
          .setButtonText("Sync Now")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.sync();
              new Notice("Sync completed");
            } catch (error) {
              new Notice(`Sync failed: ${error}`);
            }
          }),
      );
  }

  private renderStatusSection(container: HTMLElement): void {
    container.createEl("h3", { text: "Status" });

    // Connection status
    const status = this.plugin.getStatus();
    const peers = this.plugin.getConnectedPeers();
    const connectedCount = peers.filter(
      (p) =>
        p.connectionState === "connected" || p.connectionState === "syncing",
    ).length;

    new Setting(container)
      .setName("Connection")
      .setDesc(`${connectedCount} of ${peers.length} device(s) connected`)
      .addExtraButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Refresh")
          .onClick(() => this.display()),
      );

    // Node ID
    new Setting(container)
      .setName("Node ID")
      .setDesc("Your unique device identifier")
      .addText((text) => {
        const nodeId = this.plugin.getNodeId();
        text.setValue(nodeId.substring(0, 16) + "...");
        text.setDisabled(true);
        text.inputEl.style.fontFamily = "var(--font-monospace)";
        text.inputEl.style.fontSize = "12px";
      })
      .addExtraButton((btn) =>
        btn
          .setIcon("copy")
          .setTooltip("Copy full ID")
          .onClick(() => {
            navigator.clipboard.writeText(this.plugin.getNodeId());
            new Notice("Node ID copied");
          }),
      );

    // Device hostname (from system, not editable)
    const hostname = getDeviceHostname();
    new Setting(container)
      .setName("Hostname")
      .setDesc("Your device's system hostname (shared with peers)")
      .addText((text) => {
        text.setValue(hostname);
        text.setDisabled(true);
      });

    // Device nickname (user-defined, or auto-generated from node ID)
    const autoNickname = nodeIdToWords(this.plugin.getNodeId());
    const currentNickname = this.plugin.settings.deviceNickname ?? "";
    let pendingNickname = currentNickname;

    const nicknameSetting = new Setting(container)
      .setName("Device nickname")
      .setDesc(`Friendly name shown to peers. Auto-generated: "${autoNickname}"`)
      .addText((text) => {
        text
          .setPlaceholder(autoNickname)
          .setValue(currentNickname)
          .onChange((value) => {
            pendingNickname = value.trim();
          });
      })
      .addButton((btn) =>
        btn
          .setButtonText("Save")
          .onClick(async () => {
            btn.setButtonText("Saving...");
            btn.setDisabled(true);

            // Save the nickname
            this.plugin.settings.deviceNickname = pendingNickname || undefined;
            await this.plugin.saveSettings();

            // Update peer manager config
            const newNickname = pendingNickname || autoNickname;
            if (this.plugin.peerManager) {
              (this.plugin.peerManager as any).config.nickname = newNickname;
            }

            // Sync with peers to push the new nickname
            try {
              await this.plugin.peerManager?.syncAll();
              btn.setButtonText("✓ Saved");
              new Notice("Nickname updated and synced to peers");
            } catch {
              btn.setButtonText("✓ Saved");
              new Notice("Nickname saved (will sync on next connection)");
            }

            // Reset button after delay
            setTimeout(() => {
              btn.setButtonText("Save");
              btn.setDisabled(false);
            }, 2000);
          }),
      );

    // Vault ID
    new Setting(container)
      .setName("Vault ID")
      .setDesc("Shared identifier for this vault")
      .addText((text) => {
        const vaultId = this.plugin.documentManager?.getVaultId() ?? "Not initialized";
        text.setValue(vaultId.length > 8 ? vaultId.substring(0, 8) + "..." : vaultId);
        text.setDisabled(true);
        text.inputEl.style.fontFamily = "var(--font-monospace)";
        text.inputEl.style.fontSize = "12px";
      });

    // Files tracked
    const fileCount = this.plugin.documentManager?.listAllPaths().length ?? 0;
    new Setting(container)
      .setName("Files tracked")
      .setDesc(`${fileCount} file(s) in sync`);

    // Conflicts
    const tracker = getConflictTracker();
    const conflictCount = tracker.getConflictCount();
    if (conflictCount > 0) {
      new Setting(container)
        .setName("Concurrent edits")
        .setDesc(`${conflictCount} file(s) with recent concurrent edits`)
        .addButton((btn) =>
          btn
            .setButtonText("Review")
            .setWarning()
            .onClick(() => {
              new ConflictModal(this.app, this.plugin).open();
            }),
        );
    }
  }

  private renderDevicesSection(container: HTMLElement): void {
    container.createEl("h3", { text: "Devices" });

    // 1. Pending pairing requests (most important - show first)
    const pairingRequests = this.plugin.peerManager?.getPendingPairingRequests() ?? [];
    if (pairingRequests.length > 0) {
      const requestsSection = container.createDiv({ cls: "peervault-pairing-requests" });
      requestsSection.createEl("h4", { text: "Pairing Requests", cls: "peervault-subsection-header" });

      for (const request of pairingRequests) {
        const setting = new Setting(requestsSection)
          .setName(`Device ${request.nodeId.substring(0, 8)}...`)
          .setDesc("Wants to pair with this vault")
          .setClass("peervault-pairing-request-item");

        setting.addButton((btn) =>
          btn
            .setButtonText("Accept")
            .setCta()
            .onClick(async () => {
              try {
                await this.plugin.peerManager?.acceptPairingRequest(request.nodeId);
                new Notice("Device paired successfully!");
              } catch (error) {
                new Notice(`Failed to accept: ${error}`);
              }
            }),
        );

        setting.addButton((btn) =>
          btn.setButtonText("Deny").onClick(async () => {
            await this.plugin.peerManager?.denyPairingRequest(request.nodeId);
            new Notice("Pairing denied");
          }),
        );
      }
    }

    // 2. Connected devices
    const peers = this.plugin.getConnectedPeers();
    if (peers.length > 0) {
      for (const peer of peers) {
        const stateIcon = this.getStateIcon(peer.connectionState);
        const stateText =
          peer.connectionState.charAt(0).toUpperCase() +
          peer.connectionState.slice(1);

        const displayName = peer.hostname
          ? (peer.nickname ? `${peer.hostname} (${peer.nickname})` : peer.hostname)
          : (peer.nickname || nodeIdToWords(peer.nodeId));
        new Setting(container)
          .setName(`${stateIcon} ${displayName}`)
          .setDesc(`${stateText} • ${peer.nodeId.substring(0, 8)}...`)
          .addExtraButton((btn) =>
            btn
              .setIcon("trash")
              .setTooltip("Remove device")
              .onClick(async () => {
                const confirmed = await showConfirm(this.app, {
                  title: "Remove Device",
                  message: `Remove "${displayName}" from sync?`,
                  confirmText: "Remove",
                  isDestructive: true,
                });
                if (confirmed) {
                  await this.plugin.peerManager.removePeer(peer.nodeId);
                  new Notice("Device removed");
                  this.display();
                }
              }),
          );
      }
    }

    // 3. Add Device section (collapsible)
    const addDeviceHeader = new Setting(container)
      .setName("Add Device")
      .setDesc(this.showAddDevice ? "Pair a new device" : "Click to expand")
      .addExtraButton((btn) =>
        btn
          .setIcon(this.showAddDevice ? "chevron-up" : "chevron-down")
          .setTooltip(this.showAddDevice ? "Collapse" : "Expand")
          .onClick(() => {
            this.showAddDevice = !this.showAddDevice;
            this.display();
          }),
      );

    if (peers.length === 0 && pairingRequests.length === 0) {
      addDeviceHeader.setDesc("No devices paired yet. Expand to add one.");
    }

    if (this.showAddDevice) {
      this.renderAddDeviceSection(container);
    }
  }

  private renderAddDeviceSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-add-device-section" });

    // --- Show My Invite (for others to scan) ---
    const myInviteHeader = new Setting(section)
      .setName("My Invite Code")
      .setDesc(this.showMyQR ? "Others scan this to connect" : "Show QR code for other devices")
      .addExtraButton((btn) =>
        btn
          .setIcon(this.showMyQR ? "chevron-up" : "qr-code")
          .setTooltip(this.showMyQR ? "Hide" : "Show QR")
          .onClick(async () => {
            this.showMyQR = !this.showMyQR;
            if (this.showMyQR && !this.myTicket) {
              try {
                this.myTicket = await this.plugin.generateInvite();
              } catch (error) {
                new Notice(`Failed to generate invite: ${error}`);
                this.showMyQR = false;
              }
            }
            this.display();
          }),
      );

    if (this.showMyQR && this.myTicket) {
      const qrSection = section.createDiv({ cls: "peervault-qr-section" });

      // QR Code
      const qrContainer = qrSection.createDiv({ cls: "peervault-qr-container-small" });
      this.generateQRCode(qrContainer, this.myTicket);

      // Copy ticket button
      new Setting(qrSection)
        .addButton((btn) =>
          btn.setButtonText("Copy Ticket").onClick(() => {
            navigator.clipboard.writeText(this.myTicket);
            new Notice("Ticket copied!");
          }),
        );
    }

    // --- Connect to Another Device ---
    section.createEl("div", { cls: "peervault-section-divider" });

    new Setting(section)
      .setName("Connect to Device")
      .setDesc("Paste their invite ticket");

    // Ticket input
    const ticketSetting = new Setting(section);
    ticketSetting.controlEl.style.flexDirection = "column";
    ticketSetting.controlEl.style.alignItems = "stretch";

    const ticketInput = ticketSetting.controlEl.createEl("textarea", {
      cls: "peervault-ticket-input",
      attr: { placeholder: "Paste ticket here...", rows: "2" },
    });
    ticketInput.value = this.ticketInput;
    ticketInput.oninput = () => {
      this.ticketInput = ticketInput.value.trim();
    };

    // Connect button
    new Setting(section).addButton((btn) =>
      btn
        .setButtonText("Connect")
        .setCta()
        .onClick(async () => {
          if (!this.ticketInput) {
            new Notice("Please paste a ticket first");
            return;
          }
          try {
            btn.setButtonText("Connecting...");
            btn.setDisabled(true);
            await this.plugin.addPeer(this.ticketInput);
            new Notice("Device connected!");
            this.ticketInput = "";
            this.showAddDevice = false;
            this.display();
          } catch (error) {
            new Notice(`Connection failed: ${error}`);
            btn.setButtonText("Connect");
            btn.setDisabled(false);
          }
        }),
    );

    // Scan QR option
    section.createEl("div", { cls: "peervault-section-divider" });

    new Setting(section)
      .setName("Scan QR Code")
      .setDesc("Upload an image containing a QR code")
      .addButton((btn) =>
        btn.setButtonText("Choose Image").onClick(() => {
          this.openQRScanner();
        }),
      );
  }

  private async generateQRCode(container: HTMLElement, data: string): Promise<void> {
    try {
      const QRCode = await import("qrcode");
      const canvas = container.createEl("canvas", { cls: "peervault-qr-canvas-small" });

      const isDark = document.body.classList.contains("theme-dark");
      await QRCode.toCanvas(canvas, data, {
        width: 160,
        margin: 2,
        color: {
          dark: isDark ? "#ffffff" : "#000000",
          light: isDark ? "#1e1e1e" : "#ffffff",
        },
        errorCorrectionLevel: "M",
      });
    } catch (error) {
      container.createEl("p", {
        text: "QR code generation failed",
        cls: "peervault-error-text",
      });
    }
  }

  private openQRScanner(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        await this.processQRImage(file);
      }
    };
    input.click();
  }

  private async processQRImage(file: File): Promise<void> {
    try {
      const imageData = await this.loadImageData(file);
      const jsQR = (await import("jsqr")).default;
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code) {
        this.ticketInput = code.data;
        this.showAddDevice = true;
        new Notice("QR code detected!");
        this.display();
      } else {
        new Notice("No QR code found in image");
      }
    } catch (error) {
      new Notice(`Failed to process image: ${error}`);
    }
  }

  private async loadImageData(file: File): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not get canvas context"));
          return;
        }
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Failed to load image"));
      };
      img.src = objectUrl;
    });
  }

  private renderPeerGroupsSection(container: HTMLElement): void {
    container.createEl("h3", { text: "Device Groups" });

    const groupManager = this.plugin.peerManager?.getGroupManager();
    if (!groupManager) {
      new Setting(container)
        .setName("Groups unavailable")
        .setDesc("Peer manager not initialized");
      return;
    }

    const groups = groupManager.getGroups();

    // List existing groups
    for (const group of groups) {
      const isDefault = group.id === DEFAULT_GROUP_ID;
      const peerCount = group.peerIds.length;
      const excludedCount = group.syncPolicy.excludedFolders.length;

      let desc = `${peerCount} device(s)`;
      if (excludedCount > 0) {
        desc += ` • ${excludedCount} folder(s) excluded`;
      }
      if (group.syncPolicy.readOnly) {
        desc += " • Read-only";
      }

      const setting = new Setting(container)
        .setName(`${group.icon} ${group.name}`)
        .setDesc(desc);

      // Manage peers button
      setting.addExtraButton((btn) =>
        btn
          .setIcon("users")
          .setTooltip("Manage devices")
          .onClick(() => {
            new GroupPeersModal(this.app, this.plugin, group).open();
          }),
      );

      // Edit button
      setting.addExtraButton((btn) =>
        btn
          .setIcon("pencil")
          .setTooltip("Edit group")
          .onClick(() => {
            new GroupModal(this.app, this.plugin, group, () => {
              this.display();
            }).open();
          }),
      );

      // Delete button (not for default group)
      if (!isDefault) {
        setting.addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Delete group")
            .onClick(async () => {
              const confirmed = await showConfirm(this.app, {
                title: "Delete Group",
                message: `Delete group "${group.name}"?\n\nDevices will remain but won't be in this group.`,
                confirmText: "Delete",
                isDestructive: true,
              });
              if (confirmed) {
                try {
                  groupManager.deleteGroup(group.id);
                  new Notice(`Group "${group.name}" deleted`);
                  this.display();
                } catch (error) {
                  new Notice(`Failed to delete group: ${error}`);
                }
              }
            }),
        );
      }
    }

    // Create new group button
    new Setting(container).addButton((btn) =>
      btn.setButtonText("Create Group").onClick(() => {
        new GroupModal(this.app, this.plugin, undefined, () => {
          this.display();
        }).open();
      }),
    );

    // Help text
    container.createEl("p", {
      text: "Groups let you organize devices and apply different sync policies to each group.",
      cls: "peervault-help-text setting-item-description",
    });
  }

  private renderSecuritySection(container: HTMLElement): void {
    container.createEl("h3", { text: "Security" });

    const encryption = getEncryptionService();
    const isEnabled = this.plugin.settings.encryptionEnabled;
    const isUnlocked = encryption.isEnabled();

    let statusText: string;
    let statusClass: string;

    if (!isEnabled) {
      statusText = "Disabled";
      statusClass = "peervault-status-disabled";
    } else if (isUnlocked) {
      statusText = "Enabled & Unlocked";
      statusClass = "peervault-status-unlocked";
    } else {
      statusText = "Enabled (Locked)";
      statusClass = "peervault-status-locked";
    }

    new Setting(container)
      .setName("End-to-end encryption")
      .setDesc(`Status: ${statusText}`)
      .addButton((btn) =>
        btn.setButtonText(isEnabled ? "Manage" : "Enable").onClick(() => {
          new EncryptionModal(this.app, this.plugin).open();
        }),
      );

    if (isEnabled && !isUnlocked) {
      new Setting(container)
        .setClass("peervault-warning-setting")
        .setName("Encryption is locked")
        .setDesc("Enter your password to unlock encryption and sync securely")
        .addButton((btn) =>
          btn
            .setButtonText("Unlock")
            .setCta()
            .onClick(() => {
              new EncryptionModal(this.app, this.plugin).open();
            }),
        );
    }
  }

  private renderSyncSection(container: HTMLElement): void {
    container.createEl("h3", { text: "Sync Settings" });

    new Setting(container)
      .setName("Auto-sync")
      .setDesc("Automatically sync changes with connected devices")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(container)
      .setName("Sync interval")
      .setDesc("How often to sync (seconds, 0 = real-time)")
      .addSlider((slider) =>
        slider
          .setLimits(0, 300, 10)
          .setValue(this.plugin.settings.syncInterval)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(container)
      .setName("Selective sync")
      .setDesc("Choose which folders to sync")
      .addButton((btn) =>
        btn.setButtonText("Configure").onClick(() => {
          new SelectiveSyncModal(this.app, this.plugin).open();
        }),
      );

    // Show current exclusions summary
    const excluded = this.plugin.settings.excludedFolders;
    if (excluded.length > 0) {
      const summary =
        excluded.slice(0, 3).join(", ") +
        (excluded.length > 3 ? ` +${excluded.length - 3} more` : "");
      new Setting(container)
        .setName("Excluded folders")
        .setDesc(summary)
        .addExtraButton((btn) =>
          btn
            .setIcon("pencil")
            .setTooltip("Edit")
            .onClick(() => {
              new SelectiveSyncModal(this.app, this.plugin).open();
            }),
        );
    }

    new Setting(container)
      .setName("File history")
      .setDesc("View and restore previous versions of files")
      .addButton((btn) =>
        btn.setButtonText("Open").onClick(() => {
          new FileHistoryModal(this.app, this.plugin).open();
        }),
      );
  }

  private renderStorageSection(container: HTMLElement): void {
    container.createEl("h3", { text: "Storage & Maintenance" });

    // GC enabled toggle
    new Setting(container)
      .setName("Garbage collection")
      .setDesc("Automatically compact documents and clean up unused data")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.gcEnabled)
          .onChange(async (value) => {
            this.plugin.settings.gcEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    // Only show detailed settings if GC is enabled
    if (this.plugin.settings.gcEnabled) {
      // Max document size
      new Setting(container)
        .setName("Compact when larger than")
        .setDesc("Document size threshold for automatic compaction (MB)")
        .addSlider((slider) =>
          slider
            .setLimits(10, 200, 10)
            .setValue(this.plugin.settings.gcMaxDocSizeMB)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.gcMaxDocSizeMB = value;
              await this.plugin.saveSettings();
            }),
        );

      // Minimum history days
      new Setting(container)
        .setName("Preserve history for")
        .setDesc("Minimum days of edit history to keep")
        .addSlider((slider) =>
          slider
            .setLimits(7, 365, 7)
            .setValue(this.plugin.settings.gcMinHistoryDays)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.gcMinHistoryDays = value;
              await this.plugin.saveSettings();
            }),
        );

      // Peer consensus
      new Setting(container)
        .setName("Require peer sync before cleanup")
        .setDesc("Only clean up data that has been synced to other devices")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.gcRequirePeerConsensus)
            .onChange(async (value) => {
              this.plugin.settings.gcRequirePeerConsensus = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    // Manual GC button
    new Setting(container)
      .setName("Run maintenance now")
      .setDesc("Manually run garbage collection to free up space")
      .addButton((btn) =>
        btn.setButtonText("Run").onClick(async () => {
          if (!this.plugin.gc) {
            new Notice("Garbage collector not available");
            return;
          }

          btn.setButtonText("Running...");
          btn.setDisabled(true);

          try {
            const stats = await this.plugin.gc.run();
            const docSavedKB = Math.round(
              (stats.beforeSize - stats.afterSize) / 1024,
            );
            const blobSavedKB = Math.round(stats.blobBytesReclaimed / 1024);
            new Notice(
              `Maintenance complete:\n` +
                `• Document: saved ${docSavedKB} KB\n` +
                `• Blobs: cleaned ${stats.blobsRemoved} (${blobSavedKB} KB)`,
            );
          } catch (error) {
            this.plugin.logger.error("Manual GC failed:", error);
            new Notice(`Maintenance failed: ${error}`);
          } finally {
            btn.setButtonText("Run");
            btn.setDisabled(false);
          }
        }),
      );

    // Storage info
    if (this.plugin.documentManager) {
      const docSize = this.plugin.documentManager.getDocumentSize?.();
      if (docSize !== undefined) {
        const sizeKB = Math.round(docSize / 1024);
        const sizeMB = (docSize / (1024 * 1024)).toFixed(2);
        new Setting(container)
          .setName("Document size")
          .setDesc(`${sizeKB} KB (${sizeMB} MB)`);
      }
    }
  }

  private renderAdvancedSection(container: HTMLElement): void {
    container.createEl("h3", { text: "Advanced" });

    new Setting(container)
      .setName("Show status bar")
      .setDesc("Display sync status in the status bar")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showStatusBar)
          .onChange(async (value) => {
            this.plugin.settings.showStatusBar = value;
            await this.plugin.saveSettings();
            new Notice("Restart Obsidian to apply");
          }),
      );

    new Setting(container)
      .setName("Debug mode")
      .setDesc("Enable verbose logging for troubleshooting")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (value) => {
            this.plugin.settings.debugMode = value;
            await this.plugin.saveSettings();
          }),
      );

    // Copy logs for debugging
    new Setting(container)
      .setName("Copy debug logs")
      .setDesc("Copy recent logs to clipboard for troubleshooting")
      .addButton((btn) =>
        btn.setButtonText("Copy Logs").onClick(async () => {
          const { getRecentLogs } = await import("../utils/logger");
          const logs = getRecentLogs(200);
          if (logs) {
            await navigator.clipboard.writeText(logs);
            new Notice("Logs copied to clipboard!");
          } else {
            new Notice("No logs available");
          }
        }),
      );
  }

  private renderDangerZone(container: HTMLElement): void {
    container.createEl("h3", {
      text: "Danger Zone",
      cls: "peervault-danger-header",
    });

    new Setting(container)
      .setName("Reset sync data")
      .setDesc(
        "Delete all sync data and start fresh. Peers will need to re-pair.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            const confirmed = await showConfirm(this.app, {
              title: "Reset PeerVault",
              message:
                "Are you sure you want to reset all PeerVault data?\n\n" +
                "This will:\n" +
                "- Remove all paired devices\n" +
                "- Delete sync history\n" +
                "- Clear encryption keys\n\n" +
                "Your vault files will NOT be deleted.",
              confirmText: "Reset",
              isDestructive: true,
            });
            if (confirmed) {
              await this.resetPlugin();
            }
          }),
      );
  }

  private async resetPlugin(): Promise<void> {
    try {
      // Clear encryption
      const encryption = getEncryptionService();
      encryption.clearKey();

      // Clear settings
      this.plugin.settings.encryptionEnabled = false;
      this.plugin.settings.encryptedKey = undefined;
      this.plugin.settings.keySalt = undefined;

      // Remove all peers
      if (this.plugin.peerManager) {
        const peers = this.plugin.peerManager.getPeers();
        for (const peer of peers) {
          await this.plugin.peerManager.removePeer(peer.nodeId);
        }
      }

      // Save settings
      await this.plugin.saveSettings();

      // Clear stored data
      await this.plugin.storage.delete("peervault-peers");
      await this.plugin.storage.delete("peervault-snapshot");

      new Notice("PeerVault data has been reset. Please restart Obsidian.");
      this.display();
    } catch (error) {
      this.plugin.logger.error("Reset failed:", error);
      new Notice(`Reset failed: ${error}`);
    }
  }

  private getStateIcon(state: string): string {
    switch (state) {
      case "connected":
        return STATUS_ICONS.connected;
      case "syncing":
        return STATUS_ICONS.syncing;
      case "connecting":
        return STATUS_ICONS.syncing;
      case "error":
        return STATUS_ICONS.error;
      case "disconnected":
        return STATUS_ICONS.offline;
      default:
        return STATUS_ICONS.idle;
    }
  }
}
