/**
 * Garbage Collection Types
 *
 * Defines configuration and result types for document compaction
 * and orphaned blob cleanup.
 */

/**
 * Configuration for garbage collection.
 */
export interface GCConfig {
  /** Enable automatic garbage collection */
  enabled: boolean;
  /** Maximum document size in MB before forcing GC (default: 50) */
  maxDocSizeMB: number;
  /** Minimum history retention in days (default: 30) */
  minHistoryDays: number;
  /** Require all known peers to have synced before GC (default: true) */
  requirePeerConsensus: boolean;
}

/**
 * Default GC configuration.
 */
export const DEFAULT_GC_CONFIG: GCConfig = {
  enabled: true,
  maxDocSizeMB: 50,
  minHistoryDays: 30,
  requirePeerConsensus: true,
};

/**
 * Result of running garbage collection.
 */
export interface GCStats {
  /** Document size before compaction (bytes) */
  beforeSize: number;
  /** Document size after compaction (bytes) */
  afterSize: number;
  /** Number of orphaned blobs removed */
  blobsRemoved: number;
  /** Bytes reclaimed from blob cleanup */
  blobBytesReclaimed: number;
  /** Timestamp of GC run */
  timestamp: number;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Information about a peer's sync state for consensus checking.
 */
export interface PeerSyncState {
  /** Peer's node ID */
  peerId: string;
  /** Peer's human-readable name */
  peerName?: string;
  /** When we last synced with this peer */
  lastSyncTime: number;
  /** Whether peer is currently connected */
  isConnected: boolean;
}

/**
 * Information about an orphaned blob.
 */
export interface OrphanedBlobInfo {
  /** Blob hash */
  hash: string;
  /** Blob size in bytes */
  size: number;
  /** When the blob was created */
  createdAt?: number;
}

/**
 * Progress callback for GC operations.
 */
export type GCProgressCallback = (percent: number, message: string) => void;
