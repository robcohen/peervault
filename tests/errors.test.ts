/**
 * Error Handling Tests
 *
 * Tests for PeerVaultError base class and error catalog.
 */

import { describe, it, expect } from "bun:test";
import { PeerVaultError } from "../src/errors/base";
import { ErrorSeverity, ErrorCategory } from "../src/errors/types";
import {
  StorageErrors,
  SyncErrors,
  TransportErrors,
  ConfigErrors,
  PeerErrors,
} from "../src/errors/catalog";

// ============================================================================
// PeerVaultError Base Class Tests
// ============================================================================

describe("PeerVaultError", () => {
  describe("constructor", () => {
    it("should create error with all properties", () => {
      const error = new PeerVaultError(
        "Test error",
        "TEST_CODE",
        ErrorCategory.STORAGE,
        ErrorSeverity.ERROR,
        true,
        { key: "value" },
      );

      expect(error.message).toBe("Test error");
      expect(error.code).toBe("TEST_CODE");
      expect(error.category).toBe(ErrorCategory.STORAGE);
      expect(error.severity).toBe(ErrorSeverity.ERROR);
      expect(error.recoverable).toBe(true);
      expect(error.context).toEqual({ key: "value" });
    });

    it("should extend Error", () => {
      const error = new PeerVaultError(
        "Test",
        "TEST",
        ErrorCategory.SYNC,
        ErrorSeverity.WARNING,
        false,
      );

      expect(error instanceof Error).toBe(true);
      expect(error instanceof PeerVaultError).toBe(true);
    });

    it("should include cause in stack trace", () => {
      const cause = new Error("Original error");
      const error = new PeerVaultError(
        "Wrapped error",
        "WRAP",
        ErrorCategory.TRANSPORT,
        ErrorSeverity.ERROR,
        false,
        undefined,
        cause,
      );

      expect(error.cause).toBe(cause);
      expect(error.stack).toContain("Caused by:");
    });
  });

  describe("toJSON", () => {
    it("should serialize error to JSON", () => {
      const error = new PeerVaultError(
        "Test error",
        "TEST_CODE",
        ErrorCategory.CONFIG,
        ErrorSeverity.WARNING,
        true,
        { detail: "info" },
      );

      const json = error.toJSON();

      expect(json.name).toBe("PeerVaultError");
      expect(json.message).toBe("Test error");
      expect(json.code).toBe("TEST_CODE");
      expect(json.category).toBe(ErrorCategory.CONFIG);
      expect(json.severity).toBe(ErrorSeverity.WARNING);
      expect(json.recoverable).toBe(true);
      expect(json.context).toEqual({ detail: "info" });
      expect(json.stack).toBeDefined();
    });
  });

  describe("toString", () => {
    it("should format error as string", () => {
      const error = new PeerVaultError(
        "Test error",
        "TEST_CODE",
        ErrorCategory.PEER,
        ErrorSeverity.ERROR,
        false,
      );

      expect(error.toString()).toBe("[TEST_CODE] Test error");
    });

    it("should include context in string", () => {
      const error = new PeerVaultError(
        "Test error",
        "TEST_CODE",
        ErrorCategory.PEER,
        ErrorSeverity.ERROR,
        false,
        { peerId: "abc123" },
      );

      expect(error.toString()).toContain("[TEST_CODE] Test error");
      expect(error.toString()).toContain("peerId");
    });
  });

  describe("isCategory", () => {
    it("should return true for matching category", () => {
      const error = new PeerVaultError(
        "Test",
        "TEST",
        ErrorCategory.SYNC,
        ErrorSeverity.ERROR,
        false,
      );

      expect(error.isCategory(ErrorCategory.SYNC)).toBe(true);
    });

    it("should return false for non-matching category", () => {
      const error = new PeerVaultError(
        "Test",
        "TEST",
        ErrorCategory.SYNC,
        ErrorSeverity.ERROR,
        false,
      );

      expect(error.isCategory(ErrorCategory.STORAGE)).toBe(false);
    });
  });

  describe("shouldNotifyUser", () => {
    it("should return true for ERROR severity", () => {
      const error = new PeerVaultError(
        "Test",
        "TEST",
        ErrorCategory.SYNC,
        ErrorSeverity.ERROR,
        false,
      );

      expect(error.shouldNotifyUser()).toBe(true);
    });

    it("should return true for CRITICAL severity", () => {
      const error = new PeerVaultError(
        "Test",
        "TEST",
        ErrorCategory.SYNC,
        ErrorSeverity.CRITICAL,
        false,
      );

      expect(error.shouldNotifyUser()).toBe(true);
    });

    it("should return false for WARNING severity", () => {
      const error = new PeerVaultError(
        "Test",
        "TEST",
        ErrorCategory.SYNC,
        ErrorSeverity.WARNING,
        false,
      );

      expect(error.shouldNotifyUser()).toBe(false);
    });

    it("should return false for INFO severity", () => {
      const error = new PeerVaultError(
        "Test",
        "TEST",
        ErrorCategory.SYNC,
        ErrorSeverity.INFO,
        false,
      );

      expect(error.shouldNotifyUser()).toBe(false);
    });
  });

  describe("wrap", () => {
    it("should return PeerVaultError unchanged", () => {
      const original = new PeerVaultError(
        "Original",
        "ORIG",
        ErrorCategory.SYNC,
        ErrorSeverity.ERROR,
        true,
      );

      const wrapped = PeerVaultError.wrap(
        original,
        "WRAP",
        ErrorCategory.STORAGE,
      );

      expect(wrapped).toBe(original);
    });

    it("should wrap Error with cause", () => {
      const original = new Error("Original error");

      const wrapped = PeerVaultError.wrap(
        original,
        "WRAP_CODE",
        ErrorCategory.TRANSPORT,
        { detail: "test" },
      );

      expect(wrapped.message).toBe("Original error");
      expect(wrapped.code).toBe("WRAP_CODE");
      expect(wrapped.category).toBe(ErrorCategory.TRANSPORT);
      expect(wrapped.cause).toBe(original);
      expect(wrapped.context).toEqual({ detail: "test" });
    });

    it("should wrap non-Error values", () => {
      const wrapped = PeerVaultError.wrap(
        "string error",
        "WRAP_CODE",
        ErrorCategory.CONFIG,
      );

      expect(wrapped.message).toBe("string error");
      expect(wrapped.code).toBe("WRAP_CODE");
    });
  });

  describe("isPeerVaultError", () => {
    it("should return true for PeerVaultError", () => {
      const error = new PeerVaultError(
        "Test",
        "TEST",
        ErrorCategory.SYNC,
        ErrorSeverity.ERROR,
        false,
      );

      expect(PeerVaultError.isPeerVaultError(error)).toBe(true);
    });

    it("should return false for regular Error", () => {
      const error = new Error("Test");

      expect(PeerVaultError.isPeerVaultError(error)).toBe(false);
    });

    it("should return false for non-error values", () => {
      expect(PeerVaultError.isPeerVaultError(null)).toBe(false);
      expect(PeerVaultError.isPeerVaultError(undefined)).toBe(false);
      expect(PeerVaultError.isPeerVaultError("string")).toBe(false);
      expect(PeerVaultError.isPeerVaultError({})).toBe(false);
    });
  });
});

