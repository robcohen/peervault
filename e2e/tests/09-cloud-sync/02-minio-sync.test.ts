/**
 * Cloud Sync Tests - MinIO Integration
 *
 * Tests full cloud sync flow using local MinIO server.
 * Requires: `just minio-start` before running tests.
 * In Docker mode, MinIO runs as a container and is accessible via `minio:9000`.
 */

import type { TestContext } from "../../lib/context";
import {
  assert,
  assertTruthy,
  assertEqual,
} from "../../lib/assertions";
import { isDockerMode } from "../../config";

// MinIO endpoint differs between host (for health check) and container (for plugin)
const MINIO_HOST_ENDPOINT = "http://localhost:9000";  // For health check from test runner
const MINIO_CONTAINER_ENDPOINT = "http://minio:9000"; // For plugin inside container

const MINIO_CONFIG = {
  // In Docker mode, the plugin inside the container uses the Docker network hostname
  endpoint: isDockerMode ? MINIO_CONTAINER_ENDPOINT : MINIO_HOST_ENDPOINT,
  bucket: "peervault-test",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
  region: "us-east-1",
  // MinIO here is plaintext http on a trusted (loopback/docker) network. Opt into
  // insecure http so the non-loopback `minio:9000` container endpoint is accepted.
  allowInsecureHttp: true,
};

// Shared vault key for encryption (derived from passphrase)
const VAULT_KEY_PASSPHRASE = "e2e-test-vault-key-for-cloud-sync";

async function checkMinioRunning(ctx: TestContext): Promise<boolean> {
  try {
    // Always use host endpoint for health check (test runner runs on host)
    const response = await fetch(`${MINIO_HOST_ENDPOINT}/minio/health/live`);
    return response.ok;
  } catch {
    return false;
  }
}

async function configureCloudSync(
  client: TestContext["test"]["client"],
  config: typeof MINIO_CONFIG,
): Promise<boolean> {
  return await client.evaluate<boolean>(`
    (async function() {
      const plugin = window.app?.plugins?.plugins?.["peervault"];
      const cloudSync = plugin?.getCloudSync?.();
      if (!cloudSync) return false;

      const result = await cloudSync.configure(${JSON.stringify(config)});
      return result === true;
    })()
  `);
}

async function setVaultKey(
  client: TestContext["test"]["client"],
  passphrase: string,
): Promise<boolean> {
  return await client.evaluate<boolean>(`
    (async function() {
      const plugin = window.app?.plugins?.plugins?.["peervault"];
      const cloudSync = plugin?.getCloudSync?.();
      if (!cloudSync) return false;

      const encoder = new TextEncoder();
      const data = encoder.encode(${JSON.stringify(passphrase)});
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const keyBytes = new Uint8Array(hashBuffer);

      cloudSync.setVaultKey(keyBytes);
      return true;
    })()
  `);
}

async function disableCloudSync(
  client: TestContext["test"]["client"],
): Promise<void> {
  await client.evaluate<void>(`
    (async function() {
      const plugin = window.app?.plugins?.plugins?.["peervault"];
      const cloudSync = plugin?.getCloudSync?.();
      if (cloudSync) {
        await cloudSync.disable();
      }
    })()
  `);
}

