# Performance Budget Spec

## Purpose

Define performance requirements, budgets, and optimization strategies for PeerVault to ensure smooth operation across device types and vault sizes.

## Requirements

- **REQ-PERF-01**: Plugin startup MUST complete within 2 seconds
- **REQ-PERF-02**: File sync latency MUST be under 5 seconds for typical edits
- **REQ-PERF-03**: Memory usage MUST stay under 200MB for typical vaults
- **REQ-PERF-04**: Battery impact on mobile MUST be minimal during idle
- **REQ-PERF-05**: Large vaults (10k+ files) MUST remain usable

## Performance Budgets

### Startup Time

| Phase | Budget | Notes |
|-------|--------|-------|
| Plugin load | 100ms | Load JS, initialize classes |
| WASM load | 500ms | Load Iroh WASM module |
| Storage init | 200ms | Create directories, load meta |
| Loro snapshot load | 50ms | Load vault.loro with snapshot (very fast!) |
| Peer connect | 800ms | Connect to auto-connect peers |
| **Total** | **1650ms** | Cold start budget |

**Note:** Loro's snapshot mode provides ~100-200x faster loading than operation replay. A vault with 260K operations loads in ~6ms vs ~1,185ms.

```
┌─────────────────────────────────────────────────────────┐
│                    Startup Timeline                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  0ms        500ms      1000ms      1500ms      2000ms   │
│  │           │           │           │           │      │
│  ├───────────┤           │           │           │      │
│  │  Plugin   │           │           │           │      │
│  │   Load    │           │           │           │      │
│  │           ├───────────┤           │           │      │
│  │           │   WASM    │           │           │      │
│  │           │   Load    │           │           │      │
│  │           │           ├──┤        │           │      │
│  │           │           │St│        │           │      │
│  │           │           │  ├─┤      │           │      │
│  │           │           │  │L│ (Loro snapshot: ~50ms)  │
│  │           │           │  │ ├──────────────────┤      │
│  │           │           │  │ │   Peer Connect   │      │
│  │           │           │  │ │                  │      │
└─────────────────────────────────────────────────────────┘
```

### Sync Latency

| Operation | Budget | Condition |
|-----------|--------|-----------|
| Local change to CRDT | 50ms | Any file size |
| CRDT to peer (LAN) | 100ms | <100KB file |
| CRDT to peer (WAN) | 500ms | <100KB file |
| Peer to local file | 50ms | <100KB file |
| **Total round-trip** | **1000ms** | LAN, typical file |

### Memory Usage

| Component | Budget | Notes |
|-----------|--------|-------|
| Plugin base | 10MB | Code, static data |
| Iroh WASM | 30MB | Runtime |
| Loro document | 30MB | Single vault LoroDoc (efficient) |
| Sync buffers | 20MB | In-flight data |
| Path index | 5MB | Map<path, nodeId> |
| **Total** | **95MB** | Typical usage |
| **Max** | **150MB** | Large vault peak |

**Note:** Loro's single-document architecture is more memory-efficient than per-file documents. The entire vault state is in one LoroDoc with lazy loading of content.

### Battery (Mobile)

| State | Budget | Strategy |
|-------|--------|----------|
| Idle (connected) | <1% / hour | Reduce keepalives |
| Active sync | <5% / 100 files | Batch operations |
| Background | <0.5% / hour | Suspend connections |

## Vault Size Tiers

### Small Vault (<100 files)

| Metric | Target |
|--------|--------|
| Startup | <1s |
| Full sync | <10s |
| Memory | <50MB |

### Medium Vault (100-1000 files)

| Metric | Target |
|--------|--------|
| Startup | <2s |
| Full sync | <60s |
| Memory | <100MB |

### Large Vault (1000-10000 files)

| Metric | Target |
|--------|--------|
| Startup | <5s |
| Full sync | <10min |
| Memory | <200MB |

### Extra Large Vault (10000+ files)

| Metric | Target |
|--------|--------|
| Startup | <10s |
| Full sync | Best effort |
| Memory | <300MB |
| Strategy | Incremental sync |

## Optimization Strategies

### 1. Loro Snapshot Loading

Loro's native snapshot feature provides fast loading without replaying operations:

