/**
 * Migration 002: Add Peer Groups
 *
 * Adds the peer groups structure to the Loro document
 * and updates stored peers to include groupIds.
 */

import type { Migration } from "../types";
import { DEFAULT_GROUP_ID } from "../../../peer/groups";

const PEERS_STORAGE_KEY = "peervault-peers";

/**
 * Interface for stored peer info (pre-migration).
 */
interface LegacyStoredPeerInfo {
  nodeId: string;
  name?: string;
  ticket?: string;
  firstSeen: number;
  lastSynced?: number;
  lastSeen?: number;
  trusted: boolean;
}

/**
 * Interface for stored peer info (post-migration).
 */
interface UpdatedStoredPeerInfo extends LegacyStoredPeerInfo {
  groupIds?: string[];
}

/**
 * Add peer groups support to the schema.
 *
 * This migration:
 * 1. Updates stored peers to include groupIds (defaulting to 'default' group)
 *
 * Note: The Loro document 'groups' map is created automatically by
 * PeerGroupManager when it initializes, so we only need to update
 * the peer storage here.
 */
export const migration002AddPeerGroups: Migration = {
  fromVersion: 1,
  toVersion: 2,
  description: "Add peer groups support",

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
      const peers: LegacyStoredPeerInfo[] = JSON.parse(
        new TextDecoder().decode(peersData),
      );

      ctx.onProgress(50, `Updating ${peers.length} peers...`);

      // Add groupIds to each peer
      const updatedPeers: UpdatedStoredPeerInfo[] = peers.map((peer) => ({
        ...peer,
        groupIds: [DEFAULT_GROUP_ID], // Add to default group
      }));

      ctx.onProgress(75, "Saving updated peers...");

      // Write back
      const updatedData = new TextEncoder().encode(
        JSON.stringify(updatedPeers),
      );
      await ctx.storage.write(PEERS_STORAGE_KEY, updatedData);

      ctx.logger.info(
        `Migration 002: Updated ${peers.length} peers with group IDs`,
      );
      ctx.onProgress(100, "Peer groups migration complete");
    } catch (error) {
      ctx.logger.error("Migration 002: Failed to parse/update peers", error);
      throw new Error(`Failed to migrate peers: ${error}`);
    }
  },
};
