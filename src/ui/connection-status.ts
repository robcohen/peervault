/**
 * Connection Status Component
 *
 * Real-time status indicator showing peer count, sync progress, and errors.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type PeerVaultPlugin from "../main";
import { UI_LIMITS, type SyncStatus } from "../types";
import { STATUS_ICONS } from "./status-icons";
import { nodeIdToWords } from "../utils/device";
import { timeAgo } from "./utils/time-utils";
import { formatUserError } from "../utils/validation";
import type { CloudSyncStatus } from "../cloud/types";

/** Sync progress info */
export interface SyncProgress {
  /** Current operation description */
  operation: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Peer being synced */
  peerId?: string;
  /** Bytes transferred */
  bytesTransferred?: number;
  /** Total bytes */
  totalBytes?: number;
}

/** Error info for recovery */
export interface SyncError {
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
  /** Peer that caused the error */
  peerId?: string;
  /** Timestamp */
  timestamp: number;
  /** Whether this error can be retried */
  retryable: boolean;
}

/** State management for connection status (encapsulated) */
class ConnectionState {
  private recentErrors: SyncError[] = [];
  private currentProgress: SyncProgress | null = null;
  private readonly MAX_RECENT_ERRORS = 10;

  recordError(error: SyncError): void {
    this.recentErrors.unshift(error);
    while (this.recentErrors.length > this.MAX_RECENT_ERRORS) {
      this.recentErrors.pop();
    }
  }

  getErrors(): SyncError[] {
    return [...this.recentErrors];
  }

  getLatestError(): SyncError | undefined {
    return this.recentErrors[0];
  }

  clearErrors(): void {
    this.recentErrors.length = 0;
  }

  setProgress(progress: SyncProgress | null): void {
    this.currentProgress = progress;
  }

  getProgress(): SyncProgress | null {
    return this.currentProgress;
  }
}

const connectionState = new ConnectionState();

/**
 * Record a sync error.
 */
export function recordSyncError(error: SyncError): void {
  connectionState.recordError(error);
}

/**
 * Get recent errors.
 */
export function getRecentErrors(): SyncError[] {
  return connectionState.getErrors();
}

/**
 * Clear recent errors.
 */
export function clearErrors(): void {
  connectionState.clearErrors();
}

/**
 * Update current sync progress.
 */
export function updateSyncProgress(progress: SyncProgress | null): void {
  connectionState.setProgress(progress);
}

/**
 * Get current sync progress.
 */
export function getSyncProgress(): SyncProgress | null {
  return connectionState.getProgress();
}

/**
 * Status bar manager for real-time connection status.
 */
