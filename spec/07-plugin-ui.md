# Plugin UI Spec

## Purpose

Define the user interface components for PeerVault, including settings, peer management, and sync status.

## Requirements

- **REQ-UI-01**: MUST provide settings tab in Obsidian settings
- **REQ-UI-02**: MUST show sync status in status bar
- **REQ-UI-03**: MUST provide peer management interface
- **REQ-UI-04**: MUST support QR code display and scanning for pairing
- **REQ-UI-05**: MUST show document history/versions

## UI Components

### 1. Status Bar Item

Shows sync status at a glance.

```
States:
- ● Synced                    (green dot)
- ◐ Syncing...               (animated)
- ○ Offline                  (gray dot)
- ⚠ Sync error              (yellow warning)
```

```typescript
class SyncStatusBar {
  private statusBarItem: HTMLElement;

  constructor(private plugin: Plugin) {
    this.statusBarItem = plugin.addStatusBarItem();
    this.statusBarItem.addClass('peervault-status');
  }

  update(state: SyncState): void {
    this.statusBarItem.empty();

    const icon = this.statusBarItem.createSpan({ cls: 'status-icon' });
    const text = this.statusBarItem.createSpan({ cls: 'status-text' });

    switch (state.status) {
      case 'synced':
        icon.addClass('synced');
        text.setText(`Synced with ${state.peerCount} peer(s)`);
        break;
      case 'syncing':
        icon.addClass('syncing');
        text.setText('Syncing...');
        break;
      case 'offline':
        icon.addClass('offline');
        text.setText('Offline');
        break;
      case 'error':
        icon.addClass('error');
        text.setText('Sync error');
        break;
    }

    // Click to open peer panel
    this.statusBarItem.onClickEvent(() => {
      this.plugin.showPeerPanel();
    });
  }
}
```

### 2. Settings Tab

Plugin configuration in Obsidian Settings.

```typescript
class PeerVaultSettingTab extends PluginSettingTab {
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'PeerVault Settings' });

    // --- Identity Section ---
    containerEl.createEl('h3', { text: 'Identity' });

    new Setting(containerEl)
      .setName('Your Device ID')
      .setDesc('Share this with peers to let them connect to you')
      .addText(text => text
        .setValue(this.plugin.transport.getNodeId())
        .setDisabled(true)
      )
      .addButton(btn => btn
        .setIcon('copy')
        .onClick(() => navigator.clipboard.writeText(this.plugin.transport.getNodeId()))
      );

    // --- Peers Section ---
    containerEl.createEl('h3', { text: 'Connected Peers' });

    new Setting(containerEl)
      .setName('Add Device')
      .setDesc('Connect a new device to sync with')
      .addButton(btn => btn
        .setButtonText('Show QR Code')
        .onClick(() => this.showAddDeviceModal())
      )
      .addButton(btn => btn
        .setButtonText('Enter Ticket')
        .onClick(() => this.showJoinDeviceModal())
      );

    // List existing peers
    this.displayPeerList(containerEl);

    // --- Sync Section ---
    containerEl.createEl('h3', { text: 'Sync Options' });

    new Setting(containerEl)
      .setName('Auto-sync on startup')
      .setDesc('Automatically connect to peers when Obsidian opens')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(value => this.plugin.updateSettings({ autoSync: value }))
      );

    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('Folders to exclude from sync (one per line)')
      .addTextArea(text => text
        .setValue(this.plugin.settings.excludedFolders.join('\n'))
        .onChange(value => {
          const folders = value.split('\n').filter(f => f.trim());
          this.plugin.updateSettings({ excludedFolders: folders });
        })
      );
  }

  private displayPeerList(containerEl: HTMLElement): void {
    const peers = this.plugin.peerManager.getPeerStates();

    if (peers.length === 0) {
      containerEl.createEl('p', {
        text: 'No peers connected. Add a device to start syncing.',
        cls: 'peervault-no-peers'
      });
      return;
    }

    for (const state of peers) {
      new Setting(containerEl)
        .setName(state.peer.name)
        .setDesc(this.getPeerStatusText(state))
        .addButton(btn => btn
          .setIcon(state.status === 'connected' ? 'unlink' : 'link')
          .setTooltip(state.status === 'connected' ? 'Disconnect' : 'Connect')
          .onClick(() => this.togglePeerConnection(state))
        )
        .addButton(btn => btn
          .setIcon('trash')
          .setTooltip('Remove peer')
          .onClick(() => this.removePeer(state.peer.nodeId))
        );
    }
  }
}
```

### 3. Progress Indicators

Show sync and transfer progress to keep users informed.

#### Sync Progress Panel

```typescript
interface SyncProgress {
  phase: 'connecting' | 'exchanging' | 'syncing' | 'complete' | 'error';
  peerId: string;
  peerName: string;
  bytesReceived: number;
  bytesSent: number;
  filesUpdated: number;
  startTime: number;
  error?: string;
}

class SyncProgressView extends ItemView {
  static VIEW_TYPE = 'peervault-sync-progress';

  private progressData = new Map<string, SyncProgress>();

  getViewType(): string { return SyncProgressView.VIEW_TYPE; }
  getDisplayText(): string { return 'Sync Progress'; }
  getIcon(): string { return 'refresh-cw'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('peervault-progress-view');

    // Subscribe to sync events
    this.plugin.syncEngine.on('sync-progress', (progress: SyncProgress) => {
      this.progressData.set(progress.peerId, progress);
      this.render();
    });

    this.render();
  }

  private render(): void {
    const container = this.containerEl.children[1];
    container.empty();

    container.createEl('h4', { text: 'Active Sync Operations' });

    if (this.progressData.size === 0) {
      container.createEl('p', {
        text: 'No sync in progress',
        cls: 'peervault-no-progress'
      });
      return;
    }

    for (const progress of this.progressData.values()) {
      this.renderProgressItem(container, progress);
    }
  }

  private renderProgressItem(container: HTMLElement, progress: SyncProgress): void {
    const item = container.createDiv({ cls: 'peervault-progress-item' });

    // Header with peer name and status
    const header = item.createDiv({ cls: 'progress-header' });
    header.createSpan({ text: progress.peerName, cls: 'peer-name' });
    header.createSpan({
      text: this.getPhaseLabel(progress.phase),
      cls: `phase-badge phase-${progress.phase}`
    });

    // Progress bar (for file sync)
    if (progress.phase === 'syncing') {
      const progressBar = item.createDiv({ cls: 'progress-bar-container' });
      const bar = progressBar.createDiv({ cls: 'progress-bar' });

      // Estimate progress based on bytes
      const total = progress.bytesReceived + progress.bytesSent;
      bar.style.width = `${Math.min(100, Math.floor(Math.random() * 30) + 70)}%`; // Placeholder

      // Stats
      const stats = item.createDiv({ cls: 'progress-stats' });
      stats.createSpan({
        text: `${this.formatBytes(progress.bytesReceived)} received`
      });
      stats.createSpan({
        text: `${progress.filesUpdated} files updated`
      });
    }

    // Error message
    if (progress.phase === 'error' && progress.error) {
      item.createDiv({
        text: progress.error,
        cls: 'progress-error'
      });
    }

    // Elapsed time
    const elapsed = Date.now() - progress.startTime;
    item.createDiv({
      text: `${this.formatDuration(elapsed)}`,
      cls: 'progress-time'
    });
  }

  private getPhaseLabel(phase: SyncProgress['phase']): string {
    return {
      connecting: 'Connecting...',
      exchanging: 'Exchanging versions...',
      syncing: 'Syncing files...',
      complete: 'Complete',
      error: 'Error',
    }[phase];
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return 'Just now';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }
}
```

#### Blob Transfer Progress

