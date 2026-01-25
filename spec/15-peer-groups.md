# Peer Groups Spec

## Purpose

Define how peers can be organized into groups for easier management of multiple devices and shared vaults. Peer groups allow categorizing devices (e.g., "Personal", "Work") and managing sync policies per group.

## Requirements

- **REQ-PG-01**: Peers MUST be assignable to one or more groups
- **REQ-PG-02**: Groups MUST support custom names and icons
- **REQ-PG-03**: Sync policies MUST be configurable per group
- **REQ-PG-04**: Groups MUST be synced between devices
- **REQ-PG-05**: Default group MUST exist for ungrouped peers

## Use Cases

### 1. Personal Device Groups

```
┌─────────────────────────────────────────────────────────┐
│                    Personal Devices                      │
├─────────────────────────────────────────────────────────┤
│  📱 iPhone           ✅ Connected                        │
│  💻 MacBook Pro      ✅ Connected                        │
│  🖥️ Desktop PC       ⚪ Offline                         │
└─────────────────────────────────────────────────────────┘
```

### 2. Work vs Personal

```
┌─────────────────────────────────────────────────────────┐
│  Groups                                                  │
├─────────────────────────────────────────────────────────┤
│  📁 Personal (3 devices)                                │
│     - iPhone, MacBook, iPad                             │
│     - Full sync                                          │
│                                                          │
│  📁 Work (2 devices)                                    │
│     - Work Laptop, Office PC                            │
│     - Exclude: Personal/, Journal/                      │
│                                                          │
│  📁 Read-Only Archives (1 device)                       │
│     - NAS Server                                         │
│     - Read-only access                                   │
└─────────────────────────────────────────────────────────┘
```

## Data Model

### Group Schema

```typescript
interface PeerGroup {
  /** Unique group identifier */
  id: string;

  /** Display name */
  name: string;

  /** Icon (emoji or icon name) */
  icon: string;

  /** Group color for UI */
  color: string;

  /** Peers in this group */
  peerIds: string[];

  /** Sync policy for this group */
  syncPolicy: GroupSyncPolicy;

  /** When group was created */
  createdAt: number;
}

interface GroupSyncPolicy {
  /** Folders to exclude from sync for this group */
  excludedFolders: string[];

  /** Whether peers in this group are read-only */
  readOnly: boolean;

  /** Auto-connect when any peer in group is available */
  autoConnect: boolean;

  /** Priority for sync (higher = sync first) */
  priority: number;
}

const DEFAULT_GROUP: PeerGroup = {
  id: 'default',
  name: 'All Devices',
  icon: '📱',
  color: '#7c7c7c',
  peerIds: [],
  syncPolicy: {
    excludedFolders: [],
    readOnly: false,
    autoConnect: true,
    priority: 0,
  },
  createdAt: 0,
};
```

### Storage in Loro

Groups are stored in the Loro document for sync:

```typescript
import { LoroDoc, LoroMap, LoroList } from 'loro-crdt';

function initializeGroups(doc: LoroDoc): void {
  const groups = doc.getMap('groups');

  // Create default group if not exists
  if (!groups.get('default')) {
    doc.transact(() => {
      const defaultGroup = groups.setContainer('default', 'Map');
      defaultGroup.set('id', 'default');
      defaultGroup.set('name', 'All Devices');
      defaultGroup.set('icon', '📱');
      defaultGroup.set('color', '#7c7c7c');
      defaultGroup.setContainer('peerIds', 'List');
      defaultGroup.setContainer('syncPolicy', 'Map');
      defaultGroup.set('createdAt', Date.now());
    });
  }
}

function createGroup(doc: LoroDoc, group: Omit<PeerGroup, 'id' | 'createdAt'>): string {
  const groups = doc.getMap('groups');
  const id = generateGroupId();

  doc.transact(() => {
    const groupMap = groups.setContainer(id, 'Map');
    groupMap.set('id', id);
    groupMap.set('name', group.name);
    groupMap.set('icon', group.icon);
    groupMap.set('color', group.color);

    const peerIds = groupMap.setContainer('peerIds', 'List');
    for (const peerId of group.peerIds) {
      peerIds.push(peerId);
    }

    const policy = groupMap.setContainer('syncPolicy', 'Map');
    policy.set('excludedFolders', group.syncPolicy.excludedFolders);
    policy.set('readOnly', group.syncPolicy.readOnly);
    policy.set('autoConnect', group.syncPolicy.autoConnect);
    policy.set('priority', group.syncPolicy.priority);

    groupMap.set('createdAt', Date.now());
  });

  return id;
}

function addPeerToGroup(doc: LoroDoc, groupId: string, peerId: string): void {
  const groups = doc.getMap('groups');
  const group = groups.get(groupId) as LoroMap;

  if (!group) {
    throw new Error(`Group not found: ${groupId}`);
  }

  const peerIds = group.get('peerIds') as LoroList;

  // Check if already in group
  const existing = peerIds.toArray();
  if (existing.includes(peerId)) {
    return;
  }

  doc.transact(() => {
    peerIds.push(peerId);
  });
}

function removePeerFromGroup(doc: LoroDoc, groupId: string, peerId: string): void {
  const groups = doc.getMap('groups');
  const group = groups.get(groupId) as LoroMap;

  if (!group) return;

  const peerIds = group.get('peerIds') as LoroList;
  const index = peerIds.toArray().indexOf(peerId);

  if (index !== -1) {
    doc.transact(() => {
      peerIds.delete(index, 1);
    });
  }
}
```