```typescript
import { LoroDoc } from 'loro-crdt';

class FastDocumentLoader {
  /**
   * Load vault document using Loro snapshot.
   * ~100-200x faster than operation replay.
   */
  async loadVault(storagePath: string): Promise<LoroDoc> {
    const bytes = await readFile(`${storagePath}/vault.loro`);

    const doc = new LoroDoc();
    // Snapshot import is O(state size), not O(operation count)
    doc.import(bytes);

    return doc;
  }

  /**
   * Save with snapshot for fast future loads.
   */
  async saveVault(doc: LoroDoc, storagePath: string): Promise<void> {
    // Snapshot mode includes pre-computed state
    const bytes = doc.export({ mode: 'snapshot' });
    await atomicWrite(`${storagePath}/vault.loro`, bytes);
  }
}
```

### Performance Comparison

| Vault Size | Operation Replay | Snapshot Load |
|------------|------------------|---------------|
| 10K ops | ~45ms | ~0.5ms |
| 260K ops | ~1,185ms | ~6ms |
| 26M ops | OOM | ~66ms |

### 2. Incremental Sync

Sync recently modified files first, defer old files.

```typescript
interface SyncPriority {
  /** Files modified in last hour: sync immediately */
  immediate: string[];

  /** Files modified in last day: sync soon */
  soon: string[];

  /** Older files: sync in background */
  background: string[];
}

function prioritizeSync(index: VaultIndex): SyncPriority {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const priority: SyncPriority = {
    immediate: [],
    soon: [],
    background: [],
  };

  for (const [path, entry] of Object.entries(index.files)) {
    if (entry.mtime > hourAgo) {
      priority.immediate.push(entry.docId);
    } else if (entry.mtime > dayAgo) {
      priority.soon.push(entry.docId);
    } else {
      priority.background.push(entry.docId);
    }
  }

  return priority;
}
```

### 3. Debounced Sync

Batch rapid edits before syncing.

```typescript
class DebouncedSync {
  private pending = new Map<string, NodeJS.Timeout>();
  private readonly DEBOUNCE_MS = 1000;

  scheduleSync(docId: string): void {
    // Cancel existing timer
    const existing = this.pending.get(docId);
    if (existing) clearTimeout(existing);

    // Set new timer
    const timer = setTimeout(() => {
      this.pending.delete(docId);
      this.performSync(docId);
    }, this.DEBOUNCE_MS);

    this.pending.set(docId, timer);
  }

  // Flush all pending syncs (e.g., before close)
  async flush(): Promise<void> {
    const docIds = [...this.pending.keys()];
    this.pending.forEach((timer) => clearTimeout(timer));
    this.pending.clear();

    await Promise.all(docIds.map((id) => this.performSync(id)));
  }
}
```

### 4. Compression

Loro's binary format is already efficient. Additional compression helps for wire transfer:

```typescript
// Sync message compression using native CompressionStream API
async function compressSyncMessage(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 1024) {
    // Don't compress small messages
    return new Uint8Array([0, ...data]); // 0 = uncompressed
  }

  // Use native CompressionStream (available in modern browsers)
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());

    if (compressed.length < data.length * 0.9) {
      return new Uint8Array([1, ...compressed]); // 1 = compressed
    }
  }

  return new Uint8Array([0, ...data]);
}

async function decompressSyncMessage(data: Uint8Array): Promise<Uint8Array> {
  const isCompressed = data[0] === 1;
  const payload = data.slice(1);

  if (!isCompressed) {
    return payload;
  }

  const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
```

### 5. Connection Pooling

Reuse connections, limit concurrent operations.

```typescript
class ConnectionPool {
  private readonly maxConcurrentSyncs = 3;
  private activeSyncs = 0;
  private queue: (() => Promise<void>)[] = [];

  async withConnection<T>(
    peerId: string,
    operation: (conn: PeerConnection) => Promise<T>
  ): Promise<T> {
    // Wait if at capacity
    if (this.activeSyncs >= this.maxConcurrentSyncs) {
      await new Promise<void>((resolve) => {
        this.queue.push(async () => resolve());
      });
    }

    this.activeSyncs++;
    try {
      const conn = await this.getConnection(peerId);
      return await operation(conn);
    } finally {
      this.activeSyncs--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.queue.length > 0 && this.activeSyncs < this.maxConcurrentSyncs) {
      const next = this.queue.shift()!;
      next();
    }
  }
}
```

### 6. Mobile Optimizations

