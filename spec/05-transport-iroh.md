# Iroh Transport Spec

## Purpose

Define how Iroh is used for peer-to-peer connections, including initialization, connection establishment, and stream management.

## Requirements

### v1.0 (Core)
- **REQ-IR-01**: MUST use Iroh compiled to WASM for browser/Obsidian compatibility
- **REQ-IR-02**: MUST support relay-based connections as primary transport
- **REQ-IR-03**: MUST encrypt all traffic end-to-end (relay cannot decrypt)
- **REQ-IR-04**: MUST persist endpoint identity across restarts
- **REQ-IR-05**: MUST work on desktop, mobile (iOS/Android), and browser contexts

### v1.1 (Performance)
- **REQ-IR-06**: SHOULD support WebRTC for hole-punching (direct connections)
- **REQ-IR-07**: SHOULD use Happy Eyeballs to race transport options
- **REQ-IR-08**: SHOULD detect local network peers via mDNS (where available)
- **REQ-IR-09**: SHOULD compress sync messages >1KB
- **REQ-IR-10**: SHOULD multiplex document streams over single connection

### v1.2 (Optimization)
- **REQ-IR-11**: MAY throttle bandwidth on metered connections
- **REQ-IR-12**: MAY monitor connection quality and upgrade transports
- **REQ-IR-13**: MAY prioritize sync for currently-open files

## Version Roadmap

```
v1.0 ──────────────────────────────────────────────────────────►
  │ Iroh WASM relay-only
  │ Basic connection management
  │ Single transport
  │
v1.1 ──────────────────────────────────────────────────────────►
  │ + WebRTC hole-punching
  │ + Happy Eyeballs connection racing
  │ + Local network discovery (mDNS)
  │ + Message compression
  │ + Stream multiplexing
  │
v1.2 ──────────────────────────────────────────────────────────►
  │ + Bandwidth throttling
  │ + Connection quality monitoring
  │ + Adaptive transport switching
  │ + Priority sync for open files
```

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

---

# Advanced Transport Features (v1.1+)

The following sections describe optimizations planned for v1.1 and beyond. v1.0 uses Iroh relay-only for simplicity.

## Hybrid Transport Architecture

### Overview

Use WebRTC for hole-punching (works in WebViews), with Iroh relay as guaranteed fallback:

```
┌─────────────────────────────────────────────────────────────────┐
│                      Transport Layer                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐          │
│  │   WebRTC    │    │    Iroh     │    │   Local     │          │
│  │  (Direct)   │    │   (Relay)   │    │  (mDNS)     │          │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘          │
│         │                  │                  │                  │
│         └────────┬─────────┴─────────┬────────┘                  │
│                  │                   │                           │
│                  ▼                   ▼                           │
│         ┌──────────────┐    ┌──────────────┐                    │
│         │   Primary    │    │   Fallback   │                    │
│         │  Connection  │    │  Connection  │                    │
│         └──────────────┘    └──────────────┘                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
               ┌────────────────────────┐
               │  Unified Connection    │
               │     Interface          │
               └────────────────────────┘
                              │
                              ▼
               ┌────────────────────────┐
               │  Automerge Sync Layer  │
               │  (transport-agnostic)  │
               └────────────────────────┘
```

### Transport Priority

| Priority | Transport | Use Case | Latency |
|----------|-----------|----------|---------|
| 1 | Local (mDNS) | Same network | <5ms |
| 2 | WebRTC Direct | Hole-punch success | 20-100ms |
| 3 | Iroh Relay | Fallback | 50-200ms |

### Interface

```typescript
type TransportType = 'local' | 'webrtc-direct' | 'webrtc-relay' | 'iroh-relay';

interface TransportConnection {
  type: TransportType;
  peerId: string;
  stats: ConnectionStats;

  send(data: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array>;
  close(): Promise<void>;
}

interface TransportManager {
  /**
   * Connect to peer using best available transport.
   * Tries multiple transports in parallel (Happy Eyeballs).
   */
  connect(peerId: string, ticket: string): Promise<TransportConnection>;

  /**
   * Get current connection to peer, if any.
   */
  getConnection(peerId: string): TransportConnection | null;

  /**
   * Upgrade connection to better transport if available.
   */
  tryUpgrade(peerId: string): Promise<boolean>;
}
```

## Happy Eyeballs (Parallel Connection Racing)

### Concept

