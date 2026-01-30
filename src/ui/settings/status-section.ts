/**
 * Status Section
 *
 * Displays connection status, device info, and conflicts.
 */

import { Setting, Notice } from "obsidian";
import type { SectionContext } from "./types";
import { getDeviceHostname, nodeIdToWords } from "../../utils/device";
import { getConflictTracker } from "../../core/conflict-tracker";
import { ConflictModal } from "../conflict-modal";

/** State for nickname editing */
let editingNickname = false;

export function renderStatusSection(
  container: HTMLElement,
  ctx: SectionContext,
): void {
  container.createEl("h3", { text: "Status" });

  const { plugin, app, refresh } = ctx;

  // Get stats
  const peers = plugin.getConnectedPeers();
  const connectedCount = peers.filter(
    (p) => p.connectionState === "connected" || p.connectionState === "syncing",
  ).length;
  const fileCount = plugin.documentManager?.listAllPaths().length ?? 0;
  const hostname = getDeviceHostname();
  const autoNickname = nodeIdToWords(plugin.getNodeId());
  const nickname = plugin.settings.deviceNickname || autoNickname;

  // Line 1: Connection stats
  new Setting(container)
    .setName(`${connectedCount}/${peers.length} devices connected`)
    .setDesc(`${fileCount} files synced`)
    .addExtraButton((btn) =>
      btn
        .setIcon("refresh-cw")
        .setTooltip("Refresh")
        .onClick(() => refresh()),
    );

  // Line 2: This device identity
  if (editingNickname) {
    renderNicknameEditor(container, ctx, autoNickname);
  } else {
    new Setting(container)
      .setName(`This device: ${hostname}`)
      .setDesc(`Nickname: ${nickname}`)
      .addExtraButton((btn) =>
        btn
          .setIcon("pencil")
          .setTooltip("Edit nickname")
          .onClick(() => {
            editingNickname = true;
            refresh();
          }),
      );
  }

  // Conflicts (only if present)
  const tracker = getConflictTracker();
  const conflictCount = tracker.getConflictCount();
  if (conflictCount > 0) {
    new Setting(container)
      .setName("Concurrent edits")
      .setDesc(`${conflictCount} file(s) need review`)
      .addButton((btn) =>
        btn
          .setButtonText("Review")
          .setWarning()
          .onClick(() => {
            new ConflictModal(app, plugin).open();
          }),
      );
  }
}

function renderNicknameEditor(
  container: HTMLElement,
  ctx: SectionContext,
  autoNickname: string,
): void {
  const { plugin, refresh } = ctx;
  const currentNickname = plugin.settings.deviceNickname ?? "";
  let pendingNickname = currentNickname;

  new Setting(container)
    .setName("Edit nickname")
    .setDesc(`Auto-generated: "${autoNickname}"`)
    .addText((text) => {
      text
        .setPlaceholder(autoNickname)
        .setValue(currentNickname)
        .onChange((value) => {
          pendingNickname = value.trim();
        });
    })
    .addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          btn.setButtonText("Saving...");
          btn.setDisabled(true);

          plugin.settings.deviceNickname = pendingNickname || undefined;
          await plugin.saveSettings();

          const newNickname = pendingNickname || autoNickname;
          if (plugin.peerManager) {
            plugin.peerManager.setOwnNickname(newNickname);
          }

          try {
            const peerManager = plugin.peerManager;
            if (peerManager) {
              for (const peer of peerManager.getPeers()) {
                await peerManager.closeSession(peer.nodeId);
              }
              await peerManager.syncAll();
            }
            new Notice("Nickname updated");
          } catch {
            new Notice("Nickname saved");
          }

          editingNickname = false;
          refresh();
        }),
    )
    .addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => {
        editingNickname = false;
        refresh();
      }),
    );
}

/** Reset editing state (call when settings tab is hidden) */
export function resetStatusSectionState(): void {
  editingNickname = false;
}
