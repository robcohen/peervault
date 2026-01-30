/**
 * Settings Tab
 *
 * Plugin settings UI for PeerVault configuration.
 */

import { App, Platform, PluginSettingTab, Setting, Notice, Modal } from "obsidian";
import type PeerVaultPlugin from "../main";
import { nodeIdToWords } from "../utils/device";
import { GroupModal } from "./group-modal";
import { showConfirm } from "./confirm-modal";
import { STATUS_ICONS } from "./status-icons";
import { DEFAULT_GROUP_ID, type PeerGroup } from "../peer/groups";
import { formatUserError } from "../utils/validation";
import {
  generateQRCode,
  openQRFilePicker,
} from "./utils/qr-utils";
import {
  renderStatusSection,
  resetStatusSectionState,
  renderSyncSection,
  renderStorageSection,
  renderAdvancedSection,
  renderDangerZone,
  type SectionContext,
} from "./settings";

export class PeerVaultSettingsTab extends PluginSettingTab {
  plugin: PeerVaultPlugin;
  private eventCleanup: (() => void)[] = [];
  private refreshTimeout?: number;

  // Pairing state
  private showMyQR = false;
  private showAddDevice = false;
  private myTicket = "";
  private ticketInput = "";

  // Group expansion state (All Devices expanded by default)
  private expandedGroups = new Set<string>(["all-devices"]);

  // Drag and drop state
  private draggedPeerId: string | null = null;

  // Collapsible sections (all start collapsed)
  private expandedSections = new Set<string>();

  /** Context for section renderers */
  private getSectionContext(): SectionContext {
    return {
      app: this.app,
      plugin: this.plugin,
      refresh: () => this.display(),
      expandedSections: this.expandedSections,
    };
  }

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

    const ctx = this.getSectionContext();

    // Status Section
    renderStatusSection(containerEl, ctx);

    // Devices Section (includes groups) - kept inline due to complexity
    this.renderDevicesSection(containerEl);

    // Sync Section
    renderSyncSection(containerEl, ctx);

    // Storage & Maintenance Section
    renderStorageSection(containerEl, ctx);

    // Advanced Section
    renderAdvancedSection(containerEl, ctx);

    // Danger Zone
    renderDangerZone(containerEl, ctx);
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

    // Reset section states
    resetStatusSectionState();
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

