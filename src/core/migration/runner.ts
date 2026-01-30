/**
 * Migration Runner
 *
 * Handles running schema migrations with backup and rollback support.
 */

import type { StorageAdapter } from "../../types";
import type { Logger } from "../../utils/logger";
import type {
  Migration,
  MigrationContext,
  MigrationResult,
  MigrationProgressCallback,
} from "./types";
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  BACKUP_KEY_PREFIX,
} from "./types";

/**
 * Schema version stored in storage.
 */
interface StoredSchemaVersion {
  version: number;
  updatedAt: number;
  migrationsRun: string[];
}

/**
 * MigrationRunner handles schema migrations for PeerVault.
 *
 * Features:
 * - Automatic migration path finding
 * - Pre-migration backup
 * - Progress reporting
 * - Version tracking
 */
export class MigrationRunner {
  constructor(
    private storage: StorageAdapter,
    private migrations: Migration[],
    private logger: Logger,
  ) {}

  /**
   * Run all necessary migrations to reach the current schema version.
   */
  async run(onProgress?: MigrationProgressCallback): Promise<MigrationResult> {
    const progress = onProgress ?? (() => {});
    const currentVersion = await this.getStoredVersion();

    this.logger.info(
      `Current schema version: ${currentVersion}, target: ${CURRENT_SCHEMA_VERSION}`,
    );

    // Already up to date
    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      return {
        status: "up-to-date",
        fromVersion: currentVersion,
        toVersion: currentVersion,
        migrationsRun: [],
      };
    }

    // Find migration path
    const migrationPath = this.findMigrationPath(
      currentVersion,
      CURRENT_SCHEMA_VERSION,
    );
    if (!migrationPath || migrationPath.length === 0) {
      // No migrations needed or found
      if (currentVersion === 0) {
        // Fresh install - just set the version
        await this.setStoredVersion(CURRENT_SCHEMA_VERSION, []);
        return {
          status: "success",
          fromVersion: 0,
          toVersion: CURRENT_SCHEMA_VERSION,
          migrationsRun: [],
        };
      }

      return {
        status: "failed",
        fromVersion: currentVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        migrationsRun: [],
        error: `No migration path found from v${currentVersion} to v${CURRENT_SCHEMA_VERSION}`,
      };
    }

    // Create backup before migrations
    progress(0, "Creating backup...");
    const backupKey = await this.createBackup(currentVersion);
    this.logger.info(`Created backup: ${backupKey}`);

    // Run migrations
    const migrationsRun: string[] = [];
    const context: MigrationContext = {
      storage: this.storage,
      logger: this.logger,
      onProgress: (percent, msg) => {
        // Scale progress across all migrations
        const migrationIndex = migrationsRun.length;
        const overallPercent =
          ((migrationIndex + percent / 100) / migrationPath.length) * 100;
        progress(overallPercent, msg);
      },
    };