```typescript
class MobileOptimizer {
  constructor(private platform: Platform) {}

  getConfig(): PerformanceConfig {
    if (!this.platform.isMobile) {
      return DEFAULT_CONFIG;
    }

    return {
      // Reduce memory pressure
      maxCachedDocs: 50,
      maxCacheSize: 25 * 1024 * 1024, // 25MB

      // Reduce battery drain
      syncDebounceMs: 2000, // Longer debounce
      keepaliveIntervalMs: 60000, // Less frequent
      backgroundSyncEnabled: false,

      // Reduce bandwidth
      compressThreshold: 512, // Compress smaller messages
      maxConcurrentSyncs: 2,
    };
  }
}
```

## Benchmarks

### Required Benchmarks

```typescript
// benchmark/startup.bench.ts
describe('Startup Performance', () => {
  bench('cold start - empty vault', async () => {
    const plugin = await loadPlugin(emptyVault);
    await plugin.initialize();
  });

  bench('cold start - 100 files', async () => {
    const plugin = await loadPlugin(smallVault);
    await plugin.initialize();
  });

  bench('cold start - 1000 files', async () => {
    const plugin = await loadPlugin(mediumVault);
    await plugin.initialize();
  });
});

// benchmark/sync.bench.ts
describe('Sync Performance', () => {
  bench('sync single file - 1KB', async () => {
    await syncFile(peer1, peer2, smallFile);
  });

  bench('sync single file - 100KB', async () => {
    await syncFile(peer1, peer2, mediumFile);
  });

  bench('sync 100 files', async () => {
    await syncFiles(peer1, peer2, hundredFiles);
  });
});

// benchmark/memory.bench.ts
describe('Memory Usage', () => {
  bench('memory - 100 docs loaded', async () => {
    const before = process.memoryUsage().heapUsed;
    await loadDocs(100);
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(50 * 1024 * 1024);
  });
});
```

### Benchmark CI Integration

```yaml
# .github/workflows/benchmark.yml
name: Performance Benchmarks

on:
  pull_request:
    branches: [main]

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run bench
      - name: Compare with baseline
        run: npm run bench:compare
      - name: Fail on regression
        run: |
          if grep -q "REGRESSION" bench-results.txt; then
            echo "Performance regression detected!"
            exit 1
          fi
```

## Monitoring

### Performance Metrics to Track

```typescript
interface PerformanceMetrics {
  // Startup
  startupTimeMs: number;
  wasmLoadTimeMs: number;
  indexLoadTimeMs: number;

  // Sync
  lastSyncDurationMs: number;
  avgSyncLatencyMs: number;
  syncErrorCount: number;

  // Memory
  heapUsedMb: number;
  docsCached: number;
  cacheHitRate: number;

  // Network
  bytesReceived: number;
  bytesSent: number;
  activeConnections: number;
}

class PerformanceMonitor {
  private metrics: PerformanceMetrics = { /* ... */ };

  recordStartup(durationMs: number): void {
    this.metrics.startupTimeMs = durationMs;
  }

  recordSync(durationMs: number): void {
    this.metrics.lastSyncDurationMs = durationMs;
    // Update rolling average
    this.metrics.avgSyncLatencyMs =
      (this.metrics.avgSyncLatencyMs * 0.9) + (durationMs * 0.1);
  }

  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  // Export for debugging
  exportReport(): string {
    return JSON.stringify(this.metrics, null, 2);
  }
}
```

## Performance Testing Checklist

| Test | Target | Method |
|------|--------|--------|
| Cold startup | <2s | Automated benchmark |
| Warm startup | <500ms | Automated benchmark |
| Single file sync | <1s | Integration test |
| 100 file sync | <30s | Integration test |
| Memory (100 files) | <100MB | Heap snapshot |
| Memory (1000 files) | <200MB | Heap snapshot |
| Mobile battery | <1%/hr idle | Manual test |

## Mobile-Specific Optimizations

Mobile devices have stricter resource constraints. This section details mobile-specific optimizations.

### Platform Detection