## Group Manager

```typescript
class PeerGroupManager {
  constructor(
    private doc: LoroDoc,
    private peerManager: PeerManager
  ) {
    initializeGroups(this.doc);
  }

  /**
   * Get all groups.
   */
  getGroups(): PeerGroup[] {
    const groups = this.doc.getMap('groups');
    const result: PeerGroup[] = [];

    for (const [id, groupMap] of groups.entries()) {
      result.push(this.mapToGroup(groupMap as LoroMap));
    }

    return result.sort((a, b) => b.syncPolicy.priority - a.syncPolicy.priority);
  }

  /**
   * Get group by ID.
   */
  getGroup(id: string): PeerGroup | null {
    const groups = this.doc.getMap('groups');
    const groupMap = groups.get(id) as LoroMap;

    if (!groupMap) return null;
    return this.mapToGroup(groupMap);
  }

  /**
   * Get groups that contain a peer.
   */
  getGroupsForPeer(peerId: string): PeerGroup[] {
    return this.getGroups().filter(g => g.peerIds.includes(peerId));
  }

  /**
   * Get effective sync policy for a peer.
   * Merges policies from all groups the peer belongs to.
   *
   * ## Policy Merging Rules
   *
   * When a peer belongs to multiple groups, policies are merged as follows:
   *
   * | Property | Merge Strategy | Rationale |
   * |----------|---------------|-----------|
   * | excludedFolders | Union (combine all) | Most restrictive: exclude everything any group excludes |
   * | readOnly | OR (true if ANY group is read-only) | Security: read-only is the more restrictive option |
   * | autoConnect | AND (true only if ALL groups allow) | Explicit opt-in from all groups required |
   * | priority | MAX (highest priority wins) | Higher priority groups should take precedence |
   *
   * ## Examples
   *
   * **Peer in "Family" (readOnly: true) and "Backup" (readOnly: false):**
   * - Result: readOnly = true (most restrictive)
   *
   * **Peer in "Work" (excludes: "/Private") and "Mobile" (excludes: "/Large"):**
   * - Result: excludedFolders = ["/Private", "/Large"] (union)
   *
   * **Peer in "Primary" (autoConnect: true) and "Metered" (autoConnect: false):**
   * - Result: autoConnect = false (all groups must allow)
   *
   * **Peer in "VIP" (priority: 10) and "Default" (priority: 0):**
   * - Result: priority = 10 (highest)
   */
  getEffectiveSyncPolicy(peerId: string): GroupSyncPolicy {
    const groups = this.getGroupsForPeer(peerId);

    if (groups.length === 0) {
      // Use default group policy
      return this.getGroup('default')!.syncPolicy;
    }

    // Merge policies according to documented rules
    const excludedFolders = new Set<string>();
    let readOnly = false;
    let autoConnect = true;
    let maxPriority = 0;

    for (const group of groups) {
      // UNION: Combine all excluded folders (most restrictive)
      for (const folder of group.syncPolicy.excludedFolders) {
        excludedFolders.add(folder);
      }

      // OR: Read-only if ANY group is read-only (security-first)
      if (group.syncPolicy.readOnly) {
        readOnly = true;
      }

      // AND: Auto-connect only if ALL groups allow it (explicit consent)
      if (!group.syncPolicy.autoConnect) {
        autoConnect = false;
      }

      // MAX: Highest priority wins (VIP treatment)
      maxPriority = Math.max(maxPriority, group.syncPolicy.priority);
    }

    return {
      excludedFolders: Array.from(excludedFolders),
      readOnly,
      autoConnect,
      priority: maxPriority,
    };
  }

  /**
   * Check if adding a peer to a group would change their effective policy.
   * Useful for warning users before group changes.
   */
  previewPolicyChange(
    peerId: string,
    newGroupId: string
  ): { before: GroupSyncPolicy; after: GroupSyncPolicy; changes: string[] } {
    const before = this.getEffectiveSyncPolicy(peerId);

    // Temporarily add peer to group for preview
    const currentGroups = this.getGroupsForPeer(peerId);
    const newGroup = this.getGroup(newGroupId);

    if (!newGroup) {
      return { before, after: before, changes: [] };
    }

    const allGroups = [...currentGroups, newGroup];
    const after = this.mergeGroupPolicies(allGroups);

    const changes: string[] = [];

    if (after.readOnly && !before.readOnly) {
      changes.push('Peer will become read-only');
    }
    if (!after.autoConnect && before.autoConnect) {
      changes.push('Auto-connect will be disabled');
    }

    const newExclusions = after.excludedFolders.filter(f => !before.excludedFolders.includes(f));
    if (newExclusions.length > 0) {
      changes.push(`New excluded folders: ${newExclusions.join(', ')}`);
    }

    return { before, after, changes };
  }

  private mergeGroupPolicies(groups: PeerGroup[]): GroupSyncPolicy {
    const excludedFolders = new Set<string>();
    let readOnly = false;
    let autoConnect = true;
    let maxPriority = 0;

    for (const group of groups) {
      for (const folder of group.syncPolicy.excludedFolders) {
        excludedFolders.add(folder);
      }
      if (group.syncPolicy.readOnly) readOnly = true;
      if (!group.syncPolicy.autoConnect) autoConnect = false;
      maxPriority = Math.max(maxPriority, group.syncPolicy.priority);
    }

    return {
      excludedFolders: Array.from(excludedFolders),
      readOnly,
      autoConnect,
      priority: maxPriority,
    };
  }

  /**
   * Create a new group.
   */
  createGroup(name: string, icon: string, color: string): string {
    return createGroup(this.doc, {
      name,
      icon,
      color,
      peerIds: [],
      syncPolicy: {
        excludedFolders: [],
        readOnly: false,
        autoConnect: true,
        priority: 0,
      },
    });
  }

  /**
   * Update group settings.
   */
  updateGroup(id: string, updates: Partial<PeerGroup>): void {
    const groups = this.doc.getMap('groups');
    const group = groups.get(id) as LoroMap;

    if (!group) {
      throw new Error(`Group not found: ${id}`);
    }

    this.doc.transact(() => {
      if (updates.name !== undefined) group.set('name', updates.name);
      if (updates.icon !== undefined) group.set('icon', updates.icon);
      if (updates.color !== undefined) group.set('color', updates.color);

      if (updates.syncPolicy) {
        const policy = group.get('syncPolicy') as LoroMap;
        if (updates.syncPolicy.excludedFolders !== undefined) {
          policy.set('excludedFolders', updates.syncPolicy.excludedFolders);
        }
        if (updates.syncPolicy.readOnly !== undefined) {
          policy.set('readOnly', updates.syncPolicy.readOnly);
        }
        if (updates.syncPolicy.autoConnect !== undefined) {
          policy.set('autoConnect', updates.syncPolicy.autoConnect);
        }
        if (updates.syncPolicy.priority !== undefined) {
          policy.set('priority', updates.syncPolicy.priority);
        }
      }
    });
  }

  /**
   * Delete a group (moves peers to default).
   */
  deleteGroup(id: string): void {
    if (id === 'default') {
      throw new Error('Cannot delete default group');
    }

    const group = this.getGroup(id);
    if (!group) return;

    // Move peers to default group
    for (const peerId of group.peerIds) {
      addPeerToGroup(this.doc, 'default', peerId);
    }

    // Delete group
    const groups = this.doc.getMap('groups');
    this.doc.transact(() => {
      groups.delete(id);
    });
  }

  /**
   * Add peer to group.
   */
  addPeerToGroup(groupId: string, peerId: string): void {
    addPeerToGroup(this.doc, groupId, peerId);
  }

  /**
   * Remove peer from group.
   */
  removePeerFromGroup(groupId: string, peerId: string): void {
    removePeerFromGroup(this.doc, groupId, peerId);
  }

  private mapToGroup(map: LoroMap): PeerGroup {
    const peerIds = map.get('peerIds') as LoroList;
    const policy = map.get('syncPolicy') as LoroMap;

    return {
      id: map.get('id') as string,
      name: map.get('name') as string,
      icon: map.get('icon') as string,
      color: map.get('color') as string,
      peerIds: peerIds.toArray() as string[],
      syncPolicy: {
        excludedFolders: (policy.get('excludedFolders') as string[]) || [],
        readOnly: (policy.get('readOnly') as boolean) || false,
        autoConnect: (policy.get('autoConnect') as boolean) ?? true,
        priority: (policy.get('priority') as number) || 0,
      },
      createdAt: map.get('createdAt') as number,
    };
  }
}
```

