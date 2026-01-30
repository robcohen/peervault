/**
 * Conflict Tracker
 *
 * Tracks concurrent edits from multiple peers to show conflict indicators.
 * CRDTs automatically merge conflicts, but users should know when concurrent
 * edits occurred so they can review the result.
 */

import type { Logger } from "../utils/logger";
import { ConfigErrors } from "../errors";

/** A detected conflict */
export interface ConflictInfo {
  /** File path */
  path: string;
  /** Timestamp when conflict was detected */
  timestamp: number;
  /** Peers involved in the conflict */
  peerIds: string[];
  /** Peer names if known */
  peerNames: string[];
  /** Was this conflict resolved (reviewed by user) */
  resolved: boolean;
  /** Edit timestamps from each peer */
  editTimestamps: number[];
}

/** Concurrent edit window in ms (edits within this window are considered concurrent) */
const CONCURRENT_WINDOW_MS = 60000; // 1 minute

/** Maximum number of files to track edits for */
const MAX_TRACKED_FILES = 1000;

/** Maximum number of conflicts to store */
const MAX_CONFLICTS = 500;

/**
 * Tracks file edit history to detect concurrent edits.
 */
export class ConflictTracker {
  /** Recent edits per file: path -> array of {peerId, timestamp} */
  private recentEdits = new Map<
    string,
    Array<{ peerId: string; peerName?: string; timestamp: number }>
  >();

  /** Detected conflicts */
  private conflicts = new Map<string, ConflictInfo>();

  /** Callbacks for conflict events */
  private conflictCallbacks: Array<(conflict: ConflictInfo) => void> = [];

  constructor(private logger: Logger) {}

  /**
   * Record an edit from a peer.
   */
  recordEdit(
    path: string,
    peerId: string,
    peerName?: string,
    timestamp?: number,
  ): void {
    const editTime = timestamp ?? Date.now();
    const edits = this.recentEdits.get(path) ?? [];

    // Add this edit
    edits.push({ peerId, peerName, timestamp: editTime });

    // Keep only recent edits (within the concurrent window)
    const cutoff = Date.now() - CONCURRENT_WINDOW_MS * 2;
    const recentOnly = edits.filter((e) => e.timestamp > cutoff);
    this.recentEdits.set(path, recentOnly);

    // Enforce size limit on recentEdits map - remove oldest entries
    if (this.recentEdits.size > MAX_TRACKED_FILES) {
      this.pruneOldestEdits();
    }

    // Check for concurrent edits
    this.detectConflict(path, recentOnly);
  }

