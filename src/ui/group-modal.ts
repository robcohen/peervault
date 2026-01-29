/**
 * Group Modal
 *
 * UI for creating and editing peer groups.
 */

import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import type PeerVaultPlugin from "../main";
import type { PeerGroup, GroupSyncPolicy } from "../peer/groups";
import { DEFAULT_SYNC_POLICY } from "../peer/groups";
import { STATUS_ICONS } from "./status-icons";

/** Color presets for groups */
const COLOR_PRESETS = [
  "#7c7c7c", // gray (default)
  "#e03131", // red
  "#f76707", // orange
  "#fcc419", // yellow
  "#37b24d", // green
  "#1c7ed6", // blue
  "#7950f2", // purple
  "#f06595", // pink
];

/** Icon presets for groups */
const ICON_PRESETS = [
  "📱", // mobile
  "💻", // laptop
  "🖥️", // desktop
  "🏠", // home
  "🏢", // work
  "👤", // personal
  "👥", // team
  "🔒", // secure
  "📁", // folder
  "⭐", // star
];

/**
 * Modal for creating or editing a peer group.
 */
export class GroupModal extends Modal {
  private name: string;
  private icon: string;
  private color: string;
  private syncPolicy: GroupSyncPolicy;
  private excludedFolders: Set<string>;
  private expandedFolders = new Set<string>();

