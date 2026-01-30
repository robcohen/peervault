/**
 * Merge Notification UI
 *
 * Shows users when changes from peers were merged into their vault.
 * CRDTs automatically merge changes, so this is informational rather than
 * requiring user intervention.
 */

import { App, Modal, Notice } from "obsidian";
import { STATUS_ICONS } from "./status-icons";
import { UI_LIMITS } from "../types";

/** Information about a merge event */
export interface MergeInfo {
  /** File paths that were changed */
  changedFiles: string[];
  /** Peer name who sent the changes */
  peerName: string;
  /** Peer node ID */
  peerId: string;
  /** When the merge occurred */
  timestamp: number;
  /** Number of files created */
  filesCreated: number;
  /** Number of files updated */
  filesUpdated: number;
  /** Number of files deleted */
  filesDeleted: number;
}

/** Recent merge history */
const recentMerges: MergeInfo[] = [];
const MAX_RECENT_MERGES = 20;

/**
 * Record a merge event and optionally show a notification.
 */
export function recordMerge(
  info: MergeInfo,
  app?: App,
  showNotice = true,
): void {
  recentMerges.unshift(info);

  // Trim old entries
  while (recentMerges.length > MAX_RECENT_MERGES) {
    recentMerges.pop();
  }

  if (showNotice && info.changedFiles.length > 0) {
    showMergeNotice(info, app);
  }
}

/**
 * Get recent merge history.
 */
export function getRecentMerges(): MergeInfo[] {
  return [...recentMerges];
}

/**
 * Clear merge history.
 */
export function clearMergeHistory(): void {
  recentMerges.length = 0;
}

/**
 * Show a notice about merged changes.
 */
function showMergeNotice(info: MergeInfo, app?: App): void {
  const totalChanges =
    info.filesCreated + info.filesUpdated + info.filesDeleted;

  if (totalChanges === 0) return;

  const parts: string[] = [];
  if (info.filesCreated > 0) parts.push(`${info.filesCreated} new`);
  if (info.filesUpdated > 0) parts.push(`${info.filesUpdated} updated`);
  if (info.filesDeleted > 0) parts.push(`${info.filesDeleted} deleted`);

  const message = `Synced from ${info.peerName || "peer"}: ${parts.join(", ")}`;

  // Create clickable notice
  const notice = new Notice(message, 8000);
  if (app) {
    notice.noticeEl.style.cursor = "pointer";
    notice.noticeEl.title = "Click to see details";
    notice.noticeEl.onclick = () => {
      notice.hide();
      new MergeDetailModal(app, info).open();
    };
  }
}

/**
 * Modal showing merge details.
 */
export class MergeDetailModal extends Modal {
  constructor(
    app: App,
    private info: MergeInfo,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-merge-modal");

    // Header
    contentEl.createEl("h2", { text: "Synced Changes" });

    // Peer info
    const peerInfo = contentEl.createDiv({ cls: "merge-peer-info" });
    peerInfo.createEl("strong", {
      text: `From: ${this.info.peerName || "Unknown Device"}`,
    });
    peerInfo.createEl("div", {
      text: new Date(this.info.timestamp).toLocaleString(),
      cls: "merge-timestamp",
    });

    // Summary
    const summary = contentEl.createDiv({ cls: "merge-summary" });

    if (this.info.filesCreated > 0) {
      summary.createEl("div", {
        text: `${this.info.filesCreated} file(s) created`,
        cls: "merge-stat created",
      });
    }
    if (this.info.filesUpdated > 0) {
      summary.createEl("div", {
        text: `${this.info.filesUpdated} file(s) updated`,
        cls: "merge-stat updated",
      });
    }
    if (this.info.filesDeleted > 0) {
      summary.createEl("div", {
        text: `${this.info.filesDeleted} file(s) deleted`,
        cls: "merge-stat deleted",
      });
    }

    // File list
    if (this.info.changedFiles.length > 0) {
      contentEl.createEl("h3", { text: "Changed Files" });
      const fileList = contentEl.createEl("ul", { cls: "merge-file-list" });

      const filesToShow = this.info.changedFiles.slice(0, UI_LIMITS.maxMergeFilesDisplay);
      for (const path of filesToShow) {
        const li = fileList.createEl("li");
        li.createEl("a", {
          text: path,
          cls: "merge-file-link",
        }).onclick = async (e) => {
          e.preventDefault();
          try {
            await this.app.workspace.openLinkText(path, "");
            this.close();
          } catch (error) {
            new Notice(`Could not open file: ${error}`);
          }
        };
      }

      if (this.info.changedFiles.length > 20) {
        fileList.createEl("li", {
          text: `... and ${this.info.changedFiles.length - 20} more`,
          cls: "merge-more-files",
        });
      }
    }

    // Actions
    const actions = contentEl.createDiv({ cls: "merge-actions" });
    actions.createEl("button", { text: "Close" }).onclick = () => this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Modal showing recent merge history.
 */
export class MergeHistoryModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-merge-history-modal");

    contentEl.createEl("h2", { text: "Recent Sync History" });

    const merges = getRecentMerges();

    if (merges.length === 0) {
      contentEl.createEl("p", { text: "No recent syncs.", cls: "merge-empty" });
    } else {
      const list = contentEl.createDiv({ cls: "merge-history-list" });

      for (const merge of merges) {
        const item = list.createDiv({ cls: "merge-history-item" });

        const header = item.createDiv({ cls: "merge-history-header" });
        header.createEl("strong", { text: merge.peerName || "Unknown Device" });
        header.createEl("span", {
          text: new Date(merge.timestamp).toLocaleString(),
          cls: "merge-history-time",
        });

        const stats = item.createDiv({ cls: "merge-history-stats" });
        const parts: string[] = [];
        if (merge.filesCreated > 0) parts.push(`${merge.filesCreated} new`);
        if (merge.filesUpdated > 0) parts.push(`${merge.filesUpdated} updated`);
        if (merge.filesDeleted > 0) parts.push(`${merge.filesDeleted} deleted`);
        stats.createEl("span", { text: parts.join(", ") || "No changes" });

        // Click to see details
        item.onclick = () => {
          this.close();
          new MergeDetailModal(this.app, merge).open();
        };
        item.style.cursor = "pointer";
      }
    }

    // Actions
    const actions = contentEl.createDiv({ cls: "merge-actions" });

    if (merges.length > 0) {
      actions.createEl("button", { text: "Clear History" }).onclick = () => {
        clearMergeHistory();
        this.close();
      };
    }

    actions.createEl("button", { text: "Close" }).onclick = () => this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
