# PeerVault: System Overview

## Purpose

PeerVault is an Obsidian plugin that enables peer-to-peer synchronization of markdown vaults using CRDTs. It provides conflict-free sync without requiring a central server.

## Design Principles

1. **Conflict-free by default** - Concurrent edits merge automatically using Loro CRDTs
2. **Offline-first** - Full functionality without network; sync when peers connect
3. **No central server** - Direct P2P connections via Iroh with relay fallback
4. **Single-document architecture** - Entire vault in one Loro document with native tree CRDT
5. **Non-destructive** - Full edit history preserved; deletions are tombstones

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Obsidian Plugin                       │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ File Watcher│  │  Plugin UI  │  │ Peer Management │  │
│  └──────┬──────┘  └─────────────┘  └────────┬────────┘  │
│         │                                    │          │
│  ┌──────▼──────────────────────────┐  ┌─────▼───────┐  │
│  │      Loro Document Manager       │  │ Iroh WASM   │  │
│  │  - Single vault LoroDoc          │  │ - Endpoint  │  │
│  │  - LoroTree for file hierarchy   │  │ - Streams   │  │
│  │  - LoroText for file content     │  │ - Tickets   │  │
│  └──────┬──────────────────────────┘  └─────┬───────┘  │
│         │                                    │          │
│  ┌──────▼────────────────────────────────────▼───────┐  │
│  │                  Sync Protocol                     │  │
│  │  - Version vector exchange                         │  │
│  │  - Incremental update sync                         │  │
│  └──────┬────────────────────────────────────────────┘  │
│         │                                               │
│  ┌──────▼──────┐                                        │
│  │   Storage   │                                        │
│  │  .loro file │                                        │
│  └─────────────┘                                        │
└─────────────────────────────────────────────────────────┘
```

## Glossary

| Term | Definition |
|------|------------|
| **Vault** | An Obsidian vault (folder of markdown files) |
| **LoroDoc** | Single Loro document containing entire vault state |
| **LoroTree** | Native tree CRDT for file/folder hierarchy |
| **LoroText** | Text CRDT using Fugue algorithm for file content |
| **Version Vector** | Loro's causality tracker for incremental sync |
| **Peer** | Another device/instance running PeerVault |
| **Endpoint** | Iroh network identity (public key) |
| **Ticket** | Connection info for pairing (endpoint + relay hints) |
| **Tombstone** | Marker indicating a file was deleted (preserves history) |

## Technology Stack

| Component | Library | Purpose |
|-----------|---------|---------|
| CRDT Engine | `loro-crdt` | Conflict-free data structures (Fugue, LoroTree) |
| P2P Transport | `@aspect/iroh` (WASM) | NAT traversal, encrypted streams |
| Binary Sync | `iroh-blobs` | Large file/attachment sync |
| Plugin Host | Obsidian Plugin API | File access, UI integration |

## Component Dependencies

```
File Watcher ──────► Loro Doc Manager ◄────── Sync Protocol
                            │                        │
                            ▼                        │
                        Storage                      │
                        (.loro)                      │
                                                     │
Peer Management ──────► Iroh Transport ◄─────────────┘
                              │
                              ▼
                        iroh-blobs
                    (binary attachments)
```

## Spec Documents

### Core Components

| Spec | Description |
|------|-------------|
| [01-data-model](./01-data-model.md) | Loro document schemas |
| [02-storage](./02-storage.md) | Persistence layer |
| [03-file-watcher](./03-file-watcher.md) | Vault change detection |
| [04-sync-protocol](./04-sync-protocol.md) | Document synchronization |
| [05-transport-iroh](./05-transport-iroh.md) | P2P networking |
| [06-peer-management](./06-peer-management.md) | Pairing and discovery |
| [07-plugin-ui](./07-plugin-ui.md) | User interface |

### Cross-Cutting Concerns

| Spec | Description |
|------|-------------|
| [08-testing](./08-testing.md) | Test strategy, fixtures, CI |
| [09-error-handling](./09-error-handling.md) | Error taxonomy, recovery |
| [10-security](./10-security.md) | Threat model, encryption, trust |
| [11-performance](./11-performance.md) | Budgets, optimization, benchmarks |
| [12-migration](./12-migration.md) | Schema versioning, upgrades |
| [13-plugin-development](./13-plugin-development.md) | Build setup, API patterns, guidelines |
| [14-binary-files](./14-binary-files.md) | Binary attachments via iroh-blobs |
| [15-peer-groups](./15-peer-groups.md) | Device groups and sync policies |

## Multi-Vault Support

PeerVault supports syncing multiple vaults independently. Each vault has its own identity, peers, and sync state.

### Vault Isolation

```typescript
/**
 * Each vault has independent sync state.
 */