// ============================================================================
// Error Catalog Tests
// ============================================================================

describe("Error Catalog", () => {
  describe("StorageErrors", () => {
    it("should create read error", () => {
      const error = StorageErrors.readFailed("/test/path.md", "IO error");

      expect(error.code).toBe("STOR_READ_FAILED");
      expect(error.category).toBe(ErrorCategory.STORAGE);
      expect(error.context?.path).toBe("/test/path.md");
      expect(error.context?.reason).toBe("IO error");
    });

    it("should create write error", () => {
      const error = StorageErrors.writeFailed("/test/path.md", "Disk full");

      expect(error.code).toBe("STOR_WRITE_FAILED");
      expect(error.category).toBe(ErrorCategory.STORAGE);
      expect(error.context?.path).toBe("/test/path.md");
    });
  });

  describe("SyncErrors", () => {
    it("should create vault mismatch error", () => {
      const error = SyncErrors.vaultMismatch("local-id", "remote-id");

      expect(error.code).toBe("SYNC_VAULT_MISMATCH");
      expect(error.category).toBe(ErrorCategory.SYNC);
      expect(error.context?.localId).toBe("local-id");
      expect(error.context?.remoteId).toBe("remote-id");
    });

    it("should create protocol error", () => {
      const error = SyncErrors.protocolError("Unexpected message");

      expect(error.code).toBe("SYNC_PROTOCOL_ERROR");
      expect(error.message).toContain("Unexpected message");
    });

    it("should create timeout error", () => {
      const error = SyncErrors.timeout("Connection timed out");

      expect(error.code).toBe("SYNC_TIMEOUT");
      expect(error.recoverable).toBe(true);
    });
  });

  describe("TransportErrors", () => {
    it("should create WASM load error", () => {
      const error = TransportErrors.wasmLoadFailed("Module not found");

      expect(error.code).toBe("TRANSPORT_WASM_LOAD");
      expect(error.severity).toBe(ErrorSeverity.CRITICAL);
      expect(error.recoverable).toBe(false);
    });

    it("should create connection failed error", () => {
      const error = TransportErrors.connectionFailed("peer-123", "Refused");

      expect(error.code).toBe("TRANSPORT_CONN_FAILED");
      expect(error.context?.peerId).toBe("peer-123");
    });
  });

  describe("ConfigErrors", () => {
    it("should create invalid config error", () => {
      const error = ConfigErrors.invalid("maxSize", "Must be positive");

      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.context?.field).toBe("maxSize");
      expect(error.context?.reason).toBe("Must be positive");
    });

    it("should create migration failed error", () => {
      const error = ConfigErrors.migrationFailed(1, 2, "Schema change");

      expect(error.code).toBe("CONFIG_MIGRATION_FAILED");
      expect(error.message).toContain("v1");
      expect(error.message).toContain("v2");
    });
  });

  describe("PeerErrors", () => {
    it("should create unknown peer error", () => {
      const error = PeerErrors.unknownPeer("peer-abc");

      expect(error.code).toBe("PEER_UNKNOWN");
      expect(error.context?.nodeId).toBe("peer-abc");
    });

    it("should create not found error", () => {
      const error = PeerErrors.notFound("peer-xyz");

      expect(error.code).toBe("PEER_NOT_FOUND");
    });
  });
});
