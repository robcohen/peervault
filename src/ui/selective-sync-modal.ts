/**
 * Selective Sync Modal
 *
 * UI for choosing which folders to include/exclude from sync.
 */

import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import type PeerVaultPlugin from "../main";
import { isPathInExcludedFolders } from "../utils/validation";

/** Sync mode for a folder */
export type FolderSyncMode = "include" | "exclude" | "inherit";

/**
 * Modal for configuring selective sync rules.
 */
export class SelectiveSyncModal extends Modal {
  private excludedFolders: Set<string>;
  private expandedFolders = new Set<string>();

  constructor(
    app: App,
    private plugin: PeerVaultPlugin,
  ) {
    super(app);
    this.excludedFolders = new Set(this.plugin.settings.excludedFolders);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-selective-sync-modal");

    contentEl.createEl("h2", { text: "Selective Sync" });

    contentEl.createEl("p", {
      text: "Choose which folders to sync. Excluded folders will not be synced to other devices.",
      cls: "peervault-help-text",
    });

    // Quick actions
    this.renderQuickActions(contentEl);

    // Folder tree
    this.renderFolderTree(contentEl);

    // Summary
    this.renderSummary(contentEl);

    // Actions
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderQuickActions(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-quick-actions" });

    new Setting(section)
      .setName("Common exclusions")
      .setDesc("Quickly exclude commonly unwanted folders")
      .addButton((btn) =>
        btn.setButtonText("Exclude .obsidian").onClick(() => {
          this.toggleFolder(".obsidian", true);
          this.refresh();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Exclude .git").onClick(() => {
          this.toggleFolder(".git", true);
          this.refresh();
        }),
      );

    new Setting(section)
      .addButton((btn) =>
        btn.setButtonText("Include All").onClick(() => {
          this.excludedFolders.clear();
          this.refresh();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Expand All").onClick(() => {
          const folders = this.getAllFolders();
          for (const folder of folders) {
            this.expandedFolders.add(folder.path);
          }
          this.refresh();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Collapse All").onClick(() => {
          this.expandedFolders.clear();
          this.refresh();
        }),
      );
  }

  private renderFolderTree(container: HTMLElement): void {
    const section = container.createDiv({
      cls: "peervault-folder-tree-section",
    });
    section.createEl("h3", { text: "Folders" });

    const tree = section.createDiv({ cls: "peervault-folder-tree" });

    // Get root folders
    const rootFolder = this.app.vault.getRoot();
    const rootChildren =
      rootFolder.children?.filter((c): c is TFolder => c instanceof TFolder) ??
      [];

    // Sort alphabetically
    rootChildren.sort((a, b) => a.name.localeCompare(b.name));

    for (const folder of rootChildren) {
      this.renderFolderItem(tree, folder, 0);
    }

    if (rootChildren.length === 0) {
      tree.createEl("p", {
        text: "No folders in vault.",
        cls: "peervault-empty-state",
      });
    }
  }

  private renderFolderItem(
    container: HTMLElement,
    folder: TFolder,
    depth: number,
  ): void {
    const isExcluded = this.isFolderExcluded(folder.path);
    const isParentExcluded = this.isParentExcluded(folder.path);
    const hasChildren =
      folder.children?.some((c) => c instanceof TFolder) ?? false;
    const isExpanded = this.expandedFolders.has(folder.path);

    const item = container.createDiv({
      cls: `peervault-folder-item ${isExcluded ? "excluded" : ""} ${isParentExcluded ? "parent-excluded" : ""}`,
    });
    item.style.paddingLeft = `${depth * 20 + 8}px`;

    // Expand/collapse button
    if (hasChildren) {
      const expandBtn = item.createSpan({ cls: "peervault-folder-expand" });
      expandBtn.setText(isExpanded ? "v" : ">");
      expandBtn.onclick = (e) => {
        e.stopPropagation();
        if (isExpanded) {
          this.expandedFolders.delete(folder.path);
        } else {
          this.expandedFolders.add(folder.path);
        }
        this.refresh();
      };
    } else {
      item.createSpan({ cls: "peervault-folder-expand-placeholder" });
    }

    // Checkbox
    const checkbox = item.createEl("input", {
      type: "checkbox",
      cls: "peervault-folder-checkbox",
    });
    checkbox.checked = !isExcluded && !isParentExcluded;
    checkbox.disabled = isParentExcluded;
    checkbox.onclick = (e) => {
      e.stopPropagation();
      this.toggleFolder(folder.path, checkbox.checked);
      this.refresh();
    };

    // Folder name
    const nameEl = item.createSpan({ cls: "peervault-folder-name" });
    nameEl.setText(folder.name);

    // Status
    if (isExcluded) {
      item.createSpan({
        text: "(excluded)",
        cls: "peervault-folder-status excluded",
      });
    } else if (isParentExcluded) {
      item.createSpan({
        text: "(parent excluded)",
        cls: "peervault-folder-status inherited",
      });
    }

    // File count
    const fileCount = this.countFiles(folder);
    item.createSpan({
      text: `${fileCount} files`,
      cls: "peervault-folder-count",
    });

    // Render children if expanded
    if (hasChildren && isExpanded) {
      const children =
        folder.children?.filter((c): c is TFolder => c instanceof TFolder) ??
        [];
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        this.renderFolderItem(container, child, depth + 1);
      }
    }
  }

