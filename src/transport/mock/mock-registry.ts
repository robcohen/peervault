/**
 * Mock Transport Registry
 *
 * Global registry that allows MockTransport instances to discover and connect to each other.
 *
 * Two modes:
 * - In-memory: For unit tests (same process)
 * - Cross-window: For E2E tests (uses BroadcastChannel to communicate between Obsidian windows)
 */

import type { SyncStream } from "../types";
import type { MockTransport } from "./mock-transport";
import { MockPeerConnection, type MockConnectionConfig } from "./mock-connection";

const BROADCAST_CHANNEL_NAME = "peervault-mock-transport";

/**
 * Message types for cross-window communication.
 */
type BridgeMessageType =
  | "connect-request"
  | "connect-accept"
  | "connect-reject"
  | "stream-open"
  | "stream-opened"
  | "stream-data"
  | "stream-close"
  | "disconnect";

/**
 * Cross-window bridge message.
 */
interface BridgeMessage {
  type: BridgeMessageType;
  fromNodeId: string;
  toNodeId: string;
  requestId?: string;
  ticket?: string;
  streamId?: string;
  data?: string; // Base64 encoded for binary data
  error?: string;
}

/**
 * Mock transport registry interface.
 */
export interface MockRegistry {
  /** Register a transport */
  register(transport: MockTransport): void;

  /** Unregister a transport */
  unregister(nodeId: string): void;

  /** Get transport by node ID */
  get(nodeId: string): MockTransport | undefined;

  /** Get transport by ticket */
  getByTicket(ticket: string): MockTransport | undefined;

  /** Request connection to a peer via ticket */
  requestConnection(
    fromTransport: MockTransport,
    ticket: string,
    config?: MockConnectionConfig,
  ): Promise<MockPeerConnection>;

  /** Clear all registrations */
  clear(): void;
}

// ============================================================================
// Base64 encoding/decoding for Uint8Array
// ============================================================================

function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================================
// In-Memory Registry (for unit tests)
// ============================================================================

interface RegistryEntry {
  nodeId: string;
  ticket: string;
  transport: MockTransport;
}

/**
 * In-memory registry for same-process testing.
 */
class InMemoryRegistry implements MockRegistry {
  private entries = new Map<string, RegistryEntry>();
  private ticketIndex = new Map<string, string>(); // ticket -> nodeId

  register(transport: MockTransport): void {
    const nodeId = transport.getNodeId();
    const ticket = transport.getTicket();

    this.entries.set(nodeId, { nodeId, ticket, transport });
    this.ticketIndex.set(ticket, nodeId);
  }

  unregister(nodeId: string): void {
    const entry = this.entries.get(nodeId);
    if (entry) {
      this.ticketIndex.delete(entry.ticket);
      this.entries.delete(nodeId);
    }
  }

  get(nodeId: string): MockTransport | undefined {
    return this.entries.get(nodeId)?.transport;
  }

  getByTicket(ticket: string): MockTransport | undefined {
    const nodeId = this.ticketIndex.get(ticket);
    return nodeId ? this.entries.get(nodeId)?.transport : undefined;
  }

  async requestConnection(
    fromTransport: MockTransport,
    ticket: string,
    config?: MockConnectionConfig,
  ): Promise<MockPeerConnection> {
    const targetTransport = this.getByTicket(ticket);
    if (!targetTransport) {
      throw new Error(`No transport registered for ticket: ${ticket}`);
    }

    const fromNodeId = fromTransport.getNodeId();
    const toNodeId = targetTransport.getNodeId();

    // Create linked connection pair
    const connA = new MockPeerConnection(toNodeId, fromNodeId, config);
    const connB = new MockPeerConnection(fromNodeId, toNodeId, config);

    connA.linkRemote(connB);
    connB.linkRemote(connA);

    // Notify both sides
    fromTransport._addConnection(connA);
    targetTransport._handleIncomingConnection(connB);

    return connA;
  }

  clear(): void {
    this.entries.clear();
    this.ticketIndex.clear();
  }
}

// ============================================================================
// Bridged Sync Stream (for cross-window communication)
// ============================================================================

/**
 * A SyncStream that bridges two windows via BroadcastChannel.
 * All data is serialized to base64 and sent as messages.
 */
class BridgedSyncStream implements SyncStream {
  readonly id: string;

  private _open = true;
  private localNodeId: string;
  private remoteNodeId: string;
  private channel: BroadcastChannel;

