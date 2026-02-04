/**
 * HybridTransport Tests
 *
 * Tests for the HybridTransport and HybridConnection classes.
 * Tests the upgrade flow, stream detection, and fallback logic.
 */

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import type { TransportLogger, SyncStream, PeerConnection, ConnectionState } from "../src/transport/types";
import {
  SignalingMessageType,
  serializeSignalingMessage,
  deserializeSignalingMessage,
  createUpgradeRequest,
  isSignalingMessageType,
} from "../src/transport/webrtc";
import { HybridTransport, HybridConnection } from "../src/transport/hybrid-transport";
import { DEFAULT_WEBRTC_CONFIG } from "../src/transport/webrtc/types";

// Check if we're in a browser-like environment with WebRTC
const hasWebRTC = typeof globalThis.RTCPeerConnection !== "undefined";

// Mock logger
const createMockLogger = (): TransportLogger => ({
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
});

// Create a mock SyncStream
const createMockStream = (): SyncStream & {
  sentMessages: Uint8Array[];
  _receiveQueue: Uint8Array[];
  _receiveResolvers: Array<(data: Uint8Array) => void>;
  pushMessage: (data: Uint8Array) => void;
} => {
  const sentMessages: Uint8Array[] = [];
  const _receiveQueue: Uint8Array[] = [];
  const _receiveResolvers: Array<(data: Uint8Array) => void> = [];
  let closed = false;

  return {
    id: `mock-${Math.random().toString(36).slice(2)}`,
    sentMessages,
    _receiveQueue,
    _receiveResolvers,
    pushMessage: (data: Uint8Array) => {
      if (_receiveResolvers.length > 0) {
        const resolver = _receiveResolvers.shift()!;
        resolver(data);
      } else {
        _receiveQueue.push(data);
      }
    },
    send: async (data: Uint8Array) => {
      if (closed) throw new Error("Stream closed");
      sentMessages.push(data);
    },
    receive: async () => {
      if (closed) throw new Error("Stream closed");
      if (_receiveQueue.length > 0) {
        return _receiveQueue.shift()!;
      }
      return new Promise<Uint8Array>((resolve) => {
        _receiveResolvers.push(resolve);
      });
    },
    close: async () => {
      closed = true;
      // Reject any pending receives
      for (const resolver of _receiveResolvers) {
        // This will cause the promise to hang, which is expected
      }
    },
    isOpen: () => !closed,
  };
};

// Create a mock PeerConnection
const createMockPeerConnection = (peerId: string): PeerConnection & {
  _openedStreams: SyncStream[];
  _streamCallbacks: Array<(stream: SyncStream) => void>;
  _stateCallbacks: Array<(state: ConnectionState) => void>;
  simulateIncomingStream: (stream: SyncStream) => void;
  simulateDisconnect: () => void;
} => {
  const _openedStreams: SyncStream[] = [];
  const _streamCallbacks: Array<(stream: SyncStream) => void> = [];
  const _stateCallbacks: Array<(state: ConnectionState) => void> = [];
  let connected = true;
  let _state: ConnectionState = "connected";

  const mock = {
    peerId,
    get state() { return _state; },
    _openedStreams,
    _streamCallbacks,
    _stateCallbacks,
    simulateIncomingStream: (stream: SyncStream) => {
      for (const cb of _streamCallbacks) {
        cb(stream);
      }
    },
    simulateDisconnect: () => {
      connected = false;
      _state = "disconnected";
      for (const cb of _stateCallbacks) {
        cb("disconnected");
      }
    },
    openStream: async () => {
      const stream = createMockStream();
      _openedStreams.push(stream);
      return stream;
    },
    acceptStream: async () => {
      throw new Error("Not implemented in mock");
    },
    close: async () => {
      connected = false;
      _state = "disconnected";
    },
    isConnected: () => connected,
    onStateChange: (callback: (state: ConnectionState) => void) => {
      _stateCallbacks.push(callback);
      return () => {
        const idx = _stateCallbacks.indexOf(callback);
        if (idx >= 0) _stateCallbacks.splice(idx, 1);
      };
    },
    onStream: (callback: (stream: SyncStream) => void) => {
      _streamCallbacks.push(callback);
      return () => {
        const idx = _streamCallbacks.indexOf(callback);
        if (idx >= 0) _streamCallbacks.splice(idx, 1);
      };
    },
    getRttMs: () => 50,
    getPendingStreamCount: () => 0,
  };

  return mock;
};

