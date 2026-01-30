/**
 * Conflict Tracker Tests
 *
 * Tests for concurrent edit detection and conflict management.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  ConflictTracker,
  initConflictTracker,
  getConflictTracker,
  type ConflictInfo,
} from "../src/core/conflict-tracker";
import type { Logger } from "../src/utils/logger";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    log: () => {},
    child: () => createTestLogger(),
    time: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    timeSync: <T>(_label: string, fn: () => T) => fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("ConflictTracker", () => {
  let logger: Logger;
  let tracker: ConflictTracker;

  beforeEach(() => {
    logger = createTestLogger();
    tracker = new ConflictTracker(logger);
  });

  describe("Initialization", () => {
    it("should start with no conflicts", () => {
      expect(tracker.getConflicts()).toEqual([]);
      expect(tracker.getConflictCount()).toBe(0);
    });

    it("should not have conflict for non-existent path", () => {
      expect(tracker.hasConflict("nonexistent.md")).toBe(false);
      expect(tracker.getConflict("nonexistent.md")).toBeUndefined();
    });
  });

  describe("Recording Edits", () => {
    it("should record single edit without conflict", () => {
      tracker.recordEdit("test.md", "peer-1", "Peer 1");
      expect(tracker.getConflicts()).toEqual([]);
    });

    it("should record multiple edits from same peer without conflict", () => {
      const now = Date.now();
      tracker.recordEdit("test.md", "peer-1", "Peer 1", now);
      tracker.recordEdit("test.md", "peer-1", "Peer 1", now + 1000);
      tracker.recordEdit("test.md", "peer-1", "Peer 1", now + 2000);
      expect(tracker.getConflicts()).toEqual([]);
    });

    it("should detect conflict when two peers edit within window", () => {
      const now = Date.now();
      tracker.recordEdit("test.md", "peer-1", "Peer 1", now);
      tracker.recordEdit("test.md", "peer-2", "Peer 2", now + 1000);

      expect(tracker.hasConflict("test.md")).toBe(true);
      const conflict = tracker.getConflict("test.md");
      expect(conflict).toBeDefined();
      expect(conflict!.path).toBe("test.md");
      expect(conflict!.peerIds).toContain("peer-1");
      expect(conflict!.peerIds).toContain("peer-2");
      expect(conflict!.resolved).toBe(false);
    });

    it("should not detect conflict when edits are outside window", () => {
      const now = Date.now();
      // First edit
      tracker.recordEdit("test.md", "peer-1", "Peer 1", now - 120000); // 2 minutes ago
      // Second edit from different peer (outside 1-minute window)
      tracker.recordEdit("test.md", "peer-2", "Peer 2", now);

      // Should not be a conflict since edits are > 1 minute apart
      expect(tracker.hasConflict("test.md")).toBe(false);
    });

    it("should detect conflict with three or more peers", () => {
      const now = Date.now();
      tracker.recordEdit("test.md", "peer-1", "Peer 1", now);
      tracker.recordEdit("test.md", "peer-2", "Peer 2", now + 1000);
      tracker.recordEdit("test.md", "peer-3", "Peer 3", now + 2000);

      const conflict = tracker.getConflict("test.md");
      expect(conflict).toBeDefined();
      expect(conflict!.peerIds.length).toBeGreaterThanOrEqual(2);
    });

    it("should use timestamp from Date.now() if not provided", () => {
      tracker.recordEdit("test.md", "peer-1");
      tracker.recordEdit("test.md", "peer-2");

      // Should detect conflict since both are at ~current time
      expect(tracker.hasConflict("test.md")).toBe(true);
    });
  });

  describe("Conflict Info", () => {
    it("should include peer names in conflict info", () => {
      const now = Date.now();
      tracker.recordEdit("test.md", "peer-1", "Laptop", now);
      tracker.recordEdit("test.md", "peer-2", "Phone", now + 500);

      const conflict = tracker.getConflict("test.md");
      expect(conflict!.peerNames).toContain("Laptop");
      expect(conflict!.peerNames).toContain("Phone");
    });

    it("should use truncated peer ID if name not provided", () => {
      const now = Date.now();
      tracker.recordEdit("test.md", "abcdef123456", undefined, now);
      tracker.recordEdit("test.md", "xyz789000111", undefined, now + 500);

      const conflict = tracker.getConflict("test.md");
      expect(conflict!.peerNames).toContain("abcdef12");
      expect(conflict!.peerNames).toContain("xyz78900");
    });

    it("should include edit timestamps", () => {
      const now = Date.now();
      const time1 = now;
      const time2 = now + 500;
      tracker.recordEdit("test.md", "peer-1", "P1", time1);
      tracker.recordEdit("test.md", "peer-2", "P2", time2);

      const conflict = tracker.getConflict("test.md");
      expect(conflict!.editTimestamps.length).toBe(2);
    });
  });

  describe("Resolving Conflicts", () => {
    it("should mark conflict as resolved", () => {
      const now = Date.now();
      tracker.recordEdit("test.md", "peer-1", "P1", now);
      tracker.recordEdit("test.md", "peer-2", "P2", now + 500);

      expect(tracker.hasConflict("test.md")).toBe(true);

      tracker.resolveConflict("test.md");

      expect(tracker.hasConflict("test.md")).toBe(false);
      expect(tracker.getConflict("test.md")).toBeUndefined();
    });

    it("should not count resolved conflicts", () => {
      const now = Date.now();
      tracker.recordEdit("a.md", "peer-1", "P1", now);
      tracker.recordEdit("a.md", "peer-2", "P2", now);
      tracker.recordEdit("b.md", "peer-1", "P1", now);
      tracker.recordEdit("b.md", "peer-2", "P2", now);

      expect(tracker.getConflictCount()).toBe(2);

      tracker.resolveConflict("a.md");

      expect(tracker.getConflictCount()).toBe(1);
    });

    it("should handle resolving non-existent conflict gracefully", () => {
      // Should not throw
      tracker.resolveConflict("nonexistent.md");
    });
  });

  describe("Clear Conflicts", () => {
    it("should clear all conflicts", () => {
      const now = Date.now();
      tracker.recordEdit("a.md", "peer-1", "P1", now);
      tracker.recordEdit("a.md", "peer-2", "P2", now);
      tracker.recordEdit("b.md", "peer-1", "P1", now);
      tracker.recordEdit("b.md", "peer-2", "P2", now);

      expect(tracker.getConflictCount()).toBe(2);

      tracker.clearConflicts();

      expect(tracker.getConflictCount()).toBe(0);
      expect(tracker.getConflicts()).toEqual([]);
    });
  });

  describe("Event Callbacks", () => {
    it("should notify callback on conflict detection", () => {
      const conflicts: ConflictInfo[] = [];
      tracker.onConflict((conflict) => {
        conflicts.push(conflict);
      });

      const now = Date.now();
      tracker.recordEdit("test.md", "peer-1", "P1", now);
      tracker.recordEdit("test.md", "peer-2", "P2", now);

      expect(conflicts.length).toBe(1);
      expect(conflicts[0]!.path).toBe("test.md");
    });

    it("should allow unsubscribing from events", () => {
      const conflicts: ConflictInfo[] = [];
      const unsubscribe = tracker.onConflict((conflict) => {
        conflicts.push(conflict);
      });

      const now = Date.now();
      tracker.recordEdit("a.md", "peer-1", "P1", now);
      tracker.recordEdit("a.md", "peer-2", "P2", now);

      expect(conflicts.length).toBe(1);

      unsubscribe();

      tracker.recordEdit("b.md", "peer-1", "P1", now);
      tracker.recordEdit("b.md", "peer-2", "P2", now);

      // Should still be 1 since we unsubscribed
      expect(conflicts.length).toBe(1);
    });

    it("should handle callback errors gracefully", () => {
      tracker.onConflict(() => {
        throw new Error("Callback error");
      });

      const now = Date.now();
      // Should not throw
      tracker.recordEdit("test.md", "peer-1", "P1", now);
      tracker.recordEdit("test.md", "peer-2", "P2", now);
    });
  });

  describe("Multiple Files", () => {
    it("should track conflicts independently per file", () => {
      const now = Date.now();

      // Conflict in a.md
      tracker.recordEdit("a.md", "peer-1", "P1", now);
      tracker.recordEdit("a.md", "peer-2", "P2", now);

      // No conflict in b.md (same peer)
      tracker.recordEdit("b.md", "peer-1", "P1", now);
      tracker.recordEdit("b.md", "peer-1", "P1", now + 1000);

      expect(tracker.hasConflict("a.md")).toBe(true);
      expect(tracker.hasConflict("b.md")).toBe(false);
    });

    it("should list all unresolved conflicts", () => {
      const now = Date.now();
      tracker.recordEdit("a.md", "peer-1", "P1", now);
      tracker.recordEdit("a.md", "peer-2", "P2", now);
      tracker.recordEdit("b.md", "peer-1", "P1", now);
      tracker.recordEdit("b.md", "peer-2", "P2", now);
      tracker.recordEdit("c.md", "peer-1", "P1", now);
      tracker.recordEdit("c.md", "peer-2", "P2", now);

      const conflicts = tracker.getConflicts();
      expect(conflicts.length).toBe(3);

      const paths = conflicts.map((c) => c.path);
      expect(paths).toContain("a.md");
      expect(paths).toContain("b.md");
      expect(paths).toContain("c.md");
    });
  });
});

describe("Singleton Functions", () => {
  it("should initialize tracker with logger", () => {
    const logger = createTestLogger();
    const tracker = initConflictTracker(logger);
    expect(tracker).toBeInstanceOf(ConflictTracker);
  });

  it("should get initialized tracker", () => {
    const logger = createTestLogger();
    initConflictTracker(logger);
    const tracker = getConflictTracker();
    expect(tracker).toBeInstanceOf(ConflictTracker);
  });
});
