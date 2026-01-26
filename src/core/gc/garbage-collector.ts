/**
 * Garbage Collector
 *
 * Handles document compaction and orphaned blob cleanup.
 * Ensures peer consensus before discarding history to prevent sync issues.
 */

import type { DocumentManager } from "../document-manager";
import type { BlobStore } from "../blob-store";
import type { StorageAdapter } from "../../types";
import type { Logger } from "../../utils/logger";
import type {
  GCConfig,
  GCStats,
  PeerSyncState,
  GCProgressCallback,
} from "./types";
import { DEFAULT_GC_CONFIG } from "./types";

/** Storage key for GC checkpoint */
const CHECKPOINT_PREFIX = "gc-checkpoint-";

/**
 * Interface for getting peer sync states.
 * Implemented by PeerManager.
 */
export interface PeerSyncStateProvider {
  getPeerSyncStates(): PeerSyncState[];
}

/**
 * GarbageCollector manages document compaction and blob cleanup.
 *
 * Features:
 * - Document compaction using Loro's shallow-snapshot
 * - Orphaned blob detection and cleanup
 * - Peer consensus checking before compaction
 * - Checkpoint creation for recovery
 */
export class GarbageCollector {
  private config: GCConfig;

  constructor(
    private documentManager: DocumentManager,
    private blobStore: BlobStore,
    private storage: StorageAdapter,
    private logger: Logger,
    private peerProvider?: PeerSyncStateProvider,
    config?: Partial<GCConfig>,
  ) {
    this.config = { ...DEFAULT_GC_CONFIG, ...config };
  }

  /**
   * Update GC configuration.
   */
  updateConfig(config: Partial<GCConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current GC configuration.
   */
  getConfig(): GCConfig {
    return { ...this.config };
  }

  /**
   * Check if GC should run based on document size.
   */
  shouldRun(): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const docSize = this.documentManager.getDocumentSize();
    const maxSize = this.config.maxDocSizeMB * 1024 * 1024;

    return docSize >= maxSize;
  }

  /**
   * Check if all peers have synced recently enough for safe compaction.
   */
  checkPeerConsensus(): {
    canCompact: boolean;
    reason?: string;
    peerStates: PeerSyncState[];
  } {
    if (!this.config.requirePeerConsensus) {
      return { canCompact: true, peerStates: [] };
    }

    if (!this.peerProvider) {
      return { canCompact: true, peerStates: [] };
    }

    const peerStates = this.peerProvider.getPeerSyncStates();
    if (peerStates.length === 0) {
      return { canCompact: true, peerStates: [] };
    }

    const retentionMs = this.config.minHistoryDays * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMs;

    // Find peers that haven't synced within retention period
    const stalePeers = peerStates.filter((p) => p.lastSyncTime < cutoffTime);

    if (stalePeers.length > 0) {
      const staleNames = stalePeers
        .map((p) => p.peerName || p.peerId)
        .join(", ");
      return {
        canCompact: false,
        reason: `Waiting for peers to sync: ${staleNames}`,
        peerStates,
      };
    }

    return { canCompact: true, peerStates };
  }

  /**
   * Run garbage collection if conditions are met.
   *
   * @param force Force GC even if conditions aren't met
   * @param onProgress Progress callback
   * @returns GC stats if GC ran, null otherwise
   */
  async maybeRun(
    force = false,
    onProgress?: GCProgressCallback,
  ): Promise<GCStats | null> {
    const progress = onProgress ?? (() => {});

    // Check if GC should run
    if (!force && !this.shouldRun()) {
      this.logger.debug("GC skipped: document size below threshold");
      return null;
    }

    // Check peer consensus
    if (!force) {
      const consensus = this.checkPeerConsensus();
      if (!consensus.canCompact) {
        this.logger.info(`GC skipped: ${consensus.reason}`);
        return null;
      }
    }

    return this.run(onProgress);
  }

  /**
   * Force run garbage collection.
   *
   * @param onProgress Progress callback
   * @returns GC stats
   */
  async run(onProgress?: GCProgressCallback): Promise<GCStats> {
    const progress = onProgress ?? (() => {});
    const startTime = Date.now();

    this.logger.info("Starting garbage collection...");
    progress(0, "Starting garbage collection...");

    // Step 1: Create checkpoint
    progress(5, "Creating checkpoint...");
    await this.createCheckpoint();

    // Step 2: Compact document
    progress(20, "Compacting document...");
    const { beforeSize, afterSize } = await this.documentManager.compact();

    // Step 3: Save compacted document
    progress(50, "Saving compacted document...");
    await this.documentManager.save();

    // Step 4: Find and clean orphaned blobs
    progress(60, "Scanning for orphaned blobs...");
    const referencedHashes = new Set(this.documentManager.getAllBlobHashes());
    const orphanCount = (await this.blobStore.findOrphans(referencedHashes))
      .length;

    progress(80, `Cleaning ${orphanCount} orphaned blobs...`);
    const { count: blobsRemoved, bytesReclaimed: blobBytesReclaimed } =
      await this.blobStore.cleanOrphans(referencedHashes);

    const durationMs = Date.now() - startTime;

    const stats: GCStats = {
      beforeSize,
      afterSize,
      blobsRemoved,
      blobBytesReclaimed,
      timestamp: Date.now(),
      durationMs,
    };

    progress(100, "Garbage collection complete");

    this.logger.info(
      `GC complete: document ${beforeSize} -> ${afterSize} bytes, ` +
        `${blobsRemoved} blobs removed (${blobBytesReclaimed} bytes), ` +
        `took ${durationMs}ms`,
    );

    return stats;
  }

