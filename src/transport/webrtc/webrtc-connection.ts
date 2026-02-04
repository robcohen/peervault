/**
 * WebRTC Peer Connection
 *
 * Wraps RTCPeerConnection to implement PeerConnection interface.
 * Manages DataChannels for sync streams.
 */

import type {
  PeerConnection,
  ConnectionState,
  SyncStream,
  TransportLogger,
} from "../types";
import {
  type WebRTCConfig,
  type WebRTCConnectionMetrics,
  type IceCandidateType,
  DEFAULT_WEBRTC_CONFIG,
  WEBRTC_CONSTANTS,
  DEFAULT_STREAM_CONFIG,
} from "./types";
import { WebRTCSyncStream } from "./webrtc-stream";

/**
 * WebRTC-based PeerConnection implementation.
 */
export class WebRTCPeerConnection implements PeerConnection {
  readonly peerId: string;

  private pc: RTCPeerConnection;
  private logger: TransportLogger;
  private config: WebRTCConfig;

  private _state: ConnectionState = "connecting";
  private stateCallbacks: Array<(state: ConnectionState) => void> = [];
  private streamCallbacks: Array<(stream: SyncStream) => void> = [];

  private pendingStreams: SyncStream[] = [];
  private streamResolvers: Array<{
    resolve: (stream: SyncStream) => void;
    reject: (error: Error) => void;
  }> = [];

  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  private streamCounter = 0;
  private closed = false;

  private metrics: WebRTCConnectionMetrics = {
    isDirect: false,
    localCandidateType: null,
    remoteCandidateType: null,
    bytesSent: 0,
    bytesReceived: 0,
  };

  private rttMs?: number;

  constructor(
    peerId: string,
    pc: RTCPeerConnection,
    logger: TransportLogger,
    config: WebRTCConfig = DEFAULT_WEBRTC_CONFIG,
  ) {
    this.peerId = peerId;
    this.pc = pc;
    this.logger = logger;
    this.config = config;

    this.setupEventHandlers();
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Set up RTCPeerConnection event handlers.
   */
  private setupEventHandlers(): void {
    this.pc.onconnectionstatechange = () => {
      this.handleConnectionStateChange();
    };

    this.pc.oniceconnectionstatechange = () => {
      this.logger.debug(
        `[WebRTC ${this.peerId}] ICE connection state: ${this.pc.iceConnectionState}`,
      );

      // Use ICE state for more accurate connection tracking
      if (this.pc.iceConnectionState === "connected") {
        this.updateConnectionMetrics();
      }
    };

    this.pc.ondatachannel = (event) => {
      this.handleIncomingDataChannel(event.channel);
    };

    this.pc.onicecandidate = (event) => {
      // ICE candidates are handled by the transport layer
      // This is just for logging
      if (event.candidate) {
        this.logger.debug(
          `[WebRTC ${this.peerId}] ICE candidate: ${event.candidate.type} ${event.candidate.address || ""}`,
        );
      }
    };
  }

  /**
   * Handle connection state changes.
   */
  private handleConnectionStateChange(): void {
    const pcState = this.pc.connectionState;
    this.logger.debug(
      `[WebRTC ${this.peerId}] Connection state: ${pcState}`,
    );

    let newState: ConnectionState;

    switch (pcState) {
      case "new":
      case "connecting":
        newState = "connecting";
        break;
      case "connected":
        newState = "connected";
        this.updateConnectionMetrics();
        break;
      case "disconnected":
        newState = "disconnected";
        break;
      case "failed":
      case "closed":
        newState = this.closed ? "disconnected" : "error";
        this.rejectPendingStreamResolvers();
        break;
      default:
        return;
    }

    if (newState !== this._state) {
      this._state = newState;
      this.notifyStateChange();
    }
  }

  /**
   * Handle incoming DataChannel.
   */
  private handleIncomingDataChannel(channel: RTCDataChannel): void {
    this.logger.debug(
      `[WebRTC ${this.peerId}] Incoming channel: ${channel.label}`,
    );

    // Wrap in SyncStream
    const stream = new WebRTCSyncStream(channel, this.logger, this.config);

    // Deliver to waiting acceptor or queue
    const resolver = this.streamResolvers.shift();
    if (resolver) {
      resolver.resolve(stream);
    } else {
      this.pendingStreams.push(stream);
      this.notifyStream(stream);
    }
  }

  /**
   * Update connection metrics after connecting.
   */
  private async updateConnectionMetrics(): Promise<void> {
    try {
      const stats = await this.pc.getStats();

      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          // Get RTT
          if (report.currentRoundTripTime !== undefined) {
            this.rttMs = report.currentRoundTripTime * 1000;
          }

          // Get bytes transferred
          this.metrics.bytesSent = report.bytesSent || 0;
          this.metrics.bytesReceived = report.bytesReceived || 0;

          // Get local candidate info
          const localCandidateId = report.localCandidateId;
          const remoteCandidateId = report.remoteCandidateId;

          stats.forEach((candidateReport) => {
            if (candidateReport.id === localCandidateId) {
              this.metrics.localCandidateType =
                candidateReport.candidateType as IceCandidateType;
              this.metrics.localAddress = candidateReport.address;
            }
            if (candidateReport.id === remoteCandidateId) {
              this.metrics.remoteCandidateType =
                candidateReport.candidateType as IceCandidateType;
              this.metrics.remoteAddress = candidateReport.address;
            }
          });
        }
      });

