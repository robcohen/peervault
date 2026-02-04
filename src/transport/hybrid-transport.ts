/**
 * Hybrid Transport
 *
 * Orchestrates Iroh and WebRTC transports for optimal connectivity.
 * Uses Iroh for signaling and fallback, WebRTC for direct LAN connections.
 */

import type {
  Transport,
  PeerConnection,
  SyncStream,
  TransportConfig,
  ConnectionState,
  TransportLogger,
} from "./types";
import { IrohTransport } from "./iroh-transport";
import {
  type WebRTCConfig,
  type SignalingMessage,
  type WebRTCConnectionMetrics,
  SignalingMessageType,
  DEFAULT_WEBRTC_CONFIG,
} from "./webrtc/types";
import { WebRTCPeerConnection, createWebRTCPeerConnection } from "./webrtc/webrtc-connection";
import {
  serializeSignalingMessage,
  deserializeSignalingMessage,
  createUpgradeRequest,
  createUpgradeAccept,
  createUpgradeReject,
  createOffer,
  createAnswer,
  createIceCandidate,
  createReady,
  isSignalingMessageType,
} from "./webrtc/signaling";
import { isWebRTCAvailable } from "./webrtc";

/** Delay before attempting WebRTC upgrade (ms) - longer to avoid sync interference */
const UPGRADE_DELAY_MS = 5000;  // 5s delay to allow initial sync handshake first

/** Time to wait for first message when detecting stream type (ms) */
const STREAM_DETECT_TIMEOUT_MS = 2000;

/**
 * Hybrid transport configuration.
 */
export interface HybridTransportConfig extends TransportConfig {
  /** Enable WebRTC upgrade attempts (default: true) */
  enableWebRTC?: boolean;

  /** Automatically attempt WebRTC upgrade after Iroh connects (default: true) */
  autoUpgradeToWebRTC?: boolean;

  /** Timeout for WebRTC upgrade in milliseconds (default: 10000) */
  webrtcUpgradeTimeout?: number;

  /** WebRTC-specific configuration */
  webrtcConfig?: Partial<WebRTCConfig>;

  /** DIAGNOSTIC: Bypass HybridConnection wrapper and use IrohPeerConnection directly */
  _bypassHybridWrapper?: boolean;
}

/**
 * Hybrid transport that combines Iroh and WebRTC.
 */
export class HybridTransport implements Transport {
  private irohTransport: IrohTransport;
  private config: HybridTransportConfig;
  private webrtcConfig: WebRTCConfig;
  private logger: TransportLogger;
  private nodeId: string = "";

  private connections = new Map<string, HybridConnection>();
  private incomingCallbacks: Array<(conn: PeerConnection) => void> = [];
  private ready = false;

  private webrtcAvailable: boolean;

  constructor(config: HybridTransportConfig) {
    this.config = config;
    this.logger = config.logger;
    this.webrtcConfig = {
      ...DEFAULT_WEBRTC_CONFIG,
      ...config.webrtcConfig,
    };

    // Create the underlying Iroh transport
    this.irohTransport = new IrohTransport(config);

    // Check WebRTC availability
    this.webrtcAvailable = isWebRTCAvailable();
    if (!this.webrtcAvailable) {
      this.logger.info("WebRTC not available, using Iroh only");
    }
  }

  async initialize(): Promise<void> {
    // Initialize the underlying Iroh transport
    await this.irohTransport.initialize();
    this.nodeId = this.irohTransport.getNodeId();

    // Set up incoming connection handler
    this.irohTransport.onIncomingConnection((conn) => {
      this.handleIncomingConnection(conn);
    });

    this.ready = true;
    this.logger.info(
      `HybridTransport initialized (WebRTC: ${this.webrtcAvailable ? "enabled" : "disabled"})`,
    );
  }

  getNodeId(): string {
    return this.irohTransport.getNodeId();
  }

  async generateTicket(): Promise<string> {
    return this.irohTransport.generateTicket();
  }

