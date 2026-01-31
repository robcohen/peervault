/**
 * WebRTC Sync Stream
 *
 * Wraps RTCDataChannel to implement SyncStream interface.
 * Uses 4-byte length-prefix framing (same as Iroh transport).
 */

import type { SyncStream } from "../types";
import type { TransportLogger } from "../types";
import {
  WEBRTC_CONSTANTS,
  type WebRTCConfig,
  DEFAULT_WEBRTC_CONFIG,
} from "./types";

/**
 * WebRTC-based SyncStream implementation.
 *
 * Provides reliable, ordered message delivery over RTCDataChannel
 * with 4-byte length-prefix framing for compatibility with Iroh transport.
 */
export class WebRTCSyncStream implements SyncStream {
  readonly id: string;

  private channel: RTCDataChannel;
  private logger: TransportLogger;
  private config: WebRTCConfig;

  private messageQueue: Uint8Array[] = [];
  private receiveResolvers: Array<{
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
  }> = [];

  private receiveBuffer: Uint8Array = new Uint8Array(0);
  private closed = false;
  private closeError: Error | null = null;

  constructor(
    channel: RTCDataChannel,
    logger: TransportLogger,
    config: WebRTCConfig = DEFAULT_WEBRTC_CONFIG,
  ) {
    this.id = `webrtc-${channel.label}-${Date.now()}`;
    this.channel = channel;
    this.logger = logger;
    this.config = config;

    // Set binary type
    this.channel.binaryType = "arraybuffer";

    // Set up event handlers
    this.setupEventHandlers();
  }

  /**
   * Set up DataChannel event handlers.
   */
  private setupEventHandlers(): void {
    this.channel.onmessage = (event: MessageEvent) => {
      if (this.closed) return;

      const data =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new Uint8Array(event.data.buffer || event.data);

      this.handleIncomingData(data);
    };

    this.channel.onerror = (event: Event) => {
      const errorEvent = event as RTCErrorEvent;
      const error = new Error(
        `DataChannel error: ${errorEvent.error?.message || "Unknown error"}`,
      );
      this.logger.error(`[WebRTCStream ${this.id}] Error:`, error.message);
      this.handleClose(error);
    };

    this.channel.onclose = () => {
      this.logger.debug(`[WebRTCStream ${this.id}] Channel closed`);
      this.handleClose(null);
    };
  }

  /**
   * Handle incoming data with length-prefix framing.
   */
  private handleIncomingData(data: Uint8Array): void {
    // Append to receive buffer
    const newBuffer = new Uint8Array(this.receiveBuffer.length + data.length);
    newBuffer.set(this.receiveBuffer);
    newBuffer.set(data, this.receiveBuffer.length);
    this.receiveBuffer = newBuffer;

    // Process complete messages
    this.processReceiveBuffer();
  }

  /**
   * Process receive buffer and extract complete messages.
   */
  private processReceiveBuffer(): void {
    while (this.receiveBuffer.length >= 4) {
      // Read 4-byte length prefix (big-endian)
      const view = new DataView(this.receiveBuffer.buffer);
      const messageLength = view.getUint32(0, false);

      // Check if we have the complete message
      if (this.receiveBuffer.length < 4 + messageLength) {
        break;
      }

      // Extract the message
      const message = this.receiveBuffer.slice(4, 4 + messageLength);

      // Remove from buffer
      this.receiveBuffer = this.receiveBuffer.slice(4 + messageLength);

      // Deliver to waiting receiver or queue
      this.deliverMessage(message);
    }
  }

  /**
   * Deliver a complete message to a waiting receiver or queue.
   */
  private deliverMessage(message: Uint8Array): void {
    const resolver = this.receiveResolvers.shift();
    if (resolver) {
      resolver.resolve(message);
    } else {
      this.messageQueue.push(message);
    }
  }

  /**
   * Handle channel close.
   */
  private handleClose(error: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;

    // Reject all pending receivers
    const closeError =
      error || new Error(`Stream ${this.id} closed unexpectedly`);
    for (const resolver of this.receiveResolvers) {
      resolver.reject(closeError);
    }
    this.receiveResolvers = [];
  }

  /**
   * Wait for backpressure to clear.
   */
  private async waitForBackpressure(): Promise<void> {
    const startTime = Date.now();

    while (this.channel.bufferedAmount > this.config.maxBufferedAmount) {
      if (Date.now() - startTime > WEBRTC_CONSTANTS.BACKPRESSURE_TIMEOUT) {
        throw new Error("Backpressure timeout: channel buffer full");
      }
      await new Promise((resolve) =>
        setTimeout(resolve, WEBRTC_CONSTANTS.BACKPRESSURE_CHECK_INTERVAL),
      );
    }
  }

  /**
   * Send data with 4-byte length prefix.
   */
  async send(data: Uint8Array): Promise<void> {
    if (this.closed) {
      throw new Error(`Stream ${this.id} is closed`);
    }

    if (this.channel.readyState !== "open") {
      throw new Error(`DataChannel not open (state: ${this.channel.readyState})`);
    }

    // Wait for backpressure to clear
    await this.waitForBackpressure();

    // Create framed message with 4-byte length prefix
    const framed = new Uint8Array(4 + data.length);
    const view = new DataView(framed.buffer);
    view.setUint32(0, data.length, false); // Big-endian
    framed.set(data, 4);

    // Send the framed message
    this.channel.send(framed);
  }

  /**
   * Receive a complete message (blocks until available).
   */
  async receive(): Promise<Uint8Array> {
    if (this.closed) {
      throw this.closeError || new Error(`Stream ${this.id} is closed`);
    }

    // Check queue first
    const queued = this.messageQueue.shift();
    if (queued) {
      return queued;
    }

    // Wait for incoming message
    return new Promise<Uint8Array>((resolve, reject) => {
      // Check again after adding to resolvers (race condition prevention)
      if (this.closed) {
        reject(this.closeError || new Error(`Stream ${this.id} is closed`));
        return;
      }

      this.receiveResolvers.push({ resolve, reject });
    });
  }

  /**
   * Close the stream.
   */
  async close(): Promise<void> {
    if (this.closed) return;

    this.logger.debug(`[WebRTCStream ${this.id}] Closing stream`);
    this.handleClose(null);

    if (this.channel.readyState === "open") {
      this.channel.close();
    }
  }

  /**
   * Check if the stream is open.
   */
  isOpen(): boolean {
    return !this.closed && this.channel.readyState === "open";
  }

  /**
   * Get the underlying DataChannel (for advanced use).
   */
  getChannel(): RTCDataChannel {
    return this.channel;
  }

  /**
   * Get buffered amount in bytes.
   */
  getBufferedAmount(): number {
    return this.channel.bufferedAmount;
  }
}

/**
 * Create a WebRTCSyncStream from an existing DataChannel.
 */
export function createWebRTCStream(
  channel: RTCDataChannel,
  logger: TransportLogger,
  config?: WebRTCConfig,
): WebRTCSyncStream {
  return new WebRTCSyncStream(channel, logger, config);
}
