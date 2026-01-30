/**
 * Storage Section
 *
 * Garbage collection and storage maintenance settings.
 */

import { Setting, Notice } from "obsidian";
import type { SectionContext } from "./types";

export function renderStorageSection(
  container: HTMLElement,
  ctx: SectionContext,
): void {
  const { plugin, refresh, expandedSections } = ctx;
  const isExpanded = expandedSections.has("storage");

  new Setting(container)
    .setName("Storage & Maintenance")
    .setHeading()
    .addExtraButton((btn) =>
      btn
        .setIcon(isExpanded ? "chevron-up" : "chevron-down")
        .setTooltip(isExpanded ? "Collapse" : "Expand")
        .onClick(() => {
          if (isExpanded) expandedSections.delete("storage");
          else expandedSections.add("storage");
          refresh();
        }),
    );

  if (!isExpanded) return;

  // GC enabled toggle
  new Setting(container)
    .setName("Garbage collection")
    .setDesc("Automatically compact documents and clean up unused data")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.gcEnabled)
        .onChange(async (value) => {
          plugin.settings.gcEnabled = value;
          await plugin.saveSettings();
        }),
    );

  // Only show detailed settings if GC is enabled
  if (plugin.settings.gcEnabled) {
    // Max document size
    new Setting(container)
      .setName("Compact when larger than")
      .setDesc("Document size threshold for automatic compaction (MB)")
      .addSlider((slider) =>
        slider
          .setLimits(10, 200, 10)
          .setValue(plugin.settings.gcMaxDocSizeMB)
          .setDynamicTooltip()
          .onChange(async (value) => {
            plugin.settings.gcMaxDocSizeMB = value;
            await plugin.saveSettings();
          }),
      );

    // Minimum history days
    new Setting(container)
      .setName("Preserve history for")
      .setDesc("Minimum days of edit history to keep")
      .addSlider((slider) =>
        slider
          .setLimits(7, 365, 7)
          .setValue(plugin.settings.gcMinHistoryDays)
          .setDynamicTooltip()
          .onChange(async (value) => {
            plugin.settings.gcMinHistoryDays = value;
            await plugin.saveSettings();
          }),
      );

    // Peer consensus
    new Setting(container)
      .setName("Require peer sync before cleanup")
      .setDesc("Only clean up data that has been synced to other devices")
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.settings.gcRequirePeerConsensus)
          .onChange(async (value) => {
            plugin.settings.gcRequirePeerConsensus = value;
            await plugin.saveSettings();
          }),
      );
  }

  // Manual GC button
  new Setting(container)
    .setName("Run maintenance now")
    .setDesc("Manually run garbage collection to free up space")
    .addButton((btn) =>
      btn.setButtonText("Run").onClick(async () => {
        if (!plugin.gc) {
          new Notice("Garbage collector not available");
          return;
        }

        btn.setButtonText("Running...");
        btn.setDisabled(true);

        try {
          const stats = await plugin.gc.run();
          const docSavedKB = Math.round(
            (stats.beforeSize - stats.afterSize) / 1024,
          );
          const blobSavedKB = Math.round(stats.blobBytesReclaimed / 1024);
          new Notice(
            `Maintenance complete:\n` +
              `• Document: saved ${docSavedKB} KB\n` +
              `• Blobs: cleaned ${stats.blobsRemoved} (${blobSavedKB} KB)`,
          );
        } catch (error) {
          plugin.logger.error("Manual GC failed:", error);
          new Notice(`Maintenance failed: ${error}`);
        } finally {
          btn.setButtonText("Run");
          btn.setDisabled(false);
        }
      }),
    );

  // Storage info
  if (plugin.documentManager) {
    const docSize = plugin.documentManager.getDocumentSize?.();
    if (docSize !== undefined) {
      const sizeKB = Math.round(docSize / 1024);
      const sizeMB = (docSize / (1024 * 1024)).toFixed(2);
      new Setting(container)
        .setName("Document size")
        .setDesc(`${sizeKB} KB (${sizeMB} MB)`);
    }
  }
}