```typescript
interface BlobTransferProgress {
  hash: string;
  fileName: string;
  totalBytes: number;
  transferredBytes: number;
  speed: number; // bytes per second
  direction: 'download' | 'upload';
  status: 'active' | 'stalled' | 'retrying' | 'waiting' | 'failed';
  retryCount?: number;
  peerId?: string;
  peerName?: string;
  errorMessage?: string;
}

class BlobTransferIndicator {
  private transfers = new Map<string, BlobTransferProgress>();
  private containerEl: HTMLElement | null = null;

  constructor(private plugin: Plugin) {
    // Subscribe to blob transfer events from BlobTransferManager
    const blobManager = this.plugin.blobSync;

    blobManager.on('transferStarted', (e: { hash: string; totalSize: number; resumedFrom: number; peerId: string }) => {
      this.updateTransfer(e.hash, {
        totalBytes: e.totalSize,
        transferredBytes: e.resumedFrom,
        status: 'active',
        peerId: e.peerId,
      });
    });

    blobManager.on('transferProgress', (e: { hash: string; receivedBytes: number; totalSize: number; percentage: number }) => {
      this.updateTransfer(e.hash, {
        transferredBytes: e.receivedBytes,
        totalBytes: e.totalSize,
        status: 'active',
      });
    });

    blobManager.on('transferRetry', (e: { hash: string; newPeerId: string; attempt: number }) => {
      this.updateTransfer(e.hash, {
        status: 'retrying',
        retryCount: e.attempt,
        peerId: e.newPeerId,
      });
    });

    blobManager.on('transferWaiting', (e: { hash: string; reason: string; receivedBytes: number }) => {
      this.updateTransfer(e.hash, {
        status: 'waiting',
        errorMessage: e.reason,
      });
    });

    blobManager.on('transferFailed', (e: { hash: string; reason: string; receivedBytes: number; totalSize: number }) => {
      this.updateTransfer(e.hash, {
        status: 'failed',
        errorMessage: e.reason,
      });
      // Remove failed transfer after showing for 5 seconds
      setTimeout(() => this.removeTransfer(e.hash), 5000);
    });

    blobManager.on('transferComplete', (e: { hash: string; totalSize: number; duration: number; retries: number }) => {
      this.removeTransfer(e.hash);
      if (e.retries > 0) {
        new Notice(`File transferred after ${e.retries} retry(s)`);
      }
    });

    blobManager.on('transferHashMismatch', (e: { hash: string; retrying: boolean }) => {
      this.updateTransfer(e.hash, {
        status: 'retrying',
        errorMessage: 'Hash mismatch, redownloading...',
      });
    });
  }

  private updateTransfer(hash: string, updates: Partial<BlobTransferProgress>): void {
    const existing = this.transfers.get(hash) || {
      hash,
      fileName: this.getFileName(hash),
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      direction: 'download' as const,
      status: 'active' as const,
    };

    // Calculate speed
    if (updates.transferredBytes !== undefined && existing.transferredBytes > 0) {
      const byteDiff = updates.transferredBytes - existing.transferredBytes;
      updates.speed = byteDiff * 10; // Assuming ~100ms update interval
    }

    this.transfers.set(hash, { ...existing, ...updates });
    this.render();
  }

  private removeTransfer(hash: string): void {
    this.transfers.delete(hash);
    this.render();
  }

  show(parent: HTMLElement): void {
    this.containerEl = parent.createDiv({ cls: 'peervault-blob-transfers' });
    this.render();
  }

  private render(): void {
    if (!this.containerEl) return;
    this.containerEl.empty();

    if (this.transfers.size === 0) {
      this.containerEl.style.display = 'none';
      return;
    }

    this.containerEl.style.display = 'block';
    this.containerEl.createEl('h5', { text: 'File Transfers' });

    for (const transfer of this.transfers.values()) {
      this.renderTransfer(transfer);
    }
  }

  private renderTransfer(transfer: BlobTransferProgress): void {
    if (!this.containerEl) return;

    const item = this.containerEl.createDiv({
      cls: `blob-transfer-item status-${transfer.status}`
    });

    // File name, direction, and status
    const header = item.createDiv({ cls: 'transfer-header' });
    header.createSpan({
      text: transfer.direction === 'download' ? '↓' : '↑',
      cls: `transfer-direction ${transfer.direction}`
    });
    header.createSpan({ text: transfer.fileName, cls: 'transfer-filename' });

    // Status badge for non-active states
    if (transfer.status !== 'active') {
      const statusBadge = header.createSpan({ cls: `transfer-status-badge ${transfer.status}` });
      switch (transfer.status) {
        case 'stalled':
          statusBadge.setText('⏸️ Stalled');
          break;
        case 'retrying':
          statusBadge.setText(`🔄 Retry ${transfer.retryCount || 1}`);
          break;
        case 'waiting':
          statusBadge.setText('⏳ Waiting for peers');
          break;
        case 'failed':
          statusBadge.setText('❌ Failed');
          break;
      }
    }

    // Progress bar
    const progressContainer = item.createDiv({ cls: 'transfer-progress-container' });
    const progressBar = progressContainer.createDiv({ cls: 'transfer-progress-bar' });
    const percent = transfer.totalBytes > 0
      ? (transfer.transferredBytes / transfer.totalBytes) * 100
      : 0;
    progressBar.style.width = `${percent}%`;

    // Add animation class for retrying
    if (transfer.status === 'retrying') {
      progressBar.addClass('retrying');
    }

    // Stats
    const stats = item.createDiv({ cls: 'transfer-stats' });
    stats.createSpan({
      text: `${this.formatBytes(transfer.transferredBytes)} / ${this.formatBytes(transfer.totalBytes)}`
    });

    if (transfer.status === 'active' && transfer.speed > 0) {
      stats.createSpan({
        text: `${this.formatBytes(transfer.speed)}/s`
      });

      // ETA
      const remaining = transfer.totalBytes - transfer.transferredBytes;
      const etaSeconds = Math.ceil(remaining / transfer.speed);
      stats.createSpan({
        text: `ETA: ${this.formatEta(etaSeconds)}`
      });
    }

    // Error message
    if (transfer.errorMessage) {
      item.createDiv({
        text: transfer.errorMessage,
        cls: 'transfer-error-message'
      });
    }

    // Peer info
    if (transfer.peerName) {
      item.createDiv({
        text: `From: ${transfer.peerName}`,
        cls: 'transfer-peer-info'
      });
    }

    // Cancel button (only for active/stalled/retrying)
    if (['active', 'stalled', 'retrying'].includes(transfer.status)) {
      const cancelBtn = item.createEl('button', {
        text: '✕',
        cls: 'transfer-cancel-btn',
        attr: { title: 'Cancel transfer' }
      });
      cancelBtn.onclick = () => this.cancelTransfer(transfer.hash);
    }
  }

  private cancelTransfer(hash: string): void {
    this.plugin.blobSync.cancelTransfer(hash);
    this.removeTransfer(hash);
    new Notice('Transfer cancelled');
  }

  private getFileName(hash: string): string {
    // Try to resolve hash to file name from blob store
    const blobInfo = this.plugin.blobStore.getBlobInfo(hash);
    return blobInfo?.fileName || hash.slice(0, 8) + '...';
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private formatEta(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
}

// CSS for enhanced transfer progress
const BLOB_TRANSFER_CSS = `
.blob-transfer-item {
  padding: 8px;
  border-radius: 4px;
  margin-bottom: 8px;
  background: var(--background-secondary);
  position: relative;
}

.blob-transfer-item.status-stalled {
  border-left: 3px solid var(--text-warning);
}

.blob-transfer-item.status-retrying {
  border-left: 3px solid var(--text-accent);
}

.blob-transfer-item.status-waiting {
  border-left: 3px solid var(--text-muted);
}

.blob-transfer-item.status-failed {
  border-left: 3px solid var(--text-error);
  opacity: 0.7;
}

.transfer-status-badge {
  font-size: 0.8em;
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: 8px;
}

.transfer-status-badge.stalled {
  background: var(--text-warning);
  color: var(--text-on-accent);
}

.transfer-status-badge.retrying {
  background: var(--text-accent);
  color: var(--text-on-accent);
}

.transfer-status-badge.waiting {
  background: var(--background-modifier-border);
}

.transfer-status-badge.failed {
  background: var(--text-error);
  color: var(--text-on-accent);
}

.transfer-progress-bar.retrying {
  animation: progress-pulse 1s ease-in-out infinite;
}

@keyframes progress-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.transfer-error-message {
  font-size: 0.85em;
  color: var(--text-error);
  margin-top: 4px;
}

.transfer-peer-info {
  font-size: 0.8em;
  color: var(--text-muted);
  margin-top: 2px;
}

.transfer-cancel-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}

.transfer-cancel-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-error);
}
`;
```

#### Status Bar Progress

```typescript
class StatusBarProgress {
  private statusBarItem: HTMLElement;
  private isActive = false;

  constructor(private plugin: Plugin) {
    this.statusBarItem = plugin.addStatusBarItem();
    this.statusBarItem.addClass('peervault-progress-status');
    this.hide();
  }

  showProgress(message: string, percent?: number): void {
    this.isActive = true;
    this.statusBarItem.style.display = 'inline-flex';
    this.statusBarItem.empty();

    // Spinner
    this.statusBarItem.createSpan({ cls: 'peervault-spinner' });

    // Message
    this.statusBarItem.createSpan({ text: message, cls: 'progress-message' });

    // Optional percent
    if (percent !== undefined) {
      this.statusBarItem.createSpan({
        text: `${Math.round(percent)}%`,
        cls: 'progress-percent'
      });
    }
  }

  hide(): void {
    this.isActive = false;
    this.statusBarItem.style.display = 'none';
  }

  isShowing(): boolean {
    return this.isActive;
  }
}

// CSS for progress components
const PROGRESS_CSS = `
.peervault-progress-item {
  padding: 8px;
  margin: 4px 0;
  border-radius: 4px;
  background: var(--background-secondary);
}

.progress-bar-container {
  height: 4px;
  background: var(--background-modifier-border);
  border-radius: 2px;
  margin: 8px 0;
}

.progress-bar {
  height: 100%;
  background: var(--interactive-accent);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.phase-badge {
  font-size: 0.8em;
  padding: 2px 6px;
  border-radius: 3px;
}

.phase-syncing { background: var(--interactive-accent); color: white; }
.phase-complete { background: var(--text-success); color: white; }
.phase-error { background: var(--text-error); color: white; }

.peervault-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--background-modifier-border);
  border-top-color: var(--interactive-accent);
  border-radius: 50%;
  animation: peervault-spin 1s linear infinite;
  margin-right: 6px;
}

@keyframes peervault-spin {
  to { transform: rotate(360deg); }
}
`;
```

### Long Sync Cancellation UI

When a sync takes longer than expected, provide the user with status information and the ability to cancel.

```typescript
interface LongSyncInfo {
  /** When sync started */
  startTime: number;

  /** Current operation */
  operation: 'sending' | 'receiving' | 'merging' | 'writing';

  /** Files processed */
  filesProcessed: number;

  /** Total files to process (if known) */
  totalFiles?: number;

  /** Bytes transferred */
  bytesTransferred: number;

  /** Peer we're syncing with */
  peerId: string;
}

class LongSyncCancellationUI {
  private modal: Modal | null = null;
  private readonly LONG_SYNC_THRESHOLD_MS = 30_000; // 30 seconds
  private checkInterval: number | null = null;

  constructor(
    private app: App,
    private syncEngine: SyncEngine
  ) {
    this.startMonitoring();
  }

  private startMonitoring(): void {
    this.checkInterval = window.setInterval(() => {
      this.checkForLongSync();
    }, 5000);
  }

  private checkForLongSync(): void {
    const activeSyncs = this.syncEngine.getActiveSyncs();

    for (const sync of activeSyncs) {
      const duration = Date.now() - sync.startTime;

      if (duration > this.LONG_SYNC_THRESHOLD_MS && !this.modal) {
        this.showCancellationModal(sync);
      }
    }
  }

  private showCancellationModal(sync: LongSyncInfo): void {
    this.modal = new Modal(this.app);
    const { contentEl } = this.modal;

    contentEl.addClass('peervault-long-sync-modal');
    contentEl.createEl('h2', { text: 'Sync in Progress' });

    // Progress info
    const infoContainer = contentEl.createDiv({ cls: 'sync-info' });

    const updateInfo = () => {
      const current = this.syncEngine.getActiveSync(sync.peerId);
      if (!current) {
        this.modal?.close();
        this.modal = null;
        return;
      }

      infoContainer.empty();

      // Duration
      const duration = Date.now() - current.startTime;
      infoContainer.createDiv({
        text: `Duration: ${this.formatDuration(duration)}`,
        cls: 'sync-duration',
      });

      // Operation
      const operationLabels = {
        sending: 'Sending changes...',
        receiving: 'Receiving changes...',
        merging: 'Merging documents...',
        writing: 'Writing files...',
      };
      infoContainer.createDiv({
        text: operationLabels[current.operation],
        cls: 'sync-operation',
      });

      // Progress
      if (current.totalFiles) {
        const percent = (current.filesProcessed / current.totalFiles) * 100;
        infoContainer.createDiv({
          text: `${current.filesProcessed} / ${current.totalFiles} files (${Math.round(percent)}%)`,
          cls: 'sync-progress',
        });
      } else {
        infoContainer.createDiv({
          text: `${current.filesProcessed} files processed`,
          cls: 'sync-progress',
        });
      }

      // Bytes transferred
      infoContainer.createDiv({
        text: `${this.formatBytes(current.bytesTransferred)} transferred`,
        cls: 'sync-bytes',
      });
    };

    updateInfo();
    const updateInterval = window.setInterval(updateInfo, 1000);

    // Warning
    contentEl.createEl('p', {
      text: 'Large syncs may take several minutes. You can cancel if needed, but some changes may not be synced.',
      cls: 'sync-warning',
    });

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: 'sync-buttons' });

    new ButtonComponent(buttonContainer)
      .setButtonText('Continue in Background')
      .onClick(() => {
        window.clearInterval(updateInterval);
        this.modal?.close();
        this.modal = null;
      });

    new ButtonComponent(buttonContainer)
      .setButtonText('Cancel Sync')
      .setWarning()
      .onClick(async () => {
        window.clearInterval(updateInterval);
        await this.syncEngine.cancelSync(sync.peerId);
        new Notice('Sync cancelled. Some changes may not have been synced.');
        this.modal?.close();
        this.modal = null;
      });

    // Store cleanup function to call when modal closes
    const cleanup = () => {
      window.clearInterval(updateInterval);
      this.modal = null;
    };

    // Override close to include cleanup
    const originalClose = this.modal.close.bind(this.modal);
    this.modal.close = () => {
      cleanup();
      originalClose();
    };

    this.modal.open();
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  destroy(): void {
    if (this.checkInterval) {
      window.clearInterval(this.checkInterval);
    }
    this.modal?.close();
  }
}
```

