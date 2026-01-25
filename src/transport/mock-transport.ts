/**
 * Mock Transport Implementation
 *
 * A mock transport for development and testing that simulates
 * peer-to-peer connections in memory.
 */

import type {
  Transport,
  PeerConnection,
  SyncStream,
  TransportConfig,
  ConnectionState,
} from './types';

/** Registry of mock transports for local testing */
const mockRegistry = new Map<string, MockTransport>();

/**
 * Generate a random node ID.
 */
function generateNodeId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Mock transport implementation for development/testing.
 */
export class MockTransport implements Transport {
  private nodeId: string;
  private connections = new Map<string, MockPeerConnection>();
  private incomingCallbacks: Array<(conn: PeerConnection) => void> = [];
  private ready = false;
  private config: TransportConfig;

  constructor(config: TransportConfig) {
    this.config = config;
    this.nodeId = generateNodeId();
  }

  async initialize(): Promise<void> {
    // Try to load existing key, or generate new one
    const storedKey = await this.config.storage.loadSecretKey();
    if (storedKey && storedKey.length === 16) {
      // Derive node ID from stored key (convert 16 bytes to 32 hex chars)
      this.nodeId = Array.from(storedKey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } else {
      // Save the generated key (convert 32 hex chars to 16 bytes)
      const keyBytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        keyBytes[i] = parseInt(this.nodeId.slice(i * 2, i * 2 + 2), 16);
      }
      await this.config.storage.saveSecretKey(keyBytes);
    }

    // Register in mock registry for local connections
    mockRegistry.set(this.nodeId, this);

    this.ready = true;
    this.config.logger.info('MockTransport initialized with nodeId:', this.nodeId);
  }

  getNodeId(): string {
    return this.nodeId;
  }

  async generateTicket(): Promise<string> {
    // Simple ticket format: mock://<nodeId>
    return `mock://${this.nodeId}`;
  }

  async connectWithTicket(ticket: string): Promise<PeerConnection> {
    // Parse ticket
    const match = ticket.match(/^mock:\/\/([a-f0-9]+)$/);
    if (!match) {
      throw new Error(`Invalid mock ticket format: ${ticket}`);
    }

    const peerId = match[1]!;

    // Check if already connected
    const existing = this.connections.get(peerId);
    if (existing?.isConnected()) {
      return existing;
    }

    // Find peer in registry
    const peerTransport = mockRegistry.get(peerId);
    if (!peerTransport) {
      throw new Error(`Peer not found: ${peerId}`);
    }

    // Create bidirectional connection
    const [connA, connB] = createMockConnectionPair(this.nodeId, peerId);

    // Store our side
    this.connections.set(peerId, connA);
    peerTransport.connections.set(this.nodeId, connB);

    // Notify peer of incoming connection
    peerTransport.notifyIncoming(connB);

    this.config.logger.info('Connected to peer:', peerId);
    return connA;
  }

  onIncomingConnection(callback: (conn: PeerConnection) => void): void {
    this.incomingCallbacks.push(callback);
  }

  private notifyIncoming(conn: MockPeerConnection): void {
    for (const callback of this.incomingCallbacks) {
      try {
        callback(conn);
      } catch (err) {
        this.config.logger.error('Error in incoming connection callback:', err);
      }
    }
  }

  getConnections(): PeerConnection[] {
    return Array.from(this.connections.values()).filter((c) => c.isConnected());
  }

  getConnection(peerId: string): PeerConnection | undefined {
    const conn = this.connections.get(peerId);
    return conn?.isConnected() ? conn : undefined;
  }

  async shutdown(): Promise<void> {
    // Close all connections
    for (const conn of this.connections.values()) {
      await conn.close();
    }
    this.connections.clear();

    // Unregister from mock registry
    mockRegistry.delete(this.nodeId);

    this.ready = false;
    this.config.logger.info('MockTransport shut down');
  }

  isReady(): boolean {
    return this.ready;
  }
}

/**
 * Create a pair of connected mock connections.
 */
function createMockConnectionPair(
  idA: string,
  idB: string
): [MockPeerConnection, MockPeerConnection] {
  const connA = new MockPeerConnection(idB);
  const connB = new MockPeerConnection(idA);

  // Link them together
  connA.setPeer(connB);
  connB.setPeer(connA);

  return [connA, connB];
}

/**
 * Mock peer connection implementation.
 */
class MockPeerConnection implements PeerConnection {
  readonly peerId: string;
  state: ConnectionState = 'connected';