```typescript
interface PlatformInfo {
  isMobile: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  isTablet: boolean;

  /** Available memory estimate (if accessible) */
  availableMemoryMB?: number;

  /** Network type */
  networkType: 'wifi' | 'cellular' | 'offline' | 'unknown';

  /** Battery level (0-1) */
  batteryLevel?: number;

  /** Is device charging? */
  isCharging?: boolean;
}

function detectPlatform(): PlatformInfo {
  const platform = Platform.current;

  return {
    isMobile: platform.isMobile,
    isIOS: platform.isIOS,
    isAndroid: platform.isAndroid,
    isTablet: platform.isTablet,
    networkType: getNetworkType(),
    batteryLevel: navigator.battery?.level,
    isCharging: navigator.battery?.charging,
  };
}

function getNetworkType(): PlatformInfo['networkType'] {
  if (!navigator.onLine) return 'offline';

  const connection = navigator.connection;
  if (!connection) return 'unknown';

  if (connection.type === 'wifi' || connection.type === 'ethernet') {
    return 'wifi';
  }
  if (connection.type === 'cellular') {
    return 'cellular';
  }

  return 'unknown';
}
```

### WASM Memory Limits

iOS WebView has stricter memory limits than desktop browsers:

```typescript
interface WasmMemoryConfig {
  /** Initial memory allocation */
  initialPages: number;

  /** Maximum memory pages */
  maxPages: number;

  /** Memory per page (64KB) */
  pageSize: 65536;
}

const WASM_MEMORY_CONFIGS: Record<string, WasmMemoryConfig> = {
  desktop: {
    initialPages: 256,   // 16 MB initial
    maxPages: 16384,     // 1 GB max
    pageSize: 65536,
  },
  mobile: {
    initialPages: 128,   // 8 MB initial
    maxPages: 2048,      // 128 MB max (iOS limit)
    pageSize: 65536,
  },
  mobileConstrained: {
    initialPages: 64,    // 4 MB initial
    maxPages: 1024,      // 64 MB max (older devices)
    pageSize: 65536,
  },
};

/**
 * Get WASM memory config for current platform.
 */
function getWasmMemoryConfig(platform: PlatformInfo): WasmMemoryConfig {
  if (!platform.isMobile) {
    return WASM_MEMORY_CONFIGS.desktop;
  }

  // Check available memory
  if (platform.availableMemoryMB && platform.availableMemoryMB < 1024) {
    return WASM_MEMORY_CONFIGS.mobileConstrained;
  }

  return WASM_MEMORY_CONFIGS.mobile;
}
```

### Memory Pressure Handling

```typescript
/**
 * Handle low memory situations on mobile.
 */
class MemoryPressureHandler {
  private isUnderPressure = false;

  constructor(private plugin: PeerVaultPlugin) {
    // iOS sends this event
    window.addEventListener('memorywarning', this.handleMemoryWarning.bind(this));

    // Android sends this as part of performance observer
    if ('PerformanceObserver' in window) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'memory-pressure') {
            this.handleMemoryWarning();
          }
        }
      });
      observer.observe({ type: 'memory-pressure', buffered: true });
    }
  }

  private async handleMemoryWarning(): Promise<void> {
    console.warn('Memory pressure detected, releasing resources');
    this.isUnderPressure = true;

    // Release non-essential caches
    await this.plugin.clearNonEssentialCaches();

    // Force garbage collection if available
    if (globalThis.gc) {
      globalThis.gc();
    }

    // Pause non-critical sync
    this.plugin.pauseBackgroundSync();

    // Resume after cooldown
    setTimeout(() => {
      this.isUnderPressure = false;
      this.plugin.resumeBackgroundSync();
    }, 30000);
  }

  shouldDeferOperation(): boolean {
    return this.isUnderPressure;
  }
}
```

### Network Priority

```typescript
interface NetworkConfig {
  /** Max bytes per sync on cellular */
  cellularMaxBytes: number;

  /** Whether to sync blobs on cellular */
  syncBlobsOnCellular: boolean;

  /** Sync only on WiFi */
  wifiOnlySync: boolean;

  /** Reduced sync frequency on cellular */
  cellularSyncIntervalMs: number;
}

const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  cellularMaxBytes: 5 * 1024 * 1024,  // 5 MB per sync
  syncBlobsOnCellular: false,          // Don't sync large files on cellular
  wifiOnlySync: false,                 // Allow sync on cellular
  cellularSyncIntervalMs: 60000,       // Less frequent on cellular
};

class NetworkAwareSync {
  private config: NetworkConfig;
  private platform: PlatformInfo;

  constructor(config: NetworkConfig) {
    this.config = config;
    this.platform = detectPlatform();

    // Listen for network changes
    if (navigator.connection) {
      navigator.connection.addEventListener('change', this.handleNetworkChange.bind(this));
    }
  }

  private handleNetworkChange(): void {
    this.platform.networkType = getNetworkType();

    if (this.platform.networkType === 'offline') {
      this.pauseAllSync();
    } else if (this.platform.networkType === 'wifi') {
      this.resumeFullSync();
    } else if (this.platform.networkType === 'cellular') {
      this.switchToCellularMode();
    }
  }

  shouldSyncBlobs(): boolean {
    if (this.platform.networkType === 'cellular') {
      return this.config.syncBlobsOnCellular;
    }
    return true;
  }

  getSyncBudget(): number {
    if (this.platform.networkType === 'cellular') {
      return this.config.cellularMaxBytes;
    }
    return Infinity;
  }

  private switchToCellularMode(): void {
    // Reduce sync frequency
    // Pause blob sync
    // Prioritize text content
    console.log('Switching to cellular-optimized sync mode');
  }
}
```