### Peer Unreachable Feedback

Provide clear feedback when a peer cannot be reached.

```typescript
interface PeerConnectionStatus {
  peerId: string;
  peerName: string;
  status: 'connected' | 'connecting' | 'unreachable' | 'offline';
  lastSeen?: number;
  lastError?: string;
  retryCount: number;
}

class PeerUnreachableFeedback {
  private statusMap = new Map<string, HTMLElement>();
  private readonly UNREACHABLE_THRESHOLD_MS = 30_000;

  constructor(
    private app: App,
    private peerManager: PeerManager,
    private transport: IrohTransport
  ) {
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.transport.on('connectionFailed', (event) => {
      this.showUnreachableNotice(event.peerId, event.error);
    });

    this.transport.on('connectionRestored', (event) => {
      this.showRestoredNotice(event.peerId);
    });

    this.peerManager.on('peerStatusChanged', (event) => {
      this.updatePeerStatusIndicator(event);
    });
  }

  /**
   * Show notice when peer becomes unreachable.
   */
  private showUnreachableNotice(peerId: string, error: string): void {
    const peer = this.peerManager.getPeer(peerId);
    const peerName = peer?.name || 'Unknown peer';

    // Determine error message based on error type
    let message: string;
    let suggestion: string;

    if (error.includes('timeout')) {
      message = `${peerName} is not responding`;
      suggestion = 'They may be offline or on a slow network.';
    } else if (error.includes('refused')) {
      message = `Connection to ${peerName} was refused`;
      suggestion = 'They may have removed you from their peer list.';
    } else if (error.includes('relay')) {
      message = `Cannot reach ${peerName} through relay`;
      suggestion = 'Relay servers may be unavailable. Try again later.';
    } else {
      message = `Cannot connect to ${peerName}`;
      suggestion = 'Check your network connection.';
    }

    // Show notice
    const notice = new Notice(
      createFragment((frag) => {
        frag.createEl('strong', { text: message });
        frag.createEl('br');
        frag.createEl('span', { text: suggestion, cls: 'notice-suggestion' });
      }),
      10_000
    );
  }

  /**
   * Show notice when connection is restored.
   */
  private showRestoredNotice(peerId: string): void {
    const peer = this.peerManager.getPeer(peerId);
    const peerName = peer?.name || 'Unknown peer';

    new Notice(`Reconnected to ${peerName}`, 3000);
  }

  /**
   * Update peer status indicator in UI.
   */
  updatePeerStatusIndicator(status: PeerConnectionStatus): void {
    const { peerId, status: connStatus, lastSeen, retryCount } = status;

    // Status badge classes
    const statusClasses = {
      connected: 'peer-status-connected',
      connecting: 'peer-status-connecting',
      unreachable: 'peer-status-unreachable',
      offline: 'peer-status-offline',
    };

    // Status icons/text
    const statusLabels = {
      connected: 'Connected',
      connecting: 'Connecting...',
      unreachable: 'Unreachable',
      offline: 'Offline',
    };

    // Find or create status element
    let statusEl = this.statusMap.get(peerId);
    if (!statusEl) {
      // Will be created by peer list component
      return;
    }

    // Update status
    statusEl.empty();
    statusEl.removeClass(...Object.values(statusClasses));
    statusEl.addClass(statusClasses[connStatus]);

    // Icon
    const icon = connStatus === 'connected' ? 'check-circle' :
                 connStatus === 'connecting' ? 'loader' :
                 connStatus === 'unreachable' ? 'alert-circle' : 'x-circle';
    setIcon(statusEl.createSpan({ cls: 'status-icon' }), icon);

    // Label
    statusEl.createSpan({ text: statusLabels[connStatus], cls: 'status-label' });

    // Additional info for unreachable
    if (connStatus === 'unreachable' && lastSeen) {
      const ago = this.formatTimeAgo(lastSeen);
      statusEl.createSpan({
        text: `(last seen ${ago})`,
        cls: 'status-last-seen',
      });

      if (retryCount > 0) {
        statusEl.createSpan({
          text: `[retry ${retryCount}]`,
          cls: 'status-retry',
        });
      }
    }
  }

  private formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  /**
   * Register a status element for a peer.
   */
  registerStatusElement(peerId: string, element: HTMLElement): void {
    this.statusMap.set(peerId, element);
  }

  /**
   * Unregister when peer is removed.
   */
  unregisterStatusElement(peerId: string): void {
    this.statusMap.delete(peerId);
  }
}
```

#### CSS for Peer Status

```css
.peer-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-ui-small);
  padding: 2px 8px;
  border-radius: 12px;
}

.peer-status-connected {
  background: var(--background-modifier-success);
  color: var(--text-success);
}

.peer-status-connecting {
  background: var(--background-modifier-border);
  color: var(--text-muted);
}

.peer-status-connecting .status-icon {
  animation: peervault-spin 1s linear infinite;
}

.peer-status-unreachable {
  background: var(--background-modifier-error);
  color: var(--text-error);
}

.peer-status-offline {
  background: var(--background-modifier-border);
  color: var(--text-faint);
}

.status-last-seen {
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
  margin-left: 4px;
}

.status-retry {
  font-size: var(--font-ui-smaller);
  color: var(--text-accent);
  margin-left: 4px;
}
```

#### Retry Strategy Display

```typescript
class RetryStrategyDisplay {
  /**
   * Show retry countdown in peer status.
   */
  showRetryCountdown(
    statusEl: HTMLElement,
    nextRetryMs: number
  ): () => void {
    const countdown = statusEl.createSpan({ cls: 'retry-countdown' });

    const updateCountdown = () => {
      const remaining = nextRetryMs - Date.now();
      if (remaining <= 0) {
        countdown.setText('Retrying...');
      } else {
        countdown.setText(`Retry in ${Math.ceil(remaining / 1000)}s`);
      }
    };

    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1000);

    // Return cleanup function
    return () => {
      window.clearInterval(interval);
      countdown.remove();
    };
  }

  /**
   * Show manual retry button.
   */
  showManualRetryButton(
    container: HTMLElement,
    peerId: string,
    transport: IrohTransport
  ): void {
    const button = new ButtonComponent(container)
      .setButtonText('Retry Now')
      .setClass('retry-button')
      .onClick(async () => {
        button.setDisabled(true);
        button.setButtonText('Connecting...');

        try {
          await transport.reconnect(peerId);
          button.buttonEl.remove();
        } catch (error) {
          button.setButtonText('Retry Failed');
          setTimeout(() => {
            button.setButtonText('Retry Now');
            button.setDisabled(false);
          }, 2000);
        }
      });
  }
}
```

### 4. Add Device Modal (QR Code)

Display QR code for pairing.

```typescript
class AddDeviceModal extends Modal {
  private ticket: string = '';

  async onOpen(): Promise<void> {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Add Device' });
    contentEl.createEl('p', {
      text: 'Scan this QR code from another device running PeerVault'
    });

    // Generate ticket
    this.ticket = await this.plugin.transport.generateTicket();

    // QR Code container
    const qrContainer = contentEl.createDiv({ cls: 'peervault-qr' });

    // Use qrcode library to generate QR
    QRCode.toCanvas(qrContainer, this.ticket, {
      width: 256,
      margin: 2,
    });

    // Copy button
    new Setting(contentEl)
      .setName('Or copy ticket')
      .addButton(btn => btn
        .setButtonText('Copy')
        .onClick(() => {
          navigator.clipboard.writeText(this.ticket);
          new Notice('Ticket copied to clipboard');
        })
      );

    // Waiting indicator
    contentEl.createEl('p', {
      text: 'Waiting for connection...',
      cls: 'peervault-waiting'
    });

    // Listen for incoming connection
    this.plugin.transport.onIncomingConnection((conn) => {
      this.handleConnection(conn);
    });
  }

  private async handleConnection(conn: PeerConnection): Promise<void> {
    // Prompt for peer name
    const name = await this.promptPeerName();

    await this.plugin.peerManager.addPeer(this.ticket, name);

    new Notice(`Connected to ${name}`);
    this.close();
  }
}
```

### 4. Join Device Modal

Enter ticket to join another device.

```typescript
class JoinDeviceModal extends Modal {
  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Join Device' });
    contentEl.createEl('p', {
      text: 'Enter the ticket from another device'
    });

    let ticketInput: TextAreaComponent;
    let nameInput: TextComponent;

    new Setting(contentEl)
      .setName('Ticket')
      .addTextArea(text => {
        ticketInput = text;
        text.setPlaceholder('Paste ticket here...');
      });

    new Setting(contentEl)
      .setName('Device Name')
      .addText(text => {
        nameInput = text;
        text.setPlaceholder('e.g., MacBook Pro');
      });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('Connect')
        .setCta()
        .onClick(() => this.connect(ticketInput.getValue(), nameInput.getValue()))
      );
  }

  private async connect(ticket: string, name: string): Promise<void> {
    if (!ticket || !name) {
      new Notice('Please enter both ticket and name');
      return;
    }

    try {
      await this.plugin.peerManager.addPeer(ticket, name);
      new Notice(`Connected to ${name}`);
      this.close();
    } catch (err) {
      new Notice(`Connection failed: ${err.message}`);
    }
  }
}
```

### 5. Document History View

Show version history for a file using Loro's time travel capabilities.

