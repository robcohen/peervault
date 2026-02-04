/**
 * Advanced Section
 *
 * Node ID, vault ID, debug mode, relay servers, and connection stats.
 */

import { Setting, Notice } from "obsidian";
import type { SectionContext } from "./types";
import { protocolTracer } from "../../utils/protocol-tracer";
import type { ProtocolTraceLevel } from "../../types";

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

  // Protocol tracing toggle
  new Setting(container)
    .setName("Protocol tracing")
    .setDesc("Enable detailed tracing of sync protocol messages for debugging")
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.enableProtocolTracing)
        .onChange(async (value) => {
          plugin.settings.enableProtocolTracing = value;
          protocolTracer.setEnabled(value);
          await plugin.saveSettings();
        }),
    );

  // Protocol trace level (only show if tracing is enabled)
  if (plugin.settings.enableProtocolTracing) {
    new Setting(container)
      .setName("Trace level")
      .setDesc("minimal = state changes only, standard = + messages, verbose = + details")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("minimal", "Minimal")
          .addOption("standard", "Standard")
          .addOption("verbose", "Verbose")
          .setValue(plugin.settings.protocolTraceLevel)
          .onChange(async (value) => {
            plugin.settings.protocolTraceLevel = value as ProtocolTraceLevel;
            protocolTracer.setLevel(value as ProtocolTraceLevel);
            await plugin.saveSettings();
          }),
      );

    // Copy protocol traces
    new Setting(container)
      .setName("Copy protocol traces")
      .setDesc(`Export trace events as NDJSON (${protocolTracer.getEventCount()} events)`)
      .addButton((btn) =>
        btn.setButtonText("Copy Traces").onClick(async () => {
          const ndjson = protocolTracer.exportAsNdjson();
          if (ndjson) {
            await navigator.clipboard.writeText(ndjson);
            new Notice("Traces copied to clipboard!");
          } else {
            new Notice("No trace events available");
          }
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Clear").onClick(() => {
          protocolTracer.clear();
          new Notice("Traces cleared");
          refresh();
        }),
      );
  }

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

  // WebRTC direct connection setting
  new Setting(container)
    .setName("WebRTC direct connections")
    .setDesc(
      "Enable WebRTC for direct peer-to-peer connections on the same network. " +
      "Reduces latency from ~100ms to <10ms when both devices are on the same LAN."
    )
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.enableWebRTC)
        .onChange(async (value) => {
          plugin.settings.enableWebRTC = value;
          await plugin.saveSettings();
          new Notice("Restart plugin to apply WebRTC setting");
        }),
    );

  // Connection stats
  renderConnectionStats(container, plugin);
}

/**
 * Format bytes into human-readable string (KB, MB, GB)
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Quality indicator icons */
const QUALITY_ICONS: Record<string, string> = {
  excellent: "🟢",
  good: "🟢",
  fair: "🟡",
  poor: "🔴",
  disconnected: "⚫",
};

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

  // Get RTT, bandwidth, and health for each connected peer
  for (const peer of connectedPeers) {
    const rtt = plugin.peerManager?.getPeerRtt(peer.nodeId);
    const rttText = rtt !== undefined ? `${Math.round(rtt)}ms` : "measuring...";
    const displayName = peer.hostname || peer.nickname || peer.nodeId.substring(0, 8);
    const health = peer.health;

    // Build description with latency, health, and bandwidth stats
    let desc = `Latency: ${rttText}`;

    // Add health info if available
    if (health) {
      const qualityIcon = QUALITY_ICONS[health.quality] || "";
      desc = `${qualityIcon} ${health.quality} • Latency: ${rttText}`;
      if (health.jitterMs > 0) {
        desc += ` • Jitter: ${Math.round(health.jitterMs)}ms`;
      }
    }

    if (peer.bandwidth) {
      const sent = formatBytes(peer.bandwidth.bytesSent);
      const received = formatBytes(peer.bandwidth.bytesReceived);
      desc += ` • Sent: ${sent} • Received: ${received}`;
    }

    new Setting(container)
      .setName(displayName)
      .setDesc(desc);
  }
}
