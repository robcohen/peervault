/**
 * Peer Groups Tests
 *
 * Tests for peer group management and policy merging.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { PeerGroupManager, DEFAULT_GROUP_ID, DEFAULT_SYNC_POLICY } from '../src/peer/groups';
import { DocumentManager } from '../src/core/document-manager';
import { MemoryStorageAdapter } from '../src/core/storage-adapter';
import type { Logger } from '../src/utils/logger';

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe('PeerGroupManager', () => {
  let storage: MemoryStorageAdapter;
  let logger: Logger;
  let docManager: DocumentManager;
  let groupManager: PeerGroupManager;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    logger = createTestLogger();
    docManager = new DocumentManager(storage, logger);
    await docManager.initialize();

    groupManager = new PeerGroupManager(docManager.getLoro(), logger);
  });

  describe('Default Group', () => {
    it('should have a default group on initialization', () => {
      const groups = groupManager.getGroups();
      expect(groups.length).toBe(1);
      expect(groups[0]!.id).toBe(DEFAULT_GROUP_ID);
      expect(groups[0]!.name).toBe('All Devices');
    });

    it('should not allow deleting default group', () => {
      expect(() => {
        groupManager.deleteGroup(DEFAULT_GROUP_ID);
      }).toThrow();
    });
  });

  describe('Group CRUD', () => {
    it('should create a new group', () => {
      const group = groupManager.createGroup('Work', '💼', '#1c7ed6');

      expect(group.id).toBeDefined();
      expect(group.name).toBe('Work');
      expect(group.icon).toBe('💼');
      expect(group.color).toBe('#1c7ed6');
      expect(group.peerIds).toEqual([]);
      expect(group.syncPolicy).toEqual(DEFAULT_SYNC_POLICY);
    });

    it('should get group by ID', () => {
      const created = groupManager.createGroup('Test', '🧪', '#7950f2');
      const retrieved = groupManager.getGroup(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('Test');
    });

    it('should update group properties', () => {
      const group = groupManager.createGroup('Old Name', '📁', '#7c7c7c');

      groupManager.updateGroup(group.id, {
        name: 'New Name',
        icon: '📂',
        color: '#e03131',
      });

      const updated = groupManager.getGroup(group.id);
      expect(updated!.name).toBe('New Name');
      expect(updated!.icon).toBe('📂');
      expect(updated!.color).toBe('#e03131');
    });

    it('should update group sync policy', () => {
      const group = groupManager.createGroup('Test', '📁', '#7c7c7c');

      groupManager.updateGroup(group.id, {
        syncPolicy: {
          ...DEFAULT_SYNC_POLICY,
          excludedFolders: ['private', 'secrets'],
          readOnly: true,
          priority: 5,
        },
      });

      const updated = groupManager.getGroup(group.id);
      expect(updated!.syncPolicy.excludedFolders).toEqual(['private', 'secrets']);
      expect(updated!.syncPolicy.readOnly).toBe(true);
      expect(updated!.syncPolicy.priority).toBe(5);
    });

    it('should delete a group', () => {
      const group = groupManager.createGroup('ToDelete', '🗑️', '#e03131');
      expect(groupManager.getGroups().length).toBe(2);

      groupManager.deleteGroup(group.id);
      expect(groupManager.getGroups().length).toBe(1);
      expect(groupManager.getGroup(group.id)).toBeUndefined();
    });
  });

  describe('Peer Management', () => {
    it('should add peer to group', () => {
      const group = groupManager.createGroup('Work', '💼', '#1c7ed6');

      groupManager.addPeerToGroup(group.id, 'peer-123');

      const updated = groupManager.getGroup(group.id);
      expect(updated!.peerIds).toContain('peer-123');
    });

    it('should remove peer from group', () => {
      const group = groupManager.createGroup('Work', '💼', '#1c7ed6');
      groupManager.addPeerToGroup(group.id, 'peer-123');
      groupManager.addPeerToGroup(group.id, 'peer-456');

      groupManager.removePeerFromGroup(group.id, 'peer-123');

      const updated = groupManager.getGroup(group.id);
      expect(updated!.peerIds).not.toContain('peer-123');
      expect(updated!.peerIds).toContain('peer-456');
    });

    it('should get groups for a peer', () => {
      const group1 = groupManager.createGroup('Work', '💼', '#1c7ed6');
      const group2 = groupManager.createGroup('Home', '🏠', '#37b24d');

      groupManager.addPeerToGroup(group1.id, 'peer-123');
      groupManager.addPeerToGroup(group2.id, 'peer-123');
      groupManager.addPeerToGroup(DEFAULT_GROUP_ID, 'peer-123');

      const peerGroups = groupManager.getGroupsForPeer('peer-123');
      expect(peerGroups.length).toBe(3);
      expect(peerGroups.map((g) => g.name)).toContain('Work');
      expect(peerGroups.map((g) => g.name)).toContain('Home');
      expect(peerGroups.map((g) => g.name)).toContain('All Devices');
    });

    it('should not add duplicate peer to group', () => {
      const group = groupManager.createGroup('Work', '💼', '#1c7ed6');

      groupManager.addPeerToGroup(group.id, 'peer-123');
      groupManager.addPeerToGroup(group.id, 'peer-123'); // Duplicate

      const updated = groupManager.getGroup(group.id);
      expect(updated!.peerIds.filter((id) => id === 'peer-123').length).toBe(1);
    });
  });

  describe('Policy Merging', () => {
    it('should return default policy for peer with no groups', () => {
      const policy = groupManager.getEffectiveSyncPolicy('unknown-peer');

      expect(policy).toEqual(DEFAULT_SYNC_POLICY);
    });

    it('should return group policy for peer in single group', () => {
      const group = groupManager.createGroup('Work', '💼', '#1c7ed6');
      groupManager.updateGroup(group.id, {
        syncPolicy: {
          excludedFolders: ['personal'],
          readOnly: true,
          autoConnect: false,
          priority: 5,
        },
      });
      groupManager.addPeerToGroup(group.id, 'peer-123');

      const policy = groupManager.getEffectiveSyncPolicy('peer-123');

      expect(policy.excludedFolders).toEqual(['personal']);
      expect(policy.readOnly).toBe(true);
      expect(policy.autoConnect).toBe(false);
      expect(policy.priority).toBe(5);
    });

    it('should merge excludedFolders as UNION', () => {
      const group1 = groupManager.createGroup('Group1', '📁', '#1c7ed6');
      const group2 = groupManager.createGroup('Group2', '📂', '#37b24d');

      groupManager.updateGroup(group1.id, {
        syncPolicy: { ...DEFAULT_SYNC_POLICY, excludedFolders: ['folder-a', 'folder-b'] },
      });
      groupManager.updateGroup(group2.id, {
        syncPolicy: { ...DEFAULT_SYNC_POLICY, excludedFolders: ['folder-b', 'folder-c'] },
      });

      groupManager.addPeerToGroup(group1.id, 'peer-123');
      groupManager.addPeerToGroup(group2.id, 'peer-123');

      const policy = groupManager.getEffectiveSyncPolicy('peer-123');

      // Union: folder-a, folder-b, folder-c
      expect(policy.excludedFolders).toContain('folder-a');
      expect(policy.excludedFolders).toContain('folder-b');
      expect(policy.excludedFolders).toContain('folder-c');
      expect(policy.excludedFolders.length).toBe(3);
    });

    it('should merge readOnly as OR (true if ANY group is readOnly)', () => {
      const group1 = groupManager.createGroup('ReadOnly', '🔒', '#e03131');
      const group2 = groupManager.createGroup('ReadWrite', '📝', '#37b24d');

      groupManager.updateGroup(group1.id, {
        syncPolicy: { ...DEFAULT_SYNC_POLICY, readOnly: true },
      });
      groupManager.updateGroup(group2.id, {
        syncPolicy: { ...DEFAULT_SYNC_POLICY, readOnly: false },
      });

      groupManager.addPeerToGroup(group1.id, 'peer-123');
      groupManager.addPeerToGroup(group2.id, 'peer-123');

      const policy = groupManager.getEffectiveSyncPolicy('peer-123');

      // OR: true because group1 is readOnly
      expect(policy.readOnly).toBe(true);
    });

    it('should merge autoConnect as AND (true only if ALL allow)', () => {
      const group1 = groupManager.createGroup('Auto', '⚡', '#37b24d');
      const group2 = groupManager.createGroup('Manual', '🔧', '#f76707');

      groupManager.updateGroup(group1.id, {
        syncPolicy: { ...DEFAULT_SYNC_POLICY, autoConnect: true },
      });
      groupManager.updateGroup(group2.id, {
        syncPolicy: { ...DEFAULT_SYNC_POLICY, autoConnect: false },
      });

      groupManager.addPeerToGroup(group1.id, 'peer-123');
      groupManager.addPeerToGroup(group2.id, 'peer-123');

      const policy = groupManager.getEffectiveSyncPolicy('peer-123');

      // AND: false because group2 disables autoConnect
      expect(policy.autoConnect).toBe(false);
    });

    it('should merge priority as MAX', () => {
      const group1 = groupManager.createGroup('Low', '⬇️', '#7c7c7c');
      const group2 = groupManager.createGroup('High', '⬆️', '#e03131');

      groupManager.updateGroup(group1.id, {
        syncPolicy: { ...DEFAULT_SYNC_POLICY, priority: 2 },
      });
      groupManager.updateGroup(group2.id, {
        syncPolicy: { ...DEFAULT_SYNC_POLICY, priority: 8 },
      });

      groupManager.addPeerToGroup(group1.id, 'peer-123');
      groupManager.addPeerToGroup(group2.id, 'peer-123');

      const policy = groupManager.getEffectiveSyncPolicy('peer-123');

      // MAX: 8
      expect(policy.priority).toBe(8);
    });
  });

  describe('Events', () => {
    it('should emit group:created event', () => {
      let emittedGroup: any = null;

      groupManager.on('group:created', (group) => {
        emittedGroup = group;
      });

      const created = groupManager.createGroup('Test', '🧪', '#7950f2');

      expect(emittedGroup).toBeDefined();
      expect(emittedGroup.id).toBe(created.id);
    });

    it('should emit group:updated event', () => {
      let emittedGroup: any = null;

      groupManager.on('group:updated', (group) => {
        emittedGroup = group;
      });

      const created = groupManager.createGroup('Test', '🧪', '#7950f2');
      groupManager.updateGroup(created.id, { name: 'Updated' });

      expect(emittedGroup).toBeDefined();
      expect(emittedGroup.name).toBe('Updated');
    });

    it('should emit group:deleted event', () => {
      let deletedId: string | null = null;

      groupManager.on('group:deleted', (id) => {
        deletedId = id;
      });

      const created = groupManager.createGroup('ToDelete', '🗑️', '#e03131');
      groupManager.deleteGroup(created.id);

      expect(deletedId).toBe(created.id);
    });

    it('should emit peer:added-to-group event', () => {
      let eventData: any = null;

      groupManager.on('peer:added-to-group', (data) => {
        eventData = data;
      });

      const group = groupManager.createGroup('Test', '🧪', '#7950f2');
      groupManager.addPeerToGroup(group.id, 'peer-123');

      expect(eventData).toEqual({ groupId: group.id, peerId: 'peer-123' });
    });
  });
});
