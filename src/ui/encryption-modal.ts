/**
 * Encryption Settings Modal
 *
 * UI for configuring end-to-end encryption.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type PeerVaultPlugin from "../main";
import {
  getEncryptionService,
  deriveKeyFromPassword,
  generateSalt,
  exportKey,
  importKey,
  keyToRecoveryPhrase,
  recoveryPhraseToKey,
} from "../crypto";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";

/**
 * Modal for encryption setup and management.
 */
export class EncryptionModal extends Modal {
  private password = "";
  private confirmPassword = "";
  private recoveryPhrase = "";

  constructor(
    app: App,
    private plugin: PeerVaultPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-encryption-modal");

    const encryption = getEncryptionService();
    const isSetup =
      this.plugin.settings.encryptionEnabled &&
      this.plugin.settings.encryptedKey;

    if (isSetup) {
      this.renderManageView(contentEl);
    } else {
      this.renderSetupView(contentEl);
    }
  }

  override onClose(): void {
    // Clear sensitive data
    this.password = "";
    this.confirmPassword = "";
    this.recoveryPhrase = "";
    this.contentEl.empty();
  }

  // ===========================================================================
  // Setup View (First Time)
  // ===========================================================================

  private renderSetupView(container: HTMLElement): void {
    container.createEl("h2", { text: "Set Up Encryption" });

    container.createEl("p", {
      text: "End-to-end encryption ensures only your devices can read your synced data. Set a password to protect your encryption key.",
      cls: "peervault-help-text",
    });

    // Warning
    const warning = container.createDiv({ cls: "peervault-warning" });
    warning.createEl("strong", { text: "Important: " });
    warning.createSpan({
      text: "If you forget your password, you will not be able to decrypt your data. Save your recovery phrase in a safe place.",
    });

    // Password input
    new Setting(container)
      .setName("Password")
      .setDesc("Choose a strong password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.placeholder = "Enter password";
        text.onChange((value) => {
          this.password = value;
        });
      });

