/**
 * Mock Transport Layer
 *
 * In-memory transport implementation for testing.
 * Provides MockTransport, MockPeerConnection, and MockSyncStream.
 */

// Main transport
export {
  MockTransport,
  createMockTransportPair,
  type MockTransportConfig,
  type MockTransportStats,
} from "./mock-transport";

// Connection
export {
  MockPeerConnection,
  createMockConnectionPair,
  type MockConnectionConfig,
} from "./mock-connection";

// Stream
export {
  MockSyncStream,
  createMockStreamPair,
  type MockStreamConfig,
} from "./mock-stream";

// Registry
export {
  getMockRegistry,
  resetMockRegistry,
  createInMemoryRegistry,
  type MockRegistry,
} from "./mock-registry";
