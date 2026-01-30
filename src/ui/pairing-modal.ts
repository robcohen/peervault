/**
 * Pairing Modal
 *
 * Unified UI for device pairing with QR code support.
 * - Show QR: Display your invite QR for other devices to scan
 * - Scan QR: Decode QR from an image file or clipboard
 * - Manual: Paste a connection ticket directly
 */

import { App, Modal, Setting, Notice } from "obsidian";
import type PeerVaultPlugin from "../main";
import {
  generateQRCode,
  scanQRFromImage,
  scanQRFromClipboard,
} from "./utils/qr-utils";
import { formatUserError } from "../utils/validation";

export type PairingTab = "show" | "scan" | "manual";

export class PairingModal extends Modal {
  plugin: PeerVaultPlugin;
  private activeTab: PairingTab;
  private ticketInput = "";
  private myTicket = "";
  private isGenerating = false;

  constructor(app: App, plugin: PeerVaultPlugin, initialTab: PairingTab = "show") {
    super(app);
    this.plugin = plugin;
    this.activeTab = initialTab;
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("peervault-pairing-modal");
    await this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    // Header
    contentEl.createEl("h2", { text: "Pair Device" });

    // Tab buttons
    const tabContainer = contentEl.createDiv({ cls: "peervault-pairing-tabs" });
    this.createTabButton(tabContainer, "show", "Show QR Code");
    this.createTabButton(tabContainer, "scan", "Scan QR Code");
    this.createTabButton(tabContainer, "manual", "Enter Ticket");

    // Tab content
    const content = contentEl.createDiv({ cls: "peervault-pairing-content" });

    switch (this.activeTab) {
      case "show":
        await this.renderShowTab(content);
        break;
      case "scan":
        await this.renderScanTab(content);
        break;
      case "manual":
        this.renderManualTab(content);
        break;
    }
  }