Don't wait for one transport to fail before trying another. Race them and use the winner.

Inspired by [RFC 8305](https://tools.ietf.org/html/rfc8305) (Happy Eyeballs for IPv4/IPv6).

### Algorithm

```typescript
interface ConnectionRace {
  /**
   * Race multiple connection attempts, return first success.
   */
  race(peerId: string, ticket: string): Promise<TransportConnection>;
}

class HappyEyeballs implements ConnectionRace {
  // Stagger delays to avoid unnecessary parallel attempts
  private static readonly STAGGER_DELAYS: Record<TransportType, number> = {
    'local': 0,           // Start immediately
    'webrtc-direct': 50,  // Start after 50ms
    'iroh-relay': 150,    // Start after 150ms (give direct a chance)
  };

  async race(peerId: string, ticket: string): Promise<TransportConnection> {
    const controller = new AbortController();
    const attempts: Promise<TransportConnection>[] = [];

    // Start local discovery immediately
    attempts.push(this.attemptLocal(peerId, controller.signal));

    // Start WebRTC after short delay
    attempts.push(
      this.delay(50).then(() =>
        this.attemptWebRTC(peerId, ticket, controller.signal)
      )
    );

    // Start Iroh relay as fallback
    attempts.push(
      this.delay(150).then(() =>
        this.attemptIrohRelay(peerId, ticket, controller.signal)
      )
    );

    try {
      // Promise.any returns first success, ignores failures
      const winner = await Promise.any(attempts);

      // Cancel other attempts
      controller.abort();

      console.log(`Connected via ${winner.type}`);
      return winner;
    } catch (err) {
      // All attempts failed
      throw new Error('All connection attempts failed');
    }
  }

  private async attemptLocal(
    peerId: string,
    signal: AbortSignal
  ): Promise<TransportConnection> {
    // Check if peer is on local network via mDNS
    const localAddr = await this.localDiscovery.findPeer(peerId, { signal });
    if (!localAddr) throw new Error('Peer not on local network');

    return this.connectLocal(localAddr, signal);
  }

  private async attemptWebRTC(
    peerId: string,
    ticket: string,
    signal: AbortSignal
  ): Promise<TransportConnection> {
    // Exchange SDP via Iroh relay, then attempt direct WebRTC
    const sdp = await this.exchangeSDP(peerId, ticket, signal);
    const conn = await this.webrtc.connect(sdp, signal);

    // Check if connection is direct or via TURN
    const type = conn.isRelayed ? 'webrtc-relay' : 'webrtc-direct';
    return { ...conn, type };
  }

  private async attemptIrohRelay(
    peerId: string,
    ticket: string,
    signal: AbortSignal
  ): Promise<TransportConnection> {
    const conn = await this.iroh.connectWithTicket(ticket, signal);
    return { ...conn, type: 'iroh-relay' };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Sequence Diagram

```
┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
│  App   │    │ Local  │    │ WebRTC │    │  Iroh  │
│        │    │ (mDNS) │    │        │    │ Relay  │
└───┬────┘    └───┬────┘    └───┬────┘    └───┬────┘
    │             │             │             │
    │ connect()   │             │             │
    │─────────────┼─────────────┼─────────────│
    │             │             │             │
    │ [t=0ms]     │             │             │
    │ try local   │             │             │
    │────────────►│             │             │
    │             │             │             │
    │ [t=50ms]    │             │             │
    │ try webrtc  │             │             │
    │─────────────┼────────────►│             │
    │             │             │             │
    │ [t=150ms]   │             │             │
    │ try relay   │             │             │
    │─────────────┼─────────────┼────────────►│
    │             │             │             │
    │             │ [t=80ms]    │             │
    │             │ local fails │             │
    │◄────────────│ (not found) │             │
    │             │             │             │
    │             │             │ [t=200ms]   │
    │             │             │ WebRTC      │
    │             │             │ succeeds!   │
    │◄────────────┼─────────────│             │
    │             │             │             │
    │ cancel      │             │             │
    │ other       │             │             │
    │ attempts    │             │             │
    │─────────────┼─────────────┼────────────►│
    │             │             │             │ (aborted)
    │             │             │             │
    │ return      │             │             │
    │ WebRTC conn │             │             │
    │◄────────────┼─────────────│             │
    │             │             │             │
```

## Local Network Discovery (mDNS)

### Purpose

When peers are on the same local network (WiFi), connect directly without any relay.

### Implementation

```typescript
interface LocalDiscovery {
  /**
   * Advertise this peer on local network.
   */
  advertise(nodeId: string, port: number): Promise<void>;

  /**
   * Find a peer on local network.
   */
  findPeer(nodeId: string, options?: { timeout?: number }): Promise<LocalPeerInfo | null>;

  /**
   * Stop advertising.
   */
  stopAdvertising(): Promise<void>;
}

interface LocalPeerInfo {
  nodeId: string;
  addresses: string[];  // Local IP addresses
  port: number;
}

// Browser implementation using mDNS (where available)
class BrowserLocalDiscovery implements LocalDiscovery {
  private serviceName = '_peervault._tcp.local';

  async advertise(nodeId: string, port: number): Promise<void> {
    // Note: mDNS not available in all browsers
    // Falls back to no-op on unsupported platforms
    if (!('NDNSServiceDiscovery' in navigator)) {
      console.log('mDNS not available, skipping local discovery');
      return;
    }

    // Register service
    await navigator.NDNSServiceDiscovery.register({
      name: nodeId.slice(0, 8),  // Short name
      type: this.serviceName,
      port,
      txt: { nodeId }
    });
  }

  async findPeer(nodeId: string, options?: { timeout?: number }): Promise<LocalPeerInfo | null> {
    if (!('NDNSServiceDiscovery' in navigator)) {
      return null;
    }

    const timeout = options?.timeout ?? 2000;

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);

      navigator.NDNSServiceDiscovery.browse(this.serviceName, (service) => {
        if (service.txt?.nodeId === nodeId) {
          clearTimeout(timer);
          resolve({
            nodeId,
            addresses: service.addresses,
            port: service.port
          });
        }
      });
    });
  }
}
```

### Platform Support

| Platform | mDNS Support | Notes |
|----------|--------------|-------|
| Desktop (Electron) | ✅ Full | Via Node.js `bonjour` package |
| iOS (WKWebView) | ⚠️ Limited | Requires native bridge |
| Android (WebView) | ⚠️ Limited | Requires native bridge |
| Browser | ❌ None | No mDNS API in browsers |

### Local Connection

When peers are discovered locally, connect directly via WebSocket or WebRTC:

```typescript
async connectLocal(peer: LocalPeerInfo): Promise<TransportConnection> {
  // Try WebSocket first (simpler)
  for (const addr of peer.addresses) {
    try {
      const ws = new WebSocket(`ws://${addr}:${peer.port}`);
      await this.waitForOpen(ws);

      return new LocalWebSocketConnection(ws, peer.nodeId);
    } catch {
      continue;  // Try next address
    }
  }

  throw new Error('Could not connect to local peer');
}
```

## Connection Quality Monitoring

### Stats Interface

```typescript
interface ConnectionStats {
  /** Transport type in use */
  transport: TransportType;

