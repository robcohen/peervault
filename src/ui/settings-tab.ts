/**
 * Settings Tab
 *
 * Plugin settings UI for PeerVault configuration.
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type PeerVaultPlugin from "../main";
import { nodeIdToWords } from "../utils/device";
import { showConfirm } from "./confirm-modal";
import { STATUS_ICONS } from "./status-icons";
import { formatUserError } from "../utils/validation";
import {
  renderStatusSection,
  resetStatusSectionState,
  renderSyncSection,
  renderStorageSection,
  renderSecuritySection,
  renderCloudSection,
  renderAdvancedSection,
  renderDangerZone,
  type SectionContext,
} from "./settings";

export class PeerVaultSettingsTab extends PluginSettingTab {
  plugin: PeerVaultPlugin;
  private eventCleanup: (() => void)[] = [];
  private refreshTimeout?: number;

  // Pairing state
  private showTicket = false;
  private showAddDevice = false;
  private myTicket = "";
  private ticketInput = "";

  // Device list expansion state
  private devicesExpanded = true;

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

    // Security Section
    renderSecuritySection(containerEl, ctx);

    // Cloud Sync Section
    renderCloudSection(containerEl, ctx);

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

    // 2. Paired Devices section (collapsible)
    new Setting(container)
      .setName("Paired Devices")
      .setDesc(`${allPeers.length} device(s)`)
      .setClass("peervault-group-header")
      .addExtraButton((btn) =>
        btn
          .setIcon(this.devicesExpanded ? "chevron-up" : "chevron-down")
          .setTooltip(this.devicesExpanded ? "Collapse" : "Expand")
          .onClick(() => {
            this.devicesExpanded = !this.devicesExpanded;
            this.display();
          }),
      );

    if (this.devicesExpanded) {
      const devicesContent = container.createDiv({ cls: "peervault-group-content" });

      if (allPeers.length === 0) {
        devicesContent.createEl("p", {
          text: "No devices paired yet",
          cls: "peervault-empty-state",
        });
      } else {
        for (const peer of allPeers) {
          this.renderDevice(devicesContent, peer);
        }
      }
    }

    // 3. Add Device section (collapsible)
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
   * Render a single device entry.
   */
  private renderDevice(
    container: HTMLElement,
    peer: { nodeId: string; hostname?: string; nickname?: string; state: string },
  ): void {
    const stateIcon = this.getStateIcon(peer.state);
    const displayName = peer.hostname
      ? (peer.nickname ? `${peer.hostname} (${peer.nickname})` : peer.hostname)
      : (peer.nickname || nodeIdToWords(peer.nodeId));

    const shortId = peer.nodeId.substring(0, 8) + "...";

    // Get connection type for connected peers
    let connectionTypeStr = "";
    if (peer.state === "connected") {
      const connType = this.plugin.peerManager?.getPeerConnectionType(peer.nodeId);
      if (connType) {
        connectionTypeStr = connType === "direct" ? "🔗 direct" : connType === "relay" ? "☁️ relay" : connType === "mixed" ? "🔀 mixed" : "";
      }
    }

    const descParts: string[] = [];
    if (connectionTypeStr) descParts.push(connectionTypeStr);
    descParts.push(shortId);
    const description = descParts.join(" • ");

    const setting = new Setting(container)
      .setName(`${stateIcon} ${displayName}`)
      .setDesc(description)
      .setClass("peervault-device-item");

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

  private renderAddDeviceSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-add-device-section" });

    // --- Show My Invite Ticket ---
    new Setting(section)
      .setName("My Invite Ticket")
      .setDesc(this.showTicket ? "Share this with another device" : "Show your invite ticket for other devices")
      .addExtraButton((btn) =>
        btn
          .setIcon(this.showTicket ? "chevron-up" : "ticket")
          .setTooltip(this.showTicket ? "Hide" : "Show Ticket")
          .onClick(async () => {
            this.showTicket = !this.showTicket;
            if (this.showTicket && !this.myTicket) {
              try {
                this.myTicket = await this.plugin.generateInvite();
              } catch (error) {
                new Notice(`Failed to generate invite: ${formatUserError(error)}`);
                this.showTicket = false;
              }
            }
            this.display();
          }),
      );

    if (this.showTicket && this.myTicket) {
      const ticketSection = section.createDiv({ cls: "peervault-ticket-section" });

      // Ticket display
      const ticketEl = ticketSection.createEl("textarea", {
        cls: "peervault-ticket-display",
        attr: { readonly: "true", rows: "3", spellcheck: "false" },
      });
      ticketEl.value = this.myTicket;

      // Copy ticket button
      new Setting(ticketSection)
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

      const trimmed = ticket.trim();

      // Check for base32 format (standard Iroh ticket starting with "endpoint")
      if (trimmed.startsWith("endpoint")) {
        // Base32 tickets are alphanumeric lowercase, typically 100+ chars
        const isValidBase32 = /^endpoint[a-z0-9]+$/.test(trimmed) && trimmed.length >= 50;
        if (!isValidBase32) {
          this.plugin.logger.debug("Ticket validation failed: invalid base32 format");
        }
        return isValidBase32;
      }

      // Check for JSON format (legacy)
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed);
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
      }

      this.plugin.logger.debug("Ticket validation failed: unrecognized format (expected base32 or JSON)");
      return false;
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

