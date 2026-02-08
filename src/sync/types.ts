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

  /** Announce discovered peers to group members */
  PEER_ANNOUNCEMENT = 0x21,

  /** Request peers for specific groups */
  PEER_REQUEST = 0x22,

  /** Announce that a peer has left a group (for mesh cleanup) */
  PEER_LEFT = 0x23,

  // Key exchange messages (0x30 range)
  /** Request vault key from peer (includes our public key) */
  KEY_EXCHANGE_REQUEST = 0x30,

  /** Response with encrypted vault key */
  KEY_EXCHANGE_RESPONSE = 0x31,
}

/** Base sync message structure */
export interface SyncMessage {
  type: SyncMessageType;
  timestamp: number;
}

/** Known peer info for peer discovery */
export interface KnownPeerInfo {
  /** Peer's node ID */
  nodeId: string;
  /** Connection ticket (if available) */
  ticket?: string;
  /** Groups this peer belongs to */
  groupIds: string[];
  /** Timestamp when last seen/connected */
  lastSeen: number;
}

/**
 * Current protocol version.
 * Used for protocol-level feature negotiation.
 */
export const SYNC_PROTOCOL_VERSION = 2;

/** Version info message - sent at start of sync */
export interface VersionInfoMessage extends SyncMessage {
  type: SyncMessageType.VERSION_INFO;
  /** Serialized version vector */
  versionBytes: Uint8Array;
  /** Vault ID for validation */
  vaultId: string;
  /** Connection ticket for bidirectional reconnection */
  ticket: string;
  /** Device hostname (from system) */
  hostname: string;
  /** Device nickname (optional, user-defined) */
  nickname?: string;
  /** Groups this peer belongs to (protocol v2+) */
  groupIds?: string[];
  /** Known peers for discovery (protocol v2+) */
  knownPeers?: KnownPeerInfo[];
  /** Protocol version for backwards compatibility (default: 1) */
  protocolVersion?: number;
  /** Plugin version (e.g., "0.2.53") - must match exactly to sync */
  pluginVersion?: string;
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

/** Peer announcement message - gossip discovered peers to group members */
export interface PeerAnnouncementMessage extends SyncMessage {
  type: SyncMessageType.PEER_ANNOUNCEMENT;
  /** Peers being announced */
  peers: KnownPeerInfo[];
  /** Reason for announcement */
  reason: "joined" | "discovered" | "updated";
}

/** Peer request message - request peers for specific groups */
export interface PeerRequestMessage extends SyncMessage {
  type: SyncMessageType.PEER_REQUEST;
  /** Groups to request peers for */
  groupIds: string[];
}

/** Peer left message - announce that a peer has left the group */
export interface PeerLeftMessage extends SyncMessage {
  type: SyncMessageType.PEER_LEFT;
  /** Node ID of the peer that left */
  nodeId: string;
  /** Groups the peer left (empty = all groups) */
  groupIds: string[];
  /** Reason for leaving */
  reason: "removed" | "disconnected" | "left";
}

/** Key exchange request - sent by new peer to request vault key */
export interface KeyExchangeRequestMessage extends SyncMessage {
  type: SyncMessageType.KEY_EXCHANGE_REQUEST;
  /** Our Curve25519 public key for the key exchange */
  publicKey: Uint8Array;
  /** Whether we already have a vault key (existing device joining) */
  hasExistingKey: boolean;
}

/** Key exchange response - contains encrypted vault key */
export interface KeyExchangeResponseMessage extends SyncMessage {
  type: SyncMessageType.KEY_EXCHANGE_RESPONSE;
  /** Encrypted vault key bundle (serialized EncryptedKeyBundle) */
  encryptedKey: Uint8Array;
  /** Whether this is a new key (first device) or existing key */
  isNewKey: boolean;
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
  | PeerRemovedMessage
  | PeerAnnouncementMessage
  | PeerRequestMessage
  | PeerLeftMessage
  | KeyExchangeRequestMessage
  | KeyExchangeResponseMessage;

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
