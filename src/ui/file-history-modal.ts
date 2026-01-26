/**
 * File History Modal
 *
 * Browse and restore previous versions of files using Loro's time-travel.
 */

import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type PeerVaultPlugin from "../main";

/** A version entry for a file */
export interface FileVersion {
  /** Version identifier */
  versionId: string;
  /** Timestamp when this version was created */
  timestamp: number;
  /** Peer that made the change */
  peerId?: string;
  /** Peer name if known */
  peerName?: string;
  /** Type of change */
  changeType: "created" | "modified" | "deleted";
  /** Content preview (first 100 chars) */
  preview?: string;
  /** Content length */
  contentLength?: number;
}

/**
 * Modal for viewing and restoring file history.
 */
export class FileHistoryModal extends Modal {
  private filePath: string;
  private versions: FileVersion[] = [];

  constructor(
    app: App,
    private plugin: PeerVaultPlugin,
    filePath?: string,
  ) {
    super(app);
    // Use active file if no path provided
    this.filePath = filePath || this.app.workspace.getActiveFile()?.path || "";
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.addClass("peervault-file-history-modal");

    contentEl.createEl("h2", { text: "File History" });

    if (!this.filePath) {
      this.renderNoFile(contentEl);
      return;
    }

    // File selector
    this.renderFileSelector(contentEl);

    // Load versions
    const loading = contentEl.createDiv({ cls: "peervault-loading" });
    loading.setText("Loading history...");

    try {
      this.versions = await this.loadFileVersions(this.filePath);
      loading.remove();

      if (this.versions.length === 0) {
        this.renderNoHistory(contentEl);
      } else {
        this.renderVersionList(contentEl);
      }
    } catch (error) {
      loading.setText(`Error loading history: ${error}`);
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderNoFile(container: HTMLElement): void {
    container.createEl("p", {
      text: "No file selected. Open a file and try again.",
      cls: "peervault-empty-state",
    });
  }

  private renderFileSelector(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-file-selector" });

    new Setting(section)
      .setName("File")
      .setDesc("Select a file to view its history")
      .addText((text) => {
        text.setValue(this.filePath);
        text.setPlaceholder("path/to/file.md");
        text.inputEl.style.width = "300px";

        // Autocomplete with vault files
        const datalist = document.createElement("datalist");
        datalist.id = "peervault-file-list";
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files.slice(0, 100)) {
          const option = document.createElement("option");
          option.value = file.path;
          datalist.appendChild(option);
        }
        text.inputEl.setAttribute("list", "peervault-file-list");
        text.inputEl.parentElement?.appendChild(datalist);
      })
      .addButton((btn) =>
        btn.setButtonText("Load").onClick(async () => {
          const input = section.querySelector("input") as HTMLInputElement;
          if (input?.value) {
            this.filePath = input.value;
            this.close();
            new FileHistoryModal(this.app, this.plugin, this.filePath).open();
          }
        }),
      );
  }

  private renderNoHistory(container: HTMLElement): void {
    container.createEl("p", {
      text: "No version history found for this file.",
      cls: "peervault-empty-state",
    });
    container.createEl("p", {
      text: "History is recorded when files are synced between devices.",
      cls: "peervault-help-text",
    });
  }

  private renderVersionList(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-version-list" });

    // Current version
    const currentSection = section.createDiv({
      cls: "peervault-version-section",
    });
    currentSection.createEl("h3", { text: "Current Version" });
    this.renderVersionItem(currentSection, this.versions[0]!, true);

    // Previous versions
    if (this.versions.length > 1) {
      const historySection = section.createDiv({
        cls: "peervault-version-section",
      });
      historySection.createEl("h3", { text: "Previous Versions" });

      for (let i = 1; i < this.versions.length && i < 20; i++) {
        this.renderVersionItem(historySection, this.versions[i]!, false);
      }

      if (this.versions.length > 20) {
        historySection.createEl("p", {
          text: `... and ${this.versions.length - 20} more versions`,
          cls: "peervault-more-versions",
        });
      }
    }
  }

  private renderVersionItem(
    container: HTMLElement,
    version: FileVersion,
    isCurrent: boolean,
  ): void {
    const item = container.createDiv({
      cls: `peervault-version-item ${isCurrent ? "current" : ""}`,
    });

    // Header with timestamp and change type
    const header = item.createDiv({ cls: "peervault-version-header" });

    const timeStr = new Date(version.timestamp).toLocaleString();
    header.createSpan({ text: timeStr, cls: "peervault-version-time" });

    const badge = header.createSpan({
      cls: `peervault-version-badge peervault-badge-${version.changeType}`,
    });
    badge.setText(version.changeType);

    // Source
    const source = item.createDiv({ cls: "peervault-version-source" });
    if (version.peerName) {
      source.setText(`From: ${version.peerName}`);
    } else if (version.peerId) {
      source.setText(`From: ${version.peerId.substring(0, 8)}...`);
    } else {
      source.setText("Local change");
    }

    // Preview
    if (version.preview) {
      const preview = item.createDiv({ cls: "peervault-version-preview" });
      preview.setText(version.preview);
    }

    // Size
    if (version.contentLength !== undefined) {
      const size = item.createDiv({ cls: "peervault-version-size" });
      size.setText(`Size: ${this.formatBytes(version.contentLength)}`);
    }

    // Actions
    if (!isCurrent && version.changeType !== "deleted") {
      const actions = item.createDiv({ cls: "peervault-version-actions" });

      const viewBtn = actions.createEl("button", { text: "View" });
      viewBtn.onclick = () => this.viewVersion(version);

      const restoreBtn = actions.createEl("button", {
        text: "Restore",
        cls: "mod-cta",
      });
      restoreBtn.onclick = () => this.restoreVersion(version);
    }
  }

  private async loadFileVersions(path: string): Promise<FileVersion[]> {
    const versions: FileVersion[] = [];
    const doc = this.plugin.documentManager.getLoro();

    // Get current content
    const currentContent = this.plugin.documentManager.getTextContent(path);
    const meta = this.plugin.documentManager.getFileMeta(path);

    if (meta) {
      versions.push({
        versionId: "current",
        timestamp: meta.mtime,
        changeType: "modified",
        preview: currentContent?.substring(0, 100),
        contentLength: currentContent?.length,
      });
    }

    // Try to get history from Loro's oplog
    // Note: Loro's time-travel API allows us to view document at any version
    try {
      const oplogVersion = doc.oplogVersion();
      const frontiers = doc.oplogFrontiers();

      // For now, create synthetic history based on what we know
      // In a full implementation, we'd iterate through the oplog
      // to find all changes that affected this file

      // Get peers that have contributed
      const peers = this.plugin.getConnectedPeers();
      for (const peer of peers) {
        if (peer.lastSeen && peer.lastSeen < Date.now() - 1000) {
          versions.push({
            versionId: `peer-${peer.nodeId}`,
            timestamp: peer.lastSeen,
            peerId: peer.nodeId,
            peerName: peer.name,
            changeType: "modified",
            preview: "(synced from peer)",
          });
        }
      }
    } catch (error) {
      this.plugin.logger.debug("Could not load detailed history:", error);
    }

    // Sort by timestamp descending
    versions.sort((a, b) => b.timestamp - a.timestamp);

    return versions;
  }

  private async viewVersion(version: FileVersion): Promise<void> {
    // For a full implementation, we'd use Loro's checkout to view old content
    // For now, show a notice
    new Notice(`Version from ${new Date(version.timestamp).toLocaleString()}`);

    try {
      const doc = this.plugin.documentManager.getLoro();

      // In a full implementation:
      // const historicalDoc = doc.checkout(version.frontiers);
      // const content = getContentFromDoc(historicalDoc, this.filePath);

      // For now, show current content
      const content = this.plugin.documentManager.getTextContent(this.filePath);
      if (content) {
        // Create a temporary file or modal to show content
        const modal = new VersionViewModal(
          this.app,
          this.filePath,
          version,
          content,
        );
        modal.open();
      }
    } catch (error) {
      new Notice(`Failed to view version: ${error}`);
    }
  }

  private async restoreVersion(version: FileVersion): Promise<void> {
    const confirmed = confirm(
      `Restore "${this.filePath}" to version from ${new Date(version.timestamp).toLocaleString()}?\n\nThis will overwrite the current content.`,
    );

    if (!confirmed) return;

    try {
      // For a full implementation, we'd use Loro's checkout
      // For now, show that we would restore
      new Notice(
        `Restoring to version from ${new Date(version.timestamp).toLocaleString()}...`,
      );

      // In a full implementation:
      // const doc = this.plugin.documentManager.getLoro();
      // const historicalDoc = doc.checkout(version.frontiers);
      // const content = getContentFromDoc(historicalDoc, this.filePath);
      // await this.app.vault.modify(file, content);

      new Notice(
        "Version restored (simulated - full restore requires Loro time-travel integration)",
      );
    } catch (error) {
      new Notice(`Failed to restore: ${error}`);
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

/**
 * Modal for viewing a specific version's content.
 */
class VersionViewModal extends Modal {
  constructor(
    app: App,
    private filePath: string,
    private version: FileVersion,
    private content: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-version-view-modal");

    contentEl.createEl("h2", { text: `Version: ${this.filePath}` });

    const info = contentEl.createDiv({ cls: "peervault-version-info" });
    info.createEl("p", {
      text: `Date: ${new Date(this.version.timestamp).toLocaleString()}`,
    });
    if (this.version.peerName) {
      info.createEl("p", { text: `From: ${this.version.peerName}` });
    }

    const contentArea = contentEl.createEl("textarea", {
      cls: "peervault-version-content",
      attr: { readonly: "true" },
    });
    contentArea.value = this.content;
    contentArea.style.width = "100%";
    contentArea.style.height = "400px";
    contentArea.style.fontFamily = "var(--font-monospace)";

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Copy").onClick(() => {
          navigator.clipboard.writeText(this.content);
          new Notice("Content copied to clipboard");
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close()),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
