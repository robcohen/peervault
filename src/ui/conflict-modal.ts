/**
 * Conflict Modal
 *
 * Shows files with concurrent edits from multiple peers.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type PeerVaultPlugin from "../main";
import {
  getConflictTracker,
  type ConflictInfo,
} from "../core/conflict-tracker";

/**
 * Modal showing files with concurrent edit conflicts.
 */
export class ConflictModal extends Modal {
  constructor(
    app: App,
    private plugin: PeerVaultPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-conflict-modal");

    contentEl.createEl("h2", { text: "Concurrent Edits" });

    contentEl.createEl("p", {
      text: "These files were edited by multiple devices at the same time. The changes were automatically merged, but you may want to review the results.",
      cls: "peervault-help-text",
    });

    const tracker = getConflictTracker();
    const conflicts = tracker.getConflicts();

    if (conflicts.length === 0) {
      this.renderEmpty(contentEl);
    } else {
      this.renderConflicts(contentEl, conflicts);
    }

    // Actions
    this.renderActions(contentEl, conflicts);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderEmpty(container: HTMLElement): void {
    container.createEl("p", {
      text: "No concurrent edits detected. All synced changes were sequential.",
      cls: "peervault-empty-state",
    });
  }

  private renderConflicts(
    container: HTMLElement,
    conflicts: ConflictInfo[],
  ): void {
    const list = container.createDiv({ cls: "peervault-conflict-list" });

    for (const conflict of conflicts) {
      this.renderConflictItem(list, conflict);
    }
  }

  private renderConflictItem(
    container: HTMLElement,
    conflict: ConflictInfo,
  ): void {
    const item = container.createDiv({ cls: "peervault-conflict-item" });

    // File path (clickable)
    const pathEl = item.createDiv({ cls: "peervault-conflict-path" });
    const link = pathEl.createEl("a", { text: conflict.path });
    link.onclick = async (e) => {
      e.preventDefault();
      try {
        await this.app.workspace.openLinkText(conflict.path, "");
        this.close();
      } catch (error) {
        new Notice(`Could not open file: ${error}`);
      }
    };

    // Details
    const details = item.createDiv({ cls: "peervault-conflict-details" });
    const timeAgo = this.formatTimeAgo(conflict.timestamp);
    details.setText(`Detected ${timeAgo}`);

    // Peers involved
    const peers = item.createDiv({ cls: "peervault-conflict-peers" });
    peers.createSpan({ text: "Edited by: " });
    for (const name of conflict.peerNames) {
      peers.createSpan({ text: name, cls: "peervault-conflict-peer" });
    }

    // Actions
    const actions = item.createDiv({ cls: "peervault-conflict-actions" });

    const openBtn = actions.createEl("button", { text: "Open File" });
    openBtn.onclick = async () => {
      try {
        await this.app.workspace.openLinkText(conflict.path, "");
        this.close();
      } catch (error) {
        new Notice(`Could not open file: ${error}`);
      }
    };

    const resolveBtn = actions.createEl("button", { text: "Mark Resolved" });
    resolveBtn.onclick = () => {
      const tracker = getConflictTracker();
      tracker.resolveConflict(conflict.path);
      new Notice(`Marked "${conflict.path}" as resolved`);
      this.refresh();
    };
  }

  private refresh(): void {
    // Re-render in place
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Concurrent Edits" });

    contentEl.createEl("p", {
      text: "These files were edited by multiple devices at the same time. The changes were automatically merged, but you may want to review the results.",
      cls: "peervault-help-text",
    });

    const tracker = getConflictTracker();
    const conflicts = tracker.getConflicts();

    if (conflicts.length === 0) {
      this.renderEmpty(contentEl);
    } else {
      this.renderConflicts(contentEl, conflicts);
    }

    this.renderActions(contentEl, conflicts);
  }

  private renderActions(
    container: HTMLElement,
    conflicts: ConflictInfo[],
  ): void {
    const actions = container.createDiv({ cls: "peervault-actions-section" });

    if (conflicts.length > 0) {
      new Setting(actions)
        .addButton((btn) =>
          btn.setButtonText("Resolve All").onClick(() => {
            const tracker = getConflictTracker();
            for (const conflict of conflicts) {
              tracker.resolveConflict(conflict.path);
            }
            new Notice(`Resolved ${conflicts.length} conflict(s)`);
            this.close();
          }),
        )
        .addButton((btn) =>
          btn.setButtonText("Close").onClick(() => this.close()),
        );
    } else {
      new Setting(actions).addButton((btn) =>
        btn.setButtonText("Close").onClick(() => this.close()),
      );
    }
  }

  private formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