  // Receive queue and resolvers
  private receiveQueue: Uint8Array[] = [];
  private receiveResolvers: Array<{
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(
    streamId: string,
    localNodeId: string,
    remoteNodeId: string,
    channel: BroadcastChannel,
  ) {
    this.id = streamId;
    this.localNodeId = localNodeId;
    this.remoteNodeId = remoteNodeId;
    this.channel = channel;
  }

  /**
   * Send data to the remote stream via BroadcastChannel.
   */
  async send(data: Uint8Array): Promise<void> {
    if (!this._open) {
      throw new Error(`Stream ${this.id} is closed`);
    }

    const message: BridgeMessage = {
      type: "stream-data",
      fromNodeId: this.localNodeId,
      toNodeId: this.remoteNodeId,
      streamId: this.id,
      data: uint8ToBase64(data),
    };

    this.channel.postMessage(message);
  }

  /**
   * Receive data from the remote stream.
   * Blocks until data is available.
   */
  async receive(): Promise<Uint8Array> {
    if (!this._open) {
      throw new Error(`Stream ${this.id} is closed`);
    }

    // Check queue first
    const queued = this.receiveQueue.shift();
    if (queued) {
      return queued;
    }

    // Wait for incoming data
    return new Promise<Uint8Array>((resolve, reject) => {
      if (!this._open) {
        reject(new Error(`Stream ${this.id} is closed`));
        return;
      }
      this.receiveResolvers.push({ resolve, reject });
    });
  }

  /**
   * Close the stream.
   */
  async close(): Promise<void> {
    if (!this._open) return;

    this._open = false;

    // Notify remote side
    const message: BridgeMessage = {
      type: "stream-close",
      fromNodeId: this.localNodeId,
      toNodeId: this.remoteNodeId,
      streamId: this.id,
    };
    this.channel.postMessage(message);

    // Reject pending receives
    const error = new Error(`Stream ${this.id} closed`);
    for (const resolver of this.receiveResolvers) {
      resolver.reject(error);
    }
    this.receiveResolvers = [];
  }

  /**
   * Check if stream is open.
   */
  isOpen(): boolean {
    return this._open;
  }

  // ============================================================================
  // Internal methods (called by CrossWindowConnection)
  // ============================================================================

  /**
   * Deliver data received from BroadcastChannel.
   * @internal
   */
  _deliverData(base64Data: string): void {
    if (!this._open) return;

    const data = base64ToUint8(base64Data);

    // If there's a waiting receiver, deliver immediately
    const resolver = this.receiveResolvers.shift();
    if (resolver) {
      resolver.resolve(data);
    } else {
      // Queue for later receive() call
      this.receiveQueue.push(data);
    }
  }

  /**
   * Handle remote close.
   * @internal
   */
  _handleRemoteClose(): void {
    if (!this._open) return;

    this._open = false;

    const error = new Error(`Stream ${this.id} closed by remote`);
    for (const resolver of this.receiveResolvers) {
      resolver.reject(error);
    }
    this.receiveResolvers = [];
  }
}

// ============================================================================
// Cross-Window Connection
// ============================================================================

/**
 * A PeerConnection that bridges two windows via BroadcastChannel.
 * Streams are created as BridgedSyncStreams that communicate via messages.
 */
class BridgedPeerConnection extends MockPeerConnection {
  private channel: BroadcastChannel;
  private bridgedStreams = new Map<string, BridgedSyncStream>();

  // For acceptStream() - streams opened by remote that we haven't accepted yet
  private pendingRemoteStreams: BridgedSyncStream[] = [];
  private bridgedAcceptResolvers: Array<{
    resolve: (stream: SyncStream) => void;
    reject: (error: Error) => void;
  }> = [];

  // For openStream() - waiting for remote to acknowledge stream creation
  private pendingStreamOpens = new Map<
    string,
    {
      resolve: (stream: BridgedSyncStream) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    peerId: string,
    localNodeId: string,
    channel: BroadcastChannel,
    config: MockConnectionConfig = {},
  ) {
    super(peerId, localNodeId, config);
    this.channel = channel;
  }