  async connectWithTicket(ticket: string): Promise<PeerConnection> {
    // Connect via Iroh first
    const irohConn = await this.irohTransport.connectWithTicket(ticket);
    const peerId = irohConn.peerId;

    // DIAGNOSTIC: Bypass HybridConnection if configured
    if (this.config._bypassHybridWrapper) {
      this.logger.debug("[Hybrid] Bypassing HybridConnection wrapper (diagnostic mode)");
      return irohConn;
    }

    // Check for existing hybrid connection
    const existing = this.connections.get(peerId);
    if (existing?.isConnected()) {
      return existing;
    }

    // Create hybrid connection wrapper
    const hybridConn = new HybridConnection(
      peerId,
      irohConn,
      this.logger,
      this.webrtcConfig,
      this.shouldAttemptWebRTC(),
    );

    this.connections.set(peerId, hybridConn);

    // Schedule WebRTC upgrade attempt
    this.scheduleWebRTCUpgrade(hybridConn);

    return hybridConn;
  }

  private handleIncomingConnection(irohConn: PeerConnection): void {
    const peerId = irohConn.peerId;
    this.logger.info(`[HybridTransport] Incoming connection from ${peerId.slice(0, 8)}, ${this.incomingCallbacks.length} callbacks registered`);

    // DIAGNOSTIC: Bypass HybridConnection if configured
    if (this.config._bypassHybridWrapper) {
      this.logger.debug("[Hybrid] Bypassing HybridConnection wrapper for incoming (diagnostic mode)");
      // Notify callbacks with raw IrohPeerConnection
      for (const callback of this.incomingCallbacks) {
        try {
          callback(irohConn);
        } catch (err) {
          this.logger.error("Error in incoming connection callback:", err);
        }
      }
      return;
    }

    // Create hybrid connection wrapper
    const hybridConn = new HybridConnection(
      peerId,
      irohConn,
      this.logger,
      this.webrtcConfig,
      this.shouldAttemptWebRTC(),
    );

    this.connections.set(peerId, hybridConn);

    // Schedule WebRTC upgrade attempt
    this.scheduleWebRTCUpgrade(hybridConn);

    // Notify callbacks
    for (const callback of this.incomingCallbacks) {
      try {
        callback(hybridConn);
      } catch (err) {
        this.logger.error("Error in incoming connection callback:", err);
      }
    }
  }

  /**
   * Schedule WebRTC upgrade attempt after connection stabilizes.
   * Uses deterministic initiator selection based on peer ID comparison.
   */
  private scheduleWebRTCUpgrade(conn: HybridConnection): void {
    if (!this.shouldAttemptWebRTC() || this.config.autoUpgradeToWebRTC === false) {
      return;
    }

    // Delay to let sync establish first
    setTimeout(() => {
      // Mark that upgrade timer has fired - now we should detect signaling streams
      conn.markUpgradeScheduled();

      if (!conn.isConnected() || conn.isWebRTCActive()) {
        return; // Connection closed or already upgraded
      }

      // Deterministic initiator: lower peer ID initiates
      const shouldInitiate = this.nodeId < conn.peerId;

      this.logger.debug(
        `[Hybrid ${conn.peerId}] Scheduling WebRTC upgrade (initiator: ${shouldInitiate})`,
      );

      conn.attemptWebRTCUpgrade(shouldInitiate).catch((err) => {
        this.logger.debug(`[Hybrid ${conn.peerId}] WebRTC upgrade failed:`, err);
      });
    }, UPGRADE_DELAY_MS);
  }

  onIncomingConnection(callback: (conn: PeerConnection) => void): () => void {
    this.incomingCallbacks.push(callback);
    return () => {
      const idx = this.incomingCallbacks.indexOf(callback);
      if (idx >= 0) this.incomingCallbacks.splice(idx, 1);
    };
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

    // Close all hybrid connections
    for (const conn of this.connections.values()) {
      await conn.close();
    }
    this.connections.clear();

    // Shutdown Iroh transport
    await this.irohTransport.shutdown();

    this.logger.info("HybridTransport shut down");
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Check if WebRTC upgrade should be attempted.
   */
  private shouldAttemptWebRTC(): boolean {
    return (
      this.webrtcAvailable &&
      this.config.enableWebRTC !== false
    );
  }

  /**
   * Get WebRTC availability status.
   */
  isWebRTCAvailable(): boolean {
    return this.webrtcAvailable;
  }
}

/**
 * Hybrid connection that wraps Iroh and optionally WebRTC connections.
 */
export class HybridConnection implements PeerConnection {
  readonly peerId: string;

