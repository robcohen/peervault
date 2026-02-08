/**
 * Mock Peer Connection
 *
 * In-memory PeerConnection implementation for testing.
 * Connections come in linked pairs where stream operations on one side
 * are visible on the other.
 */

import type { PeerConnection, ConnectionState, ConnectionType, SyncStream } from "../types";
import { MockSyncStream, createMockStreamPair, type MockStreamConfig } from "./mock-stream";

/**
 * Configuration for mock connection behavior.
 */
export interface MockConnectionConfig {
  /** Simulated RTT in milliseconds (default: 1) */
  rttMs?: number;

  /** Stream configuration passed to created streams */
  streamConfig?: MockStreamConfig;

  /** Maximum queued streams before blocking (default: 100) */
  maxQueuedStreams?: number;
}

/**
 * Mock PeerConnection implementation.
 *
 * Use createMockConnectionPair() to create linked connection pairs for testing.
 */
export class MockPeerConnection implements PeerConnection {
  readonly peerId: string;
  protected _state: ConnectionState = "connected";
  protected localNodeId: string;
  protected config: MockConnectionConfig;

  // Linked remote connection
  protected remoteSide: MockPeerConnection | null = null;

  // Stream management
  protected streamCounter = 0;
  protected pendingStreams: MockSyncStream[] = [];
  protected streamCallbacks: Array<(stream: SyncStream) => void> = [];
  protected stateCallbacks: Array<(state: ConnectionState) => void> = [];