  /**
   * Open a new stream to the remote peer.
   * Sends a stream-open message and waits for stream-opened response.
   */
  override async openStream(): Promise<SyncStream> {
    if (!this.isConnected()) {
      throw new Error(`Connection to ${this.peerId} is not connected`);
    }

    const streamId = `${this.localNodeId.slice(0, 8)}-${++this.streamCounter}-${Date.now()}`;

    return new Promise<SyncStream>((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingStreamOpens.delete(streamId);
        reject(new Error(`Stream open timed out for ${streamId}`));
      }, 10000);

      this.pendingStreamOpens.set(streamId, {
        resolve: (stream) => {
          clearTimeout(timeout);
          resolve(stream);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      // Send stream-open request
      const message: BridgeMessage = {
        type: "stream-open",
        fromNodeId: this.localNodeId,
        toNodeId: this.peerId,
        streamId,
      };
      this.channel.postMessage(message);
    });
  }

  /**
   * Accept an incoming stream from the remote peer.
   */
  override async acceptStream(): Promise<SyncStream> {
    if (!this.isConnected()) {
      throw new Error(`Connection to ${this.peerId} is not connected`);
    }

    // Check if there's a pending remote stream
    const pending = this.pendingRemoteStreams.shift();
    if (pending) {
      return pending;
    }

    // Wait for incoming stream
    return new Promise<SyncStream>((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error(`Connection to ${this.peerId} closed while waiting for stream`));
        return;
      }
      this.bridgedAcceptResolvers.push({ resolve, reject });
    });
  }

  /**
   * Get count of pending streams.
   */
  override getPendingStreamCount(): number {
    return this.pendingRemoteStreams.length;
  }

  /**
   * Close the connection.
   */
  override async close(): Promise<void> {
    // Close all bridged streams
    for (const stream of this.bridgedStreams.values()) {
      await stream.close();
    }
    this.bridgedStreams.clear();

    // Reject pending operations
    for (const resolver of this.bridgedAcceptResolvers) {
      resolver.reject(new Error(`Connection to ${this.peerId} closed`));
    }
    this.bridgedAcceptResolvers = [];

    for (const [, resolver] of this.pendingStreamOpens) {
      resolver.reject(new Error(`Connection to ${this.peerId} closed`));
    }
    this.pendingStreamOpens.clear();

    // Notify remote
    const message: BridgeMessage = {
      type: "disconnect",
      fromNodeId: this.localNodeId,
      toNodeId: this.peerId,
    };
    this.channel.postMessage(message);

    await super.close();
  }

  // ============================================================================
  // Internal methods (called by CrossWindowRegistry)
  // ============================================================================

  /**
   * Handle stream-open message from remote.
   * Creates a local BridgedSyncStream and sends stream-opened response.
   * @internal
   */
  _handleStreamOpen(streamId: string): void {
    // Create the bridged stream
    const stream = new BridgedSyncStream(
      streamId,
      this.localNodeId,
      this.peerId,
      this.channel,
    );
    this.bridgedStreams.set(streamId, stream);

    // Send acknowledgment
    const message: BridgeMessage = {
      type: "stream-opened",
      fromNodeId: this.localNodeId,
      toNodeId: this.peerId,
      streamId,
    };
    this.channel.postMessage(message);

    // Deliver to waiting acceptStream() or queue
    const resolver = this.bridgedAcceptResolvers.shift();
    if (resolver) {
      resolver.resolve(stream);
    } else {
      this.pendingRemoteStreams.push(stream);

      // Also notify stream callbacks
      // (MockPeerConnection stores callbacks in parent class)
      this._notifyStreamCallbacks(stream);
    }
  }

  /**
   * Handle stream-opened message from remote.
   * Completes the openStream() promise.
   * @internal
   */
  _handleStreamOpened(streamId: string): void {
    const pending = this.pendingStreamOpens.get(streamId);
    if (!pending) return;

    this.pendingStreamOpens.delete(streamId);

    // Create the local bridged stream
    const stream = new BridgedSyncStream(
      streamId,
      this.localNodeId,
      this.peerId,
      this.channel,
    );
    this.bridgedStreams.set(streamId, stream);

    pending.resolve(stream);
  }

  /**
   * Handle stream-data message from remote.
   * @internal
   */
  _handleStreamData(streamId: string, base64Data: string): void {
    const stream = this.bridgedStreams.get(streamId);
    if (stream) {
      stream._deliverData(base64Data);
    }
  }

  /**
   * Handle stream-close message from remote.
   * @internal
   */
  _handleStreamClose(streamId: string): void {
    const stream = this.bridgedStreams.get(streamId);
    if (stream) {
      stream._handleRemoteClose();
      this.bridgedStreams.delete(streamId);
    }
  }

