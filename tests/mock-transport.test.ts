/**
 * Mock Transport Tests
 *
 * Unit tests for the mock transport layer.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  MockTransport,
  MockPeerConnection,
  MockSyncStream,
  createMockTransportPair,
  createMockConnectionPair,
  createMockStreamPair,
  resetMockRegistry,
} from "../src/transport/mock";

describe("MockSyncStream", () => {
  it("should send and receive messages", async () => {
    const { streamA, streamB } = createMockStreamPair("a", "b");

    // Send from A
    const message = new TextEncoder().encode("hello");
    await streamA.send(message);

    // Receive on B
    const received = await streamB.receive();
    expect(new TextDecoder().decode(received)).toBe("hello");
  });

  it("should queue messages until received", async () => {
    const { streamA, streamB } = createMockStreamPair("a", "b");

    // Send multiple messages
    await streamA.send(new TextEncoder().encode("one"));
    await streamA.send(new TextEncoder().encode("two"));
    await streamA.send(new TextEncoder().encode("three"));

    // Messages should be queued
    expect(streamB.getQueuedMessageCount()).toBe(3);

    // Receive in order
    expect(new TextDecoder().decode(await streamB.receive())).toBe("one");
    expect(new TextDecoder().decode(await streamB.receive())).toBe("two");
    expect(new TextDecoder().decode(await streamB.receive())).toBe("three");
  });

  it("should track sent messages for inspection", async () => {
    const { streamA, streamB } = createMockStreamPair("a", "b");

    await streamA.send(new TextEncoder().encode("test1"));
    await streamA.send(new TextEncoder().encode("test2"));

    const sent = streamA.getSentMessages();
    expect(sent.length).toBe(2);
    expect(new TextDecoder().decode(sent[0]!)).toBe("test1");
    expect(new TextDecoder().decode(sent[1]!)).toBe("test2");
  });

  it("should throw when sending on closed stream", async () => {
    const { streamA, streamB } = createMockStreamPair("a", "b");
    await streamA.close();

    await expect(streamA.send(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /closed/,
    );
  });

  it("should reject pending receives when closed", async () => {
    const { streamA, streamB } = createMockStreamPair("a", "b");

    // Start waiting for receive
    const receivePromise = streamB.receive();

    // Close the stream
    await streamB.close();

    // Should reject
    await expect(receivePromise).rejects.toThrow(/closed/);
  });

  it("should report open state correctly", async () => {
    const { streamA } = createMockStreamPair("a", "b");

    expect(streamA.isOpen()).toBe(true);
    await streamA.close();
    expect(streamA.isOpen()).toBe(false);
  });
});

describe("MockPeerConnection", () => {
  it("should open and accept streams", async () => {
    const { connA, connB } = createMockConnectionPair("node-a", "node-b");

    // Open stream from A
    const streamA = await connA.openStream();
    expect(streamA).toBeDefined();
    expect(streamA.isOpen()).toBe(true);

    // Stream should appear on B
    const streamB = await connB.acceptStream();
    expect(streamB).toBeDefined();
    expect(streamB.isOpen()).toBe(true);

    // Should be able to communicate
    await streamA.send(new TextEncoder().encode("hello from A"));
    const received = await streamB.receive();
    expect(new TextDecoder().decode(received)).toBe("hello from A");
  });

  it("should queue incoming streams", async () => {
    const { connA, connB } = createMockConnectionPair("node-a", "node-b");

    // Open multiple streams without accepting
    await connA.openStream();
    await connA.openStream();
    await connA.openStream();

    expect(connB.getPendingStreamCount()).toBe(3);
  });

  it("should notify stream callbacks", async () => {
    const { connA, connB } = createMockConnectionPair("node-a", "node-b");

    const receivedStreams: MockSyncStream[] = [];
    connB.onStream((stream) => {
      receivedStreams.push(stream as MockSyncStream);
    });

    await connA.openStream();
    await connA.openStream();

    // Callbacks should have been called
    expect(receivedStreams.length).toBe(2);
  });

  it("should notify state change callbacks on disconnect", async () => {
    const { connA, connB } = createMockConnectionPair("node-a", "node-b");

    let stateB: string | null = null;
    connB.onStateChange((state) => {
      stateB = state;
    });

    // Close A, which should notify B
    await connA.close();

    expect(stateB).toBe("disconnected");
  });

  it("should return correct RTT", () => {
    const { connA } = createMockConnectionPair("node-a", "node-b", {
      rttMs: 42,
    });

    expect(connA.getRttMs()).toBe(42);
  });

  it("should simulate disconnect", () => {
    const { connA } = createMockConnectionPair("node-a", "node-b");

    expect(connA.isConnected()).toBe(true);
    connA.simulateDisconnect();
    expect(connA.isConnected()).toBe(false);
    expect(connA.state).toBe("disconnected");
  });
});

describe("MockTransport", () => {
  afterEach(() => {
    resetMockRegistry();
  });

  it("should initialize and generate node ID", async () => {
    const transport = new MockTransport({ isolatedRegistry: true });
    await transport.initialize();

    expect(transport.isReady()).toBe(true);
    expect(transport.getNodeId()).toBeDefined();
    expect(transport.getNodeId().length).toBe(64); // 32 bytes hex encoded

    await transport.shutdown();
  });

  it("should generate tickets", async () => {
    const transport = new MockTransport({ isolatedRegistry: true });
    await transport.initialize();

    const ticket = await transport.generateTicket();
    expect(ticket).toBeDefined();

    // Ticket should be JSON with nodeId
    const parsed = JSON.parse(ticket);
    expect(parsed.nodeId).toBe(transport.getNodeId());

    await transport.shutdown();
  });

  it("should connect two transports via ticket", async () => {
    const { transportA, transportB } = await createMockTransportPair();

    // Get ticket from B
    const ticketB = await transportB.generateTicket();

    // Connect A to B
    const conn = await transportA.connectWithTicket(ticketB);

    expect(conn).toBeDefined();
    expect(conn.peerId).toBe(transportB.getNodeId());
    expect(conn.isConnected()).toBe(true);

    await transportA.shutdown();
    await transportB.shutdown();
  });

  it("should notify incoming connection callbacks", async () => {
    const { transportA, transportB } = await createMockTransportPair();

    let incomingConn: MockPeerConnection | null = null;
    transportB.onIncomingConnection((conn) => {
      incomingConn = conn as MockPeerConnection;
    });

    // A connects to B
    const ticketB = await transportB.generateTicket();
    await transportA.connectWithTicket(ticketB);

    expect(incomingConn).not.toBeNull();
    expect(incomingConn!.peerId).toBe(transportA.getNodeId());

    await transportA.shutdown();
    await transportB.shutdown();
  });

  it("should track active connections", async () => {
    const { transportA, transportB } = await createMockTransportPair();

    const ticketB = await transportB.generateTicket();
    await transportA.connectWithTicket(ticketB);

    expect(transportA.getConnections().length).toBe(1);
    expect(transportB.getConnections().length).toBe(1);

    const conn = transportA.getConnection(transportB.getNodeId());
    expect(conn).toBeDefined();

    await transportA.shutdown();
    await transportB.shutdown();
  });

  it("should shutdown and close all connections", async () => {
    const { transportA, transportB } = await createMockTransportPair();

    const ticketB = await transportB.generateTicket();
    const conn = await transportA.connectWithTicket(ticketB);

    expect(conn.isConnected()).toBe(true);

    await transportA.shutdown();

    expect(transportA.isReady()).toBe(false);
    expect(transportA.getConnections().length).toBe(0);
  });

  it("should support full sync flow", async () => {
    const { transportA, transportB } = await createMockTransportPair();

    // Set up B to handle incoming connections
    let acceptedStream: MockSyncStream | null = null;
    transportB.onIncomingConnection(async (conn) => {
      acceptedStream = (await conn.acceptStream()) as MockSyncStream;
    });

    // A connects to B and opens a stream
    const ticketB = await transportB.generateTicket();
    const conn = await transportA.connectWithTicket(ticketB);
    const stream = (await conn.openStream()) as MockSyncStream;

    // Wait for B to accept the stream
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acceptedStream).not.toBeNull();

    // Simulate sync protocol messages
    await stream.send(new TextEncoder().encode("VERSION_INFO"));
    const received = await acceptedStream!.receive();
    expect(new TextDecoder().decode(received)).toBe("VERSION_INFO");

    await acceptedStream!.send(new TextEncoder().encode("VERSION_INFO_REPLY"));
    const reply = await stream.receive();
    expect(new TextDecoder().decode(reply)).toBe("VERSION_INFO_REPLY");

    await transportA.shutdown();
    await transportB.shutdown();
  });
});

describe("MockTransport Stats", () => {
  it("should return accurate stats", async () => {
    const transport = new MockTransport({ isolatedRegistry: true });

    const statsBefore = transport.getStats();
    expect(statsBefore.ready).toBe(false);
    expect(statsBefore.connectionCount).toBe(0);

    await transport.initialize();

    const statsAfter = transport.getStats();
    expect(statsAfter.ready).toBe(true);
    expect(statsAfter.nodeId).toBe(transport.getNodeId());

    await transport.shutdown();
  });
});
