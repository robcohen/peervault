/**
 * Error Catalog
 *
 * Factory functions for creating standardized errors.
 * Based on spec/09-error-handling.md
 */

import { PeerVaultError } from "./base";
import { ErrorSeverity, ErrorCategory } from "./types";

/**
 * Network-related errors.
 */
export const NetworkErrors = {
  offline: () =>
    new PeerVaultError(
      "Device is offline",
      "NET_OFFLINE",
      ErrorCategory.NETWORK,
      ErrorSeverity.WARNING,
      true,
    ),

  timeout: (host: string, timeoutMs: number) =>
    new PeerVaultError(
      `Connection to ${host} timed out after ${timeoutMs}ms`,
      "NET_TIMEOUT",
      ErrorCategory.NETWORK,
      ErrorSeverity.ERROR,
      true,
      { host, timeoutMs },
    ),

  relayUnreachable: (relayUrl: string) =>
    new PeerVaultError(
      `Cannot reach relay server: ${relayUrl}`,
      "NET_RELAY_UNREACHABLE",
      ErrorCategory.NETWORK,
      ErrorSeverity.ERROR,
      true,
      { relayUrl },
    ),

  holePunchFailed: (peerId: string) =>
    new PeerVaultError(
      `NAT traversal failed for peer ${peerId}`,
      "NET_HOLE_PUNCH_FAILED",
      ErrorCategory.NETWORK,
      ErrorSeverity.WARNING,
      true,
      { peerId },
    ),
};

/**
 * Storage-related errors.
 */
export const StorageErrors = {
  diskFull: (path: string) =>
    new PeerVaultError(
      "Cannot save document: disk is full",
      "STOR_DISK_FULL",
      ErrorCategory.STORAGE,
      ErrorSeverity.CRITICAL,
      false,
      { path },
    ),

  permissionDenied: (path: string) =>
    new PeerVaultError(
      `Permission denied: ${path}`,
      "STOR_PERMISSION",
      ErrorCategory.STORAGE,
      ErrorSeverity.CRITICAL,
      false,
      { path },
    ),

  corrupt: (docId: string, details: string) =>
    new PeerVaultError(
      `Document ${docId} is corrupted: ${details}`,
      "STOR_CORRUPT",
      ErrorCategory.STORAGE,
      ErrorSeverity.ERROR,
      true, // Can recover from peers
      { docId, details },
    ),

  notFound: (path: string) =>
    new PeerVaultError(
      `File not found: ${path}`,
      "STOR_NOT_FOUND",
      ErrorCategory.STORAGE,
      ErrorSeverity.WARNING,
      true,
      { path },
    ),

  writeFailed: (path: string, reason: string) =>
    new PeerVaultError(
      `Failed to write file ${path}: ${reason}`,
      "STOR_WRITE_FAILED",
      ErrorCategory.STORAGE,
      ErrorSeverity.ERROR,
      true,
      { path, reason },
    ),

  readFailed: (path: string, reason: string) =>
    new PeerVaultError(
      `Failed to read file ${path}: ${reason}`,
      "STOR_READ_FAILED",
      ErrorCategory.STORAGE,
      ErrorSeverity.ERROR,
      true,
      { path, reason },
    ),
};

/**
 * Sync-related errors.
 */
export const SyncErrors = {
  vaultMismatch: (localId: string, remoteId: string) =>
    new PeerVaultError(
      "Cannot sync: vault IDs do not match",
      "SYNC_VAULT_MISMATCH",
      ErrorCategory.SYNC,
      ErrorSeverity.ERROR,
      false,
      { localId, remoteId },
    ),

  docTooLarge: (path: string, sizeBytes: number, limitBytes: number) =>
    new PeerVaultError(
      `File ${path} exceeds sync size limit`,
      "SYNC_DOC_TOO_LARGE",
      ErrorCategory.SYNC,
      ErrorSeverity.WARNING,
      false,
      { path, sizeBytes, limitBytes },
    ),

  versionConflict: (path: string) =>
    new PeerVaultError(
      `Version conflict on ${path}`,
      "SYNC_VERSION_CONFLICT",
      ErrorCategory.SYNC,
      ErrorSeverity.WARNING,
      true, // CRDT auto-merges
      { path },
    ),

  protocolError: (details: string) =>
    new PeerVaultError(
      `Sync protocol error: ${details}`,
      "SYNC_PROTOCOL_ERROR",
      ErrorCategory.SYNC,
      ErrorSeverity.ERROR,
      true,
      { details },
    ),

  errorLimit: (errorCount: number) =>
    new PeerVaultError(
      "Too many sync errors, stopping sync",
      "SYNC_ERROR_LIMIT",
      ErrorCategory.SYNC,
      ErrorSeverity.ERROR,
      false,
      { errorCount },
    ),

  invalidMessage: (messageType: number) =>
    new PeerVaultError(
      `Invalid sync message type: ${messageType}`,
      "SYNC_INVALID_MESSAGE",
      ErrorCategory.SYNC,
      ErrorSeverity.ERROR,
      true,
      { messageType },
    ),
};