  /**
   * Handle remote disconnect.
   * @internal
   */
  _handleDisconnect(): void {
    // Close all streams
    for (const stream of this.bridgedStreams.values()) {
      stream._handleRemoteClose();
    }
    this.bridgedStreams.clear();

    // Reject pending operations
    for (const resolver of this.bridgedAcceptResolvers) {
      resolver.reject(new Error(`Connection to ${this.peerId} lost`));
    }
    this.bridgedAcceptResolvers = [];

    for (const [, resolver] of this.pendingStreamOpens) {
      resolver.reject(new Error(`Connection to ${this.peerId} lost`));
    }
    this.pendingStreamOpens.clear();

    super._handleRemoteDisconnect();
  }

  /**
   * Notify stream callbacks (access parent's private array).
   * @internal
   */
  private _notifyStreamCallbacks(stream: SyncStream): void {
    // Access parent's streamCallbacks via prototype chain
    // We call onStream handlers that were registered
    const callbacks = (this as unknown as { streamCallbacks: Array<(s: SyncStream) => void> })
      .streamCallbacks;
    if (callbacks) {
      for (const cb of callbacks) {
        cb(stream);
      }
    }
  }
}

// ============================================================================
// Cross-Window Registry
// ============================================================================

/**
 * Cross-window registry using BroadcastChannel.
 * Enables two Obsidian windows to "connect" via mock transport.
 */
