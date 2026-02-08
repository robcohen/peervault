/**
 * Migration 002: Add Peer Groups (REMOVED)
 *
 * This migration was for peer groups which have been removed.
 * Now it strips any legacy groupIds from stored peers.
 */

import type { Migration } from "../types";

const PEERS_STORAGE_KEY = "peervault-peers";

/**
 * Interface for stored peer info.
 */
interface StoredPeerInfo {
  nodeId: string;
  name?: string;
  ticket?: string;
  firstSeen: number;
  lastSynced?: number;
  lastSeen?: number;
  trusted: boolean;
  groupIds?: string[]; // Legacy field - will be stripped
}

/**
 * Migration that strips legacy groupIds from stored peers.
 * Groups feature was removed - all peers now sync with the entire vault.
 */
export const migration002AddPeerGroups: Migration = {
  fromVersion: 1,
  toVersion: 2,
  description: "Remove peer groups (feature removed)",

  async migrate(ctx) {
    ctx.onProgress(0, "Reading stored peers...");

    // Read existing peers
    const peersData = await ctx.storage.read(PEERS_STORAGE_KEY);

    if (!peersData) {
      ctx.onProgress(100, "No peers to migrate");
      ctx.logger.info("Migration 002: No stored peers found");
      return;
    }

    ctx.onProgress(25, "Parsing peer data...");

    try {
      const peers: StoredPeerInfo[] = JSON.parse(
        new TextDecoder().decode(peersData),
      );

      ctx.onProgress(50, `Cleaning up ${peers.length} peers...`);

      // Strip groupIds from each peer (legacy field)
      const updatedPeers = peers.map((peer) => {
        const { groupIds: _removed, ...rest } = peer;
        return rest;
      });

      ctx.onProgress(75, "Saving updated peers...");

      // Write back
      const updatedData = new TextEncoder().encode(
        JSON.stringify(updatedPeers),
      );
      await ctx.storage.write(PEERS_STORAGE_KEY, updatedData);

      ctx.logger.info(
        `Migration 002: Cleaned up ${peers.length} peers (removed groupIds)`,
      );
      ctx.onProgress(100, "Migration complete");
    } catch (error) {
      // Non-fatal - just log and continue
      ctx.logger.warn("Migration 002: Failed to clean up peers", error);
      ctx.onProgress(100, "Migration complete (with warnings)");
    }
  },
};
