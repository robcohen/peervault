/**
 * File History Modal
 *
 * Browse and restore previous versions of files using Loro's time-travel.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type PeerVaultPlugin from "../main";
import type { HistoricalVersion } from "../core/document-manager";
import type { OpId } from "loro-crdt";

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
  /** Frontiers for checkout (if available) */
  frontiers?: OpId[];
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      loading.setText(`Error loading history: ${errorMsg}`);
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
      text: "History is recorded when changes are made to the document.",
      cls: "peervault-help-text",
    });
  }

  private renderVersionList(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-version-list" });

    // Current version
    const currentVersion = this.versions[0];
    if (!currentVersion) {
      return; // Safety check - should not happen since we check length before calling
    }

    const currentSection = section.createDiv({
      cls: "peervault-version-section",
    });
    currentSection.createEl("h3", { text: "Current Version" });
    this.renderVersionItem(currentSection, currentVersion, true);

    // Previous versions
    if (this.versions.length > 1) {
      const historySection = section.createDiv({
        cls: "peervault-version-section",
      });
      historySection.createEl("h3", { text: "Previous Versions" });

      for (let i = 1; i < this.versions.length && i < 20; i++) {
        const version = this.versions[i];
        if (version) {
          this.renderVersionItem(historySection, version, false);
        }
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

    // Loro timestamps are in seconds, convert to milliseconds for Date
    const timestampMs = version.timestamp < 1e12 ? version.timestamp * 1000 : version.timestamp;
    const timeStr = new Date(timestampMs).toLocaleString();
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

    // Actions for non-current versions with frontiers
    if (!isCurrent && version.changeType !== "deleted" && version.frontiers) {
      const actions = item.createDiv({ cls: "peervault-version-actions" });

      const viewBtn = actions.createEl("button", { text: "View" });
      viewBtn.onclick = () => this.viewVersion(version);

      const restoreBtn = actions.createEl("button", { text: "Restore" });
      restoreBtn.onclick = () => this.restoreVersion(version);
    }
  }

  private async viewVersion(version: FileVersion): Promise<void> {
    if (!version.frontiers || !this.plugin.documentManager) {
      new Notice("Cannot view this version");
      return;
    }

    try {
      // Checkout to the historical version
      const historicalDoc = this.plugin.documentManager.checkoutToFrontiers(version.frontiers);

      // Get the content at that version
      const content = this.plugin.documentManager.getTextContentFromDoc(historicalDoc, this.filePath);

      if (content === undefined) {
        new Notice("File not found at this version");
        return;
      }

      // Show content in a new modal
      new VersionViewModal(this.app, this.filePath, version, content).open();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to view version: ${errorMsg}`);
    }
  }

  private async restoreVersion(version: FileVersion): Promise<void> {
    if (!version.frontiers || !this.plugin.documentManager) {
      new Notice("Cannot restore this version");
      return;
    }

    try {
      // Checkout to the historical version
      const historicalDoc = this.plugin.documentManager.checkoutToFrontiers(version.frontiers);

      // Get the content at that version
      const content = this.plugin.documentManager.getTextContentFromDoc(historicalDoc, this.filePath);

      if (content === undefined) {
        new Notice("File not found at this version");
        return;
      }

      // Write the content back to the current document
      await this.plugin.documentManager.setTextContent(this.filePath, content);

      // Also update the Obsidian vault file
      const file = this.app.vault.getAbstractFileByPath(this.filePath);
      if (file && "path" in file) {
        await this.app.vault.modify(file as import("obsidian").TFile, content);
      }

      new Notice(`Restored "${this.filePath}" to previous version`);
      this.close();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to restore version: ${errorMsg}`);
    }
  }

  private async loadFileVersions(path: string): Promise<FileVersion[]> {
    const versions: FileVersion[] = [];
    const documentManager = this.plugin.documentManager;

    if (!documentManager) {
      return versions;
    }

    // Get current content
    const currentContent = documentManager.getTextContent(path);
    const meta = documentManager.getFileMeta(path);

    if (meta) {
      versions.push({
        versionId: "current",
        timestamp: meta.mtime,
        changeType: "modified",
        preview: currentContent?.substring(0, 100),
        contentLength: currentContent?.length,
      });
    }

    // Get version history from Loro
    // Note: This samples historical versions to avoid performance issues
    try {
      const history = documentManager.getVersionHistory();
      const myNodeId = this.plugin.getNodeId();

      // Only check a limited number of versions (most recent ones)
      // to avoid performance problems with large histories
      const MAX_VERSIONS_TO_CHECK = 50;
      const versionsToCheck = history.slice(0, MAX_VERSIONS_TO_CHECK);

      // Track content hashes to detect actual changes
      const seenContentHashes = new Set<string>();
      if (currentContent) {
        seenContentHashes.add(this.hashContent(currentContent));
      }

      for (const histVersion of versionsToCheck) {
        // Skip very recent versions (likely same as current)
        if (meta && Math.abs(histVersion.timestamp * 1000 - meta.mtime) < 2000) {
          continue;
        }

        try {
          const historicalDoc = documentManager.checkoutToFrontiers(histVersion.frontiers);
          const historicalContent = documentManager.getTextContentFromDoc(historicalDoc, path);

          // Only include if file exists and content is different from what we've seen
          if (historicalContent !== undefined) {
            const contentHash = this.hashContent(historicalContent);

            // Skip if we've already seen this exact content
            if (seenContentHashes.has(contentHash)) {
              continue;
            }
            seenContentHashes.add(contentHash);

            const peerName = histVersion.peerId === myNodeId
              ? "This device"
              : this.getPeerName(histVersion.peerId);

            versions.push({
              versionId: `${histVersion.peerId}-${histVersion.lamport}`,
              timestamp: histVersion.timestamp,
              peerId: histVersion.peerId,
              peerName: peerName,
              changeType: "modified",
              preview: historicalContent.substring(0, 100),
              contentLength: historicalContent.length,
              frontiers: histVersion.frontiers,
            });

            // Limit total versions shown
            if (versions.length >= 20) {
              break;
            }
          }
        } catch {
          // Skip versions that can't be checked out
        }
      }
    } catch (error) {
      this.plugin.logger.debug("Could not load Loro history:", error);
    }

    // Sort by timestamp descending (newest first)
    versions.sort((a, b) => {
      const aTime = a.timestamp < 1e12 ? a.timestamp * 1000 : a.timestamp;
      const bTime = b.timestamp < 1e12 ? b.timestamp * 1000 : b.timestamp;
      return bTime - aTime;
    });

    return versions;
  }

  /**
   * Create a simple hash of content for deduplication.
   * Uses length + sample of content to quickly identify duplicates.
   */
  private hashContent(content: string): string {
    const len = content.length;
    // Sample characters at various positions for a quick fingerprint
    const sample = [
      content.charAt(0),
      content.charAt(Math.floor(len / 4)),
      content.charAt(Math.floor(len / 2)),
      content.charAt(Math.floor(len * 3 / 4)),
      content.charAt(len - 1),
    ].join('');
    return `${len}:${sample}`;
  }

  private getPeerName(peerId: string): string | undefined {
    try {
      const peers = this.plugin.getConnectedPeers();
      const peer = peers.find((p) => p.nodeId === peerId);
      return peer?.nickname ?? peer?.hostname;
    } catch {
      return undefined;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

/**
 * Modal for viewing a historical version's content.
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

    // Header
    const timestampMs = this.version.timestamp < 1e12
      ? this.version.timestamp * 1000
      : this.version.timestamp;
    contentEl.createEl("h2", {
      text: `${this.filePath} @ ${new Date(timestampMs).toLocaleString()}`
    });

    // Source info
    const source = contentEl.createDiv({ cls: "peervault-version-source" });
    if (this.version.peerName) {
      source.setText(`From: ${this.version.peerName}`);
    } else if (this.version.peerId) {
      source.setText(`From: ${this.version.peerId.substring(0, 8)}...`);
    }

    // Content
    const contentArea = contentEl.createEl("textarea", {
      cls: "peervault-version-content",
      attr: { readonly: "true", rows: "20" },
    });
    contentArea.value = this.content;
    contentArea.style.width = "100%";
    contentArea.style.fontFamily = "var(--font-monospace)";

    // Actions
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