export class ConnectionStatusManager {
  private statusBarItem: HTMLElement | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private plugin: PeerVaultPlugin,
    private app: App,
  ) {}

  /**
   * Initialize the status bar.
   */
  initialize(): void {
    if (!this.plugin.settings.showStatusBar) return;

    // Clean up any stale status bar items from previous plugin instances
    // Only remove items that are direct children of the status bar container
    // and have our specific class
    const statusBarContainer = document.querySelector(".status-bar");
    if (statusBarContainer) {
      const staleItems = statusBarContainer.querySelectorAll(":scope > .status-bar-item.peervault-status-bar");
      staleItems.forEach(item => item.remove());
    }

    this.statusBarItem = this.plugin.addStatusBarItem();
    this.statusBarItem.addClass("peervault-status-bar");
    this.update();

    // Update every second for real-time feel
    this.updateInterval = setInterval(() => this.update(), 1000);

    // Click to open status modal
    this.statusBarItem.onclick = () => {
      new ConnectionStatusModal(this.app, this.plugin).open();
    };
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  /**
   * Update the status bar display.
   */
  update(): void {
    if (!this.statusBarItem) return;

    const status = this.plugin.getStatus();
    const peers = this.plugin.getConnectedPeers();
    const connectedPeers = peers.filter(
      (p) =>
        p.connectionState === "connected" || p.connectionState === "syncing",
    );
    const progress = getSyncProgress();
    const latestError = connectionState.getLatestError();
    const hasRecentError =
      latestError !== undefined && Date.now() - latestError.timestamp < 60000;

    this.statusBarItem.empty();

    // Status icon
    const iconEl = this.statusBarItem.createSpan({
      cls: "peervault-status-icon",
    });

    // Determine what to show
    if (hasRecentError && status === "error" && latestError) {
      iconEl.setText(STATUS_ICONS.error);
      iconEl.addClass("peervault-status-error");
      iconEl.ariaLabel = "Error";
      this.statusBarItem.title = `Error: ${latestError.message}`;
    } else if (status === "syncing") {
      iconEl.setText(STATUS_ICONS.syncing);
      iconEl.addClass("peervault-status-syncing");
      iconEl.ariaLabel = "Syncing";
      if (progress) {
        this.statusBarItem.title = `${progress.operation}: ${progress.progress}%`;
      } else {
        this.statusBarItem.title = "Syncing...";
      }
    } else if (connectedPeers.length > 0) {
      iconEl.setText(STATUS_ICONS.connected);
      iconEl.addClass("peervault-status-connected");
      iconEl.ariaLabel = "Connected";
      this.statusBarItem.title = `Connected to ${connectedPeers.length} peer(s)`;
    } else if (peers.length > 0) {
      iconEl.setText(STATUS_ICONS.offline);
      iconEl.addClass("peervault-status-offline");
      iconEl.ariaLabel = "Offline";
      this.statusBarItem.title = `${peers.length} peer(s) offline`;
    } else {
      iconEl.setText(STATUS_ICONS.idle);
      iconEl.addClass("peervault-status-idle");
      iconEl.ariaLabel = "Idle";
      this.statusBarItem.title = "No peers configured";
    }

    // Peer count
    const countEl = this.statusBarItem.createSpan({
      cls: "peervault-peer-count",
    });
    if (connectedPeers.length > 0) {
      countEl.setText(` ${connectedPeers.length}`);
    }

    // Progress bar if syncing
    if (status === "syncing" && progress && progress.progress > 0) {
      const progressBar = this.statusBarItem.createSpan({
        cls: "peervault-progress-bar",
      });
      const progressFill = progressBar.createSpan({
        cls: "peervault-progress-fill",
      });
      progressFill.style.width = `${progress.progress}%`;
    }

    // Cloud sync status (if configured)
    const cloudSync = this.plugin.getCloudSync?.();
    if (cloudSync?.isConfigured()) {
      const cloudState = cloudSync.getState();
      const cloudIcon = this.statusBarItem.createSpan({
        cls: "peervault-cloud-icon",
      });
      cloudIcon.style.marginLeft = "6px";

      switch (cloudState.status) {
        case "syncing":
        case "uploading":
        case "downloading":
          cloudIcon.setText("☁↕");
          cloudIcon.addClass("peervault-status-syncing");
          cloudIcon.title = `Cloud: ${cloudState.status}`;
          break;
        case "error":
          cloudIcon.setText("☁✗");
          cloudIcon.addClass("peervault-status-error");
          cloudIcon.title = `Cloud error: ${cloudState.error || "Unknown"}`;
          break;
        case "idle":
          cloudIcon.setText("☁✓");
          cloudIcon.addClass("peervault-status-connected");
          cloudIcon.title = cloudState.lastSyncedAt
            ? `Cloud: synced ${timeAgo(cloudState.lastSyncedAt)}`
            : "Cloud: connected";
          break;
        default:
          // disabled - don't show icon
          break;
      }
    }
  }
}

/**
 * Modal showing detailed connection status and error recovery options.
 */
