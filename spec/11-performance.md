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
| Index load | 300ms | Load VaultIndex from disk |
| Peer connect | 800ms | Connect to auto-connect peers |
| **Total** | **2000ms** | Cold start budget |

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
│  │           │           ├───┤       │           │      │
│  │           │           │Str│       │           │      │
│  │           │           │   ├───────┤           │      │
│  │           │           │   │ Index │           │      │
│  │           │           │   │       ├───────────┤      │
│  │           │           │   │       │   Peer    │      │
│  │           │           │   │       │  Connect  │      │
│  │           │           │   │       │           │      │
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
| Document cache | 50MB | Hot documents |
| Sync buffers | 20MB | In-flight data |
| Index | 10MB | 10k files |
| **Total** | **120MB** | Typical usage |
| **Max** | **200MB** | Large vault peak |

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

### 1. Lazy Document Loading

Don't load all documents into memory at startup.

```typescript
class LazyDocumentCache {
  private cache = new LRUCache<string, Automerge.Doc<FileDoc>>({
    max: 100, // Max 100 docs in memory
    maxSize: 50 * 1024 * 1024, // 50MB max
    sizeCalculation: (doc) => Automerge.save(doc).length,
    dispose: (doc, key) => {
      // Save to disk before eviction if dirty
      if (this.dirtyDocs.has(key)) {
        this.saveToDisk(key, doc);
      }
    },
  });

  async get(docId: string): Promise<Automerge.Doc<FileDoc>> {
    let doc = this.cache.get(docId);
    if (!doc) {
      doc = await this.loadFromDisk(docId);
      this.cache.set(docId, doc);
    }
    return doc;
  }
}
```

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

Automerge documents are already compressed, but we can optimize wire format.

```typescript
// Sync message compression for large documents
async function compressSyncMessage(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 1024) {
    // Don't compress small messages
    return new Uint8Array([0, ...data]); // 0 = uncompressed
  }

  const compressed = await compress(data); // Use compression stream API
  if (compressed.length < data.length * 0.9) {
    return new Uint8Array([1, ...compressed]); // 1 = compressed
  }

  return new Uint8Array([0, ...data]);
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

## Dependencies

- LRU cache library (e.g., `lru-cache`)
- Compression API (native or `pako`)
- Performance monitoring (built-in or `perf_hooks`)
