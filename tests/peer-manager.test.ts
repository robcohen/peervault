/**
 * Peer Manager Tests
 *
 * Tests for peer management, connection handling, and sync coordination.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { PeerManager } from "../src/peer/peer-manager";
import { DocumentManager } from "../src/core/document-manager";
import { MemoryStorageAdapter } from "../src/core/storage-adapter";
import type { Logger } from "../src/utils/logger";
import type { Transport, PeerConnection, SyncStream } from "../src/transport";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    log: () => {},
    child: () => createTestLogger(),
    time: async <T>(label: string, fn: () => Promise<T>) => fn(),
    timeSync: <T>(label: string, fn: () => T) => fn(),
  };
}

class MockStream implements SyncStream {
  id = "test-stream";
  private messageQueue: Uint8Array[] = [];
  private closed = false;

  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Stream closed");
    // Store for inspection
  }

  async receive(): Promise<Uint8Array> {
    if (this.closed) throw new Error("Stream closed");
    if (this.messageQueue.length === 0) {
      // Simulate waiting
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("No messages");
    }
    return this.messageQueue.shift()!;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isOpen(): boolean {
    return !this.closed;
  }

  pushMessage(data: Uint8Array): void {
    this.messageQueue.push(data);
  }
}

class MockConnection implements PeerConnection {
  peerId: string;
  state: "connected" | "connecting" | "disconnected" = "connected";
  private streams: MockStream[] = [];
  private stateCallbacks: Array<(state: "connected" | "connecting" | "disconnected") => void> = [];
  private streamCallbacks: Array<(stream: SyncStream) => void> = [];

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  async openStream(): Promise<SyncStream> {
    const stream = new MockStream();
    this.streams.push(stream);
    return stream;
  }

  async acceptStream(): Promise<SyncStream> {
    return new Promise((resolve) => {
      this.streamCallbacks.push((stream) => resolve(stream));
    });
  }

  async close(): Promise<void> {
    this.state = "disconnected";
    for (const callback of this.stateCallbacks) {
      callback("disconnected");
    }
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  getRttMs(): number | undefined {
    return 50;
  }

  onStateChange(callback: (state: "connected" | "connecting" | "disconnected") => void): void {
    this.stateCallbacks.push(callback);
  }

  onStream(callback: (stream: SyncStream) => void): void {
    this.streamCallbacks.push(callback);
  }

  // Test helper to simulate incoming stream
  simulateIncomingStream(): MockStream {
    const stream = new MockStream();
    for (const callback of this.streamCallbacks) {
      callback(stream);
    }
    return stream;
  }
}

class MockTransport implements Transport {
  private nodeId = "test-node-id-" + Math.random().toString(36).substring(7);
  private connections = new Map<string, MockConnection>();
  private incomingCallbacks: Array<(conn: PeerConnection) => void> = [];
  private ready = true;

  async initialize(): Promise<void> {
    this.ready = true;
  }

  getNodeId(): string {
    return this.nodeId;
  }

  async generateTicket(): Promise<string> {
    return `iroh://test-ticket-${this.nodeId}`;
  }

  async connectWithTicket(ticket: string): Promise<PeerConnection> {
    // Extract peer ID from ticket (simplified)
    const peerId = ticket.replace("iroh://test-ticket-", "");
    const conn = new MockConnection(peerId);
    this.connections.set(peerId, conn);
    return conn;
  }

  onIncomingConnection(callback: (conn: PeerConnection) => void): void {
    this.incomingCallbacks.push(callback);
  }

  getConnections(): PeerConnection[] {
    return Array.from(this.connections.values()).filter((c) => c.isConnected());
  }

  getConnection(peerId: string): PeerConnection | undefined {
    const conn = this.connections.get(peerId);
    return conn?.isConnected() ? conn : undefined;
  }

  async shutdown(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.close();
    }
    this.connections.clear();
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  // Test helpers
  simulateIncomingConnection(peerId: string): MockConnection {
    const conn = new MockConnection(peerId);
    this.connections.set(peerId, conn);
    for (const callback of this.incomingCallbacks) {
      callback(conn);
    }
    return conn;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("PeerManager", () => {
  let storage: MemoryStorageAdapter;
  let logger: Logger;
  let docManager: DocumentManager;
  let transport: MockTransport;
  let peerManager: PeerManager;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    logger = createTestLogger();
    docManager = new DocumentManager(storage, logger);
    await docManager.initialize();
    transport = new MockTransport();
    await transport.initialize();

    peerManager = new PeerManager(
      transport,
      docManager,
      storage,
      logger,
      { hostname: "test-device" },
    );
    await peerManager.initialize();
  });

  describe("Initialization", () => {
    it("should initialize with empty peer list", () => {
      const peers = peerManager.getPeers();
      expect(peers).toEqual([]);
    });

    it("should have idle status after initialization", () => {
      expect(peerManager.getStatus()).toBe("idle");
    });

    it("should return transport node ID", () => {
      expect(peerManager.getNodeId()).toBe(transport.getNodeId());
    });
  });

  describe("Ticket Generation", () => {
    it("should generate invite tickets", async () => {
      const ticket = await peerManager.generateInvite();
      expect(ticket).toBeDefined();
      expect(typeof ticket).toBe("string");
      expect(ticket.length).toBeGreaterThan(0);
    });
  });

  describe("Peer Management", () => {
    it("should add peer from ticket", async () => {
      const peerId = "remote-peer-123";
      const ticket = `iroh://test-ticket-${peerId}`;

      const peer = await peerManager.addPeer(ticket);

      expect(peer.nodeId).toBe(peerId);
      expect(peer.state).toBeDefined();
    });

    it("should list added peers", async () => {
      const ticket1 = "iroh://test-ticket-peer-1";
      const ticket2 = "iroh://test-ticket-peer-2";

      await peerManager.addPeer(ticket1);
      await peerManager.addPeer(ticket2);

      const peers = peerManager.getPeers();
      expect(peers.length).toBe(2);
    });

    it("should remove peer", async () => {
      const ticket = "iroh://test-ticket-peer-to-remove";
      const peer = await peerManager.addPeer(ticket);

      await peerManager.removePeer(peer.nodeId);

      const peers = peerManager.getPeers();
      expect(peers.find((p) => p.nodeId === peer.nodeId)).toBeUndefined();
    });

    it("should set peer nickname", async () => {
      const ticket = "iroh://test-ticket-peer-nickname";
      const peer = await peerManager.addPeer(ticket);

      await peerManager.setNickname(peer.nodeId, "My Phone");

      const updated = peerManager.getPeers().find((p) => p.nodeId === peer.nodeId);
      expect(updated?.nickname).toBe("My Phone");
    });
  });

  describe("Own Device Nickname", () => {
    it("should set own nickname", () => {
      peerManager.setOwnNickname("My Laptop");
      // No public getter, but this should not throw
    });

    it("should accept undefined nickname", () => {
      peerManager.setOwnNickname(undefined);
      // Should not throw
    });
  });

  describe("Session Management", () => {
    it("should close session for peer", async () => {
      const ticket = "iroh://test-ticket-session-peer";
      const peer = await peerManager.addPeer(ticket);

      // Should not throw even if no session exists
      await peerManager.closeSession(peer.nodeId);
    });
  });

  describe("Sync Operations", () => {
    it("should have syncAll method", async () => {
      // Should not throw with no peers
      await peerManager.syncAll();
    });

    it("should emit status changes during sync", async () => {
      const statusChanges: string[] = [];
      peerManager.on("status:change", (status) => {
        statusChanges.push(status);
      });

      await peerManager.syncAll();

      // Should transition through statuses
      expect(statusChanges).toContain("syncing");
    });
  });

  describe("Persistence", () => {
    it("should persist peers across restarts", async () => {
      const ticket = "iroh://test-ticket-persist";
      await peerManager.addPeer(ticket);

      // Create new peer manager with same storage
      const newPeerManager = new PeerManager(
        transport,
        docManager,
        storage,
        logger,
        { hostname: "test-device" },
      );
      await newPeerManager.initialize();

      const peers = newPeerManager.getPeers();
      expect(peers.length).toBe(1);
    });
  });

  describe("Event Emission", () => {
    it("should emit peer:connected on new connection", async () => {
      const connected = new Promise<string>((resolve) => {
        peerManager.on("peer:connected", (peer) => {
          resolve(peer.nodeId);
        });
      });

      const ticket = "iroh://test-ticket-events";
      await peerManager.addPeer(ticket);

      const nodeId = await connected;
      expect(nodeId).toBe("events");
    });
  });

  describe("Shutdown", () => {
    it("should shutdown gracefully", async () => {
      const ticket = "iroh://test-ticket-shutdown";
      await peerManager.addPeer(ticket);

      await peerManager.shutdown();

      // Status should be idle, syncing, or offline after shutdown
      const status = peerManager.getStatus();
      expect(["idle", "syncing", "offline"]).toContain(status);
    });
  });
});