  /** Round-trip time in milliseconds */
  rttMs: number;

  /** Packet loss percentage (0-100) */
  packetLossPercent: number;

  /** Bytes sent since connection start */
  bytesSent: number;

  /** Bytes received since connection start */
  bytesReceived: number;

  /** Connection uptime in milliseconds */
  uptimeMs: number;

  /** Whether connection is currently healthy */
  isHealthy: boolean;
}

interface ConnectionMonitor {
  /**
   * Get current stats for a connection.
   */
  getStats(peerId: string): ConnectionStats | null;

  /**
   * Subscribe to stats updates.
   */
  onStatsUpdate(callback: (peerId: string, stats: ConnectionStats) => void): void;

  /**
   * Check if we should try to upgrade to a better transport.
   */
  shouldUpgrade(peerId: string): boolean;
}
```

### Implementation

```typescript
class ConnectionMonitorImpl implements ConnectionMonitor {
  private stats = new Map<string, ConnectionStats>();
  private pingIntervals = new Map<string, NodeJS.Timeout>();

  startMonitoring(peerId: string, conn: TransportConnection): void {
    // Ping every 5 seconds to measure RTT
    const interval = setInterval(async () => {
      const start = Date.now();

      try {
        await conn.ping();
        const rttMs = Date.now() - start;

        this.updateStats(peerId, { rttMs, isHealthy: true });
      } catch {
        this.updateStats(peerId, { isHealthy: false });
      }
    }, 5000);

    this.pingIntervals.set(peerId, interval);
  }

