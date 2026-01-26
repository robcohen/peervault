/**
 * Migration module exports
 */

export { MigrationRunner } from "./runner";
export {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  BACKUP_KEY_PREFIX,
  type Migration,
  type MigrationContext,
  type MigrationResult,
  type MigrationProgressCallback,
} from "./types";

// Import migrations
import { migration001InitializeSchema } from "./migrations/001-initialize-schema";
import { migration002AddPeerGroups } from "./migrations/002-add-peer-groups";

/**
 * All migrations in order.
 * Add new migrations here as the schema evolves.
 */
export const MIGRATIONS: import("./types").Migration[] = [
  migration001InitializeSchema,
  migration002AddPeerGroups,
];
