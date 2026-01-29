/**
 * Settings Tab
 *
 * Plugin settings UI for PeerVault configuration.
 */

import { App, Platform, PluginSettingTab, Setting, Notice, Modal } from "obsidian";
import type PeerVaultPlugin from "../main";
import { getDeviceHostname, nodeIdToWords } from "../utils/device";
import { getConflictTracker } from "../core/conflict-tracker";
import { SelectiveSyncModal } from "./selective-sync-modal";
import { ConflictModal } from "./conflict-modal";
import { FileHistoryModal } from "./file-history-modal";
import { GroupModal } from "./group-modal";
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

  // Group expansion state
  private expandedGroups = new Set<string>();

  // Status section state
  private editingNickname = false;

  // Collapsible sections
  private expandedSections = new Set<string>(["sync"]); // sync expanded by default

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

    // Status Section
    this.renderStatusSection(containerEl);

    // Devices Section (includes groups)
    this.renderDevicesSection(containerEl);

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

  private renderStatusSection(container: HTMLElement): void {
    container.createEl("h3", { text: "Status" });

    // Get stats
    const peers = this.plugin.getConnectedPeers();
    const connectedCount = peers.filter(
      (p) => p.connectionState === "connected" || p.connectionState === "syncing",
    ).length;
    const fileCount = this.plugin.documentManager?.listAllPaths().length ?? 0;
    const hostname = getDeviceHostname();
    const autoNickname = nodeIdToWords(this.plugin.getNodeId());
    const nickname = this.plugin.settings.deviceNickname || autoNickname;

    // Line 1: Connection stats
    new Setting(container)
      .setName(`${connectedCount}/${peers.length} devices connected`)
      .setDesc(`${fileCount} files synced`)
      .addExtraButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Refresh")
          .onClick(() => this.display()),
      );

    // Line 2: This device identity
    if (this.editingNickname) {
      // Editing mode
      const currentNickname = this.plugin.settings.deviceNickname ?? "";
      let pendingNickname = currentNickname;

      new Setting(container)
        .setName("Edit nickname")
        .setDesc(`Auto-generated: "${autoNickname}"`)
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
            .setCta()
            .onClick(async () => {
              btn.setButtonText("Saving...");
              btn.setDisabled(true);

              this.plugin.settings.deviceNickname = pendingNickname || undefined;
              await this.plugin.saveSettings();

              const newNickname = pendingNickname || autoNickname;
              if (this.plugin.peerManager) {
                (this.plugin.peerManager as any).config.nickname = newNickname;
              }

              try {
                const peerManager = this.plugin.peerManager;
                if (peerManager) {
                  for (const peer of peerManager.getPeers()) {
                    const session = (peerManager as any).sessions.get(peer.nodeId);
                    if (session) await session.close();
                  }
                  await peerManager.syncAll();
                }
                new Notice("Nickname updated");
              } catch {
                new Notice("Nickname saved");
              }

              this.editingNickname = false;
              this.display();
            }),
        )
        .addButton((btn) =>
          btn.setButtonText("Cancel").onClick(() => {
            this.editingNickname = false;
            this.display();
          }),
        );
    } else {
      // Display mode
      new Setting(container)
        .setName(`This device: ${hostname}`)
        .setDesc(`Nickname: ${nickname}`)
        .addExtraButton((btn) =>
          btn
            .setIcon("pencil")
            .setTooltip("Edit nickname")
            .onClick(() => {
              this.editingNickname = true;
              this.display();
            }),
        );
    }

    // Conflicts (only if present)
    const tracker = getConflictTracker();
    const conflictCount = tracker.getConflictCount();
    if (conflictCount > 0) {
      new Setting(container)
        .setName("Concurrent edits")
        .setDesc(`${conflictCount} file(s) need review`)
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

    const groupManager = this.plugin.peerManager?.getGroupManager();
    const allPeers = this.plugin.peerManager?.getPeers() ?? [];

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

    // 2. Render groups with their devices
    if (groupManager) {
      const groups = groupManager.getGroups();

      for (const group of groups) {
        const isExpanded = this.expandedGroups.has(group.id);
        const peersInGroup = allPeers.filter((p) => group.peerIds.includes(p.nodeId));
        const isDefault = group.id === DEFAULT_GROUP_ID;

        // Group header (collapsible)
        const groupHeader = new Setting(container)
          .setName(`${group.icon} ${group.name}`)
          .setDesc(`${peersInGroup.length} device(s)`)
          .setClass("peervault-group-header")
          .addExtraButton((btn) =>
            btn
              .setIcon(isExpanded ? "chevron-up" : "chevron-down")
              .setTooltip(isExpanded ? "Collapse" : "Expand")
              .onClick(() => {
                if (isExpanded) {
                  this.expandedGroups.delete(group.id);
                } else {
                  this.expandedGroups.add(group.id);
                }
                this.display();
              }),
          );

        // If expanded, show devices and settings
        if (isExpanded) {
          const groupContent = container.createDiv({ cls: "peervault-group-content" });

          // Devices in this group
          if (peersInGroup.length === 0) {
            groupContent.createEl("p", {
              text: "No devices in this group",
              cls: "peervault-empty-state",
            });
          } else {
            for (const peer of peersInGroup) {
              this.renderDeviceInGroup(groupContent, peer, group, isDefault);
            }
          }

          // Inline group settings
          this.renderInlineGroupSettings(groupContent, group, isDefault);
        }
      }

      // 3. Create Group button
      new Setting(container)
        .addButton((btn) =>
          btn
            .setButtonText("+ Create Group")
            .onClick(() => {
              new GroupModal(this.app, this.plugin, undefined, () => {
                this.display();
              }).open();
            }),
        );
    }

    // 4. Add Device section (collapsible)
    container.createEl("div", { cls: "peervault-section-divider" });

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

    if (allPeers.length === 0 && pairingRequests.length === 0) {
      addDeviceHeader.setDesc("No devices paired yet. Expand to add one.");
    }

    if (this.showAddDevice) {
      this.renderAddDeviceSection(container);
    }
  }

  private renderDeviceInGroup(
    container: HTMLElement,
    peer: { nodeId: string; hostname?: string; nickname?: string; state: string },
    group: { id: string; peerIds: string[] },
    isDefaultGroup: boolean,
  ): void {
    const stateIcon = this.getStateIcon(peer.state as any);
    const displayName = peer.hostname
      ? (peer.nickname ? `${peer.hostname} (${peer.nickname})` : peer.hostname)
      : (peer.nickname || nodeIdToWords(peer.nodeId));

    const setting = new Setting(container)
      .setName(`${stateIcon} ${displayName}`)
      .setDesc(peer.nodeId.substring(0, 8) + "...")
      .setClass("peervault-device-item");

    // Remove from group button (not for default group)
    if (!isDefaultGroup) {
      setting.addExtraButton((btn) =>
        btn
          .setIcon("x")
          .setTooltip("Remove from group")
          .onClick(() => {
            this.plugin.peerManager?.getGroupManager()?.removePeerFromGroup(group.id, peer.nodeId);
            new Notice("Device removed from group");
            this.display();
          }),
      );
    }

    // Delete device button
    setting.addExtraButton((btn) =>
      btn
        .setIcon("trash")
        .setTooltip("Delete device")
        .onClick(async () => {
          const confirmed = await showConfirm(this.app, {
            title: "Remove Device",
            message: `Remove "${displayName}" from sync entirely?`,
            confirmText: "Remove",
            isDestructive: true,
          });
          if (confirmed) {
            await this.plugin.peerManager?.removePeer(peer.nodeId);
            new Notice("Device removed");
            this.display();
          }
        }),
    );
  }

  private renderInlineGroupSettings(
    container: HTMLElement,
    group: { id: string; name: string; syncPolicy: { readOnly: boolean; excludedFolders: string[]; autoConnect: boolean; priority: number } },
    isDefaultGroup: boolean,
  ): void {
    const settingsDiv = container.createDiv({ cls: "peervault-group-settings" });
    settingsDiv.createEl("div", { text: "Group Settings", cls: "peervault-settings-label" });

    // Excluded folders display
    const excludedCount = group.syncPolicy.excludedFolders.length;
    new Setting(settingsDiv)
      .setName("Excluded folders")
      .setDesc(excludedCount > 0 ? group.syncPolicy.excludedFolders.join(", ") : "None")
      .addExtraButton((btn) =>
        btn
          .setIcon("pencil")
          .setTooltip("Edit excluded folders")
          .onClick(() => {
            new GroupModal(this.app, this.plugin, group as any, () => {
              this.display();
            }).open();
          }),
      );

    // Read-only toggle
    new Setting(settingsDiv)
      .setName("Read-only")
      .setDesc("Devices can receive but not send changes")
      .addToggle((toggle) =>
        toggle.setValue(group.syncPolicy.readOnly).onChange((value) => {
          const groupManager = this.plugin.peerManager?.getGroupManager();
          if (groupManager) {
            groupManager.updateGroup(group.id, {
              syncPolicy: { ...group.syncPolicy, readOnly: value },
            });
            new Notice(value ? "Group set to read-only" : "Group set to read-write");
          }
        }),
      );

    // Delete group button (not for default)
    if (!isDefaultGroup) {
      new Setting(settingsDiv)
        .addButton((btn) =>
          btn
            .setButtonText("Delete Group")
            .setWarning()
            .onClick(async () => {
              const confirmed = await showConfirm(this.app, {
                title: "Delete Group",
                message: `Delete "${group.name}"? Devices will remain but won't be in this group.`,
                confirmText: "Delete",
                isDestructive: true,
              });
              if (confirmed) {
                this.plugin.peerManager?.getGroupManager()?.deleteGroup(group.id);
                this.expandedGroups.delete(group.id);
                new Notice("Group deleted");
                this.display();
              }
            }),
        );
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

    const isValidTicket = (ticket: string): boolean => {
      if (!ticket || ticket.length < 20) return false;
      // Standard iroh ticket format: endpoint<base32>
      // Base32 uses A-Z and 2-7, lowercase allowed
      return /^endpoint[a-z2-7]+$/i.test(ticket);
    };

    // Ticket input with validation
    const ticketInput = section.createEl("input", {
      cls: "peervault-ticket-input-compact",
      attr: {
        type: "text",
        placeholder: "Paste invite ticket...",
        spellcheck: "false",
      },
    });
    ticketInput.value = this.ticketInput;

    // Initial validation state
    if (this.ticketInput) {
      ticketInput.addClass(isValidTicket(this.ticketInput) ? "valid" : "invalid");
    }

    let connectBtn: HTMLButtonElement;

    const updateValidation = () => {
      const ticket = ticketInput.value.trim();
      this.ticketInput = ticket;
      ticketInput.removeClass("valid", "invalid");
      if (ticket) {
        ticketInput.addClass(isValidTicket(ticket) ? "valid" : "invalid");
      }
      connectBtn.disabled = !isValidTicket(ticket);
    };

    ticketInput.oninput = updateValidation;

    // Buttons: Paste + Connect
    new Setting(section)
      .addButton((btn) =>
        btn.setButtonText("Paste").onClick(async () => {
          try {
            const text = await navigator.clipboard.readText();
            ticketInput.value = text.trim();
            updateValidation();
          } catch {
            new Notice("Could not read clipboard");
          }
        }),
      )
      .addButton((btn) => {
        connectBtn = btn.buttonEl;
        btn
          .setButtonText("Connect")
          .setCta()
          .setDisabled(!isValidTicket(this.ticketInput))
          .onClick(async () => {
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
              updateValidation();
            }
          });
      });

    // Scan QR option
    section.createEl("div", { cls: "peervault-section-divider" });

    const scanSetting = new Setting(section)
      .setName("Scan QR Code")
      .setDesc(Platform.isDesktop ? "Use camera or upload an image" : "Upload an image containing a QR code");

    // Camera button (desktop only)
    if (Platform.isDesktop) {
      scanSetting.addButton((btn) =>
        btn.setButtonText("Use Camera").onClick(() => {
          this.openCameraScanner();
        }),
      );
    }

    // File picker button (all platforms)
    scanSetting.addButton((btn) =>
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

  private openCameraScanner(): void {
    const modal = new CameraScannerModal(this.app, (ticket) => {
      this.ticketInput = ticket;
      this.showAddDevice = true;
      this.display();
    });
    modal.open();
  }

  private renderSyncSection(container: HTMLElement): void {
    const isExpanded = this.expandedSections.has("sync");

    new Setting(container)
      .setName("Sync Settings")
      .setHeading()
      .addExtraButton((btn) =>
        btn
          .setIcon(isExpanded ? "chevron-up" : "chevron-down")
          .setTooltip(isExpanded ? "Collapse" : "Expand")
          .onClick(() => {
            if (isExpanded) this.expandedSections.delete("sync");
            else this.expandedSections.add("sync");
            this.display();
          }),
      );

    if (!isExpanded) return;

    new Setting(container)
      .setName("Sync now")
      .setDesc("Manually trigger a sync with all connected devices")
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
    const isExpanded = this.expandedSections.has("storage");

    new Setting(container)
      .setName("Storage & Maintenance")
      .setHeading()
      .addExtraButton((btn) =>
        btn
          .setIcon(isExpanded ? "chevron-up" : "chevron-down")
          .setTooltip(isExpanded ? "Collapse" : "Expand")
          .onClick(() => {
            if (isExpanded) this.expandedSections.delete("storage");
            else this.expandedSections.add("storage");
            this.display();
          }),
      );

    if (!isExpanded) return;

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
    const isExpanded = this.expandedSections.has("advanced");

    new Setting(container)
      .setName("Advanced")
      .setHeading()
      .addExtraButton((btn) =>
        btn
          .setIcon(isExpanded ? "chevron-up" : "chevron-down")
          .setTooltip(isExpanded ? "Collapse" : "Expand")
          .onClick(() => {
            if (isExpanded) this.expandedSections.delete("advanced");
            else this.expandedSections.add("advanced");
            this.display();
          }),
      );

    if (!isExpanded) return;

    // Node ID
    const nodeId = this.plugin.getNodeId();
    new Setting(container)
      .setName("Node ID")
      .setDesc(nodeId.substring(0, 20) + "...")
      .addExtraButton((btn) =>
        btn
          .setIcon("copy")
          .setTooltip("Copy")
          .onClick(() => {
            navigator.clipboard.writeText(nodeId);
            new Notice("Node ID copied");
          }),
      );

    // Vault ID
    const vaultId = this.plugin.documentManager?.getVaultId() ?? "Not initialized";
    new Setting(container)
      .setName("Vault ID")
      .setDesc(vaultId.substring(0, 20) + "...")
      .addExtraButton((btn) =>
        btn
          .setIcon("copy")
          .setTooltip("Copy")
          .onClick(() => {
            navigator.clipboard.writeText(vaultId);
            new Notice("Vault ID copied");
          }),
      );

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

/**
 * Modal for scanning QR codes using the device camera (desktop only).
 */
class CameraScannerModal extends Modal {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private scanInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    app: App,
    private onScan: (ticket: string) => void,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("peervault-camera-modal");

    contentEl.createEl("h2", { text: "Scan QR Code" });
    contentEl.createEl("p", {
      text: "Point your camera at a PeerVault QR code",
      cls: "peervault-camera-instructions",
    });

    // Video container
    const videoContainer = contentEl.createDiv({ cls: "peervault-camera-container" });

    // Create video element
    this.video = videoContainer.createEl("video", {
      cls: "peervault-camera-video",
      attr: { autoplay: "", playsinline: "" },
    });

    // Hidden canvas for frame capture
    this.canvas = document.createElement("canvas");

    // Status text
    const statusEl = contentEl.createEl("p", {
      text: "Starting camera...",
      cls: "peervault-camera-status",
    });

    // Close button
    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => this.close()),
    );

    // Start camera
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      statusEl.setText("Scanning for QR code...");

      // Start scanning
      this.startScanning();
    } catch (error) {
      statusEl.setText(`Camera error: ${error}`);
      statusEl.addClass("peervault-error-text");
    }
  }

  override onClose(): void {
    this.stopScanning();
    this.stopCamera();
    this.contentEl.empty();
  }

  private startScanning(): void {
    if (!this.video || !this.canvas) return;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    this.scanInterval = setInterval(async () => {
      if (!this.video || this.video.readyState !== this.video.HAVE_ENOUGH_DATA) {
        return;
      }

      // Set canvas size to video size
      this.canvas!.width = this.video.videoWidth;
      this.canvas!.height = this.video.videoHeight;

      // Draw video frame to canvas
      ctx.drawImage(this.video, 0, 0);

      // Get image data and scan for QR
      const imageData = ctx.getImageData(0, 0, this.canvas!.width, this.canvas!.height);

      try {
        const jsQR = (await import("jsqr")).default;
        const code = jsQR(imageData.data, imageData.width, imageData.height);

        if (code && code.data) {
          new Notice("QR code detected!");
          this.onScan(code.data);
          this.close();
        }
      } catch {
        // jsQR import failed, ignore
      }
    }, 200); // Scan every 200ms
  }

  private stopScanning(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }

  private stopCamera(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }
}
