/**
 * Pairing Modal
 *
 * Simple UI for device pairing via connection tickets.
 * - Share your ticket for other devices to connect
 * - Enter another device's ticket to connect to them
 */

import { App, Modal, Setting, Notice } from "obsidian";
import type PeerVaultPlugin from "../main";
import { formatUserError } from "../utils/validation";

export class PairingModal extends Modal {
  plugin: PeerVaultPlugin;
  private ticketInput = "";
  private myTicket = "";
  private isGenerating = false;

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app);
    this.plugin = plugin;
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

    // Generate ticket if needed
    if (!this.myTicket && !this.isGenerating) {
      this.isGenerating = true;
      const loadingEl = contentEl.createDiv({ cls: "peervault-loading" });
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
      contentEl.createDiv({
        cls: "peervault-loading",
        text: "Generating invite...",
      });
      return;
    }

    // === Your Ticket Section ===
    const shareSection = contentEl.createDiv({ cls: "peervault-section" });
    shareSection.createEl("h3", { text: "Your Invite Ticket" });
    shareSection.createEl("p", {
      text: "Share this ticket with another device to let them connect to you.",
      cls: "peervault-help-text",
    });

    const ticketDisplay = shareSection.createEl("textarea", {
      cls: "peervault-ticket",
      attr: { readonly: "true", rows: "3", spellcheck: "false" },
    });
    ticketDisplay.value = this.myTicket;

    new Setting(shareSection)
      .addButton((btn) =>
        btn.setButtonText("Copy Ticket").onClick(() => {
          navigator.clipboard.writeText(this.myTicket);
          new Notice("Ticket copied to clipboard!");
        }),
      );

    // Divider
    contentEl.createEl("hr", { cls: "peervault-divider" });

    // === Connect Section ===
    const connectSection = contentEl.createDiv({ cls: "peervault-section" });
    connectSection.createEl("h3", { text: "Connect to Another Device" });
    connectSection.createEl("p", {
      text: "Paste a ticket from another device to connect to them.",
      cls: "peervault-help-text",
    });

    const inputContainer = connectSection.createDiv({ cls: "peervault-input-container" });
    const ticketInput = inputContainer.createEl("textarea", {
      cls: "peervault-ticket-input",
      attr: { rows: "3", placeholder: "Paste ticket here...", spellcheck: "false" },
    });
    ticketInput.value = this.ticketInput;
    ticketInput.oninput = () => {
      this.ticketInput = ticketInput.value.trim();
    };

    new Setting(connectSection)
      .addButton((btn) =>
        btn.setButtonText("Paste").onClick(async () => {
          try {
            const text = await navigator.clipboard.readText();
            ticketInput.value = text.trim();
            this.ticketInput = text.trim();
          } catch {
            new Notice("Could not read clipboard");
          }
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

  private async handleConnect(): Promise<void> {
    if (!this.ticketInput) {
      new Notice("Please paste a connection ticket first");
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

// Legacy export for backwards compatibility
export type PairingTab = "show" | "scan" | "manual";
