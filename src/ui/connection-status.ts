/**
 * Connection Status Component
 *
 * Real-time status indicator showing peer count, sync progress, and errors.
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import type PeerVaultPlugin from '../main';
import type { SyncStatus } from '../types';

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

/** Recent error history */
const recentErrors: SyncError[] = [];
const MAX_RECENT_ERRORS = 10;

/** Current sync progress */
let currentProgress: SyncProgress | null = null;

/**
 * Record a sync error.
 */
export function recordSyncError(error: SyncError): void {
  recentErrors.unshift(error);
  while (recentErrors.length > MAX_RECENT_ERRORS) {
    recentErrors.pop();
  }
}

/**
 * Get recent errors.
 */
export function getRecentErrors(): SyncError[] {
  return [...recentErrors];
}

/**
 * Clear recent errors.
 */
export function clearErrors(): void {
  recentErrors.length = 0;
}

/**
 * Update current sync progress.
 */
export function updateSyncProgress(progress: SyncProgress | null): void {
  currentProgress = progress;
}

/**
 * Get current sync progress.
 */
export function getSyncProgress(): SyncProgress | null {
  return currentProgress;
}

/**
 * Status bar manager for real-time connection status.
 */
export class ConnectionStatusManager {
  private statusBarItem: HTMLElement | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private plugin: PeerVaultPlugin,
    private app: App
  ) {}

  /**
   * Initialize the status bar.
   */
  initialize(): void {
    if (!this.plugin.settings.showStatusBar) return;

    this.statusBarItem = this.plugin.addStatusBarItem();
    this.statusBarItem.addClass('peervault-status-bar');
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
      (p) => p.connectionState === 'connected' || p.connectionState === 'syncing'
    );
    const progress = getSyncProgress();
    const errors = getRecentErrors();
    const hasRecentError = errors.length > 0 && Date.now() - errors[0]!.timestamp < 60000;

    this.statusBarItem.empty();

    // Status icon
    const iconEl = this.statusBarItem.createSpan({ cls: 'peervault-status-icon' });

    // Determine what to show
    if (hasRecentError && status === 'error') {
      iconEl.setText('!');
      iconEl.addClass('peervault-status-error');
      this.statusBarItem.title = `Error: ${errors[0]!.message}`;
    } else if (status === 'syncing') {
      iconEl.setText('~');
      iconEl.addClass('peervault-status-syncing');
      if (progress) {
        this.statusBarItem.title = `${progress.operation}: ${progress.progress}%`;
      } else {
        this.statusBarItem.title = 'Syncing...';
      }
    } else if (connectedPeers.length > 0) {
      iconEl.setText('*');
      iconEl.addClass('peervault-status-connected');
      this.statusBarItem.title = `Connected to ${connectedPeers.length} peer(s)`;
    } else if (peers.length > 0) {
      iconEl.setText('o');
      iconEl.addClass('peervault-status-offline');
      this.statusBarItem.title = `${peers.length} peer(s) offline`;
    } else {
      iconEl.setText('-');
      iconEl.addClass('peervault-status-idle');
      this.statusBarItem.title = 'No peers configured';
    }

    // Peer count
    const countEl = this.statusBarItem.createSpan({ cls: 'peervault-peer-count' });
    if (connectedPeers.length > 0) {
      countEl.setText(` ${connectedPeers.length}`);
    }

    // Progress bar if syncing
    if (status === 'syncing' && progress && progress.progress > 0) {
      const progressBar = this.statusBarItem.createSpan({ cls: 'peervault-progress-bar' });
      const progressFill = progressBar.createSpan({ cls: 'peervault-progress-fill' });
      progressFill.style.width = `${progress.progress}%`;
    }
  }
}

/**
 * Modal showing detailed connection status and error recovery options.
 */