  private renderDevicesSection(container: HTMLElement): void {
    container.createEl("h3", { text: "Devices" });

    const groupManager = this.plugin.peerManager?.getGroupManager();
    const allPeers = this.plugin.peerManager?.getPeers() ?? [];
    const userGroups = (groupManager?.getGroups() ?? []).filter((g) => g.id !== DEFAULT_GROUP_ID);

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
                new Notice(`Failed to accept: ${formatUserError(error)}`);
              }
            }),
        );

        setting.addButton((btn) =>
          btn.setButtonText("Deny").onClick(async () => {
            try {
              await this.plugin.peerManager?.denyPairingRequest(request.nodeId);
              new Notice("Pairing denied");
            } catch (error) {
              new Notice(`Failed to deny: ${formatUserError(error)}`);
            }
          }),
        );
      }
    }

    // 2. All Devices section (master list - every device always here)
    const allDevicesExpanded = this.expandedGroups.has("all-devices");
    new Setting(container)
      .setName("All Devices")
      .setDesc(`${allPeers.length} device(s)`)
      .setClass("peervault-group-header")
      .addExtraButton((btn) =>
        btn
          .setIcon(allDevicesExpanded ? "chevron-up" : "chevron-down")
          .setTooltip(allDevicesExpanded ? "Collapse" : "Expand")
          .onClick(() => {
            if (allDevicesExpanded) {
              this.expandedGroups.delete("all-devices");
            } else {
              this.expandedGroups.add("all-devices");
            }
            this.display();
          }),
      );

    if (allDevicesExpanded) {
      const allDevicesContent = container.createDiv({ cls: "peervault-group-content" });

      if (allPeers.length === 0) {
        allDevicesContent.createEl("p", {
          text: "No devices paired yet",
          cls: "peervault-empty-state",
        });
      } else {
        for (const peer of allPeers) {
          this.renderDevice(allDevicesContent, peer, {
            draggable: true,
            showDragHint: userGroups.length > 0,
          });
        }
      }
    }

    // 3. User-created groups (not the default group)
    if (groupManager && userGroups.length > 0) {
      for (const group of userGroups) {
        const isExpanded = this.expandedGroups.has(group.id);
        const peersInGroup = allPeers.filter((p) => group.peerIds.includes(p.nodeId));

        // Group header (collapsible + drop target)
        const groupSetting = new Setting(container)
          .setName(`${group.icon} ${group.name}`)
          .setDesc(`${peersInGroup.length} device(s) • Drop to add`)
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

        // Make group header a drop target
        const groupEl = groupSetting.settingEl;
        groupEl.addClass("peervault-drop-target");

        groupEl.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (this.draggedPeerId && !group.peerIds.includes(this.draggedPeerId)) {
            groupEl.addClass("peervault-drag-over");
            if (e.dataTransfer) {
              e.dataTransfer.dropEffect = "move";
            }
          }
        });

        groupEl.addEventListener("dragleave", () => {
          groupEl.removeClass("peervault-drag-over");
        });

        groupEl.addEventListener("drop", (e) => {
          e.preventDefault();
          groupEl.removeClass("peervault-drag-over");
          if (this.draggedPeerId && !group.peerIds.includes(this.draggedPeerId)) {
            this.plugin.peerManager?.getGroupManager()?.addPeerToGroup(group.id, this.draggedPeerId);
            new Notice(`Added to ${group.name}`);
            this.draggedPeerId = null;
            this.display();
          }
        });

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
              this.renderDevice(groupContent, peer, { group, isDefaultGroup: false });
            }
          }

          // Inline group settings
          this.renderInlineGroupSettings(groupContent, group, false);
        }
      }
    }

    // 4. Create Group button
    if (groupManager) {
      new Setting(container).addButton((btn) =>
        btn.setButtonText("+ Create Group").onClick(() => {
          new GroupModal(this.app, this.plugin, undefined, () => {
            this.display();
          }).open();
        }),
      );
    }

    // 5. Add Device section (collapsible)
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

  /**
   * Unified device rendering for both All Devices and Group contexts.
   */
  private renderDevice(
    container: HTMLElement,
    peer: { nodeId: string; hostname?: string; nickname?: string; state: string },
    options: {
      /** Enable drag-and-drop (for All Devices section) */
      draggable?: boolean;
      /** Show "Drag to group" hint in description */
      showDragHint?: boolean;
      /** Group context (if rendering in a group) */
      group?: { id: string; peerIds: string[] };
      /** Whether it's the default group (hides remove button) */
      isDefaultGroup?: boolean;
    } = {},
  ): void {
    const stateIcon = this.getStateIcon(peer.state);
    const displayName = peer.hostname
      ? (peer.nickname ? `${peer.hostname} (${peer.nickname})` : peer.hostname)
      : (peer.nickname || nodeIdToWords(peer.nodeId));

    const shortId = peer.nodeId.substring(0, 8) + "...";
    const description = options.showDragHint ? `Drag to group • ${shortId}` : shortId;

    const setting = new Setting(container)
      .setName(`${stateIcon} ${displayName}`)
      .setDesc(description)
      .setClass("peervault-device-item");

    const settingEl = setting.settingEl;

    // Drag-and-drop for All Devices section
    if (options.draggable) {
      settingEl.setAttribute("draggable", "true");
      settingEl.addClass("peervault-draggable");

      settingEl.addEventListener("dragstart", (e) => {
        this.draggedPeerId = peer.nodeId;
        settingEl.addClass("peervault-dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", peer.nodeId);
        }
      });

      settingEl.addEventListener("dragend", () => {
        this.draggedPeerId = null;
        settingEl.removeClass("peervault-dragging");
        container.querySelectorAll(".peervault-drag-over").forEach((el) => {
          el.removeClass("peervault-drag-over");
        });
      });
    }

    // Remove from group button (only in group context, not default group)
    if (options.group && !options.isDefaultGroup) {
      setting.addExtraButton((btn) =>
        btn
          .setIcon("x")
          .setTooltip("Remove from group")
          .onClick(() => {
            this.plugin.peerManager?.getGroupManager()?.removePeerFromGroup(options.group!.id, peer.nodeId);
            new Notice("Device removed from group");
            this.display();
          }),
      );
    }

    // Delete device button (always shown)
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
    group: PeerGroup,
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
            new GroupModal(this.app, this.plugin, group, () => {
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
                new Notice(`Failed to generate invite: ${formatUserError(error)}`);
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
      generateQRCode(qrContainer, this.myTicket, {
        width: 160,
        canvasClass: "peervault-qr-canvas-small",
      });

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
      if (!ticket || ticket.length < 20) {
        this.plugin.logger.debug("Ticket validation failed: too short or empty");
        return false;
      }
      try {
        const parsed = JSON.parse(ticket);
        // Must have id (node ID) and addrs array
        const valid = typeof parsed.id === "string" && parsed.id.length > 0 && Array.isArray(parsed.addrs);
        if (!valid) {
          this.plugin.logger.debug("Ticket validation failed: missing id or addrs", {
            hasId: typeof parsed.id === "string",
            idLength: parsed.id?.length ?? 0,
            hasAddrs: Array.isArray(parsed.addrs),
          });
        }
        return valid;
      } catch (err) {
        this.plugin.logger.debug("Ticket validation failed: JSON parse error", err);
        return false;
      }
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
              new Notice(`Connection failed: ${formatUserError(error)}`);
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

  private async openQRScanner(): Promise<void> {
    const result = await openQRFilePicker();
    if (result) {
      this.ticketInput = result;
      this.showAddDevice = true;
      new Notice("QR code detected!");
      this.display();
    } else {
      new Notice("No QR code found in image");
    }
  }

  private openCameraScanner(): void {
    const modal = new CameraScannerModal(this.app, (ticket) => {
      this.ticketInput = ticket;
      this.showAddDevice = true;
      this.display();
    });
    modal.open();
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
      // Clean up any partially initialized resources
      this.stopScanning();
      this.stopCamera();
      statusEl.setText(`Camera error: ${formatUserError(error)}`);
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
