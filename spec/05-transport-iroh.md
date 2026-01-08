# Iroh Transport Spec

## Purpose

Define how Iroh is used for peer-to-peer connections, including initialization, connection establishment, and stream management.

## Requirements

- **REQ-IR-01**: MUST use Iroh compiled to WASM for browser/Obsidian compatibility
- **REQ-IR-02**: MUST support relay-based connections (hole-punching unavailable in browser)
- **REQ-IR-03**: MUST encrypt all traffic end-to-end (relay cannot decrypt)
- **REQ-IR-04**: MUST persist endpoint identity across restarts
- **REQ-IR-05**: MUST work on desktop, mobile (iOS/Android), and browser contexts

## Iroh WASM Status (as of v0.33, January 2025)

> **Important**: This section documents the current state of Iroh's WASM support, which affects our implementation approach.

### What Works

| Feature | Status | Notes |
|---------|--------|-------|
| WASM compilation | ✅ Stable | As of iroh 0.33 |
| Browser support | ✅ Alpha | Via wasm-bindgen |
| Relay connections | ✅ Works | All browser traffic flows through relays |
| End-to-end encryption | ✅ Works | Relay cannot decrypt |
| iroh-gossip | ✅ Works | WASM-compatible as of 0.33 |

### What Doesn't Work in Browser/WASM

| Feature | Status | Reason |
|---------|--------|--------|
| Direct UDP | ❌ | Browser sandbox restriction |
| Hole-punching | ❌ | Requires direct UDP |
| Local network discovery | ❌ | `discovery-local-network` feature unavailable |
| DHT discovery | ❌ | `discovery-dht` feature unavailable |

### Implementation Constraints

1. **No NPM Package**: Iroh does not publish WASM builds to NPM. We must create a custom Rust wrapper crate using `wasm-bindgen`.

2. **Relay-Only Mode**: In browser contexts, ALL connections flow through relay servers. This is unavoidable but connections remain encrypted.

3. **Feature Flags**: Must use `iroh = { version = "0.33", default-features = false }` for WASM builds.

4. **Desktop Advantage**: On Electron desktop (not mobile), we *could* use native Iroh for hole-punching, but this adds complexity. For v1, we use relay-only everywhere for consistency.

### References