  private createTabButton(
    container: HTMLElement,
    tab: PairingTab,
    label: string,
  ): void {
    const btn = container.createEl("button", {
      text: label,
      cls: `peervault-tab-btn ${this.activeTab === tab ? "active" : ""}`,
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
    container.createEl("p", {
      text: "Show this QR code to your other device to pair.",
      cls: "peervault-help-text",
    });

    // Generate ticket if needed
    if (!this.myTicket && !this.isGenerating) {
      this.isGenerating = true;
      const loadingEl = container.createDiv({ cls: "peervault-loading" });
      loadingEl.setText("Generating invite...");

      try {
        this.myTicket = await this.plugin.generateInvite();
        this.isGenerating = false;
        await this.render();
        return;
      } catch (error) {
        this.isGenerating = false;
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        loadingEl.setText(`Failed to generate invite: ${errorMsg}`);
        return;
      }
    }

    if (this.isGenerating) {
      container.createDiv({
        cls: "peervault-loading",
        text: "Generating invite...",
      });
      return;
    }

    // QR Code
    const qrContainer = container.createDiv({ cls: "peervault-qr-container" });
    await generateQRCode(qrContainer, this.myTicket, { width: 220 });

    // Ticket display
    const ticketSection = container.createDiv({
      cls: "peervault-ticket-section",
    });
    ticketSection.createEl("h4", {
      text: "Connection Ticket",
      cls: "peervault-ticket-header",
    });

    const ticketEl = ticketSection.createEl("textarea", {
      cls: "peervault-ticket",
      attr: { readonly: "true", rows: "3" },
    });
    ticketEl.value = this.myTicket;

    // Copy button
    new Setting(container).addButton((btn) =>
      btn.setButtonText("Copy Ticket").onClick(() => {
        navigator.clipboard.writeText(this.myTicket);
        new Notice("Ticket copied to clipboard!");
      }),
    );
  }


  // ===========================================================================
  // Scan QR Tab
  // ===========================================================================

  private async renderScanTab(container: HTMLElement): Promise<void> {
    container.createEl("p", {
      text: "Upload an image or paste a screenshot containing a QR code.",
      cls: "peervault-help-text",
    });

    // Drag and drop zone
    const dropZone = container.createDiv({ cls: "peervault-drop-zone" });
    dropZone.createEl("div", {
      text: "Drop an image here",
      cls: "peervault-drop-text",
    });
    dropZone.createEl("div", { text: "or", cls: "peervault-drop-separator" });

    // File input
    const fileInput = dropZone.createEl("input", {
      type: "file",
      attr: { accept: "image/*" },
      cls: "peervault-file-input",
    });

    const browseBtn = dropZone.createEl("button", {
      text: "Browse Files",
      cls: "peervault-browse-btn",
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
      dropZone.addClass("dragover");
    };

    dropZone.ondragleave = () => {
      dropZone.removeClass("dragover");
    };

    dropZone.ondrop = async (e) => {
      e.preventDefault();
      dropZone.removeClass("dragover");
      const file = e.dataTransfer?.files[0];
      if (file && file.type.startsWith("image/")) {
        await this.processQRImage(file);
      } else {
        new Notice("Please drop an image file");
      }
    };

    // Paste from clipboard button
    container.createEl("div", {
      cls: "peervault-scan-separator",
      text: "or paste from clipboard",
    });

    const pasteContainer = container.createDiv({
      cls: "peervault-paste-container",
    });
    const pasteBtn = pasteContainer.createEl("button", {
      text: "Paste from Clipboard",
      cls: "peervault-paste-btn",
    });

    pasteBtn.onclick = async () => {
      await this.pasteFromClipboard();
    };

  }

  private async processQRImage(file: File): Promise<void> {
    try {
      const result = await scanQRFromImage(file);
      if (result) {
        this.ticketInput = result;
        new Notice("QR code detected!");
        await this.handleConnect();
      } else {
        new Notice("No QR code found in image");
      }
    } catch (error) {
      this.plugin.logger.error("Failed to process QR image:", error);
      new Notice(`Failed to process image: ${formatUserError(error)}`);
    }
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      // First try scanning for QR image in clipboard
      const qrResult = await scanQRFromClipboard();
      if (qrResult) {
        this.ticketInput = qrResult;
        new Notice("QR code detected from clipboard!");
        await this.handleConnect();
        return;
      }

      // Fallback: check for text ticket
      const text = await navigator.clipboard.readText();
      if (text.startsWith("iroh://")) {
        this.ticketInput = text.trim();
        new Notice("Ticket detected from clipboard!");
        await this.handleConnect();
        return;
      }

      new Notice("No QR image or ticket found in clipboard");
    } catch (error) {
      this.plugin.logger.error("Clipboard access denied:", error);
      new Notice("Could not access clipboard. Please use file upload.");
    }
  }

  // ===========================================================================
  // Manual Tab
  // ===========================================================================

  private renderManualTab(container: HTMLElement): void {
    container.createEl("p", {
      text: "Paste the connection ticket from your other device.",
      cls: "peervault-help-text",
    });

    new Setting(container)
      .setName("Connection Ticket")
      .setDesc("Paste the ticket here")
      .addTextArea((text) =>
        text.setPlaceholder("iroh://...").onChange((value) => {
          this.ticketInput = value.trim();
        }),
      );

    new Setting(container)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Connect")
          .setCta()
          .onClick(async () => {
            await this.handleConnect();
          }),
      );
  }

  // ===========================================================================
  // Connect Handler
  // ===========================================================================

  private async handleConnect(): Promise<void> {
    if (!this.ticketInput) {
      new Notice("Please provide a connection ticket");
      return;
    }

    try {
      new Notice("Connecting to peer...");
      await this.plugin.addPeer(this.ticketInput);
      new Notice("Device connected successfully!");
      this.close();
    } catch (error) {
      this.plugin.logger.error("Failed to connect to peer:", error);
      new Notice(`Connection failed: ${formatUserError(error)}`);
    }
  }
}