  constructor(
    app: App,
    private plugin: PeerVaultPlugin,
    private existingGroup?: PeerGroup,
    private onSave?: (group: PeerGroup) => void,
  ) {
    super(app);

    if (existingGroup) {
      this.name = existingGroup.name;
      this.icon = existingGroup.icon;
      this.color = existingGroup.color;
      this.syncPolicy = { ...existingGroup.syncPolicy };
      this.excludedFolders = new Set(existingGroup.syncPolicy.excludedFolders);
    } else {
      this.name = "";
      this.icon = "📁";
      this.color = "#7c7c7c";
      this.syncPolicy = { ...DEFAULT_SYNC_POLICY };
      this.excludedFolders = new Set();
    }
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-group-modal");

    const title = this.existingGroup ? "Edit Group" : "Create Group";
    contentEl.createEl("h2", { text: title });

    this.renderBasicSettings(contentEl);
    this.renderSyncPolicy(contentEl);
    this.renderFolderExclusions(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderBasicSettings(container: HTMLElement): void {
    container.createEl("h3", { text: "Group Details" });

    // Name
    new Setting(container)
      .setName("Name")
      .setDesc("Display name for this group")
      .addText((text) =>
        text
          .setPlaceholder("e.g., Work Devices")
          .setValue(this.name)
          .onChange((value) => {
            this.name = value;
          }),
      );

    // Icon picker
    const iconSetting = new Setting(container)
      .setName("Icon")
      .setDesc("Choose an icon for this group");

    const iconContainer = iconSetting.controlEl.createDiv({
      cls: "peervault-icon-picker",
    });
    for (const icon of ICON_PRESETS) {
      const iconBtn = iconContainer.createEl("button", {
        text: icon,
        cls: `peervault-icon-btn ${this.icon === icon ? "selected" : ""}`,
      });
      iconBtn.onclick = () => {
        this.icon = icon;
        iconContainer.querySelectorAll(".peervault-icon-btn").forEach((btn) => {
          btn.removeClass("selected");
        });
        iconBtn.addClass("selected");
      };
    }

    // Color picker
    const colorSetting = new Setting(container)
      .setName("Color")
      .setDesc("Choose a color for this group");

    const colorContainer = colorSetting.controlEl.createDiv({
      cls: "peervault-color-picker",
    });
    for (const color of COLOR_PRESETS) {
      const colorBtn = colorContainer.createEl("button", {
        cls: `peervault-color-btn ${this.color === color ? "selected" : ""}`,
      });
      colorBtn.style.backgroundColor = color;
      colorBtn.onclick = () => {
        this.color = color;
        colorContainer
          .querySelectorAll(".peervault-color-btn")
          .forEach((btn) => {
            btn.removeClass("selected");
          });
        colorBtn.addClass("selected");
      };
    }
  }

  private renderSyncPolicy(container: HTMLElement): void {
    container.createEl("h3", { text: "Sync Policy" });

    // Read-only
    new Setting(container)
      .setName("Read-only")
      .setDesc("Devices in this group can receive but not send changes")
      .addToggle((toggle) =>
        toggle.setValue(this.syncPolicy.readOnly).onChange((value) => {
          this.syncPolicy.readOnly = value;
        }),
      );

    // Auto-connect
    new Setting(container)
      .setName("Auto-connect")
      .setDesc("Automatically connect when devices in this group are available")
      .addToggle((toggle) =>
        toggle.setValue(this.syncPolicy.autoConnect).onChange((value) => {
          this.syncPolicy.autoConnect = value;
        }),
      );

    // Priority
    new Setting(container)
      .setName("Sync priority")
      .setDesc("Higher priority groups sync first (0-10)")
      .addSlider((slider) =>
        slider
          .setLimits(0, 10, 1)
          .setValue(this.syncPolicy.priority)
          .setDynamicTooltip()
          .onChange((value) => {
            this.syncPolicy.priority = value;
          }),
      );
  }

  private renderFolderExclusions(container: HTMLElement): void {
    container.createEl("h3", { text: "Folder Exclusions" });
    container.createEl("p", {
      text: "Select folders to exclude from sync for devices in this group.",
      cls: "peervault-help-text",
    });

    const section = container.createDiv({
      cls: "peervault-folder-tree-section",
    });
    const tree = section.createDiv({
      cls: "peervault-folder-tree peervault-group-folder-tree",
    });

    // Get root folders
    const rootFolder = this.app.vault.getRoot();
    const rootChildren =
      rootFolder.children?.filter((c): c is TFolder => c instanceof TFolder) ??
      [];
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
    const isExcluded = this.excludedFolders.has(folder.path);
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
      expandBtn.setText(isExpanded ? "▼" : "▶");
      expandBtn.onclick = (e) => {
        e.stopPropagation();
        if (isExpanded) {
          this.expandedFolders.delete(folder.path);
        } else {
          this.expandedFolders.add(folder.path);
        }
        this.refreshFolderTree();
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
      if (checkbox.checked) {
        this.excludedFolders.delete(folder.path);
      } else {
        this.excludedFolders.add(folder.path);
      }
      this.refreshFolderTree();
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

  private refreshFolderTree(): void {
    const tree = this.contentEl.querySelector(".peervault-group-folder-tree");
    if (tree) {
      tree.empty();
      const rootFolder = this.app.vault.getRoot();
      const rootChildren =
        rootFolder.children?.filter(
          (c): c is TFolder => c instanceof TFolder,
        ) ?? [];
      rootChildren.sort((a, b) => a.name.localeCompare(b.name));

      for (const folder of rootChildren) {
        this.renderFolderItem(tree as HTMLElement, folder, 0);
      }
    }
  }

  private renderActions(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-actions-section" });

    new Setting(section)
      .addButton((btn) =>
        btn.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.existingGroup ? "Save" : "Create")
          .setCta()
          .onClick(async () => {
            await this.save();
          }),
      );
  }

  private async save(): Promise<void> {
    // Validate
    if (!this.name.trim()) {
      new Notice("Please enter a group name");
      return;
    }

    const groupManager = this.plugin.peerManager?.getGroupManager();
    if (!groupManager) {
      new Notice("Group manager not available");
      return;
    }

    // Update sync policy with excluded folders
    this.syncPolicy.excludedFolders = Array.from(this.excludedFolders);

    let group: PeerGroup;

    if (this.existingGroup) {
      // Update existing
      groupManager.updateGroup(this.existingGroup.id, {
        name: this.name.trim(),
        icon: this.icon,
        color: this.color,
        syncPolicy: this.syncPolicy,
      });
      const updatedGroup = groupManager.getGroup(this.existingGroup.id);
      if (!updatedGroup) {
        new Notice("Failed to update group");
        return;
      }
      group = updatedGroup;
      new Notice(`Group "${this.name}" updated`);
    } else {
      // Create new
      group = groupManager.createGroup(this.name.trim(), this.icon, this.color);
      // Update sync policy (createGroup uses defaults)
      groupManager.updateGroup(group.id, { syncPolicy: this.syncPolicy });
      const createdGroup = groupManager.getGroup(group.id);
      if (!createdGroup) {
        new Notice("Failed to create group");
        return;
      }
      group = createdGroup;
      new Notice(`Group "${this.name}" created`);
    }

    if (this.onSave) {
      this.onSave(group);
    }

    this.close();
  }
}

/**
 * Modal for managing peers within a group.
 */
export class GroupPeersModal extends Modal {
  private group: PeerGroup;

  constructor(
    app: App,
    private plugin: PeerVaultPlugin,
    group: PeerGroup,
  ) {
    super(app);
    this.group = group;
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("peervault-group-peers-modal");

    contentEl.createEl("h2", {
      text: `${this.group.icon} ${this.group.name} - Devices`,
    });

    this.renderPeersInGroup(contentEl);
    this.renderAvailablePeers(contentEl);
    this.renderActions(contentEl);
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderPeersInGroup(container: HTMLElement): void {
    container.createEl("h3", { text: "Devices in Group" });

    const allPeers = this.plugin.peerManager?.getPeers() ?? [];
    const peersInGroup = allPeers.filter((p) =>
      this.group.peerIds.includes(p.nodeId),
    );

    if (peersInGroup.length === 0) {
      container.createEl("p", {
        text: "No devices in this group yet.",
        cls: "peervault-empty-state",
      });
      return;
    }

    for (const peer of peersInGroup) {
      const stateIcon = this.getStateIcon(peer.state);
      const displayName = peer.nickname ?? peer.hostname ?? "Unknown Device";
      new Setting(container)
        .setName(`${stateIcon} ${displayName}`)
        .setDesc(`${peer.nodeId.substring(0, 8)}...`)
        .addButton((btn) =>
          btn.setButtonText("Remove").onClick(() => {
            this.removePeerFromGroup(peer.nodeId);
          }),
        );
    }
  }

  private renderAvailablePeers(container: HTMLElement): void {
    container.createEl("h3", { text: "Add Devices" });

    const allPeers = this.plugin.peerManager?.getPeers() ?? [];
    const availablePeers = allPeers.filter(
      (p) => !this.group.peerIds.includes(p.nodeId),
    );

    if (availablePeers.length === 0) {
      container.createEl("p", {
        text: "All devices are already in this group.",
        cls: "peervault-empty-state",
      });
      return;
    }

    for (const peer of availablePeers) {
      const stateIcon = this.getStateIcon(peer.state);
      const displayName = peer.nickname ?? peer.hostname ?? "Unknown Device";
      new Setting(container)
        .setName(`${stateIcon} ${displayName}`)
        .setDesc(`${peer.nodeId.substring(0, 8)}...`)
        .addButton((btn) =>
          btn
            .setButtonText("Add")
            .setCta()
            .onClick(() => {
              this.addPeerToGroup(peer.nodeId);
            }),
        );
    }
  }

  private renderActions(container: HTMLElement): void {
    const section = container.createDiv({ cls: "peervault-actions-section" });

    new Setting(section).addButton((btn) =>
      btn
        .setButtonText("Done")
        .setCta()
        .onClick(() => this.close()),
    );
  }

  private addPeerToGroup(peerId: string): void {
    const groupManager = this.plugin.peerManager?.getGroupManager();
    if (!groupManager) return;

    groupManager.addPeerToGroup(this.group.id, peerId);
    const updatedGroup = groupManager.getGroup(this.group.id);
    if (updatedGroup) {
      this.group = updatedGroup;
    }
    this.refresh();
    new Notice("Device added to group");
  }

  private removePeerFromGroup(peerId: string): void {
    const groupManager = this.plugin.peerManager?.getGroupManager();
    if (!groupManager) return;

    groupManager.removePeerFromGroup(this.group.id, peerId);
    const updatedGroup = groupManager.getGroup(this.group.id);
    if (updatedGroup) {
      this.group = updatedGroup;
    }
    this.refresh();
    new Notice("Device removed from group");
  }

  private refresh(): void {
    this.contentEl.empty();
    this.onOpen();
  }

  private getStateIcon(state: string): string {
    switch (state) {
      case "connected":
      case "synced":
        return STATUS_ICONS.connected;
      case "syncing":
      case "connecting":
        return STATUS_ICONS.syncing;
      case "error":
        return STATUS_ICONS.error;
      case "disconnected":
        return STATUS_ICONS.offline;
      default:
        return STATUS_ICONS.idle;
    }
  }
}
