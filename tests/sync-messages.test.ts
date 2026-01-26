/**
 * Sync Messages Tests
 *
 * Tests for sync protocol message serialization/deserialization.
 */

import { describe, it, expect } from 'bun:test';
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
} from '../src/sync';

describe('Sync Messages', () => {
  describe('VERSION_INFO', () => {
    it('should serialize and deserialize VERSION_INFO message', () => {
      const vaultId = 'test-vault-123';
      const versionBytes = new Uint8Array([1, 2, 3, 4, 5]);

      const message = createVersionInfoMessage(vaultId, versionBytes);
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.type).toBe(SyncMessageType.VERSION_INFO);
      expect((deserialized as typeof message).vaultId).toBe(vaultId);
      expect((deserialized as typeof message).versionBytes).toEqual(versionBytes);
    });

    it('should handle empty version bytes', () => {
      const message = createVersionInfoMessage('vault', new Uint8Array(0));
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.type).toBe(SyncMessageType.VERSION_INFO);
      expect((deserialized as typeof message).versionBytes.length).toBe(0);
    });

    it('should handle Unicode vault ID', () => {
      const vaultId = 'test-vault-日本語-🎉';
      const message = createVersionInfoMessage(vaultId, new Uint8Array([1]));
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect((deserialized as typeof message).vaultId).toBe(vaultId);
    });
  });

  describe('UPDATES', () => {
    it('should serialize and deserialize UPDATES message', () => {
      const updates = new Uint8Array([10, 20, 30, 40, 50]);
      const opCount = 42;

      const message = createUpdatesMessage(updates, opCount);
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.type).toBe(SyncMessageType.UPDATES);
      expect((deserialized as typeof message).updates).toEqual(updates);
      expect((deserialized as typeof message).opCount).toBe(opCount);
    });

    it('should handle large updates', () => {
      const updates = new Uint8Array(10000).fill(42);

      const message = createUpdatesMessage(updates, 1000);
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect((deserialized as typeof message).updates.length).toBe(10000);
    });
  });

  describe('SYNC_COMPLETE', () => {
    it('should serialize and deserialize SYNC_COMPLETE message', () => {
      const versionBytes = new Uint8Array([100, 200]);

      const message = createSyncCompleteMessage(versionBytes);
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.type).toBe(SyncMessageType.SYNC_COMPLETE);
      expect((deserialized as typeof message).versionBytes).toEqual(versionBytes);
    });
  });

  describe('PING/PONG', () => {
    it('should serialize and deserialize PING message', () => {
      const seq = 12345;

      const message = createPingMessage(seq);
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.type).toBe(SyncMessageType.PING);
      expect((deserialized as typeof message).seq).toBe(seq);
    });

    it('should serialize and deserialize PONG message', () => {
      const seq = 67890;

      const message = createPongMessage(seq);
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.type).toBe(SyncMessageType.PONG);
      expect((deserialized as typeof message).seq).toBe(seq);
    });
  });

  describe('ERROR', () => {
    it('should serialize and deserialize ERROR message', () => {
      const code = SyncErrorCode.VAULT_MISMATCH;
      const errorMessage = 'Vault IDs do not match';

      const message = createErrorMessage(code, errorMessage);
      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.type).toBe(SyncMessageType.ERROR);
      expect((deserialized as typeof message).code).toBe(code);
      expect((deserialized as typeof message).message).toBe(errorMessage);
    });

    it('should handle all error codes', () => {
      const codes = [
        SyncErrorCode.UNKNOWN,
        SyncErrorCode.VERSION_MISMATCH,
        SyncErrorCode.VAULT_MISMATCH,
        SyncErrorCode.INVALID_MESSAGE,
        SyncErrorCode.INTERNAL_ERROR,
      ];

      for (const code of codes) {
        const message = createErrorMessage(code, `Error code ${code}`);
        const serialized = serializeMessage(message);
        const deserialized = deserializeMessage(serialized);

        expect((deserialized as typeof message).code).toBe(code);
      }
    });
  });

  describe('Error handling', () => {
    it('should throw on message too short', () => {
      const shortData = new Uint8Array([1, 2, 3]);
      expect(() => deserializeMessage(shortData)).toThrow('Message too short');
    });

    it('should throw on unknown message type', () => {
      // Create a valid-length buffer with invalid type
      const buffer = new ArrayBuffer(13);
      const view = new DataView(buffer);
      view.setUint8(0, 0x99); // Invalid type
      view.setBigUint64(1, BigInt(Date.now()), false);

      expect(() => deserializeMessage(new Uint8Array(buffer))).toThrow('Invalid sync message type');
    });
  });

  describe('Timestamp preservation', () => {
    it('should preserve timestamp through serialization', () => {
      const before = Date.now();
      const message = createVersionInfoMessage('vault', new Uint8Array([1]));
      const after = Date.now();

      const serialized = serializeMessage(message);
      const deserialized = deserializeMessage(serialized);

      expect(deserialized.timestamp).toBeGreaterThanOrEqual(before);
      expect(deserialized.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
