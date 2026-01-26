/**
 * Transport Layer Types
 *
 * Defines interfaces for peer-to-peer transport, following the Iroh transport spec.
 */

/** ALPN protocol identifier for PeerVault sync */
export const PEERVAULT_ALPN = new TextEncoder().encode("peervault/sync/1");

/** Transport connection state */
export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/** Transport events */
export interface TransportEvents {
  "connection:incoming": { connection: PeerConnection };
  "connection:established": { peerId: string };
  "connection:lost": { peerId: string; reason?: string };
  "connection:error": { peerId: string; error: Error };
  "state:change": { state: ConnectionState };
}

/**
 * Main transport interface for peer-to-peer connections.
 */
export interface Transport {
  /**
   * Initialize the transport. Call once on plugin load.
   */
  initialize(): Promise<void>;

  /**
   * Get this device's node/peer ID.
   */
  getNodeId(): string;

  /**
   * Generate a connection ticket for pairing.
   * The ticket contains everything needed to connect to this peer.
   */
  generateTicket(): Promise<string>;

  /**
   * Connect to a peer using their ticket.
   */
  connectWithTicket(ticket: string): Promise<PeerConnection>;

  /**
   * Register callback for incoming connections.
   */
  onIncomingConnection(callback: (conn: PeerConnection) => void): void;

  /**
   * Get all active connections.
   */
  getConnections(): PeerConnection[];

  /**
   * Get connection by peer ID.
   */
  getConnection(peerId: string): PeerConnection | undefined;

  /**
   * Shut down the transport and close all connections.
   */
  shutdown(): Promise<void>;

  /**
   * Check if transport is initialized and ready.
   */
  isReady(): boolean;
}

/**
 * Represents a connection to a single peer.
 */
export interface PeerConnection {
  /** Remote peer's NodeId */
  readonly peerId: string;

  /** Connection state */
  readonly state: ConnectionState;

  /**
   * Open a new bidirectional stream for sync.
   */
  openStream(): Promise<SyncStream>;

  /**
   * Accept an incoming stream from the peer.
   */
  acceptStream(): Promise<SyncStream>;

  /**
   * Close the connection gracefully.
   */
  close(): Promise<void>;

  /**
   * Check if connection is active.
   */
  isConnected(): boolean;

  /**
   * Register callback for connection state changes.
   */
  onStateChange(callback: (state: ConnectionState) => void): void;

  /**
   * Register callback for incoming streams.
   */
  onStream(callback: (stream: SyncStream) => void): void;
}

/**
 * Bidirectional byte stream for sync messages.
 */
export interface SyncStream {
  /** Stream ID for debugging */
  readonly id: string;

  /**
   * Send bytes to the peer.
   * Messages are framed with a 4-byte length prefix.
   */
  send(data: Uint8Array): Promise<void>;

  /**
   * Receive bytes from the peer.
   * Blocks until a complete message is received.
   */
  receive(): Promise<Uint8Array>;

  /**
   * Close the stream gracefully.
   */
  close(): Promise<void>;

  /**
   * Check if stream is open.
   */
  isOpen(): boolean;
}

/**
 * Configuration for transport initialization.
 */
export interface TransportConfig {
  /** Storage adapter for persisting keys */
  storage: TransportStorage;

  /** Logger instance */
  logger: TransportLogger;

  /** Custom relay servers (optional, uses defaults if not provided) */
  relayUrls?: string[];

  /** Enable debug mode */
  debug?: boolean;
}

/**
 * Storage interface for transport secrets.
 */
export interface TransportStorage {
  loadSecretKey(): Promise<Uint8Array | null>;
  saveSecretKey(key: Uint8Array): Promise<void>;
}

/**
 * Logger interface for transport.
 */
export interface TransportLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
