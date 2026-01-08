# Peer Management Spec

## Purpose

Define how peers are discovered, paired, stored, and managed throughout the lifecycle of vault synchronization.

## Requirements

- **REQ-PM-01**: MUST support manual pairing via ticket/QR code
- **REQ-PM-02**: MUST persist known peers across restarts
- **REQ-PM-03**: MUST auto-reconnect to known peers on startup
- **REQ-PM-04**: MUST allow removing peers
- **REQ-PM-05**: MUST display peer connection status

## Peer Data Model

```typescript
interface Peer {
  /** Iroh NodeId (public key) */
  nodeId: string;

  /** User-assigned name for this peer */
  name: string;

  /** Last known connection ticket */
  ticket: string;

  /** When this peer was added */
  addedAt: string;

  /** Last successful sync timestamp */
  lastSyncAt: string | null;

  /** Whether to auto-connect on startup */
  autoConnect: boolean;
}

interface PeerState {
  /** Static peer info */
  peer: Peer;

  /** Current connection status */
  status: 'disconnected' | 'connecting' | 'connected' | 'syncing';

  /** Active connection if connected */
  connection: PeerConnection | null;

  /** Last error if any */
  lastError: string | null;
}
```

## Interface

```typescript
interface PeerManager {
  /**
   * Get all known peers.
   */
  getPeers(): Peer[];

  /**
   * Get current state of all peers.
   */
  getPeerStates(): PeerState[];

  /**
   * Add a new peer via their ticket.
   * @returns The new peer, or existing peer if already known
   */
  addPeer(ticket: string, name: string): Promise<Peer>;

  /**
   * Remove a peer and disconnect.
   */
  removePeer(nodeId: string): Promise<void>;

  /**
   * Update peer settings.
   */
  updatePeer(nodeId: string, updates: Partial<Pick<Peer, 'name' | 'autoConnect'>>): Promise<void>;

  /**
   * Manually trigger connection to a peer.
   */
  connectToPeer(nodeId: string): Promise<void>;

  /**
   * Disconnect from a peer (but keep in peer list).
   */
  disconnectPeer(nodeId: string): Promise<void>;

  /**
   * Connect to all auto-connect peers.
   */
  connectAll(): Promise<void>;

  /**
   * Subscribe to peer state changes.
   */
  onPeerStateChange(callback: (states: PeerState[]) => void): () => void;
}
```

## Pairing Flow

### Device A (Initiator)

```
1. User clicks "Add Device"
2. Generate ticket: transport.generateTicket()
3. Display as QR code + copyable text
4. Wait for incoming connection
5. On connect: add peer, start sync
```

### Device B (Joiner)

```
1. User clicks "Join Device"
2. Scan QR code or paste ticket
3. Connect: transport.connectWithTicket(ticket)
4. On connect: add peer, start sync
```

### Implementation

```typescript
class PeerManagerImpl implements PeerManager {
  private peers: Map<string, Peer> = new Map();
  private states: Map<string, PeerState> = new Map();
  private stateListeners: ((states: PeerState[]) => void)[] = [];

  async addPeer(ticket: string, name: string): Promise<Peer> {
    // Parse ticket to get NodeId
    const parsedTicket = Ticket.parse(ticket);
    const nodeId = parsedTicket.nodeAddr().nodeId().toString();

    // Check if already known
    if (this.peers.has(nodeId)) {
      return this.peers.get(nodeId)!;
    }

    // Create peer record
    const peer: Peer = {
      nodeId,
      name,
      ticket,
      addedAt: new Date().toISOString(),
      lastSyncAt: null,
      autoConnect: true,
    };

    // Persist
    this.peers.set(nodeId, peer);
    await this.savePeers();

    // Initialize state
    this.states.set(nodeId, {
      peer,
      status: 'disconnected',
      connection: null,
      lastError: null,
    });

    // Auto-connect
    this.connectToPeer(nodeId);

    this.notifyStateChange();
    return peer;
  }

  async connectToPeer(nodeId: string): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (!peer) throw new Error('Unknown peer');

    const state = this.states.get(nodeId)!;
    if (state.status === 'connected' || state.status === 'connecting') {
      return;
    }

    this.updateState(nodeId, { status: 'connecting', lastError: null });

    try {
      const connection = await this.transport.connectWithTicket(peer.ticket);

      this.updateState(nodeId, {
        status: 'connected',
        connection,
      });

      // Start sync
      this.syncEngine.syncWithPeer(connection);

      // Handle disconnection
      connection.onDisconnect(() => {
        this.handleDisconnect(nodeId);
      });
    } catch (err) {
      this.updateState(nodeId, {
        status: 'disconnected',
        lastError: err.message,
      });

      // Schedule retry
      this.scheduleReconnect(nodeId);
    }
  }

  private handleDisconnect(nodeId: string): void {
    this.updateState(nodeId, {
      status: 'disconnected',
      connection: null,
    });

    const peer = this.peers.get(nodeId);
    if (peer?.autoConnect) {
      this.scheduleReconnect(nodeId);
    }
  }

  private scheduleReconnect(nodeId: string): void {
    setTimeout(() => {
      const state = this.states.get(nodeId);
      if (state?.status === 'disconnected') {
        this.connectToPeer(nodeId);
      }
    }, 10000); // Retry after 10s
  }
}
```

## Persistence

Store peers in plugin data.json:

```typescript
// data.json
{
  "peers": [
    {
      "nodeId": "abc123...",
      "name": "MacBook Pro",
      "ticket": "iroh-ticket:...",
      "addedAt": "2024-01-15T10:30:00Z",
      "lastSyncAt": "2024-01-15T12:00:00Z",
      "autoConnect": true
    }
  ],
  "settings": {
    // other plugin settings
  }
}
```

```typescript
async savePeers(): Promise<void> {
  const data = await this.plugin.loadData() ?? {};
  data.peers = Array.from(this.peers.values());
  await this.plugin.saveData(data);
}

async loadPeers(): Promise<void> {
  const data = await this.plugin.loadData();
  if (data?.peers) {
    for (const peer of data.peers) {
      this.peers.set(peer.nodeId, peer);
      this.states.set(peer.nodeId, {
        peer,
        status: 'disconnected',
        connection: null,
        lastError: null,
      });
    }
  }
}
```

## Incoming Connections

Handle connections initiated by other peers:

```typescript
constructor(private transport: IrohTransport) {
  transport.onIncomingConnection(this.handleIncoming.bind(this));
}

private async handleIncoming(conn: PeerConnection): Promise<void> {
  const nodeId = conn.peerId;

  // Check if known peer
  if (!this.peers.has(nodeId)) {
    // Unknown peer - could prompt user or reject
    // For now, reject unknown peers
    console.log('Rejected unknown peer:', nodeId);
    conn.close();
    return;
  }

  // Update state
  this.updateState(nodeId, {
    status: 'connected',
    connection: conn,
  });

  // Start sync
  this.syncEngine.syncWithPeer(conn);
}
```

## Dependencies

- Iroh Transport (05-transport-iroh.md)
- Sync Engine (04-sync-protocol.md)
- Obsidian Plugin API for persistence

## Error Handling

| Error | Recovery |
|-------|----------|
| Invalid ticket | Show error, don't add peer |
| Connection refused | Retry with backoff |
| Peer removed during sync | Abort sync cleanly |

## Open Questions

1. **Unknown peer policy**: Prompt user to accept unknown incoming connections?
2. **Peer limits**: Maximum number of peers?
3. **Peer groups**: Support multiple vaults with different peer sets?
