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

  /** Peer's hostname (sent by them during sync) */
  hostname?: string;

  /** User-friendly nickname (set locally) */
  nickname?: string;

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
  hostname?: string;
  nickname?: string;
  ticket?: string;
  firstSeen: number;
  lastSynced?: number;
  lastSeen?: number;
  trusted: boolean;
  groupIds?: string[];
}

/** Incoming pairing request from unknown peer */
export interface PairingRequest {
  /** Remote peer's node ID */
  nodeId: string;
  /** Remote peer's ticket (for reconnection if accepted) */
  ticket?: string;
  /** When the request was received */
  timestamp: number;
}

/** Events from peer manager */
export interface PeerManagerEvents {
  "peer:connected": PeerInfo;
  "peer:disconnected": { nodeId: string; reason?: string };
  "peer:synced": string; // nodeId
  "peer:error": { nodeId: string; error: Error };
  "peer:pairing-request": PairingRequest;
  "peer:pairing-accepted": string; // nodeId
  "peer:pairing-denied": string; // nodeId
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

  /** Our device hostname to share with peers */
  hostname?: string;
}
