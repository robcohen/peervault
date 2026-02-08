/**
 * Mock Transport
 *
 * In-memory Transport implementation for testing.
 * Connects to other MockTransport instances via a shared registry.
 */

import type {
  Transport,
  PeerConnection,
  TransportConfig,
  TransportLogger,
} from "../types";
import { MockPeerConnection, type MockConnectionConfig } from "./mock-connection";
import {
  getMockRegistry,
  createInMemoryRegistry,
  type MockRegistry,
} from "./mock-registry";

/**
 * Configuration for mock transport.
 */
export interface MockTransportConfig extends Partial<TransportConfig> {
  /** Custom node ID (default: random UUID) */
  nodeId?: string;

  /** Simulated latency range [min, max] in ms (default: [0, 0]) */
  latencyMs?: [number, number];

  /** Use cross-window registry for E2E tests (default: false) */
  crossWindow?: boolean;

  /** Use isolated registry instead of global (for unit tests) */
  isolatedRegistry?: boolean;

  /** Connection configuration */
  connectionConfig?: MockConnectionConfig;
}

/**
 * Create a console-based logger for testing.
 */
function createTestLogger(): TransportLogger {
  return {
    debug: (msg, ...args) => console.debug(`[MockTransport] ${msg}`, ...args),
    info: (msg, ...args) => console.info(`[MockTransport] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[MockTransport] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[MockTransport] ${msg}`, ...args),
  };
}

/**
 * Mock Transport implementation.
 *
 * For unit tests, create two MockTransport instances and they will find each other
 * via the global in-memory registry.
 *
 * For E2E tests, set crossWindow: true to use BroadcastChannel for cross-window
 * communication between Obsidian instances.
 */
export class MockTransport implements Transport {
  private _nodeId: string;
  private _ticket: string;
  private _ready = false;
  private config: MockTransportConfig;
  private logger: TransportLogger;
  private registry: MockRegistry;

  private connections = new Map<string, MockPeerConnection>();
  private incomingCallbacks: Array<(conn: PeerConnection) => void> = [];

  constructor(config: MockTransportConfig = {}) {
    this.config = config;
    this.logger = config.logger ?? createTestLogger();

    // Generate or use provided node ID
    this._nodeId = config.nodeId ?? generateNodeId();

    // Generate ticket containing node ID
    this._ticket = JSON.stringify({
      nodeId: this._nodeId,
      timestamp: Date.now(),
    });

    // Get or create registry
    if (config.isolatedRegistry) {
      this.registry = createInMemoryRegistry();
    } else {
      this.registry = getMockRegistry(config.crossWindow ?? false);
    }
  }