## UI Components

### Group Management Settings

```typescript
class GroupSettingsSection {
  constructor(
    private containerEl: HTMLElement,
    private groupManager: PeerGroupManager
  ) {}

  display(): void {
    this.containerEl.createEl('h3', { text: 'Peer Groups' });

    // Add group button
    new Setting(this.containerEl)
      .setName('Create group')
      .setDesc('Organize your devices into groups')
      .addButton(btn => btn
        .setButtonText('New Group')
        .onClick(() => this.showCreateGroupModal())
      );

    // List existing groups
    const groups = this.groupManager.getGroups();
    for (const group of groups) {
      this.renderGroup(group);
    }
  }

  private renderGroup(group: PeerGroup): void {
    const setting = new Setting(this.containerEl)
      .setName(`${group.icon} ${group.name}`)
      .setDesc(`${group.peerIds.length} device(s)`);

    if (group.id !== 'default') {
      setting
        .addButton(btn => btn
          .setIcon('pencil')
          .setTooltip('Edit group')
          .onClick(() => this.showEditGroupModal(group))
        )
        .addButton(btn => btn
          .setIcon('trash')
          .setTooltip('Delete group')
          .onClick(() => this.deleteGroup(group.id))
        );
    }

    // Show sync policy summary
    const policyEl = this.containerEl.createEl('div', { cls: 'group-policy' });
    if (group.syncPolicy.readOnly) {
      policyEl.createEl('span', { text: '👁️ Read-only', cls: 'policy-badge' });
    }
    if (group.syncPolicy.excludedFolders.length > 0) {
      policyEl.createEl('span', {
        text: `📁 ${group.syncPolicy.excludedFolders.length} excluded`,
        cls: 'policy-badge'
      });
    }
  }
}
```

