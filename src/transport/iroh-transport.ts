/**
 * Iroh Transport Implementation
 *
 * Real P2P transport using Iroh via WASM bindings.
 * Uses relay servers for NAT traversal in browser environments.
 */

import type {
  Transport,
  PeerConnection,
  SyncStream,
  TransportConfig,
  ConnectionState,
} from "./types";
import { TransportErrors } from "../errors";

// Import the bundled Iroh WASM module (inlined by esbuild plugin)
// @ts-ignore - This is resolved by esbuild to the transformed module
import * as irohWasm from "../../peervault-iroh/pkg/peervault_iroh.js";

// Type definitions matching the WASM module exports
interface WasmEndpoint {
  nodeId(): string;
  secretKeyBytes(): Uint8Array;
  generateTicket(): Promise<string>;
  connectWithTicket(ticket: string): Promise<WasmConnection>;
  acceptConnection(): Promise<WasmConnection | null>;
  close(): Promise<void>;
  free(): void;
}

interface WasmEndpointStatic {
  /**
   * Create a new Iroh endpoint.
   *
   * @param keyBytes - Optional 32-byte secret key for identity persistence
   * @param relayUrls - Optional custom relay server URLs (e.g., ["https://relay.example.com"])
   *                    If not provided, uses Iroh's default public relays.
   *
   * See spec/05-transport-iroh.md for details on self-hosted relay setup.
   */
  create(keyBytes?: Uint8Array | null, relayUrls?: string[]): Promise<WasmEndpoint>;
}

interface WasmConnection {
  remoteNodeId(): string;
  openStream(): Promise<WasmStream>;
  acceptStream(): Promise<WasmStream>;
  isConnected(): boolean;
  getRttMs(): number;
  getStats(): string;
  close(): Promise<void>;
  free(): void;
}

