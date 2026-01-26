/**
 * Peer Group Manager
 *
 * Manages peer groups and their sync policies.
 * Groups are stored in the Loro document for cross-device sync.
 */

import type { LoroDoc, LoroMap, LoroList } from "loro-crdt";
import type { Logger } from "../../utils/logger";
import { EventEmitter } from "../../utils/events";
import type { PeerGroup, GroupSyncPolicy, PeerGroupEvents } from "./types";
import { DEFAULT_GROUP_ID, DEFAULT_GROUP, DEFAULT_SYNC_POLICY } from "./types";

/**
 * PeerGroupManager handles peer group CRUD and policy enforcement.
 *
 * Groups are stored in the Loro document under the 'groups' map,
 * which means they sync across devices automatically.
 */
export class PeerGroupManager extends EventEmitter<PeerGroupEvents> {
  private groupsMap: LoroMap;

  constructor(
    private doc: LoroDoc,
    private logger: Logger,
  ) {
    super();
    this.groupsMap = this.doc.getMap("groups");
    this.ensureDefaultGroup();
  }

  /**
   * Ensure the default group exists.
   */
  private ensureDefaultGroup(): void {
    if (!this.groupsMap.get(DEFAULT_GROUP_ID)) {
      this.logger.debug("Creating default peer group");
      this.createGroupInternal({
        ...DEFAULT_GROUP,
        createdAt: Date.now(),
      });
    }
  }