      // Determine if direct connection
      this.metrics.isDirect =
        this.metrics.localCandidateType === "host" &&
        this.metrics.remoteCandidateType === "host";

      if (!this.metrics.connectedAt) {
        this.metrics.connectedAt = Date.now();
      }

      this.logger.info(
        `[WebRTC ${this.peerId}] Connected: direct=${this.metrics.isDirect}, ` +
          `local=${this.metrics.localCandidateType}, remote=${this.metrics.remoteCandidateType}`,
      );
    } catch (error) {
      this.logger.warn(
        `[WebRTC ${this.peerId}] Failed to get stats:`,
        error,
      );
    }
  }

  /**
   * Notify state change callbacks.
   */
  private notifyStateChange(): void {
    for (const callback of this.stateCallbacks) {
      try {
        callback(this._state);
      } catch (error) {
        this.logger.error(
          `[WebRTC ${this.peerId}] State callback error:`,
          error,
        );
      }
    }
  }

  /**
   * Notify stream callbacks.
   */
  private notifyStream(stream: SyncStream): void {
    for (const callback of this.streamCallbacks) {
      try {
        callback(stream);
      } catch (error) {
        this.logger.error(
          `[WebRTC ${this.peerId}] Stream callback error:`,
          error,
        );
      }
    }
  }

  /**
   * Reject all pending stream resolvers.
   */
  private rejectPendingStreamResolvers(): void {
    const error = new Error(`Connection ${this.peerId} closed`);
    for (const resolver of this.streamResolvers) {
      resolver.reject(error);
    }
    this.streamResolvers = [];
  }

  /**
   * Open a new bidirectional stream.
   */
  async openStream(): Promise<SyncStream> {
    if (this.closed) {
      throw new Error(`Connection ${this.peerId} is closed`);
    }

    if (this._state !== "connected") {
      throw new Error(
        `Cannot open stream: connection state is ${this._state}`,
      );
    }

    const label = `${WEBRTC_CONSTANTS.STREAM_CHANNEL_PREFIX}${this.streamCounter++}`;
    const channel = this.pc.createDataChannel(label, {
      ordered: DEFAULT_STREAM_CONFIG.ordered,
      maxRetransmits: DEFAULT_STREAM_CONFIG.maxRetransmits ?? undefined,
      protocol: DEFAULT_STREAM_CONFIG.protocol,
    });

    // Wait for channel to open
    await this.waitForChannelOpen(channel);

    return new WebRTCSyncStream(channel, this.logger, this.config);
  }

  /**
   * Wait for a DataChannel to open.
   */
  private waitForChannelOpen(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      if (channel.readyState === "open") {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error(`DataChannel ${channel.label} open timeout`));
      }, this.config.connectionTimeout);

      channel.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      channel.onerror = (event) => {
        clearTimeout(timeout);
        const errorEvent = event as RTCErrorEvent;
        reject(
          new Error(
            `DataChannel error: ${errorEvent.error?.message || "Unknown"}`,
          ),
        );
      };
    });
  }

  /**
   * Accept an incoming stream.
   */
  async acceptStream(): Promise<SyncStream> {
    if (this.closed) {
      throw new Error(`Connection ${this.peerId} is closed`);
    }

    // Check queue first
    const queued = this.pendingStreams.shift();
    if (queued) {
      return queued;
    }

    // Wait for incoming stream
    return new Promise<SyncStream>((resolve, reject) => {
      if (this.closed || this._state === "error") {
        reject(new Error(`Connection ${this.peerId} is closed`));
        return;
      }

      this.streamResolvers.push({ resolve, reject });
    });
  }

  /**
   * Close the connection.
   */
  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    this.logger.debug(`[WebRTC ${this.peerId}] Closing connection`);

    // Close all pending streams
    for (const stream of this.pendingStreams) {
      await stream.close();
    }
    this.pendingStreams = [];

    // Reject pending resolvers
    this.rejectPendingStreamResolvers();

    // Close the peer connection
    this.pc.close();

    this._state = "disconnected";
    this.notifyStateChange();
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this._state === "connected" && !this.closed;
  }

  /**
   * Register state change callback.
   */
  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateCallbacks.push(callback);
    return () => {
      const index = this.stateCallbacks.indexOf(callback);
      if (index >= 0) {
        this.stateCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Register stream callback.
   */
  onStream(callback: (stream: SyncStream) => void): () => void {
    this.streamCallbacks.push(callback);
    return () => {
      const index = this.streamCallbacks.indexOf(callback);
      if (index >= 0) {
        this.streamCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Get RTT in milliseconds.
   */
  getRttMs(): number | undefined {
    return this.rttMs;
  }

  /**
   * Get pending stream count.
   */
  getPendingStreamCount(): number {
    return this.pendingStreams.length;
  }

  /**
   * Get connection metrics.
   */
  getMetrics(): WebRTCConnectionMetrics {
    return { ...this.metrics };
  }

  /**
   * Check if using direct connection (host candidates).
   */
  isDirect(): boolean {
    return this.metrics.isDirect;
  }

  /**
   * Get the underlying RTCPeerConnection (for signaling).
   */
  getRTCPeerConnection(): RTCPeerConnection {
    return this.pc;
  }

  /**
   * Set remote description (for signaling).
   */
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(desc);
    this.remoteDescriptionSet = true;

    // Add any pending ICE candidates
    for (const candidate of this.pendingIceCandidates) {
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingIceCandidates = [];
  }

  /**
   * Add ICE candidate (for signaling).
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.remoteDescriptionSet) {
      await this.pc.addIceCandidate(candidate);
    } else {
      // Queue until remote description is set
      this.pendingIceCandidates.push(candidate);
    }
  }

  /**
   * Create SDP offer (for signaling).
   * Creates an initial DataChannel to ensure data channel support is negotiated.
   */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    // Create an initial data channel to ensure SCTP is negotiated in the SDP
    // Without this, the SDP won't include DataChannel support
    const initialChannel = this.pc.createDataChannel(
      WEBRTC_CONSTANTS.MAIN_CHANNEL_LABEL,
      { ordered: true },
    );
    this.logger.debug(`[WebRTC ${this.peerId}] Created initial DataChannel for SDP`);

    // Wait for the channel to be ready (or just proceed if it fails)
    initialChannel.onopen = () => {
      this.logger.debug(`[WebRTC ${this.peerId}] Initial DataChannel opened`);
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /**
   * Create SDP answer (for signaling).
   */
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }
}

/**
 * Create a new WebRTC peer connection.
 */
export function createWebRTCPeerConnection(
  peerId: string,
  logger: TransportLogger,
  config: WebRTCConfig = DEFAULT_WEBRTC_CONFIG,
): WebRTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: config.iceServers,
  });

  return new WebRTCPeerConnection(peerId, pc, logger, config);
}