interface VaultSyncState {
  /** Unique identifier for this vault */
  vaultId: string;

  /** Human-readable vault name */
  vaultName: string;

  /** Loro document for this vault */
  doc: LoroDoc;

  /** Peers for this vault (separate from other vaults) */
  peers: Peer[];

  /** Path to vault root */
  vaultPath: string;
}
```

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Obsidian Instance                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────┐    ┌─────────────────────┐         │
│  │   Personal Vault    │    │    Work Vault       │         │
│  │                     │    │                     │         │
│  │  vaultId: abc123    │    │  vaultId: def456    │         │
│  │  peers: [phone]     │    │  peers: [laptop]    │         │
│  │  doc: LoroDoc       │    │  doc: LoroDoc       │         │
│  └─────────────────────┘    └─────────────────────┘         │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │          Shared Iroh Transport                    │       │
│  │    (single WASM instance, multiple connections)   │       │
│  └──────────────────────────────────────────────────┘       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Vault Identification

```typescript
/**
 * Generate stable vault ID from path.
 * Used to distinguish vaults on same device.
 */
function generateVaultId(vaultPath: string): string {
  // Use hash of vault path for stability
  // Or use UUID stored in .obsidian/plugins/peervault/vault-id
  return sha256(vaultPath).slice(0, 16);
}

/**
 * Vault registry tracks all PeerVault-enabled vaults.
 */
class VaultRegistry {
  private vaults = new Map<string, VaultSyncState>();

  async registerVault(vaultPath: string): Promise<VaultSyncState> {
    const vaultId = generateVaultId(vaultPath);

    if (this.vaults.has(vaultId)) {
      return this.vaults.get(vaultId)!;
    }

    const state: VaultSyncState = {
      vaultId,
      vaultName: path.basename(vaultPath),
      doc: new LoroDoc(),
      peers: [],
      vaultPath,
    };

    // Load existing state if available
    await this.loadVaultState(state);

    this.vaults.set(vaultId, state);
    return state;
  }

  getVault(vaultId: string): VaultSyncState | undefined {
    return this.vaults.get(vaultId);
  }

  getCurrentVault(): VaultSyncState | undefined {
    // Get vault for currently active Obsidian vault
    const currentPath = this.app.vault.getRoot().path;
    const vaultId = generateVaultId(currentPath);
    return this.vaults.get(vaultId);
  }
}
```

### Peer Association

Peers are associated with specific vaults, not globally:

```typescript
interface MultiVaultPeer extends Peer {
  /** Which vault this peer syncs */
  vaultId: string;
}

/**
 * When pairing, associate peer with current vault.
 */
async function addPeerToCurrentVault(
  ticket: string,
  name: string,
  registry: VaultRegistry
): Promise<Peer> {
  const currentVault = registry.getCurrentVault();
  if (!currentVault) {
    throw new Error('No vault active');
  }

  const peer: MultiVaultPeer = {
    // ...standard peer fields
    vaultId: currentVault.vaultId,
  };

  currentVault.peers.push(peer);
  await savePeerState(currentVault);

  return peer;
}
```

### UI Considerations

```typescript
/**
 * Settings show vault-specific peer list.
 */
