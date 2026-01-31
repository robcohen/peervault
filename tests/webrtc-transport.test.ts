/**
 * WebRTC Transport Tests
 *
 * Tests for WebRTC transport components.
 * Note: Some tests require a browser-like environment with WebRTC support.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { TransportLogger } from '../src/transport/types';
import {
  DEFAULT_WEBRTC_CONFIG,
  DEFAULT_STREAM_CONFIG,
  WEBRTC_CONSTANTS,
  SignalingMessageType,
  type WebRTCConfig,
  type WebRTCSupport,
} from '../src/transport/webrtc/types';

// Check if we're in a browser-like environment with WebRTC
const hasWebRTC = typeof globalThis.RTCPeerConnection !== 'undefined';

// Mock logger for tests
const mockLogger: TransportLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('WebRTC Types', () => {
  describe('DEFAULT_WEBRTC_CONFIG', () => {
    it('should have empty iceServers for LAN-only mode', () => {
      expect(DEFAULT_WEBRTC_CONFIG.iceServers).toEqual([]);
    });

    it('should have reasonable timeout values', () => {
      expect(DEFAULT_WEBRTC_CONFIG.iceGatheringTimeout).toBe(5000);
      expect(DEFAULT_WEBRTC_CONFIG.connectionTimeout).toBe(10000);
      expect(DEFAULT_WEBRTC_CONFIG.signalingTimeout).toBe(5000);
    });

    it('should have 1MB max buffered amount', () => {
      expect(DEFAULT_WEBRTC_CONFIG.maxBufferedAmount).toBe(1024 * 1024);
    });
  });

  describe('DEFAULT_STREAM_CONFIG', () => {
    it('should be ordered (reliable)', () => {
      expect(DEFAULT_STREAM_CONFIG.ordered).toBe(true);
    });

    it('should have no maxRetransmits (fully reliable)', () => {
      expect(DEFAULT_STREAM_CONFIG.maxRetransmits).toBeNull();
    });

    it('should use peervault-sync protocol', () => {
      expect(DEFAULT_STREAM_CONFIG.protocol).toBe('peervault-sync');
    });
  });

  describe('WEBRTC_CONSTANTS', () => {
    it('should have correct channel labels', () => {
      expect(WEBRTC_CONSTANTS.MAIN_CHANNEL_LABEL).toBe('peervault-main');
      expect(WEBRTC_CONSTANTS.STREAM_CHANNEL_PREFIX).toBe('stream-');
      expect(WEBRTC_CONSTANTS.SIGNALING_CHANNEL_LABEL).toBe('signaling');
    });

    it('should have reasonable backpressure settings', () => {
      expect(WEBRTC_CONSTANTS.BACKPRESSURE_CHECK_INTERVAL).toBe(10);
      expect(WEBRTC_CONSTANTS.BACKPRESSURE_TIMEOUT).toBe(30000);
    });
  });

  describe('SignalingMessageType', () => {
    it('should have correct message type values in 0x30 range', () => {
      expect(SignalingMessageType.UPGRADE_REQUEST).toBe(0x30);
      expect(SignalingMessageType.UPGRADE_ACCEPT).toBe(0x31);
      expect(SignalingMessageType.UPGRADE_REJECT).toBe(0x32);
      expect(SignalingMessageType.OFFER).toBe(0x33);
      expect(SignalingMessageType.ANSWER).toBe(0x34);
      expect(SignalingMessageType.ICE_CANDIDATE).toBe(0x35);
      expect(SignalingMessageType.READY).toBe(0x36);
    });

    it('should not overlap with sync message types', () => {
      // Sync message types are in 0x01-0x20 range
      const signalingTypes = [
        SignalingMessageType.UPGRADE_REQUEST,
        SignalingMessageType.UPGRADE_ACCEPT,
        SignalingMessageType.UPGRADE_REJECT,
        SignalingMessageType.OFFER,
        SignalingMessageType.ANSWER,
        SignalingMessageType.ICE_CANDIDATE,
        SignalingMessageType.READY,
      ];

      for (const type of signalingTypes) {
        expect(type).toBeGreaterThanOrEqual(0x30);
        expect(type).toBeLessThanOrEqual(0x3f);
      }
    });
  });
});

describe('WebRTC Feature Detection', () => {
  describe('isWebRTCAvailable', () => {
    it('should return a boolean', async () => {
      const { isWebRTCAvailable } = await import('../src/transport/webrtc');
      const result = isWebRTCAvailable();
      expect(typeof result).toBe('boolean');
    });

    it('should match RTCPeerConnection availability', async () => {
      const { isWebRTCAvailable } = await import('../src/transport/webrtc');
      const expected = typeof globalThis.RTCPeerConnection !== 'undefined';
      expect(isWebRTCAvailable()).toBe(expected);
    });
  });

  describe.skipIf(!hasWebRTC)('testWebRTCSupport (browser only)', () => {
    it('should return WebRTCSupport object', async () => {
      const { testWebRTCSupport } = await import('../src/transport/webrtc');
      const support = await testWebRTCSupport(false);

      expect(support).toHaveProperty('available');
      expect(support).toHaveProperty('hasPeerConnection');
      expect(support).toHaveProperty('hasDataChannel');
    });

    it('should detect WebRTC availability', async () => {
      const { testWebRTCSupport } = await import('../src/transport/webrtc');
      const support = await testWebRTCSupport(false);

      expect(support.available).toBe(true);
      expect(support.hasPeerConnection).toBe(true);
      expect(support.hasDataChannel).toBe(true);
    });
  });

  describe.skipIf(!hasWebRTC)('gatherCandidateTypes (browser only)', () => {
    it('should return an array of candidate types', async () => {
      const { gatherCandidateTypes } = await import('../src/transport/webrtc');
      const types = await gatherCandidateTypes();

      expect(Array.isArray(types)).toBe(true);
    });

    it('should timeout after 3 seconds', async () => {
      const { gatherCandidateTypes } = await import('../src/transport/webrtc');
      const start = Date.now();
      await gatherCandidateTypes();
      const elapsed = Date.now() - start;

      // Should complete within timeout (3000ms) + some buffer
      expect(elapsed).toBeLessThan(4000);
    });
  });
});

describe('WebRTC Stream', () => {
  // These tests would require a mock DataChannel
  // In a browser environment, we could create real DataChannels

  describe('Message framing', () => {
    it('should use 4-byte big-endian length prefix', () => {
      // Test the framing format: [4-byte length][message]
      const messageLength = 100;
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      view.setUint32(0, messageLength, false); // big-endian

      const bytes = new Uint8Array(buffer);
      expect(bytes[0]).toBe(0);
      expect(bytes[1]).toBe(0);
      expect(bytes[2]).toBe(0);
      expect(bytes[3]).toBe(100);
    });

    it('should handle large message lengths', () => {
      const messageLength = 1024 * 1024; // 1MB
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      view.setUint32(0, messageLength, false);

      // Read it back
      const readLength = view.getUint32(0, false);
      expect(readLength).toBe(messageLength);
    });
  });
});

describe('WebRTC Connection', () => {
  describe.skipIf(!hasWebRTC)('RTCPeerConnection wrapper (browser only)', () => {
    it('should be able to create RTCPeerConnection with empty iceServers', () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      expect(pc).toBeDefined();
      expect(pc.connectionState).toBe('new');
      pc.close();
    });

    it('should be able to create DataChannel', () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      const channel = pc.createDataChannel('test');

      expect(channel).toBeDefined();
      expect(channel.label).toBe('test');

      channel.close();
      pc.close();
    });

    it('should support ordered DataChannels', () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      const channel = pc.createDataChannel('test', {
        ordered: true,
        protocol: 'peervault-sync',
      });

      expect(channel.ordered).toBe(true);
      expect(channel.protocol).toBe('peervault-sync');

      channel.close();
      pc.close();
    });
  });
});

describe('Hybrid Transport', () => {
  describe('HybridTransport exports', () => {
    it('should export HybridTransport class', async () => {
      const { HybridTransport } = await import('../src/transport');
      expect(HybridTransport).toBeDefined();
      expect(typeof HybridTransport).toBe('function');
    });

    it('should export HybridConnection class', async () => {
      const { HybridConnection } = await import('../src/transport');
      expect(HybridConnection).toBeDefined();
      expect(typeof HybridConnection).toBe('function');
    });
  });
});

describe('WebRTC Errors', () => {
  it('should export WebRTCErrors', async () => {
    const { WebRTCErrors } = await import('../src/errors');
    expect(WebRTCErrors).toBeDefined();
  });

  it('should have all expected error factories', async () => {
    const { WebRTCErrors } = await import('../src/errors');

    expect(typeof WebRTCErrors.notAvailable).toBe('function');
    expect(typeof WebRTCErrors.upgradeRejected).toBe('function');
    expect(typeof WebRTCErrors.upgradeTimeout).toBe('function');
    expect(typeof WebRTCErrors.signalingFailed).toBe('function');
    expect(typeof WebRTCErrors.connectionFailed).toBe('function');
    expect(typeof WebRTCErrors.dataChannelError).toBe('function');
  });

  it('should create proper error objects', async () => {
    const { WebRTCErrors } = await import('../src/errors');

    const error = WebRTCErrors.upgradeRejected('peer123', 'not supported');
    expect(error.message).toContain('peer123');
    expect(error.message).toContain('not supported');
    expect(error.code).toBe('WEBRTC_UPGRADE_REJECTED');
  });
});