export class ConnectionStatusModal extends Modal {
  constructor(
    app: App,
    private plugin: PeerVaultPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-connection-status-modal");

    contentEl.createEl("h2", { text: "Connection Status" });

    this.renderOverview(contentEl);
    this.renderCloudSync(contentEl);
    this.renderPeers(contentEl);
    this.renderErrors(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderOverview(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-status-overview" });

    const status = this.plugin.getStatus();
    const peers = this.plugin.getConnectedPeers();
    const connectedCount = peers.filter(
      (p) =>
        p.connectionState === "connected" || p.connectionState === "syncing",
    ).length;

    // Status badge
    const statusRow = section.createDiv({ cls: "peervault-overview-row" });
    statusRow.createSpan({ text: "P2P Status: ", cls: "peervault-label" });
    const badge = statusRow.createSpan({
      cls: `peervault-badge peervault-badge-${status}`,
    });
    badge.setText(this.getStatusText(status));

    // Peer count
    const peerRow = section.createDiv({ cls: "peervault-overview-row" });
    peerRow.createSpan({ text: "Connected Peers: ", cls: "peervault-label" });
    peerRow.createSpan({
      text: `${connectedCount} / ${peers.length}`,
      cls: "peervault-value",
    });

    // Current progress
    const progress = getSyncProgress();
    if (progress) {
      const progressRow = section.createDiv({ cls: "peervault-overview-row" });
      progressRow.createSpan({ text: "Current: ", cls: "peervault-label" });
      progressRow.createSpan({
        text: progress.operation,
        cls: "peervault-value",
      });

      if (progress.progress > 0) {
        const progressBar = section.createDiv({
          cls: "peervault-progress-bar-large",
        });
        const fill = progressBar.createDiv({ cls: "peervault-progress-fill" });
        fill.style.width = `${progress.progress}%`;
        progressBar.createSpan({
          text: `${progress.progress}%`,
          cls: "peervault-progress-text",
        });
      }
    }
  }

  private renderCloudSync(container: HTMLElement): void {
    const cloudSync = this.plugin.getCloudSync?.();
    if (!cloudSync?.isConfigured()) {
      return; // Don't show section if cloud sync not configured
    }

    const section = container.createDiv({ cls: "peervault-cloud-section" });
    section.createEl("h3", { text: "Cloud Sync" });

    const state = cloudSync.getState();

    // Cloud status
    const statusRow = section.createDiv({ cls: "peervault-overview-row" });
    statusRow.createSpan({ text: "Status: ", cls: "peervault-label" });
    const badge = statusRow.createSpan({
      cls: `peervault-badge peervault-badge-${state.status === "idle" ? "connected" : state.status}`,
    });
    badge.setText(this.getCloudStatusText(state.status));

    // Last synced
    if (state.lastSyncedAt) {
      const syncedRow = section.createDiv({ cls: "peervault-overview-row" });
      syncedRow.createSpan({ text: "Last Synced: ", cls: "peervault-label" });
      syncedRow.createSpan({
        text: timeAgo(state.lastSyncedAt),
        cls: "peervault-value",
      });
    }

    // Pending uploads
    if (state.pendingUploads > 0) {
      const pendingRow = section.createDiv({ cls: "peervault-overview-row" });
      pendingRow.createSpan({ text: "Pending Uploads: ", cls: "peervault-label" });
      pendingRow.createSpan({
        text: String(state.pendingUploads),
        cls: "peervault-value",
      });
    }

    // Error message
    if (state.status === "error" && state.error) {
      const errorRow = section.createDiv({ cls: "peervault-overview-row peervault-error-row" });
      errorRow.createSpan({ text: "Error: ", cls: "peervault-label" });
      errorRow.createSpan({
        text: state.error,
        cls: "peervault-value peervault-error-text",
      });
    }

    // Cloud sync button
    new Setting(section).addButton((btn) =>
      btn
        .setButtonText("Sync to Cloud")
        .setDisabled(state.status === "syncing" || state.status === "uploading" || state.status === "downloading")
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Syncing...");
          try {
            const result = await cloudSync.sync();
            if (result.success) {
              const parts = [];
              if (result.deltasUploaded > 0 || result.deltasDownloaded > 0) {
                parts.push(`${result.deltasUploaded}↑ ${result.deltasDownloaded}↓ deltas`);
              }
              if (result.blobsUploaded > 0 || result.blobsDownloaded > 0) {
                parts.push(`${result.blobsUploaded}↑ ${result.blobsDownloaded}↓ blobs`);
              }
              new Notice(parts.length > 0 ? `Cloud sync: ${parts.join(", ")}` : "Cloud: Already in sync");
            } else {
              new Notice(`Cloud sync failed: ${result.error}`);
            }
          } catch (error) {
            new Notice(`Cloud sync failed: ${formatUserError(error)}`);
          } finally {
            btn.setButtonText("Sync to Cloud");
            btn.setDisabled(false);
          }
        }),
    );
  }

  private getCloudStatusText(status: CloudSyncStatus): string {
    switch (status) {
      case "idle":
        return "Connected";
      case "syncing":
        return "Syncing";
      case "uploading":
        return "Uploading";
      case "downloading":
        return "Downloading";
      case "error":
        return "Error";
      case "disabled":
        return "Disabled";
      default:
        return "Unknown";
    }
  }

