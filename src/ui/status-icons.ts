/**
 * Status Icons
 *
 * Consistent status icons and colors across the UI.
 */

/** Status icon characters */
export const STATUS_ICONS = {
  connected: "●", // Filled circle
  syncing: "◐", // Half circle (animated feel)
  offline: "○", // Empty circle
  error: "◆", // Diamond (warning)
  idle: "○", // Empty circle
  unknown: "○", // Empty circle
} as const;

/** Status colors (CSS class suffixes) */
export const STATUS_COLORS = {
  connected: "connected",
  syncing: "syncing",
  offline: "offline",
  error: "error",
  idle: "idle",
} as const;

/** Get status icon for a peer connection state */
export function getPeerStateIcon(
  state: "connected" | "syncing" | "disconnected" | "error" | "idle",
): string {
  switch (state) {
    case "connected":
      return STATUS_ICONS.connected;
    case "syncing":
      return STATUS_ICONS.syncing;
    case "disconnected":
      return STATUS_ICONS.offline;
    case "error":
      return STATUS_ICONS.error;
    case "idle":
      return STATUS_ICONS.idle;
    default:
      return STATUS_ICONS.unknown;
  }
}

/** Get accessible label for a status */
export function getStatusLabel(
  status: "connected" | "syncing" | "disconnected" | "error" | "idle" | "offline",
): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "syncing":
      return "Syncing";
    case "disconnected":
      return "Disconnected";
    case "offline":
      return "Offline";
    case "error":
      return "Error";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}