  /**
   * Remove oldest entries from recentEdits to stay under the size limit.
   */
  private pruneOldestEdits(): void {
    // Find entries with oldest timestamps and remove them
    const entries = Array.from(this.recentEdits.entries())
      .map(([path, edits]) => ({
        path,
        latestTimestamp: Math.max(...edits.map((e) => e.timestamp), 0),
      }))
      .sort((a, b) => a.latestTimestamp - b.latestTimestamp);

    // Remove oldest 10% to avoid frequent pruning
    const toRemove = Math.ceil(entries.length * 0.1);
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.recentEdits.delete(entries[i].path);
    }
  }

  /**
   * Remove old conflicts to stay under the size limit.
   * Prioritizes removing resolved conflicts first, then oldest unresolved.
   */
  private pruneOldConflicts(): void {
    const entries = Array.from(this.conflicts.entries())
      .map(([path, conflict]) => ({ path, conflict }))
      // Sort: resolved first, then by timestamp (oldest first)
      .sort((a, b) => {
        if (a.conflict.resolved !== b.conflict.resolved) {
          return a.conflict.resolved ? -1 : 1; // Resolved first
        }
        return a.conflict.timestamp - b.conflict.timestamp; // Oldest first
      });

    // Remove oldest 10% to avoid frequent pruning
    const toRemove = Math.ceil(entries.length * 0.1);
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.conflicts.delete(entries[i].path);
    }
  }

  /**
   * Detect if there are concurrent edits from different peers.
   *
   * A conflict is detected when 2+ different peers have edited the same file
   * within the CONCURRENT_WINDOW_MS time window (default: 1 minute).
   *
   * Note: This doesn't mean data was lost - Loro CRDT automatically merges
   * concurrent edits. This tracking is purely to alert users that multiple
   * people edited the same file around the same time so they can review
   * the merged result.
   *
   * @param path - File path being checked
   * @param edits - Recent edits for this file
   */
  private detectConflict(
    path: string,
    edits: Array<{ peerId: string; peerName?: string; timestamp: number }>,
  ): void {
    // Get edits within the concurrent window
    const now = Date.now();
    const recentEdits = edits.filter(
      (e) => now - e.timestamp < CONCURRENT_WINDOW_MS,
    );

    // Get unique peers
    const peerMap = new Map<string, { name?: string; timestamp: number }>();
    for (const edit of recentEdits) {
      const existing = peerMap.get(edit.peerId);
      if (!existing || edit.timestamp > existing.timestamp) {
        peerMap.set(edit.peerId, {
          name: edit.peerName,
          timestamp: edit.timestamp,
        });
      }
    }

    // If multiple peers edited within the window, it's a conflict
    if (peerMap.size >= 2) {
      const peerIds = Array.from(peerMap.keys());
      const peerNames = peerIds.map(
        (id) => peerMap.get(id)?.name ?? id.substring(0, 8),
      );
      const editTimestamps = peerIds.map((id) => peerMap.get(id)!.timestamp);

      const conflict: ConflictInfo = {
        path,
        timestamp: now,
        peerIds,
        peerNames,
        resolved: false,
        editTimestamps,
      };

      this.conflicts.set(path, conflict);
      this.logger.info("Concurrent edit detected:", path, "peers:", peerNames);

      // Enforce size limit on conflicts map - remove oldest resolved conflicts first
      if (this.conflicts.size > MAX_CONFLICTS) {
        this.pruneOldConflicts();
      }

      // Notify listeners
      for (const callback of this.conflictCallbacks) {
        try {
          callback(conflict);
        } catch (err) {
          this.logger.error("Error in conflict callback:", err);
        }
      }
    }
  }

  /**
   * Get all unresolved conflicts.
   */
  getConflicts(): ConflictInfo[] {
    return Array.from(this.conflicts.values()).filter((c) => !c.resolved);
  }

  /**
   * Get conflict for a specific file.
   */
  getConflict(path: string): ConflictInfo | undefined {
    const conflict = this.conflicts.get(path);
    return conflict && !conflict.resolved ? conflict : undefined;
  }

  /**
   * Check if a file has an unresolved conflict.
   */
  hasConflict(path: string): boolean {
    const conflict = this.conflicts.get(path);
    return conflict !== undefined && !conflict.resolved;
  }

  /**
   * Mark a conflict as resolved.
   */
  resolveConflict(path: string): void {
    const conflict = this.conflicts.get(path);
    if (conflict) {
      conflict.resolved = true;
      this.logger.info("Conflict resolved:", path);
    }
  }

  /**
   * Clear all conflicts.
   */
  clearConflicts(): void {
    this.conflicts.clear();
  }

  /**
   * Subscribe to conflict events.
   */
  onConflict(callback: (conflict: ConflictInfo) => void): () => void {
    this.conflictCallbacks.push(callback);
    return () => {
      const idx = this.conflictCallbacks.indexOf(callback);
      if (idx >= 0) this.conflictCallbacks.splice(idx, 1);
    };
  }

  /**
   * Get conflict count.
   */
  getConflictCount(): number {
    return this.getConflicts().length;
  }

  /**
   * Clear all conflict callbacks.
   * Call this when cleaning up to prevent memory leaks.
   */
  clearCallbacks(): void {
    this.conflictCallbacks = [];
  }

  /**
   * Reset the tracker, clearing all state.
   * Call this when reinitializing.
   */
  reset(): void {
    this.recentEdits.clear();
    this.conflicts.clear();
    this.conflictCallbacks = [];
  }
}

// Singleton instance
let conflictTracker: ConflictTracker | null = null;

/**
 * Get the global conflict tracker instance.
 */
export function getConflictTracker(logger?: Logger): ConflictTracker {
  if (!conflictTracker) {
    if (!logger) {
      throw ConfigErrors.invalid("logger", "ConflictTracker not initialized and no logger provided");
    }
    conflictTracker = new ConflictTracker(logger);
  }
  return conflictTracker;
}

/**
 * Initialize the conflict tracker.
 */
export function initConflictTracker(logger: Logger): ConflictTracker {
  conflictTracker = new ConflictTracker(logger);
  return conflictTracker;
}