class MultiVaultSettingsTab extends PluginSettingTab {
  display(): void {
    const { containerEl } = this;
    const currentVault = this.plugin.registry.getCurrentVault();

    if (!currentVault) {
      containerEl.createEl('p', {
        text: 'PeerVault not enabled for this vault. Click Enable to start syncing.',
      });
      return;
    }

    containerEl.createEl('h2', { text: `PeerVault: ${currentVault.vaultName}` });
    containerEl.createEl('p', {
      text: `Vault ID: ${currentVault.vaultId}`,
      cls: 'peervault-vault-id',
    });

    // Show peers for THIS vault only
    this.displayPeersForVault(currentVault);
  }
}
```

### Switching Vaults

When user switches vaults in Obsidian:

```typescript
class VaultSwitchHandler {
  constructor(private registry: VaultRegistry) {
    // Listen for vault change
    this.app.workspace.on('vault-change', this.handleVaultSwitch.bind(this));
  }

  private async handleVaultSwitch(newVault: Vault): Promise<void> {
    const vaultId = generateVaultId(newVault.getRoot().path);

    // Pause sync for previous vault (if any)
    const previousVault = this.registry.getCurrentVault();
    if (previousVault) {
      await this.pauseSync(previousVault);
    }

    // Resume/start sync for new vault
    const newVaultState = this.registry.getVault(vaultId);
    if (newVaultState) {
      await this.resumeSync(newVaultState);
    }
    // If not registered, user needs to enable PeerVault for this vault
  }
}
```

### Storage Layout (Multi-Vault)

```
~/.obsidian-peervault/              # Shared across vaults
├── transport/
│   └── iroh/                       # Single Iroh identity
└── vaults/
    ├── abc123/                     # Personal vault
    │   ├── vault.loro
    │   ├── peers.json
    │   └── blobs/
    └── def456/                     # Work vault
        ├── vault.loro
        ├── peers.json
        └── blobs/
```

### Multi-Vault Multiplexing over Single Endpoint

All vaults share a single Iroh endpoint (NodeId). This minimizes resource usage and simplifies peer discovery.

#### Protocol Layer Multiplexing

```typescript
/**
 * Vault identifier is sent in the first message of each sync stream.
 * This allows the receiving peer to route to the correct vault handler.
 */
interface StreamHeader {
  /** Protocol version */
  version: 1;

  /** Message type */
  type: 'sync-init';

  /** Which vault this stream is for */
  vaultId: string;

  /** Sender's version vector for this vault */
  versionVector: Uint8Array;
}

/**
 * Connection multiplexer routes streams to vault handlers.
 */
class ConnectionMultiplexer {
  private vaultHandlers = new Map<string, VaultSyncHandler>();
  private activeStreams = new Map<string, Set<WasmStream>>(); // vaultId -> streams
  private vaultLocks = new Map<string, number>(); // vaultId -> active sync count

  /** Stream header timeout in milliseconds */
  private readonly STREAM_HEADER_TIMEOUT_MS = 30_000; // 30 seconds

  /**
   * Register a vault's sync handler.
   */
  registerVault(vaultId: string, handler: VaultSyncHandler): void {
    this.vaultHandlers.set(vaultId, handler);
    this.activeStreams.set(vaultId, new Set());
    this.vaultLocks.set(vaultId, 0);
  }

  /**
   * Unregister when vault is closed.
   * Gracefully closes all active streams first.
   */
  async unregisterVault(vaultId: string): Promise<void> {
    // Check for active syncs
    const activeSyncs = this.vaultLocks.get(vaultId) ?? 0;
    if (activeSyncs > 0) {
      console.warn(`Vault ${vaultId} has ${activeSyncs} active syncs, closing them`);
    }

    // Close all active streams for this vault
    const streams = this.activeStreams.get(vaultId);
    if (streams) {
      for (const stream of streams) {
        try {
          await stream.send(this.createError('VAULT_CLOSING'));
          await stream.close();
        } catch (e) {
          // Stream may already be closed
        }
      }
      streams.clear();
    }

    // Remove handler
    this.vaultHandlers.delete(vaultId);
    this.activeStreams.delete(vaultId);
    this.vaultLocks.delete(vaultId);
  }

  /**
   * Check if vault can be safely unregistered.
   */
  canUnregisterVault(vaultId: string): { safe: boolean; reason?: string } {
    const activeSyncs = this.vaultLocks.get(vaultId) ?? 0;
    if (activeSyncs > 0) {
      return {
        safe: false,
        reason: `${activeSyncs} sync operation(s) in progress`,
      };
    }
    return { safe: true };
  }