describe("HybridConnection", () => {
  let mockLogger: TransportLogger;
  let mockIrohConn: ReturnType<typeof createMockPeerConnection>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockIrohConn = createMockPeerConnection("test-peer-123");
  });

  describe("Basic functionality", () => {
    it("should create HybridConnection with correct peerId", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        true
      );

      expect(conn.peerId).toBe("test-peer-123");
    });

    it("should report connected when Iroh is connected", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        true
      );

      expect(conn.isConnected()).toBe(true);
    });

    it("should report disconnected after Iroh disconnects", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        true
      );

      mockIrohConn.simulateDisconnect();

      expect(conn.isConnected()).toBe(false);
    });

    it("should forward openStream to Iroh connection", async () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        true
      );

      const stream = await conn.openStream();
      expect(stream).toBeDefined();
      expect(mockIrohConn._openedStreams.length).toBe(1);
    });

    it("should return RTT from Iroh connection", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        true
      );

      expect(conn.getRttMs()).toBe(50);
    });
  });

  describe("Stream handling", () => {
    it("should forward sync streams to callbacks", async () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        false // WebRTC disabled
      );

      const receivedStreams: SyncStream[] = [];
      conn.onStream((stream) => {
        receivedStreams.push(stream);
      });

      // Simulate incoming stream
      const mockStream = createMockStream();
      mockIrohConn.simulateIncomingStream(mockStream);

      expect(receivedStreams.length).toBe(1);
    });

    it("should unsubscribe stream callback correctly", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        false
      );

      const receivedStreams: SyncStream[] = [];
      const unsubscribe = conn.onStream((stream) => {
        receivedStreams.push(stream);
      });

      // Unsubscribe
      unsubscribe();

      // Simulate incoming stream
      const mockStream = createMockStream();
      mockIrohConn.simulateIncomingStream(mockStream);

      // Should not receive the stream
      expect(receivedStreams.length).toBe(0);
    });
  });

  describe("WebRTC status methods", () => {
    it("should report WebRTC not active when disabled", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        false // WebRTC disabled
      );

      expect(conn.isWebRTCActive()).toBe(false);
      expect(conn.isDirectConnection()).toBe(false);
    });

    it("should report WebRTC not active when no WebRTC connection exists", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        true // WebRTC enabled but not connected
      );

      expect(conn.isWebRTCActive()).toBe(false);
      expect(conn.isDirectConnection()).toBe(false);
    });

    it("should return Iroh (relay) as connection type when no WebRTC", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        true
      );

      expect(conn.getConnectionType()).toBe("Iroh (relay)");
    });

    it("should return null for WebRTC metrics when not connected", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        true
      );

      expect(conn.getWebRTCMetrics()).toBeNull();
    });
  });

  describe("State change notifications", () => {
    it("should notify state change callbacks on disconnect", () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        false
      );

      const states: ConnectionState[] = [];
      conn.onStateChange((state) => {
        states.push(state);
      });

      mockIrohConn.simulateDisconnect();

      expect(states).toContain("disconnected");
    });
  });

  describe("Close handling", () => {
    it("should close Iroh connection", async () => {
      const conn = new HybridConnection(
        "test-peer-123",
        mockIrohConn,
        mockLogger,
        DEFAULT_WEBRTC_CONFIG,
        false
      );

      await conn.close();

      expect(mockIrohConn.isConnected()).toBe(false);
      expect(conn.isConnected()).toBe(false);
    });
  });
});

