/**
 * Status Modal
 *
 * Shows sync status and connected peers.
 */

import { App, Modal, Setting } from 'obsidian';
import type PeerVaultPlugin from '../main';
import type { PeerInfo } from '../types';

export class PeerVaultStatusModal extends Modal {
  plugin: PeerVaultPlugin;

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app);
    this.plugin = plugin;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('peervault-status-modal');

    contentEl.createEl('h2', { text: 'PeerVault Status' });

    this.renderStatus(contentEl);
    this.renderPeers(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private renderStatus(container: HTMLElement): void {
    const statusEl = container.createDiv({ cls: 'peervault-status-section' });
    statusEl.createEl('h3', { text: 'Sync Status' });

    const statusGrid = statusEl.createDiv({ cls: 'peervault-status-grid' });

    // Current status
    const statusRow = statusGrid.createDiv({ cls: 'peervault-status-row' });
    statusRow.createSpan({ text: 'Status:', cls: 'peervault-label' });
    const statusValue = statusRow.createSpan({ cls: 'peervault-value' });

    const status = this.plugin.getStatus();
    const statusIcons: Record<string, string> = {
      idle: 'Idle',
      syncing: 'Syncing...',
      offline: 'Offline',
      error: 'Error',
    };
    statusValue.setText(statusIcons[status] ?? 'Unknown');
    statusValue.addClass(`peervault-status-${status}`);

    // Vault ID
    const vaultRow = statusGrid.createDiv({ cls: 'peervault-status-row' });
    vaultRow.createSpan({ text: 'Vault ID:', cls: 'peervault-label' });
    const vaultId = this.plugin.documentManager.getVaultId();
    vaultRow.createSpan({ text: vaultId.substring(0, 8) + '...', cls: 'peervault-value' });

    // Files tracked
    const filesRow = statusGrid.createDiv({ cls: 'peervault-status-row' });
    filesRow.createSpan({ text: 'Files tracked:', cls: 'peervault-label' });
    const fileCount = this.plugin.documentManager.listAllPaths().length;
    filesRow.createSpan({ text: String(fileCount), cls: 'peervault-value' });
  }

  private renderPeers(container: HTMLElement): void {
    const peersEl = container.createDiv({ cls: 'peervault-peers-section' });
    peersEl.createEl('h3', { text: 'Connected Peers' });

    const peers = this.plugin.getConnectedPeers();

    if (peers.length === 0) {
      peersEl.createEl('p', {
        text: 'No peers connected. Add a device to start syncing.',
        cls: 'peervault-no-peers',
      });
    } else {
      const peerList = peersEl.createEl('ul', { cls: 'peervault-peer-list' });

      for (const peer of peers) {
        this.renderPeerItem(peerList, peer);
      }
    }
  }

  private renderPeerItem(list: HTMLElement, peer: PeerInfo): void {
    const item = list.createEl('li', { cls: 'peervault-peer-item' });

    // Peer info
    const info = item.createDiv({ cls: 'peervault-peer-info' });
    info.createSpan({
      text: peer.name || peer.nodeId.substring(0, 8) + '...',
      cls: 'peervault-peer-name',
    });

    // Status indicator
    const statusEl = info.createSpan({ cls: `peervault-peer-status peervault-peer-${peer.connectionState}` });
    statusEl.setText(peer.connectionState);

    // Last seen
    if (peer.lastSeen) {
      const lastSeen = item.createDiv({ cls: 'peervault-peer-lastseen' });
      const ago = this.timeAgo(peer.lastSeen);
      lastSeen.setText(`Last seen: ${ago}`);
    }
  }

  private renderActions(container: HTMLElement): void {
    const actionsEl = container.createDiv({ cls: 'peervault-actions-section' });

    new Setting(actionsEl)
      .setName('Add Device')
      .setDesc('Pair a new device by scanning QR code or entering ticket')
      .addButton((btn) =>
        btn.setButtonText('Add Device').onClick(() => {
          this.close();
          // TODO: Open add device modal
        })
      );

    new Setting(actionsEl)
      .setName('Show My Invite')
      .setDesc('Generate a ticket or QR code for other devices to connect')
      .addButton((btn) =>
        btn.setButtonText('Show Invite').onClick(() => {
          this.close();
          // TODO: Open invite modal
        })
      );

    new Setting(actionsEl)
      .setName('Sync Now')
      .setDesc('Manually trigger sync with all connected peers')
      .addButton((btn) =>
        btn.setButtonText('Sync').onClick(async () => {
          await this.plugin.sync();
          this.close();
        })
      );
  }

  private timeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