  shouldUpgrade(peerId: string): boolean {
    const stats = this.stats.get(peerId);
    if (!stats) return false;

    // Consider upgrade if:
    // 1. Currently on relay with high latency
    // 2. Connection has been stable for a while
    return (
      stats.transport === 'iroh-relay' &&
      stats.rttMs > 100 &&
      stats.uptimeMs > 30000 &&
      stats.isHealthy
    );
  }

  private updateStats(peerId: string, partial: Partial<ConnectionStats>): void {
    const current = this.stats.get(peerId) ?? this.defaultStats();
    const updated = { ...current, ...partial };
    this.stats.set(peerId, updated);

    this.emit('statsUpdate', peerId, updated);
  }
}
```

### Adaptive Transport Switching

```typescript
class AdaptiveTransport {
  private monitor: ConnectionMonitor;
  private connections: Map<string, TransportConnection>;

  async maybeUpgrade(peerId: string): Promise<void> {
    if (!this.monitor.shouldUpgrade(peerId)) return;

    const current = this.connections.get(peerId);
    if (!current) return;

    console.log(`Attempting upgrade for ${peerId} (current: ${current.type})`);

    try {
      // Try to establish a better connection
      const better = await this.happyEyeballs.raceWithout(
        peerId,
        current.type  // Exclude current transport
      );

      if (this.isBetter(better, current)) {
        // Migrate to new connection
        await this.migrateConnection(peerId, current, better);
        console.log(`Upgraded ${peerId} to ${better.type}`);
      } else {
        // New connection isn't better, close it
        await better.close();
      }
    } catch {
      // Upgrade failed, keep current connection
    }
  }

  private isBetter(
    candidate: TransportConnection,
    current: TransportConnection
  ): boolean {
    const priority: Record<TransportType, number> = {
      'local': 1,
      'webrtc-direct': 2,
      'webrtc-relay': 3,
      'iroh-relay': 4
    };

    return priority[candidate.type] < priority[current.type];
  }
}
```

## Bandwidth Throttling

### Purpose

Prevent sync from saturating the connection, especially on mobile/metered networks.

### Configuration

```typescript
interface ThrottleConfig {
  /** Maximum bytes per second for sync traffic */
  maxBytesPerSecond: number;

  /** Burst size in bytes (for short bursts above limit) */
  burstSize: number;

  /** Whether to detect metered connections and auto-throttle */
  autoDetectMetered: boolean;

  /** Throttle limit for metered connections */
  meteredBytesPerSecond: number;
}

const DEFAULT_THROTTLE: ThrottleConfig = {
  maxBytesPerSecond: 1024 * 1024,      // 1 MB/s default
  burstSize: 64 * 1024,                 // 64 KB burst
  autoDetectMetered: true,
  meteredBytesPerSecond: 256 * 1024,   // 256 KB/s on metered
};
```

### Token Bucket Implementation

```typescript
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillRate: number  // tokens per ms
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async consume(amount: number): Promise<void> {
    this.refill();

    while (this.tokens < amount) {
      // Wait for tokens to accumulate
      const needed = amount - this.tokens;
      const waitMs = needed / this.refillRate;
      await this.delay(Math.min(waitMs, 100));
      this.refill();
    }

    this.tokens -= amount;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate
    );
    this.lastRefill = now;
  }
}

class ThrottledStream implements SyncStream {
  constructor(
    private inner: SyncStream,
    private bucket: TokenBucket
  ) {}

  async send(data: Uint8Array): Promise<void> {
    await this.bucket.consume(data.length);
    return this.inner.send(data);
  }

  async receive(): Promise<Uint8Array> {
    // Don't throttle receives (backpressure handles this)
    return this.inner.receive();
  }
}
```

### Metered Connection Detection

```typescript
function isMeteredConnection(): boolean {
  // Check Navigator API (where available)
  if ('connection' in navigator) {
    const conn = (navigator as any).connection;

    // Explicit metered flag
    if (conn.saveData) return true;

    // Cellular connections are typically metered
    if (conn.type === 'cellular') return true;

    // Slow connections should be treated carefully
    if (conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g') {
      return true;
    }
  }

  return false;
}

class AdaptiveThrottle {
  private config: ThrottleConfig;
  private bucket: TokenBucket;