export default [
  {
    name: "Check MinIO is running",
    async fn(ctx: TestContext) {
      const isRunning = await checkMinioRunning(ctx);
      if (!isRunning) {
        console.log("  MinIO not running - skipping cloud sync tests");
        console.log("  Start with: just minio-start (or use Docker E2E)");
        // Mark context to skip remaining tests
        (ctx as any)._skipMinioTests = true;
        return;
      }
      console.log(`  MinIO running at ${MINIO_HOST_ENDPOINT}`);
      console.log(`  Plugin will use: ${MINIO_CONFIG.endpoint}`);
    },
  },

  {
    name: "Configure TEST with MinIO",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      // First disable any existing config
      await disableCloudSync(ctx.test.client);

      const configured = await configureCloudSync(ctx.test.client, MINIO_CONFIG);
      assertTruthy(configured, "TEST should configure with MinIO");

      const keySet = await setVaultKey(ctx.test.client, VAULT_KEY_PASSPHRASE);
      assertTruthy(keySet, "TEST should set vault key");

      const isConfigured = await ctx.test.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          return plugin?.getCloudSync?.()?.isConfigured() ?? false;
        })()
      `);
      assertTruthy(isConfigured, "TEST cloud sync should be configured");
      console.log("  TEST configured with MinIO");
    },
  },

  {
    name: "Configure TEST2 with MinIO",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      await disableCloudSync(ctx.test2.client);

      const configured = await configureCloudSync(ctx.test2.client, MINIO_CONFIG);
      assertTruthy(configured, "TEST2 should configure with MinIO");

      const keySet = await setVaultKey(ctx.test2.client, VAULT_KEY_PASSPHRASE);
      assertTruthy(keySet, "TEST2 should set vault key");

      console.log("  TEST2 configured with MinIO");
    },
  },

  {
    name: "Create commit on TEST",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const commit = await ctx.test.client.evaluate<{ hash: string } | null>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return null;

          const result = await cloudSync.commit("E2E test commit from TEST");
          return result ? { hash: result.hash } : null;
        })()
      `);

      assertTruthy(commit, "Should create commit");
      assertTruthy(commit.hash, "Commit should have hash");
      (ctx as any)._testCommitHash = commit.hash;
      console.log(`  Created commit: ${commit.hash.slice(0, 16)}...`);
    },
  },

  {
    name: "Sync TEST to cloud",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const result = await ctx.test.client.evaluate<{
        success: boolean;
        deltasUploaded: number;
        error?: string;
      }>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return { success: false, deltasUploaded: 0, error: "No cloudSync" };

          return await cloudSync.sync();
        })()
      `);

      assertTruthy(result.success, `Sync should succeed: ${result.error || "unknown error"}`);
      console.log(`  Sync success, deltas uploaded: ${result.deltasUploaded}`);
    },
  },

  {
    name: "TEST has commit in history",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const history = await ctx.test.client.evaluate<Array<{ hash: string }>>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return [];
          return await cloudSync.getCommitHistory();
        })()
      `);

      assert(history.length > 0, "TEST should have commits in history");
      const expectedHash = (ctx as any)._testCommitHash;
      const found = history.some(c => c.hash === expectedHash);
      assertTruthy(found, "TEST history should contain the created commit");
      console.log(`  Commit history: ${history.length} commit(s)`);
    },
  },

  {
    name: "Sync TEST2 from cloud",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const result = await ctx.test2.client.evaluate<{
        success: boolean;
        deltasDownloaded: number;
        newHead?: string;
        error?: string;
      }>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return { success: false, deltasDownloaded: 0, error: "No cloudSync" };

          return await cloudSync.sync();
        })()
      `);

      assertTruthy(result.success, `TEST2 sync should succeed: ${result.error || "unknown error"}`);
      console.log(`  TEST2 sync success, newHead: ${result.newHead?.slice(0, 16) || "none"}...`);
    },
  },

  {
    name: "TEST2 has same commit in history",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const history = await ctx.test2.client.evaluate<Array<{ hash: string }>>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return [];
          return await cloudSync.getCommitHistory();
        })()
      `);

      const expectedHash = (ctx as any)._testCommitHash;
      const found = history.some(c => c.hash === expectedHash);
      assertTruthy(found, "TEST2 should have TEST's commit after sync");
      console.log(`  TEST2 has TEST's commit: confirmed`);
    },
  },

  {
    name: "Create second commit on TEST2",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const commit = await ctx.test2.client.evaluate<{ hash: string } | null>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return null;

          const result = await cloudSync.commit("E2E test commit from TEST2");
          return result ? { hash: result.hash } : null;
        })()
      `);

      assertTruthy(commit, "TEST2 should create commit");
      (ctx as any)._test2CommitHash = commit.hash;
      console.log(`  Created commit: ${commit.hash.slice(0, 16)}...`);
    },
  },

  {
    name: "Sync TEST2 to cloud",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const result = await ctx.test2.client.evaluate<{
        success: boolean;
        error?: string;
      }>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return { success: false, error: "No cloudSync" };

          return await cloudSync.sync();
        })()
      `);

      assertTruthy(result.success, `TEST2 sync should succeed: ${result.error || "unknown error"}`);
      console.log("  TEST2 synced to cloud");
    },
  },

  {
    name: "Sync TEST from cloud gets TEST2 commit",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const result = await ctx.test.client.evaluate<{
        success: boolean;
        newHead?: string;
        error?: string;
      }>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return { success: false, error: "No cloudSync" };

          return await cloudSync.sync();
        })()
      `);

      assertTruthy(result.success, `TEST sync should succeed: ${result.error || "unknown error"}`);

      const history = await ctx.test.client.evaluate<Array<{ hash: string }>>(`
        (async function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          const cloudSync = plugin?.getCloudSync?.();
          if (!cloudSync) return [];
          return await cloudSync.getCommitHistory();
        })()
      `);

      const expectedHash = (ctx as any)._test2CommitHash;
      const found = history.some(c => c.hash === expectedHash);
      assertTruthy(found, "TEST should have TEST2's commit after sync");
      console.log("  TEST synced TEST2's commit from cloud");
    },
  },

  {
    name: "Cloud sync state shows idle after sync",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      const state = await ctx.test.client.evaluate<{
        status: string;
        pendingUploads: number;
        pendingDownloads: number;
        lastSyncedAt?: number;
      }>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          return plugin?.getCloudSync?.()?.getState();
        })()
      `);

      assertEqual(state.status, "idle", "Status should be idle after sync");
      assertEqual(state.pendingUploads, 0, "No pending uploads");
      assertEqual(state.pendingDownloads, 0, "No pending downloads");
      assertTruthy(state.lastSyncedAt, "Should have lastSyncedAt timestamp");
      console.log(`  State: idle, last synced: ${new Date(state.lastSyncedAt!).toISOString()}`);
    },
  },

  {
    name: "Cleanup: Disable cloud sync on both vaults",
    async fn(ctx: TestContext) {
      if ((ctx as any)._skipMinioTests) {
        console.log("  Skipped (MinIO not running)");
        return;
      }

      await disableCloudSync(ctx.test.client);
      await disableCloudSync(ctx.test2.client);

      const test1Configured = await ctx.test.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          return plugin?.getCloudSync?.()?.isConfigured() ?? false;
        })()
      `);

      const test2Configured = await ctx.test2.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          return plugin?.getCloudSync?.()?.isConfigured() ?? false;
        })()
      `);

      assertEqual(test1Configured, false, "TEST cloud sync should be disabled");
      assertEqual(test2Configured, false, "TEST2 cloud sync should be disabled");
      console.log("  Cloud sync disabled on both vaults");
    },
  },
];
