/**
 * WebRTC Signaling Tests
 *
 * Tests for signaling message serialization/deserialization.
 */

import { describe, it, expect } from 'bun:test';
import {
  SignalingMessageType,
  serializeSignalingMessage,
  deserializeSignalingMessage,
  createUpgradeRequest,
  createUpgradeAccept,
  createUpgradeReject,
  createOffer,
  createAnswer,
  createIceCandidate,
  createReady,
  isSignalingMessageType,
} from '../src/transport/webrtc';

describe('WebRTC Signaling Messages', () => {
  describe('UPGRADE_REQUEST', () => {
    it('should serialize and deserialize UPGRADE_REQUEST message', () => {
      const message = createUpgradeRequest();
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect(deserialized.type).toBe(SignalingMessageType.UPGRADE_REQUEST);
      expect(deserialized.timestamp).toBeGreaterThan(0);
    });
  });

  describe('UPGRADE_ACCEPT', () => {
    it('should serialize and deserialize UPGRADE_ACCEPT message', () => {
      const message = createUpgradeAccept();
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect(deserialized.type).toBe(SignalingMessageType.UPGRADE_ACCEPT);
    });
  });

  describe('UPGRADE_REJECT', () => {
    it('should serialize and deserialize UPGRADE_REJECT message', () => {
      const reason = 'WebRTC not available';
      const message = createUpgradeReject(reason);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect(deserialized.type).toBe(SignalingMessageType.UPGRADE_REJECT);
      expect((deserialized as typeof message).reason).toBe(reason);
    });

    it('should handle Unicode reason', () => {
      const reason = 'Not available: 接続失敗 🚫';
      const message = createUpgradeReject(reason);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect((deserialized as typeof message).reason).toBe(reason);
    });

    it('should handle empty reason', () => {
      const message = createUpgradeReject('');
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect((deserialized as typeof message).reason).toBe('');
    });
  });

  describe('OFFER', () => {
    it('should serialize and deserialize OFFER message', () => {
      const sdp = 'v=0\r\no=- 1234567890 2 IN IP4 127.0.0.1\r\n...';
      const message = createOffer(sdp);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect(deserialized.type).toBe(SignalingMessageType.OFFER);
      expect((deserialized as typeof message).sdp).toBe(sdp);
    });

    it('should handle large SDP', () => {
      const sdp = 'v=0\r\n' + 'a=candidate:'.repeat(1000);
      const message = createOffer(sdp);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect((deserialized as typeof message).sdp).toBe(sdp);
    });
  });

  describe('ANSWER', () => {
    it('should serialize and deserialize ANSWER message', () => {
      const sdp = 'v=0\r\no=- 9876543210 2 IN IP4 192.168.1.1\r\n...';
      const message = createAnswer(sdp);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect(deserialized.type).toBe(SignalingMessageType.ANSWER);
      expect((deserialized as typeof message).sdp).toBe(sdp);
    });
  });

  describe('ICE_CANDIDATE', () => {
    it('should serialize and deserialize ICE_CANDIDATE message with all fields', () => {
      // Create a mock RTCIceCandidate-like object
      const candidate = {
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.100 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      } as RTCIceCandidate;

      const message = createIceCandidate(candidate);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect(deserialized.type).toBe(SignalingMessageType.ICE_CANDIDATE);
      expect((deserialized as typeof message).candidate).toBe(candidate.candidate);
      expect((deserialized as typeof message).sdpMid).toBe(candidate.sdpMid);
      expect((deserialized as typeof message).sdpMLineIndex).toBe(candidate.sdpMLineIndex);
    });

    it('should handle null sdpMid', () => {
      const candidate = {
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.100 54321 typ host',
        sdpMid: null,
        sdpMLineIndex: 0,
      } as RTCIceCandidate;

      const message = createIceCandidate(candidate);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect((deserialized as typeof message).sdpMid).toBeNull();
      expect((deserialized as typeof message).sdpMLineIndex).toBe(0);
    });

    it('should handle null sdpMLineIndex', () => {
      const candidate = {
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.100 54321 typ host',
        sdpMid: '0',
        sdpMLineIndex: null,
      } as RTCIceCandidate;

      const message = createIceCandidate(candidate);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect((deserialized as typeof message).sdpMid).toBe('0');
      expect((deserialized as typeof message).sdpMLineIndex).toBeNull();
    });

    it('should handle IPv6 candidates', () => {
      const candidate = {
        candidate: 'candidate:1 1 UDP 2122252543 2001:db8::1 54321 typ host',
        sdpMid: 'audio',
        sdpMLineIndex: 1,
      } as RTCIceCandidate;

      const message = createIceCandidate(candidate);
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect((deserialized as typeof message).candidate).toContain('2001:db8::1');
    });
  });

  describe('READY', () => {
    it('should serialize and deserialize READY message', () => {
      const message = createReady();
      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect(deserialized.type).toBe(SignalingMessageType.READY);
    });
  });

  describe('isSignalingMessageType', () => {
    it('should return true for signaling message types', () => {
      expect(isSignalingMessageType(0x30)).toBe(true); // UPGRADE_REQUEST
      expect(isSignalingMessageType(0x31)).toBe(true); // UPGRADE_ACCEPT
      expect(isSignalingMessageType(0x32)).toBe(true); // UPGRADE_REJECT
      expect(isSignalingMessageType(0x33)).toBe(true); // OFFER
      expect(isSignalingMessageType(0x34)).toBe(true); // ANSWER
      expect(isSignalingMessageType(0x35)).toBe(true); // ICE_CANDIDATE
      expect(isSignalingMessageType(0x36)).toBe(true); // READY
    });

    it('should return false for non-signaling message types', () => {
      expect(isSignalingMessageType(0x00)).toBe(false);
      expect(isSignalingMessageType(0x01)).toBe(false); // VERSION_INFO
      expect(isSignalingMessageType(0x02)).toBe(false); // UPDATES
      expect(isSignalingMessageType(0x2f)).toBe(false);
      expect(isSignalingMessageType(0x37)).toBe(false);
      expect(isSignalingMessageType(0xff)).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should throw on message too short', () => {
      const shortData = new Uint8Array([0x30, 1, 2, 3]);
      expect(() => deserializeSignalingMessage(shortData)).toThrow('Signaling message too short');
    });

    it('should throw on unknown message type', () => {
      // Create a valid-length buffer with invalid type
      const buffer = new Uint8Array(9);
      buffer[0] = 0x99; // Invalid type
      const view = new DataView(buffer.buffer);
      view.setBigUint64(1, BigInt(Date.now()), false);

      expect(() => deserializeSignalingMessage(buffer)).toThrow('Unknown signaling message type');
    });
  });

  describe('Timestamp preservation', () => {
    it('should preserve timestamp through serialization', () => {
      const before = Date.now();
      const message = createUpgradeRequest();
      const after = Date.now();

      const serialized = serializeSignalingMessage(message);
      const deserialized = deserializeSignalingMessage(serialized);

      expect(deserialized.timestamp).toBeGreaterThanOrEqual(before);
      expect(deserialized.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('Round-trip consistency', () => {
    it('should maintain data integrity through multiple round-trips', () => {
      const sdp = 'v=0\r\no=- 1234567890 2 IN IP4 127.0.0.1\r\n';
      let message = createOffer(sdp);

      // Serialize and deserialize multiple times
      for (let i = 0; i < 5; i++) {
        const serialized = serializeSignalingMessage(message);
        message = deserializeSignalingMessage(serialized) as typeof message;
      }

      expect(message.type).toBe(SignalingMessageType.OFFER);
      expect(message.sdp).toBe(sdp);
    });
  });
});
