/**
 * Cloud Section
 *
 * Settings UI for S3-compatible cloud sync configuration.
 */

import { Setting, Notice, Modal, TextComponent, App } from "obsidian";
import type { SectionContext } from "./types";
import type { CloudStorageConfig, CloudSyncState, SyncProgress, ConflictResolutionStrategy } from "../../cloud/types";

export function renderCloudSection(
  container: HTMLElement,
  ctx: SectionContext,
): void {
  const { app, plugin, refresh, expandedSections } = ctx;
  const isExpanded = expandedSections.has("cloud");

  new Setting(container)
    .setName("Cloud Sync")
    .setHeading()
    .addExtraButton((btn) =>
      btn
        .setIcon(isExpanded ? "chevron-up" : "chevron-down")
        .setTooltip(isExpanded ? "Collapse" : "Expand")
        .onClick(() => {
          if (isExpanded) expandedSections.delete("cloud");
          else expandedSections.add("cloud");
          refresh();
        }),
    );

  if (!isExpanded) return;

  const cloudSync = plugin.getCloudSync?.();
  const isConfigured = cloudSync?.isConfigured() ?? false;
  const state = cloudSync?.getState();

  if (!isConfigured) {
    // Not configured - show setup option
    new Setting(container)
      .setName("Status")
      .setDesc("Cloud sync is not configured. Set up S3-compatible storage to enable offline sync.");

    new Setting(container)
      .setName("Configure Cloud Storage")
      .setDesc("Connect to S3, Cloudflare R2, or other S3-compatible storage")
      .addButton((btn) =>
        btn
          .setButtonText("Configure")
          .setCta()
          .onClick(() => {
            new CloudConfigModal(app, async (config) => {
              const success = await cloudSync?.configure(config);
              if (success) {
                new Notice("Cloud sync configured successfully");
                refresh();
                return true;
              } else {
                new Notice("Failed to connect to cloud storage");
                return false;
              }
            }).open();
          }),
      );

    return;
  }

  // Configured - show status and controls
  renderCloudStatus(container, state);

  // Encryption key section
  // Check both cloudSync state and persisted vault key
  const cloudHasKey = state?.hasVaultKey ?? false;
  const vaultKeyManager = plugin.getVaultKeyManager?.();

  // If there's a persisted key but cloudSync doesn't have it, load it
  const checkAndLoadKey = async () => {
    if (!cloudHasKey && vaultKeyManager) {
      const persistedKey = await vaultKeyManager.getKey();
      if (persistedKey) {
        cloudSync?.setVaultKey(persistedKey);
        refresh();
      }
    }
  };
  checkAndLoadKey();

  const hasKey = cloudHasKey;

  new Setting(container)
    .setName("Encryption Key")
    .setDesc(
      hasKey
        ? "Encryption key is set. All data is encrypted before upload."
        : "Set a passphrase to encrypt your data. Required for syncing.",
    )
    .addButton((btn) => {
      if (hasKey) {
        btn.setButtonText("Change Key").onClick(() => {
          new SetEncryptionKeyModal(app, async (passphrase) => {
            const key = await deriveKeyFromPassphrase(passphrase);
            // Persist the key for future reloads
            try {
              await plugin.importVaultKey?.(key);
            } catch (e) {
              console.warn("Could not persist key:", e);
            }
            cloudSync?.setVaultKey(key);
            new Notice("Encryption key updated");
            refresh();
            return true;
          }).open();
        });
      } else {
        btn
          .setButtonText("Set Key")
          .setCta()
          .onClick(() => {
            new SetEncryptionKeyModal(app, async (passphrase) => {
              const key = await deriveKeyFromPassphrase(passphrase);
              // Persist the key for future reloads
              try {
                await plugin.importVaultKey?.(key);
              } catch (e) {
                console.warn("Could not persist key:", e);
              }
              cloudSync?.setVaultKey(key);
              new Notice("Encryption key set");
              refresh();
              return true;
            }).open();
          });
      }
    });

  // Warning if no key is set
  if (!hasKey) {
    const warningEl = container.createDiv({ cls: "peervault-warning" });
    warningEl.style.padding = "10px";
    warningEl.style.marginBottom = "10px";
    warningEl.style.borderRadius = "4px";
    warningEl.style.backgroundColor = "var(--background-modifier-warning)";
    warningEl.style.color = "var(--text-warning)";
    warningEl.textContent =
      "⚠ Set an encryption key before syncing. Without it, your data cannot be encrypted.";
  }

  // Progress bar (hidden by default)
  const progressContainer = container.createDiv({ cls: "peervault-cloud-progress" });
  progressContainer.style.display = "none";
  progressContainer.style.marginBottom = "16px";

  const progressLabel = progressContainer.createDiv();
  progressLabel.style.fontSize = "12px";
  progressLabel.style.marginBottom = "4px";

  const progressBarOuter = progressContainer.createDiv();
  progressBarOuter.style.height = "6px";
  progressBarOuter.style.backgroundColor = "var(--background-modifier-border)";
  progressBarOuter.style.borderRadius = "3px";
  progressBarOuter.style.overflow = "hidden";

  const progressBarInner = progressBarOuter.createDiv();
  progressBarInner.style.height = "100%";
  progressBarInner.style.width = "0%";
  progressBarInner.style.backgroundColor = "var(--interactive-accent)";
  progressBarInner.style.transition = "width 0.2s ease";

  const progressDetails = progressContainer.createDiv();
  progressDetails.style.fontSize = "11px";
  progressDetails.style.color = "var(--text-muted)";
  progressDetails.style.marginTop = "4px";

  // Subscribe to progress events
  const updateProgress = (progress: SyncProgress) => {
    progressContainer.style.display = "block";
    const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
    progressBarInner.style.width = `${percent}%`;

    const phaseText = {
      preparing: "Preparing...",
      downloading: "Downloading",
      uploading: "Uploading",
      finalizing: "Finalizing...",
    }[progress.phase];

    progressLabel.textContent = `${phaseText} ${progress.completed}/${progress.total}`;

    if (progress.bytesTransferred > 0) {
      const kb = (progress.bytesTransferred / 1024).toFixed(1);
      progressDetails.textContent = progress.currentItem
        ? `${kb} KB transferred | ${progress.currentItem}`
        : `${kb} KB transferred`;
    } else {
      progressDetails.textContent = progress.currentItem || "";
    }
  };

  const hideProgress = () => {
    progressContainer.style.display = "none";
    progressBarInner.style.width = "0%";
  };

  // Register event listeners if cloudSync is available
  if (cloudSync) {
    cloudSync.on("progress:sync", updateProgress);
    cloudSync.on("sync:complete", hideProgress);
    cloudSync.on("sync:error", hideProgress);
  }

  // Sync controls
  new Setting(container)
    .setName("Sync Now")
    .setDesc("Manually sync with cloud storage")
    .addButton((btn) =>
      btn
        .setButtonText("Sync")
        .setDisabled(state?.status === "syncing")
        .onClick(async () => {
          btn.setButtonText("Syncing...");
          btn.setDisabled(true);
          try {
            const result = await cloudSync?.sync();
            if (result?.success) {
              const parts = [];
              if (result.deltasUploaded > 0 || result.deltasDownloaded > 0) {
                parts.push(`${result.deltasUploaded} deltas up, ${result.deltasDownloaded} down`);
              }
              if (result.blobsUploaded > 0 || result.blobsDownloaded > 0) {
                parts.push(`${result.blobsUploaded} blobs up, ${result.blobsDownloaded} down`);
              }
              new Notice(parts.length > 0 ? `Synced: ${parts.join(", ")}` : "Already in sync");
            } else {
              new Notice(`Sync failed: ${result?.error || "Unknown error"}`);
            }
          } catch (error) {
            new Notice(`Sync failed: ${error}`);
          } finally {
            refresh();
          }
        }),
    );

  // Create commit
  new Setting(container)
    .setName("Create Snapshot")
    .setDesc("Create a named snapshot (commit) of the current state")
    .addButton((btn) =>
      btn.setButtonText("Create Snapshot").onClick(() => {
        new CreateCommitModal(app, async (message) => {
          const commit = await cloudSync?.commit({ message, push: true });
          if (commit) {
            new Notice(`Snapshot created: ${commit.hash.slice(0, 8)}`);
            refresh();
            return true;
          } else {
            new Notice("Failed to create snapshot");
            return false;
          }
        }).open();
      }),
    );

  // Auto-sync toggle and interval
  const autoSyncEnabled = plugin.settings?.cloudAutoSync ?? false;
  const autoSyncInterval = plugin.settings?.cloudAutoSyncInterval ?? 5;

  new Setting(container)
    .setName("Auto-sync")
    .setDesc("Automatically sync with cloud storage periodically")
    .addToggle((toggle) =>
      toggle.setValue(autoSyncEnabled).onChange(async (value) => {
        if (plugin.settings) {
          plugin.settings.cloudAutoSync = value;
          await plugin.saveSettings();
          if (value) {
            const intervalMs = (plugin.settings.cloudAutoSyncInterval ?? 5) * 60 * 1000;
            cloudSync?.startAutoSync(intervalMs);
            new Notice("Cloud auto-sync enabled");
          } else {
            cloudSync?.stopAutoSync();
            new Notice("Cloud auto-sync disabled");
          }
          refresh();
        }
      }),
    );

  // Auto-sync interval (only shown if auto-sync is enabled)
  if (autoSyncEnabled) {
    new Setting(container)
      .setName("Sync Interval")
      .setDesc("How often to sync with cloud storage")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "Every 1 minute")
          .addOption("5", "Every 5 minutes")
          .addOption("15", "Every 15 minutes")
          .addOption("30", "Every 30 minutes")
          .addOption("60", "Every hour")
          .setValue(String(autoSyncInterval))
          .onChange(async (value) => {
            if (plugin.settings) {
              plugin.settings.cloudAutoSyncInterval = parseInt(value, 10);
              await plugin.saveSettings();
              // Restart auto-sync with new interval
              const intervalMs = parseInt(value, 10) * 60 * 1000;
              cloudSync?.startAutoSync(intervalMs);
              new Notice(`Cloud sync interval set to ${value} minute(s)`);
            }
          }),
      );
  }

  // Conflict resolution strategy
  new Setting(container)
    .setName("Conflict Resolution")
    .setDesc("How to handle conflicts when syncing with cloud")
    .addDropdown((dropdown) =>
      dropdown
        .addOption("merge", "Auto-merge (recommended)")
        .addOption("local", "Keep local changes")
        .addOption("remote", "Keep remote changes")
        .addOption("manual", "Ask me")
        .setValue("merge")
        .onChange((value) => {
          cloudSync?.setConflictStrategy(value as ConflictResolutionStrategy);
        }),
    );

  // View commit history
  const hasSnapshots = !!state?.headCommit;
  new Setting(container)
    .setName("Snapshot History")
    .setDesc(hasSnapshots ? "View and restore previous snapshots" : "No snapshots yet")
    .addButton((btn) =>
      btn
        .setButtonText("View History")
        .setDisabled(!hasSnapshots)
        .onClick(async () => {
          const commits = await cloudSync?.getCommitHistory(20);
          if (commits && commits.length > 0) {
            new CommitHistoryModal(app, commits, async (hash) => {
              const result = await cloudSync?.restoreToCommit(hash);
              if (result?.success) {
                refresh();
                return true;
              }
              return false;
            }).open();
          } else {
            new Notice("No snapshots found");
          }
        }),
    );

  // Storage stats
  const statsContainer = container.createDiv({ cls: "peervault-storage-stats" });
  statsContainer.style.marginTop = "16px";
  statsContainer.style.marginBottom = "16px";
  statsContainer.style.padding = "12px";
  statsContainer.style.backgroundColor = "var(--background-secondary)";
  statsContainer.style.borderRadius = "6px";

  const statsHeader = statsContainer.createDiv();
  statsHeader.style.display = "flex";
  statsHeader.style.justifyContent = "space-between";
  statsHeader.style.alignItems = "center";
  statsHeader.style.marginBottom = "8px";

  const statsTitle = statsHeader.createSpan({ text: "Storage Usage" });
  statsTitle.style.fontWeight = "600";

  const refreshBtn = statsHeader.createEl("button", { text: "Refresh" });
  refreshBtn.style.fontSize = "11px";
  refreshBtn.style.padding = "2px 8px";

  const statsContent = statsContainer.createDiv();
  statsContent.style.fontSize = "12px";
  statsContent.style.color = "var(--text-muted)";
  statsContent.textContent = "Loading...";

  const loadStats = async () => {
    statsContent.textContent = "Loading...";
    refreshBtn.disabled = true;
    try {
      const stats = await cloudSync?.getStorageStats();
      if (stats) {
        const sizeStr = formatBytes(stats.totalBytes);
        statsContent.innerHTML = `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px;">
            <span>Total Size:</span><span style="text-align: right;">${sizeStr}</span>
            <span>Deltas:</span><span style="text-align: right;">${stats.deltaCount}</span>
            <span>Blobs:</span><span style="text-align: right;">${stats.blobCount}</span>
            <span>Commits:</span><span style="text-align: right;">${stats.commitCount}</span>
          </div>
        `;
      } else {
        statsContent.textContent = "Unable to load stats";
      }
    } catch (e) {
      statsContent.textContent = "Error loading stats";
    }
    refreshBtn.disabled = false;
  };

  refreshBtn.onclick = loadStats;
  loadStats();

  // Backup & Restore Section
  const backupSection = container.createDiv({ cls: "peervault-backup-section" });
  backupSection.style.marginTop = "16px";
  backupSection.style.marginBottom = "16px";
  backupSection.style.padding = "12px";
  backupSection.style.backgroundColor = "var(--background-secondary)";
  backupSection.style.borderRadius = "6px";

  const backupTitle = backupSection.createDiv({ text: "Backup & Restore" });
  backupTitle.style.fontWeight = "600";
  backupTitle.style.marginBottom = "8px";

  const backupDesc = backupSection.createDiv({
    text: "Export all cloud data as an encrypted backup file, or restore from a previous backup.",
  });
  backupDesc.style.fontSize = "12px";
  backupDesc.style.color = "var(--text-muted)";
  backupDesc.style.marginBottom = "12px";

  const backupButtons = backupSection.createDiv();
  backupButtons.style.display = "flex";
  backupButtons.style.gap = "8px";

  // Export button
  const exportBtn = backupButtons.createEl("button", { text: "Export Backup" });
  exportBtn.onclick = async () => {
    if (!state?.hasVaultKey) {
      new Notice("Set an encryption key before exporting");
      return;
    }

    exportBtn.disabled = true;
    exportBtn.textContent = "Exporting...";

    try {
      const result = await cloudSync?.exportBackup();
      if (result?.success && result.data) {
        // Create download - convert Uint8Array to ArrayBuffer for Blob compatibility
        const buffer = new ArrayBuffer(result.data.length);
        new Uint8Array(buffer).set(result.data);
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `peervault-backup-${new Date().toISOString().slice(0, 10)}.pvbackup`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        new Notice(`Backup exported: ${result.stats?.deltas} deltas, ${result.stats?.blobs} blobs`);
      } else {
        new Notice(`Export failed: ${result?.error || "Unknown error"}`);
      }
    } catch (error) {
      new Notice(`Export failed: ${error}`);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = "Export Backup";
    }
  };

  // Import button
  const importBtn = backupButtons.createEl("button", { text: "Import Backup" });
  importBtn.onclick = async () => {
    if (!state?.hasVaultKey) {
      new Notice("Set an encryption key before importing");
      return;
    }

    // Create file input
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pvbackup";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      const confirmed = await showConfirmImport(app, file.name);
      if (!confirmed) return;

      importBtn.disabled = true;
      importBtn.textContent = "Importing...";

      try {
        const buffer = await file.arrayBuffer();
        const data = new Uint8Array(buffer);
        const result = await cloudSync?.importBackup(data);

        if (result?.success) {
          new Notice(`Backup imported: ${result.stats?.deltas} deltas, ${result.stats?.blobs} blobs`);
          refresh();
        } else {
          new Notice(`Import failed: ${result?.error || "Unknown error"}`);
        }
      } catch (error) {
        new Notice(`Import failed: ${error}`);
      } finally {
        importBtn.disabled = false;
        importBtn.textContent = "Import Backup";
      }
    };
    input.click();
  };

  // Download full state button
  const downloadBtn = backupButtons.createEl("button", { text: "Download from Cloud" });
  downloadBtn.title = "Download all cloud data to restore this device";
  downloadBtn.onclick = async () => {
    if (!state?.hasVaultKey) {
      new Notice("Set an encryption key first");
      return;
    }

    const confirmed = await showConfirmDownload(app);
    if (!confirmed) return;

    downloadBtn.disabled = true;
    downloadBtn.textContent = "Downloading...";

    try {
      const result = await cloudSync?.downloadFullState();
      if (result?.success) {
        new Notice("Cloud data downloaded and applied");
        refresh();
      } else {
        new Notice(`Download failed: ${result?.error || "Unknown error"}`);
      }
    } catch (error) {
      new Notice(`Download failed: ${error}`);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "Download from Cloud";
    }
  };

  // Reconfigure / Disconnect
  new Setting(container)
    .setName("Disconnect")
    .setDesc("Remove cloud storage configuration")
    .addButton((btn) =>
      btn
        .setButtonText("Disconnect")
        .setWarning()
        .onClick(async () => {
          const confirmed = await showConfirmDisconnect(app);
          if (confirmed) {
            await cloudSync?.disable();
            new Notice("Cloud sync disconnected");
            refresh();
          }
        }),
    );
}