    new Setting(container)
      .setName("Confirm Password")
      .setDesc("Re-enter your password")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.placeholder = "Confirm password";
        text.onChange((value) => {
          this.confirmPassword = value;
        });
      });

    // Actions
    new Setting(container)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Enable Encryption")
          .setCta()
          .onClick(async () => {
            await this.setupEncryption();
          }),
      );

    // Alternative: Import existing key
    container.createEl("hr");
    container.createEl("h3", { text: "Or Import Existing Key" });

    new Setting(container)
      .setName("Recovery Phrase")
      .setDesc("Paste your recovery phrase from another device")
      .addTextArea((text) => {
        text.setPlaceholder("xxxxxxxx-xxxxxxxx-...");
        text.onChange((value) => {
          this.recoveryPhrase = value.trim();
        });
      });

    new Setting(container).addButton((btn) =>
      btn.setButtonText("Import Key").onClick(async () => {
        await this.importExistingKey();
      }),
    );
  }

  private async setupEncryption(): Promise<void> {
    // Validate
    if (this.password.length < 8) {
      new Notice("Password must be at least 8 characters");
      return;
    }

    if (this.password !== this.confirmPassword) {
      new Notice("Passwords do not match");
      return;
    }

    try {
      const encryption = getEncryptionService();

      // Generate new encryption key
      const key = encryption.generateKey();

      // Set the key so encryption is active
      encryption.setKey(key);

      // Generate salt and derive password key
      const salt = generateSalt();
      const passwordKey = await deriveKeyFromPassword(this.password, salt);

      // Encrypt the encryption key with the password-derived key
      const tempEncryption = new (
        await import("../crypto")
      ).EncryptionService();
      tempEncryption.setKey(passwordKey);
      const encryptedKey = tempEncryption.encrypt(key);

      // Save to settings
      this.plugin.settings.encryptionEnabled = true;
      this.plugin.settings.storageEncrypted = true;
      this.plugin.settings.encryptedKey = encodeBase64(encryptedKey);
      this.plugin.settings.keySalt = encodeBase64(salt);
      await this.plugin.saveSettings();

      // Re-encrypt all existing storage with the new key
      this.showReencryptionProgress(key);
    } catch (error) {
      this.plugin.logger.error("Failed to setup encryption:", error);
      new Notice(`Encryption setup failed: ${error}`);
    }
  }

  private showReencryptionProgress(key: Uint8Array): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Encrypting Storage..." });

    const progressContainer = contentEl.createDiv({
      cls: "peervault-progress-container",
    });
    const progressBar = progressContainer.createDiv({
      cls: "peervault-progress-bar-large",
    });
    const progressFill = progressBar.createDiv({
      cls: "peervault-progress-fill",
    });
    progressFill.style.width = "0%";

    const statusText = contentEl.createEl("p", {
      text: "Starting encryption...",
      cls: "peervault-help-text",
    });

    // Start re-encryption
    this.plugin.storage
      .reencryptAll((percent, message) => {
        progressFill.style.width = `${percent}%`;
        statusText.setText(message);
      })
      .then((result) => {
        // Show recovery phrase after re-encryption completes
        const phrase = keyToRecoveryPhrase(key);
        this.showRecoveryPhrase(phrase, result);
      })
      .catch((error) => {
        this.plugin.logger.error("Re-encryption failed:", error);
        new Notice(`Re-encryption failed: ${error}`);
        statusText.setText(`Error: ${error}`);
      });
  }

  private showRecoveryPhrase(
    phrase: string,
    encryptionResult?: { encrypted: number; skipped: number; failed: string[] },
  ): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Encryption Enabled!" });

    // Show encryption stats if available
    if (encryptionResult) {
      const statsEl = contentEl.createDiv({
        cls: "peervault-encryption-status",
      });
      statsEl.createEl("span", {
        text: `Encrypted ${encryptionResult.encrypted} files`,
      });
      if (encryptionResult.failed.length > 0) {
        statsEl.createEl("span", {
          text: ` (${encryptionResult.failed.length} failed)`,
          cls: "peervault-status-error",
        });
      }
    }

    contentEl.createEl("p", {
      text: "Save this recovery phrase in a safe place. You will need it to decrypt your data on new devices.",
      cls: "peervault-help-text",
    });

    const phraseEl = contentEl.createEl("textarea", {
      cls: "peervault-recovery-phrase",
      attr: { readonly: "true", rows: "3" },
    });
    phraseEl.value = phrase;

    const warning = contentEl.createDiv({ cls: "peervault-warning" });
    warning.createEl("strong", { text: "Warning: " });
    warning.createSpan({
      text: "This phrase will only be shown once. If you lose it, you cannot recover your encrypted data.",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Copy to Clipboard").onClick(() => {
          navigator.clipboard.writeText(phrase);
          new Notice("Recovery phrase copied to clipboard");
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("I've Saved It")
          .setCta()
          .onClick(() => {
            new Notice("Encryption is now active");
            this.close();
          }),
      );
  }

  private async importExistingKey(): Promise<void> {
    if (!this.recoveryPhrase) {
      new Notice("Please enter a recovery phrase");
      return;
    }

    try {
      const key = recoveryPhraseToKey(this.recoveryPhrase);
      const encryption = getEncryptionService();
      encryption.setKey(key);

      // We need a password to protect the imported key
      if (this.password.length < 8) {
        new Notice(
          "Please enter a password (at least 8 characters) to protect the imported key",
        );
        return;
      }

      // Generate salt and derive password key
      const salt = generateSalt();
      const passwordKey = await deriveKeyFromPassword(this.password, salt);

      // Encrypt the encryption key with the password-derived key
      const tempEncryption = new (
        await import("../crypto")
      ).EncryptionService();
      tempEncryption.setKey(passwordKey);
      const encryptedKey = tempEncryption.encrypt(key);

      // Save to settings
      this.plugin.settings.encryptionEnabled = true;
      this.plugin.settings.encryptedKey = encodeBase64(encryptedKey);
      this.plugin.settings.keySalt = encodeBase64(salt);
      await this.plugin.saveSettings();

      new Notice("Encryption key imported successfully");
      this.close();
    } catch (error) {
      this.plugin.logger.error("Failed to import key:", error);
      new Notice(`Import failed: ${error}`);
    }
  }

  // ===========================================================================
  // Manage View (Already Set Up)
  // ===========================================================================

  private renderManageView(container: HTMLElement): void {
    const encryption = getEncryptionService();

    container.createEl("h2", { text: "Encryption Settings" });

    // Status
    const status = container.createDiv({ cls: "peervault-encryption-status" });
    const isUnlocked = encryption.isEnabled();

    if (isUnlocked) {
      status.createEl("span", { text: "Status: ", cls: "peervault-label" });
      status.createEl("span", {
        text: "Unlocked",
        cls: "peervault-status-unlocked",
      });
    } else {
      status.createEl("span", { text: "Status: ", cls: "peervault-label" });
      status.createEl("span", {
        text: "Locked",
        cls: "peervault-status-locked",
      });

      // Unlock form
      container.createEl("p", {
        text: "Enter your password to unlock encryption.",
        cls: "peervault-help-text",
      });

      new Setting(container)
        .setName("Password")
        .addText((text) => {
          text.inputEl.type = "password";
          text.inputEl.placeholder = "Enter password";
          text.onChange((value) => {
            this.password = value;
          });
        })
        .addButton((btn) =>
          btn
            .setButtonText("Unlock")
            .setCta()
            .onClick(async () => {
              await this.unlockEncryption();
            }),
        );
    }

    // Actions when unlocked
    if (isUnlocked) {
      container.createEl("hr");

      new Setting(container)
        .setName("Show Recovery Phrase")
        .setDesc("Display your recovery phrase (keep it secret!)")
        .addButton((btn) =>
          btn.setButtonText("Show").onClick(() => {
            const key = encryption.getKey();
            if (key) {
              const phrase = keyToRecoveryPhrase(key);
              this.showRecoveryPhraseReadonly(phrase);
            }
          }),
        );

      new Setting(container)
        .setName("Change Password")
        .setDesc("Change the password protecting your encryption key")
        .addButton((btn) =>
          btn.setButtonText("Change").onClick(() => {
            this.showChangePassword();
          }),
        );
    }

    // Danger zone
    container.createEl("hr");
    container.createEl("h3", {
      text: "Danger Zone",
      cls: "peervault-danger-header",
    });

    new Setting(container)
      .setName("Disable Encryption")
      .setDesc(
        "Turn off encryption. Existing encrypted data will need to be re-synced.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Disable")
          .setWarning()
          .onClick(async () => {
            const confirmed = confirm(
              "Are you sure you want to disable encryption? This will require re-syncing all data.",
            );
            if (confirmed) {
              await this.disableEncryption();
            }
          }),
      );

    // Close button
    container.createEl("hr");
    new Setting(container).addButton((btn) =>
      btn.setButtonText("Close").onClick(() => this.close()),
    );
  }

  private async unlockEncryption(): Promise<void> {
    if (!this.password) {
      new Notice("Please enter your password");
      return;
    }

    try {
      const salt = decodeBase64(this.plugin.settings.keySalt!);
      const encryptedKey = decodeBase64(this.plugin.settings.encryptedKey!);

      // Derive password key
      const passwordKey = await deriveKeyFromPassword(this.password, salt);

      // Decrypt the encryption key
      const tempEncryption = new (
        await import("../crypto")
      ).EncryptionService();
      tempEncryption.setKey(passwordKey);
      const key = tempEncryption.decrypt(encryptedKey);

      // Set the actual encryption key
      const encryption = getEncryptionService();
      encryption.setKey(key);

      new Notice("Encryption unlocked");
      this.close();
      new EncryptionModal(this.app, this.plugin).open();
    } catch (error) {
      this.plugin.logger.error("Failed to unlock encryption:", error);
      new Notice("Wrong password or corrupted data");
    }
  }

  private showRecoveryPhraseReadonly(phrase: string): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Your Recovery Phrase" });

    const warning = contentEl.createDiv({ cls: "peervault-warning" });
    warning.createEl("strong", { text: "Keep this secret! " });
    warning.createSpan({
      text: "Anyone with this phrase can decrypt your data.",
    });

    const phraseEl = contentEl.createEl("textarea", {
      cls: "peervault-recovery-phrase",
      attr: { readonly: "true", rows: "3" },
    });
    phraseEl.value = phrase;

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Copy").onClick(() => {
          navigator.clipboard.writeText(phrase);
          new Notice("Copied to clipboard");
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Done")
          .setCta()
          .onClick(() => {
            this.close();
            new EncryptionModal(this.app, this.plugin).open();
          }),
      );
  }

  private showChangePassword(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Change Password" });

    let newPassword = "";
    let confirmNewPassword = "";

    new Setting(contentEl).setName("New Password").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("Enter new password");
      text.onChange((value) => {
        newPassword = value;
      });
    });

    new Setting(contentEl).setName("Confirm New Password").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("Confirm new password");
      text.onChange((value) => {
        confirmNewPassword = value;
      });
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => {
          this.close();
          new EncryptionModal(this.app, this.plugin).open();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Change Password")
          .setCta()
          .onClick(async () => {
            if (newPassword.length < 8) {
              new Notice("Password must be at least 8 characters");
              return;
            }
            if (newPassword !== confirmNewPassword) {
              new Notice("Passwords do not match");
              return;
            }

            try {
              const encryption = getEncryptionService();
              const key = encryption.getKey();
              if (!key) {
                new Notice("Encryption not unlocked");
                return;
              }

              // Generate new salt and derive new password key
              const salt = generateSalt();
              const passwordKey = await deriveKeyFromPassword(
                newPassword,
                salt,
              );

              // Encrypt the encryption key with the new password-derived key
              const tempEncryption = new (
                await import("../crypto")
              ).EncryptionService();
              tempEncryption.setKey(passwordKey);
              const encryptedKey = tempEncryption.encrypt(key);

              // Save to settings
              this.plugin.settings.encryptedKey = encodeBase64(encryptedKey);
              this.plugin.settings.keySalt = encodeBase64(salt);
              await this.plugin.saveSettings();

              new Notice("Password changed successfully");
              this.close();
            } catch (error) {
              this.plugin.logger.error("Failed to change password:", error);
              new Notice(`Failed: ${error}`);
            }
          }),
      );
  }

  private async disableEncryption(): Promise<void> {
    const encryption = getEncryptionService();

    // Check if encryption is unlocked (needed to decrypt files)
    if (!encryption.isEnabled()) {
      new Notice("Please unlock encryption first before disabling");
      return;
    }

    // Show decryption progress
    this.showDecryptionProgress();
  }

  private showDecryptionProgress(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Decrypting Storage..." });

    const progressContainer = contentEl.createDiv({
      cls: "peervault-progress-container",
    });
    const progressBar = progressContainer.createDiv({
      cls: "peervault-progress-bar-large",
    });
    const progressFill = progressBar.createDiv({
      cls: "peervault-progress-fill",
    });
    progressFill.style.width = "0%";

    const statusText = contentEl.createEl("p", {
      text: "Starting decryption...",
      cls: "peervault-help-text",
    });

    // Start decryption
    this.plugin.storage
      .decryptAll((percent, message) => {
        progressFill.style.width = `${percent}%`;
        statusText.setText(message);
      })
      .then(async (result) => {
        // Clear encryption settings
        const encryption = getEncryptionService();
        encryption.clearKey();

        this.plugin.settings.encryptionEnabled = false;
        this.plugin.settings.storageEncrypted = false;
        this.plugin.settings.encryptedKey = undefined;
        this.plugin.settings.keySalt = undefined;
        await this.plugin.saveSettings();

        // Show completion
        contentEl.empty();
        contentEl.createEl("h2", { text: "Encryption Disabled" });

        const statsEl = contentEl.createDiv({
          cls: "peervault-encryption-status",
        });
        statsEl.createEl("span", {
          text: `Decrypted ${result.decrypted} files`,
        });
        if (result.failed.length > 0) {
          statsEl.createEl("span", {
            text: ` (${result.failed.length} failed)`,
            cls: "peervault-status-error",
          });
        }

        new Setting(contentEl).addButton((btn) =>
          btn
            .setButtonText("Close")
            .setCta()
            .onClick(() => {
              this.close();
            }),
        );

        new Notice("Encryption disabled");
      })
      .catch((error) => {
        this.plugin.logger.error("Decryption failed:", error);
        new Notice(`Decryption failed: ${error}`);
        statusText.setText(`Error: ${error}`);
      });
  }
}
