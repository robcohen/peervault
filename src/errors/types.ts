/**
 * Error Types
 *
 * Enums and types for the error handling system.
 * Based on spec/09-error-handling.md
 */

/**
 * Error severity levels.
 */
export enum ErrorSeverity {
  /** Informational, operation continues */
  INFO = "info",

  /** Something unexpected, but recovered */
  WARNING = "warning",

  /** Operation failed, but plugin continues */
  ERROR = "error",

  /** Plugin cannot function, requires restart */
  CRITICAL = "critical",
}

/**
 * Error categories for classification.
 */
export enum ErrorCategory {
  /** Network connectivity issues */
  NETWORK = "network",

  /** File system operations */
  STORAGE = "storage",

  /** Loro/CRDT operations */
  SYNC = "sync",

  /** Iroh transport layer */
  TRANSPORT = "transport",

  /** Peer connection/management */
  PEER = "peer",

  /** Plugin configuration */
  CONFIG = "config",

  /** Obsidian API issues */
  PLATFORM = "platform",
}

/**
 * Error context with additional debugging info.
 */
export interface ErrorContext {
  [key: string]: unknown;
}
