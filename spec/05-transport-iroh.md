# Iroh Transport Spec

## Purpose

Define how Iroh is used for peer-to-peer connections, including initialization, connection establishment, and stream management.

## Requirements

- **REQ-IR-01**: MUST use pure WASM Iroh (no native sidecar)
- **REQ-IR-02**: MUST support NAT traversal via hole-punching
- **REQ-IR-03**: MUST fall back to relay when direct connection fails
- **REQ-IR-04**: MUST encrypt all traffic (Iroh default)
- **REQ-IR-05**: MUST persist endpoint identity across restarts

## Iroh Concepts

| Concept | Description |
|---------|-------------|
| **Endpoint** | Your network identity (public key + connection info) |
| **NodeId** | Public key identifying a peer |
| **Ticket** | Serialized connection info (NodeId + relay hints) |
| **Stream** | Bidirectional byte stream between endpoints |
| **ALPN** | Protocol identifier for connection multiplexing |

## ALPN Protocol

We define a custom ALPN for PeerVault sync:

```typescript
const PEERVAULT_ALPN = new TextEncoder().encode('peervault/sync/1');
```

## Interface

```typescript
interface IrohTransport {
  /**
   * Initialize Iroh endpoint. Call once on plugin load.
   */
  initialize(): Promise<void>;

  /**
   * Get this device's NodeId.
   */
  getNodeId(): string;

  /**
   * Generate a connection ticket for pairing.
   */
  generateTicket(): Promise<string>;

  /**
   * Connect to a peer using their ticket.
   */
  connectWithTicket(ticket: string): Promise<PeerConnection>;

  /**
   * Accept incoming connections.
   */
  onIncomingConnection(callback: (conn: PeerConnection) => void): void;

  /**
   * Shut down the endpoint.
   */
  shutdown(): Promise<void>;
}

interface PeerConnection {
  /** Remote peer's NodeId */
  peerId: string;

  /** Open a new bidirectional stream */
  openStream(): Promise<SyncStream>;

  /** Accept an incoming stream */
  acceptStream(): Promise<SyncStream>;

  /** Close the connection */
  close(): Promise<void>;

  /** Connection state */
  isConnected(): boolean;
}

interface SyncStream {
  /** Send bytes */
  send(data: Uint8Array): Promise<void>;

  /** Receive bytes */
  receive(): Promise<Uint8Array>;

  /** Close the stream */
  close(): Promise<void>;
}
```

## Implementation

### Endpoint Initialization

```typescript
import { Endpoint, SecretKey } from '@aspect/iroh';

class IrohTransportImpl implements IrohTransport {
  private endpoint: Endpoint | null = null;
  private secretKey: SecretKey | null = null;

  async initialize(): Promise<void> {
    // Load or generate secret key
    this.secretKey = await this.loadOrCreateSecretKey();

    // Create endpoint with our key
    this.endpoint = await Endpoint.create({
      secretKey: this.secretKey,
      alpns: [PEERVAULT_ALPN],
      // Use default Iroh relays
      relayMode: 'default',
    });

    // Start accepting connections
    this.startAcceptLoop();
  }

  private async loadOrCreateSecretKey(): Promise<SecretKey> {
    const stored = await this.storage.loadSecretKey();
    if (stored) {
      return SecretKey.fromBytes(stored);
    }

    const key = SecretKey.generate();
    await this.storage.saveSecretKey(key.toBytes());
    return key;
  }

  getNodeId(): string {
    return this.endpoint!.nodeId().toString();
  }
}
```

### Ticket Generation

Tickets contain everything needed to connect:

```typescript
async generateTicket(): Promise<string> {
  // Get our addressing info
  const nodeAddr = await this.endpoint!.nodeAddr();

  // Serialize to ticket string
  return nodeAddr.toTicket().toString();
}
```

### Connecting to Peer

```typescript
async connectWithTicket(ticketStr: string): Promise<PeerConnection> {
  const ticket = Ticket.parse(ticketStr);
  const nodeAddr = ticket.nodeAddr();

  // Connect with our ALPN
  const connection = await this.endpoint!.connect(nodeAddr, PEERVAULT_ALPN);

  return new PeerConnectionImpl(connection, nodeAddr.nodeId().toString());
}
```

### Connection Handler

```typescript
private async startAcceptLoop(): Promise<void> {
  while (this.endpoint) {
    try {
      const incoming = await this.endpoint.accept();
      if (!incoming) continue;

      const connection = await incoming.accept();
      const peerId = incoming.remoteNodeId().toString();

      const peerConn = new PeerConnectionImpl(connection, peerId);
      this.emitIncomingConnection(peerConn);
    } catch (err) {
      console.error('Accept error:', err);
    }
  }
}
```

### Stream Implementation

```typescript
class SyncStreamImpl implements SyncStream {
  constructor(
    private sendStream: SendStream,
    private recvStream: RecvStream
  ) {}

  async send(data: Uint8Array): Promise<void> {
    // Frame the message: 4-byte length prefix + data
    const frame = new Uint8Array(4 + data.length);
    new DataView(frame.buffer).setUint32(0, data.length, false);
    frame.set(data, 4);

    await this.sendStream.write(frame);
  }

  async receive(): Promise<Uint8Array> {
    // Read length prefix
    const lenBuf = await this.recvStream.readExact(4);
    const len = new DataView(lenBuf.buffer).getUint32(0, false);

    // Read message body
    return this.recvStream.readExact(len);
  }

  async close(): Promise<void> {
    await this.sendStream.finish();
  }
}
```

## Connection States

```
┌──────────────┐
│ Disconnected │
└──────┬───────┘
       │ connectWithTicket() or incoming
       ▼
┌──────────────┐
│  Connecting  │──────► Connection failed
└──────┬───────┘
       │ success
       ▼
┌──────────────┐
│  Connected   │◄────── Reconnect
└──────┬───────┘
       │ network error / close
       ▼
┌──────────────┐
│ Disconnected │
└──────────────┘
```

## Reconnection

Maintain connection to known peers:

```typescript
class ConnectionManager {
  private peers = new Map<string, PeerConnection>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  async maintainConnection(peerId: string, ticket: string): Promise<void> {
    if (this.peers.get(peerId)?.isConnected()) {
      return;
    }

    try {
      const conn = await this.transport.connectWithTicket(ticket);
      this.peers.set(peerId, conn);

      // Monitor for disconnection
      conn.onDisconnect(() => {
        this.scheduleReconnect(peerId, ticket);
      });
    } catch (err) {
      this.scheduleReconnect(peerId, ticket);
    }
  }

  private scheduleReconnect(peerId: string, ticket: string): void {
    const timer = setTimeout(() => {
      this.maintainConnection(peerId, ticket);
    }, 5000); // Retry after 5s

    this.reconnectTimers.set(peerId, timer);
  }
}
```

## Security Considerations

- All Iroh connections are encrypted with the peer's public key
- NodeIds are derived from public keys (tampering detectable)
- Tickets can be shared via secure channel (QR code, encrypted message)
- Consider adding application-level authentication for vault access

## Dependencies

- `@aspect/iroh` - Iroh WASM bindings

## Error Handling

| Error | Recovery |
|-------|----------|
| WASM load failure | Surface error, suggest reload |
| Relay unreachable | Try direct connection, retry relay |
| Hole-punch fails | Fall back to relay |
| Connection timeout | Retry with exponential backoff |

## Open Questions

1. **Custom relays**: Allow users to specify their own relay server?
2. **Bandwidth monitoring**: Expose connection stats to UI?
3. **Mobile battery**: Reduce connection keepalives on mobile?
