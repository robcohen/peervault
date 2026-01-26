/**
 * Migration System Tests
 *
 * Tests for the schema migration runner.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { MigrationRunner } from '../src/core/migration/runner';
import { MemoryStorageAdapter } from '../src/core/storage-adapter';
import { SCHEMA_VERSION_KEY, type Migration } from '../src/core/migration/types';
import type { Logger } from '../src/utils/logger';

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('MigrationRunner', () => {
  let storage: MemoryStorageAdapter;
  let logger: Logger;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    logger = createTestLogger();
  });

  describe('Fresh Install', () => {
    it('should run all migrations on fresh install', async () => {
      const migrations: Migration[] = [
        {
          fromVersion: 0,
          toVersion: 1,
          description: 'Init',
          migrate: async () => {},
        },
        {
          fromVersion: 1,
          toVersion: 2,
          description: 'Upgrade',
          migrate: async () => {},
        },
      ];

      const runner = new MigrationRunner(storage, migrations, logger);
      const result = await runner.run();

      expect(result.status).toBe('success');
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(2);
      expect(result.migrationsRun).toEqual(['v0→v1: Init', 'v1→v2: Upgrade']);
    });

    it('should set schema version after migration', async () => {
      const migrations: Migration[] = [
        {
          fromVersion: 0,
          toVersion: 1,
          description: 'Init',
          migrate: async () => {},
        },
        {
          fromVersion: 1,
          toVersion: 2,
          description: 'Upgrade',
          migrate: async () => {},
        },
      ];

      const runner = new MigrationRunner(storage, migrations, logger);
      await runner.run();

      const versionData = await storage.read(SCHEMA_VERSION_KEY);
      expect(versionData).toBeDefined();

      const version = JSON.parse(new TextDecoder().decode(versionData!));
      expect(version.version).toBe(2);
    });
  });

  describe('Existing Install', () => {
    it('should skip migrations for up-to-date schema', async () => {
      // Set existing version
      await storage.write(
        SCHEMA_VERSION_KEY,
        new TextEncoder().encode(JSON.stringify({ version: 2 }))
      );

      const migrations: Migration[] = [
        {
          fromVersion: 0,
          toVersion: 1,
          description: 'Init',
          migrate: async () => {},
        },
        {
          fromVersion: 1,
          toVersion: 2,
          description: 'Upgrade',
          migrate: async () => {},
        },
      ];

      const runner = new MigrationRunner(storage, migrations, logger);
      const result = await runner.run();

      expect(result.status).toBe('up-to-date');
      expect(result.migrationsRun).toEqual([]);
    });

    it('should run only needed migrations', async () => {
      // Set existing version to 1
      await storage.write(
        SCHEMA_VERSION_KEY,
        new TextEncoder().encode(JSON.stringify({ version: 1 }))
      );

      let migration1Ran = false;
      let migration2Ran = false;

      const migrations: Migration[] = [
        {
          fromVersion: 0,
          toVersion: 1,
          description: 'Init',
          migrate: async () => {
            migration1Ran = true;
          },
        },
        {
          fromVersion: 1,
          toVersion: 2,
          description: 'Upgrade',
          migrate: async () => {
            migration2Ran = true;
          },
        },
      ];

      const runner = new MigrationRunner(storage, migrations, logger);
      const result = await runner.run();

      expect(result.status).toBe('success');
      expect(migration1Ran).toBe(false);
      expect(migration2Ran).toBe(true);
      expect(result.migrationsRun).toEqual(['v1→v2: Upgrade']);
    });
  });

  describe('Migration Path', () => {
    it('should find correct migration path', async () => {
      const executionOrder: string[] = [];

      // Note: CURRENT_SCHEMA_VERSION is 2, so we test up to v2
      const migrations: Migration[] = [
        {
          fromVersion: 0,
          toVersion: 1,
          description: 'Step 1',
          migrate: async () => {
            executionOrder.push('1');
          },
        },
        {
          fromVersion: 1,
          toVersion: 2,
          description: 'Step 2',
          migrate: async () => {
            executionOrder.push('2');
          },
        },
      ];

      const runner = new MigrationRunner(storage, migrations, logger);
      await runner.run();

      expect(executionOrder).toEqual(['1', '2']);
    });
  });

  describe('Progress Callback', () => {
    it('should report progress during migration', async () => {
      const progressReports: Array<{ percent: number; message: string }> = [];

      const migrations: Migration[] = [
        {
          fromVersion: 0,
          toVersion: 1,
          description: 'Step1',
          migrate: async (ctx) => {
            ctx.onProgress(50, 'Halfway');
            ctx.onProgress(100, 'Done');
          },
        },
        {
          fromVersion: 1,
          toVersion: 2,
          description: 'Step2',
          migrate: async () => {},
        },
      ];

      const runner = new MigrationRunner(storage, migrations, logger);
      await runner.run((percent, message) => {
        progressReports.push({ percent, message });
      });

      // Progress reports include backup creation and migration progress
      expect(progressReports.length).toBeGreaterThan(0);
      // Check for backup message or running message
      expect(progressReports.some((r) =>
        r.message.includes('backup') || r.message.includes('Running') || r.message === 'Halfway'
      )).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should return failed status on error', async () => {
      const migrations: Migration[] = [
        {
          fromVersion: 0,
          toVersion: 1,
          description: 'Init',
          migrate: async () => {},
        },
        {
          fromVersion: 1,
          toVersion: 2,
          description: 'Failing',
          migrate: async () => {
            throw new Error('Migration failed');
          },
        },
      ];

      const runner = new MigrationRunner(storage, migrations, logger);
      const result = await runner.run();

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Migration failed');
    });
  });
});
