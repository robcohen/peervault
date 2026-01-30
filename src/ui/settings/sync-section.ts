/**
 * Sync Section
 *
 * Sync settings: auto-sync, interval, selective sync, file history.
 */

import { Setting, Notice } from "obsidian";
import type { SectionContext } from "./types";
import { SelectiveSyncModal } from "../selective-sync-modal";
import { FileHistoryModal } from "../file-history-modal";
import { formatUserError } from "../../utils/validation";
import { UI_LIMITS } from "../../types";

export function renderSyncSection(
  container: HTMLElement,
  ctx: SectionContext,
): void {
  const { plugin, app, refresh, expandedSections } = ctx;
  const isExpanded = expandedSections.has("sync");

  new Setting(container)
    .setName("Sync Settings")
    .setHeading()
    .addExtraButton((btn) =>
      btn
        .setIcon(isExpanded ? "chevron-up" : "chevron-down")
        .setTooltip(isExpanded ? "Collapse" : "Expand")
        .onClick(() => {
          if (isExpanded) expandedSections.delete("sync");
          else expandedSections.add("sync");
          refresh();
        }),
    );

  if (!isExpanded) return;

  new Setting(container)
    .setName("Sync now")
    .setDesc("Manually trigger a sync with all connected devices")
    .addButton((btn) =>
      btn
        .setButtonText("Sync Now")
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Syncing...");
          try {
            await plugin.sync();
            new Notice("Sync completed");
          } catch (error) {
            new Notice(`Sync failed: ${formatUserError(error)}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText("Sync Now");
          }
        }),
    );

  new Setting(container)
    .setName("Auto-sync")
    .setDesc("Automatically sync changes with connected devices")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.autoSync)
        .onChange(async (value) => {
          plugin.settings.autoSync = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(container)
    .setName("Sync interval")
    .setDesc("How often to sync (seconds, 0 = real-time)")
    .addSlider((slider) =>
      slider
        .setLimits(0, 300, 10)
        .setValue(plugin.settings.syncInterval)
        .setDynamicTooltip()
        .onChange(async (value) => {
          plugin.settings.syncInterval = value;
          await plugin.saveSettings();
        }),
    );

  new Setting(container)
    .setName("Selective sync")
    .setDesc("Choose which folders to sync")
    .addButton((btn) =>
      btn.setButtonText("Configure").onClick(() => {
        new SelectiveSyncModal(app, plugin).open();
      }),
    );

  // Show current exclusions summary
  const excluded = plugin.settings.excludedFolders;
  if (excluded.length > 0) {
    const limit = UI_LIMITS.maxInlineExcludedFolders;
    const summary =
      excluded.slice(0, limit).join(", ") +
      (excluded.length > limit ? ` +${excluded.length - limit} more` : "");
    new Setting(container)
      .setName("Excluded folders")
      .setDesc(summary)
      .addExtraButton((btn) =>
        btn
          .setIcon("pencil")
          .setTooltip("Edit")
          .onClick(() => {
            new SelectiveSyncModal(app, plugin).open();
          }),
      );
  }

  new Setting(container)
    .setName("File history")
    .setDesc("View and restore previous versions of files")
    .addButton((btn) =>
      btn.setButtonText("Open").onClick(() => {
        new FileHistoryModal(app, plugin).open();
      }),
    );
}
