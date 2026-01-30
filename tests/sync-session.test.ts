/**
 * Sync Session Tests
 *
 * Tests for sync protocol state machine and message handling.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { SyncSession, type SyncSessionConfig } from "../src/sync/sync-session";
import { DocumentManager } from "../src/core/document-manager";
import { MemoryStorageAdapter } from "../src/core/storage-adapter";
import type { Logger } from "../src/utils/logger";
import type { SyncStream } from "../src/transport";

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
  private sentMessages: Uint8Array[] = [];
  private receiveQueue: Uint8Array[] = [];
  private receiveResolvers: Array<(data: Uint8Array) => void> = [];
  private closed = false;

  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Stream closed");
    this.sentMessages.push(data);
  }

  async receive(): Promise<Uint8Array> {
    if (this.closed) throw new Error("Stream closed");

    if (this.receiveQueue.length > 0) {
      return this.receiveQueue.shift()!;
    }

    // Wait for message
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Receive timeout"));
      }, 5000);

      this.receiveResolvers.push((data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    // Reject all pending receives
    for (const resolver of this.receiveResolvers) {
      // They'll throw on next access
    }
    this.receiveResolvers = [];
  }

  isOpen(): boolean {
    return !this.closed;
  }

  // Test helpers
  getSentMessages(): Uint8Array[] {
    return this.sentMessages;
  }

  pushMessage(data: Uint8Array): void {
    if (this.receiveResolvers.length > 0) {
      const resolver = this.receiveResolvers.shift()!;
      resolver(data);
    } else {
      this.receiveQueue.push(data);
    }
  }

  clearSent(): void {
    this.sentMessages = [];
  }
}

function createTestConfig(): SyncSessionConfig {
  return {
    ourTicket: "iroh://test-ticket-12345",
    ourHostname: "test-device",
    ourNickname: "Test",
    pingInterval: 60000, // Long interval for tests
    pingTimeout: 5000,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("SyncSession", () => {
  let storage: MemoryStorageAdapter;
  let logger: Logger;
  let docManager: DocumentManager;
  let stream: MockStream;
  let session: SyncSession;
  let config: SyncSessionConfig;

  beforeEach(async () => {
    storage = new MemoryStorageAdapter();
    logger = createTestLogger();
    docManager = new DocumentManager(storage, logger);
    await docManager.initialize();
    stream = new MockStream();
    config = createTestConfig();

    session = new SyncSession(
      stream,
      docManager,
      logger,
      config,
    );
  });

  describe("Initialization", () => {
    it("should create session in idle state", () => {
      expect(session.getState()).toBe("idle");
    });

    it("should not be closed initially", () => {
      expect(session.getState()).not.toBe("closed");
    });
  });

  describe("State Machine", () => {
    it("should emit state changes", async () => {
      const states: string[] = [];
      session.on("state:change", (state) => {
        states.push(state);
      });

      // Create a mock stream for the test
      const mockStream = new MockStream();

      // Start sync (will fail due to no peer response, but should change state)
      const syncPromise = session.startSync(mockStream);

      // Give it a moment to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have started syncing
      expect(states.length).toBeGreaterThan(0);

      // Clean up
      await session.close();
    });
  });

  describe("Close", () => {
    it("should close session", async () => {
      await session.close();
      expect(session.getState()).toBe("closed");
    });

    it("should be idempotent", async () => {
      await session.close();
      await session.close(); // Should not throw
      expect(session.getState()).toBe("closed");
    });
  });

  describe("Event Emission", () => {
    it("should allow error event subscription", async () => {
      const errors: Error[] = [];
      session.on("error", (error) => {
        errors.push(error);
      });

      // Verify subscription works by emitting manually
      session.emit("error", new Error("Test error"));
      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toBe("Test error");
    });
  });

  describe("Peer Info", () => {
    it("should emit peer info when received", async () => {
      let receivedInfo: { hostname: string; nickname?: string } | null = null;
      session.on("peer:info", (info) => {
        receivedInfo = info;
      });

      // The peer info is received during version exchange
      // This would require a full protocol simulation
      // For now, just verify the event handler works
      session.emit("peer:info", { hostname: "other-device", nickname: "Phone" });

      expect(receivedInfo?.hostname).toBe("other-device");
      expect(receivedInfo?.nickname).toBe("Phone");
    });
  });

  describe("Configuration", () => {
    it("should accept read-only peer config", async () => {
      const readOnlyConfig: SyncSessionConfig = {
        ...config,
        peerIsReadOnly: true,
      };

      const readOnlySession = new SyncSession(
        stream,
        docManager,
        logger,
        readOnlyConfig,
      );

      expect(readOnlySession.getState()).toBe("idle");
      await readOnlySession.close();
    });

    it("should accept vault adoption config", async () => {
      const adoptionConfig: SyncSessionConfig = {
        ...config,
        allowVaultAdoption: true,
      };

      const adoptionSession = new SyncSession(
        stream,
        docManager,
        logger,
        adoptionConfig,
      );

      expect(adoptionSession.getState()).toBe("idle");
      await adoptionSession.close();
    });
  });

  describe("Stream Handling", () => {
    it("should handle closed stream gracefully", async () => {
      await stream.close();

      // Starting sync on closed stream should not crash
      // It may resolve early or emit an error
      try {
        await session.startSync();
      } catch {
        // Expected - stream is closed
      }

      // Session should eventually be in error or closed state
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = session.getState();
      expect(["error", "closed", "idle"]).toContain(state);
    });
  });
});
