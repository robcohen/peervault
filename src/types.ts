/**
 * PeerVault shared type definitions
 */

import type {
  LoroDoc,
  LoroTree,
  LoroMap,
  LoroText,
  LoroList,
  TreeID,
} from "loro-crdt";

// ============================================================================
// Document Types
// ============================================================================

/**
 * A PeerVault document wrapping a Loro document with our schema.
 */
export interface PeerVaultDoc {
  readonly loro: LoroDoc;
  readonly tree: LoroTree;
  readonly meta: LoroMap;
}

/**
 * Node type in the file tree.
 * - 'file': Text file with content stored in node.data.content (LoroText)
 * - 'folder': Directory node
 * - 'binary': Binary file with content hash stored in node.data.blobHash
 */
export type FileNodeType = "file" | "folder" | "binary";

/**
 * File node metadata stored in the Loro tree node.data (LoroMap).
 * Per Loro best practices, all data including content is stored in node.data.
 */
export interface FileNodeMeta {
  /** File name (not path) */
  name: string;
  /** Node type: 'file' | 'folder' | 'binary' */
  type: FileNodeType;
  /** MIME type (e.g., 'text/markdown', 'image/png') */
  mimeType?: string;
  /** Last modification time (Unix ms) */
  mtime: number;
  /** Creation time (Unix ms) */
  ctime: number;
  /** Soft delete flag (always initialized, not optional) */
  deleted: boolean;
  /** For binary files: content hash (SHA-256 hex) */
  blobHash?: string;
}

/**
 * Serialized version vector for sync protocol.
 */
export interface SerializedVersionVector {
  entries: Array<[string, number]>;
}

// ============================================================================
// Storage Types
// ============================================================================

/**
 * Storage adapter interface for platform abstraction.
 */
export interface StorageAdapter {
  /** Read raw bytes from storage */
  read(key: string): Promise<Uint8Array | null>;
  /** Write raw bytes to storage */
  write(key: string, data: Uint8Array): Promise<void>;
  /** Delete a key from storage */
  delete(key: string): Promise<void>;
  /** List all keys with optional prefix */
  list(prefix?: string): Promise<string[]>;
  /** Check if a key exists */
  exists(key: string): Promise<boolean>;
}

/**
 * Snapshot metadata for document persistence.
 */
export interface SnapshotMeta {
  /** Snapshot ID */
  id: string;
  /** Version vector at snapshot time */
  version: SerializedVersionVector;
  /** Snapshot timestamp */
  timestamp: number;
  /** Size in bytes */
  sizeBytes: number;
}

// ============================================================================
// Peer Types
// ============================================================================

/**
 * Peer identity and connection info.
 */
export interface PeerInfo {
  /** Unique peer identifier (Iroh NodeId) */
  nodeId: string;
  /** Device hostname (sent by peer) */
  hostname?: string;
  /** User-friendly nickname (set locally) */
  nickname?: string;
  /** Device type */
  deviceType: "desktop" | "mobile" | "tablet" | "unknown";
  /** Last seen timestamp */
  lastSeen: number;
  /** Connection state */
  connectionState: ConnectionState;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "syncing"
  | "error";

/**
 * Pairing ticket for device pairing.
 */
export interface PairingTicket {
  /** Iroh node ticket */
  nodeTicket: string;
  /** Vault ID for verification */
  vaultId: string;
  /** Expiration timestamp */
  expiresAt: number;
  /** Peer name for display */
  peerName: string;
}

// ============================================================================
// Sync Types
// ============================================================================

/**
 * Sync message types for peer communication.
 */
export type SyncMessage =
  | { type: "handshake"; version: Uint8Array; peerId: string; peerName: string }
  | { type: "sync-request"; version: Uint8Array }
  | { type: "sync-response"; updates: Uint8Array; version: Uint8Array }
  | { type: "update"; data: Uint8Array }
  | { type: "ack"; version: Uint8Array }
  | { type: "blob-request"; hashes: string[] }
  | { type: "blob-have"; available: string[]; missing: string[] }
  | {
      type: "blob-transfer";
      hash: string;
      data: Uint8Array;
      offset: number;
      total: number;
    }
  | { type: "blob-ack"; hash: string; received: boolean }
  | { type: "error"; code: string; message: string };

/**
 * Sync session state.
 */
export interface SyncSession {
  peerId: string;
  startTime: number;
  bytesReceived: number;
  bytesSent: number;
  updatesReceived: number;
  updatesSent: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Events emitted by PeerVault components.
 */
export interface PeerVaultEvents {
  // Document events
  "doc:change": { origin: "local" | "remote"; peerId?: string };
  "doc:file-created": { path: string; nodeId: TreeID };
  "doc:file-modified": { path: string; nodeId: TreeID };
  "doc:file-deleted": { path: string; nodeId: TreeID };
  "doc:file-moved": { oldPath: string; newPath: string; nodeId: TreeID };