/**
 * Render cloud sync status.
 */
function renderCloudStatus(container: HTMLElement, state?: CloudSyncState): void {
  if (!state) return;

  let statusText = "";
  let statusClass = "";

  switch (state.status) {
    case "idle":
      statusText = "Connected";
      statusClass = "mod-success";
      break;
    case "syncing":
      statusText = "Syncing...";
      statusClass = "mod-warning";
      break;
    case "uploading":
      statusText = "Uploading...";
      statusClass = "mod-warning";
      break;
    case "downloading":
      statusText = "Downloading...";
      statusClass = "mod-warning";
      break;
    case "error":
      statusText = `Error: ${state.error || "Unknown"}`;
      statusClass = "mod-error";
      break;
    default:
      statusText = "Unknown";
  }

  const setting = new Setting(container).setName("Status");

  // Create status badge
  const badge = document.createElement("span");
  badge.textContent = statusText;
  badge.className = `peervault-status-badge ${statusClass}`;
  badge.style.padding = "2px 8px";
  badge.style.borderRadius = "4px";
  badge.style.fontSize = "12px";
  if (statusClass === "mod-success") {
    badge.style.backgroundColor = "var(--background-modifier-success)";
    badge.style.color = "var(--text-success)";
  } else if (statusClass === "mod-warning") {
    badge.style.backgroundColor = "var(--background-modifier-warning)";
    badge.style.color = "var(--text-warning)";
  } else if (statusClass === "mod-error") {
    badge.style.backgroundColor = "var(--background-modifier-error)";
    badge.style.color = "var(--text-error)";
  }

  setting.descEl.appendChild(badge);

  // Show additional info
  const infoLines: string[] = [];
  if (state.lastSyncedAt) {
    const ago = formatTimeAgo(state.lastSyncedAt);
    infoLines.push(`Last synced: ${ago}`);
  }
  if (state.pendingUploads > 0) {
    infoLines.push(`${state.pendingUploads} pending upload${state.pendingUploads > 1 ? "s" : ""}`);
  }
  if (state.headCommit) {
    infoLines.push(`HEAD: ${state.headCommit.slice(0, 8)}`);
  }

  if (infoLines.length > 0) {
    const infoEl = document.createElement("div");
    infoEl.style.marginTop = "4px";
    infoEl.style.fontSize = "12px";
    infoEl.style.color = "var(--text-muted)";
    infoEl.textContent = infoLines.join(" | ");
    setting.descEl.appendChild(infoEl);
  }
}

