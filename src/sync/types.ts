/**
 * Sync Protocol Types
 *
 * Message types and interfaces for the sync protocol.
 */

/**
 * Sync message types - codes match spec/04-sync-protocol.md
 */
export enum SyncMessageType {
  /** Initial version exchange */
  VERSION_INFO = 0x01,

  /** Updates payload (Loro export) */
  UPDATES = 0x02,

  /** Request a full document snapshot (for new peers) */
  SNAPSHOT_REQUEST = 0x03,

  /** Full document snapshot */
  SNAPSHOT = 0x04,

  /** Chunk of a large snapshot */
  SNAPSHOT_CHUNK = 0x05,

  /** Sync complete acknowledgment */
  SYNC_COMPLETE = 0x06,

  /** Error message */
  ERROR = 0x07,

  /** Keep-alive ping */
  PING = 0x08,

  /** Keep-alive pong */
  PONG = 0x09,

  // Blob sync messages (0x10 range, extension to spec)
  /** List of blob hashes we have */
  BLOB_HASHES = 0x10,

  /** Request specific blobs by hash */
  BLOB_REQUEST = 0x11,

  /** Blob data transfer */
  BLOB_DATA = 0x12,

  /** Blob sync complete */
  BLOB_SYNC_COMPLETE = 0x13,

  // Peer management messages (0x20 range)
  /** Notification that peer has been removed */
  PEER_REMOVED = 0x20,
}

/** Base sync message structure */
export interface SyncMessage {
  type: SyncMessageType;
  timestamp: number;
}

/** Version info message - sent at start of sync */
export interface VersionInfoMessage extends SyncMessage {
  type: SyncMessageType.VERSION_INFO;
  /** Serialized version vector */
  versionBytes: Uint8Array;
  /** Vault ID for validation */
  vaultId: string;
  /** Optional connection ticket for bidirectional reconnection */
  ticket?: string;
}

/** Snapshot request message - for new peers requesting full document */
export interface SnapshotRequestMessage extends SyncMessage {
  type: SyncMessageType.SNAPSHOT_REQUEST;
}

/** Full document snapshot message */
export interface SnapshotMessage extends SyncMessage {
  type: SyncMessageType.SNAPSHOT;
  /** Full Loro document snapshot */
  snapshot: Uint8Array;
  /** Size of full snapshot for progress tracking */
  totalSize: number;
}

/** Chunk of a large snapshot */
export interface SnapshotChunkMessage extends SyncMessage {
  type: SyncMessageType.SNAPSHOT_CHUNK;
  /** Chunk sequence number (0-indexed) */
  chunkIndex: number;
  /** Total number of chunks */
  totalChunks: number;
  /** Chunk data */
  data: Uint8Array;
}

/** Updates message - contains Loro export data */
export interface UpdatesMessage extends SyncMessage {
  type: SyncMessageType.UPDATES;
  /** Loro update payload */
  updates: Uint8Array;
  /** Number of operations in this update */
  opCount: number;
}

/** Sync complete message */
export interface SyncCompleteMessage extends SyncMessage {
  type: SyncMessageType.SYNC_COMPLETE;
  /** Final version after sync */
  versionBytes: Uint8Array;
}

/** Ping message */
export interface PingMessage extends SyncMessage {
  type: SyncMessageType.PING;
  seq: number;
}

/** Pong message */
export interface PongMessage extends SyncMessage {
  type: SyncMessageType.PONG;
  seq: number;
}

/** Error message */
export interface ErrorMessage extends SyncMessage {
  type: SyncMessageType.ERROR;
  code: SyncErrorCode;
  message: string;
}

/** Blob hashes message - list of blob hashes we have */
export interface BlobHashesMessage extends SyncMessage {
  type: SyncMessageType.BLOB_HASHES;
  /** List of blob hashes */
  hashes: string[];
}

/** Blob request message - request specific blobs */
export interface BlobRequestMessage extends SyncMessage {
  type: SyncMessageType.BLOB_REQUEST;
  /** Hashes of blobs to request */
  hashes: string[];
}

/** Blob data message - transfer blob data */
export interface BlobDataMessage extends SyncMessage {
  type: SyncMessageType.BLOB_DATA;
  /** Hash of the blob */
  hash: string;
  /** Blob content */
  data: Uint8Array;
  /** MIME type of the blob */
  mimeType?: string;
}

/** Blob sync complete message */
export interface BlobSyncCompleteMessage extends SyncMessage {
  type: SyncMessageType.BLOB_SYNC_COMPLETE;
  /** Number of blobs synced */
  blobCount: number;
}

/** Peer removed notification message */
export interface PeerRemovedMessage extends SyncMessage {
  type: SyncMessageType.PEER_REMOVED;
  /** Reason for removal (optional) */
  reason?: string;
}

/** Sync error codes */
export enum SyncErrorCode {
  UNKNOWN = 0,
  VERSION_MISMATCH = 1,
  VAULT_MISMATCH = 2,
  INVALID_MESSAGE = 3,
  INTERNAL_ERROR = 4,
}

/** Union type of all sync messages */
export type AnySyncMessage =
  | VersionInfoMessage
  | SnapshotRequestMessage
  | SnapshotMessage
  | SnapshotChunkMessage
  | UpdatesMessage
  | SyncCompleteMessage
  | PingMessage
  | PongMessage
  | ErrorMessage
  | BlobHashesMessage
  | BlobRequestMessage
  | BlobDataMessage
  | BlobSyncCompleteMessage
  | PeerRemovedMessage;

/** Sync session state */
export type SyncSessionState =
  | "idle"
  | "connecting"
  | "exchanging_versions"
  | "syncing"
  | "live"
  | "error"
  | "closed";

/** Sync session events */
export interface SyncSessionEvents {
  "state:change": { state: SyncSessionState };
  "sync:progress": { sent: number; received: number };
  "sync:complete": { versionBytes: Uint8Array };
  error: { error: Error };
}