  // Peer events
  "peer:connected": { peer: PeerInfo };
  "peer:disconnected": { peer: PeerInfo; reason?: string };
  "peer:sync-start": { peer: PeerInfo };
  "peer:sync-complete": { peer: PeerInfo; duration: number };
  "peer:sync-error": { peer: PeerInfo; error: Error };

  // Transfer events
  "transfer:start": {
    hash: string;
    totalBytes: number;
    direction: "upload" | "download";
  };
  "transfer:progress": {
    hash: string;
    receivedBytes: number;
    totalBytes: number;
  };
  "transfer:complete": { hash: string; duration: number };
  "transfer:error": { hash: string; error: Error };

  // Status events
  "status:change": { status: SyncStatus };
  error: { error: Error; context?: string };
}

export type SyncStatus = "idle" | "syncing" | "offline" | "error";

// ============================================================================
// Settings Types
// ============================================================================

/** Transport type for P2P connections */
export type TransportType = "iroh";

/**
 * Plugin settings stored in Obsidian.
 */
export interface PeerVaultSettings {
  /** Enable sync on startup */
  autoSync: boolean;
  /** Sync interval in seconds (0 = real-time) */
  syncInterval: number;
  /** Folders to exclude from sync */
  excludedFolders: string[];
  /** Maximum file size to sync (bytes) */
  maxFileSize: number;
  /** Show sync status in status bar */
  showStatusBar: boolean;
  /** Enable debug logging */
  debugMode: boolean;
  /** Relay server URLs */
  relayServers: string[];
  /** Transport type for P2P connections */
  transportType: TransportType;
  /** Enable end-to-end encryption for sync */
  encryptionEnabled: boolean;
  /** Enable encryption at rest (local storage) */
  storageEncrypted: boolean;
  /** Encrypted encryption key (encrypted with password-derived key) */
  encryptedKey?: string;
  /** Salt for password-based key derivation */
  keySalt?: string;
  /** Garbage collection configuration */
  gcEnabled: boolean;
  /** Maximum document size in MB before GC runs (default: 50) */
  gcMaxDocSizeMB: number;
  /** Minimum history retention in days (default: 30) */
  gcMinHistoryDays: number;
  /** Require peer consensus before GC (default: true) */
  gcRequirePeerConsensus: boolean;
}

export const DEFAULT_SETTINGS: PeerVaultSettings = {
  autoSync: true,
  syncInterval: 0,
  excludedFolders: [".obsidian/plugins", ".obsidian/themes"],
  maxFileSize: 100 * 1024 * 1024, // 100 MB
  showStatusBar: true,
  debugMode: false,
  relayServers: [],
  transportType: "iroh",
  encryptionEnabled: false,
  storageEncrypted: false,
  gcEnabled: true,
  gcMaxDocSizeMB: 50,
  gcMinHistoryDays: 30,
  gcRequirePeerConsensus: true,
};