export class ConnectionStatusModal extends Modal {
  constructor(
    app: App,
    private plugin: PeerVaultPlugin
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('peervault-connection-status-modal');

    contentEl.createEl('h2', { text: 'Connection Status' });

    this.renderOverview(contentEl);
    this.renderPeers(contentEl);
    this.renderErrors(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderOverview(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'peervault-status-overview' });

    const status = this.plugin.getStatus();
    const peers = this.plugin.getConnectedPeers();
    const connectedCount = peers.filter(
      (p) => p.connectionState === 'connected' || p.connectionState === 'syncing'
    ).length;

    // Status badge
    const statusRow = section.createDiv({ cls: 'peervault-overview-row' });
    statusRow.createSpan({ text: 'Status: ', cls: 'peervault-label' });
    const badge = statusRow.createSpan({ cls: `peervault-badge peervault-badge-${status}` });
    badge.setText(this.getStatusText(status));

    // Peer count
    const peerRow = section.createDiv({ cls: 'peervault-overview-row' });
    peerRow.createSpan({ text: 'Connected Peers: ', cls: 'peervault-label' });
    peerRow.createSpan({ text: `${connectedCount} / ${peers.length}`, cls: 'peervault-value' });

    // Current progress
    const progress = getSyncProgress();
    if (progress) {
      const progressRow = section.createDiv({ cls: 'peervault-overview-row' });
      progressRow.createSpan({ text: 'Current: ', cls: 'peervault-label' });
      progressRow.createSpan({ text: progress.operation, cls: 'peervault-value' });

      if (progress.progress > 0) {
        const progressBar = section.createDiv({ cls: 'peervault-progress-bar-large' });
        const fill = progressBar.createDiv({ cls: 'peervault-progress-fill' });
        fill.style.width = `${progress.progress}%`;
        progressBar.createSpan({ text: `${progress.progress}%`, cls: 'peervault-progress-text' });
      }
    }
  }

  private renderPeers(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'peervault-peers-section' });
    section.createEl('h3', { text: 'Peers' });

    const peers = this.plugin.getConnectedPeers();

    if (peers.length === 0) {
      section.createEl('p', {
        text: 'No peers configured. Add a device to start syncing.',
        cls: 'peervault-empty-state',
      });
      return;
    }

    const list = section.createDiv({ cls: 'peervault-peer-list' });

    for (const peer of peers) {
      const item = list.createDiv({ cls: 'peervault-peer-row' });

      // Status indicator
      const indicator = item.createSpan({ cls: `peervault-peer-indicator peervault-peer-${peer.connectionState}` });

      // Name
      const name = item.createSpan({ cls: 'peervault-peer-name' });
      name.setText(peer.name || peer.nodeId.substring(0, 8) + '...');

      // State
      const state = item.createSpan({ cls: `peervault-peer-state peervault-peer-${peer.connectionState}` });
      state.setText(peer.connectionState);

      // Actions
      if (peer.connectionState === 'error' || peer.connectionState === 'disconnected') {
        const retryBtn = item.createEl('button', { text: 'Retry', cls: 'peervault-retry-btn' });
        retryBtn.onclick = async () => {
          try {
            await this.plugin.peerManager.syncPeer(peer.nodeId);
            new Notice('Reconnecting to peer...');
            this.close();
          } catch (err) {
            new Notice(`Failed to reconnect: ${err}`);
          }
        };
      }
    }
  }

  private renderErrors(container: HTMLElement): void {
    const errors = getRecentErrors();
    if (errors.length === 0) return;

    const section = container.createDiv({ cls: 'peervault-errors-section' });
    section.createEl('h3', { text: 'Recent Errors' });

    const list = section.createDiv({ cls: 'peervault-error-list' });

    for (const error of errors.slice(0, 5)) {
      const item = list.createDiv({ cls: 'peervault-error-item' });

      const header = item.createDiv({ cls: 'peervault-error-header' });
      header.createSpan({ text: error.message, cls: 'peervault-error-message' });
      header.createSpan({
        text: this.timeAgo(error.timestamp),
        cls: 'peervault-error-time',
      });

      if (error.code) {
        item.createDiv({ text: `Code: ${error.code}`, cls: 'peervault-error-code' });
      }
    }

    // Clear errors button
    new Setting(section)
      .addButton((btn) =>
        btn.setButtonText('Clear Errors').onClick(() => {
          clearErrors();
          this.close();
          new Notice('Errors cleared');
        })
      );
  }

  private renderActions(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'peervault-actions-section' });

    new Setting(section)
      .addButton((btn) =>
        btn.setButtonText('Sync Now').setCta().onClick(async () => {
          this.close();
          await this.plugin.sync();
        })
      )
      .addButton((btn) =>
        btn.setButtonText('Close').onClick(() => this.close())
      );
  }

  private getStatusText(status: SyncStatus): string {
    switch (status) {
      case 'idle':
        return 'Ready';
      case 'syncing':
        return 'Syncing';
      case 'offline':
        return 'Offline';
      case 'error':
        return 'Error';
      default:
        return 'Unknown';
    }
  }

  private timeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