- [Iroh WASM/Browser Support Docs](https://docs.iroh.computer/deployment/wasm-browser-support)
- [iroh-examples (browser demos)](https://github.com/n0-computer/iroh-examples)
- [Common WASM Troubleshooting](https://github.com/n0-computer/iroh/discussions/3200)

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
// Import from our custom WASM wrapper (see Dependencies section)
import { Endpoint, SecretKey } from 'peervault-iroh';

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

## Sequence Diagrams

### Endpoint Initialization

```
┌────────────┐     ┌────────────┐     ┌────────────┐     ┌────────────┐
│  Plugin    │     │   Iroh     │     │  Storage   │     │   Iroh     │
│   Load     │     │ Transport  │     │            │     │   WASM     │
└─────┬──────┘     └─────┬──────┘     └─────┬──────┘     └─────┬──────┘
      │                  │                  │                  │
      │ initialize()     │                  │                  │
      │─────────────────►│                  │                  │
      │                  │                  │                  │
      │                  │ loadSecretKey()  │                  │
      │                  │─────────────────►│                  │
      │                  │                  │                  │
      │                  │ [if exists]      │                  │
      │                  │◄─────────────────│                  │
      │                  │                  │                  │
      │                  │ [if not exists]  │                  │
      │                  │ generate key     │                  │
      │                  │─────────┐        │                  │
      │                  │         │        │                  │
      │                  │◄────────┘        │                  │
      │                  │                  │                  │
      │                  │ saveSecretKey()  │                  │
      │                  │─────────────────►│                  │
      │                  │                  │                  │
      │                  │ Endpoint.create()│                  │
      │                  │─────────────────────────────────────►
      │                  │                  │                  │
      │                  │                  │     load WASM    │
      │                  │                  │    ┌─────────────│
      │                  │                  │    │             │
      │                  │                  │    └────────────►│
      │                  │                  │                  │
      │                  │◄─────────────────────────────────────
      │                  │                  │   endpoint ready │
      │                  │                  │                  │
      │                  │ startAcceptLoop()│                  │
      │                  │─────────┐        │                  │
      │                  │         │        │                  │
      │                  │◄────────┘        │                  │
      │                  │                  │                  │
      │◄─────────────────│                  │                  │
      │    ready         │                  │                  │
      │                  │                  │                  │
```

### Connection Establishment (Browser/WASM - Relay Only)

> **Note**: In browser/WASM contexts, all connections are relayed. Hole-punching requires direct UDP access which browsers don't permit.

```
┌────────┐           ┌─────────┐           ┌────────┐
│ Peer A │           │  Relay  │           │ Peer B │
│(Browser)│          │ Server  │           │(Browser)│
└───┬────┘           └────┬────┘           └───┬────┘
    │                     │                    │
    │  WebSocket connect  │                    │
    │────────────────────►│                    │
    │                     │                    │
    │  Register NodeId    │                    │
    │────────────────────►│                    │
    │                     │                    │
    │                     │  WebSocket connect │
    │                     │◄───────────────────│
    │                     │                    │
    │                     │  Register NodeId   │
    │                     │◄───────────────────│
    │                     │                    │
    │  Connect to Peer B  │                    │
    │  (via ticket)       │                    │
    │────────────────────►│                    │
    │                     │                    │
    │                     │  Forward to B      │
    │                     │───────────────────►│
    │                     │                    │
    │                     │  Accept connection │
    │                     │◄───────────────────│
    │                     │                    │
    │◄════ All traffic relayed (encrypted) ═══►│
    │                     │                    │
    │  E2E Encrypted      │  Cannot decrypt    │
    │  (peer keys)        │  (relay is blind)  │
    │                     │                    │
    │        TLS 1.3 + QUIC over WebSocket     │
    │◄════════════════════════════════════════►│
    │                     │                    │
```

### Connection Establishment (Native Desktop - With Hole Punching)

> **Note**: On native desktop (Electron main process), direct UDP is available and hole-punching can succeed.

```
┌────────┐           ┌─────────┐           ┌────────┐
│ Peer A │           │  Relay  │           │ Peer B │
│(Desktop)│          │ Server  │           │(Desktop)│
└───┬────┘           └────┬────┘           └───┬────┘
    │                     │                    │
    │  Register with relay                     │
    │────────────────────►│                    │
    │                     │                    │
    │                     │  Register with relay
    │                     │◄───────────────────│
    │                     │                    │
    │  Connect to Peer B  │                    │
    │  (via ticket)       │                    │
    │────────────────────►│                    │
    │                     │                    │
    │                     │  Forward connection│
    │                     │  request to B      │
    │                     │───────────────────►│
    │                     │                    │
    │       HOLE PUNCHING ATTEMPT              │
    │◄─────────── UDP probes ─────────────────►│
    │                     │                    │
    │ [if hole-punch succeeds]                 │
    │◄═══════ Direct P2P (UDP/QUIC) ══════════►│
    │         (relay not used)                 │
    │                     │                    │
    │ [if hole-punch fails]                    │
    │◄════ Relayed Connection via Server ═════►│
    │                     │                    │
```

### Stream Communication

```
┌────────┐                                              ┌────────┐
│ Peer A │                                              │ Peer B │
└───┬────┘                                              └───┬────┘
    │                                                       │
    │                  QUIC Connection                      │
    │◄═════════════════════════════════════════════════════►│
    │                                                       │
    │  openStream()                                         │
    │─────────┐                                             │
    │         │                                             │
    │◄────────┘                                             │
    │                                                       │
    │ ─────────────── Stream Open Request ───────────────►  │
    │                                                       │
    │                               acceptStream()          │
    │                               ┌───────────────────────│
    │                               │                       │
    │                               └──────────────────────►│
    │                                                       │
    │ ◄─────────────── Stream Accepted ────────────────────│
    │                                                       │
    │                                                       │
    │  send(data)                                           │
    │─────────┐                                             │
    │ [frame: │                                             │
    │  4-byte │                                             │
    │  len +  │                                             │
    │  data]  │                                             │
    │◄────────┘                                             │
    │                                                       │
    │ ─────────────── [len][payload] ────────────────────►  │
    │                                                       │
    │                                        receive()      │
    │                                    ┌───────────────────│
    │                                    │ [read 4 bytes]   │
    │                                    │ [read len bytes] │
    │                                    └──────────────────►│
    │                                                       │
    │ ◄─────────────── [len][payload] ────────────────────  │
    │                                                       │
    │  close()                                              │
    │ ─────────────── Stream FIN ────────────────────────►  │
    │                                                       │
```

### Error Recovery Flow

```
┌────────┐     ┌────────────┐     ┌────────────┐
│ Peer A │     │ Connection │     │ Reconnect  │
│        │     │  Manager   │     │   Timer    │
└───┬────┘     └─────┬──────┘     └─────┬──────┘
    │                │                  │
    │  connected     │                  │
    │═══════════════►│                  │
    │                │                  │
    │  network error │                  │
    │───────────────►│                  │
    │                │                  │
    │                │ scheduleReconnect│
    │                │─────────────────►│
    │                │                  │
    │                │                  │ wait 5s
    │                │                  │────┐
    │                │                  │    │
    │                │                  │◄───┘
    │                │                  │
    │                │  try reconnect   │
    │                │◄─────────────────│
    │                │                  │
    │  [attempt 1]   │                  │
    │◄───────────────│                  │
    │                │                  │
    │  fail          │                  │
    │───────────────►│                  │
    │                │                  │
    │                │ scheduleReconnect│
    │                │─────────────────►│
    │                │                  │
    │                │                  │ wait 10s (backoff)
    │                │                  │────┐
    │                │                  │    │
    │                │                  │◄───┘
    │                │                  │
    │  [attempt 2]   │                  │
    │◄───────────────│                  │
    │                │                  │
    │  success       │                  │
    │═══════════════►│                  │
    │                │                  │
    │                │ cancelTimer      │
    │                │─────────────────►│
    │                │                  │
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

### WASM Build (Custom)

Iroh does not publish WASM bindings to NPM. We need to create a custom Rust wrapper crate:

```
peervault-iroh/
├── Cargo.toml           # Rust crate with wasm-bindgen
├── src/
│   └── lib.rs           # Wrapper exposing Iroh to JS
├── pkg/                 # Generated by wasm-pack
│   ├── peervault_iroh.js
│   ├── peervault_iroh.d.ts
│   └── peervault_iroh_bg.wasm
└── build.sh             # wasm-pack build --target web
```

**Cargo.toml (key dependencies):**
```toml
[package]
name = "peervault-iroh"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
iroh = { version = "0.33", default-features = false }
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
js-sys = "0.3"
web-sys = { version = "0.3", features = ["console"] }
getrandom = { version = "0.2", features = ["js"] }

[profile.release]
opt-level = "s"      # Optimize for size
lto = true           # Link-time optimization
```

**Build command:**
```bash
wasm-pack build --target web --release
```

The generated `pkg/` folder is then included in the Obsidian plugin's build.

## Error Handling

| Error | Recovery | Context |
|-------|----------|---------|
| WASM load failure | Surface error, suggest reload | All platforms |
| WASM instantiation OOM | Reduce concurrent operations, surface memory warning | Mobile especially |
| Relay unreachable | Retry with backoff, try alternate relay | Browser (no fallback to direct) |
| All relays unavailable | Surface offline status, queue changes | Browser |
| Connection timeout | Retry with exponential backoff (max 60s) | All platforms |
| Peer not responding | Mark peer offline, continue retry in background | All platforms |
| WebSocket closed unexpectedly | Reconnect automatically | Browser |
| Hole-punch fails | Fall back to relay (automatic) | Desktop native only |

## Open Questions

1. **Custom relays**: Allow users to specify their own relay server? (Iroh supports this via `RelayUrl`)
2. **Bandwidth monitoring**: Expose connection stats to UI? (Iroh provides `Connection::stats()`)
3. **Mobile battery**: Reduce connection keepalives on mobile? (Consider disconnecting when app backgrounded)
4. **WASM bundle size**: The Iroh WASM binary may be 2-5MB. Should we lazy-load it after plugin init?
5. **Relay trust**: Default Iroh relays are operated by n0. For privacy-sensitive users, should we document self-hosting?
6. **Native desktop optimization**: Worth implementing hybrid mode (native Iroh for desktop, WASM for mobile) in v2?

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Direct connection vs relay-only | Relay-only for v1 | Browser/WASM cannot do hole-punching; simplifies implementation |
| NPM package vs custom build | Custom wasm-bindgen wrapper | Iroh doesn't publish WASM to NPM |
| Desktop hole-punching | Deferred to v2 | Adds complexity; relay works everywhere |