/**
 * Transport-related errors.
 */
export const TransportErrors = {
  wasmLoadFailed: (details: string) =>
    new PeerVaultError(
      `Failed to load Iroh WASM module: ${details}`,
      "TRANSPORT_WASM_LOAD",
      ErrorCategory.TRANSPORT,
      ErrorSeverity.CRITICAL,
      false,
      { details },
    ),

  notInitialized: () =>
    new PeerVaultError(
      "Transport not initialized",
      "TRANSPORT_NOT_INIT",
      ErrorCategory.TRANSPORT,
      ErrorSeverity.ERROR,
      true,
    ),

  connectionFailed: (peerId: string, reason: string) =>
    new PeerVaultError(
      `Failed to connect to peer ${peerId}: ${reason}`,
      "TRANSPORT_CONN_FAILED",
      ErrorCategory.TRANSPORT,
      ErrorSeverity.ERROR,
      true,
      { peerId, reason },
    ),

  streamClosed: (streamId: string) =>
    new PeerVaultError(
      `Stream ${streamId} was closed unexpectedly`,
      "TRANSPORT_STREAM_CLOSED",
      ErrorCategory.TRANSPORT,
      ErrorSeverity.WARNING,
      true,
      { streamId },
    ),

  invalidTicket: (ticket: string) =>
    new PeerVaultError(
      "Invalid connection ticket",
      "TRANSPORT_INVALID_TICKET",
      ErrorCategory.TRANSPORT,
      ErrorSeverity.ERROR,
      false,
      { ticketPrefix: ticket.slice(0, 20) + "..." },
    ),
};

/**
 * Peer-related errors.
 */
export const PeerErrors = {
  unknownPeer: (nodeId: string) =>
    new PeerVaultError(
      `Unknown peer: ${nodeId}`,
      "PEER_UNKNOWN",
      ErrorCategory.PEER,
      ErrorSeverity.WARNING,
      false,
      { nodeId },
    ),

  untrustedPeer: (nodeId: string) =>
    new PeerVaultError(
      `Untrusted peer: ${nodeId}`,
      "PEER_UNTRUSTED",
      ErrorCategory.PEER,
      ErrorSeverity.WARNING,
      false,
      { nodeId },
    ),

  disconnected: (nodeId: string, reason?: string) =>
    new PeerVaultError(
      `Peer ${nodeId} disconnected${reason ? `: ${reason}` : ""}`,
      "PEER_DISCONNECTED",
      ErrorCategory.PEER,
      ErrorSeverity.INFO,
      true,
      { nodeId, reason },
    ),

  notFound: (nodeId: string) =>
    new PeerVaultError(
      `Peer not found: ${nodeId}`,
      "PEER_NOT_FOUND",
      ErrorCategory.PEER,
      ErrorSeverity.ERROR,
      false,
      { nodeId },
    ),

  groupNotFound: (groupId: string) =>
    new PeerVaultError(
      `Peer group not found: ${groupId}`,
      "PEER_GROUP_NOT_FOUND",
      ErrorCategory.PEER,
      ErrorSeverity.ERROR,
      false,
      { groupId },
    ),
};

/**
 * Configuration-related errors.
 */
export const ConfigErrors = {
  invalid: (field: string, reason: string) =>
    new PeerVaultError(
      `Invalid configuration: ${field} - ${reason}`,
      "CONFIG_INVALID",
      ErrorCategory.CONFIG,
      ErrorSeverity.ERROR,
      false,
      { field, reason },
    ),

  migrationFailed: (fromVersion: number, toVersion: number, reason: string) =>
    new PeerVaultError(
      `Configuration migration failed from v${fromVersion} to v${toVersion}: ${reason}`,
      "CONFIG_MIGRATION_FAILED",
      ErrorCategory.CONFIG,
      ErrorSeverity.CRITICAL,
      false,
      { fromVersion, toVersion, reason },
    ),
};

/**
 * Platform-related errors (Obsidian API issues).
 */
export const PlatformErrors = {
  apiUnavailable: (apiName: string) =>
    new PeerVaultError(
      `Obsidian API unavailable: ${apiName}`,
      "PLATFORM_API_UNAVAILABLE",
      ErrorCategory.PLATFORM,
      ErrorSeverity.CRITICAL,
      false,
      { apiName },
    ),

  vaultNotLoaded: () =>
    new PeerVaultError(
      "Obsidian vault not loaded",
      "PLATFORM_VAULT_NOT_LOADED",
      ErrorCategory.PLATFORM,
      ErrorSeverity.CRITICAL,
      false,
    ),

  pluginConflict: (pluginId: string) =>
    new PeerVaultError(
      `Conflict with plugin: ${pluginId}`,
      "PLATFORM_PLUGIN_CONFLICT",
      ErrorCategory.PLATFORM,
      ErrorSeverity.WARNING,
      false,
      { pluginId },
    ),
};