```typescript
import { LoroDoc, type OpId, type Change } from 'loro-crdt';

interface VersionEntry {
  /** Version frontiers (OpId array for checkout) */
  frontiers: OpId[];
  /** Timestamp of the change (Unix seconds) */
  timestamp: number;
  /** Peer ID that made the change */
  peerId: string;
  /** Lamport timestamp for causal ordering */
  lamport: number;
}

class HistoryView extends ItemView {
  static VIEW_TYPE = 'peervault-history';

  private filePath: string | null = null;

  getViewType(): string {
    return HistoryView.VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Document History';
  }

  async showHistory(filePath: string): Promise<void> {
    this.filePath = filePath;
    const container = this.containerEl.children[1];
    container.empty();

    container.createEl('h3', { text: `History: ${filePath}` });

    const doc = this.plugin.syncEngine.getDoc();
    const nodeId = this.plugin.syncEngine.getNodeIdForPath(filePath);

    if (!nodeId) {
      container.createEl('p', { text: 'No sync history for this file' });
      return;
    }

    // Get version history for this file
    const versions = await this.getFileVersions(doc, nodeId);

    if (versions.length === 0) {
      container.createEl('p', { text: 'No version history available' });
      return;
    }

    const list = container.createEl('ul', { cls: 'peervault-history-list' });

    for (const version of versions) {
      const item = list.createEl('li');

      const time = new Date(version.timestamp).toLocaleString();
      const peer = version.peerId.substring(0, 8);

      item.createEl('span', { text: time, cls: 'history-time' });
      item.createEl('span', { text: ` by ${peer}`, cls: 'history-actor' });
      if (version.description) {
        item.createEl('span', { text: ` - ${version.description}`, cls: 'history-desc' });
      }

      // Preview button
      const previewBtn = item.createEl('button', { text: 'Preview' });
      previewBtn.onclick = () => this.previewVersion(version);

      // Restore button
      const restoreBtn = item.createEl('button', { text: 'Restore' });
      restoreBtn.onclick = () => this.restoreVersion(version);
    }
  }

  private async getFileVersions(doc: LoroDoc, nodeId: string): Promise<VersionEntry[]> {
    // Loro tracks changes via version vectors
    // We can checkout to any past version using frontiers
    const versions: VersionEntry[] = [];

    // Get change history from Loro
    // getAllChanges() returns Map<PeerID, Change[]>
    const changes = doc.getAllChanges();

    // Iterate over the Map entries
    for (const [peerId, peerChanges] of changes.entries()) {
      for (const change of peerChanges) {
        // Construct frontiers from change position
        // Frontiers point to the end of this change (counter + length - 1)
        const frontiers: OpId[] = [
          { peer: change.peer, counter: change.counter + change.length - 1 }
        ];

        versions.push({
          frontiers,
          timestamp: change.timestamp,
          peerId,
          lamport: change.lamport,
        });
      }
    }

    // Sort by lamport (causal order), then timestamp
    versions.sort((a, b) => {
      if (a.lamport !== b.lamport) return b.lamport - a.lamport;
      return b.timestamp - a.timestamp;
    });

    return versions;
  }

  private async previewVersion(version: VersionEntry): Promise<void> {
    const doc = this.plugin.syncEngine.getDoc();

    // Clone the document and checkout to historical version
    // Note: checkout() returns void and makes doc "detached", so we clone first
    const snapshot = doc.export({ mode: "snapshot" });
    const historicalDoc = new LoroDoc();
    historicalDoc.import(snapshot);
    historicalDoc.checkout(version.frontiers);

    // Get file content at that version
    const content = this.getFileContentAtVersion(historicalDoc, this.filePath!);

    // Show in preview modal
    new VersionPreviewModal(this.app, this.filePath!, content, version).open();
  }

  private async restoreVersion(version: VersionEntry): Promise<void> {
    const doc = this.plugin.syncEngine.getDoc();

    // Clone and checkout to get content at historical version
    const snapshot = doc.export({ mode: "snapshot" });
    const historicalDoc = new LoroDoc();
    historicalDoc.import(snapshot);
    historicalDoc.checkout(version.frontiers);
    const oldContent = this.getFileContentAtVersion(historicalDoc, this.filePath!);

    // Apply as new change (preserves history)
    const nodeId = this.plugin.syncEngine.getNodeIdForPath(this.filePath!);
    const files = doc.getTree('files');
    const nodeData = files.getMeta(nodeId);
    const contentText = nodeData.get('content') as LoroText;

    // Replace content with historical version
    doc.transact(() => {
      contentText.delete(0, contentText.length);
      contentText.insert(0, oldContent);
    });

    new Notice(`Restored ${this.filePath} to version from ${new Date(version.timestamp).toLocaleString()}`);
  }

  private getFileContentAtVersion(doc: LoroDoc, path: string): string {
    // Navigate tree to find file and get content
    const nodeId = this.findNodeByPath(doc, path);
    if (!nodeId) return '';

    const files = doc.getTree('files');
    const nodeData = files.getMeta(nodeId);
    const content = nodeData.get('content') as LoroText;

    return content?.toString() ?? '';
  }

  private describeChange(change: Change): string {
    // Use change message if available, otherwise describe based on length
    if (change.message) return change.message;

    // The Change interface provides: peer, counter, lamport, length, timestamp, deps
    // We can only infer basic info from the operation count
    if (change.length > 10) return 'multiple edits';
    if (change.length > 1) return 'edited';
    return 'modified';
  }
}

class VersionPreviewModal extends Modal {
  constructor(
    app: App,
    private filePath: string,
    private content: string,
    private version: VersionEntry
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: `Preview: ${this.filePath}` });
    contentEl.createEl('p', {
      text: `Version from ${new Date(this.version.timestamp).toLocaleString()}`,
      cls: 'version-info'
    });

    const preview = contentEl.createEl('pre', { cls: 'version-preview' });
    preview.createEl('code', { text: this.content });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

## Commands

Register Obsidian commands:

```typescript
plugin.addCommand({
  id: 'show-peer-panel',
  name: 'Show peer management',
  callback: () => this.showPeerPanel(),
});

plugin.addCommand({
  id: 'show-file-history',
  name: 'Show sync history for current file',
  editorCallback: (editor, view) => {
    this.showHistoryForFile(view.file?.path);
  },
});

plugin.addCommand({
  id: 'force-sync',
  name: 'Force sync now',
  callback: () => this.syncEngine.syncAll(),
});
```

### 6. First-Run Setup Wizard

Guide new users through initial configuration on first launch.

```typescript
interface WizardStep {
  id: string;
  title: string;
  description: string;
  component: (container: HTMLElement) => void;
  validate?: () => boolean | Promise<boolean>;
}

class FirstRunWizard extends Modal {
  private currentStep = 0;
  private steps: WizardStep[] = [];
  private userData: Record<string, unknown> = {};

  constructor(app: App, private plugin: PeerVaultPlugin) {
    super(app);
    this.initializeSteps();
  }

  private initializeSteps(): void {
    this.steps = [
      {
        id: 'welcome',
        title: 'Welcome to PeerVault',
        description: 'Sync your vault between devices without a server',
        component: (container) => this.renderWelcome(container),
      },
      {
        id: 'device-name',
        title: 'Name This Device',
        description: 'Give this device a name for identification',
        component: (container) => this.renderDeviceName(container),
        validate: () => Boolean(this.userData.deviceName),
      },
      {
        id: 'sync-choice',
        title: 'Setup Method',
        description: 'Are you adding this vault to an existing sync or starting new?',
        component: (container) => this.renderSyncChoice(container),
      },
      {
        id: 'encryption',
        title: 'Enable Encryption',
        description: 'Protect your vault with a passphrase (optional)',
        component: (container) => this.renderEncryption(container),
      },
      {
        id: 'complete',
        title: 'Setup Complete!',
        description: 'PeerVault is ready to use',
        component: (container) => this.renderComplete(container),
      },
    ];
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass('peervault-wizard');
    this.renderCurrentStep();
  }

  private renderCurrentStep(): void {
    const { contentEl } = this;
    contentEl.empty();

    const step = this.steps[this.currentStep];

    // Progress indicator
    const progressContainer = contentEl.createDiv({ cls: 'wizard-progress' });
    for (let i = 0; i < this.steps.length; i++) {
      const dot = progressContainer.createSpan({ cls: 'progress-dot' });
      if (i < this.currentStep) dot.addClass('completed');
      if (i === this.currentStep) dot.addClass('current');
    }

    // Step content
    contentEl.createEl('h2', { text: step.title });
    contentEl.createEl('p', { text: step.description, cls: 'wizard-desc' });

    const stepContainer = contentEl.createDiv({ cls: 'wizard-step-content' });
    step.component(stepContainer);

    // Navigation buttons
    const nav = contentEl.createDiv({ cls: 'wizard-nav' });

    if (this.currentStep > 0) {
      const backBtn = nav.createEl('button', { text: 'Back', cls: 'wizard-back' });
      backBtn.onclick = () => this.goBack();
    }

    if (this.currentStep < this.steps.length - 1) {
      const nextBtn = nav.createEl('button', { text: 'Next', cls: 'wizard-next mod-cta' });
      nextBtn.onclick = () => this.goNext();
    } else {
      const finishBtn = nav.createEl('button', { text: 'Get Started', cls: 'wizard-finish mod-cta' });
      finishBtn.onclick = () => this.finish();
    }
  }

  private async goNext(): Promise<void> {
    const step = this.steps[this.currentStep];

    // Validate current step
    if (step.validate) {
      const isValid = await step.validate();
      if (!isValid) return;
    }

    this.currentStep++;
    this.renderCurrentStep();
  }

  private goBack(): void {
    if (this.currentStep > 0) {
      this.currentStep--;
      this.renderCurrentStep();
    }
  }

  private async finish(): Promise<void> {
    // Save configuration
    await this.applyConfiguration();

    // Mark wizard as completed
    await this.plugin.updateSettings({ wizardCompleted: true });

    this.close();
    new Notice('PeerVault is ready!');
  }

  // Step renderers

  private renderWelcome(container: HTMLElement): void {
    container.createEl('div', { cls: 'wizard-welcome' });

    const features = [
      'Sync your vault between all your devices',
      'No central server - direct peer-to-peer',
      'Conflict-free merging with CRDTs',
      'Full edit history preserved',
    ];

    const list = container.createEl('ul', { cls: 'feature-list' });
    for (const feature of features) {
      list.createEl('li', { text: feature });
    }
  }

  private renderDeviceName(container: HTMLElement): void {
    const input = container.createEl('input', {
      type: 'text',
      placeholder: 'e.g., MacBook Pro, iPhone, Home PC',
      cls: 'wizard-input',
    });

    input.value = (this.userData.deviceName as string) || '';
    input.oninput = () => {
      this.userData.deviceName = input.value;
    };

    container.createEl('p', {
      text: 'This name will be visible to other devices you sync with.',
      cls: 'wizard-hint',
    });
  }

  private renderSyncChoice(container: HTMLElement): void {
    const choices = [
      {
        id: 'new',
        title: 'Start New Sync',
        desc: 'This is my first device using PeerVault for this vault',
      },
      {
        id: 'join',
        title: 'Join Existing Sync',
        desc: 'I have another device already syncing this vault',
      },
    ];

    for (const choice of choices) {
      const card = container.createDiv({ cls: 'wizard-choice-card' });
      const radio = card.createEl('input', {
        type: 'radio',
        attr: { name: 'sync-choice', value: choice.id },
      });

      if (this.userData.syncChoice === choice.id) {
        radio.checked = true;
      }

      radio.onchange = () => {
        this.userData.syncChoice = choice.id;
      };

      card.createEl('strong', { text: choice.title });
      card.createEl('p', { text: choice.desc });
    }
  }

  private renderEncryption(container: HTMLElement): void {
    const toggle = new Setting(container)
      .setName('Enable vault encryption')
      .setDesc('Encrypt sync data with a passphrase')
      .addToggle(t => {
        t.setValue(Boolean(this.userData.encryptionEnabled));
        t.onChange(value => {
          this.userData.encryptionEnabled = value;
          passphraseContainer.style.display = value ? 'block' : 'none';
        });
      });

    const passphraseContainer = container.createDiv({ cls: 'passphrase-inputs' });
    passphraseContainer.style.display = this.userData.encryptionEnabled ? 'block' : 'none';

    const passInput = passphraseContainer.createEl('input', {
      type: 'password',
      placeholder: 'Enter passphrase (min 8 characters)',
    });

    const confirmInput = passphraseContainer.createEl('input', {
      type: 'password',
      placeholder: 'Confirm passphrase',
    });

    passInput.oninput = () => { this.userData.passphrase = passInput.value; };
    confirmInput.oninput = () => { this.userData.passphraseConfirm = confirmInput.value; };

    container.createEl('p', {
      text: 'If enabled, you will need to enter this passphrase each time you start Obsidian.',
      cls: 'wizard-warning',
    });
  }

