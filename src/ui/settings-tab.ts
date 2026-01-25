/**
 * Settings Tab
 *
 * Plugin settings UI for PeerVault configuration.
 */

import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type PeerVaultPlugin from '../main';
import { getEncryptionService } from '../crypto';
import { getConflictTracker } from '../core/conflict-tracker';
import { EncryptionModal } from './encryption-modal';
import { SelectiveSyncModal } from './selective-sync-modal';
import { PairingModal } from './pairing-modal';
import { ConflictModal } from './conflict-modal';
import { FileHistoryModal } from './file-history-modal';

export class PeerVaultSettingsTab extends PluginSettingTab {
  plugin: PeerVaultPlugin;

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('peervault-settings');

    containerEl.createEl('h2', { text: 'PeerVault Settings' });

    // Quick Actions Section
    this.renderQuickActions(containerEl);

    // Status Section
    this.renderStatusSection(containerEl);

    // Devices Section
    this.renderDevicesSection(containerEl);

    // Security Section
    this.renderSecuritySection(containerEl);

    // Sync Section
    this.renderSyncSection(containerEl);

    // Advanced Section
    this.renderAdvancedSection(containerEl);

    // Danger Zone
    this.renderDangerZone(containerEl);
  }

  private renderQuickActions(container: HTMLElement): void {
    const section = container.createDiv({ cls: 'peervault-quick-actions-section' });

    new Setting(section)
      .setName('Quick Actions')
      .setDesc('Common tasks')
      .addButton((btn) =>
        btn.setButtonText('Pair Device').setCta().onClick(() => {
          new PairingModal(this.app, this.plugin).open();
        })
      )
      .addButton((btn) =>
        btn.setButtonText('Sync Now').onClick(async () => {
          await this.plugin.sync();
        })
      );
  }

  private renderStatusSection(container: HTMLElement): void {
    container.createEl('h3', { text: 'Status' });

    // Connection status
    const status = this.plugin.getStatus();
    const peers = this.plugin.getConnectedPeers();
    const connectedCount = peers.filter(
      (p) => p.connectionState === 'connected' || p.connectionState === 'syncing'
    ).length;

    new Setting(container)
      .setName('Connection')
      .setDesc(`${connectedCount} of ${peers.length} device(s) connected`)
      .addExtraButton((btn) =>
        btn.setIcon('refresh-cw').setTooltip('Refresh').onClick(() => this.display())
      );

    // Node ID
    new Setting(container)
      .setName('Node ID')
      .setDesc('Your unique device identifier')
      .addText((text) => {
        const nodeId = this.plugin.getNodeId();
        text.setValue(nodeId.substring(0, 16) + '...');
        text.setDisabled(true);
        text.inputEl.style.fontFamily = 'var(--font-monospace)';
        text.inputEl.style.fontSize = '12px';
      })
      .addExtraButton((btn) =>
        btn.setIcon('copy').setTooltip('Copy full ID').onClick(() => {
          navigator.clipboard.writeText(this.plugin.getNodeId());
          new Notice('Node ID copied');
        })
      );

    // Vault ID
    new Setting(container)
      .setName('Vault ID')
      .setDesc('Shared identifier for this vault')
      .addText((text) => {
        const vaultId = this.plugin.documentManager.getVaultId();
        text.setValue(vaultId.substring(0, 8) + '...');
        text.setDisabled(true);
        text.inputEl.style.fontFamily = 'var(--font-monospace)';
        text.inputEl.style.fontSize = '12px';
      });

    // Files tracked
    const fileCount = this.plugin.documentManager.listAllPaths().length;
    new Setting(container)
      .setName('Files tracked')
      .setDesc(`${fileCount} file(s) in sync`);

    // Conflicts
    const tracker = getConflictTracker();
    const conflictCount = tracker.getConflictCount();
    if (conflictCount > 0) {
      new Setting(container)
        .setName('Concurrent edits')
        .setDesc(`${conflictCount} file(s) with recent concurrent edits`)
        .addButton((btn) =>
          btn.setButtonText('Review').setWarning().onClick(() => {
            new ConflictModal(this.app, this.plugin).open();
          })
        );
    }
  }

  private renderDevicesSection(container: HTMLElement): void {
    container.createEl('h3', { text: 'Devices' });

    const peers = this.plugin.getConnectedPeers();

    if (peers.length === 0) {
      new Setting(container)
        .setName('No devices paired')
        .setDesc('Pair a device to start syncing')
        .addButton((btn) =>
          btn.setButtonText('Pair Device').setCta().onClick(() => {
            new PairingModal(this.app, this.plugin).open();
          })
        );
    } else {
      for (const peer of peers) {
        const stateIcon = this.getStateIcon(peer.connectionState);
        const stateText = peer.connectionState.charAt(0).toUpperCase() + peer.connectionState.slice(1);

        new Setting(container)
          .setName(`${stateIcon} ${peer.name || 'Unknown Device'}`)
          .setDesc(`${stateText} • ${peer.nodeId.substring(0, 8)}...`)
          .addExtraButton((btn) =>
            btn.setIcon('trash').setTooltip('Remove device').onClick(async () => {
              const confirmed = confirm(`Remove "${peer.name || 'this device'}" from sync?`);
              if (confirmed) {
                await this.plugin.peerManager.removePeer(peer.nodeId);
                new Notice('Device removed');
                this.display();
              }
            })
          );
      }

      new Setting(container).addButton((btn) =>
        btn.setButtonText('Add Another Device').onClick(() => {
          new PairingModal(this.app, this.plugin).open();
        })
      );
    }
  }

  private renderSecuritySection(container: HTMLElement): void {
    container.createEl('h3', { text: 'Security' });

    const encryption = getEncryptionService();
    const isEnabled = this.plugin.settings.encryptionEnabled;
    const isUnlocked = encryption.isEnabled();

    let statusText: string;
    let statusClass: string;

    if (!isEnabled) {
      statusText = 'Disabled';
      statusClass = 'peervault-status-disabled';
    } else if (isUnlocked) {
      statusText = 'Enabled & Unlocked';
      statusClass = 'peervault-status-unlocked';
    } else {
      statusText = 'Enabled (Locked)';
      statusClass = 'peervault-status-locked';
    }

    new Setting(container)
      .setName('End-to-end encryption')
      .setDesc(`Status: ${statusText}`)
      .addButton((btn) =>
        btn.setButtonText(isEnabled ? 'Manage' : 'Enable').onClick(() => {
          new EncryptionModal(this.app, this.plugin).open();
        })
      );

    if (isEnabled && !isUnlocked) {
      new Setting(container)
        .setClass('peervault-warning-setting')
        .setName('Encryption is locked')
        .setDesc('Enter your password to unlock encryption and sync securely')
        .addButton((btn) =>
          btn.setButtonText('Unlock').setCta().onClick(() => {
            new EncryptionModal(this.app, this.plugin).open();
          })
        );
    }
  }

  private renderSyncSection(container: HTMLElement): void {
    container.createEl('h3', { text: 'Sync Settings' });

    new Setting(container)
      .setName('Auto-sync')
      .setDesc('Automatically sync changes with connected devices')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(container)
      .setName('Sync interval')
      .setDesc('How often to sync (seconds, 0 = real-time)')
      .addSlider((slider) =>
        slider
          .setLimits(0, 300, 10)
          .setValue(this.plugin.settings.syncInterval)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName('Selective sync')
      .setDesc('Choose which folders to sync')
      .addButton((btn) =>
        btn.setButtonText('Configure').onClick(() => {
          new SelectiveSyncModal(this.app, this.plugin).open();
        })
      );

    // Show current exclusions summary
    const excluded = this.plugin.settings.excludedFolders;
    if (excluded.length > 0) {
      const summary = excluded.slice(0, 3).join(', ') + (excluded.length > 3 ? ` +${excluded.length - 3} more` : '');
      new Setting(container)
        .setName('Excluded folders')
        .setDesc(summary)
        .addExtraButton((btn) =>
          btn.setIcon('pencil').setTooltip('Edit').onClick(() => {
            new SelectiveSyncModal(this.app, this.plugin).open();
          })
        );
    }

    new Setting(container)
      .setName('File history')
      .setDesc('View and restore previous versions of files')
      .addButton((btn) =>
        btn.setButtonText('Open').onClick(() => {
          new FileHistoryModal(this.app, this.plugin).open();
        })
      );
  }

  private renderAdvancedSection(container: HTMLElement): void {
    container.createEl('h3', { text: 'Advanced' });

    new Setting(container)
      .setName('Transport')
      .setDesc('Network transport for P2P connections')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('mock', 'Mock (Testing)')
          .addOption('iroh', 'Iroh (Production)')
          .setValue(this.plugin.settings.transportType)
          .onChange(async (value) => {
            this.plugin.settings.transportType = value as 'mock' | 'iroh';
            await this.plugin.saveSettings();
            new Notice('Restart Obsidian to apply transport change');
          })
      );

    new Setting(container)
      .setName('Show status bar')
      .setDesc('Display sync status in the status bar')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
          this.plugin.settings.showStatusBar = value;
          await this.plugin.saveSettings();
          new Notice('Restart Obsidian to apply');
        })
      );

    new Setting(container)
      .setName('Debug mode')
      .setDesc('Enable verbose logging for troubleshooting')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugMode).onChange(async (value) => {
          this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderDangerZone(container: HTMLElement): void {
    container.createEl('h3', { text: 'Danger Zone', cls: 'peervault-danger-header' });

    new Setting(container)
      .setName('Reset sync data')
      .setDesc('Delete all sync data and start fresh. Peers will need to re-pair.')
      .addButton((btn) =>
        btn
          .setButtonText('Reset')
          .setWarning()
          .onClick(async () => {
            const confirmed = confirm(
              'Are you sure you want to reset all PeerVault data?\n\n' +
              'This will:\n' +
              '• Remove all paired devices\n' +
              '• Delete sync history\n' +
              '• Clear encryption keys\n\n' +
              'Your vault files will NOT be deleted.'
            );
            if (confirmed) {
              await this.resetPlugin();
            }
          })
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
      const peers = this.plugin.peerManager.getPeers();
      for (const peer of peers) {
        await this.plugin.peerManager.removePeer(peer.nodeId);
      }

      // Save settings
      await this.plugin.saveSettings();

      // Clear stored data
      await this.plugin.storage.delete('peervault-peers');
      await this.plugin.storage.delete('peervault-snapshot');

      new Notice('PeerVault data has been reset. Please restart Obsidian.');
      this.display();
    } catch (error) {
      this.plugin.logger.error('Reset failed:', error);
      new Notice(`Reset failed: ${error}`);
    }
  }

  private getStateIcon(state: string): string {
    switch (state) {
      case 'connected':
      case 'syncing':
        return '🟢';
      case 'connecting':
        return '🟡';
      case 'error':
        return '🔴';
      default:
        return '⚪';
    }
  }
}
