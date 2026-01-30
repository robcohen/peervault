/**
 * Danger Zone Section
 *
 * Reset and destructive operations.
 */

import { Setting, Notice } from "obsidian";
import type { SectionContext } from "./types";
import { showConfirm } from "../confirm-modal";

export function renderDangerZone(
  container: HTMLElement,
  ctx: SectionContext,
): void {
  const { plugin, app, refresh } = ctx;

  container.createEl("h3", {
    text: "Danger Zone",
    cls: "peervault-danger-header",
  });

  new Setting(container)
    .setName("Reset sync data")
    .setDesc(
      "Delete all sync data and start fresh. Peers will need to re-pair.",
    )
    .addButton((btn) =>
      btn
        .setButtonText("Reset")
        .setWarning()
        .onClick(async () => {
          const confirmed = await showConfirm(app, {
            title: "Reset PeerVault",
            message:
              "Are you sure you want to reset all PeerVault data?\n\n" +
              "This will:\n" +
              "- Remove all paired devices\n" +
              "- Delete sync history\n" +
              "- Clear encryption keys\n\n" +
              "Your vault files will NOT be deleted.",
            confirmText: "Reset",
            isDestructive: true,
          });
          if (confirmed) {
            await resetPlugin(plugin);
            refresh();
          }
        }),
    );
}

async function resetPlugin(plugin: SectionContext["plugin"]): Promise<void> {
  try {
    // Remove all peers
    if (plugin.peerManager) {
      const peers = plugin.peerManager.getPeers();
      for (const peer of peers) {
        await plugin.peerManager.removePeer(peer.nodeId);
      }
    }

    // Save settings
    await plugin.saveSettings();

    // Clear stored data
    await plugin.storage.delete("peervault-peers");
    await plugin.storage.delete("peervault-snapshot");

    new Notice("PeerVault data has been reset. Please restart Obsidian.");
  } catch (error) {
    plugin.logger.error("Reset failed:", error);
    new Notice(`Reset failed: ${error}`);
  }
}