  private renderComplete(container: HTMLElement): void {
    container.createEl('p', { text: 'Your PeerVault configuration:' });

    const summary = container.createEl('ul', { cls: 'setup-summary' });
    summary.createEl('li', { text: `Device name: ${this.userData.deviceName}` });
    summary.createEl('li', {
      text: this.userData.syncChoice === 'join'
        ? 'Joining existing sync'
        : 'Starting new sync',
    });
    summary.createEl('li', {
      text: this.userData.encryptionEnabled
        ? 'Encryption: Enabled'
        : 'Encryption: Disabled',
    });

    if (this.userData.syncChoice === 'join') {
      container.createEl('p', {
        text: 'After setup, go to Settings > PeerVault > Add Device to pair with your other devices.',
        cls: 'wizard-next-step',
      });
    } else {
      container.createEl('p', {
        text: 'Your vault is ready! Install PeerVault on other devices and pair them to start syncing.',
        cls: 'wizard-next-step',
      });
    }
  }

  private async applyConfiguration(): Promise<void> {
    // Apply device name
    if (this.userData.deviceName) {
      await this.plugin.updateSettings({
        deviceName: this.userData.deviceName as string,
      });
    }

    // Apply encryption if enabled
    if (this.userData.encryptionEnabled && this.userData.passphrase) {
      await this.plugin.storage.enableEncryption(this.userData.passphrase as string);
    }

    // Initialize sync based on choice
    if (this.userData.syncChoice === 'new') {
      await this.plugin.syncEngine.initializeNewVault();
    }
    // For 'join', user will manually add peer after wizard
  }
}

// CSS for wizard
const WIZARD_CSS = `
.peervault-wizard {
  max-width: 500px;
}

.wizard-progress {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 20px;
}

.progress-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--background-modifier-border);
}

.progress-dot.completed { background: var(--text-success); }
.progress-dot.current { background: var(--interactive-accent); }

.wizard-choice-card {
  padding: 12px;
  margin: 8px 0;
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  cursor: pointer;
}

.wizard-choice-card:hover {
  border-color: var(--interactive-accent);
}

.wizard-nav {
  display: flex;
  justify-content: space-between;
  margin-top: 24px;
}

.wizard-warning {
  color: var(--text-muted);
  font-size: 0.9em;
}

.feature-list li {
  margin: 8px 0;
}
`;

// Show wizard on first run
async function checkFirstRun(plugin: PeerVaultPlugin): Promise<void> {
  const settings = await plugin.loadData();

  if (!settings?.wizardCompleted) {
    new FirstRunWizard(plugin.app, plugin).open();
  }
}
```

### 7. Conflict Visualization UI

When concurrent edits result in merged content, show users what changed and where the merge occurred.

```typescript
interface MergeConflict {
  filePath: string;
  localContent: string;
  remoteContent: string;
  mergedContent: string;
  conflictRegions: ConflictRegion[];
  timestamp: number;
  remotePeerId: string;
  remotePeerName: string;
}

interface ConflictRegion {
  startLine: number;
  endLine: number;
  localText: string;
  remoteText: string;
  mergedText: string;
  type: 'insertion' | 'deletion' | 'modification';
}

class ConflictNotificationManager {
  private recentConflicts: MergeConflict[] = [];
  private readonly MAX_RECENT = 10;

  constructor(private plugin: PeerVaultPlugin) {
    // Subscribe to merge events
    this.plugin.syncEngine.on('merge-complete', this.onMerge.bind(this));
  }

  private onMerge(event: MergeEvent): void {
    if (event.hadConcurrentChanges) {
      const conflict = this.analyzeConflict(event);
      this.recentConflicts.unshift(conflict);

      // Trim old conflicts
      if (this.recentConflicts.length > this.MAX_RECENT) {
        this.recentConflicts.pop();
      }

      // Show notification
      this.showConflictNotice(conflict);
    }
  }

  private showConflictNotice(conflict: MergeConflict): void {
    const notice = new Notice(
      `Merged changes in "${conflict.filePath}" from ${conflict.remotePeerName}. ` +
      `Click to review.`,
      10000
    );

    // Make notice clickable
    notice.noticeEl.onclick = () => {
      this.showConflictDetail(conflict);
    };
  }

  private showConflictDetail(conflict: MergeConflict): void {
    new ConflictDetailModal(this.plugin.app, conflict).open();
  }

  getRecentConflicts(): MergeConflict[] {
    return [...this.recentConflicts];
  }
}

class ConflictDetailModal extends Modal {
  constructor(app: App, private conflict: MergeConflict) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('peervault-conflict-modal');

    contentEl.createEl('h2', { text: 'Merged Changes' });

    // File info
    const info = contentEl.createDiv({ cls: 'conflict-info' });
    info.createEl('strong', { text: this.conflict.filePath });
    info.createEl('span', {
      text: ` - Merged ${new Date(this.conflict.timestamp).toLocaleString()}`,
    });
    info.createEl('span', {
      text: ` with ${this.conflict.remotePeerName}`,
      cls: 'peer-name',
    });

    // Summary
    contentEl.createEl('p', {
      text: `${this.conflict.conflictRegions.length} region(s) had concurrent changes`,
      cls: 'conflict-summary',
    });

    // Diff view
    const diffContainer = contentEl.createDiv({ cls: 'conflict-diff' });
    this.renderDiff(diffContainer);

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'conflict-actions' });

    actions.createEl('button', {
      text: 'Open File',
      cls: 'mod-cta',
    }).onclick = () => {
      this.app.workspace.openLinkText(this.conflict.filePath, '');
      this.close();
    };

    actions.createEl('button', {
      text: 'View History',
    }).onclick = () => {
      this.plugin.showHistoryForFile(this.conflict.filePath);
      this.close();
    };

    actions.createEl('button', {
      text: 'Dismiss',
    }).onclick = () => this.close();
  }

  private renderDiff(container: HTMLElement): void {
    // Three-column view: Local | Merged | Remote
    const columns = container.createDiv({ cls: 'diff-columns' });

    const localCol = columns.createDiv({ cls: 'diff-column local' });
    localCol.createEl('h4', { text: 'Your Changes' });

    const mergedCol = columns.createDiv({ cls: 'diff-column merged' });
    mergedCol.createEl('h4', { text: 'Merged Result' });

    const remoteCol = columns.createDiv({ cls: 'diff-column remote' });
    remoteCol.createEl('h4', { text: `${this.conflict.remotePeerName}'s Changes` });

    // Render each conflict region
    for (const region of this.conflict.conflictRegions) {
      this.renderConflictRegion(localCol, region.localText, 'local');
      this.renderConflictRegion(mergedCol, region.mergedText, 'merged');
      this.renderConflictRegion(remoteCol, region.remoteText, 'remote');
    }
  }

  private renderConflictRegion(
    container: HTMLElement,
    text: string,
    type: string
  ): void {
    const region = container.createDiv({ cls: `diff-region ${type}` });

    // Syntax highlight if markdown
    const pre = region.createEl('pre');
    const code = pre.createEl('code');
    code.setText(text || '(no changes)');

    if (!text) {
      region.addClass('empty');
    }
  }
}

// CSS for conflict UI
const CONFLICT_CSS = `
.peervault-conflict-modal {
  min-width: 700px;
}

.conflict-info {
  margin: 12px 0;
  padding: 8px;
  background: var(--background-secondary);
  border-radius: 4px;
}

.conflict-summary {
  color: var(--text-muted);
}

.diff-columns {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
  max-height: 400px;
  overflow-y: auto;
}

.diff-column {
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
  padding: 8px;
}

.diff-column h4 {
  margin: 0 0 8px 0;
  font-size: 0.9em;
  color: var(--text-muted);
}

.diff-column.local { border-top: 3px solid var(--color-blue); }
.diff-column.merged { border-top: 3px solid var(--color-green); }
.diff-column.remote { border-top: 3px solid var(--color-orange); }

.diff-region {
  margin: 4px 0;
  padding: 4px;
  font-size: 0.85em;
  background: var(--background-primary);
  border-radius: 2px;
}

.diff-region.empty {
  color: var(--text-muted);
  font-style: italic;
}

.conflict-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  justify-content: flex-end;
}
`;
```

### Inline Conflict Markers in Editor

Show subtle indicators in the editor gutter for recently merged regions:

```typescript
import { EditorView, Decoration, DecorationSet, ViewPlugin } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';

interface MergeMarker {
  line: number;
  peerName: string;
  timestamp: number;
}

const addMergeMarker = StateEffect.define<MergeMarker>();
const clearMergeMarkers = StateEffect.define<null>();

const mergeMarkerField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(markers, tr) {
    markers = markers.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(addMergeMarker)) {
        const marker = effect.value;
        const deco = Decoration.line({
          class: 'peervault-merge-line',
          attributes: {
            'data-peer': marker.peerName,
            'data-time': marker.timestamp.toString(),
          },
        });
        markers = markers.update({
          add: [deco.range(tr.state.doc.line(marker.line).from)],
        });
      }
      if (effect.is(clearMergeMarkers)) {
        markers = Decoration.none;
      }
    }

    return markers;
  },
  provide: f => EditorView.decorations.from(f),
});

/**
 * Show merge indicators in editor.
 */
class EditorMergeIndicator {
  constructor(private plugin: PeerVaultPlugin) {}

  /**
   * Mark lines that were merged from another peer.
   */
  showMergeLines(view: EditorView, regions: ConflictRegion[], peerName: string): void {
    const effects: StateEffect<MergeMarker>[] = [];

    for (const region of regions) {
      for (let line = region.startLine; line <= region.endLine; line++) {
        effects.push(addMergeMarker.of({
          line,
          peerName,
          timestamp: Date.now(),
        }));
      }
    }

    view.dispatch({ effects });

    // Auto-clear after 30 seconds
    setTimeout(() => {
      view.dispatch({ effects: [clearMergeMarkers.of(null)] });
    }, 30000);
  }
}

// CSS for editor merge markers
const EDITOR_MERGE_CSS = `
.peervault-merge-line {
  background: linear-gradient(to right, var(--color-green-rgb, 0, 200, 100) 0.1%, transparent 3%);
}

.peervault-merge-line::before {
  content: '↙';
  position: absolute;
  left: -20px;
  color: var(--color-green);
  font-size: 12px;
}
`;
```

### 8. Enhanced History Browser

Full-featured version history viewer with diff comparison.

```typescript
import { LoroDoc, type OpId } from 'loro-crdt';
import { ItemView, Notice } from 'obsidian';

// Uses VersionEntry from earlier section
// Uses confirmDialog, findNodeByPath, updateFileContent, getSemanticDiff utilities

class HistoryBrowserView extends ItemView {
  static VIEW_TYPE = 'peervault-history-browser';

  private selectedFile: string | null = null;
  private versions: VersionEntry[] = [];
  private selectedVersion: VersionEntry | null = null;
  private compareVersion: VersionEntry | null = null;

  getViewType(): string { return HistoryBrowserView.VIEW_TYPE; }
  getDisplayText(): string { return 'Version History'; }
  getIcon(): string { return 'history'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('peervault-history-browser');

    this.render();
  }