### Group Selection in Peer Add Flow

```typescript
class AddPeerModal extends Modal {
  private selectedGroups: Set<string> = new Set(['default']);

  async onOpen(): Promise<void> {
    // ... existing ticket/QR code flow ...

    // Add group selection
    const { contentEl } = this;
    contentEl.createEl('h4', { text: 'Add to Groups' });

    const groups = this.groupManager.getGroups();
    for (const group of groups) {
      new Setting(contentEl)
        .setName(`${group.icon} ${group.name}`)
        .addToggle(toggle => toggle
          .setValue(this.selectedGroups.has(group.id))
          .onChange(value => {
            if (value) {
              this.selectedGroups.add(group.id);
            } else {
              this.selectedGroups.delete(group.id);
            }
          })
        );
    }
  }

  async onPeerConnected(peerId: string): Promise<void> {
    // Add peer to selected groups
    for (const groupId of this.selectedGroups) {
      this.groupManager.addPeerToGroup(groupId, peerId);
    }
  }
}
```

## Sync Policy Enforcement

```typescript
class GroupPolicyEnforcer {
  constructor(
    private groupManager: PeerGroupManager,
    private fileWatcher: FileWatcher
  ) {}

  /**
   * Filter file events based on peer's group policy.
   */
  shouldSyncFile(peerId: string, filePath: string): boolean {
    const policy = this.groupManager.getEffectiveSyncPolicy(peerId);

    // Check excluded folders
    for (const excludedFolder of policy.excludedFolders) {
      if (filePath.startsWith(excludedFolder + '/') || filePath === excludedFolder) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if peer can send updates to us.
   */
  canReceiveUpdatesFrom(peerId: string): boolean {
    const policy = this.groupManager.getEffectiveSyncPolicy(peerId);
    return !policy.readOnly;
  }

  /**
   * Get peers to auto-connect on startup.
   */
  getAutoConnectPeers(): string[] {
    const groups = this.groupManager.getGroups();
    const peers: string[] = [];

    for (const group of groups) {
      if (group.syncPolicy.autoConnect) {
        peers.push(...group.peerIds);
      }
    }

    return [...new Set(peers)]; // Deduplicate
  }

  /**
   * Get sync priority for ordering peer connections.
   */
  getSyncPriority(peerId: string): number {
    return this.groupManager.getEffectiveSyncPolicy(peerId).priority;
  }
}
```

## Error Handling

| Error | Recovery |
|-------|----------|
| Group not found | Use default group |
| Peer in no groups | Add to default group |
| Conflicting policies | Most restrictive wins |
| Group deleted while syncing | Move peers to default |

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- Loro for group data storage and sync
- Obsidian Plugin API for UI components

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Peer groups | Yes, support | Useful for organizing many devices and setting per-group policies |
| Multiple groups per peer | Yes, allow | Peer can belong to multiple groups (e.g., "Personal" and "Backup") |
| Policy merging | Most restrictive | If peer is in multiple groups, most restrictive policy applies |
| Group sync | Via Loro | Groups stored in Loro doc, automatically synced with vault |
| Default group | Required | Ensures all peers have at least one group |