  constructor(config: ThrottleConfig = DEFAULT_THROTTLE) {
    this.config = config;
    this.updateBucket();

    // Listen for connection changes
    if ('connection' in navigator) {
      (navigator as any).connection.addEventListener('change', () => {
        this.updateBucket();
      });
    }
  }

  private updateBucket(): void {
    const rate = this.config.autoDetectMetered && isMeteredConnection()
      ? this.config.meteredBytesPerSecond
      : this.config.maxBytesPerSecond;

    this.bucket = new TokenBucket(
      this.config.burstSize,
      rate / 1000  // Convert to per-ms
    );

    console.log(`Throttle rate: ${rate} bytes/s (metered: ${isMeteredConnection()})`);
  }
}
```

## Message Compression

### Purpose

Reduce bandwidth usage by compressing sync messages. Automerge sync messages are binary but often compressible.

### Configuration

```typescript
interface CompressionConfig {
  /** Enable compression */
  enabled: boolean;

  /** Minimum message size to compress (small messages may grow) */
  minSizeBytes: number;

  /** Compression algorithm */
  algorithm: 'gzip' | 'deflate' | 'brotli';

  /** Compression level (1-9, higher = smaller but slower) */
  level: number;
}

const DEFAULT_COMPRESSION: CompressionConfig = {
  enabled: true,
  minSizeBytes: 1024,  // Don't compress < 1KB
  algorithm: 'gzip',
  level: 6,            // Balanced speed/ratio
};
```

### Implementation

```typescript
class CompressedStream implements SyncStream {
  constructor(
    private inner: SyncStream,
    private config: CompressionConfig
  ) {}

  async send(data: Uint8Array): Promise<void> {
    let payload: Uint8Array;
    let compressed = false;

    if (this.config.enabled && data.length >= this.config.minSizeBytes) {
      const compressedData = await this.compress(data);

      // Only use compression if it actually helps
      if (compressedData.length < data.length * 0.9) {
        payload = compressedData;
        compressed = true;
      } else {
        payload = data;
      }
    } else {
      payload = data;
    }

    // Frame format: [1 byte flags][payload]
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = compressed ? 0x01 : 0x00;
    frame.set(payload, 1);

    return this.inner.send(frame);
  }

  async receive(): Promise<Uint8Array> {
    const frame = await this.inner.receive();

    const compressed = frame[0] === 0x01;
    const payload = frame.slice(1);

    if (compressed) {
      return this.decompress(payload);
    }
    return payload;
  }

  private async compress(data: Uint8Array): Promise<Uint8Array> {
    // Use CompressionStream API (modern browsers)
    if ('CompressionStream' in globalThis) {
      const stream = new CompressionStream('gzip');
      const writer = stream.writable.getWriter();
      writer.write(data);
      writer.close();

      const chunks: Uint8Array[] = [];
      const reader = stream.readable.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      return this.concat(chunks);
    }

    // Fallback: use pako library
    return pako.gzip(data, { level: this.config.level });
  }

  private async decompress(data: Uint8Array): Promise<Uint8Array> {
    if ('DecompressionStream' in globalThis) {
      const stream = new DecompressionStream('gzip');
      const writer = stream.writable.getWriter();
      writer.write(data);
      writer.close();

      const chunks: Uint8Array[] = [];
      const reader = stream.readable.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      return this.concat(chunks);
    }

    return pako.ungzip(data);
  }
}
```

### Compression Ratios

Typical compression ratios for Automerge sync messages:

| Content Type | Uncompressed | Compressed | Ratio |
|--------------|--------------|------------|-------|
| Text changes | 10 KB | 3 KB | 70% |
| Binary (images) | 100 KB | 95 KB | 5% |
| Initial sync (text vault) | 1 MB | 300 KB | 70% |
| Incremental sync | 2 KB | 800 B | 60% |

## Connection Multiplexing

### Purpose

Use a single underlying connection for multiple document sync streams. Reduces connection overhead for large vaults.

### Design

```
┌─────────────────────────────────────────────────┐
│              Single QUIC Connection              │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Stream 1 │  │ Stream 2 │  │ Stream 3 │  ... │
│  │ (doc A)  │  │ (doc B)  │  │ (doc C)  │      │
│  └──────────┘  └──────────┘  └──────────┘      │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Interface

