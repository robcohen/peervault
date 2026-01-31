/**
 * PeerVault Error Handling
 *
 * Exports all error types and factory functions.
 */

export { ErrorSeverity, ErrorCategory, type ErrorContext } from "./types";

export { PeerVaultError } from "./base";

export {
  NetworkErrors,
  StorageErrors,
  SyncErrors,
  TransportErrors,
  PeerErrors,
  ConfigErrors,
  PlatformErrors,
  WebRTCErrors,
} from "./catalog";
