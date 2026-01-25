/**
 * Pairing Modal
 *
 * Unified UI for device pairing with QR code support.
 * - Show QR: Display your invite QR for other devices to scan
 * - Scan QR: Decode QR from an image file or clipboard
 * - Manual: Paste a connection ticket directly
 */

import { App, Modal, Setting, Notice } from 'obsidian';
import type PeerVaultPlugin from '../main';

type PairingTab = 'show' | 'scan' | 'manual';

export class PairingModal extends Modal {
  plugin: PeerVaultPlugin;
  private activeTab: PairingTab = 'show';
  private ticketInput = '';
  private nameInput = '';
  private myTicket = '';
  private isGenerating = false;

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app);
    this.plugin = plugin;
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass('peervault-pairing-modal');
    await this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    // Header
    contentEl.createEl('h2', { text: 'Pair Device' });

    // Tab buttons
    const tabContainer = contentEl.createDiv({ cls: 'peervault-pairing-tabs' });
    this.createTabButton(tabContainer, 'show', 'Show QR Code');
    this.createTabButton(tabContainer, 'scan', 'Scan QR Code');
    this.createTabButton(tabContainer, 'manual', 'Enter Ticket');

    // Tab content
    const content = contentEl.createDiv({ cls: 'peervault-pairing-content' });

    switch (this.activeTab) {
      case 'show':
        await this.renderShowTab(content);
        break;
      case 'scan':
        await this.renderScanTab(content);
        break;
      case 'manual':
        this.renderManualTab(content);
        break;
    }
  }

  private createTabButton(container: HTMLElement, tab: PairingTab, label: string): void {
    const btn = container.createEl('button', {
      text: label,
      cls: `peervault-tab-btn ${this.activeTab === tab ? 'active' : ''}`,
    });
    btn.onclick = async () => {
      this.activeTab = tab;
      await this.render();
    };
  }

  // ===========================================================================
  // Show QR Tab
  // ===========================================================================

  private async renderShowTab(container: HTMLElement): Promise<void> {
    container.createEl('p', {
      text: 'Show this QR code to your other device to pair.',
      cls: 'peervault-help-text',
    });

    // Generate ticket if needed
    if (!this.myTicket && !this.isGenerating) {
      this.isGenerating = true;
      const loadingEl = container.createDiv({ cls: 'peervault-loading' });
      loadingEl.setText('Generating invite...');

      try {
        this.myTicket = await this.plugin.generateInvite();
        this.isGenerating = false;
        await this.render();
        return;
      } catch (error) {
        this.isGenerating = false;
        loadingEl.setText(`Failed to generate invite: ${error}`);
        return;
      }
    }

    if (this.isGenerating) {
      container.createDiv({ cls: 'peervault-loading', text: 'Generating invite...' });
      return;
    }

    // QR Code
    const qrContainer = container.createDiv({ cls: 'peervault-qr-container' });
    await this.generateQRCode(qrContainer, this.myTicket);

    // Ticket display
    const ticketSection = container.createDiv({ cls: 'peervault-ticket-section' });
    ticketSection.createEl('h4', { text: 'Connection Ticket', cls: 'peervault-ticket-header' });

    const ticketEl = ticketSection.createEl('textarea', {
      cls: 'peervault-ticket',
      attr: { readonly: 'true', rows: '3' },
    });
    ticketEl.value = this.myTicket;

    // Copy button
    new Setting(container).addButton((btn) =>
      btn.setButtonText('Copy Ticket').onClick(() => {
        navigator.clipboard.writeText(this.myTicket);
        new Notice('Ticket copied to clipboard!');
      })
    );
  }

  private async generateQRCode(container: HTMLElement, data: string): Promise<void> {
    try {
      const QRCode = await import('qrcode');
      const canvas = container.createEl('canvas', { cls: 'peervault-qr-canvas' });

      // Check if dark mode is active
      const isDark = document.body.classList.contains('theme-dark');

      await QRCode.toCanvas(canvas, data, {
        width: 220,
        margin: 2,
        color: {
          dark: isDark ? '#ffffff' : '#000000',
          light: isDark ? '#1e1e1e' : '#ffffff',
        },
        errorCorrectionLevel: 'M',
      });
    } catch (error) {
      container.createEl('p', {
        text: 'QR code generation failed. Use the ticket below.',
        cls: 'peervault-qr-error',
      });
      this.plugin.logger.error('QR code generation failed:', error);
    }
  }

  // ===========================================================================
  // Scan QR Tab
  // ===========================================================================

  private async renderScanTab(container: HTMLElement): Promise<void> {
    container.createEl('p', {
      text: 'Upload an image or paste a screenshot containing a QR code.',
      cls: 'peervault-help-text',
    });

    // Drag and drop zone
    const dropZone = container.createDiv({ cls: 'peervault-drop-zone' });
    dropZone.createEl('div', { text: 'Drop an image here', cls: 'peervault-drop-text' });
    dropZone.createEl('div', { text: 'or', cls: 'peervault-drop-separator' });

    // File input
    const fileInput = dropZone.createEl('input', {
      type: 'file',
      attr: { accept: 'image/*' },
      cls: 'peervault-file-input',
    });

    const browseBtn = dropZone.createEl('button', {
      text: 'Browse Files',
      cls: 'peervault-browse-btn',
    });
    browseBtn.onclick = () => fileInput.click();

    // Handle file selection
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (file) {
        await this.processQRImage(file);
      }
    };

    // Handle drag and drop
    dropZone.ondragover = (e) => {
      e.preventDefault();
      dropZone.addClass('dragover');
    };

    dropZone.ondragleave = () => {
      dropZone.removeClass('dragover');
    };

    dropZone.ondrop = async (e) => {
      e.preventDefault();
      dropZone.removeClass('dragover');
      const file = e.dataTransfer?.files[0];
      if (file && file.type.startsWith('image/')) {
        await this.processQRImage(file);
      } else {
        new Notice('Please drop an image file');
      }
    };

    // Paste from clipboard button
    container.createEl('div', { cls: 'peervault-scan-separator', text: 'or paste from clipboard' });

    const pasteContainer = container.createDiv({ cls: 'peervault-paste-container' });
    const pasteBtn = pasteContainer.createEl('button', {
      text: 'Paste from Clipboard',
      cls: 'peervault-paste-btn',
    });

    pasteBtn.onclick = async () => {
      await this.pasteFromClipboard();
    };

    // Device name input for after scanning
    const nameSection = container.createDiv({ cls: 'peervault-name-section' });
    new Setting(nameSection)
      .setName('Device Name')
      .setDesc('Optional name for the device you\'re connecting to')
      .addText((text) =>
        text.setPlaceholder('e.g., Phone').onChange((value) => {
          this.nameInput = value.trim();
        })
      );
  }

  private async processQRImage(file: File): Promise<void> {
    try {
      const imageData = await this.loadImageData(file);
      const jsQR = (await import('jsqr')).default;

      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code) {
        this.ticketInput = code.data;
        new Notice('QR code detected!');
        await this.handleConnect();
      } else {
        new Notice('No QR code found in image');
      }
    } catch (error) {
      this.plugin.logger.error('Failed to process QR image:', error);
      new Notice(`Failed to process image: ${error}`);
    }
  }

  private async loadImageData(file: File): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve(imageData);
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = URL.createObjectURL(file);
    });
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      const clipboardItems = await navigator.clipboard.read();

      for (const item of clipboardItems) {
        // Check for image types
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const file = new File([blob], 'clipboard.png', { type: imageType });
          await this.processQRImage(file);
          return;
        }

        // Check for text (might be a ticket)
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();
          if (text.startsWith('mock://') || text.startsWith('iroh://')) {
            this.ticketInput = text.trim();
            new Notice('Ticket detected from clipboard!');
            await this.handleConnect();
            return;
          }
        }
      }

      new Notice('No QR image or ticket found in clipboard');
    } catch (error) {
      // Fallback for browsers that don't support clipboard.read()
      try {
        const text = await navigator.clipboard.readText();
        if (text.startsWith('mock://') || text.startsWith('iroh://')) {
          this.ticketInput = text.trim();
          new Notice('Ticket detected from clipboard!');
          await this.handleConnect();
        } else {
          new Notice('No ticket found in clipboard. Try copying an image.');
        }
      } catch {
        this.plugin.logger.error('Clipboard access denied:', error);
        new Notice('Could not access clipboard. Please use file upload.');
      }
    }
  }

  // ===========================================================================
  // Manual Tab
  // ===========================================================================

  private renderManualTab(container: HTMLElement): void {
    container.createEl('p', {
      text: 'Paste the connection ticket from your other device.',
      cls: 'peervault-help-text',
    });

    new Setting(container)
      .setName('Connection Ticket')
      .setDesc('Paste the ticket here')
      .addTextArea((text) =>
        text.setPlaceholder('mock://... or iroh://...').onChange((value) => {
          this.ticketInput = value.trim();
        })
      );

    new Setting(container)
      .setName('Device Name')
      .setDesc('Optional friendly name for this device')
      .addText((text) =>
        text.setPlaceholder('e.g., Work Laptop').onChange((value) => {
          this.nameInput = value.trim();
        })
      );

    new Setting(container)
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => {
          this.close();
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText('Connect')
          .setCta()
          .onClick(async () => {
            await this.handleConnect();
          })
      );
  }

  // ===========================================================================
  // Connect Handler
  // ===========================================================================

  private async handleConnect(): Promise<void> {
    if (!this.ticketInput) {
      new Notice('Please provide a connection ticket');
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
