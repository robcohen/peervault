/**
 * Peer Group Manager
 *
 * Manages peer groups and their sync policies.
 * Groups are stored in the Loro document for cross-device sync.
 */

import { LoroList } from "loro-crdt";
import type { LoroDoc, LoroMap } from "loro-crdt";
import type { Logger } from "../../utils/logger";
import { EventEmitter } from "../../utils/events";
import type { PeerGroup, GroupSyncPolicy, PeerGroupEvents } from "./types";
import { DEFAULT_GROUP_ID, DEFAULT_GROUP, DEFAULT_SYNC_POLICY } from "./types";
import { PeerErrors, ConfigErrors } from "../../errors";

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
   * Uses LoroList for arrays to maintain proper CRDT merge semantics.
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

    // Use LoroList for arrays to maintain CRDT merge semantics
    const peerIdsList = groupMap.setContainer("peerIds", new LoroList());
    for (const peerId of group.peerIds) {
      peerIdsList.push(peerId);
    }

    const excludedFoldersList = groupMap.setContainer(
      "excludedFolders",
      new LoroList(),
    );
    for (const folder of group.syncPolicy.excludedFolders) {
      excludedFoldersList.push(folder);
    }
  }

  /**
   * Update a peer group.
   * Uses LoroList for arrays to maintain proper CRDT merge semantics.
   */
  updateGroup(
    groupId: string,
    updates: Partial<Omit<PeerGroup, "id" | "createdAt">>,
  ): void {
    const groupMap = this.groupsMap.get(groupId) as LoroMap | undefined;
    if (!groupMap) {
      throw PeerErrors.groupNotFound(groupId);
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
      // Clear and repopulate the LoroList
      let peerIdsList = groupMap.get("peerIds") as LoroList | undefined;
      if (!peerIdsList || !(peerIdsList instanceof LoroList)) {
        // Create new list if doesn't exist or is legacy JSON string
        peerIdsList = groupMap.setContainer("peerIds", new LoroList());
      } else {
        // Clear existing list
        const len = peerIdsList.length;
        if (len > 0) {
          peerIdsList.delete(0, len);
        }
      }
      for (const peerId of updates.peerIds) {
        peerIdsList.push(peerId);
      }
    }
    if (updates.syncPolicy !== undefined) {
      groupMap.set("readOnly", updates.syncPolicy.readOnly);
      groupMap.set("autoConnect", updates.syncPolicy.autoConnect);
      groupMap.set("priority", updates.syncPolicy.priority);

      // Clear and repopulate the excludedFolders LoroList
      let excludedFoldersList = groupMap.get("excludedFolders") as
        | LoroList
        | undefined;
      if (!excludedFoldersList || !(excludedFoldersList instanceof LoroList)) {
        excludedFoldersList = groupMap.setContainer(
          "excludedFolders",
          new LoroList(),
        );
      } else {
        const len = excludedFoldersList.length;
        if (len > 0) {
          excludedFoldersList.delete(0, len);
        }
      }
      for (const folder of updates.syncPolicy.excludedFolders) {
        excludedFoldersList.push(folder);
      }
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
   * Peers in the deleted group are automatically moved to the default group.
   */
  deleteGroup(groupId: string): void {
    if (groupId === DEFAULT_GROUP_ID) {
      throw ConfigErrors.invalid("groupId", "Cannot delete the default group");
    }

    const group = this.getGroup(groupId);
    if (!group) {
      throw PeerErrors.groupNotFound(groupId);
    }

    // Move all peers to the default group before deletion
    for (const peerId of group.peerIds) {
      this.addPeerToGroup(DEFAULT_GROUP_ID, peerId);
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
      throw PeerErrors.groupNotFound(groupId);
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
      throw PeerErrors.groupNotFound(groupId);
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
   * Remove a peer from all groups.
   */
  removePeerFromAllGroups(peerId: string): void {
    for (const group of this.getGroups()) {
      if (group.peerIds.includes(peerId)) {
        const newPeerIds = group.peerIds.filter((id) => id !== peerId);
        this.updateGroup(group.id, { peerIds: newPeerIds });
        this.logger.debug("Removed peer from group:", peerId, group.id);
        this.emit("peer:removed-from-group", { groupId: group.id, peerId });
      }
    }
  }

  /**
   * Remove stale peer IDs from groups that don't exist in the peers list.
   */
  cleanupStalePeers(validPeerIds: Set<string>): number {
    let removed = 0;
    for (const group of this.getGroups()) {
      const stalePeers = group.peerIds.filter((id) => !validPeerIds.has(id));
      if (stalePeers.length > 0) {
        const newPeerIds = group.peerIds.filter((id) => validPeerIds.has(id));
        this.updateGroup(group.id, { peerIds: newPeerIds });
        removed += stalePeers.length;
        this.logger.info("Cleaned up stale peers from group:", group.id, stalePeers);
      }
    }
    return removed;
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
   * Handles both LoroList (new format) and JSON string (legacy format) for arrays.
   */
  private parseGroup(
    id: string,
    data: Record<string, unknown>,
  ): PeerGroup | undefined {
    try {
      // Parse peerIds - can be LoroList, array, or legacy JSON string
      let peerIds: string[] = [];
      if (Array.isArray(data.peerIds)) {
        peerIds = data.peerIds.map(String);
      } else if (typeof data.peerIds === "string") {
        // Legacy: JSON string format
        try {
          peerIds = JSON.parse(data.peerIds);
        } catch {
          peerIds = [];
        }
      }

      // Parse excludedFolders - can be LoroList, array, or legacy JSON string
      let excludedFolders: string[] = [];
      if (Array.isArray(data.excludedFolders)) {
        excludedFolders = data.excludedFolders.map(String);
      } else if (typeof data.excludedFolders === "string") {
        // Legacy: JSON string format
        try {
          excludedFolders = JSON.parse(data.excludedFolders);
        } catch {
          excludedFolders = [];
        }
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
