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

// Type definitions matching the WASM module exports
interface WasmEndpoint {
  nodeId(): string;
  secretKeyBytes(): Uint8Array;
  generateTicket(): Promise<string>;
  connectWithTicket(ticket: string): Promise<WasmConnection>;
  acceptConnection(): Promise<WasmConnection>;
  close(): Promise<void>;
  free(): void;
}

interface WasmEndpointStatic {
  create(keyBytes?: Uint8Array | null): Promise<WasmEndpoint>;
}

interface WasmConnection {
  remoteNodeId(): string;
  openStream(): Promise<WasmStream>;
  acceptStream(): Promise<WasmStream>;
  isConnected(): boolean;
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
 * @param jsUrl - URL or path to the peervault_iroh.js file (from getResourcePath)
 * @param wasmUrl - Optional URL or path to the .wasm file (auto-detected if not provided)
 */
export async function initIrohWasm(
  jsUrl?: string,
  wasmUrl?: string,
): Promise<void> {
  // Prevent multiple initializations
  if (wasmInitialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Dynamic import of the WASM module
      // In Obsidian, jsUrl should be the full path from getResourcePath()
      const modulePath = jsUrl ?? "./peervault_iroh.js";

      // Use Function constructor to create dynamic import (works around bundler issues)
      const importFn = new Function("url", "return import(url)");
      const module = (await importFn(modulePath)) as IrohWasmModule;

      // Initialize the WASM module
      // If wasmUrl is provided, pass it to the init function
      if (wasmUrl) {
        await module.default({ module_or_path: wasmUrl });
      } else {
        // Let it auto-detect the wasm file location (same directory as JS)
        await module.default();
      }

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

  constructor(config: TransportConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (!wasmModule) {
      throw new Error(
        "Iroh WASM module not initialized. Call initIrohWasm() first.",
      );
    }

    // Load existing secret key or create new one
    const storedKey = await this.config.storage.loadSecretKey();
    const keyBytes = storedKey && storedKey.length === 32 ? storedKey : null;

    this.config.logger.debug("Creating Iroh endpoint...");

    // Create the endpoint
    this.endpoint = await wasmModule.WasmEndpoint.create(keyBytes ?? undefined);

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
      throw new Error("Transport not initialized");
    }
    return this.endpoint.nodeId();
  }

  async generateTicket(): Promise<string> {
    if (!this.endpoint) {
      throw new Error("Transport not initialized");
    }

    this.config.logger.debug("Generating connection ticket...");
    const ticket = await this.endpoint.generateTicket();
    this.config.logger.debug("Ticket generated");
    return ticket;
  }

  async connectWithTicket(ticket: string): Promise<PeerConnection> {
    if (!this.endpoint) {
      throw new Error("Transport not initialized");
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

  onIncomingConnection(callback: (conn: PeerConnection) => void): void {
    this.incomingCallbacks.push(callback);
  }

  private startAcceptLoop(): void {
    if (this.acceptLoopRunning) return;
    this.acceptLoopRunning = true;

    const acceptLoop = async () => {
      while (this.ready && this.endpoint) {
        try {
          this.config.logger.debug("Waiting for incoming connection...");
          const wasmConn = await this.endpoint.acceptConnection();
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
            this.config.logger.error("Error accepting connection:", err);
            // Small delay before retrying
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
    };

    // Run accept loop in background
    acceptLoop().catch((err) => {
      this.config.logger.error("Accept loop crashed:", err);
      this.acceptLoopRunning = false;
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

    // Close all connections
    for (const conn of this.connections.values()) {
      await conn.close();
    }
    this.connections.clear();

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
  private streamCallbacks: Array<(stream: SyncStream) => void> = [];
  private streamCounter = 0;
  private logger: TransportConfig["logger"];
  private acceptStreamLoopRunning = false;

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

          // Add to pending or notify callbacks
          if (this.streamCallbacks.length > 0) {
            for (const callback of this.streamCallbacks) {
              try {
                callback(stream);
              } catch (err) {
                this.logger.error("Error in stream callback:", err);
              }
            }
          } else {
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
    });
  }

  private handleDisconnect(): void {
    if (this.state === "disconnected") return;

    this.state = "disconnected";
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
      throw new Error("Connection not active");
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

    // Wait for incoming stream
    return new Promise((resolve, reject) => {
      if (this.state !== "connected") {
        reject(new Error("Connection not active"));
        return;
      }

      const handler = (stream: SyncStream) => {
        resolve(stream);
        // Remove this one-time handler
        const idx = this.streamCallbacks.indexOf(handler);
        if (idx >= 0) this.streamCallbacks.splice(idx, 1);
      };
      this.streamCallbacks.push(handler);
    });
  }

  async close(): Promise<void> {
    if (this.state === "disconnected") return;

    this.state = "disconnected";

    // Close all streams
    for (const stream of this.streams.values()) {
      await stream.close();
    }
    this.streams.clear();

    // Close the WASM connection
    await this.wasmConn.close();
    this.wasmConn.free();

    // Notify state change
    for (const callback of this.stateCallbacks) {
      try {
        callback("disconnected");
      } catch (err) {
        this.logger.error("Error in state change callback:", err);
      }
    }
  }

  isConnected(): boolean {
    return this.state === "connected" && this.wasmConn.isConnected();
  }

  onStateChange(callback: (state: ConnectionState) => void): void {
    this.stateCallbacks.push(callback);
  }

  onStream(callback: (stream: SyncStream) => void): void {
    this.streamCallbacks.push(callback);
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
      throw new Error("Stream is closed");
    }
    await this.wasmStream.send(data);
  }

  async receive(): Promise<Uint8Array> {
    if (!this.open) {
      throw new Error("Stream is closed");
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