  /**
   * Get all peer groups.
   */
  getGroups(): PeerGroup[] {
    const groups: PeerGroup[] = [];

    // Iterate over group IDs in the map
    const entries = this.groupsMap.toJSON() as Record<string, unknown>;
    for (const [id, data] of Object.entries(entries)) {
      if (typeof data === "object" && data !== null) {
        const group = this.parseGroup(id, data as Record<string, unknown>);
        if (group) {
          groups.push(group);
        }
      }
    }

    // Sort by priority (highest first), then by name
    return groups.sort((a, b) => {
      if (b.syncPolicy.priority !== a.syncPolicy.priority) {
        return b.syncPolicy.priority - a.syncPolicy.priority;
      }
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get a specific group by ID.
   */
  getGroup(groupId: string): PeerGroup | undefined {
    const data = this.groupsMap.get(groupId);
    if (!data || typeof data !== "object") return undefined;

    // For nested LoroMap, convert to JSON
    const json =
      data instanceof Object && "toJSON" in data
        ? (data as { toJSON(): unknown }).toJSON()
        : data;

    return this.parseGroup(groupId, json as Record<string, unknown>);
  }

  /**
   * Get all groups that a peer belongs to.
   */
  getGroupsForPeer(peerId: string): PeerGroup[] {
    return this.getGroups().filter((g) => g.peerIds.includes(peerId));
  }

  /**
   * Get the effective sync policy for a peer.
   * Merges policies from all groups the peer belongs to.
   *
   * Merge rules:
   * - excludedFolders: UNION of all groups
   * - readOnly: true if ANY group is read-only
   * - autoConnect: true only if ALL groups allow
   * - priority: MAX across groups
   */
  getEffectiveSyncPolicy(peerId: string): GroupSyncPolicy {
    const groups = this.getGroupsForPeer(peerId);

    // If peer is in no groups, use default group policy
    if (groups.length === 0) {
      const defaultGroup = this.getGroup(DEFAULT_GROUP_ID);
      return defaultGroup?.syncPolicy ?? DEFAULT_SYNC_POLICY;
    }

    // Merge policies
    const excludedFolders = new Set<string>();
    let readOnly = false;
    let autoConnect = true;
    let maxPriority = 0;

    for (const group of groups) {
      const policy = group.syncPolicy;

      // Union of excluded folders
      for (const folder of policy.excludedFolders) {
        excludedFolders.add(folder);
      }

      // OR for readOnly
      if (policy.readOnly) {
        readOnly = true;
      }

      // AND for autoConnect
      if (!policy.autoConnect) {
        autoConnect = false;
      }

      // MAX for priority
      if (policy.priority > maxPriority) {
        maxPriority = policy.priority;
      }
    }

    return {
      excludedFolders: Array.from(excludedFolders),
      readOnly,
      autoConnect,
      priority: maxPriority,
    };
  }

  /**
   * Create a new peer group.
   */
  createGroup(
    name: string,
    icon: string = "📁",
    color: string = "#6c6c6c",
  ): PeerGroup {
    const id = crypto.randomUUID();
    const group: PeerGroup = {
      id,
      name,
      icon,
      color,
      peerIds: [],
      syncPolicy: { ...DEFAULT_SYNC_POLICY },
      createdAt: Date.now(),
    };

    this.createGroupInternal(group);
    this.doc.commit();

    this.logger.info("Created peer group:", name, id);
    this.emit("group:created", group);

    return group;
  }

  /**
   * Internal method to create a group in the Loro map.
   */
  private createGroupInternal(group: PeerGroup): void {
    const groupMap = this.groupsMap.setContainer(
      group.id,
      new (this.doc.getMap("_tmp").constructor as typeof LoroMap)(),
    ) as LoroMap;

    groupMap.set("name", group.name);
    groupMap.set("icon", group.icon);
    groupMap.set("color", group.color);
    groupMap.set("createdAt", group.createdAt);
    groupMap.set("readOnly", group.syncPolicy.readOnly);
    groupMap.set("autoConnect", group.syncPolicy.autoConnect);
    groupMap.set("priority", group.syncPolicy.priority);

    // Store arrays as JSON strings for simplicity
    groupMap.set("peerIds", JSON.stringify(group.peerIds));
    groupMap.set(
      "excludedFolders",
      JSON.stringify(group.syncPolicy.excludedFolders),
    );
  }

  /**
   * Update a peer group.
   */
  updateGroup(
    groupId: string,
    updates: Partial<Omit<PeerGroup, "id" | "createdAt">>,
  ): void {
    const groupMap = this.groupsMap.get(groupId) as LoroMap | undefined;
    if (!groupMap) {
      throw new Error(`Group not found: ${groupId}`);
    }

    if (updates.name !== undefined) {
      groupMap.set("name", updates.name);
    }
    if (updates.icon !== undefined) {
      groupMap.set("icon", updates.icon);
    }
    if (updates.color !== undefined) {
      groupMap.set("color", updates.color);
    }
    if (updates.peerIds !== undefined) {
      groupMap.set("peerIds", JSON.stringify(updates.peerIds));
    }
    if (updates.syncPolicy !== undefined) {
      groupMap.set("readOnly", updates.syncPolicy.readOnly);
      groupMap.set("autoConnect", updates.syncPolicy.autoConnect);
      groupMap.set("priority", updates.syncPolicy.priority);
      groupMap.set(
        "excludedFolders",
        JSON.stringify(updates.syncPolicy.excludedFolders),
      );
    }

    this.doc.commit();

    const group = this.getGroup(groupId);
    if (group) {
      this.logger.info("Updated peer group:", group.name);
      this.emit("group:updated", group);
    }
  }

  /**
   * Delete a peer group.
   * Cannot delete the default group.
   */
  deleteGroup(groupId: string): void {
    if (groupId === DEFAULT_GROUP_ID) {
      throw new Error("Cannot delete the default group");
    }

    const group = this.getGroup(groupId);
    if (!group) {
      throw new Error(`Group not found: ${groupId}`);
    }

    this.groupsMap.delete(groupId);
    this.doc.commit();

    this.logger.info("Deleted peer group:", group.name);
    this.emit("group:deleted", groupId);
  }

  /**
   * Add a peer to a group.
   */
  addPeerToGroup(groupId: string, peerId: string): void {
    const group = this.getGroup(groupId);
    if (!group) {
      throw new Error(`Group not found: ${groupId}`);
    }

    if (group.peerIds.includes(peerId)) {
      return; // Already in group
    }

    const newPeerIds = [...group.peerIds, peerId];
    this.updateGroup(groupId, { peerIds: newPeerIds });

    this.logger.debug("Added peer to group:", peerId, groupId);
    this.emit("peer:added-to-group", { groupId, peerId });
  }

  /**
   * Remove a peer from a group.
   */
  removePeerFromGroup(groupId: string, peerId: string): void {
    const group = this.getGroup(groupId);
    if (!group) {
      throw new Error(`Group not found: ${groupId}`);
    }

    const newPeerIds = group.peerIds.filter((id) => id !== peerId);
    if (newPeerIds.length === group.peerIds.length) {
      return; // Wasn't in group
    }

    this.updateGroup(groupId, { peerIds: newPeerIds });

    this.logger.debug("Removed peer from group:", peerId, groupId);
    this.emit("peer:removed-from-group", { groupId, peerId });
  }

  /**
   * Get all peers that belong to any group.
   */
  getAllGroupedPeers(): string[] {
    const peers = new Set<string>();
    for (const group of this.getGroups()) {
      for (const peerId of group.peerIds) {
        peers.add(peerId);
      }
    }
    return Array.from(peers);
  }

  /**
   * Parse a group from Loro map data.
   */
  private parseGroup(
    id: string,
    data: Record<string, unknown>,
  ): PeerGroup | undefined {
    try {
      // Parse peerIds (stored as JSON string)
      let peerIds: string[] = [];
      if (typeof data.peerIds === "string") {
        peerIds = JSON.parse(data.peerIds);
      } else if (Array.isArray(data.peerIds)) {
        peerIds = data.peerIds;
      }

      // Parse excludedFolders (stored as JSON string)
      let excludedFolders: string[] = [];
      if (typeof data.excludedFolders === "string") {
        excludedFolders = JSON.parse(data.excludedFolders);
      } else if (Array.isArray(data.excludedFolders)) {
        excludedFolders = data.excludedFolders;
      }

      return {
        id,
        name: String(data.name ?? "Unnamed"),
        icon: String(data.icon ?? "📁"),
        color: String(data.color ?? "#6c6c6c"),
        peerIds,
        syncPolicy: {
          excludedFolders,
          readOnly: Boolean(data.readOnly),
          autoConnect: data.autoConnect !== false,
          priority: Number(data.priority ?? 0),
        },
        createdAt: Number(data.createdAt ?? Date.now()),
      };
    } catch (error) {
      this.logger.warn("Failed to parse group:", id, error);
      return undefined;
    }
  }
}
