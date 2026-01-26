/**
 * Migration 001: Initialize Schema
 *
 * Sets up the initial schema version for new installations
 * or upgrades from pre-versioned storage.
 */

import type { Migration } from "../types";

/**
 * Initialize schema version tracking.
 *
 * This migration runs on:
 * - New installations (no version stored)
 * - Existing installations before versioning was added
 *
 * It doesn't actually modify data, just establishes version 1.
 */
export const migration001InitializeSchema: Migration = {
  fromVersion: 0,
  toVersion: 1,
  description: "Initialize schema version tracking",

  async migrate(ctx) {
    ctx.onProgress(0, "Checking existing data...");

    // Check if there's existing PeerVault data
    const snapshotKey = "peervault-snapshot";
    const hasSnapshot = await ctx.storage.read(snapshotKey);

    if (hasSnapshot) {
      ctx.onProgress(50, "Existing data found, marking as version 1");
      ctx.logger.info(
        "Migration 001: Found existing data, initializing schema version",
      );
    } else {
      ctx.onProgress(50, "Fresh installation detected");
      ctx.logger.info("Migration 001: Fresh installation");
    }

    ctx.onProgress(100, "Schema initialized");
    // Version will be written by the MigrationRunner after successful migration
  },
};
