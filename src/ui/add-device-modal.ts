/**
 * Add Device Modal
 *
 * UI for pairing a new device by entering a connection ticket.
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import type PeerVaultPlugin from '../main';

export class AddDeviceModal extends Modal {
  plugin: PeerVaultPlugin;
  private ticketInput = '';
  private nameInput = '';

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app);
    this.plugin = plugin;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('peervault-add-device-modal');

    contentEl.createEl('h2', { text: 'Add Device' });

    contentEl.createEl('p', {
      text: 'Enter the connection ticket from your other device to pair them.',
      cls: 'peervault-help-text',
    });

    new Setting(contentEl).setName('Connection Ticket').setDesc('Paste the ticket from your other device').addTextArea((text) =>
      text.setPlaceholder('mock://... or iroh://...').onChange((value) => {
        this.ticketInput = value.trim();
      })
    );

    new Setting(contentEl).setName('Device Name').setDesc('Optional friendly name for this device').addText((text) =>
      text.setPlaceholder('e.g., Work Laptop').onChange((value) => {
        this.nameInput = value.trim();
      })
    );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Cancel')
        .onClick(() => {
          this.close();
        })
    ).addButton((btn) =>
      btn
        .setButtonText('Connect')
        .setCta()
        .onClick(async () => {
          await this.handleConnect();
        })
    );
  }

  override onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private async handleConnect(): Promise<void> {
    if (!this.ticketInput) {
      new Notice('Please enter a connection ticket');
      return;
    }

    try {
      new Notice('Connecting to peer...');
      await this.plugin.addPeer(this.ticketInput, this.nameInput || undefined);
      new Notice('Device connected successfully!');
      this.close();
    } catch (error) {
      this.plugin.logger.error('Failed to connect to peer:', error);
      new Notice(`Connection failed: ${error}`);
    }
  }
}

/**
 * Show Invite Modal
 *
 * Displays the connection ticket/QR code for other devices to connect.
 */
export class ShowInviteModal extends Modal {
  plugin: PeerVaultPlugin;
  private ticket = '';

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app);
    this.plugin = plugin;
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('peervault-invite-modal');

    contentEl.createEl('h2', { text: 'Your Connection Invite' });

    contentEl.createEl('p', {
      text: 'Scan this QR code or share the ticket with your other devices.',
      cls: 'peervault-help-text',
    });

    // Generate ticket
    const loadingEl = contentEl.createDiv({ cls: 'peervault-loading' });
    loadingEl.setText('Generating invite...');

    try {
      this.ticket = await this.plugin.generateInvite();
      loadingEl.remove();

      // QR Code container
      const qrContainer = contentEl.createDiv({ cls: 'peervault-qr-container' });
      await this.generateQRCode(qrContainer, this.ticket);

      // Show ticket
      const ticketContainer = contentEl.createDiv({ cls: 'peervault-ticket-container' });

      contentEl.createEl('h4', { text: 'Connection Ticket', cls: 'peervault-ticket-header' });

      const ticketEl = ticketContainer.createEl('textarea', {
        cls: 'peervault-ticket',
        attr: { readonly: 'true', rows: '3' },
      });
      ticketEl.value = this.ticket;

      // Copy button
      new Setting(contentEl).addButton((btn) =>
        btn.setButtonText('Copy Ticket').onClick(() => {
          navigator.clipboard.writeText(this.ticket);
          new Notice('Ticket copied to clipboard!');
        })
      );
    } catch (error) {
      loadingEl.setText(`Failed to generate invite: ${error}`);
    }
  }

  private async generateQRCode(container: HTMLElement, data: string): Promise<void> {
    try {
      // Dynamic import of qrcode library
      const QRCode = await import('qrcode');

      // Create canvas element
      const canvas = container.createEl('canvas', { cls: 'peervault-qr-canvas' });

      // Generate QR code
      await QRCode.toCanvas(canvas, data, {
        width: 200,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'M',
      });
    } catch (error) {
      // Fallback if QR code generation fails
      container.createEl('p', {
        text: 'QR code generation failed. Please use the ticket below.',
        cls: 'peervault-qr-error',
      });
      this.plugin.logger.error('QR code generation failed:', error);
    }
  }

  override onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