### Battery-Aware Sync

```typescript
class BatteryAwareSync {
  private battery: BatteryManager | null = null;

  async initialize(): Promise<void> {
    if ('getBattery' in navigator) {
      this.battery = await navigator.getBattery();
      this.battery.addEventListener('levelchange', this.handleBatteryChange.bind(this));
      this.battery.addEventListener('chargingchange', this.handleBatteryChange.bind(this));
    }
  }

  private handleBatteryChange(): void {
    if (!this.battery) return;

    const level = this.battery.level;
    const charging = this.battery.charging;

    if (level < 0.2 && !charging) {
      // Critical battery - pause sync
      console.log('Low battery, pausing sync');
      this.pauseSync();
    } else if (level < 0.5 && !charging) {
      // Low battery - reduce sync frequency
      this.reduceSyncFrequency();
    } else {
      // Normal operation
      this.resumeNormalSync();
    }
  }

  getSyncStrategy(): 'full' | 'reduced' | 'paused' {
    if (!this.battery) return 'full';

    const level = this.battery.level;
    const charging = this.battery.charging;

    if (charging) return 'full';
    if (level < 0.2) return 'paused';
    if (level < 0.5) return 'reduced';
    return 'full';
  }
}
```

### iOS Background Execution Strategy

iOS severely limits background execution. This section details how PeerVault works within iOS constraints.

#### iOS Background Limits

| Scenario | Time Limit | Behavior |
|----------|------------|----------|
| App in foreground | Unlimited | Full sync |
| App backgrounded | ~30 seconds | Complete current operation |
| Background App Refresh | ~30 seconds | Quick sync only |
| Background Processing | ~1-5 minutes | Long-running (needs entitlement) |
| No background | None | Sync on next open |

#### Background Task Registration

```typescript
/**
 * iOS Background Task Manager.
 * Uses BGTaskScheduler when available (iOS 13+).
 */
class iOSBackgroundTaskManager {
  private static readonly SYNC_TASK_ID = 'com.peervault.sync';
  private static readonly PROCESSING_TASK_ID = 'com.peervault.processing';

  /**
   * Register background tasks.
   * Must be called on app startup.
   */
  static register(): void {
    if (!this.isIOSWithBackgroundSupport()) return;

    // Register sync task (quick operations)
    this.registerTask(this.SYNC_TASK_ID, async (task) => {
      await this.performQuickSync(task);
    });

    // Register processing task (longer operations, requires entitlement)
    this.registerTask(this.PROCESSING_TASK_ID, async (task) => {
      await this.performExtendedSync(task);
    });
  }

  /**
   * Schedule a background sync.
   * Called when app goes to background.
   */
  static scheduleBackgroundSync(): void {
    if (!this.isIOSWithBackgroundSupport()) return;

    const request = {
      taskIdentifier: this.SYNC_TASK_ID,
      earliestBeginDate: new Date(Date.now() + 15 * 60 * 1000), // 15 min from now
      requiresNetworkConnectivity: true,
      requiresExternalPower: false,
    };

    this.submitTaskRequest(request);
  }

  /**
   * Schedule extended processing (overnight sync, etc).
   */
  static scheduleProcessing(): void {
    if (!this.isIOSWithBackgroundSupport()) return;

    const request = {
      taskIdentifier: this.PROCESSING_TASK_ID,
      earliestBeginDate: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
      requiresNetworkConnectivity: true,
      requiresExternalPower: true, // Only when charging
    };

    this.submitTaskRequest(request);
  }

  private static async performQuickSync(task: BackgroundTask): Promise<void> {
    const timeout = setTimeout(() => {
      task.setTaskCompleted({ success: false });
    }, 25000); // Leave 5s margin

    try {
      // Only sync text content (fast)
      await syncEngine.quickSync({
        maxDuration: 20000,
        excludeBlobs: true,
        maxOperations: 100,
      });

      clearTimeout(timeout);
      task.setTaskCompleted({ success: true });

      // Schedule next background sync
      this.scheduleBackgroundSync();
    } catch (error) {
      clearTimeout(timeout);
      task.setTaskCompleted({ success: false });
    }
  }

  private static async performExtendedSync(task: BackgroundTask): Promise<void> {
    // Listen for expiration warning
    task.expirationHandler = () => {
      syncEngine.pauseGracefully();
    };

    try {
      // Full sync including blobs
      await syncEngine.fullSync({
        onProgress: (progress) => {
          // Can't update UI in background
          console.log(`Background sync: ${progress.percent}%`);
        },
      });

      task.setTaskCompleted({ success: true });
    } catch (error) {
      task.setTaskCompleted({ success: false });
    }
  }

  private static isIOSWithBackgroundSupport(): boolean {
    return Platform.isIOS && 'BGTaskScheduler' in window;
  }
}

interface BackgroundTask {
  setTaskCompleted(result: { success: boolean }): void;
  expirationHandler?: () => void;
}
```

