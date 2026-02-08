/**
 * Cloud Sync Types
 *
 * Data structures for S3-compatible cloud storage sync.
 *
 * Storage Structure:
 * /v1/{vault}/
 *   deltas/{timestamp}-{hash}.enc    # Encrypted CRDT deltas
 *   commits/{hash}.json              # Commit metadata
 *   refs/HEAD                        # Current head commit hash
 *   manifest.json                    # Vault metadata
 */

/**
 * Configuration for S3-compatible cloud storage.
 */
export interface CloudStorageConfig {
  /** S3-compatible endpoint URL (e.g., "https://xxx.r2.cloudflarestorage.com") */
  endpoint: string;
  /** Bucket name */
  bucket: string;
  /** Access key ID */
  accessKeyId: string;
  /** Secret access key */
  secretAccessKey: string;
  /** AWS region (default: "auto" for R2) */
  region?: string;
  /** Path prefix within bucket (default: "v1") */
  pathPrefix?: string;
}

/**
 * Metadata for an encrypted delta file.
 */
export interface DeltaMeta {
  /** Unique identifier (timestamp-hash) */
  id: string;
  /** When the delta was created */
  timestamp: number;
  /** SHA-256 hash of encrypted content */
  hash: string;
  /** Size in bytes (encrypted) */
  size: number;
  /** Loro document version after this delta */
  version: Uint8Array;
  /** Previous delta ID (for ordering) */
  previousDeltaId?: string;
}

/**
 * A commit represents an intentional snapshot point.
 * Similar to git commits - created explicitly by user action.
 */
export interface Commit {
  /** Commit hash (SHA-256 of content) */
  hash: string;
  /** Human-readable message */
  message: string;
  /** When the commit was created */
  timestamp: number;
  /** Parent commit hash (null for initial commit) */
  parent: string | null;
  /** Loro document version at this commit */
  version: Uint8Array;
  /** Delta IDs included since parent commit */
  deltaIds: string[];
  /** Device that created this commit */
  deviceId: string;
  /** Optional device nickname */
  deviceNickname?: string;
}

/**
 * Vault manifest stored in cloud.
 * Contains metadata about the vault and sync state.
 */
export interface VaultManifest {
  /** Manifest format version */
  version: number;
  /** Vault ID (matches local vault ID) */
  vaultId: string;
  /** When the vault was first synced to cloud */
  createdAt: number;
  /** When the manifest was last updated */
  updatedAt: number;
  /** Current HEAD commit hash */
  headCommit: string | null;
  /** Latest delta ID (for incremental sync) */
  latestDeltaId: string | null;
  /** Encryption key fingerprint (for verification) */
  keyFingerprint: string;
  /** ETag for optimistic concurrency control */
  etag?: string;
  /** Sequence number for ordering concurrent updates */
  sequence?: number;
}

/**
 * Status of cloud sync.
 */
export type CloudSyncStatus =
  | "disabled"      // Cloud sync not configured
  | "idle"          // Connected, no active sync
  | "syncing"       // Currently syncing
  | "uploading"     // Uploading deltas
  | "downloading"   // Downloading deltas
  | "error";        // Error state

/**
 * Cloud sync state for UI display.
 */
export interface CloudSyncState {
  /** Current sync status */
  status: CloudSyncStatus;
  /** Error message if status is "error" */
  error?: string;
  /** Last successful sync timestamp */
  lastSyncedAt?: number;
  /** Number of pending deltas to upload */
  pendingUploads: number;
  /** Number of deltas to download */
  pendingDownloads: number;
  /** Current HEAD commit (if any) */
  headCommit?: string;
  /** Whether a vault encryption key is set */
  hasVaultKey?: boolean;
}

/**
 * Options for creating a commit.
 */
export interface CommitOptions {
  /** Commit message */
  message: string;
  /** Whether to push immediately after committing */
  push?: boolean;
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  /** Whether sync was successful */
  success: boolean;
  /** Number of deltas uploaded */
  deltasUploaded: number;
  /** Number of deltas downloaded */
  deltasDownloaded: number;
  /** Number of blobs uploaded */
  blobsUploaded: number;
  /** Number of blobs downloaded */
  blobsDownloaded: number;
  /** New HEAD commit hash (if changed) */
  newHead?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Delta entry in the cloud storage index.
 */
export interface DeltaIndexEntry {
  /** Delta ID */
  id: string;
  /** Timestamp */
  timestamp: number;
  /** Size in bytes */
  size: number;
}

/**
 * Index of deltas stored in cloud.
 * Cached locally to avoid listing operations.
 */
export interface DeltaIndex {
  /** Version of the index format */
  version: number;
  /** Vault ID */
  vaultId: string;
  /** List of deltas, ordered by timestamp */
  deltas: DeltaIndexEntry[];
  /** When the index was last updated */
  updatedAt: number;
}

// ============================================================================
// Blob Sync Types
// ============================================================================

/**
 * Metadata for a blob stored in cloud.
 */
export interface CloudBlobMeta {
  /** Content hash (SHA-256) */
  hash: string;
  /** Size in bytes (encrypted) */
  size: number;
  /** MIME type */
  mimeType: string;
  /** When uploaded */
  uploadedAt: number;
}

/**
 * Blob index stored in cloud.
 */
export interface BlobIndex {
  /** Index version */
  version: number;
  /** Vault ID */
  vaultId: string;
  /** Map of hash -> metadata */
  blobs: Record<string, CloudBlobMeta>;
  /** When updated */
  updatedAt: number;
}

// ============================================================================
// Conflict Resolution Types
// ============================================================================

/**
 * Conflict detected between local and remote commits.
 */
export interface CloudConflict {
  /** Local HEAD commit */
  localHead: string;
  /** Remote HEAD commit */
  remoteHead: string;
  /** Common ancestor commit (if found) */
  commonAncestor: string | null;
  /** Commits only in local history */
  localOnly: string[];
  /** Commits only in remote history */
  remoteOnly: string[];
}

/**
 * Strategy for resolving conflicts.
 */
export type ConflictResolutionStrategy =
  | "merge"      // Create merge commit combining both
  | "local"      // Keep local changes, discard remote
  | "remote"     // Keep remote changes, discard local
  | "manual";    // Let user decide

/**
 * Result of conflict resolution.
 */
export interface ConflictResolution {
  /** Strategy used */
  strategy: ConflictResolutionStrategy;
  /** New HEAD commit after resolution */
  newHead: string;
  /** Whether changes were lost */
  changesLost: boolean;
}

// ============================================================================
// Progress Types
// ============================================================================

/**
 * Progress of a sync operation.
 */
export interface SyncProgress {
  /** Current phase */
  phase: "preparing" | "downloading" | "uploading" | "finalizing";
  /** Items completed */
  completed: number;
  /** Total items */
  total: number;
  /** Bytes transferred */
  bytesTransferred: number;
  /** Total bytes to transfer */
  bytesTotal: number;
  /** Current item being processed */
  currentItem?: string;
}

/**
 * Progress of a single transfer.
 */
export interface TransferProgress {
  /** Item hash or ID */
  id: string;
  /** Direction */
  direction: "upload" | "download";
  /** Bytes transferred */
  bytesTransferred: number;
  /** Total bytes */
  bytesTotal: number;
  /** Transfer rate in bytes/sec */
  rate: number;
}
