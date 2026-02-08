/**
 * Mock Sync Stream
 *
 * In-memory SyncStream implementation for testing.
 * Streams come in linked pairs where one side's send() delivers to the other's receive().
 */

import type { SyncStream } from "../types";

/**
 * Configuration for mock stream behavior.
 */
export interface MockStreamConfig {
  /** Simulated message delivery latency in ms (default: 0) */
  latencyMs?: number;

  /** Fail after sending N messages (for error testing) */
  failAfterMessages?: number;
}

/**
 * Mock SyncStream implementation.
 *
 * Use createMockStreamPair() to create linked stream pairs for testing.
 */
export class MockSyncStream implements SyncStream {
  readonly id: string;

  private _open = true;
  private config: MockStreamConfig;

  // Message queues
  private receiveQueue: Uint8Array[] = [];
  private receiveResolvers: Array<{
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
  }> = [];

  // Linked remote stream (the other end)
  private remoteStream: MockSyncStream | null = null;

  // Tracking for test inspection
  private _sentMessages: Uint8Array[] = [];
  private _receivedMessages: Uint8Array[] = [];
  private sendCount = 0;

  constructor(id: string, config: MockStreamConfig = {}) {
    this.id = id;
    this.config = config;
  }

  /**
   * Link this stream to its remote counterpart.
   * Call this on both streams with each other.
   */
  linkRemote(remote: MockSyncStream): void {
    this.remoteStream = remote;
  }

  /**
   * Send data to the remote stream.
   */
  async send(data: Uint8Array): Promise<void> {
    if (!this._open) {
      throw new Error(`Stream ${this.id} is closed`);
    }

    // Check for configured failure
    if (
      this.config.failAfterMessages !== undefined &&
      this.sendCount >= this.config.failAfterMessages
    ) {
      throw new Error(`Stream ${this.id} failed after ${this.sendCount} messages`);
    }

    // Apply simulated latency
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    // Track for test inspection
    this._sentMessages.push(data);
    this.sendCount++;

    // Deliver to remote stream
    if (this.remoteStream && this.remoteStream._open) {
      this.remoteStream._deliverMessage(data);
    }
  }

  /**
   * Receive data from the remote stream.
   * Blocks until a message is available.
   */
  async receive(): Promise<Uint8Array> {
    if (!this._open) {
      throw new Error(`Stream ${this.id} is closed`);
    }

    // Check queue first
    const queued = this.receiveQueue.shift();
    if (queued) {
      this._receivedMessages.push(queued);
      return queued;
    }

    // Wait for incoming message
    return new Promise<Uint8Array>((resolve, reject) => {
      if (!this._open) {
        reject(new Error(`Stream ${this.id} is closed`));
        return;
      }
      this.receiveResolvers.push({
        resolve: (data) => {
          this._receivedMessages.push(data);
          resolve(data);
        },
        reject,
      });
    });
  }

  /**
   * Close the stream.
   */
  async close(): Promise<void> {
    if (!this._open) return;

    this._open = false;

    // Reject all pending receivers
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
  // Internal methods (called by linked remote stream)
  // ============================================================================

  /**
   * Deliver a message from the remote stream.
   * @internal
   */
  _deliverMessage(data: Uint8Array): void {
    if (!this._open) return;

    // If there's a waiting receiver, deliver immediately
    const resolver = this.receiveResolvers.shift();
    if (resolver) {
      resolver.resolve(data);
    } else {
      // Queue for later receive() call
      this.receiveQueue.push(data);
    }
  }

  // ============================================================================
  // Test utilities
  // ============================================================================

  /**
   * Get all messages sent through this stream.
   */
  getSentMessages(): Uint8Array[] {
    return [...this._sentMessages];
  }

  /**
   * Get all messages received through this stream.
   */
  getReceivedMessages(): Uint8Array[] {
    return [...this._receivedMessages];
  }

  /**
   * Get the number of messages waiting in the receive queue.
   */
  getQueuedMessageCount(): number {
    return this.receiveQueue.length;
  }

  /**
   * Simulate a stream error by closing and rejecting pending receives.
   */
  simulateError(error: Error): void {
    this._open = false;
    for (const resolver of this.receiveResolvers) {
      resolver.reject(error);
    }
    this.receiveResolvers = [];
  }

  /**
   * Push a message directly into the receive queue (for testing).
   * Use this when testing without a linked remote stream.
   */
  pushMessage(data: Uint8Array): void {
    this._deliverMessage(data);
  }
}

/**
 * Create a linked pair of mock streams.
 * Messages sent on one stream are delivered to the other.
 */
export function createMockStreamPair(
  idA: string,
  idB: string,
  config: MockStreamConfig = {},
): { streamA: MockSyncStream; streamB: MockSyncStream } {
  const streamA = new MockSyncStream(idA, config);
  const streamB = new MockSyncStream(idB, config);

  streamA.linkRemote(streamB);
  streamB.linkRemote(streamA);

  return { streamA, streamB };
}