  private irohConn: PeerConnection;
  private webrtcConn: WebRTCPeerConnection | null = null;
  private logger: TransportLogger;
  private webrtcConfig: WebRTCConfig;
  private webrtcEnabled: boolean;

  private _state: ConnectionState = "connected";
  private stateCallbacks: Array<(state: ConnectionState) => void> = [];
  private streamCallbacks: Array<(stream: SyncStream) => void> = [];

  private upgradeInProgress = false;
  private signalingStream: SyncStream | null = null;
  private upgradeScheduled = false;  // True after the upgrade timer has fired

  constructor(
    peerId: string,
    irohConn: PeerConnection,
    logger: TransportLogger,
    webrtcConfig: WebRTCConfig,
    webrtcEnabled: boolean,
  ) {
    this.peerId = peerId;
    this.irohConn = irohConn;
    this.logger = logger;
    this.webrtcConfig = webrtcConfig;
    this.webrtcEnabled = webrtcEnabled;

    // Listen for Iroh connection state changes
    irohConn.onStateChange((state) => {
      if (state === "disconnected" || state === "error") {
        this.handleIrohDisconnect();
      }
    });

    // NOTE: We do NOT register an onStream callback on IrohPeerConnection here!
    // Instead, we rely on getPendingStreamCount() and acceptStream() which properly
    // forward to IrohPeerConnection. And when peer-manager registers onStream on
    // HybridConnection, we forward those callbacks too.
    //
    // The old approach of registering a callback here caused issues because:
    // 1. Streams arriving before peer-manager registered went to pendingStreams
    // 2. But IrohPeerConnection's pendingStreams might also have streams
    // 3. This created confusion about where streams were queued
    //
    // The new approach: streams stay in IrohPeerConnection until something asks for them
    // via acceptStream, or until we forward the callback in onStream().
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Handle Iroh connection disconnect.
   */
  private handleIrohDisconnect(): void {
    // If WebRTC is connected, we can continue
    if (this.webrtcConn?.isConnected()) {
      this.logger.info(
        `[Hybrid ${this.peerId}] Iroh disconnected but WebRTC still active`,
      );
      return;
    }

    // Both transports down
    this._state = "disconnected";
    this.notifyStateChange();
  }

  /**
   * Handle incoming stream - detect type when WebRTC upgrade is expected.
   */
  private handleIncomingStream(stream: SyncStream): void {
    // Only detect stream type if we're expecting a WebRTC upgrade
    // (after the upgrade timer has fired and WebRTC isn't already connected)
    if (this.upgradeScheduled && !this.webrtcConn) {
      this.detectAndHandleStream(stream).catch((err) => {
        this.logger.error(`[Hybrid ${this.peerId}] Stream handling error:`, err);
      });
    } else {
      // Normal case: forward directly to callbacks
      this.forwardStreamToCallbacks(stream);
    }
  }

  /**
   * Detect stream type by reading first message and handle appropriately.
   * Uses a timeout to avoid blocking forever, but never loses data.
   */
  private async detectAndHandleStream(stream: SyncStream): Promise<void> {
    const streamId = stream.id;
    this.logger.debug(`[Hybrid ${this.peerId}] detectAndHandleStream: stream ${streamId} - starting detection`);

    try {
      // Start receiving the first message
      const receivePromise = stream.receive();

      // Race against timeout
      let firstMessage: Uint8Array | undefined;
      let timedOut = false;

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, STREAM_DETECT_TIMEOUT_MS);
      });

      await Promise.race([
        receivePromise.then((data) => { firstMessage = data; }),
        timeoutPromise,
      ]);

      if (timedOut && firstMessage === undefined) {
        // Timeout - create lazy replay stream that awaits the pending receive
        this.logger.debug(`[Hybrid ${this.peerId}] Stream ${streamId} detection timeout, forwarding with lazy replay`);
        const lazyStream = this.createLazyReplayStream(stream, receivePromise);
        this.forwardStreamToCallbacks(lazyStream);
        return;
      }