  /**
   * Handle incoming stream by reading header and routing.
   * Includes timeout handling for malicious/stalled peers.
   */
  async handleIncomingStream(stream: WasmStream): Promise<void> {
    let header: StreamHeader;

    // Read header with timeout
    try {
      header = await this.readHeaderWithTimeout(stream);
    } catch (error) {
      if (error.message === 'HEADER_TIMEOUT') {
        console.warn('Stream header timeout, closing connection');
        await stream.close();
        return;
      }
      throw error;
    }

    // Validate version
    if (header.version !== 1) {
      await stream.send(this.createError('UNSUPPORTED_VERSION'));
      await stream.close();
      return;
    }

    // Route to appropriate vault handler
    const handler = this.vaultHandlers.get(header.vaultId);
    if (!handler) {
      await stream.send(this.createError('UNKNOWN_VAULT', header.vaultId));
      await stream.close();
      return;
    }

    // Track this stream and increment sync lock
    this.trackStream(header.vaultId, stream);

    try {
      // Delegate to vault-specific handler
      await handler.handleStream(stream, header);
    } finally {
      // Untrack stream and decrement lock
      this.untrackStream(header.vaultId, stream);
    }
  }

  /**
   * Read stream header with timeout.
   */
  private async readHeaderWithTimeout(stream: WasmStream): Promise<StreamHeader> {
    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('HEADER_TIMEOUT'));
      }, this.STREAM_HEADER_TIMEOUT_MS);

      try {
        const headerBytes = await stream.receive();
        clearTimeout(timeoutId);
        const header = this.parseHeader(headerBytes);
        resolve(header);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Track active stream for a vault.
   */
  private trackStream(vaultId: string, stream: WasmStream): void {
    const streams = this.activeStreams.get(vaultId);
    if (streams) {
      streams.add(stream);
    }

    const count = this.vaultLocks.get(vaultId) ?? 0;
    this.vaultLocks.set(vaultId, count + 1);
  }

  /**
   * Untrack stream when done.
   */
  private untrackStream(vaultId: string, stream: WasmStream): void {
    const streams = this.activeStreams.get(vaultId);
    if (streams) {
      streams.delete(stream);
    }

    const count = this.vaultLocks.get(vaultId) ?? 0;
    this.vaultLocks.set(vaultId, Math.max(0, count - 1));
  }

  /**
   * Initiate sync with peer for specific vault.
   */
  async initiateSync(
    connection: WasmConnection,
    vaultId: string,
    versionVector: Uint8Array
  ): Promise<void> {
    const handler = this.vaultHandlers.get(vaultId);
    if (!handler) {
      throw new Error(`No handler for vault: ${vaultId}`);
    }

    // Open new stream for this vault
    const stream = await connection.openStream();

    // Send header identifying which vault
    const header: StreamHeader = {
      version: 1,
      type: 'sync-init',
      vaultId,
      versionVector,
    };
    await stream.send(this.serializeHeader(header));

    // Continue with vault-specific sync
    await handler.handleOutgoingSync(stream);
  }

  private parseHeader(bytes: Uint8Array): StreamHeader {
    // First 4 bytes: header length
    // Rest: CBOR-encoded header
    const headerLen = new DataView(bytes.buffer).getUint32(0, false);
    const headerBytes = bytes.slice(4, 4 + headerLen);
    return CBOR.decode(headerBytes);
  }

  private serializeHeader(header: StreamHeader): Uint8Array {
    const headerBytes = CBOR.encode(header);
    const result = new Uint8Array(4 + headerBytes.length);
    new DataView(result.buffer).setUint32(0, headerBytes.length, false);
    result.set(headerBytes, 4);
    return result;
  }

  private createError(code: string, detail?: string): Uint8Array {
    return this.serializeHeader({
      version: 1,
      type: 'error',
      error: { code, detail },
    } as any);
  }
}
```

#### Peer-Vault Association

```typescript
/**
 * Track which vaults each peer has access to.
 * A single peer (NodeId) may sync multiple vaults.
 */
interface PeerVaultAccess {
  /** Peer's NodeId */
  nodeId: string;