  private render(): void {
    const container = this.containerEl.children[1];
    container.empty();

    // File selector
    this.renderFileSelector(container);

    if (!this.selectedFile) {
      container.createEl('p', {
        text: 'Select a file to view its history',
        cls: 'empty-state',
      });
      return;
    }

    // Main layout: version list + content viewer
    const layout = container.createDiv({ cls: 'history-layout' });

    // Left: Version list
    const versionList = layout.createDiv({ cls: 'version-list' });
    this.renderVersionList(versionList);

    // Right: Content viewer
    const contentViewer = layout.createDiv({ cls: 'content-viewer' });
    this.renderContentViewer(contentViewer);
  }

  private renderFileSelector(container: HTMLElement): void {
    const selector = container.createDiv({ cls: 'file-selector' });

    selector.createEl('label', { text: 'File: ' });

    const select = selector.createEl('select');
    select.createEl('option', { value: '', text: '-- Select a file --' });

    // Get all synced files
    const files = this.plugin.syncEngine.getSyncedFiles();
    for (const file of files) {
      select.createEl('option', {
        value: file.path,
        text: file.path,
      });
    }

    select.value = this.selectedFile || '';
    select.onchange = async () => {
      this.selectedFile = select.value;
      this.selectedVersion = null;
      this.compareVersion = null;

      if (this.selectedFile) {
        this.versions = await this.loadVersions(this.selectedFile);
      }

      this.render();
    };
  }

  private renderVersionList(container: HTMLElement): void {
    container.createEl('h4', { text: `Versions (${this.versions.length})` });

    // Compare mode toggle
    const toolbar = container.createDiv({ cls: 'version-toolbar' });
    const compareToggle = toolbar.createEl('label');
    const checkbox = compareToggle.createEl('input', { type: 'checkbox' });
    compareToggle.appendText(' Compare mode');

    checkbox.onchange = () => {
      this.compareVersion = null;
      this.render();
    };

    // Version list
    const list = container.createDiv({ cls: 'version-entries' });

    for (const version of this.versions) {
      const entry = list.createDiv({
        cls: `version-entry ${this.selectedVersion === version ? 'selected' : ''}`,
      });

      // Date/time
      entry.createEl('div', {
        text: new Date(version.timestamp).toLocaleString(),
        cls: 'version-time',
      });

      // Peer info
      entry.createEl('div', {
        text: `by ${version.peerId.slice(0, 8)}`,
        cls: 'version-peer',
      });

      // Description
      if (version.description) {
        entry.createEl('div', {
          text: version.description,
          cls: 'version-desc',
        });
      }

      // Click to select
      entry.onclick = () => {
        if (checkbox.checked && this.selectedVersion) {
          // Compare mode: select second version
          this.compareVersion = version;
        } else {
          this.selectedVersion = version;
          this.compareVersion = null;
        }
        this.render();
      };
    }
  }

  private renderContentViewer(container: HTMLElement): void {
    if (!this.selectedVersion) {
      container.createEl('p', {
        text: 'Select a version to view',
        cls: 'empty-state',
      });
      return;
    }

    // Header with actions
    const header = container.createDiv({ cls: 'viewer-header' });
    header.createEl('span', {
      text: new Date(this.selectedVersion.timestamp).toLocaleString(),
    });

    const actions = header.createDiv({ cls: 'viewer-actions' });

    actions.createEl('button', { text: 'Restore' }).onclick = () => {
      this.restoreVersion(this.selectedVersion!);
    };

    actions.createEl('button', { text: 'Copy' }).onclick = () => {
      this.copyVersionContent(this.selectedVersion!);
    };

    // Content display
    if (this.compareVersion) {
      this.renderDiffView(container);
    } else {
      this.renderSingleVersion(container);
    }
  }

  private async renderSingleVersion(container: HTMLElement): Promise<void> {
    const content = await this.getVersionContent(this.selectedVersion!);

    const pre = container.createEl('pre', { cls: 'version-content' });
    const code = pre.createEl('code');
    code.setText(content);
  }

  private async renderDiffView(container: HTMLElement): Promise<void> {
    const oldContent = await this.getVersionContent(this.compareVersion!);
    const newContent = await this.getVersionContent(this.selectedVersion!);

    const diff = getSemanticDiff(oldContent, newContent);

    const diffContainer = container.createDiv({ cls: 'diff-view' });

    // Header
    const diffHeader = diffContainer.createDiv({ cls: 'diff-header' });
    diffHeader.createEl('span', {
      text: `Comparing: ${new Date(this.compareVersion!.timestamp).toLocaleString()}`,
      cls: 'diff-old',
    });
    diffHeader.createEl('span', { text: ' → ' });
    diffHeader.createEl('span', {
      text: new Date(this.selectedVersion!.timestamp).toLocaleString(),
      cls: 'diff-new',
    });

    // Diff content
    const diffContent = diffContainer.createDiv({ cls: 'diff-content' });

    for (const part of diff) {
      const span = diffContent.createEl('span', {
        cls: `diff-${part.type}`,
      });
      span.setText(part.text);
    }
  }

  private async loadVersions(filePath: string): Promise<VersionEntry[]> {
    const doc = this.plugin.syncEngine.getDoc();
    return this.getFileVersions(doc, filePath);
  }

  private async getVersionContent(version: VersionEntry): Promise<string> {
    const doc = this.plugin.syncEngine.getDoc();
    // Clone and checkout - checkout() returns void and makes doc detached
    const snapshot = doc.export({ mode: "snapshot" });
    const historicalDoc = new LoroDoc();
    historicalDoc.import(snapshot);
    historicalDoc.checkout(version.frontiers);
    return this.getFileContentAtVersion(historicalDoc, this.selectedFile!);
  }

  private async restoreVersion(version: VersionEntry): Promise<void> {
    const confirmed = await confirmDialog(
      this.app,
      'Restore Version',
      `Restore ${this.selectedFile} to version from ${new Date(version.timestamp).toLocaleString()}?`
    );

    if (confirmed) {
      const content = await this.getVersionContent(version);
      const doc = this.plugin.syncEngine.getDoc();
      const nodeId = findNodeByPath(doc, this.selectedFile!);

      if (nodeId) {
        updateFileContent(doc, nodeId, content);
        new Notice(`Restored ${this.selectedFile}`);
      }
    }
  }

  private async copyVersionContent(version: VersionEntry): Promise<void> {
    const content = await this.getVersionContent(version);
    await navigator.clipboard.writeText(content);
    new Notice('Content copied to clipboard');
  }
}

// CSS for history browser
const HISTORY_BROWSER_CSS = `
.peervault-history-browser {
  padding: 16px;
}

.history-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 16px;
  height: calc(100% - 60px);
}

.version-list {
  border-right: 1px solid var(--background-modifier-border);
  padding-right: 16px;
  overflow-y: auto;
}

.version-entries {
  max-height: calc(100% - 80px);
  overflow-y: auto;
}

.version-entry {
  padding: 8px;
  margin: 4px 0;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
}

.version-entry:hover {
  background: var(--background-secondary);
}

.version-entry.selected {
  background: var(--background-secondary);
  border-color: var(--interactive-accent);
}

.version-time {
  font-weight: 500;
}

.version-peer {
  font-size: 0.85em;
  color: var(--text-muted);
}

.content-viewer {
  overflow-y: auto;
}

.viewer-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.version-content {
  background: var(--background-secondary);
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
}

.diff-view .diff-insert {
  background: var(--background-modifier-success);
  color: var(--text-success);
}

.diff-view .diff-delete {
  background: var(--background-modifier-error);
  color: var(--text-error);
  text-decoration: line-through;
}
`;
```

### 9. Selective Sync Configuration

UI for configuring which folders/files to sync.

```typescript
class SelectiveSyncSettings {
  constructor(
    private containerEl: HTMLElement,
    private plugin: PeerVaultPlugin
  ) {}

  display(): void {
    const container = this.containerEl.createDiv({ cls: 'selective-sync-settings' });

    container.createEl('h3', { text: 'Selective Sync' });
    container.createEl('p', {
      text: 'Choose which folders to sync. Excluded folders will not be sent to or received from peers.',
      cls: 'setting-desc',
    });

    // Folder tree with checkboxes
    const treeContainer = container.createDiv({ cls: 'folder-tree' });
    this.renderFolderTree(treeContainer);

    // Pattern-based exclusions
    container.createEl('h4', { text: 'Exclusion Patterns' });

    new Setting(container)
      .setName('Exclude by pattern')
      .setDesc('Glob patterns to exclude (one per line)')
      .addTextArea(text => {
        text.setValue(this.plugin.settings.excludePatterns.join('\n'));
        text.setPlaceholder('*.tmp\n.git/**\nnode_modules/**');
        text.onChange(async value => {
          const patterns = value.split('\n').filter(p => p.trim());
          await this.plugin.updateSettings({ excludePatterns: patterns });
        });
      });

    // File size limits
    new Setting(container)
      .setName('Maximum file size')
      .setDesc('Files larger than this will not be synced (in MB)')
      .addSlider(slider => {
        slider
          .setLimits(1, 50, 1)
          .setValue(this.plugin.settings.maxFileSizeMB)
          .setDynamicTooltip()
          .onChange(async value => {
            await this.plugin.updateSettings({ maxFileSizeMB: value });
          });
      });

    // Sync stats
    this.renderSyncStats(container);
  }

  private renderFolderTree(container: HTMLElement): void {
    const excludedFolders = new Set(this.plugin.settings.excludedFolders);
    const vault = this.plugin.app.vault;

    // Get folder structure
    const folders = this.getFolderHierarchy(vault);

    const tree = container.createEl('ul', { cls: 'folder-tree-list' });
    this.renderFolderNode(tree, folders, '', excludedFolders);
  }

  private getFolderHierarchy(vault: Vault): FolderNode {
    const root: FolderNode = { name: '', path: '', children: [], fileCount: 0 };

    for (const file of vault.getMarkdownFiles()) {
      const parts = file.path.split('/');
      let current = root;

      for (let i = 0; i < parts.length - 1; i++) {
        const folderName = parts[i];
        const folderPath = parts.slice(0, i + 1).join('/');

        let child = current.children.find(c => c.name === folderName);
        if (!child) {
          child = { name: folderName, path: folderPath, children: [], fileCount: 0 };
          current.children.push(child);
        }
        current = child;
      }

      current.fileCount++;
    }

    return root;
  }

  private renderFolderNode(
    parent: HTMLElement,
    node: FolderNode,
    parentPath: string,
    excludedFolders: Set<string>
  ): void {
    for (const child of node.children.sort((a, b) => a.name.localeCompare(b.name))) {
      const li = parent.createEl('li');

      const label = li.createEl('label', { cls: 'folder-item' });

      // Checkbox
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.checked = !excludedFolders.has(child.path);

      // Indeterminate if some children excluded
      const childExcluded = this.hasExcludedChildren(child, excludedFolders);
      if (childExcluded && checkbox.checked) {
        checkbox.indeterminate = true;
      }

      checkbox.onchange = async () => {
        if (checkbox.checked) {
          excludedFolders.delete(child.path);
        } else {
          excludedFolders.add(child.path);
        }
        await this.plugin.updateSettings({
          excludedFolders: Array.from(excludedFolders),
        });
        this.display(); // Re-render
      };

      // Folder icon and name
      label.createSpan({ cls: 'folder-icon', text: '📁 ' });
      label.createSpan({ text: child.name });
      label.createSpan({
        text: ` (${child.fileCount} files)`,
        cls: 'file-count',
      });

      // Nested children
      if (child.children.length > 0) {
        const nestedList = li.createEl('ul');
        this.renderFolderNode(nestedList, child, child.path, excludedFolders);
      }
    }
  }