/**
 * Format time ago string.
 */
function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Modal for configuring cloud storage.
 */
class CloudConfigModal extends Modal {
  private onSave: (config: CloudStorageConfig) => Promise<boolean>;
  private endpoint = "";
  private bucket = "";
  private accessKeyId = "";
  private secretAccessKey = "";
  private region = "auto";

  constructor(app: App, onSave: (config: CloudStorageConfig) => Promise<boolean>) {
    super(app);
    this.onSave = onSave;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("peervault-modal");

    contentEl.createEl("h2", { text: "Configure Cloud Storage" });

    contentEl.createEl("p", {
      text: "Enter your S3-compatible storage credentials. Supports AWS S3, Cloudflare R2, MinIO, and others.",
    });

    const form = contentEl.createDiv({ cls: "peervault-form" });

    // Endpoint
    new Setting(form)
      .setName("Endpoint URL")
      .setDesc("S3-compatible endpoint (e.g., https://xxx.r2.cloudflarestorage.com)")
      .addText((text) => {
        text
          .setPlaceholder("https://...")
          .setValue(this.endpoint)
          .onChange((value) => {
            this.endpoint = value;
          });
        text.inputEl.style.width = "300px";
      });

    // Bucket
    new Setting(form)
      .setName("Bucket Name")
      .setDesc("The bucket to store sync data")
      .addText((text) => {
        text
          .setPlaceholder("my-bucket")
          .setValue(this.bucket)
          .onChange((value) => {
            this.bucket = value;
          });
      });

    // Access Key ID
    new Setting(form)
      .setName("Access Key ID")
      .addText((text) => {
        text
          .setPlaceholder("AKIAIOSFODNN7EXAMPLE")
          .setValue(this.accessKeyId)
          .onChange((value) => {
            this.accessKeyId = value;
          });
        text.inputEl.style.width = "250px";
      });

    // Secret Access Key
    new Setting(form)
      .setName("Secret Access Key")
      .addText((text) => {
        text
          .setPlaceholder("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
          .setValue(this.secretAccessKey)
          .onChange((value) => {
            this.secretAccessKey = value;
          });
        text.inputEl.type = "password";
        text.inputEl.style.width = "300px";
      });

    // Region (optional)
    new Setting(form)
      .setName("Region")
      .setDesc("AWS region (default: auto for R2)")
      .addText((text) => {
        text
          .setPlaceholder("auto")
          .setValue(this.region)
          .onChange((value) => {
            this.region = value || "auto";
          });
      });

    // Error message area
    const errorEl = form.createDiv({ cls: "peervault-error" });
    errorEl.style.color = "var(--text-error)";
    errorEl.style.marginTop = "10px";

    // Buttons
    const buttonDiv = form.createDiv({ cls: "peervault-buttons" });
    buttonDiv.style.display = "flex";
    buttonDiv.style.gap = "10px";
    buttonDiv.style.marginTop = "20px";

    const cancelBtn = buttonDiv.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    const saveBtn = buttonDiv.createEl("button", {
      text: "Connect",
      cls: "mod-cta",
    });
    saveBtn.onclick = async () => {
      // Validate
      if (!this.endpoint) {
        errorEl.textContent = "Endpoint URL is required";
        return;
      }
      if (!this.bucket) {
        errorEl.textContent = "Bucket name is required";
        return;
      }
      if (!this.accessKeyId) {
        errorEl.textContent = "Access Key ID is required";
        return;
      }
      if (!this.secretAccessKey) {
        errorEl.textContent = "Secret Access Key is required";
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "Connecting...";
      errorEl.textContent = "";

      const config: CloudStorageConfig = {
        endpoint: this.endpoint.trim(),
        bucket: this.bucket.trim(),
        accessKeyId: this.accessKeyId.trim(),
        secretAccessKey: this.secretAccessKey.trim(),
        region: this.region.trim(),
      };

      const success = await this.onSave(config);
      if (success) {
        this.close();
      } else {
        errorEl.textContent = "Failed to connect. Check your credentials and endpoint.";
        saveBtn.disabled = false;
        saveBtn.textContent = "Connect";
      }
    };
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Modal for creating a commit/snapshot.
 */
class CreateCommitModal extends Modal {
  private onSave: (message: string) => Promise<boolean>;
  private message = "";

  constructor(app: App, onSave: (message: string) => Promise<boolean>) {
    super(app);
    this.onSave = onSave;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("peervault-modal");

    contentEl.createEl("h2", { text: "Create Snapshot" });

    contentEl.createEl("p", {
      text: "Create a named snapshot of the current vault state. You can restore to this point later.",
    });

    const form = contentEl.createDiv({ cls: "peervault-form" });

    // Message input
    new Setting(form)
      .setName("Snapshot Message")
      .setDesc("A short description of this snapshot")
      .addText((text) => {
        text
          .setPlaceholder("e.g., Before major reorganization")
          .setValue(this.message)
          .onChange((value) => {
            this.message = value;
          });
        text.inputEl.style.width = "300px";
      });

    // Error message area
    const errorEl = form.createDiv({ cls: "peervault-error" });
    errorEl.style.color = "var(--text-error)";
    errorEl.style.marginTop = "10px";

    // Buttons
    const buttonDiv = form.createDiv({ cls: "peervault-buttons" });
    buttonDiv.style.display = "flex";
    buttonDiv.style.gap = "10px";
    buttonDiv.style.marginTop = "20px";

    const cancelBtn = buttonDiv.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    const saveBtn = buttonDiv.createEl("button", {
      text: "Create Snapshot",
      cls: "mod-cta",
    });
    saveBtn.onclick = async () => {
      if (!this.message.trim()) {
        errorEl.textContent = "Please enter a message";
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "Creating...";

      const success = await this.onSave(this.message);
      if (success) {
        this.close();
      } else {
        errorEl.textContent = "Failed to create snapshot";
        saveBtn.disabled = false;
        saveBtn.textContent = "Create Snapshot";
      }
    };
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Modal for viewing commit history with restore option.
 */
class CommitHistoryModal extends Modal {
  private commits: Array<{
    hash: string;
    message: string;
    timestamp: number;
    deviceId: string;
    deviceNickname?: string;
  }>;
  private onRestore?: (hash: string) => Promise<boolean>;

  constructor(
    app: App,
    commits: Array<{
      hash: string;
      message: string;
      timestamp: number;
      deviceId: string;
      deviceNickname?: string;
    }>,
    onRestore?: (hash: string) => Promise<boolean>,
  ) {
    super(app);
    this.commits = commits;
    this.onRestore = onRestore;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("peervault-modal");

    contentEl.createEl("h2", { text: "Snapshot History" });

    if (this.commits.length === 0) {
      contentEl.createEl("p", { text: "No snapshots found." });
      return;
    }

    const list = contentEl.createDiv({ cls: "peervault-commit-list" });
    list.style.maxHeight = "400px";
    list.style.overflowY = "auto";

    for (let i = 0; i < this.commits.length; i++) {
      const commit = this.commits[i]!;
      const isLatest = i === 0;

      const item = list.createDiv({ cls: "peervault-commit-item" });
      item.style.padding = "10px";
      item.style.borderBottom = "1px solid var(--background-modifier-border)";
      item.style.display = "flex";
      item.style.justifyContent = "space-between";
      item.style.alignItems = "flex-start";

      const infoDiv = item.createDiv();

      const header = infoDiv.createDiv({ cls: "peervault-commit-header" });
      header.style.display = "flex";
      header.style.gap = "8px";
      header.style.alignItems = "center";
      header.style.marginBottom = "4px";

      const hashEl = header.createEl("code", { text: commit.hash.slice(0, 8) });
      hashEl.style.fontSize = "12px";
      hashEl.style.color = "var(--text-accent)";

      if (isLatest) {
        const latestBadge = header.createSpan({ text: "HEAD" });
        latestBadge.style.fontSize = "10px";
        latestBadge.style.padding = "1px 4px";
        latestBadge.style.borderRadius = "3px";
        latestBadge.style.backgroundColor = "var(--interactive-accent)";
        latestBadge.style.color = "var(--text-on-accent)";
      }

      const dateEl = header.createSpan({ text: new Date(commit.timestamp).toLocaleString() });
      dateEl.style.fontSize = "12px";
      dateEl.style.color = "var(--text-muted)";

      const messageEl = infoDiv.createDiv({ text: commit.message });
      messageEl.style.fontWeight = "500";

      if (commit.deviceNickname) {
        const deviceEl = infoDiv.createDiv({ text: `by ${commit.deviceNickname}` });
        deviceEl.style.fontSize = "12px";
        deviceEl.style.color = "var(--text-muted)";
        deviceEl.style.marginTop = "2px";
      }

      // Restore button (not shown for HEAD)
      if (!isLatest && this.onRestore) {
        const restoreBtn = item.createEl("button", { text: "Restore" });
        restoreBtn.style.fontSize = "12px";
        restoreBtn.style.flexShrink = "0";
        restoreBtn.onclick = async () => {
          const confirmed = await showRestoreConfirm(this.app, commit);
          if (confirmed) {
            restoreBtn.disabled = true;
            restoreBtn.textContent = "Restoring...";
            const success = await this.onRestore!(commit.hash);
            if (success) {
              new Notice(`Restored to snapshot ${commit.hash.slice(0, 8)}`);
              this.close();
            } else {
              new Notice("Restore failed");
              restoreBtn.disabled = false;
              restoreBtn.textContent = "Restore";
            }
          }
        };
      }
    }

    // Close button
    const buttonDiv = contentEl.createDiv();
    buttonDiv.style.marginTop = "20px";
    buttonDiv.style.textAlign = "right";

    const closeBtn = buttonDiv.createEl("button", { text: "Close" });
    closeBtn.onclick = () => this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Show confirmation dialog for restore.
 */
async function showRestoreConfirm(
  app: App,
  commit: { hash: string; message: string; timestamp: number },
): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.contentEl.createEl("h2", { text: "Restore Snapshot?" });
    modal.contentEl.createEl("p", {
      text: `This will restore your vault to the snapshot from ${new Date(commit.timestamp).toLocaleString()}.`,
    });
    modal.contentEl.createEl("p", {
      text: `"${commit.message}"`,
      cls: "peervault-commit-message",
    }).style.fontStyle = "italic";
    modal.contentEl.createEl("p", {
      text: "A backup snapshot will be created automatically before restoring.",
    }).style.color = "var(--text-muted)";

    const buttonDiv = modal.contentEl.createDiv();
    buttonDiv.style.display = "flex";
    buttonDiv.style.gap = "10px";
    buttonDiv.style.marginTop = "20px";

    const cancelBtn = buttonDiv.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => {
      modal.close();
      resolve(false);
    };

    const confirmBtn = buttonDiv.createEl("button", {
      text: "Restore",
      cls: "mod-warning",
    });
    confirmBtn.onclick = () => {
      modal.close();
      resolve(true);
    };

    modal.open();
  });
}

/**
 * Show confirmation dialog for disconnecting.
 */
async function showConfirmDisconnect(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.contentEl.createEl("h2", { text: "Disconnect Cloud Sync?" });
    modal.contentEl.createEl("p", {
      text: "This will remove your cloud storage configuration. Your data in the cloud will not be deleted.",
    });

    const buttonDiv = modal.contentEl.createDiv();
    buttonDiv.style.display = "flex";
    buttonDiv.style.gap = "10px";
    buttonDiv.style.marginTop = "20px";

    const cancelBtn = buttonDiv.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => {
      modal.close();
      resolve(false);
    };

    const confirmBtn = buttonDiv.createEl("button", {
      text: "Disconnect",
      cls: "mod-warning",
    });
    confirmBtn.onclick = () => {
      modal.close();
      resolve(true);
    };

    modal.open();
  });
}

/**
 * Show confirmation dialog for importing backup.
 */
async function showConfirmImport(app: App, filename: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.contentEl.createEl("h2", { text: "Import Backup?" });
    modal.contentEl.createEl("p", {
      text: `This will import data from "${filename}" to your cloud storage.`,
    });
    modal.contentEl.createEl("p", {
      text: "Existing cloud data will be merged with the backup.",
    }).style.color = "var(--text-warning)";

    const buttonDiv = modal.contentEl.createDiv();
    buttonDiv.style.display = "flex";
    buttonDiv.style.gap = "10px";
    buttonDiv.style.marginTop = "20px";

    const cancelBtn = buttonDiv.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => {
      modal.close();
      resolve(false);
    };

    const confirmBtn = buttonDiv.createEl("button", {
      text: "Import",
      cls: "mod-warning",
    });
    confirmBtn.onclick = () => {
      modal.close();
      resolve(true);
    };

    modal.open();
  });
}

/**
 * Show confirmation dialog for downloading full state.
 */
async function showConfirmDownload(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.contentEl.createEl("h2", { text: "Download from Cloud?" });
    modal.contentEl.createEl("p", {
      text: "This will download all cloud data and apply it to your local vault.",
    });
    modal.contentEl.createEl("p", {
      text: "Your local CRDT state will be merged with the cloud data. No data will be lost.",
    }).style.color = "var(--text-muted)";

    const buttonDiv = modal.contentEl.createDiv();
    buttonDiv.style.display = "flex";
    buttonDiv.style.gap = "10px";
    buttonDiv.style.marginTop = "20px";

    const cancelBtn = buttonDiv.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => {
      modal.close();
      resolve(false);
    };

    const confirmBtn = buttonDiv.createEl("button", {
      text: "Download",
      cls: "mod-cta",
    });
    confirmBtn.onclick = () => {
      modal.close();
      resolve(true);
    };

    modal.open();
  });
}