```typescript
interface MultiplexedConnection {
  /** Underlying transport connection */
  readonly transport: TransportConnection;

  /** Open a new stream for a document */
  openStream(docId: string): Promise<DocStream>;

  /** Accept incoming streams */
  onStream(callback: (docId: string, stream: DocStream) => void): void;

  /** Get existing stream for document */
  getStream(docId: string): DocStream | null;

  /** Close all streams and connection */
  close(): Promise<void>;
}

interface DocStream {
  /** Document ID this stream is for */
  readonly docId: string;

  /** Send sync message for this document */
  send(message: Uint8Array): Promise<void>;

  /** Receive sync message for this document */
  receive(): Promise<Uint8Array>;

  /** Close this stream (keeps connection open) */
  close(): Promise<void>;
}
```

### Stream Multiplexing Protocol

```typescript
// Message format for multiplexed streams
interface MultiplexFrame {
  /** Stream ID (hash of docId) */
  streamId: number;

  /** Frame type */
  type: 'open' | 'data' | 'close';

  /** Payload (for 'open': docId, for 'data': sync message) */
  payload: Uint8Array;
}

class Multiplexer {
  private streams = new Map<number, DocStreamImpl>();
  private nextStreamId = 1;

  constructor(private conn: TransportConnection) {
    this.startReadLoop();
  }

  async openStream(docId: string): Promise<DocStream> {
    const streamId = this.nextStreamId++;

    // Send open frame
    await this.sendFrame({
      streamId,
      type: 'open',
      payload: new TextEncoder().encode(docId)
    });

    const stream = new DocStreamImpl(streamId, docId, this);
    this.streams.set(streamId, stream);

    return stream;
  }

  private async startReadLoop(): Promise<void> {
    while (true) {
      try {
        const frame = await this.receiveFrame();

        switch (frame.type) {
          case 'open':
            const docId = new TextDecoder().decode(frame.payload);
            const stream = new DocStreamImpl(frame.streamId, docId, this);
            this.streams.set(frame.streamId, stream);
            this.emit('stream', docId, stream);
            break;

          case 'data':
            const target = this.streams.get(frame.streamId);
            target?.enqueue(frame.payload);
            break;

          case 'close':
            this.streams.get(frame.streamId)?.handleClose();
            this.streams.delete(frame.streamId);
            break;
        }
      } catch (err) {
        if (this.conn.isConnected()) {
          console.error('Multiplex read error:', err);
        }
        break;
      }
    }
  }

  private async sendFrame(frame: MultiplexFrame): Promise<void> {
    // Encode: [4 bytes streamId][1 byte type][payload]
    const typeCode = { 'open': 0, 'data': 1, 'close': 2 }[frame.type];
    const buf = new Uint8Array(5 + frame.payload.length);

    new DataView(buf.buffer).setUint32(0, frame.streamId, false);
    buf[4] = typeCode;
    buf.set(frame.payload, 5);

    await this.conn.send(buf);
  }
}
```

### Benefits

| Metric | Without Multiplexing | With Multiplexing |
|--------|---------------------|-------------------|
| Connections (100 docs) | 100 | 1 |
| Connection overhead | High | Low |
| Handshake time | Per document | Once |
| NAT mappings | 100 | 1 |

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
2. **Mobile battery**: Reduce connection keepalives on mobile? (Consider disconnecting when app backgrounded)
3. **WASM bundle size**: The Iroh WASM binary may be 2-5MB. Should we lazy-load it after plugin init?
4. **Relay trust**: Default Iroh relays are operated by n0. For privacy-sensitive users, should we document self-hosting?
5. **Compression library**: Use native CompressionStream API or bundle pako for broader compatibility?
6. **Priority sync**: Should currently-open files sync before background files?

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Direct connection vs relay-only | Relay-only for v1, hybrid for v1.1 | Ship simple first, add WebRTC hole-punching later |
| NPM package vs custom build | Custom wasm-bindgen wrapper | Iroh doesn't publish WASM to NPM |
| Desktop hole-punching | WebRTC in v1.1 | Works in WebViews where Iroh WASM cannot |
| Connection strategy | Happy Eyeballs (race transports) | Minimizes connection latency |
| Local network | mDNS discovery (where available) | Sub-5ms latency on same WiFi |
| Bandwidth control | Token bucket throttling | Prevents saturation, adapts to metered connections |
| Message size | Gzip compression for >1KB | 60-70% reduction for text sync messages |
| Multiple documents | Stream multiplexing | Single connection handles all docs |
| Connection health | RTT/packet loss monitoring | Enables adaptive transport switching |