  private hasExcludedChildren(node: FolderNode, excluded: Set<string>): boolean {
    for (const child of node.children) {
      if (excluded.has(child.path)) return true;
      if (this.hasExcludedChildren(child, excluded)) return true;
    }
    return false;
  }

  private renderSyncStats(container: HTMLElement): void {
    container.createEl('h4', { text: 'Sync Statistics' });

    const stats = this.plugin.syncEngine.getSyncStats();

    const table = container.createEl('table', { cls: 'sync-stats-table' });

    const rows = [
      ['Total files', `${stats.totalFiles}`],
      ['Synced files', `${stats.syncedFiles}`],
      ['Excluded files', `${stats.excludedFiles}`],
      ['Sync data size', this.formatBytes(stats.syncDataBytes)],
      ['Last full sync', stats.lastFullSync
        ? new Date(stats.lastFullSync).toLocaleString()
        : 'Never'],
    ];

    for (const [label, value] of rows) {
      const row = table.createEl('tr');
      row.createEl('td', { text: label });
      row.createEl('td', { text: value });
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  fileCount: number;
}

// CSS for selective sync
const SELECTIVE_SYNC_CSS = `
.folder-tree-list {
  list-style: none;
  padding-left: 0;
}

.folder-tree-list ul {
  list-style: none;
  padding-left: 20px;
}

.folder-item {
  display: flex;
  align-items: center;
  padding: 4px 0;
  cursor: pointer;
}

.folder-item:hover {
  background: var(--background-secondary);
}

.folder-item input[type="checkbox"] {
  margin-right: 8px;
}

.file-count {
  color: var(--text-muted);
  font-size: 0.85em;
  margin-left: 4px;
}

.sync-stats-table {
  width: 100%;
  margin-top: 12px;
}

.sync-stats-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.sync-stats-table td:first-child {
  font-weight: 500;
}
`;
```

### 10. Accessibility (a11y) Compliance

All PeerVault UI components must meet WCAG 2.1 AA standards.

#### ARIA Labels

```typescript
/**
 * Accessible button component.
 */
function createAccessibleButton(
  container: HTMLElement,
  label: string,
  icon: string,
  onClick: () => void
): HTMLButtonElement {
  const button = container.createEl('button', {
    cls: 'peervault-icon-btn',
    attr: {
      'aria-label': label,
      'title': label,
      'role': 'button',
      'tabindex': '0',
    },
  });

  setIcon(button, icon);

  button.onclick = onClick;

  // Keyboard support
  button.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return button;
}

/**
 * Accessible status indicator.
 */
function createStatusIndicator(
  container: HTMLElement,
  status: 'synced' | 'syncing' | 'error' | 'offline'
): HTMLElement {
  const statusLabels = {
    synced: 'All changes synced',
    syncing: 'Sync in progress',
    error: 'Sync error occurred',
    offline: 'Working offline',
  };

  const indicator = container.createEl('div', {
    cls: `peervault-status peervault-status-${status}`,
    attr: {
      'role': 'status',
      'aria-live': 'polite',
      'aria-label': statusLabels[status],
    },
  });

  return indicator;
}
```

#### Keyboard Navigation

```typescript
/**
 * Keyboard-navigable list component.
 */
class AccessibleList {
  private items: HTMLElement[] = [];
  private focusedIndex = 0;

  constructor(private container: HTMLElement) {
    this.container.setAttribute('role', 'listbox');
    this.container.setAttribute('tabindex', '0');

    this.container.onkeydown = this.handleKeydown.bind(this);
  }

  addItem(label: string, onSelect: () => void): HTMLElement {
    const item = this.container.createEl('div', {
      cls: 'peervault-list-item',
      attr: {
        'role': 'option',
        'tabindex': '-1',
        'aria-selected': 'false',
      },
    });

    item.setText(label);
    item.onclick = () => {
      this.selectItem(this.items.indexOf(item));
      onSelect();
    };

    this.items.push(item);
    return item;
  }

  private handleKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.focusItem(this.focusedIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.focusItem(this.focusedIndex - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.items[this.focusedIndex]?.click();
        break;
      case 'Home':
        e.preventDefault();
        this.focusItem(0);
        break;
      case 'End':
        e.preventDefault();
        this.focusItem(this.items.length - 1);
        break;
    }
  }

  private focusItem(index: number): void {
    if (index < 0) index = this.items.length - 1;
    if (index >= this.items.length) index = 0;

    this.items[this.focusedIndex]?.removeClass('focused');
    this.focusedIndex = index;
    this.items[this.focusedIndex]?.addClass('focused');
    this.items[this.focusedIndex]?.focus();
  }

  private selectItem(index: number): void {
    this.items.forEach((item, i) => {
      item.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });
  }
}
```

#### Focus Management

```typescript
/**
 * Trap focus within modal dialogs.
 */
class FocusTrap {
  private focusableElements: HTMLElement[] = [];
  private firstElement: HTMLElement | null = null;
  private lastElement: HTMLElement | null = null;

  constructor(private container: HTMLElement) {
    this.updateFocusableElements();
  }

  activate(): void {
    this.updateFocusableElements();
    this.firstElement?.focus();

    this.container.addEventListener('keydown', this.handleKeydown);
  }

  deactivate(): void {
    this.container.removeEventListener('keydown', this.handleKeydown);
  }

  private updateFocusableElements(): void {
    const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    this.focusableElements = Array.from(
      this.container.querySelectorAll<HTMLElement>(selector)
    ).filter(el => !el.hasAttribute('disabled'));

    this.firstElement = this.focusableElements[0] || null;
    this.lastElement = this.focusableElements[this.focusableElements.length - 1] || null;
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      if (document.activeElement === this.firstElement) {
        e.preventDefault();
        this.lastElement?.focus();
      }
    } else {
      if (document.activeElement === this.lastElement) {
        e.preventDefault();
        this.firstElement?.focus();
      }
    }
  };
}
```

#### Screen Reader Announcements

```typescript
/**
 * Announce messages to screen readers.
 */
class ScreenReaderAnnouncer {
  private liveRegion: HTMLElement;

  constructor() {
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.liveRegion.addClass('sr-only');
    document.body.appendChild(this.liveRegion);
  }

  announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
    this.liveRegion.setAttribute('aria-live', priority);
    this.liveRegion.textContent = '';

    // Small delay ensures screen reader picks up the change
    setTimeout(() => {
      this.liveRegion.textContent = message;
    }, 50);
  }

  announceSync(status: 'started' | 'completed' | 'failed', details?: string): void {
    const messages = {
      started: 'Sync started',
      completed: `Sync completed${details ? `: ${details}` : ''}`,
      failed: `Sync failed${details ? `: ${details}` : ''}`,
    };
    this.announce(messages[status]);
  }
}
```

#### Accessible CSS

```css
/* Screen reader only (visually hidden but accessible) */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Focus indicators */
.peervault-focusable:focus {
  outline: 2px solid var(--interactive-accent);
  outline-offset: 2px;
}

.peervault-focusable:focus:not(:focus-visible) {
  outline: none;
}

.peervault-focusable:focus-visible {
  outline: 2px solid var(--interactive-accent);
  outline-offset: 2px;
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .peervault-status-synced { border: 2px solid green; }
  .peervault-status-error { border: 2px solid red; }
  .peervault-status-syncing { border: 2px solid blue; }
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  .peervault-spinner {
    animation: none;
  }

  .peervault-progress {
    transition: none;
  }
}

/* Minimum touch target size for mobile */
.peervault-touch-target {
  min-width: 44px;
  min-height: 44px;
}
```

#### Accessibility Checklist

| Component | ARIA | Keyboard | Focus | Screen Reader |
|-----------|------|----------|-------|---------------|
| Status bar | role="status" | N/A | N/A | Live region |
| Peer list | role="listbox" | Arrow keys | Visible | Options announced |
| Settings toggle | role="switch" | Space/Enter | Ring | State change |
| Modal dialogs | role="dialog" | Tab trap, Esc | Auto-focus first | Title announced |
| Progress bar | role="progressbar" | N/A | N/A | Value announced |
| Error notices | role="alert" | N/A | N/A | Assertive |

### 11. Internationalization (i18n)

Support for multiple languages in the UI.

```typescript
/**
 * Translation strings by language code.
 */
interface TranslationStrings {
  // Status
  'status.synced': string;
  'status.syncing': string;
  'status.offline': string;
  'status.error': string;

  // Actions
  'action.addDevice': string;
  'action.forceSync': string;
  'action.removePeer': string;

  // Settings
  'settings.autoSync': string;
  'settings.autoSyncDesc': string;
  'settings.encryption': string;

  // Errors
  'error.connectionFailed': string;
  'error.syncFailed': string;

  // Confirmations
  'confirm.removePeer': string;
  'confirm.disableEncryption': string;
}

const TRANSLATIONS: Record<string, TranslationStrings> = {
  en: {
    'status.synced': 'All changes synced',
    'status.syncing': 'Syncing...',
    'status.offline': 'Working offline',
    'status.error': 'Sync error',
    'action.addDevice': 'Add device',
    'action.forceSync': 'Force sync',
    'action.removePeer': 'Remove peer',
    'settings.autoSync': 'Auto-sync on startup',
    'settings.autoSyncDesc': 'Automatically connect to peers when Obsidian opens',
    'settings.encryption': 'Encryption',
    'error.connectionFailed': 'Failed to connect to peer',
    'error.syncFailed': 'Sync failed',
    'confirm.removePeer': 'Are you sure you want to remove this peer?',
    'confirm.disableEncryption': 'Disabling encryption will store your data unprotected. Continue?',
  },

  de: {
    'status.synced': 'Alle Änderungen synchronisiert',
    'status.syncing': 'Synchronisiere...',
    'status.offline': 'Offline arbeiten',
    'status.error': 'Synchronisierungsfehler',
    'action.addDevice': 'Gerät hinzufügen',
    'action.forceSync': 'Synchronisierung erzwingen',
    'action.removePeer': 'Peer entfernen',
    'settings.autoSync': 'Automatische Synchronisierung beim Start',
    'settings.autoSyncDesc': 'Automatisch mit Peers verbinden, wenn Obsidian startet',
    'settings.encryption': 'Verschlüsselung',
    'error.connectionFailed': 'Verbindung zum Peer fehlgeschlagen',
    'error.syncFailed': 'Synchronisierung fehlgeschlagen',
    'confirm.removePeer': 'Möchten Sie diesen Peer wirklich entfernen?',
    'confirm.disableEncryption': 'Das Deaktivieren der Verschlüsselung speichert Ihre Daten ungeschützt. Fortfahren?',
  },

  // Add more languages...
};

/**
 * Translation function.
 */
class I18n {
  private currentLocale: string;
  private strings: TranslationStrings;

  constructor(locale?: string) {
    this.currentLocale = locale || this.detectLocale();
    this.strings = TRANSLATIONS[this.currentLocale] || TRANSLATIONS['en'];
  }

