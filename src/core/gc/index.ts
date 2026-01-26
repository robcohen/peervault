/**
 * Garbage Collection module exports
 */

export {
  GarbageCollector,
  type PeerSyncStateProvider,
} from "./garbage-collector";
export {
  DEFAULT_GC_CONFIG,
  type GCConfig,
  type GCStats,
  type PeerSyncState,
  type OrphanedBlobInfo,
  type GCProgressCallback,
} from "./types";
