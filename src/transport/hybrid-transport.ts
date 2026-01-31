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
}

/**
 * Hybrid transport that combines Iroh and WebRTC.
 */
export class HybridTransport implements Transport {
  private irohTransport: IrohTransport;
  private config: HybridTransportConfig;
  private webrtcConfig: WebRTCConfig;
  private logger: TransportLogger;

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

    // Attempt WebRTC upgrade in background if enabled
    if (this.shouldAttemptWebRTC() && this.config.autoUpgradeToWebRTC !== false) {
      hybridConn.attemptWebRTCUpgrade(true).catch((err) => {
        this.logger.debug(`WebRTC upgrade failed for ${peerId}:`, err);
      });
    }

    return hybridConn;
  }

  private handleIncomingConnection(irohConn: PeerConnection): void {
    const peerId = irohConn.peerId;

    // Create hybrid connection wrapper
    const hybridConn = new HybridConnection(
      peerId,
      irohConn,
      this.logger,
      this.webrtcConfig,
      this.shouldAttemptWebRTC(),
    );

    this.connections.set(peerId, hybridConn);

    // Notify callbacks
    for (const callback of this.incomingCallbacks) {
      try {
        callback(hybridConn);
      } catch (err) {
        this.logger.error("Error in incoming connection callback:", err);
      }
    }
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

    // Forward stream events from Iroh (for signaling and regular streams)
    irohConn.onStream((stream) => {
      this.handleIncomingStream(stream);
    });
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
   * Handle incoming stream (check for signaling messages).
   */
  private handleIncomingStream(stream: SyncStream): void {
    // Forward to stream callbacks
    for (const callback of this.streamCallbacks) {
      try {
        callback(stream);
      } catch (err) {
        this.logger.error(`[Hybrid ${this.peerId}] Stream callback error:`, err);
      }
    }
  }

  /**
   * Attempt to upgrade to WebRTC.
   *
   * @param isInitiator - True if we should initiate the upgrade
   */
  async attemptWebRTCUpgrade(isInitiator: boolean): Promise<boolean> {
    if (!this.webrtcEnabled || this.upgradeInProgress || this.webrtcConn) {
      return false;
    }

    this.upgradeInProgress = true;
    this.logger.debug(
      `[Hybrid ${this.peerId}] Attempting WebRTC upgrade (initiator: ${isInitiator})`,
    );

    try {
      // Open signaling stream over Iroh
      this.signalingStream = await this.irohConn.openStream();

      if (isInitiator) {
        return await this.initiateWebRTCUpgrade();
      } else {
        return await this.respondToWebRTCUpgrade();
      }
    } catch (err) {
      this.logger.debug(`[Hybrid ${this.peerId}] WebRTC upgrade failed:`, err);
      return false;
    } finally {
      this.upgradeInProgress = false;
      if (this.signalingStream) {
        await this.signalingStream.close();
        this.signalingStream = null;
      }
    }
  }

  /**
   * Initiate WebRTC upgrade (we create the offer).
   */
  private async initiateWebRTCUpgrade(): Promise<boolean> {
    if (!this.signalingStream) return false;

    // Send upgrade request
    await this.sendSignaling(createUpgradeRequest());

    // Wait for response
    const response = await this.receiveSignalingWithTimeout();

    if (response.type === SignalingMessageType.UPGRADE_REJECT) {
      this.logger.debug(
        `[Hybrid ${this.peerId}] WebRTC upgrade rejected: ${(response as { reason: string }).reason}`,
      );
      return false;
    }

    if (response.type !== SignalingMessageType.UPGRADE_ACCEPT) {
      throw new Error(`Unexpected response: ${response.type}`);
    }

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
        await this.sendSignaling(createIceCandidate(event.candidate));
      }
    };

    // Create offer
    const offer = await this.webrtcConn.createOffer();
    await this.sendSignaling(createOffer(offer.sdp!));

    // Wait for answer
    const answerMsg = await this.receiveSignalingWithTimeout();
    if (answerMsg.type !== SignalingMessageType.ANSWER) {
      throw new Error(`Expected ANSWER, got ${answerMsg.type}`);
    }

    // Set remote description
    await this.webrtcConn.setRemoteDescription({
      type: "answer",
      sdp: (answerMsg as { sdp: string }).sdp,
    });

    // Exchange ICE candidates until connection is established
    return await this.completeWebRTCConnection();
  }

  /**
   * Respond to WebRTC upgrade request (we create the answer).
   */
  private async respondToWebRTCUpgrade(): Promise<boolean> {
    if (!this.signalingStream) return false;

    // Wait for upgrade request
    const request = await this.receiveSignalingWithTimeout();

    if (request.type !== SignalingMessageType.UPGRADE_REQUEST) {
      throw new Error(`Expected UPGRADE_REQUEST, got ${request.type}`);
    }

    // Check if we support WebRTC
    if (!isWebRTCAvailable()) {
      await this.sendSignaling(createUpgradeReject("WebRTC not available"));
      return false;
    }

    // Accept the upgrade
    await this.sendSignaling(createUpgradeAccept());

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
        await this.sendSignaling(createIceCandidate(event.candidate));
      }
    };

    // Wait for offer
    const offerMsg = await this.receiveSignalingWithTimeout();
    if (offerMsg.type !== SignalingMessageType.OFFER) {
      throw new Error(`Expected OFFER, got ${offerMsg.type}`);
    }

    // Set remote description and create answer
    await this.webrtcConn.setRemoteDescription({
      type: "offer",
      sdp: (offerMsg as { sdp: string }).sdp,
    });

    const answer = await this.webrtcConn.createAnswer();
    await this.sendSignaling(createAnswer(answer.sdp!));

    // Exchange ICE candidates until connection is established
    return await this.completeWebRTCConnection();
  }

  /**
   * Complete WebRTC connection by exchanging ICE candidates.
   */
  private async completeWebRTCConnection(): Promise<boolean> {
    if (!this.webrtcConn || !this.signalingStream) return false;

    const pc = this.webrtcConn.getRTCPeerConnection();

    // Wait for connection with timeout
    const connectionPromise = new Promise<boolean>((resolve) => {
      const checkState = () => {
        if (pc.connectionState === "connected") {
          resolve(true);
        } else if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          resolve(false);
        }
      };

      pc.onconnectionstatechange = checkState;
      checkState(); // Check immediately
    });

    const iceCandidateLoop = (async () => {
      while (this.signalingStream?.isOpen()) {
        try {
          const msg = await this.receiveSignalingWithTimeout();

          if (msg.type === SignalingMessageType.ICE_CANDIDATE) {
            const iceMsg = msg as {
              candidate: string;
              sdpMid: string | null;
              sdpMLineIndex: number | null;
            };
            await this.webrtcConn!.addIceCandidate({
              candidate: iceMsg.candidate,
              sdpMid: iceMsg.sdpMid ?? undefined,
              sdpMLineIndex: iceMsg.sdpMLineIndex ?? undefined,
            });
          } else if (msg.type === SignalingMessageType.READY) {
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
      setTimeout(() => resolve(false), this.webrtcConfig.connectionTimeout);
    });

    const connected = await Promise.race([connectionPromise, timeoutPromise]);

    // Clean up ICE candidate loop
    await iceCandidateLoop;

    if (connected) {
      // Send ready message
      if (this.signalingStream?.isOpen()) {
        await this.sendSignaling(createReady());
      }

      this.logger.info(
        `[Hybrid ${this.peerId}] WebRTC connected (direct: ${this.webrtcConn?.isDirect()})`,
      );

      // Listen for WebRTC disconnect
      this.webrtcConn!.onStateChange((state) => {
        if (state === "disconnected" || state === "error") {
          this.handleWebRTCDisconnect();
        }
      });

      return true;
    }

    // Connection failed, clean up
    await this.webrtcConn.close();
    this.webrtcConn = null;
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

  /**
   * Get the preferred connection (WebRTC if available, else Iroh).
   */
  private getPreferredConnection(): PeerConnection {
    if (this.webrtcConn?.isConnected() && this.webrtcConn.isDirect()) {
      return this.webrtcConn;
    }
    return this.irohConn;
  }

  // PeerConnection interface implementation

  async openStream(): Promise<SyncStream> {
    // Always use Iroh for streams - WebRTC DataChannels are used for upgrade only
    // This keeps the sync protocol unchanged
    return this.irohConn.openStream();
  }

  async acceptStream(): Promise<SyncStream> {
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
      await this.signalingStream.close();
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
    this.streamCallbacks.push(callback);
    // Also register with Iroh connection
    return this.irohConn.onStream(callback);
  }

  getRttMs(): number | undefined {
    // Prefer WebRTC RTT if available (more accurate for direct connections)
    if (this.webrtcConn?.isConnected()) {
      const webrtcRtt = this.webrtcConn.getRttMs();
      if (webrtcRtt !== undefined) {
        return webrtcRtt;
      }
    }
    return this.irohConn.getRttMs();
  }

  getPendingStreamCount(): number {
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