  /**
   * Initialize the transport.
   */
  async initialize(): Promise<void> {
    if (this._ready) return;

    this.logger.info(`Initializing MockTransport with nodeId: ${this._nodeId.slice(0, 8)}...`);

    // Apply simulated latency
    if (this.config.latencyMs) {
      const [min, max] = this.config.latencyMs;
      const delay = min + Math.random() * (max - min);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Register with the global registry
    this.registry.register(this);

    this._ready = true;
    this.logger.info("MockTransport initialized");
  }

  /**
   * Get this transport's node ID.
   */
  getNodeId(): string {
    return this._nodeId;
  }

  /**
   * Get this transport's ticket (for internal use).
   */
  getTicket(): string {
    return this._ticket;
  }

  /**
   * Generate a connection ticket.
   */
  async generateTicket(): Promise<string> {
    if (!this._ready) {
      throw new Error("MockTransport not initialized");
    }
    return this._ticket;
  }

  /**
   * Connect to a peer using their ticket.
   */
  async connectWithTicket(ticket: string): Promise<PeerConnection> {
    if (!this._ready) {
      throw new Error("MockTransport not initialized");
    }

    this.logger.debug(`Connecting with ticket: ${ticket.slice(0, 20)}...`);

    // Apply simulated latency
    if (this.config.latencyMs) {
      const [min, max] = this.config.latencyMs;
      const delay = min + Math.random() * (max - min);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Request connection via registry
    const conn = await this.registry.requestConnection(
      this,
      ticket,
      this.config.connectionConfig,
    );

    return conn;
  }

  /**
   * Register callback for incoming connections.
   */
  onIncomingConnection(callback: (conn: PeerConnection) => void): () => void {
    this.incomingCallbacks.push(callback);
    return () => {
      const idx = this.incomingCallbacks.indexOf(callback);
      if (idx >= 0) this.incomingCallbacks.splice(idx, 1);
    };
  }

  /**
   * Get all active connections.
   */
  getConnections(): PeerConnection[] {
    return Array.from(this.connections.values()).filter((c) => c.isConnected());
  }

  /**
   * Get connection by peer ID.
   */
  getConnection(peerId: string): PeerConnection | undefined {
    return this.connections.get(peerId);
  }

  /**
   * Shut down the transport.
   */
  async shutdown(): Promise<void> {
    if (!this._ready) return;

    this.logger.info("Shutting down MockTransport...");

    // Close all connections
    for (const conn of this.connections.values()) {
      await conn.close();
    }
    this.connections.clear();

    // Unregister from registry
    this.registry.unregister(this._nodeId);

    this._ready = false;
    this.logger.info("MockTransport shut down");
  }

  /**
   * Check if transport is ready.
   */
  isReady(): boolean {
    return this._ready;
  }

  // ============================================================================
  // Internal methods (called by registry)
  // ============================================================================

  /**
   * Add a connection (called after we initiate a connection).
   * @internal
   */
  _addConnection(conn: MockPeerConnection): void {
    this.connections.set(conn.peerId, conn);

    // Set up disconnect handler
    conn.onStateChange((state) => {
      if (state === "disconnected" || state === "error") {
        this.connections.delete(conn.peerId);
      }
    });
  }

  /**
   * Handle an incoming connection from another transport.
   * @internal
   */
  _handleIncomingConnection(conn: MockPeerConnection): void {
    this.logger.debug(`Incoming connection from ${conn.peerId.slice(0, 8)}...`);

    this.connections.set(conn.peerId, conn);

    // Set up disconnect handler
    conn.onStateChange((state) => {
      if (state === "disconnected" || state === "error") {
        this.connections.delete(conn.peerId);
      }
    });

    // Notify callbacks
    for (const callback of this.incomingCallbacks) {
      callback(conn);
    }
  }

  // ============================================================================
  // Test utilities
  // ============================================================================

  /**
   * Simulate network partition with a peer.
   */
  simulatePartition(peerId: string): void {
    const conn = this.connections.get(peerId);
    if (conn) {
      conn.simulateDisconnect();
    }
  }

  /**
   * Get statistics for testing.
   */
  getStats(): MockTransportStats {
    return {
      nodeId: this._nodeId,
      ready: this._ready,
      connectionCount: this.connections.size,
      activeConnections: this.getConnections().length,
      incomingCallbackCount: this.incomingCallbacks.length,
    };
  }

  /**
   * Get the registry (for advanced testing).
   */
  getRegistry(): MockRegistry {
    return this.registry;
  }
}

/**
 * Statistics for mock transport.
 */
export interface MockTransportStats {
  nodeId: string;
  ready: boolean;
  connectionCount: number;
  activeConnections: number;
  incomingCallbackCount: number;
}

/**
 * Generate a random node ID.
 */
function generateNodeId(): string {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback for environments without crypto
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create a pair of connected mock transports for testing.
 * Useful for unit tests that need two transports that can communicate.
 */
export async function createMockTransportPair(
  config: MockTransportConfig = {},
): Promise<{ transportA: MockTransport; transportB: MockTransport }> {
  // Use isolated registry so tests don't interfere
  const sharedConfig = { ...config, isolatedRegistry: true };

  const transportA = new MockTransport({
    ...sharedConfig,
    nodeId: config.nodeId ?? generateNodeId(),
  });
  const transportB = new MockTransport({
    ...sharedConfig,
    nodeId: generateNodeId(),
  });

  // Share the same registry
  (transportB as unknown as { registry: MockRegistry }).registry =
    (transportA as unknown as { registry: MockRegistry }).registry;

  await transportA.initialize();
  await transportB.initialize();

  return { transportA, transportB };
}
