/**
 * Advanced Section
 *
 * Node ID, vault ID, debug mode, relay servers, and connection stats.
 */

import { Setting, Notice } from "obsidian";
import type { SectionContext } from "./types";

export function renderAdvancedSection(
  container: HTMLElement,
  ctx: SectionContext,
): void {
  const { plugin, refresh, expandedSections } = ctx;
  const isExpanded = expandedSections.has("advanced");

  new Setting(container)
    .setName("Advanced")
    .setHeading()
    .addExtraButton((btn) =>
      btn
        .setIcon(isExpanded ? "chevron-up" : "chevron-down")
        .setTooltip(isExpanded ? "Collapse" : "Expand")
        .onClick(() => {
          if (isExpanded) expandedSections.delete("advanced");
          else expandedSections.add("advanced");
          refresh();
        }),
    );

  if (!isExpanded) return;

  // Node ID
  const nodeId = plugin.getNodeId();
  new Setting(container)
    .setName("Node ID")
    .setDesc(nodeId.substring(0, 20) + "...")
    .addExtraButton((btn) =>
      btn
        .setIcon("copy")
        .setTooltip("Copy")
        .onClick(() => {
          navigator.clipboard.writeText(nodeId);
          new Notice("Node ID copied");
        }),
    );

  // Vault ID
  const vaultId = plugin.documentManager?.getVaultId() ?? "Not initialized";
  new Setting(container)
    .setName("Vault ID")
    .setDesc(vaultId.substring(0, 20) + "...")
    .addExtraButton((btn) =>
      btn
        .setIcon("copy")
        .setTooltip("Copy")
        .onClick(() => {
          navigator.clipboard.writeText(vaultId);
          new Notice("Vault ID copied");
        }),
    );

  new Setting(container)
    .setName("Show status bar")
    .setDesc("Display sync status in the status bar")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.showStatusBar)
        .onChange(async (value) => {
          plugin.settings.showStatusBar = value;
          await plugin.saveSettings();
          new Notice("Restart Obsidian to apply");
        }),
    );

  new Setting(container)
    .setName("Debug mode")
    .setDesc("Enable verbose logging for troubleshooting")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.debugMode)
        .onChange(async (value) => {
          plugin.settings.debugMode = value;
          await plugin.saveSettings();
        }),
    );

  // Copy logs for debugging
  new Setting(container)
    .setName("Copy debug logs")
    .setDesc("Copy recent logs to clipboard for troubleshooting")
    .addButton((btn) =>
      btn.setButtonText("Copy Logs").onClick(async () => {
        const { getRecentLogs } = await import("../../utils/logger");
        const logs = getRecentLogs(200);
        if (logs) {
          await navigator.clipboard.writeText(logs);
          new Notice("Logs copied to clipboard!");
        } else {
          new Notice("No logs available");
        }
      }),
    );

  // Custom relay server
  new Setting(container)
    .setName("Custom relay server")
    .setDesc("Use a relay server closer to you for lower latency. Leave empty for default (US-based).")
    .addText((text) =>
      text
        .setPlaceholder("https://relay.example.com")
        .setValue(plugin.settings.relayServers[0] ?? "")
        .onChange(async (value) => {
          if (value.trim()) {
            plugin.settings.relayServers = [value.trim()];
          } else {
            plugin.settings.relayServers = [];
          }
          await plugin.saveSettings();
          new Notice("Restart plugin to use new relay");
        }),
    );

  // Connection stats
  renderConnectionStats(container, plugin);
}

function renderConnectionStats(
  container: HTMLElement,
  plugin: SectionContext["plugin"],
): void {
  const peers = plugin.peerManager?.getPeers() ?? [];
  const connectedPeers = peers.filter((p) => p.state === "synced" || p.state === "syncing");

  if (connectedPeers.length === 0) {
    new Setting(container)
      .setName("Connection latency")
      .setDesc("No active connections");
    return;
  }

  // Get RTT for each connected peer
  for (const peer of connectedPeers) {
    const rtt = plugin.peerManager?.getPeerRtt(peer.nodeId);
    const rttText = rtt !== undefined ? `${Math.round(rtt)}ms` : "measuring...";
    const displayName = peer.hostname || peer.nickname || peer.nodeId.substring(0, 8);

    new Setting(container)
      .setName(`Latency: ${displayName}`)
      .setDesc(`Round-trip time: ${rttText}`);
  }
}
