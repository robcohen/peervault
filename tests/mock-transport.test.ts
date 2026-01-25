/**
 * Mock Transport Tests
 *
 * Tests for the mock transport implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MockTransport, clearMockRegistry, type TransportConfig } from '../src/transport';

function createTestConfig(name: string): TransportConfig {
  const keys = new Map<string, Uint8Array>();

  return {
    storage: {
      loadSecretKey: async () => keys.get(name) ?? null,
      saveSecretKey: async (key: Uint8Array) => {
        keys.set(name, key);
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    debug: false,
  };
}

describe('MockTransport', () => {
  beforeEach(() => {
    clearMockRegistry();
  });

  afterEach(() => {
    clearMockRegistry();
  });

  it('should initialize and get node ID', async () => {
    const transport = new MockTransport(createTestConfig('test1'));
    await transport.initialize();

    const nodeId = transport.getNodeId();
    expect(nodeId).toBeDefined();
    expect(nodeId.length).toBe(32); // 16 bytes = 32 hex chars
    expect(transport.isReady()).toBe(true);
  });

  it('should generate a valid ticket', async () => {
    const transport = new MockTransport(createTestConfig('test1'));
    await transport.initialize();

    const ticket = await transport.generateTicket();
    expect(ticket).toStartWith('mock://');
    expect(ticket).toContain(transport.getNodeId());
  });

  it('should connect two transports', async () => {
    const transport1 = new MockTransport(createTestConfig('peer1'));
    const transport2 = new MockTransport(createTestConfig('peer2'));

    await transport1.initialize();
    await transport2.initialize();

    // Set up incoming connection handler
    let incomingConnection: unknown = null;
    transport2.onIncomingConnection((conn) => {
      incomingConnection = conn;
    });

    // Connect transport1 to transport2
    const ticket = await transport2.generateTicket();
    const connection = await transport1.connectWithTicket(ticket);

    expect(connection).toBeDefined();
    expect(connection.peerId).toBe(transport2.getNodeId());
    expect(connection.isConnected()).toBe(true);

    // Transport2 should have received the connection
    expect(incomingConnection).toBeDefined();
  });

  it('should exchange messages over stream', async () => {
    const transport1 = new MockTransport(createTestConfig('peer1'));
    const transport2 = new MockTransport(createTestConfig('peer2'));

    await transport1.initialize();
    await transport2.initialize();

    // Connect
    const ticket = await transport2.generateTicket();
    const conn1 = await transport1.connectWithTicket(ticket);

    // Open stream from peer1
    const stream1 = await conn1.openStream();

    // Accept stream on peer2
    const conn2 = transport2.getConnection(transport1.getNodeId());
    expect(conn2).toBeDefined();
    const stream2 = await conn2!.acceptStream();

    // Send message from peer1 to peer2
    const message = new TextEncoder().encode('Hello, peer!');
    await stream1.send(message);

    const received = await stream2.receive();
    expect(new TextDecoder().decode(received)).toBe('Hello, peer!');

    // Send response from peer2 to peer1
    const response = new TextEncoder().encode('Hello back!');
    await stream2.send(response);

    const receivedResponse = await stream1.receive();
    expect(new TextDecoder().decode(receivedResponse)).toBe('Hello back!');
  });

  it('should handle connection close', async () => {
    const transport1 = new MockTransport(createTestConfig('peer1'));
    const transport2 = new MockTransport(createTestConfig('peer2'));

    await transport1.initialize();
    await transport2.initialize();

    const ticket = await transport2.generateTicket();
    const conn1 = await transport1.connectWithTicket(ticket);

    expect(conn1.isConnected()).toBe(true);

    await conn1.close();

    expect(conn1.isConnected()).toBe(false);
  });

  it('should fail to connect with invalid ticket', async () => {
    const transport = new MockTransport(createTestConfig('test1'));
    await transport.initialize();

    await expect(transport.connectWithTicket('invalid')).rejects.toThrow();
    await expect(transport.connectWithTicket('mock://nonexistent')).rejects.toThrow();
  });

  it('should persist node ID across reinitializations', async () => {
    const config = createTestConfig('persist-test');

    const transport1 = new MockTransport(config);
    await transport1.initialize();
    const nodeId1 = transport1.getNodeId();
    await transport1.shutdown();

    // Reinitialize with same config (same storage)
    const transport2 = new MockTransport(config);
    await transport2.initialize();
    const nodeId2 = transport2.getNodeId();

    expect(nodeId2).toBe(nodeId1);
  });

  it('should shutdown cleanly', async () => {
    const transport = new MockTransport(createTestConfig('test1'));
    await transport.initialize();

    expect(transport.isReady()).toBe(true);

    await transport.shutdown();

    expect(transport.isReady()).toBe(false);
  });
});