  private renderSummary(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-sync-summary" });

    const totalFiles = this.countAllFiles();
    const excludedFiles = this.countExcludedFiles();
    const syncedFiles = totalFiles - excludedFiles;

    section.createEl("div", {
      text: `Syncing ${syncedFiles} of ${totalFiles} files (${this.excludedFolders.size} folders excluded)`,
      cls: "peervault-summary-text",
    });

    // Visual bar
    const bar = section.createDiv({ cls: "peervault-sync-bar" });
    const syncedPct = totalFiles > 0 ? (syncedFiles / totalFiles) * 100 : 100;
    const syncedFill = bar.createDiv({ cls: "peervault-sync-fill synced" });
    syncedFill.style.width = `${syncedPct}%`;
  }

  private renderActions(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-actions-section" });

    new Setting(section)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            await this.save();
            this.close();
          }),
      );
  }

  private toggleFolder(path: string, include: boolean): void {
    if (include) {
      this.excludedFolders.delete(path);
    } else {
      this.excludedFolders.add(path);
    }
  }

  private isFolderExcluded(path: string): boolean {
    return this.excludedFolders.has(path);
  }

  private isParentExcluded(path: string): boolean {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join("/");
      if (this.excludedFolders.has(parentPath)) {
        return true;
      }
    }
    return false;
  }

  private getAllFolders(): TFolder[] {
    const folders: TFolder[] = [];
    const collectFolders = (folder: TFolder) => {
      folders.push(folder);
      for (const child of folder.children ?? []) {
        if (child instanceof TFolder) {
          collectFolders(child);
        }
      }
    };

    const root = this.app.vault.getRoot();
    for (const child of root.children ?? []) {
      if (child instanceof TFolder) {
        collectFolders(child);
      }
    }

    return folders;
  }

  private countFiles(folder: TFolder): number {
    let count = 0;
    for (const child of folder.children ?? []) {
      if (child instanceof TFolder) {
        count += this.countFiles(child);
      } else {
        count++;
      }
    }
    return count;
  }

  private countAllFiles(): number {
    return this.app.vault.getFiles().length;
  }

  private countExcludedFiles(): number {
    let count = 0;
    const files = this.app.vault.getFiles();

    for (const file of files) {
      if (this.isPathExcluded(file.path)) {
        count++;
      }
    }

    return count;
  }

  private isPathExcluded(path: string): boolean {
    return isPathInExcludedFolders(path, [...this.excludedFolders]);
  }

  private async save(): Promise<void> {
    this.plugin.settings.excludedFolders = Array.from(this.excludedFolders);
    await this.plugin.saveSettings();

    // Update vault sync
    if (this.plugin.vaultSync) {
      this.plugin.vaultSync.updateExcludedFolders(
        this.plugin.settings.excludedFolders,
      );
    }

    new Notice(
      `Selective sync updated: ${this.excludedFolders.size} folders excluded`,
    );
  }

  private refresh(): void {
    // Re-render in place to preserve expandedFolders state
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Selective Sync" });

    contentEl.createEl("p", {
      text: "Choose which folders to sync. Excluded folders will not be synced to other devices.",
      cls: "peervault-help-text",
    });

    this.renderQuickActions(contentEl);
    this.renderFolderTree(contentEl);
    this.renderSummary(contentEl);
    this.renderActions(contentEl);
  }
}
