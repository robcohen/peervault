/**
 * Status Modal
 *
 * Shows sync status and connected peers.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type PeerVaultPlugin from "../main";
import type { PeerInfo } from "../types";
import { STATUS_ICONS, getStatusLabel } from "./status-icons";

export class PeerVaultStatusModal extends Modal {
  plugin: PeerVaultPlugin;
  private eventCleanup: (() => void)[] = [];

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app);
    this.plugin = plugin;
  }

  override onOpen(): void {
    // Subscribe to peer events for auto-refresh
    this.subscribeToEvents();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("peervault-status-modal");

    contentEl.createEl("h2", { text: "PeerVault Status" });

    this.renderStatus(contentEl);
    this.renderPeers(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
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

    const { contentEl } = this;
    contentEl.empty();
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
      // Debounce rapid events - only refresh once per 100ms
      if (this.refreshTimeout) {
        clearTimeout(this.refreshTimeout);
      }
      this.refreshTimeout = window.setTimeout(() => {
        this.refreshContent();
        this.refreshTimeout = undefined;
      }, 100);
    };

    for (const event of events) {
      peerManager.on(event, refresh);
      this.eventCleanup.push(() => peerManager.off(event, refresh));
    }
  }

  private refreshTimeout?: number;

  private refreshContent(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("peervault-status-modal");

    contentEl.createEl("h2", { text: "PeerVault Status" });

    this.renderStatus(contentEl);
    this.renderPeers(contentEl);
    this.renderActions(contentEl);
  }

  private renderStatus(container: HTMLElement): void {
    const statusEl = container.createDiv({ cls: "peervault-status-section" });
    statusEl.createEl("h3", { text: "Sync Status" });

    const statusGrid = statusEl.createDiv({ cls: "peervault-status-grid" });

    // Current status
    const statusRow = statusGrid.createDiv({ cls: "peervault-status-row" });
    statusRow.createSpan({ text: "Status:", cls: "peervault-label" });
    const statusValue = statusRow.createSpan({ cls: "peervault-value" });

    const status = this.plugin.getStatus();
    const icon = STATUS_ICONS[status as keyof typeof STATUS_ICONS] ?? STATUS_ICONS.unknown;
    const label = getStatusLabel(status);
    statusValue.setText(`${icon} ${label}`);
    statusValue.ariaLabel = label; // For screen readers
    statusValue.addClass(`peervault-status-${status}`);

    // Vault ID
    const vaultRow = statusGrid.createDiv({ cls: "peervault-status-row" });
    vaultRow.createSpan({ text: "Vault ID:", cls: "peervault-label" });
    const vaultId = this.plugin.documentManager?.getVaultId() ?? "Not initialized";
    vaultRow.createSpan({
      text: vaultId.length > 8 ? vaultId.substring(0, 8) + "..." : vaultId,
      cls: "peervault-value",
    });

    // Files tracked
    const filesRow = statusGrid.createDiv({ cls: "peervault-status-row" });
    filesRow.createSpan({ text: "Files tracked:", cls: "peervault-label" });
    const fileCount = this.plugin.documentManager?.listAllPaths().length ?? 0;
    filesRow.createSpan({ text: String(fileCount), cls: "peervault-value" });
  }

  private renderPeers(container: HTMLElement): void {
    const peersEl = container.createDiv({ cls: "peervault-peers-section" });
    peersEl.createEl("h3", { text: "Devices" });

    // Show pending pairing requests first
    const pairingRequests = this.plugin.peerManager?.getPendingPairingRequests() ?? [];
    if (pairingRequests.length > 0) {
      const requestsList = peersEl.createEl("ul", { cls: "peervault-peer-list" });
      for (const request of pairingRequests) {
        this.renderPairingRequest(requestsList, request);
      }
    }

    // Show connected peers
    const peers = this.plugin.getConnectedPeers();

    if (peers.length === 0 && pairingRequests.length === 0) {
      peersEl.createEl("p", {
        text: "No devices connected. Add a device to start syncing.",
        cls: "peervault-no-peers",
      });
    } else if (peers.length > 0) {
      const peerList = peersEl.createEl("ul", { cls: "peervault-peer-list" });

      for (const peer of peers) {
        this.renderPeerItem(peerList, peer);
      }
    }
  }

  private renderPairingRequest(list: HTMLElement, request: { nodeId: string; timestamp: number }): void {
    const item = list.createEl("li", { cls: "peervault-peer-item peervault-pairing-request" });

    // Peer info
    const info = item.createDiv({ cls: "peervault-peer-info" });
    info.createSpan({
      text: `Device ${request.nodeId.substring(0, 8)}...`,
      cls: "peervault-peer-name",
    });

    // Status indicator
    const statusEl = info.createSpan({ cls: "peervault-peer-status peervault-peer-pairing" });
    statusEl.setText("wants to pair");

    // Action buttons
    const actions = item.createDiv({ cls: "peervault-pairing-actions" });

    const acceptBtn = actions.createEl("button", {
      text: "Accept",
      cls: "peervault-btn peervault-btn-accept",
    });
    acceptBtn.onclick = async () => {
      try {
        await this.plugin.peerManager?.acceptPairingRequest(request.nodeId);
        new Notice("Pairing accepted");
        this.onOpen(); // Refresh the modal
      } catch (error) {
        new Notice(`Failed to accept: ${error}`);
      }
    };

    const denyBtn = actions.createEl("button", {
      text: "Deny",
      cls: "peervault-btn peervault-btn-deny",
    });
    denyBtn.onclick = async () => {
      await this.plugin.peerManager?.denyPairingRequest(request.nodeId);
      new Notice("Pairing denied");
      this.onOpen(); // Refresh the modal
    };
  }

  private renderPeerItem(list: HTMLElement, peer: PeerInfo): void {
    const item = list.createEl("li", { cls: "peervault-peer-item" });

    // Peer info
    const info = item.createDiv({ cls: "peervault-peer-info" });
    info.createSpan({
      text: peer.name || peer.nodeId.substring(0, 8) + "...",
      cls: "peervault-peer-name",
    });

    // Status indicator
    const statusEl = info.createSpan({
      cls: `peervault-peer-status peervault-peer-${peer.connectionState}`,
    });
    statusEl.setText(peer.connectionState);

    // Last seen
    if (peer.lastSeen) {
      const lastSeen = item.createDiv({ cls: "peervault-peer-lastseen" });
      const ago = this.timeAgo(peer.lastSeen);
      lastSeen.setText(`Last seen: ${ago}`);
    }
  }

  private renderActions(container: HTMLElement): void {
    const actionsEl = container.createDiv({ cls: "peervault-actions-section" });

    new Setting(actionsEl)
      .setName("Manage Devices")
      .setDesc("Add, remove, or configure devices")
      .addButton((btn) =>
        btn.setButtonText("Open Settings").onClick(() => {
          this.close();
          // Open settings tab
          (this.app as any).setting.open();
          (this.app as any).setting.openTabById("peervault");
        }),
      );

    new Setting(actionsEl)
      .setName("Sync Now")
      .setDesc("Manually trigger sync with all connected peers")
      .addButton((btn) =>
        btn.setButtonText("Sync").onClick(async () => {
          try {
            await this.plugin.sync();
            new Notice("Sync completed");
            this.close();
          } catch (error) {
            new Notice(`Sync failed: ${error}`);
          }
        }),
      );
  }

  private timeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
