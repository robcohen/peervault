/**
 * Sync Session Tests
 *
 * Tests for sync protocol state machine and message handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SyncSession, type SyncSessionConfig } from "../src/sync/sync-session";
import { DocumentManager } from "../src/core/document-manager";
import { MemoryStorageAdapter } from "../src/core/storage-adapter";
import type { Logger } from "../src/utils/logger";
import type { SyncStream } from "../src/transport";
import {
  SyncMessageType,
  SyncErrorCode,
  serializeMessage,
  deserializeMessage,
  createVersionInfoMessage,
  createUpdatesMessage,
  createSyncCompleteMessage,
  createPingMessage,
  createPongMessage,
  createErrorMessage,
  createBlobHashesMessage,
  createBlobSyncCompleteMessage,
} from "../src/sync";

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
    time: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    timeSync: <T>(_label: string, fn: () => T) => fn(),
  };
}

/**
 * Mock stream that allows simulating protocol messages.
 */
class MockStream implements SyncStream {
  id = "test-stream";
  private sentMessages: Uint8Array[] = [];
  private receiveQueue: Uint8Array[] = [];
  private receiveResolvers: Array<{
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
  }> = [];
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

      this.receiveResolvers.push({
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    // Reject all pending receives
    for (const { reject } of this.receiveResolvers) {
      reject(new Error("Stream closed"));
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

  getDeserializedSentMessages(): ReturnType<typeof deserializeMessage>[] {
    return this.sentMessages.map((m) => deserializeMessage(m));
  }

  pushMessage(data: Uint8Array): void {
    if (this.receiveResolvers.length > 0) {
      const { resolve } = this.receiveResolvers.shift()!;
      resolve(data);
    } else {
      this.receiveQueue.push(data);
    }
  }

  pushSerializedMessage(message: ReturnType<typeof createVersionInfoMessage>): void {
    this.pushMessage(serializeMessage(message));
  }

  clearSent(): void {
    this.sentMessages = [];
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function createTestConfig(overrides?: Partial<SyncSessionConfig>): SyncSessionConfig {
  return {
    ourTicket: "iroh://test-ticket-12345",
    ourHostname: "test-device",
    ourNickname: "Test",
    pingInterval: 60000, // Long interval for tests
    pingTimeout: 5000,
    receiveTimeout: 1000, // Short timeout for tests
    ...overrides,
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
  });

  afterEach(async () => {
    if (session) {
      await session.close();
    }
  });

  describe("Initialization", () => {
    it("should create session in idle state", () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      expect(session.getState()).toBe("idle");
    });

    it("should initialize bandwidth stats to zero", () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      const stats = session.getBandwidthStats();
      expect(stats.bytesSent).toBe(0);
      expect(stats.bytesReceived).toBe(0);
    });
  });

  describe("State Machine", () => {
    it("should emit state changes during sync", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      const states: string[] = [];
      session.on("state:change", (state) => {
        states.push(state);
      });

      // Start sync - will transition to exchanging_versions
      const syncPromise = session.startSync(stream);

      // Give it a moment to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have started version exchange
      expect(states).toContain("exchanging_versions");

      // Clean up
      await session.close();
      await syncPromise.catch(() => {}); // Ignore errors from interrupted sync
    });

    it("should transition to error state on protocol error", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      const states: string[] = [];
      session.on("state:change", (state) => {
        states.push(state);
      });

      // Push invalid message
      stream.pushSerializedMessage(createPingMessage(1));

      // Start sync expecting VERSION_INFO but getting PING
      await session.startSync(stream).catch(() => {});

      expect(states).toContain("error");
    });

    it("should not allow startSync when not idle", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);

      // Close the session first
      await session.close();

      // Try to start sync on closed session
      await expect(session.startSync(stream)).rejects.toThrow();
    });
  });

  describe("Version Exchange (Initiator)", () => {
    it("should send VERSION_INFO as first message", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);

      const syncPromise = session.startSync(stream);

      // Wait for message to be sent
      await new Promise((resolve) => setTimeout(resolve, 50));

      const sent = stream.getDeserializedSentMessages();
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]!.type).toBe(SyncMessageType.VERSION_INFO);

      await session.close();
      await syncPromise.catch(() => {});
    });

    it("should include our ticket and hostname in VERSION_INFO", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const sent = stream.getDeserializedSentMessages();
      const versionInfo = sent[0] as ReturnType<typeof createVersionInfoMessage>;
      expect(versionInfo.ticket).toBe(config.ourTicket);
      expect(versionInfo.hostname).toBe(config.ourHostname);
      expect(versionInfo.nickname).toBe(config.ourNickname);

      await session.close();
      await syncPromise.catch(() => {});
    });

    it("should emit peer info when received", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      let peerInfo: { hostname: string; nickname?: string } | null = null;
      session.on("peer:info", (info) => {
        peerInfo = info;
      });

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send peer's VERSION_INFO response
      const vaultId = docManager.getVaultId();
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          vaultId,
          docManager.getVersionBytes(),
          "iroh://peer-ticket",
          "peer-device",
          "PeerNick",
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(peerInfo?.hostname).toBe("peer-device");
      expect(peerInfo?.nickname).toBe("PeerNick");

      await session.close();
      await syncPromise.catch(() => {});
    });

    it("should emit ticket received event", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      let receivedTicket: string | null = null;
      session.on("ticket:received", (ticket) => {
        receivedTicket = ticket;
      });

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send peer's VERSION_INFO response
      const vaultId = docManager.getVaultId();
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          vaultId,
          docManager.getVersionBytes(),
          "iroh://peer-ticket-xyz",
          "peer-device",
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedTicket).toBe("iroh://peer-ticket-xyz");

      await session.close();
      await syncPromise.catch(() => {});
    });
  });

  describe("Vault ID Validation", () => {
    it("should reject mismatched vault IDs by default", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      let errorEmitted = false;
      session.on("error", () => {
        errorEmitted = true;
      });

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send peer's VERSION_INFO with different vault ID
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          "different-vault-id",
          new Uint8Array([1, 2, 3]),
          "iroh://peer-ticket",
          "peer-device",
        ),
      );

      await syncPromise.catch(() => {});

      expect(errorEmitted).toBe(true);
      expect(session.getState()).toBe("error");
    });

    it("should send ERROR message on vault mismatch", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      stream.clearSent(); // Clear VERSION_INFO

      // Send peer's VERSION_INFO with different vault ID
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          "different-vault-id",
          new Uint8Array([1, 2, 3]),
          "iroh://peer-ticket",
          "peer-device",
        ),
      );

      await syncPromise.catch(() => {});

      const sent = stream.getDeserializedSentMessages();
      const errorMsg = sent.find((m) => m.type === SyncMessageType.ERROR);
      expect(errorMsg).toBeDefined();
      expect((errorMsg as ReturnType<typeof createErrorMessage>).code).toBe(
        SyncErrorCode.VAULT_MISMATCH,
      );
    });
  });

  describe("Version Exchange (Acceptor)", () => {
    it("should wait for peer VERSION_INFO first", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);

      const syncPromise = session.handleIncomingSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No messages sent yet - waiting for peer
      expect(stream.getSentMessages().length).toBe(0);

      // Send peer's VERSION_INFO
      const vaultId = docManager.getVaultId();
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          vaultId,
          docManager.getVersionBytes(),
          "iroh://peer-ticket",
          "peer-device",
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Now should have sent our VERSION_INFO
      const sent = stream.getDeserializedSentMessages();
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]!.type).toBe(SyncMessageType.VERSION_INFO);

      await session.close();
      await syncPromise.catch(() => {});
    });
  });

  describe("Close", () => {
    it("should close session and transition to closed state", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      await session.close();
      expect(session.getState()).toBe("closed");
    });

    it("should be idempotent", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      await session.close();
      await session.close(); // Should not throw
      expect(session.getState()).toBe("closed");
    });

    it("should close underlying stream", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      await session.close();

      expect(stream.isClosed()).toBe(true);
      await syncPromise.catch(() => {});
    });
  });

  describe("Bandwidth Tracking", () => {
    it("should track bytes sent", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = session.getBandwidthStats();
      expect(stats.bytesSent).toBeGreaterThan(0); // VERSION_INFO was sent

      await session.close();
      await syncPromise.catch(() => {});
    });

    it("should track bytes received", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send a message to the session
      const vaultId = docManager.getVaultId();
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          vaultId,
          docManager.getVersionBytes(),
          "iroh://peer-ticket",
          "peer-device",
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const stats = session.getBandwidthStats();
      expect(stats.bytesReceived).toBeGreaterThan(0);

      await session.close();
      await syncPromise.catch(() => {});
    });
  });

  describe("Event Emission", () => {
    it("should emit sync:complete on successful sync", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      let syncComplete = false;
      session.on("sync:complete", () => {
        syncComplete = true;
      });

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Complete the protocol
      const vaultId = docManager.getVaultId();

      // 1. Peer VERSION_INFO
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          vaultId,
          docManager.getVersionBytes(),
          "iroh://peer-ticket",
          "peer-device",
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 2. Peer UPDATES
      stream.pushSerializedMessage(createUpdatesMessage(new Uint8Array(0), 0));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 3. Peer SYNC_COMPLETE
      stream.pushSerializedMessage(
        createSyncCompleteMessage(docManager.getVersionBytes()),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 4. Peer BLOB_HASHES (empty)
      stream.pushSerializedMessage(createBlobHashesMessage([]));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 5. Peer BLOB_SYNC_COMPLETE
      stream.pushSerializedMessage(createBlobSyncCompleteMessage());
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(syncComplete).toBe(true);
      expect(session.getState()).toBe("live");

      await session.close();
      await syncPromise.catch(() => {});
    });

    it("should emit error on protocol errors", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      const errors: Error[] = [];
      session.on("error", (error) => {
        errors.push(error);
      });

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send unexpected message type
      stream.pushSerializedMessage(createPingMessage(123));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errors.length).toBeGreaterThan(0);

      await session.close();
      await syncPromise.catch(() => {});
    });
  });

  describe("Configuration", () => {
    it("should accept read-only peer config", () => {
      session = new SyncSession("peer-123", docManager, logger, {
        ...config,
        peerIsReadOnly: true,
      });

      expect(session.getState()).toBe("idle");
    });

    it("should accept vault adoption config", () => {
      session = new SyncSession("peer-123", docManager, logger, {
        ...config,
        allowVaultAdoption: true,
      });

      expect(session.getState()).toBe("idle");
    });

    it("should call onVaultAdoptionNeeded when vault IDs mismatch", async () => {
      let adoptionRequested = false;
      session = new SyncSession("peer-123", docManager, logger, {
        ...config,
        allowVaultAdoption: true,
        onVaultAdoptionNeeded: async (peerVaultId, ourVaultId) => {
          adoptionRequested = true;
          expect(peerVaultId).toBe("different-vault");
          expect(ourVaultId).toBe(docManager.getVaultId());
          return false; // Deny adoption
        },
      });

      const syncPromise = session.handleIncomingSync(stream);

      // Send peer's VERSION_INFO with different vault ID
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          "different-vault",
          new Uint8Array([1, 2, 3]),
          "iroh://peer-ticket",
          "peer-device",
        ),
      );

      await syncPromise.catch(() => {});

      expect(adoptionRequested).toBe(true);
    });
  });

  describe("Peer Name Sanitization", () => {
    it("should truncate long hostnames", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      let peerInfo: { hostname: string; nickname?: string } | null = null;
      session.on("peer:info", (info) => {
        peerInfo = info;
      });

      const syncPromise = session.handleIncomingSync(stream);

      // Send VERSION_INFO with very long hostname
      const longHostname = "a".repeat(200);
      const vaultId = docManager.getVaultId();
      stream.pushSerializedMessage(
        createVersionInfoMessage(
          vaultId,
          docManager.getVersionBytes(),
          "iroh://peer-ticket",
          longHostname,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should be truncated to 64 chars + ellipsis
      expect(peerInfo?.hostname?.length).toBeLessThanOrEqual(65);

      await session.close();
      await syncPromise.catch(() => {});
    });
  });

  describe("Stream Error Handling", () => {
    it("should handle closed stream and transition to error state", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      await stream.close();

      // Starting sync on closed stream will fail during send/receive
      await session.startSync(stream).catch(() => {});

      // Should end up in error state
      expect(session.getState()).toBe("error");
    });

    it("should transition to error state on stream errors", async () => {
      session = new SyncSession("peer-123", docManager, logger, config);
      const states: string[] = [];
      session.on("state:change", (state) => {
        states.push(state);
      });

      const syncPromise = session.startSync(stream);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Close stream mid-sync
      await stream.close();

      await syncPromise.catch(() => {});

      expect(states).toContain("error");
    });
  });
});