  private detectLocale(): string {
    // Try Obsidian locale first
    const obsidianLocale = window.localStorage.getItem('language');
    if (obsidianLocale && TRANSLATIONS[obsidianLocale]) {
      return obsidianLocale;
    }

    // Fall back to browser locale
    const browserLocale = navigator.language.split('-')[0];
    return TRANSLATIONS[browserLocale] ? browserLocale : 'en';
  }

  t(key: keyof TranslationStrings, params?: Record<string, string>): string {
    let text = this.strings[key] || TRANSLATIONS['en'][key] || key;

    // Replace parameters
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v);
      }
    }

    return text;
  }

  setLocale(locale: string): void {
    this.currentLocale = locale;
    this.strings = TRANSLATIONS[locale] || TRANSLATIONS['en'];
  }
}

// Global instance
const i18n = new I18n();

// Usage
new Setting(containerEl)
  .setName(i18n.t('settings.autoSync'))
  .setDesc(i18n.t('settings.autoSyncDesc'))
  .addToggle(/* ... */);
```

### 12. Confirmation Dialogs for Destructive Operations

All destructive operations MUST require user confirmation. This prevents accidental data loss.

#### Confirmation Dialog Helper

```typescript
interface ConfirmationOptions {
  /** Dialog title */
  title: string;
  /** Main message explaining the action */
  message: string;
  /** Additional details or consequences */
  details?: string[];
  /** Text for confirm button (default: "Confirm") */
  confirmText?: string;
  /** Text for cancel button (default: "Cancel") */
  cancelText?: string;
  /** Button style: 'danger' for destructive actions, 'warning' for risky actions */
  confirmStyle?: 'danger' | 'warning' | 'default';
  /** Require user to type something to confirm (e.g., vault name) */
  typeToConfirm?: string;
}

class ConfirmationModal extends Modal {
  private result: boolean = false;
  private resolvePromise: ((value: boolean) => void) | null = null;

  constructor(app: App, private options: ConfirmationOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('peervault-confirmation-modal');

    // Title with warning icon for destructive actions
    const titleEl = contentEl.createEl('h2', { cls: 'confirmation-title' });
    if (this.options.confirmStyle === 'danger') {
      titleEl.createSpan({ text: '⚠️ ', cls: 'warning-icon' });
    }
    titleEl.createSpan({ text: this.options.title });

    // Main message
    contentEl.createEl('p', {
      text: this.options.message,
      cls: 'confirmation-message'
    });

    // Additional details as bullet points
    if (this.options.details && this.options.details.length > 0) {
      const detailsList = contentEl.createEl('ul', { cls: 'confirmation-details' });
      for (const detail of this.options.details) {
        detailsList.createEl('li', { text: detail });
      }
    }

    // Type-to-confirm input
    let confirmInput: HTMLInputElement | null = null;
    if (this.options.typeToConfirm) {
      const inputContainer = contentEl.createDiv({ cls: 'type-to-confirm' });
      inputContainer.createEl('p', {
        text: `Type "${this.options.typeToConfirm}" to confirm:`,
        cls: 'type-to-confirm-label'
      });
      confirmInput = inputContainer.createEl('input', {
        type: 'text',
        placeholder: this.options.typeToConfirm,
        cls: 'type-to-confirm-input'
      });
    }

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: 'confirmation-buttons' });

    // Cancel button (always available)
    new ButtonComponent(buttonContainer)
      .setButtonText(this.options.cancelText || 'Cancel')
      .onClick(() => {
        this.result = false;
        this.close();
      });

    // Confirm button
    const confirmBtn = new ButtonComponent(buttonContainer)
      .setButtonText(this.options.confirmText || 'Confirm')
      .onClick(() => {
        // Check type-to-confirm if required
        if (confirmInput && confirmInput.value !== this.options.typeToConfirm) {
          confirmInput.addClass('input-error');
          new Notice('Please type the confirmation text exactly');
          return;
        }
        this.result = true;
        this.close();
      });

    // Style the confirm button based on action type
    if (this.options.confirmStyle === 'danger') {
      confirmBtn.buttonEl.addClass('mod-warning');
    } else if (this.options.confirmStyle === 'warning') {
      confirmBtn.buttonEl.addClass('mod-cta');
    }

    // Disable confirm until type-to-confirm matches
    if (confirmInput) {
      confirmBtn.setDisabled(true);
      confirmInput.oninput = () => {
        confirmBtn.setDisabled(confirmInput!.value !== this.options.typeToConfirm);
      };
    }
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
  }

  waitForResult(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Helper function to show confirmation dialog.
 */
async function confirmDialog(
  app: App,
  title: string,
  message: string,
  options?: Partial<ConfirmationOptions>
): Promise<boolean> {
  const modal = new ConfirmationModal(app, {
    title,
    message,
    ...options,
  });
  return modal.waitForResult();
}
```

#### Destructive Operations Requiring Confirmation

| Operation | Confirmation Type | Type-to-Confirm | Details Shown |
|-----------|------------------|-----------------|---------------|
| Remove peer | danger | No | Peer name, last sync time |
| Delete sync data | danger | Vault name | Data size, cannot be undone |
| Disable encryption | danger | "DISABLE" | Security implications |
| Clear edit history | warning | No | History size, cannot be undone |
| Force overwrite | warning | No | Files affected count |
| Leave vault | danger | No | Will stop syncing |
| Reset pairing | danger | "RESET" | All peers will be disconnected |

#### Implementation Examples

```typescript
/**
 * Remove peer with confirmation.
 */
async function removePeerWithConfirmation(
  app: App,
  peerManager: PeerManager,
  peerId: string
): Promise<boolean> {
  const peer = peerManager.getPeer(peerId);
  if (!peer) return false;

  const confirmed = await confirmDialog(app, 'Remove Peer',
    `Remove "${peer.name}" from synced devices?`, {
    confirmStyle: 'danger',
    confirmText: 'Remove Peer',
    details: [
      `Last synced: ${formatRelativeTime(peer.lastSyncTime)}`,
      'They will no longer receive updates from you',
      'You will no longer receive updates from them',
      'You can re-add them later with a new pairing ticket',
    ],
  });

  if (confirmed) {
    await peerManager.removePeer(peerId);
    new Notice(`Removed peer "${peer.name}"`);
    return true;
  }
  return false;
}

/**
 * Disable encryption with strict confirmation.
 */
async function disableEncryptionWithConfirmation(
  app: App,
  settings: PeerVaultSettings
): Promise<boolean> {
  const confirmed = await confirmDialog(app, 'Disable Encryption',
    'This will store your vault data without encryption.', {
    confirmStyle: 'danger',
    confirmText: 'Disable Encryption',
    typeToConfirm: 'DISABLE',
    details: [
      'Your sync data will be stored in plain text',
      'Anyone with access to your device can read your notes',
      'This change takes effect immediately',
      'You can re-enable encryption later (will require new passphrase)',
    ],
  });

  if (confirmed) {
    await settings.setEncryption(false);
    new Notice('Encryption disabled');
    return true;
  }
  return false;
}

/**
 * Delete all sync data with strict confirmation.
 */
async function deleteSyncDataWithConfirmation(
  app: App,
  vaultName: string,
  syncEngine: SyncEngine
): Promise<boolean> {
  const stats = await syncEngine.getStorageStats();

  const confirmed = await confirmDialog(app, 'Delete Sync Data',
    'This will permanently delete all sync data for this vault.', {
    confirmStyle: 'danger',
    confirmText: 'Delete Everything',
    typeToConfirm: vaultName,
    details: [
      `Total data size: ${formatBytes(stats.totalBytes)}`,
      `Edit history: ${stats.historyEntries} entries`,
      'All local sync data will be deleted',
      'Peers will not be affected',
      'You can re-sync from peers to restore data',
      'This cannot be undone',
    ],
  });

  if (confirmed) {
    await syncEngine.deleteAllData();
    new Notice('Sync data deleted');
    return true;
  }
  return false;
}

/**
 * Force overwrite local changes.
 */
async function forceOverwriteWithConfirmation(
  app: App,
  conflictingFiles: string[]
): Promise<boolean> {
  const confirmed = await confirmDialog(app, 'Force Overwrite',
    'This will overwrite your local changes with the remote version.', {
    confirmStyle: 'warning',
    confirmText: 'Overwrite Local',
    details: [
      `${conflictingFiles.length} file(s) will be overwritten:`,
      ...conflictingFiles.slice(0, 5).map(f => `  • ${f}`),
      ...(conflictingFiles.length > 5 ? [`  ...and ${conflictingFiles.length - 5} more`] : []),
      'Your local changes will be lost',
    ],
  });

  return confirmed;
}
```

#### Confirmation Dialog CSS

```css
.peervault-confirmation-modal {
  max-width: 450px;
}

.peervault-confirmation-modal .confirmation-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.peervault-confirmation-modal .warning-icon {
  font-size: 1.2em;
}

.peervault-confirmation-modal .confirmation-message {
  color: var(--text-muted);
  margin: 16px 0;
}

.peervault-confirmation-modal .confirmation-details {
  background: var(--background-secondary);
  padding: 12px 12px 12px 28px;
  border-radius: 4px;
  margin: 16px 0;
  font-size: 0.9em;
}

.peervault-confirmation-modal .confirmation-details li {
  margin: 4px 0;
  color: var(--text-muted);
}

.peervault-confirmation-modal .type-to-confirm {
  margin: 16px 0;
}

.peervault-confirmation-modal .type-to-confirm-label {
  font-weight: 500;
  margin-bottom: 8px;
}

.peervault-confirmation-modal .type-to-confirm-input {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
}

.peervault-confirmation-modal .type-to-confirm-input.input-error {
  border-color: var(--text-error);
}

.peervault-confirmation-modal .confirmation-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.peervault-confirmation-modal .mod-warning {
  background: var(--text-error);
  color: var(--text-on-accent);
}

.peervault-confirmation-modal .mod-warning:hover {
  background: var(--text-error);
  filter: brightness(0.9);
}
```

## CSS Styles

```css
/* Status bar */
.peervault-status {
  cursor: pointer;
}

.peervault-status .status-icon {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}

.peervault-status .status-icon.synced {
  background-color: var(--color-green);
}

.peervault-status .status-icon.syncing {
  background-color: var(--color-blue);
  animation: pulse 1s infinite;
}

.peervault-status .status-icon.offline {
  background-color: var(--color-base-50);
}

.peervault-status .status-icon.error {
  background-color: var(--color-yellow);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* QR Code modal */
.peervault-qr {
  display: flex;
  justify-content: center;
  margin: 20px 0;
}

/* History list */
.peervault-history-list {
  list-style: none;
  padding: 0;
}

.peervault-history-list li {
  padding: 8px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.peervault-history-list .history-time {
  font-weight: bold;
}

.peervault-history-list .history-actor {
  color: var(--text-muted);
  font-size: 0.9em;
}
```

## Dependencies

- Obsidian Plugin API (Modal, Setting, ItemView, etc.)
- QR code library (e.g., `qrcode`)

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Mobile UI | Yes, responsive/adaptive UI | Different layout for mobile with optimized touch targets and simplified views. |
| QR scanning | Investigate Obsidian mobile camera API | Test camera access in Obsidian mobile. Fallback to manual ticket paste if unavailable. |
| Notifications | User-configurable verbosity | Let users choose notification level in settings (minimal/summary/verbose). |
