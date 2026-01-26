/**
 * Peer Groups Types
 *
 * Defines interfaces for organizing peers into groups with
 * per-group sync policies.
 */

/**
 * A peer group for organizing devices.
 */
export interface PeerGroup {
  /** Unique group identifier */
  id: string;
  /** Display name */
  name: string;
  /** Icon (emoji or icon name) */
  icon: string;
  /** Group color for UI (hex) */
  color: string;
  /** Peers in this group (nodeIds) */
  peerIds: string[];
  /** Sync policy for this group */
  syncPolicy: GroupSyncPolicy;
  /** When group was created */
  createdAt: number;
}

/**
 * Sync policy for a peer group.
 */
export interface GroupSyncPolicy {
  /** Folders to exclude from sync for this group */
  excludedFolders: string[];
  /** Whether peers in this group are read-only (can't send changes) */
  readOnly: boolean;
  /** Auto-connect when any peer in group is available */
  autoConnect: boolean;
  /** Priority for sync (higher = sync first) */
  priority: number;
}

/**
 * Default sync policy values.
 */
export const DEFAULT_SYNC_POLICY: GroupSyncPolicy = {
  excludedFolders: [],
  readOnly: false,
  autoConnect: true,
  priority: 0,
};

/**
 * Default group ID (all peers belong to this by default).
 */
export const DEFAULT_GROUP_ID = "default";

/**
 * Default group configuration.
 */
export const DEFAULT_GROUP: Omit<PeerGroup, "createdAt"> = {
  id: DEFAULT_GROUP_ID,
  name: "All Devices",
  icon: "📱",
  color: "#7c7c7c",
  peerIds: [],
  syncPolicy: DEFAULT_SYNC_POLICY,
};

/**
 * Event types for peer group changes.
 */
export interface PeerGroupEvents extends Record<string, unknown> {
  "group:created": PeerGroup;
  "group:updated": PeerGroup;
  "group:deleted": string; // group ID
  "peer:added-to-group": { groupId: string; peerId: string };
  "peer:removed-from-group": { groupId: string; peerId: string };
}