#### Foreground-to-Background Transition

```typescript
class iOSLifecycleHandler {
  constructor(private syncEngine: SyncEngine) {
    // Listen for app state changes
    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));

    // iOS-specific: listen for resign active
    if (Platform.isIOS) {
      window.addEventListener('pagehide', this.handleBackground.bind(this));
    }
  }

  private handleVisibilityChange(): void {
    if (document.visibilityState === 'hidden') {
      this.handleBackground();
    } else {
      this.handleForeground();
    }
  }

  private handleBackground(): void {
    console.log('App backgrounded, completing current sync');

    // Start background task to extend execution time
    this.beginBackgroundTask();

    // Complete current sync operation quickly
    this.syncEngine.setUrgentMode(true);

    // Schedule future background sync
    iOSBackgroundTaskManager.scheduleBackgroundSync();
  }

  private handleForeground(): void {
    console.log('App foregrounded, resuming full sync');

    this.syncEngine.setUrgentMode(false);
    this.syncEngine.resumeFullSync();
  }

  private beginBackgroundTask(): void {
    // Request extra time from iOS
    if ('beginBackgroundTask' in UIApplication) {
      const taskId = UIApplication.beginBackgroundTask(() => {
        // Expiration handler - clean up
        this.syncEngine.pauseGracefully();
        UIApplication.endBackgroundTask(taskId);
      });

      // End task when sync completes
      this.syncEngine.onSyncComplete(() => {
        UIApplication.endBackgroundTask(taskId);
      });
    }
  }
}
```

#### Quick Sync Mode

```typescript
interface QuickSyncOptions {
  /** Maximum sync duration in ms */
  maxDuration: number;

  /** Skip binary file sync */
  excludeBlobs: boolean;

  /** Max operations to process */
  maxOperations: number;

  /** Priority peers (sync these first) */
  priorityPeers?: string[];
}

class QuickSyncEngine {
  /**
   * Perform a quick sync suitable for background execution.
   * Prioritizes text content and recent changes.
   */
  async quickSync(options: QuickSyncOptions): Promise<QuickSyncResult> {
    const startTime = Date.now();
    let operationCount = 0;

    const result: QuickSyncResult = {
      success: true,
      operationsProcessed: 0,
      peersContacted: [],
      blobsSkipped: 0,
    };

    // Connect to priority peers first
    const peers = options.priorityPeers || this.getOnlinePeers();

    for (const peerId of peers) {
      // Check time budget
      if (Date.now() - startTime > options.maxDuration) {
        result.success = false;
        result.reason = 'Time budget exceeded';
        break;
      }

      // Check operation budget
      if (operationCount >= options.maxOperations) {
        result.success = false;
        result.reason = 'Operation budget exceeded';
        break;
      }

      try {
        const peerResult = await this.syncWithPeer(peerId, {
          excludeBlobs: options.excludeBlobs,
          maxOperations: options.maxOperations - operationCount,
        });

        operationCount += peerResult.operations;
        result.peersContacted.push(peerId);
        result.blobsSkipped += peerResult.blobsSkipped;
      } catch (error) {
        console.warn(`Quick sync with ${peerId} failed:`, error);
      }
    }

    result.operationsProcessed = operationCount;
    return result;
  }
}

interface QuickSyncResult {
  success: boolean;
  operationsProcessed: number;
  peersContacted: string[];
  blobsSkipped: number;
  reason?: string;
}
```

