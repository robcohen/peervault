/**
 * Confirmation Modal
 *
 * A reusable confirmation dialog that doesn't block the UI thread.
 */

import { App, Modal, Setting } from "obsidian";

export interface ConfirmOptions {
  /** Title of the confirmation dialog */
  title?: string;
  /** Message to display */
  message: string;
  /** Text for the confirm button */
  confirmText?: string;
  /** Text for the cancel button */
  cancelText?: string;
  /** Whether the confirm action is destructive (shows warning style) */
  isDestructive?: boolean;
}

/**
 * Show a confirmation modal and return a promise that resolves when the user decides.
 */
export function showConfirm(app: App, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new ConfirmModal(app, options, resolve);
    modal.open();
  });
}

/**
 * Modal for confirmation dialogs.
 */
class ConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private options: ConfirmOptions,
    private resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  private doResolve(value: boolean): void {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(value);
    }
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-confirm-modal");

    // Title
    if (this.options.title) {
      contentEl.createEl("h2", { text: this.options.title });
    }

    // Message - support multiline with line breaks
    const messageEl = contentEl.createDiv({ cls: "peervault-confirm-message" });
    const lines = this.options.message.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        messageEl.createEl("p", { text: line });
      } else {
        messageEl.createEl("br");
      }
    }

    // Buttons
    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(this.options.cancelText ?? "Cancel")
          .onClick(() => {
            this.doResolve(false);
            this.close();
          }),
      )
      .addButton((btn) => {
        btn.setButtonText(this.options.confirmText ?? "Confirm");
        if (this.options.isDestructive) {
          btn.setWarning();
        } else {
          btn.setCta();
        }
        btn.onClick(() => {
          this.doResolve(true);
          this.close();
        });
      });
  }

  override onClose(): void {
    // If modal is closed without clicking a button, treat as cancel
    this.doResolve(false);
    this.contentEl.empty();
  }
}