  private renderPeers(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-peers-section" });
    section.createEl("h3", { text: "Peers" });

    const peers = this.plugin.getConnectedPeers();

    if (peers.length === 0) {
      section.createEl("p", {
        text: "No peers configured. Add a device to start syncing.",
        cls: "peervault-empty-state",
      });
      return;
    }

    const list = section.createDiv({ cls: "peervault-peer-list" });

    for (const peer of peers) {
      const item = list.createDiv({ cls: "peervault-peer-row" });

      // Status indicator
      const indicator = item.createSpan({
        cls: `peervault-peer-indicator peervault-peer-${peer.connectionState}`,
      });

      // Name
      const name = item.createSpan({ cls: "peervault-peer-name" });
      name.setText(
        peer.hostname
          ? (peer.nickname ? `${peer.hostname} (${peer.nickname})` : peer.hostname)
          : (peer.nickname || nodeIdToWords(peer.nodeId)),
      );

      // Connection type and WebRTC status (for connected peers)
      if (peer.connectionState === "connected" || peer.connectionState === "syncing") {
        const connType = this.plugin.peerManager?.getPeerConnectionType(peer.nodeId);
        if (connType) {
          const typeEl = item.createSpan({ cls: "peervault-peer-conn-type" });
          const typeIcon = connType === "direct" ? "🔗" : connType === "relay" ? "☁️" : connType === "mixed" ? "🔀" : "";
          const typeLabel = connType === "direct" ? "direct" : connType === "relay" ? "relay" : connType === "mixed" ? "mixed" : "";
          typeEl.setText(`${typeIcon} ${typeLabel}`);
          typeEl.title = connType === "direct"
            ? "Direct peer-to-peer connection (local network)"
            : connType === "relay"
            ? "Connection via relay server"
            : connType === "mixed"
            ? "Mixed connection (direct + relay)"
            : "Connection type unknown";
        }

        // WebRTC status and upgrade button
        if (this.plugin.settings.enableWebRTC) {
          const webrtcState = this.plugin.peerManager?.getPeerWebRTCState(peer.nodeId);
          if (webrtcState) {
            const webrtcEl = item.createSpan({ cls: "peervault-peer-webrtc" });
            if (webrtcState === "connected") {
              webrtcEl.setText("⚡");
              webrtcEl.title = "WebRTC direct connection active";
              webrtcEl.addClass("peervault-webrtc-connected");
            } else if (webrtcState === "initiating" || webrtcState === "responding") {
              webrtcEl.setText("⏳");
              webrtcEl.title = "WebRTC upgrade in progress...";
              webrtcEl.addClass("peervault-webrtc-pending");
            } else if (webrtcState === "none" || webrtcState === "failed") {
              const upgradeBtn = item.createEl("button", {
                text: "Upgrade",
                cls: "peervault-webrtc-upgrade-btn",
              });
              upgradeBtn.title = "Attempt WebRTC direct connection";
              upgradeBtn.onclick = () => {
                const started = this.plugin.peerManager?.attemptWebRTCUpgrade(peer.nodeId);
                if (started) {
                  new Notice("WebRTC upgrade initiated...");
                  upgradeBtn.disabled = true;
                  upgradeBtn.setText("...");
                } else {
                  new Notice("Cannot upgrade: session not ready");
                }
              };
            }
          }
        }
      }

      // State
      const state = item.createSpan({
        cls: `peervault-peer-state peervault-peer-${peer.connectionState}`,
      });
      state.setText(peer.connectionState);

      // Actions
      if (
        peer.connectionState === "error" ||
        peer.connectionState === "disconnected"
      ) {
        const retryBtn = item.createEl("button", {
          text: "Retry",
          cls: "peervault-retry-btn",
        });
        let isRetrying = false;
        retryBtn.onclick = async () => {
          if (isRetrying) return; // Debounce
          isRetrying = true;
          retryBtn.disabled = true;
          retryBtn.setText("Retrying...");
          try {
            await this.plugin.peerManager.syncPeer(peer.nodeId);
            new Notice("Reconnecting to peer...");
            this.close();
          } catch (err) {
            new Notice(`Failed to reconnect: ${err}`);
            retryBtn.setText("Retry");
            retryBtn.disabled = false;
            isRetrying = false;
          }
        };
      }
    }
  }

  private renderErrors(container: HTMLElement): void {
    const errors = getRecentErrors();
    if (errors.length === 0) return;

    const section = container.createDiv({ cls: "peervault-errors-section" });
    section.createEl("h3", { text: "Recent Errors" });

    const list = section.createDiv({ cls: "peervault-error-list" });

    for (const error of errors.slice(0, UI_LIMITS.maxDisplayedErrors)) {
      const item = list.createDiv({ cls: "peervault-error-item" });

      const header = item.createDiv({ cls: "peervault-error-header" });
      header.createSpan({
        text: error.message,
        cls: "peervault-error-message",
      });
      header.createSpan({
        text: timeAgo(error.timestamp),
        cls: "peervault-error-time",
      });

      if (error.code) {
        item.createDiv({
          text: `Code: ${error.code}`,
          cls: "peervault-error-code",
        });
      }
    }

    // Clear errors button
    new Setting(section).addButton((btn) =>
      btn.setButtonText("Clear Errors").onClick(() => {
        clearErrors();
        this.close();
        new Notice("Errors cleared");
      }),
    );
  }

  private renderActions(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-actions-section" });

    new Setting(section)
      .addButton((btn) =>
        btn
          .setButtonText("Sync Now")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("Syncing...");
            try {
              await this.plugin.sync();
              new Notice("Sync completed");
              this.close();
            } catch (error) {
              new Notice(`Sync failed: ${formatUserError(error)}`);
              btn.setDisabled(false);
              btn.setButtonText("Sync Now");
            }
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close()),
      );
  }

  private getStatusText(status: SyncStatus): string {
    switch (status) {
      case "idle":
        return "Ready";
      case "syncing":
        return "Syncing";
      case "offline":
        return "Offline";
      case "error":
        return "Error";
      default:
        return "Unknown";
    }
  }

}