/**
 * Derive a 32-byte key from a passphrase using PBKDF2.
 * Uses 100,000 iterations for brute-force resistance.
 *
 * Note: Salt is fixed per vault to ensure the same passphrase
 * produces the same key across devices. The security relies on
 * passphrase strength rather than salt uniqueness.
 */
async function deriveKeyFromPassphrase(passphrase: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passphraseBytes = encoder.encode(passphrase);

  // Fixed salt derived from passphrase (ensures same key across devices)
  // This is acceptable because we're not storing password hashes,
  // we're deriving an encryption key that must be identical on all devices
  const saltInput = encoder.encode("PeerVault-CloudKey-v1:" + passphrase.slice(0, 8));
  const saltHash = await crypto.subtle.digest("SHA-256", saltInput);
  const salt = new Uint8Array(saltHash).slice(0, 16);

  // Import passphrase as key material for PBKDF2
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passphraseBytes,
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  // Derive 256-bit key with 100,000 iterations
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );

  return new Uint8Array(derivedBits);
}

/**
 * Modal for setting the encryption key passphrase.
 */
class SetEncryptionKeyModal extends Modal {
  private onSave: (passphrase: string) => Promise<boolean>;
  private passphrase1 = "";
  private passphrase2 = "";

  constructor(app: App, onSave: (passphrase: string) => Promise<boolean>) {
    super(app);
    this.onSave = onSave;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("peervault-modal");

    contentEl.createEl("h2", { text: "Set Encryption Key" });

    contentEl.createEl("p", {
      text: "Enter a passphrase to encrypt your cloud data. This passphrase will be used to derive a secure encryption key.",
    });

    const warningEl = contentEl.createEl("p");
    warningEl.style.color = "var(--text-warning)";
    warningEl.style.fontSize = "12px";
    warningEl.innerHTML =
      "<strong>Important:</strong> Remember this passphrase! Without it, you cannot decrypt your cloud data. Use the same passphrase on all devices.";

    const form = contentEl.createDiv({ cls: "peervault-form" });

    // Passphrase input
    new Setting(form)
      .setName("Passphrase")
      .setDesc("At least 8 characters")
      .addText((text) => {
        text
          .setPlaceholder("Enter passphrase")
          .setValue(this.passphrase1)
          .onChange((value) => {
            this.passphrase1 = value;
          });
        text.inputEl.type = "password";
        text.inputEl.style.width = "250px";
      });

    // Confirm passphrase
    new Setting(form)
      .setName("Confirm Passphrase")
      .addText((text) => {
        text
          .setPlaceholder("Confirm passphrase")
          .setValue(this.passphrase2)
          .onChange((value) => {
            this.passphrase2 = value;
          });
        text.inputEl.type = "password";
        text.inputEl.style.width = "250px";
      });

    // Error message area
    const errorEl = form.createDiv({ cls: "peervault-error" });
    errorEl.style.color = "var(--text-error)";
    errorEl.style.marginTop = "10px";

    // Buttons
    const buttonDiv = form.createDiv({ cls: "peervault-buttons" });
    buttonDiv.style.display = "flex";
    buttonDiv.style.gap = "10px";
    buttonDiv.style.marginTop = "20px";

    const cancelBtn = buttonDiv.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    const saveBtn = buttonDiv.createEl("button", {
      text: "Set Key",
      cls: "mod-cta",
    });
    saveBtn.onclick = async () => {
      // Validate
      if (this.passphrase1.length < 8) {
        errorEl.textContent = "Passphrase must be at least 8 characters";
        return;
      }
      if (this.passphrase1 !== this.passphrase2) {
        errorEl.textContent = "Passphrases do not match";
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "Setting...";
      errorEl.textContent = "";

      const success = await this.onSave(this.passphrase1);
      if (success) {
        this.close();
      } else {
        errorEl.textContent = "Failed to set encryption key";
        saveBtn.disabled = false;
        saveBtn.textContent = "Set Key";
      }
    };
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