interface WasmStream {
  send(data: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array>;
  close(): Promise<void>;
  free(): void;
}

interface IrohWasmModule {
  default: (input?: unknown) => Promise<void>;
  WasmEndpoint: WasmEndpointStatic;
}

// Module-level state for the WASM module
let wasmModule: IrohWasmModule | null = null;
let wasmInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the Iroh WASM module.
 * Call this once before creating any IrohTransport instances.
 *
 * The WASM is now bundled inline, so no file paths are needed.
 * Parameters are kept for backwards compatibility but ignored.
 */
export async function initIrohWasm(
  _jsUrl?: string,
  _wasmUrl?: string,
): Promise<void> {
  // Prevent multiple initializations
  if (wasmInitialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // WASM is bundled inline - just initialize it
      const module = irohWasm as unknown as IrohWasmModule;

      // Initialize the WASM module (uses inlined bytes)
      await module.default();

      wasmModule = module;
      wasmInitialized = true;
    } catch (err) {
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Check if the Iroh WASM module is initialized.
 */
export function isIrohWasmReady(): boolean {
  return wasmInitialized;
}

/**
 * Iroh transport implementation using WASM bindings.
 */
export class IrohTransport implements Transport {
  private endpoint: WasmEndpoint | null = null;
  private connections = new Map<string, IrohPeerConnection>();
  private incomingCallbacks: Array<(conn: PeerConnection) => void> = [];
  private ready = false;
  private config: TransportConfig;
  private acceptLoopRunning = false;
  private acceptLoopCrashCount = 0;
  private static readonly MAX_ACCEPT_LOOP_CRASHES = 5;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (!wasmModule) {
      throw TransportErrors.wasmLoadFailed(
        "Iroh WASM module not initialized. Call initIrohWasm() first.",
      );
    }

    // Load existing secret key or create new one
    const storedKey = await this.config.storage.loadSecretKey();
    const keyBytes = storedKey && storedKey.length === 32 ? storedKey : null;

    this.config.logger.debug("Creating Iroh endpoint...");

    // Create the endpoint
    // Pass relay URLs for when WASM wrapper supports custom relays
    this.endpoint = await wasmModule.WasmEndpoint.create(
      keyBytes ?? undefined,
      this.config.relayUrls,
    );

    // Save the key if we generated a new one
    if (!keyBytes) {
      const newKey = this.endpoint.secretKeyBytes();
      await this.config.storage.saveSecretKey(newKey);
      this.config.logger.info("Generated new Iroh identity");
    }

    this.ready = true;
    this.config.logger.info(
      "IrohTransport initialized with nodeId:",
      this.endpoint.nodeId(),
    );

    // Start accepting incoming connections
    this.startAcceptLoop();
  }

  getNodeId(): string {
    if (!this.endpoint) {
      throw TransportErrors.notInitialized();
    }
    return this.endpoint.nodeId();
  }

  async generateTicket(): Promise<string> {
    if (!this.endpoint) {
      throw TransportErrors.notInitialized();
    }

    this.config.logger.debug("Generating connection ticket...");
    const ticket = await this.endpoint.generateTicket();
    this.config.logger.debug("Ticket generated");
    return ticket;
  }

  async connectWithTicket(ticket: string): Promise<PeerConnection> {
    if (!this.endpoint) {
      throw TransportErrors.notInitialized();
    }

    this.config.logger.debug("Connecting with ticket...");

    // Connect using the ticket
    const wasmConn = await this.endpoint.connectWithTicket(ticket);
    const peerId = wasmConn.remoteNodeId();

    // Check if we already have a connection to this peer
    const existing = this.connections.get(peerId);
    if (existing?.isConnected()) {
      // Close the new connection and return existing
      await wasmConn.close();
      wasmConn.free();
      return existing;
    }

    // Create wrapper
    const connection = new IrohPeerConnection(
      wasmConn,
      peerId,
      this.config.logger,
    );
    this.connections.set(peerId, connection);

    this.config.logger.info("Connected to peer:", peerId);
    return connection;
  }

  onIncomingConnection(callback: (conn: PeerConnection) => void): () => void {
    this.incomingCallbacks.push(callback);
    return () => {
      const idx = this.incomingCallbacks.indexOf(callback);
      if (idx >= 0) this.incomingCallbacks.splice(idx, 1);
    };
  }

  private startAcceptLoop(): void {
    if (this.acceptLoopRunning) return;
    this.acceptLoopRunning = true;

    const acceptLoop = async () => {
      // Exponential backoff for errors
      const BASE_DELAY_MS = 500;
      const MAX_DELAY_MS = 30000;
      let consecutiveErrors = 0;

      while (this.ready && this.endpoint) {
        try {
          this.config.logger.debug("Waiting for incoming connection...");
          const wasmConn = await this.endpoint.acceptConnection();

          // acceptConnection can return null (e.g., endpoint closing)
          if (!wasmConn) {
            if (this.ready) {
              this.config.logger.debug("acceptConnection returned null, retrying...");
              continue;
            }
            break;
          }

          // Reset error counter on successful accept
          consecutiveErrors = 0;

          const peerId = wasmConn.remoteNodeId();

          this.config.logger.info("Incoming connection from:", peerId);

          // Create wrapper
          const connection = new IrohPeerConnection(
            wasmConn,
            peerId,
            this.config.logger,
          );
          this.connections.set(peerId, connection);

          // Notify callbacks
          for (const callback of this.incomingCallbacks) {
            try {
              callback(connection);
            } catch (err) {
              this.config.logger.error(
                "Error in incoming connection callback:",
                err,
              );
            }
          }
        } catch (err) {
          if (this.ready) {
            consecutiveErrors++;
            // Exponential backoff with jitter
            const delay = Math.min(
              BASE_DELAY_MS * Math.pow(2, consecutiveErrors - 1) + Math.random() * 100,
              MAX_DELAY_MS,
            );
            this.config.logger.error(
              `Error accepting connection (attempt ${consecutiveErrors}), retrying in ${delay.toFixed(0)}ms:`,
              err,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    };

    // Run accept loop in background with auto-recovery
    acceptLoop().catch((err) => {
      this.config.logger.error("Accept loop crashed:", err);
      this.acceptLoopRunning = false;
      this.acceptLoopCrashCount++;

      // Auto-restart the loop if the transport is still ready and under crash limit
      if (this.ready && this.endpoint) {
        if (this.acceptLoopCrashCount >= IrohTransport.MAX_ACCEPT_LOOP_CRASHES) {
          this.config.logger.error(
            `Accept loop crashed ${this.acceptLoopCrashCount} times, giving up. ` +
            "Restart the plugin to retry."
          );
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, this.acceptLoopCrashCount - 1), 30000);
        this.config.logger.info(
          `Restarting accept loop after crash (attempt ${this.acceptLoopCrashCount}/${IrohTransport.MAX_ACCEPT_LOOP_CRASHES}) in ${delay}ms...`
        );
        setTimeout(() => this.startAcceptLoop(), delay);
      }
    });
  }

  getConnections(): PeerConnection[] {
    return Array.from(this.connections.values()).filter((c) => c.isConnected());
  }

  getConnection(peerId: string): PeerConnection | undefined {
    const conn = this.connections.get(peerId);
    return conn?.isConnected() ? conn : undefined;
  }

  async shutdown(): Promise<void> {
    this.ready = false;
    this.acceptLoopRunning = false;

    // Close all connections
    for (const conn of this.connections.values()) {
      await conn.close();
    }
    this.connections.clear();

    // Clear incoming connection callbacks to prevent leaks on reinitialization
    this.incomingCallbacks = [];

    // Close the endpoint
    if (this.endpoint) {
      await this.endpoint.close();
      this.endpoint.free();
      this.endpoint = null;
    }

    this.config.logger.info("IrohTransport shut down");
  }

  isReady(): boolean {
    return this.ready;
  }
}

/**
 * Iroh peer connection wrapper.
 */
class IrohPeerConnection implements PeerConnection {
  readonly peerId: string;
  state: ConnectionState = "connected";

  private wasmConn: WasmConnection;
  private streams = new Map<string, IrohSyncStream>();
  private pendingStreams: IrohSyncStream[] = [];
  private stateCallbacks: Array<(state: ConnectionState) => void> = [];
  /** Pending acceptStream() handlers paired with their reject functions to avoid index mismatch */
  private pendingAccepts: Array<{
    resolve: (stream: SyncStream) => void;
    reject: (error: Error) => void;
  }> = [];
  /** Stream callbacks for onStream() - these are persistent, not one-time */
  private streamCallbacks: Array<(stream: SyncStream) => void> = [];
  private streamCounter = 0;
  private logger: TransportConfig["logger"];
  private acceptStreamLoopRunning = false;
  private streamLoopCrashCount = 0;
  private static readonly MAX_STREAM_LOOP_CRASHES = 5;

  constructor(
    wasmConn: WasmConnection,
    peerId: string,
    logger: TransportConfig["logger"],
  ) {
    this.wasmConn = wasmConn;
    this.peerId = peerId;
    this.logger = logger;

    // Start accepting streams
    this.startStreamAcceptLoop();
  }

  private startStreamAcceptLoop(): void {
    if (this.acceptStreamLoopRunning) return;
    this.acceptStreamLoopRunning = true;

    const loop = async () => {
      while (this.state === "connected") {
        try {
          const wasmStream = await this.wasmConn.acceptStream();
          const streamId = `${this.peerId}-in-${++this.streamCounter}`;
          const stream = new IrohSyncStream(wasmStream, streamId);

          this.logger.debug("Accepted incoming stream:", streamId);

          // Priority 1: Resolve any pending acceptStream() promise
          if (this.pendingAccepts.length > 0) {
            const pending = this.pendingAccepts.shift()!;
            pending.resolve(stream);
            continue;
          }

          // Priority 2: Notify onStream() callbacks (persistent listeners)
          if (this.streamCallbacks.length > 0) {
            for (const callback of this.streamCallbacks) {
              try {
                callback(stream);
              } catch (err) {
                this.logger.error("Error in stream callback:", err);
              }
            }
          } else {
            // Priority 3: Queue for later acceptStream() call
            this.pendingStreams.push(stream);
          }
        } catch (err) {
          if (this.state === "connected") {
            this.logger.error("Error accepting stream:", err);
            // Connection may have been lost
            this.handleDisconnect();
          }
          break;
        }
      }
    };

    loop().catch((err) => {
      this.logger.error("Stream accept loop crashed:", err);
      this.acceptStreamLoopRunning = false;
      this.streamLoopCrashCount++;

      // Auto-restart the loop if still connected and under crash limit
      if (this.state === "connected") {
        if (this.streamLoopCrashCount >= IrohPeerConnection.MAX_STREAM_LOOP_CRASHES) {
          this.logger.error(
            `Stream accept loop crashed ${this.streamLoopCrashCount} times, disconnecting.`
          );
          this.handleDisconnect();
          return;
        }
        const delay = Math.min(500 * Math.pow(2, this.streamLoopCrashCount - 1), 15000);
        this.logger.info(
          `Restarting stream accept loop after crash (attempt ${this.streamLoopCrashCount}/${IrohPeerConnection.MAX_STREAM_LOOP_CRASHES}) in ${delay}ms...`
        );
        setTimeout(() => this.startStreamAcceptLoop(), delay);
      }
    });
  }

  private handleDisconnect(): void {
    if (this.state === "disconnected") return;

    this.state = "disconnected";

    // Reject all pending acceptStream() promises
    const pendingAccepts = this.pendingAccepts;
    this.pendingAccepts = [];
    const disconnectError = TransportErrors.connectionFailed(this.peerId, "Connection lost");
    for (const pending of pendingAccepts) {
      try {
        pending.reject(disconnectError);
      } catch (err) {
        this.logger.debug("Error rejecting pending accept on disconnect:", err);
      }
    }

    for (const callback of this.stateCallbacks) {
      try {
        callback("disconnected");
      } catch (err) {
        this.logger.error("Error in state change callback:", err);
      }
    }
  }

  async openStream(): Promise<SyncStream> {
    if (this.state !== "connected") {
      throw TransportErrors.connectionFailed(this.peerId, "Connection not active");
    }

    const wasmStream = await this.wasmConn.openStream();
    const streamId = `${this.peerId}-out-${++this.streamCounter}`;
    const stream = new IrohSyncStream(wasmStream, streamId);

    this.streams.set(streamId, stream);
    this.logger.debug("Opened stream:", streamId);

    return stream;
  }

  async acceptStream(): Promise<SyncStream> {
    // Return pending stream if available
    if (this.pendingStreams.length > 0) {
      return this.pendingStreams.shift()!;
    }

    // Wait for incoming stream - using paired resolve/reject to avoid index mismatch
    return new Promise((resolve, reject) => {
      if (this.state !== "connected") {
        reject(TransportErrors.connectionFailed(this.peerId, "Connection not active"));
        return;
      }

      // Add paired resolve/reject - the accept loop will call resolve when a stream arrives
      this.pendingAccepts.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.state === "disconnected") return;

    this.state = "disconnected";

    // Close all active streams
    for (const stream of this.streams.values()) {
      await stream.close();
    }
    this.streams.clear();

    // Close all pending streams that were never claimed
    for (const stream of this.pendingStreams) {
      await stream.close();
    }
    this.pendingStreams = [];

    // Reject all pending acceptStream() promises
    const pendingAccepts = this.pendingAccepts;
    this.pendingAccepts = [];
    const closeError = TransportErrors.connectionFailed(this.peerId, "Connection closed");
    for (const pending of pendingAccepts) {
      try {
        pending.reject(closeError);
      } catch (err) {
        this.logger.debug("Error rejecting pending accept:", err);
      }
    }

    // Clear persistent stream callbacks
    this.streamCallbacks = [];

    // Close the WASM connection
    await this.wasmConn.close();
    this.wasmConn.free();

    // Notify state change (then clear callbacks)
    for (const callback of this.stateCallbacks) {
      try {
        callback("disconnected");
      } catch (err) {
        this.logger.error("Error in state change callback:", err);
      }
    }
    this.stateCallbacks = [];
  }

  isConnected(): boolean {
    return this.state === "connected" && this.wasmConn.isConnected();
  }

  getRttMs(): number | undefined {
    try {
      const rtt = this.wasmConn.getRttMs();
      return rtt > 0 ? rtt : undefined;
    } catch {
      return undefined;
    }
  }

  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateCallbacks.push(callback);
    return () => {
      const idx = this.stateCallbacks.indexOf(callback);
      if (idx >= 0) this.stateCallbacks.splice(idx, 1);
    };
  }

  onStream(callback: (stream: SyncStream) => void): () => void {
    this.streamCallbacks.push(callback);
    return () => {
      const idx = this.streamCallbacks.indexOf(callback);
      if (idx >= 0) this.streamCallbacks.splice(idx, 1);
    };
  }
}

/**
 * Iroh sync stream wrapper.
 */
class IrohSyncStream implements SyncStream {
  readonly id: string;

  private wasmStream: WasmStream;
  private open = true;

  constructor(wasmStream: WasmStream, id: string) {
    this.wasmStream = wasmStream;
    this.id = id;
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.open) {
      throw TransportErrors.streamClosed(this.id);
    }
    await this.wasmStream.send(data);
  }

  async receive(): Promise<Uint8Array> {
    if (!this.open) {
      throw TransportErrors.streamClosed(this.id);
    }
    return await this.wasmStream.receive();
  }

  async close(): Promise<void> {
    if (!this.open) return;

    this.open = false;
    await this.wasmStream.close();
    this.wasmStream.free();
  }

  isOpen(): boolean {
    return this.open;
  }
}