  private peer: MockPeerConnection | null = null;
  private streams = new Map<string, MockSyncStream>();
  private pendingStreams: MockSyncStream[] = [];
  private stateCallbacks: Array<(state: ConnectionState) => void> = [];
  private streamCallbacks: Array<(stream: SyncStream) => void> = [];
  private streamCounter = 0;

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  setPeer(peer: MockPeerConnection): void {
    this.peer = peer;
  }

  async openStream(): Promise<SyncStream> {
    if (!this.peer || this.state !== 'connected') {
      throw new Error('Connection not active');
    }

    // Create paired streams
    const streamId = `${this.peerId}-${++this.streamCounter}`;
    const [streamA, streamB] = createMockStreamPair(streamId);

    // Store our side
    this.streams.set(streamId, streamA);

    // Notify peer of incoming stream
    this.peer.receiveStream(streamB);

    return streamA;
  }

  async acceptStream(): Promise<SyncStream> {
    // Wait for a pending stream
    if (this.pendingStreams.length > 0) {
      return this.pendingStreams.shift()!;
    }

    // Wait for incoming stream
    return new Promise((resolve) => {
      const handler = (stream: SyncStream) => {
        resolve(stream);
        // Remove this one-time handler
        const idx = this.streamCallbacks.indexOf(handler);
        if (idx >= 0) this.streamCallbacks.splice(idx, 1);
      };
      this.streamCallbacks.push(handler);
    });
  }

  private receiveStream(stream: MockSyncStream): void {
    this.pendingStreams.push(stream);

    // Notify callbacks
    for (const callback of this.streamCallbacks) {
      callback(stream);
    }
  }

  async close(): Promise<void> {
    if (this.state === 'disconnected') return;

    this.state = 'disconnected';

    // Close all streams
    for (const stream of this.streams.values()) {
      await stream.close();
    }
    this.streams.clear();

    // Notify state change
    for (const callback of this.stateCallbacks) {
      callback('disconnected');
    }

    // Notify peer
    if (this.peer && this.peer.state !== 'disconnected') {
      this.peer.handlePeerDisconnect();
    }
  }

  private handlePeerDisconnect(): void {
    this.state = 'disconnected';
    for (const callback of this.stateCallbacks) {
      callback('disconnected');
    }
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  onStateChange(callback: (state: ConnectionState) => void): void {
    this.stateCallbacks.push(callback);
  }

  onStream(callback: (stream: SyncStream) => void): void {
    this.streamCallbacks.push(callback);
  }
}

/**
 * Create a pair of connected mock streams.
 */
function createMockStreamPair(id: string): [MockSyncStream, MockSyncStream] {
  const streamA = new MockSyncStream(`${id}-a`);
  const streamB = new MockSyncStream(`${id}-b`);

  // Link them together
  streamA.setPeer(streamB);
  streamB.setPeer(streamA);

  return [streamA, streamB];
}

/**
 * Mock sync stream implementation.
 */
class MockSyncStream implements SyncStream {
  readonly id: string;

  private peer: MockSyncStream | null = null;
  private messageQueue: Uint8Array[] = [];
  private waitingResolvers: Array<(data: Uint8Array) => void> = [];
  private open = true;

  constructor(id: string) {
    this.id = id;
  }

  setPeer(peer: MockSyncStream): void {
    this.peer = peer;
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.open) {
      throw new Error('Stream is closed');
    }
    if (!this.peer) {
      throw new Error('Stream not connected');
    }

    // Deliver to peer
    this.peer.receiveData(data);
  }

  private receiveData(data: Uint8Array): void {
    if (this.waitingResolvers.length > 0) {
      // Someone is waiting, deliver immediately
      const resolver = this.waitingResolvers.shift()!;
      resolver(data);
    } else {
      // Queue for later
      this.messageQueue.push(data);
    }
  }

  async receive(): Promise<Uint8Array> {
    if (!this.open) {
      throw new Error('Stream is closed');
    }

    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }

    // Wait for data
    return new Promise((resolve) => {
      this.waitingResolvers.push(resolve);
    });
  }

  async close(): Promise<void> {
    this.open = false;

    // Reject any waiting receivers
    while (this.waitingResolvers.length > 0) {
      // They'll get an error on next call
    }
  }

  isOpen(): boolean {
    return this.open;
  }
}

/**
 * Helper to clear mock registry (for tests).
 */
export function clearMockRegistry(): void {
  mockRegistry.clear();
}