#### Info.plist Configuration

For iOS background execution, add to `Info.plist`:

```xml
<!-- Background fetch (lightweight) -->
<key>UIBackgroundModes</key>
<array>
    <string>fetch</string>
    <string>processing</string>
</array>

<!-- Background task identifiers -->
<key>BGTaskSchedulerPermittedIdentifiers</key>
<array>
    <string>com.peervault.sync</string>
    <string>com.peervault.processing</string>
</array>
```

#### User Settings

```typescript
interface iOSBackgroundSettings {
  /** Enable background sync */
  backgroundSyncEnabled: boolean;

  /** Sync on WiFi only in background */
  backgroundWifiOnly: boolean;

  /** Allow extended processing (battery impact) */
  allowExtendedProcessing: boolean;

  /** Minimum battery for background sync */
  minBatteryForBackground: number;
}

const DEFAULT_IOS_BACKGROUND_SETTINGS: iOSBackgroundSettings = {
  backgroundSyncEnabled: true,
  backgroundWifiOnly: true,
  allowExtendedProcessing: false,
  minBatteryForBackground: 0.2,
};
```

### Mobile Budgets

| Resource | iOS Budget | Android Budget | Notes |
|----------|------------|----------------|-------|
| WASM Memory | 128 MB | 256 MB | iOS more constrained |
| Sync Data | 5 MB/min cellular | 10 MB/min cellular | Data usage |
| Background Sync | Disabled | Limited | iOS suspends aggressively |
| Keepalive Interval | 60s | 30s | iOS background limits |
| Blob Sync | WiFi only | Configurable | Default conservative |

### App Lifecycle

```typescript
/**
 * Handle iOS/Android app lifecycle events.
 */
class MobileLifecycleHandler {
  constructor(private plugin: PeerVaultPlugin) {
    document.addEventListener('pause', this.handlePause.bind(this));
    document.addEventListener('resume', this.handleResume.bind(this));
    document.addEventListener('visibilitychange', this.handleVisibility.bind(this));
  }

  private handlePause(): void {
    // App going to background
    console.log('App paused, saving state');

    // Flush pending writes
    this.plugin.flushPendingWrites();

    // Save sync state
    this.plugin.saveSyncState();

    // Pause network operations
    this.plugin.pauseNetworkOperations();
  }

  private handleResume(): void {
    // App returning to foreground
    console.log('App resumed, restoring state');

    // Reconnect to peers
    this.plugin.reconnectPeers();

    // Check for changes made while paused
    this.plugin.checkForLocalChanges();
  }

  private handleVisibility(): void {
    if (document.visibilityState === 'hidden') {
      this.handlePause();
    } else if (document.visibilityState === 'visible') {
      this.handleResume();
    }
  }
}
```

### Mobile Settings UI

```typescript
/**
 * Mobile-specific settings section.
 */
class MobileSettingsSection {
  display(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Mobile Settings' });

    new Setting(containerEl)
      .setName('WiFi-only sync')
      .setDesc('Only sync when connected to WiFi')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.wifiOnlySync)
        .onChange(value => this.plugin.updateSettings({ wifiOnlySync: value }))
      );

    new Setting(containerEl)
      .setName('Sync attachments on cellular')
      .setDesc('Download images and files over cellular data')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncBlobsOnCellular)
        .onChange(value => this.plugin.updateSettings({ syncBlobsOnCellular: value }))
      );

    new Setting(containerEl)
      .setName('Low power mode')
      .setDesc('Reduce sync frequency to save battery')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.lowPowerMode)
        .onChange(value => this.plugin.updateSettings({ lowPowerMode: value }))
      );

    new Setting(containerEl)
      .setName('Background sync')
      .setDesc('Continue syncing when app is in background (uses more battery)')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.backgroundSync)
        .onChange(value => this.plugin.updateSettings({ backgroundSync: value }))
      );
  }
}
```

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- Native CompressionStream API (modern browsers)
- Performance monitoring (built-in or `perf_hooks`)
- Battery API (where available)
- Network Information API (where available)
