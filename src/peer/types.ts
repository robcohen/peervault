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

/** Bandwidth statistics for a peer */
export interface PeerBandwidthStats {
  /** Total bytes sent to this peer */
  bytesSent: number;
  /** Total bytes received from this peer */
  bytesReceived: number;
  /** Bytes sent in the last sync session */
  lastSessionBytesSent: number;
  /** Bytes received in the last sync session */
  lastSessionBytesReceived: number;
  /** Timestamp of last stats update */
  lastUpdated: number;
}

/** Connection quality level */
export type ConnectionQuality = "excellent" | "good" | "fair" | "poor" | "disconnected";

/** Connection health metrics for a peer */
export interface ConnectionHealth {
  /** Current quality assessment */
  quality: ConnectionQuality;
  /** Average RTT in ms (rolling average) */
  avgRttMs: number;
  /** RTT jitter in ms (standard deviation) */
  jitterMs: number;
  /** Number of consecutive ping failures */
  failedPings: number;
  /** Total successful pings */
  successfulPings: number;
  /** Last successful ping timestamp */
  lastPingAt?: number;
  /** RTT history (last N samples) */
  rttHistory: number[];
}

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

  /** Bandwidth usage statistics */
  bandwidth?: PeerBandwidthStats;

  /** Connection health metrics */
  health?: ConnectionHealth;
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
  /** Bandwidth usage statistics (persisted for cumulative totals) */
  bandwidth?: PeerBandwidthStats;
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
  "peer:health-change": { nodeId: string; quality: ConnectionQuality; previousQuality: ConnectionQuality };
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

  /** Our device hostname (required, from system) */
  hostname: string;

  /** Our device nickname (optional, user-defined) */
  nickname?: string;

  /** Our plugin version (e.g., "0.2.53") - peers must match to sync */
  pluginVersion?: string;

  /** Enable WebRTC upgrade for direct connections (in-band signaling) */
  enableWebRTC?: boolean;
}