class CrossWindowRegistry implements MockRegistry {
  private channel: BroadcastChannel | null = null;
  private localTransport: MockTransport | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (conn: MockPeerConnection) => void;
      reject: (error: Error) => void;
      config?: MockConnectionConfig;
    }
  >();
  private connections = new Map<string, BridgedPeerConnection>();

  constructor() {
    // Check if BroadcastChannel is available
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      this.channel.onmessage = this.handleMessage.bind(this);
    }
  }

  private handleMessage(event: MessageEvent<BridgeMessage>): void {
    const msg = event.data;
    if (!this.localTransport) return;

    const localNodeId = this.localTransport.getNodeId();

    // Only process messages addressed to us
    if (msg.toNodeId !== localNodeId) return;

    switch (msg.type) {
      case "connect-request":
        this.handleConnectRequest(msg);
        break;

      case "connect-accept":
        this.handleConnectAccept(msg);
        break;

      case "connect-reject":
        this.handleConnectReject(msg);
        break;

      case "stream-open":
        this.handleStreamOpen(msg);
        break;

      case "stream-opened":
        this.handleStreamOpened(msg);
        break;

      case "stream-data":
        this.handleStreamData(msg);
        break;

      case "stream-close":
        this.handleStreamClose(msg);
        break;

      case "disconnect":
        this.handleDisconnect(msg);
        break;
    }
  }

  private handleConnectRequest(msg: BridgeMessage): void {
    if (!this.localTransport || !this.channel) return;

    const localNodeId = this.localTransport.getNodeId();
    const localTicket = this.localTransport.getTicket();

    // Check if the ticket matches
    if (msg.ticket !== localTicket) {
      this.channel.postMessage({
        type: "connect-reject",
        fromNodeId: localNodeId,
        toNodeId: msg.fromNodeId,
        requestId: msg.requestId,
        error: "Ticket does not match",
      } as BridgeMessage);
      return;
    }

    // Create a bridged connection
    const conn = new BridgedPeerConnection(
      msg.fromNodeId,
      localNodeId,
      this.channel,
      {},
    );

    this.connections.set(msg.fromNodeId, conn);
    this.localTransport._handleIncomingConnection(conn);

    // Accept the connection
    this.channel.postMessage({
      type: "connect-accept",
      fromNodeId: localNodeId,
      toNodeId: msg.fromNodeId,
      requestId: msg.requestId,
    } as BridgeMessage);
  }

  private handleConnectAccept(msg: BridgeMessage): void {
    const pending = this.pendingRequests.get(msg.requestId!);
    if (!pending || !this.localTransport || !this.channel) return;

    this.pendingRequests.delete(msg.requestId!);

    // Create local side of the connection
    const conn = new BridgedPeerConnection(
      msg.fromNodeId,
      this.localTransport.getNodeId(),
      this.channel,
      pending.config ?? {},
    );

    this.connections.set(msg.fromNodeId, conn);
    this.localTransport._addConnection(conn);

    pending.resolve(conn);
  }

  private handleConnectReject(msg: BridgeMessage): void {
    const pending = this.pendingRequests.get(msg.requestId!);
    if (!pending) return;

    this.pendingRequests.delete(msg.requestId!);
    pending.reject(new Error(msg.error || "Connection rejected"));
  }

  private handleStreamOpen(msg: BridgeMessage): void {
    const conn = this.connections.get(msg.fromNodeId);
    if (conn && msg.streamId) {
      conn._handleStreamOpen(msg.streamId);
    }
  }

  private handleStreamOpened(msg: BridgeMessage): void {
    const conn = this.connections.get(msg.fromNodeId);
    if (conn && msg.streamId) {
      conn._handleStreamOpened(msg.streamId);
    }
  }

  private handleStreamData(msg: BridgeMessage): void {
    const conn = this.connections.get(msg.fromNodeId);
    if (conn && msg.streamId && msg.data) {
      conn._handleStreamData(msg.streamId, msg.data);
    }
  }

  private handleStreamClose(msg: BridgeMessage): void {
    const conn = this.connections.get(msg.fromNodeId);
    if (conn && msg.streamId) {
      conn._handleStreamClose(msg.streamId);
    }
  }

  private handleDisconnect(msg: BridgeMessage): void {
    const conn = this.connections.get(msg.fromNodeId);
    if (conn) {
      conn._handleDisconnect();
      this.connections.delete(msg.fromNodeId);
    }
  }

  register(transport: MockTransport): void {
    this.localTransport = transport;
  }

  unregister(nodeId: string): void {
    // Notify all connected peers
    if (this.channel) {
      for (const [peerId] of this.connections) {
        this.channel.postMessage({
          type: "disconnect",
          fromNodeId: nodeId,
          toNodeId: peerId,
        } as BridgeMessage);
      }
    }
    this.connections.clear();
    this.localTransport = null;
  }

  get(nodeId: string): MockTransport | undefined {
    // Cross-window registry can only access local transport
    if (this.localTransport?.getNodeId() === nodeId) {
      return this.localTransport;
    }
    return undefined;
  }

  getByTicket(ticket: string): MockTransport | undefined {
    if (this.localTransport?.getTicket() === ticket) {
      return this.localTransport;
    }
    return undefined;
  }

  async requestConnection(
    fromTransport: MockTransport,
    ticket: string,
    config?: MockConnectionConfig,
  ): Promise<MockPeerConnection> {
    if (!this.channel) {
      throw new Error("BroadcastChannel not available");
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const fromNodeId = fromTransport.getNodeId();

    // Parse ticket to get target node ID
    let targetNodeId: string;
    try {
      const ticketData = JSON.parse(ticket);
      targetNodeId = ticketData.nodeId;
    } catch {
      throw new Error(`Invalid ticket format: ${ticket}`);
    }

    return new Promise<MockPeerConnection>((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("Connection request timed out"));
      }, 10000);

      this.pendingRequests.set(requestId, {
        resolve: (conn) => {
          clearTimeout(timeout);
          resolve(conn);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        config,
      });

      // Send connection request
      this.channel!.postMessage({
        type: "connect-request",
        fromNodeId,
        toNodeId: targetNodeId,
        ticket,
        requestId,
      } as BridgeMessage);
    });
  }

  clear(): void {
    this.localTransport = null;
    this.pendingRequests.clear();
    this.connections.clear();
  }

  destroy(): void {
    this.clear();
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

// ============================================================================
// Global Registry Instance
// ============================================================================

let globalRegistry: MockRegistry | null = null;

/**
 * Get or create the global mock registry.
 *
 * @param crossWindow Use cross-window registry (BroadcastChannel) for E2E tests
 */
export function getMockRegistry(crossWindow = false): MockRegistry {
  if (!globalRegistry) {
    globalRegistry = crossWindow ? new CrossWindowRegistry() : new InMemoryRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (for test cleanup).
 */
export function resetMockRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clear();
    if (globalRegistry instanceof CrossWindowRegistry) {
      (globalRegistry as CrossWindowRegistry).destroy();
    }
    globalRegistry = null;
  }
}

/**
 * Create a fresh in-memory registry (for isolated tests).
 */
export function createInMemoryRegistry(): MockRegistry {
  return new InMemoryRegistry();
}