  /** Vaults this peer can sync */
  vaults: Set<string>;

  /** Connection if currently active */
  connection?: WasmConnection;
}

class PeerVaultRegistry {
  private access = new Map<string, PeerVaultAccess>();

  /**
   * Grant peer access to a vault.
   * Called during pairing.
   */
  grantAccess(nodeId: string, vaultId: string): void {
    const entry = this.access.get(nodeId) ?? {
      nodeId,
      vaults: new Set(),
    };
    entry.vaults.add(vaultId);
    this.access.set(nodeId, entry);
  }

  /**
   * Revoke peer's access to a vault.
   */
  revokeAccess(nodeId: string, vaultId: string): void {
    const entry = this.access.get(nodeId);
    if (entry) {
      entry.vaults.delete(vaultId);
      if (entry.vaults.size === 0) {
        this.access.delete(nodeId);
      }
    }
  }

  /**
   * Check if peer can access a vault.
   * Used when receiving sync requests.
   */
  canAccess(nodeId: string, vaultId: string): boolean {
    const entry = this.access.get(nodeId);
    return entry?.vaults.has(vaultId) ?? false;
  }

  /**
   * Get all vaults a peer can access.
   */
  getVaultsForPeer(nodeId: string): string[] {
    return Array.from(this.access.get(nodeId)?.vaults ?? []);
  }

  /**
   * Get all peers that can access a vault.
   */
  getPeersForVault(vaultId: string): string[] {
    const peers: string[] = [];
    for (const [nodeId, entry] of this.access) {
      if (entry.vaults.has(vaultId)) {
        peers.push(nodeId);
      }
    }
    return peers;
  }
}
```

#### Concurrent Vault Sync

```typescript
/**
 * Sync multiple vaults with a peer concurrently.
 */
async function syncAllVaultsWithPeer(
  connection: WasmConnection,
  multiplexer: ConnectionMultiplexer,
  peerVaults: string[],
  vaultStates: Map<string, VaultSyncState>
): Promise<void> {
  // Sync each vault in parallel using separate streams
  const syncPromises = peerVaults.map(async vaultId => {
    const state = vaultStates.get(vaultId);
    if (!state) return;

    const versionVector = state.doc.version().encode();
    await multiplexer.initiateSync(connection, vaultId, versionVector);
  });

  // Wait for all to complete (or fail)
  const results = await Promise.allSettled(syncPromises);

  // Log any failures
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      console.error(
        `Vault ${peerVaults[i]} sync failed:`,
        result.reason
      );
    }
  }
}
```

#### Resource Management

```typescript
/**
 * Limit concurrent sync streams to prevent resource exhaustion.
 */
const MULTIPLEXING_LIMITS = {
  /** Max concurrent sync streams per connection */
  maxStreamsPerConnection: 4,

  /** Max concurrent syncing vaults */
  maxConcurrentVaults: 3,

  /** Stream idle timeout (close if no activity) */
  streamIdleTimeoutMs: 30_000,
} as const;

class StreamPool {
  private activeStreams = new Map<string, WasmStream>();

  async acquireStream(
    connection: WasmConnection,
    vaultId: string
  ): Promise<WasmStream | null> {
    // Check limits
    if (this.activeStreams.size >= MULTIPLEXING_LIMITS.maxStreamsPerConnection) {
      // Wait for a stream to free up
      return null;
    }

    const stream = await connection.openStream();
    this.activeStreams.set(vaultId, stream);
    return stream;
  }

  releaseStream(vaultId: string): void {
    const stream = this.activeStreams.get(vaultId);
    if (stream) {
      stream.close().catch(() => {});
      this.activeStreams.delete(vaultId);
    }
  }
}
```

### Limitations

| Scenario | Handling |
|----------|----------|
| Same vault synced via multiple peer sets | Not supported (one peer set per vault) |
| Vault path changes | Re-register with new path, migrate state |
| Vault copied to new location | Becomes separate vault (new ID) |
| Peer without access to vault | Sync request rejected with UNKNOWN_VAULT |
| Too many concurrent streams | Queued, respects MULTIPLEXING_LIMITS |