      // We have the first message (either received before timeout or race completed)
      const message = firstMessage ?? await receivePromise;
      this.logger.debug(`[Hybrid ${this.peerId}] Stream ${streamId} first byte: 0x${message[0]?.toString(16).padStart(2, '0')} (len=${message.length})`);


      // Check the first byte to determine stream type
      if (message.length === 0) {
        // Empty message - treat as sync stream
        const replayStream = this.createReplayStream(stream, message);
        this.forwardStreamToCallbacks(replayStream);
        return;
      }

      const firstByte = message[0]!; // Safe: we checked length > 0 above

      if (firstByte === SignalingMessageType.UPGRADE_REQUEST) {
        // This is a signaling stream with an upgrade request
        this.logger.debug(`[Hybrid ${this.peerId}] Received WebRTC upgrade request on stream ${streamId}`);
        await this.handleWebRTCUpgradeRequest(stream, message);
        return;
      }

      if (isSignalingMessageType(firstByte)) {
        // Other signaling message - unexpected, close stream
        this.logger.warn(`[Hybrid ${this.peerId}] Unexpected signaling message type ${firstByte}`);
        await stream.close();
        return;
      }

      // Regular sync stream - create replay wrapper and forward
      this.logger.debug(`[Hybrid ${this.peerId}] Stream ${streamId} forwarding as sync stream`);
      const replayStream = this.createReplayStream(stream, message);
      this.forwardStreamToCallbacks(replayStream);

    } catch (err) {
      this.logger.error(`[Hybrid ${this.peerId}] Stream ${streamId} detection error:`, err);
      // On error, try to forward the original stream
      this.forwardStreamToCallbacks(stream);
    }
  }

  /**
   * Create a lazy replay stream that awaits a pending first message promise.
   * This prevents data loss when stream detection times out.
   */
  private createLazyReplayStream(stream: SyncStream, firstMessagePromise: Promise<Uint8Array>): SyncStream {
    let firstMessageConsumed = false;

    return {
      id: stream.id,
      send: (data: Uint8Array) => stream.send(data),
      receive: async () => {
        if (!firstMessageConsumed) {
          firstMessageConsumed = true;
          return await firstMessagePromise;
        }
        return stream.receive();
      },
      close: () => stream.close(),
      isOpen: () => stream.isOpen(),
    };
  }

  /**
   * Create a stream wrapper that replays the first message.
   */
  private createReplayStream(stream: SyncStream, firstMessage: Uint8Array): SyncStream {
    let firstMessageConsumed = false;

    return {
      id: stream.id,
      send: (data: Uint8Array) => stream.send(data),
      receive: async () => {
        if (!firstMessageConsumed) {
          firstMessageConsumed = true;
          return firstMessage;
        }
        return stream.receive();
      },
      close: () => stream.close(),
      isOpen: () => stream.isOpen(),
    };
  }

  /**
   * Forward stream to registered callbacks.
   * Called by the forwarding callback registered on IrohPeerConnection.
   */
  private forwardStreamToCallbacks(stream: SyncStream): void {
    // This should only be called when callbacks are registered
    if (this.streamCallbacks.length === 0) {
      // This shouldn't happen, but log if it does
      this.logger.warn(`[Hybrid ${this.peerId.slice(0, 8)}] forwardStreamToCallbacks called with no callbacks registered!`);
      return;
    }

    // Deliver to first callback only (there should only be one)
    const callback = this.streamCallbacks[0]!;
    try {
      callback(stream);
    } catch (err) {
      this.logger.error(`[Hybrid ${this.peerId}] Stream callback error:`, err);
    }
  }

  /**
   * Handle WebRTC upgrade request from remote peer.
   * The first message (UPGRADE_REQUEST) has already been received.
   */
  private async handleWebRTCUpgradeRequest(stream: SyncStream, firstMessage: Uint8Array): Promise<void> {

    // Verify it's actually an upgrade request
    try {
      const msg = deserializeSignalingMessage(firstMessage);
      if (msg.type !== SignalingMessageType.UPGRADE_REQUEST) {
        this.logger.warn(`[Hybrid ${this.peerId}] Expected UPGRADE_REQUEST, got ${msg.type}`);
        await stream.close();
        return;
      }
    } catch (err) {
      this.logger.warn(`[Hybrid ${this.peerId}] Invalid upgrade request message:`, err);
      await stream.close();
      return;
    }

    // Check if we can accept the upgrade
    if (this.upgradeInProgress) {
      this.logger.debug(`[Hybrid ${this.peerId}] Rejecting upgrade - already in progress`);
      try {
        await stream.send(serializeSignalingMessage(createUpgradeReject("Already upgrading")));
      } catch { /* ignore */ }
      await stream.close();
      return;
    }

    if (this.webrtcConn) {
      this.logger.debug(`[Hybrid ${this.peerId}] Rejecting upgrade - already connected`);
      try {
        await stream.send(serializeSignalingMessage(createUpgradeReject("Already connected")));
      } catch { /* ignore */ }
      await stream.close();
      return;
    }

    if (!isWebRTCAvailable()) {
      this.logger.debug(`[Hybrid ${this.peerId}] Rejecting upgrade - WebRTC not available`);
      try {
        await stream.send(serializeSignalingMessage(createUpgradeReject("WebRTC not available")));
      } catch { /* ignore */ }
      await stream.close();
      return;
    }

    // Accept and handle the upgrade
    this.upgradeInProgress = true;
    this.signalingStream = stream;

    try {
      // Send accept
      await this.sendSignaling(createUpgradeAccept());
      this.logger.debug(`[Hybrid ${this.peerId}] Accepted WebRTC upgrade request`);

      // Create WebRTC peer connection
      this.webrtcConn = createWebRTCPeerConnection(
        this.peerId,
        this.logger,
        this.webrtcConfig,
      );

      // Set up ICE candidate handling
      const pc = this.webrtcConn.getRTCPeerConnection();
      pc.onicecandidate = async (event) => {
        if (event.candidate && this.signalingStream?.isOpen()) {
          try {
            await this.sendSignaling(createIceCandidate(event.candidate));
          } catch (err) {
            this.logger.debug(`[Hybrid ${this.peerId}] Failed to send ICE candidate:`, err);
          }
        }
      };

      // Wait for offer
      const offerMsg = await this.receiveSignalingWithTimeout();
      if (offerMsg.type !== SignalingMessageType.OFFER) {
        throw new Error(`Expected OFFER, got ${offerMsg.type}`);
      }

      this.logger.debug(`[Hybrid ${this.peerId}] Received WebRTC offer`);

      // Set remote description and create answer
      await this.webrtcConn.setRemoteDescription({
        type: "offer",
        sdp: (offerMsg as { sdp: string }).sdp,
      });

      const answer = await this.webrtcConn.createAnswer();
      await this.sendSignaling(createAnswer(answer.sdp!));
      this.logger.debug(`[Hybrid ${this.peerId}] Sent WebRTC answer`);

      // Complete connection with ICE candidate exchange
      const success = await this.completeWebRTCConnection();

      if (success) {
        this.logger.info(`[Hybrid ${this.peerId}] WebRTC upgrade successful (direct: ${this.webrtcConn?.isDirect()})`);
      } else {
        this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade failed to complete`);
        if (this.webrtcConn) {
          await this.webrtcConn.close();
          this.webrtcConn = null;
        }
      }
    } catch (err) {
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade error:`, err);
      if (this.webrtcConn) {
        await this.webrtcConn.close();
        this.webrtcConn = null;
      }
    } finally {
      this.upgradeInProgress = false;
      if (this.signalingStream) {
        try {
          await this.signalingStream.close();
        } catch { /* ignore */ }
        this.signalingStream = null;
      }
    }
  }

  /**
   * Attempt to upgrade to WebRTC.
   *
   * @param isInitiator - True if we should initiate the upgrade
   */
  async attemptWebRTCUpgrade(isInitiator: boolean): Promise<boolean> {
    if (!this.webrtcEnabled) {
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade skipped - disabled`);
      return false;
    }

    if (this.upgradeInProgress) {
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade skipped - already in progress`);
      return false;
    }

    if (this.webrtcConn) {
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade skipped - already connected`);
      return false;
    }

    if (!this.irohConn.isConnected()) {
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade skipped - Iroh not connected`);
      return false;
    }

    this.upgradeInProgress = true;
    this.logger.debug(
      `[Hybrid ${this.peerId}] Attempting WebRTC upgrade (initiator: ${isInitiator})`,
    );

    try {
      if (isInitiator) {
        return await this.initiateWebRTCUpgrade();
      } else {
        // Non-initiator waits for upgrade request via incoming stream
        // The handleIncomingStream will detect and handle it
        this.logger.debug(`[Hybrid ${this.peerId}] Waiting for WebRTC upgrade request`);
        return false; // Will be handled by handleWebRTCUpgradeRequest
      }
    } catch (err) {
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade failed:`, err);
      return false;
    } finally {
      this.upgradeInProgress = false;
      if (this.signalingStream) {
        try {
          await this.signalingStream.close();
        } catch { /* ignore */ }
        this.signalingStream = null;
      }
    }
  }

  /**
   * Initiate WebRTC upgrade (we create the offer).
   */
  private async initiateWebRTCUpgrade(): Promise<boolean> {

    // Open signaling stream
    this.signalingStream = await this.irohConn.openStream();
    this.logger.debug(`[Hybrid ${this.peerId}] Opened signaling stream`);

    // Send upgrade request
    await this.sendSignaling(createUpgradeRequest());
    this.logger.debug(`[Hybrid ${this.peerId}] Sent upgrade request`);

    // Wait for response
    const response = await this.receiveSignalingWithTimeout();

    if (response.type === SignalingMessageType.UPGRADE_REJECT) {
      const reason = (response as { reason: string }).reason;
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade rejected: ${reason}`);
      return false;
    }

    if (response.type !== SignalingMessageType.UPGRADE_ACCEPT) {
      throw new Error(`Unexpected response type: ${response.type}`);
    }

    this.logger.debug(`[Hybrid ${this.peerId}] Upgrade accepted, creating WebRTC connection`);

    // Create WebRTC peer connection
    this.webrtcConn = createWebRTCPeerConnection(
      this.peerId,
      this.logger,
      this.webrtcConfig,
    );

    // Set up ICE candidate handling
    const pc = this.webrtcConn.getRTCPeerConnection();
    pc.onicecandidate = async (event) => {
      if (event.candidate && this.signalingStream?.isOpen()) {
        try {
          await this.sendSignaling(createIceCandidate(event.candidate));
        } catch (err) {
          this.logger.debug(`[Hybrid ${this.peerId}] Failed to send ICE candidate:`, err);
        }
      }
    };

    // Create and send offer
    const offer = await this.webrtcConn.createOffer();
    await this.sendSignaling(createOffer(offer.sdp!));
    this.logger.debug(`[Hybrid ${this.peerId}] Sent WebRTC offer`);

    // Wait for answer
    const answerMsg = await this.receiveSignalingWithTimeout();
    if (answerMsg.type !== SignalingMessageType.ANSWER) {
      throw new Error(`Expected ANSWER, got ${answerMsg.type}`);
    }

    this.logger.debug(`[Hybrid ${this.peerId}] Received WebRTC answer`);

    // Set remote description
    await this.webrtcConn.setRemoteDescription({
      type: "answer",
      sdp: (answerMsg as { sdp: string }).sdp,
    });

    // Complete connection with ICE candidate exchange
    const success = await this.completeWebRTCConnection();

    if (success) {
      this.logger.info(`[Hybrid ${this.peerId}] WebRTC upgrade successful (direct: ${this.webrtcConn?.isDirect()})`);
    } else {
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC connection failed`);
      if (this.webrtcConn) {
        await this.webrtcConn.close();
        this.webrtcConn = null;
      }
    }

    return success;
  }

  /**
   * Complete WebRTC connection by exchanging ICE candidates.
   */
  private async completeWebRTCConnection(): Promise<boolean> {
    if (!this.webrtcConn || !this.signalingStream) return false;

    const pc = this.webrtcConn.getRTCPeerConnection();

    // Track connection state (use addEventListener to avoid overwriting WebRTCPeerConnection's handler)
    let connectionResolved = false;
    const connectionPromise = new Promise<boolean>((resolve) => {
      const checkState = () => {
        if (connectionResolved) return;
        if (pc.connectionState === "connected") {
          connectionResolved = true;
          resolve(true);
        } else if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          connectionResolved = true;
          resolve(false);
        }
      };

      pc.addEventListener("connectionstatechange", checkState);
      checkState();
    });

    // Process ICE candidates in background
    const iceCandidateLoop = (async () => {
      while (this.signalingStream?.isOpen() && !connectionResolved) {
        try {
          const msg = await this.receiveSignalingWithTimeout();

          if (msg.type === SignalingMessageType.ICE_CANDIDATE) {
            const iceMsg = msg as {
              candidate: string;
              sdpMid: string | null;
              sdpMLineIndex: number | null;
            };
            this.logger.debug(`[Hybrid ${this.peerId}] Received ICE candidate`);
            await this.webrtcConn!.addIceCandidate({
              candidate: iceMsg.candidate,
              sdpMid: iceMsg.sdpMid ?? undefined,
              sdpMLineIndex: iceMsg.sdpMLineIndex ?? undefined,
            });
          } else if (msg.type === SignalingMessageType.READY) {
            this.logger.debug(`[Hybrid ${this.peerId}] Received READY signal`);
            break;
          }
        } catch {
          // Timeout or stream closed
          break;
        }
      }
    })();

    // Race connection vs timeout
    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        connectionResolved = true;
        resolve(false);
      }, this.webrtcConfig.connectionTimeout);
    });

    const connected = await Promise.race([connectionPromise, timeoutPromise]);

    // Clean up ICE candidate loop
    connectionResolved = true;
    await iceCandidateLoop;

    if (connected) {
      // Send ready message
      if (this.signalingStream?.isOpen()) {
        try {
          await this.sendSignaling(createReady());
        } catch { /* ignore */ }
      }

      // Listen for WebRTC disconnect
      this.webrtcConn!.onStateChange((state) => {
        if (state === "disconnected" || state === "error") {
          this.handleWebRTCDisconnect();
        }
      });

      // Forward incoming WebRTC streams to callbacks
      this.webrtcConn!.onStream((stream) => {
        this.logger.debug(`[Hybrid ${this.peerId}] Received stream via WebRTC`);
        this.forwardStreamToCallbacks(stream);
      });

      return true;
    }

    return false;
  }

  /**
   * Handle WebRTC disconnect - fall back to Iroh.
   */
  private handleWebRTCDisconnect(): void {
    this.logger.info(`[Hybrid ${this.peerId}] WebRTC disconnected, using Iroh`);
    this.webrtcConn = null;

    // Check if Iroh is still connected
    if (!this.irohConn.isConnected()) {
      this._state = "disconnected";
      this.notifyStateChange();
    }
  }

  /**
   * Send a signaling message.
   */
  private async sendSignaling(msg: SignalingMessage): Promise<void> {
    if (!this.signalingStream) {
      throw new Error("No signaling stream");
    }
    const data = serializeSignalingMessage(msg);
    await this.signalingStream.send(data);
  }

  /**
   * Receive a signaling message with timeout.
   */
  private async receiveSignalingWithTimeout(): Promise<SignalingMessage> {
    if (!this.signalingStream) {
      throw new Error("No signaling stream");
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Signaling timeout")),
        this.webrtcConfig.signalingTimeout,
      );
    });

    const data = await Promise.race([
      this.signalingStream.receive(),
      timeoutPromise,
    ]);

    return deserializeSignalingMessage(data);
  }

  /**
   * Notify state change callbacks.
   */
  private notifyStateChange(): void {
    for (const callback of this.stateCallbacks) {
      try {
        callback(this._state);
      } catch (err) {
        this.logger.error(`[Hybrid ${this.peerId}] State callback error:`, err);
      }
    }
  }

  // PeerConnection interface implementation

  async openStream(): Promise<SyncStream> {
    this.logger.debug(`[Hybrid ${this.peerId.slice(0, 8)}] openStream called, WebRTC connected: ${this.webrtcConn?.isConnected()}`);
    // Prefer WebRTC for lower latency when available
    if (this.webrtcConn?.isConnected()) {
      try {
        return await this.webrtcConn.openStream();
      } catch (err) {
        this.logger.debug(`[Hybrid ${this.peerId}] WebRTC openStream failed, using Iroh:`, err);
      }
    }
    const stream = await this.irohConn.openStream();
    this.logger.debug(`[Hybrid ${this.peerId.slice(0, 8)}] openStream completed, stream: ${stream.id}`);
    return stream;
  }

  async acceptStream(): Promise<SyncStream> {
    // Prefer WebRTC for lower latency when available
    if (this.webrtcConn?.isConnected()) {
      try {
        return await this.webrtcConn.acceptStream();
      } catch (err) {
        this.logger.debug(`[Hybrid ${this.peerId}] WebRTC acceptStream failed, using Iroh:`, err);
      }
    }
    // Fall through to IrohPeerConnection which handles pending streams
    return this.irohConn.acceptStream();
  }

  async close(): Promise<void> {
    // Close WebRTC if active
    if (this.webrtcConn) {
      await this.webrtcConn.close();
      this.webrtcConn = null;
    }

    // Close signaling stream if open
    if (this.signalingStream) {
      try {
        await this.signalingStream.close();
      } catch { /* ignore */ }
      this.signalingStream = null;
    }

    // Close Iroh connection
    await this.irohConn.close();

    this._state = "disconnected";
    this.notifyStateChange();
  }

  isConnected(): boolean {
    return (
      this._state === "connected" &&
      (this.irohConn.isConnected() || (this.webrtcConn?.isConnected() ?? false))
    );
  }

  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateCallbacks.push(callback);
    return () => {
      const idx = this.stateCallbacks.indexOf(callback);
      if (idx >= 0) this.stateCallbacks.splice(idx, 1);
    };
  }

  onStream(callback: (stream: SyncStream) => void): () => void {
    const irohPending = this.irohConn.getPendingStreamCount();
    this.logger.debug(`[Hybrid ${this.peerId.slice(0, 8)}] onStream: registering callback, ${irohPending} pending in IrohPeerConnection`);

    this.streamCallbacks.push(callback);

    // Register a callback on IrohPeerConnection to forward streams to our callbacks
    // This only happens when the first callback is registered
    if (this.streamCallbacks.length === 1) {
      this.logger.debug(`[Hybrid ${this.peerId.slice(0, 8)}] Registering forwarding callback on IrohPeerConnection`);
      this.irohConn.onStream((stream) => {
        this.logger.debug(`[Hybrid ${this.peerId.slice(0, 8)}] IrohPeerConnection delivered stream ${stream.id}`);
        this.forwardStreamToCallbacks(stream);
      });
    }

    return () => {
      const idx = this.streamCallbacks.indexOf(callback);
      if (idx >= 0) this.streamCallbacks.splice(idx, 1);
    };
  }

  getRttMs(): number | undefined {
    // Prefer WebRTC RTT if available
    if (this.webrtcConn?.isConnected()) {
      const webrtcRtt = this.webrtcConn.getRttMs();
      if (webrtcRtt !== undefined) {
        return webrtcRtt;
      }
    }
    return this.irohConn.getRttMs();
  }

  getPendingStreamCount(): number {
    // Just forward to IrohPeerConnection - we no longer queue streams ourselves
    return this.irohConn.getPendingStreamCount();
  }

  // Hybrid-specific methods

  /**
   * Check if WebRTC is active.
   */
  isWebRTCActive(): boolean {
    return this.webrtcConn?.isConnected() ?? false;
  }

  /**
   * Mark that the upgrade timer has fired.
   * After this, we should start detecting signaling streams.
   */
  markUpgradeScheduled(): void {
    this.upgradeScheduled = true;
  }

  /**
   * Check if using direct WebRTC connection.
   */
  isDirectConnection(): boolean {
    return this.webrtcConn?.isDirect() ?? false;
  }

  /**
   * Get WebRTC connection metrics.
   */
  getWebRTCMetrics(): WebRTCConnectionMetrics | null {
    return this.webrtcConn?.getMetrics() ?? null;
  }

  /**
   * Get connection type description.
   */
  getConnectionType(): string {
    if (this.webrtcConn?.isConnected()) {
      return this.webrtcConn.isDirect() ? "WebRTC (direct)" : "WebRTC (relay)";
    }
    return "Iroh (relay)";
  }
}
