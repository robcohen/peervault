/**
 * Migration System Types
 *
 * Defines interfaces for schema migrations and version tracking.
 */

import type { StorageAdapter } from "../../types";
import type { Logger } from "../../utils/logger";

/**
 * Current schema versions for PeerVault.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Progress callback for long-running migrations.
 */
export type MigrationProgressCallback = (
  percent: number,
  message: string,
) => void;

/**
 * Context provided to migration functions.
 */
export interface MigrationContext {
  /** Storage adapter for reading/writing data */
  storage: StorageAdapter;
  /** Logger instance */
  logger: Logger;
  /** Progress reporting callback */
  onProgress: MigrationProgressCallback;
}

/**
 * A single migration step.
 */
export interface Migration {
  /** Version this migration upgrades FROM */
  fromVersion: number;
  /** Version this migration upgrades TO */
  toVersion: number;
  /** Human-readable description */
  description: string;
  /** Migration function - transforms data from old to new format */
  migrate: (context: MigrationContext) => Promise<void>;
}

/**
 * Result of running migrations.
 */
export interface MigrationResult {
  /** Status of the migration run */
  status: "success" | "failed" | "up-to-date";
  /** Starting version */
  fromVersion: number;
  /** Ending version (after migrations) */
  toVersion: number;
  /** List of migrations that were run */
  migrationsRun: string[];
  /** Error message if status is 'failed' */
  error?: string;
  /** Path to backup created before migration */
  backupKey?: string;
}

/**
 * Storage key for schema version metadata.
 */
export const SCHEMA_VERSION_KEY = "peervault-schema-version";

/**
 * Backup key prefix for pre-migration backups.
 */
export const BACKUP_KEY_PREFIX = "peervault-backup-";