  /**
   * Clean only orphaned blobs without compacting the document.
   */
  async cleanOrphanedBlobs(
    onProgress?: GCProgressCallback,
  ): Promise<{ count: number; bytesReclaimed: number }> {
    const progress = onProgress ?? (() => {});

    progress(0, "Scanning for orphaned blobs...");
    const referencedHashes = new Set(this.documentManager.getAllBlobHashes());

    progress(50, "Cleaning orphaned blobs...");
    const result = await this.blobStore.cleanOrphans(referencedHashes);

    progress(100, `Cleaned ${result.count} orphaned blobs`);
    return result;
  }

  /**
   * Create a checkpoint before GC for recovery.
   */
  private async createCheckpoint(): Promise<string> {
    const timestamp = Date.now();
    const key = `${CHECKPOINT_PREFIX}${timestamp}`;

    // Export current document state
    const snapshot = this.documentManager
      .getLoro()
      .export({ mode: "snapshot" });
    await this.storage.write(`${key}-snapshot`, snapshot);

    // Store checkpoint metadata
    const meta = {
      timestamp,
      documentSize: snapshot.length,
      schemaVersion: this.documentManager.getSchemaVersion(),
    };
    await this.storage.write(
      `${key}-meta`,
      new TextEncoder().encode(JSON.stringify(meta)),
    );

    this.logger.debug("Created GC checkpoint:", key);
    return key;
  }

  /**
   * List available GC checkpoints.
   */
  async listCheckpoints(): Promise<
    Array<{ key: string; timestamp: number; documentSize: number }>
  > {
    const keys = await this.storage.list(CHECKPOINT_PREFIX);
    const metaKeys = keys.filter((k) => k.endsWith("-meta"));

    const checkpoints: Array<{
      key: string;
      timestamp: number;
      documentSize: number;
    }> = [];

    for (const metaKey of metaKeys) {
      try {
        const data = await this.storage.read(metaKey);
        if (data) {
          const meta = JSON.parse(new TextDecoder().decode(data));
          const key = metaKey.replace("-meta", "");
          checkpoints.push({
            key,
            timestamp: meta.timestamp,
            documentSize: meta.documentSize,
          });
        }
      } catch {
        // Skip invalid checkpoints
      }
    }

    return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Delete old checkpoints, keeping only the most recent N.
   */
  async pruneCheckpoints(keepCount = 3): Promise<number> {
    const checkpoints = await this.listCheckpoints();
    let deleted = 0;

    // Delete checkpoints beyond keepCount
    for (let i = keepCount; i < checkpoints.length; i++) {
      const checkpoint = checkpoints[i]!;
      try {
        await this.storage.delete(`${checkpoint.key}-snapshot`);
        await this.storage.delete(`${checkpoint.key}-meta`);
        deleted++;
      } catch {
        // Ignore errors
      }
    }

    if (deleted > 0) {
      this.logger.debug(`Pruned ${deleted} old GC checkpoints`);
    }

    return deleted;
  }

  /**
   * Get GC statistics without running GC.
   */
  async getStats(): Promise<{
    documentSize: number;
    maxSize: number;
    shouldRun: boolean;
    orphanedBlobCount: number;
    orphanedBlobSize: number;
    peerConsensus: { canCompact: boolean; reason?: string };
  }> {
    const documentSize = this.documentManager.getDocumentSize();
    const maxSize = this.config.maxDocSizeMB * 1024 * 1024;

    const referencedHashes = new Set(this.documentManager.getAllBlobHashes());
    const orphans = await this.blobStore.findOrphans(referencedHashes);
    const orphanedBlobSize = orphans.reduce((sum, o) => sum + o.size, 0);

    const consensus = this.checkPeerConsensus();

    return {
      documentSize,
      maxSize,
      shouldRun: this.shouldRun(),
      orphanedBlobCount: orphans.length,
      orphanedBlobSize,
      peerConsensus: {
        canCompact: consensus.canCompact,
        reason: consensus.reason,
      },
    };
  }
}