    try {
      for (let i = 0; i < migrationPath.length; i++) {
        const migration = migrationPath[i]!;
        const migrationDesc = `v${migration.fromVersion}→v${migration.toVersion}: ${migration.description}`;

        this.logger.info(`Running migration: ${migrationDesc}`);
        progress(
          (i / migrationPath.length) * 100,
          `Running: ${migration.description}`,
        );

        await migration.migrate(context);

        migrationsRun.push(migrationDesc);
        this.logger.info(`Completed migration: ${migrationDesc}`);
      }

      // Update stored version
      await this.setStoredVersion(CURRENT_SCHEMA_VERSION, migrationsRun);

      progress(100, "Migrations complete");

      return {
        status: "success",
        fromVersion: currentVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        migrationsRun,
        backupKey,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Migration failed: ${errorMessage}`);

      return {
        status: "failed",
        fromVersion: currentVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        migrationsRun,
        error: errorMessage,
        backupKey,
      };
    }
  }

  /**
   * Find a sequence of migrations to get from one version to another.
   */
  private findMigrationPath(from: number, to: number): Migration[] | null {
    if (from >= to) return [];

    // Simple linear search for now - could be optimized with graph search
    const path: Migration[] = [];
    let current = from;

    while (current < to) {
      const next = this.migrations.find((m) => m.fromVersion === current);
      if (!next) {
        // No migration from current version
        return null;
      }
      path.push(next);
      current = next.toVersion;
    }

    return path;
  }

  /**
   * Get the currently stored schema version.
   * @throws Error if storage read fails (not for missing key)
   */
  private async getStoredVersion(): Promise<number> {
    const data = await this.storage.read(SCHEMA_VERSION_KEY);
    if (!data) return 0; // Fresh install - key doesn't exist

    try {
      const json = new TextDecoder().decode(data);
      const stored: StoredSchemaVersion = JSON.parse(json);
      if (typeof stored.version !== "number" || stored.version < 0) {
        this.logger.warn("Invalid schema version stored, treating as fresh install");
        return 0;
      }
      return stored.version;
    } catch (parseError) {
      // JSON parse error - data is corrupted
      this.logger.error("Failed to parse schema version, treating as fresh install:", parseError);
      return 0;
    }
  }

  /**
   * Store the current schema version.
   */
  private async setStoredVersion(
    version: number,
    migrationsRun: string[],
  ): Promise<void> {
    const stored: StoredSchemaVersion = {
      version,
      updatedAt: Date.now(),
      migrationsRun,
    };

    const json = JSON.stringify(stored, null, 2);
    const data = new TextEncoder().encode(json);
    await this.storage.write(SCHEMA_VERSION_KEY, data);
  }

  /**
   * Create a backup of important data before migrations.
   */
  private async createBackup(version: number): Promise<string> {
    const timestamp = Date.now();
    const backupKey = `${BACKUP_KEY_PREFIX}v${version}-${timestamp}`;

    // Backup the main snapshot if it exists
    const snapshotKey = "peervault-snapshot";
    const snapshot = await this.storage.read(snapshotKey);

    if (snapshot) {
      await this.storage.write(`${backupKey}-snapshot`, snapshot);
    }

    // Store backup metadata
    const backupMeta = {
      version,
      timestamp,
      snapshotBackedUp: !!snapshot,
    };
    const metaJson = JSON.stringify(backupMeta, null, 2);
    await this.storage.write(
      `${backupKey}-meta`,
      new TextEncoder().encode(metaJson),
    );

    return backupKey;
  }

  /**
   * Restore from a backup (manual recovery).
   */
  async restoreFromBackup(backupKey: string): Promise<boolean> {
    try {
      // Read backup metadata
      const metaData = await this.storage.read(`${backupKey}-meta`);
      if (!metaData) {
        this.logger.error(`Backup not found: ${backupKey}`);
        return false;
      }

      const meta = JSON.parse(new TextDecoder().decode(metaData));
      this.logger.info(
        `Restoring backup from v${meta.version}, created ${new Date(meta.timestamp).toISOString()}`,
      );

      // Restore snapshot
      if (meta.snapshotBackedUp) {
        const snapshot = await this.storage.read(`${backupKey}-snapshot`);
        if (snapshot) {
          await this.storage.write("peervault-snapshot", snapshot);
          this.logger.info("Restored snapshot");
        }
      }

      // Reset version to backup version
      await this.setStoredVersion(meta.version, []);

      return true;
    } catch (error) {
      this.logger.error("Failed to restore backup:", error);
      return false;
    }
  }

  /**
   * List available backups.
   */
  async listBackups(): Promise<
    Array<{ key: string; version: number; timestamp: number }>
  > {
    const keys = await this.storage.list(BACKUP_KEY_PREFIX);
    const metaKeys = keys.filter((k) => k.endsWith("-meta"));

    const backups: Array<{ key: string; version: number; timestamp: number }> =
      [];

    for (const metaKey of metaKeys) {
      try {
        const data = await this.storage.read(metaKey);
        if (data) {
          const meta = JSON.parse(new TextDecoder().decode(data));
          const key = metaKey.replace("-meta", "");
          backups.push({
            key,
            version: meta.version,
            timestamp: meta.timestamp,
          });
        }
      } catch {
        // Skip invalid backups
      }
    }

    return backups.sort((a, b) => b.timestamp - a.timestamp);
  }
}
