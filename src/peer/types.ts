/**
 * Peer Management Types
 *
 * Types for managing peer connections and sync state.
 */

/** Peer state */
export type PeerState =
  | "unknown"
  | "connecting"
  | "syncing"
  | "synced"
  | "offline"
  | "error";

/** Information about a known peer */
export interface PeerInfo {
  /** Peer's node ID */
  nodeId: string;

  /** User-friendly name (if set) */
  name?: string;

  /** Last known state */
  state: PeerState;

  /** Connection ticket (for reconnection) */
  ticket?: string;

  /** When this peer was first seen */
  firstSeen: number;

  /** When this peer was last synced */
  lastSynced?: number;

  /** When this peer was last seen online */
  lastSeen?: number;

  /** Whether this peer is trusted (can write) */
  trusted: boolean;

  /** Groups this peer belongs to */
  groupIds?: string[];
}

/** Serialized peer info for storage */
export interface StoredPeerInfo {
  nodeId: string;
  name?: string;
  ticket?: string;
  firstSeen: number;
  lastSynced?: number;
  lastSeen?: number;
  trusted: boolean;
  groupIds?: string[];
}

/** Events from peer manager */
export interface PeerManagerEvents {
  "peer:connected": PeerInfo;
  "peer:disconnected": { nodeId: string; reason?: string };
  "peer:synced": string; // nodeId
  "peer:error": { nodeId: string; error: Error };
  "status:change": "idle" | "syncing" | "offline" | "error";
}

/** Peer manager configuration */
export interface PeerManagerConfig {
  /** Auto-sync interval in ms (0 to disable) */
  autoSyncInterval?: number;

  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;

  /** Max reconnect attempts */
  maxReconnectAttempts?: number;

  /** Reconnect backoff base (ms) */
  reconnectBackoff?: number;
}