describe("Stream Detection", () => {
  describe("Signaling message detection", () => {
    it("should recognize UPGRADE_REQUEST (0x30) as signaling", () => {
      const msg = createUpgradeRequest();
      const serialized = serializeSignalingMessage(msg);

      // First byte should be UPGRADE_REQUEST
      expect(serialized[0]).toBe(SignalingMessageType.UPGRADE_REQUEST);
      expect(isSignalingMessageType(serialized[0])).toBe(true);
    });

    it("should NOT recognize VERSION_INFO (0x01) as signaling", () => {
      // VERSION_INFO is 0x01 in the sync protocol
      expect(isSignalingMessageType(0x01)).toBe(false);
    });

    it("should correctly classify all message types", () => {
      // Sync message types (not signaling)
      const syncTypes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x10, 0x11, 0x12, 0x13, 0x14, 0x20];
      for (const type of syncTypes) {
        expect(isSignalingMessageType(type)).toBe(false);
      }

      // Signaling types
      const signalingTypes = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36];
      for (const type of signalingTypes) {
        expect(isSignalingMessageType(type)).toBe(true);
      }
    });
  });

  describe("Replay stream wrapper", () => {
    it("should replay first message correctly", async () => {
      // This tests the concept of the replay stream wrapper
      const createReplayStream = (
        original: SyncStream,
        firstMessage: Uint8Array
      ): SyncStream => {
        let firstMessageConsumed = false;

        return {
          id: original.id,
          send: (data) => original.send(data),
          receive: async () => {
            if (!firstMessageConsumed) {
              firstMessageConsumed = true;
              return firstMessage;
            }
            return original.receive();
          },
          close: () => original.close(),
          isOpen: () => original.isOpen(),
        };
      };

      const mockStream = createMockStream();
      const firstMessage = new Uint8Array([0x01, 0x02, 0x03]);
      const secondMessage = new Uint8Array([0x04, 0x05, 0x06]);

      // Push second message to the original stream
      mockStream.pushMessage(secondMessage);

      const replayStream = createReplayStream(mockStream, firstMessage);

      // First receive should return the replayed message
      const received1 = await replayStream.receive();
      expect(Array.from(received1)).toEqual([0x01, 0x02, 0x03]);

      // Second receive should return the next message from original stream
      const received2 = await replayStream.receive();
      expect(Array.from(received2)).toEqual([0x04, 0x05, 0x06]);
    });
  });
});

describe("Upgrade Flow Logic", () => {
  it("should prevent double upgrade attempts", async () => {
    const mockLogger = createMockLogger();
    const mockIrohConn = createMockPeerConnection("test-peer");

    const conn = new HybridConnection(
      "test-peer",
      mockIrohConn,
      mockLogger,
      DEFAULT_WEBRTC_CONFIG,
      true
    );

    // First upgrade attempt starts
    const upgradePromise1 = conn.attemptWebRTCUpgrade(true);

    // Second attempt should return false immediately (upgrade in progress)
    const result2 = await conn.attemptWebRTCUpgrade(true);
    expect(result2).toBe(false);

    // Clean up - the first upgrade will fail (no WebRTC in test env)
    // but we just need to verify the second attempt was blocked
  });

  it("should return false when WebRTC is disabled", async () => {
    const mockLogger = createMockLogger();
    const mockIrohConn = createMockPeerConnection("test-peer");

    const conn = new HybridConnection(
      "test-peer",
      mockIrohConn,
      mockLogger,
      DEFAULT_WEBRTC_CONFIG,
      false // WebRTC disabled
    );

    const result = await conn.attemptWebRTCUpgrade(true);
    expect(result).toBe(false);
  });
});

describe("HybridTransport Configuration", () => {
  it("should expose isWebRTCAvailable method", async () => {
    const { HybridTransport } = await import("../src/transport");

    const mockLogger = createMockLogger();
    const transport = new HybridTransport({
      logger: mockLogger,
      enableWebRTC: true,
    });

    // Should return boolean
    const available = transport.isWebRTCAvailable();
    expect(typeof available).toBe("boolean");
  });
});