  // For acceptStream blocking
  private acceptResolvers: Array<{
    resolve: (stream: SyncStream) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(
    peerId: string,
    localNodeId: string,
    config: MockConnectionConfig = {},
  ) {
    this.peerId = peerId;
    this.localNodeId = localNodeId;
    this.config = {
      rttMs: 1,
      maxQueuedStreams: 100,
      ...config,
    };
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Link this connection to its remote counterpart.
   */
  linkRemote(remote: MockPeerConnection): void {
    this.remoteSide = remote;
  }

  /**
   * Open a new stream to the remote peer.
   */
  async openStream(): Promise<SyncStream> {
    if (this._state !== "connected") {
      throw new Error(`Connection to ${this.peerId} is not connected (state: ${this._state})`);
    }

    if (!this.remoteSide) {
      throw new Error(`Connection to ${this.peerId} has no remote side linked`);
    }

    const streamId = `${this.localNodeId.slice(0, 8)}-out-${++this.streamCounter}`;
    const remoteStreamId = `${this.peerId.slice(0, 8)}-in-${this.streamCounter}`;

    const { streamA, streamB } = createMockStreamPair(
      streamId,
      remoteStreamId,
      this.config.streamConfig,
    );

    // Deliver the remote end to the other connection
    this.remoteSide._deliverIncomingStream(streamB);

    return streamA;
  }

  /**
   * Accept an incoming stream from the remote peer.
   */
  async acceptStream(): Promise<SyncStream> {
    if (this._state !== "connected") {
      throw new Error(`Connection to ${this.peerId} is not connected (state: ${this._state})`);
    }

    // Check if there's a pending stream
    const pending = this.pendingStreams.shift();
    if (pending) {
      return pending;
    }

    // Wait for an incoming stream
    return new Promise<SyncStream>((resolve, reject) => {
      if (this._state !== "connected") {
        reject(new Error(`Connection to ${this.peerId} closed while waiting for stream`));
        return;
      }
      this.acceptResolvers.push({ resolve, reject });
    });
  }

  /**
   * Close the connection.
   */
  async close(): Promise<void> {
    if (this._state === "disconnected") return;

    this._state = "disconnected";

    // Reject pending accept resolvers
    const error = new Error(`Connection to ${this.peerId} closed`);
    for (const resolver of this.acceptResolvers) {
      resolver.reject(error);
    }
    this.acceptResolvers = [];

    // Close all pending streams
    for (const stream of this.pendingStreams) {
      await stream.close();
    }
    this.pendingStreams = [];

    // Notify state callbacks
    for (const callback of this.stateCallbacks) {
      callback("disconnected");
    }

    // Notify remote side
    if (this.remoteSide && this.remoteSide._state === "connected") {
      this.remoteSide._handleRemoteDisconnect();
    }
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this._state === "connected";
  }

  /**
   * Register callback for state changes.
   */
  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateCallbacks.push(callback);
    return () => {
      const idx = this.stateCallbacks.indexOf(callback);
      if (idx >= 0) this.stateCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register callback for incoming streams.
   * When first callback is registered, drains pending streams to it.
   */
  onStream(callback: (stream: SyncStream) => void): () => void {
    const wasEmpty = this.streamCallbacks.length === 0;
    this.streamCallbacks.push(callback);

    // Drain pending streams to the first registered callback
    if (wasEmpty && this.pendingStreams.length > 0) {
      const streams = [...this.pendingStreams];
      this.pendingStreams = [];
      for (const stream of streams) {
        callback(stream);
      }
    }

    return () => {
      const idx = this.streamCallbacks.indexOf(callback);
      if (idx >= 0) this.streamCallbacks.splice(idx, 1);
    };
  }

  /**
   * Get simulated RTT.
   */
  getRttMs(): number | undefined {
    return this.config.rttMs;
  }

  /**
   * Get number of pending streams.
   */
  getPendingStreamCount(): number {
    return this.pendingStreams.length;
  }

  /**
   * Get connection type (always "direct" for mock - simulates local connection).
   */
  getConnectionType(): ConnectionType {
    return "direct";
  }

  // ============================================================================
  // Internal methods
  // ============================================================================

  /**
   * Deliver an incoming stream from the remote side.
   * @internal
   */
  _deliverIncomingStream(stream: MockSyncStream): void {
    if (this._state !== "connected") return;

    // If there's a waiting acceptStream, deliver immediately
    const resolver = this.acceptResolvers.shift();
    if (resolver) {
      resolver.resolve(stream);
      return;
    }

    // If there are stream callbacks, deliver to all of them
    if (this.streamCallbacks.length > 0) {
      for (const callback of this.streamCallbacks) {
        callback(stream);
      }
      return;
    }

    // Queue for later
    if (this.pendingStreams.length >= (this.config.maxQueuedStreams ?? 100)) {
      console.warn(`MockPeerConnection: Stream queue full, dropping stream ${stream.id}`);
      return;
    }
    this.pendingStreams.push(stream);
  }

  /**
   * Handle remote side disconnecting.
   * @internal
   */
  public _handleRemoteDisconnect(): void {
    if (this._state === "disconnected") return;

    this._state = "disconnected";

    // Reject pending accept resolvers
    const error = new Error(`Connection to ${this.peerId} lost`);
    for (const resolver of this.acceptResolvers) {
      resolver.reject(error);
    }
    this.acceptResolvers = [];

    // Notify state callbacks
    for (const callback of this.stateCallbacks) {
      callback("disconnected");
    }
  }

  // ============================================================================
  // Test utilities
  // ============================================================================

  /**
   * Simulate a disconnect without notifying remote.
   */
  simulateDisconnect(): void {
    this._state = "disconnected";

    const error = new Error(`Connection to ${this.peerId} disconnected (simulated)`);
    for (const resolver of this.acceptResolvers) {
      resolver.reject(error);
    }
    this.acceptResolvers = [];

    for (const callback of this.stateCallbacks) {
      callback("disconnected");
    }
  }

  /**
   * Simulate reconnection.
   */
  simulateReconnect(): void {
    if (this._state === "connected") return;

    this._state = "connected";

    for (const callback of this.stateCallbacks) {
      callback("connected");
    }
  }

  /**
   * Set connection state for testing.
   */
  setState(state: ConnectionState): void {
    this._state = state;
    for (const callback of this.stateCallbacks) {
      callback(state);
    }
  }

  /**
   * Inject a stream directly (for testing without remote side).
   */
  injectStream(stream: MockSyncStream): void {
    this._deliverIncomingStream(stream);
  }
}

/**
 * Create a linked pair of mock connections.
 * Streams opened on one side appear on the other.
 */
export function createMockConnectionPair(
  nodeIdA: string,
  nodeIdB: string,
  config: MockConnectionConfig = {},
): { connA: MockPeerConnection; connB: MockPeerConnection } {
  const connA = new MockPeerConnection(nodeIdB, nodeIdA, config);
  const connB = new MockPeerConnection(nodeIdA, nodeIdB, config);

  connA.linkRemote(connB);
  connB.linkRemote(connA);

  return { connA, connB };
}
