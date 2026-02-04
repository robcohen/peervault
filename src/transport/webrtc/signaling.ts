/**
 * WebRTC Signaling
 *
 * Serialization/deserialization of WebRTC signaling messages.
 * These messages are exchanged over Iroh to establish WebRTC connections.
 *
 * All signaling messages are prefixed with a 4-byte magic number "PVWS"
 * (PeerVault WebRTC Signaling) to enable instant stream type detection.
 */

import {
  SignalingMessageType,
  type SignalingMessage,
  type UpgradeRequestMessage,
  type UpgradeAcceptMessage,
  type UpgradeRejectMessage,
  type OfferMessage,
  type AnswerMessage,
  type IceCandidateMessage,
  type ReadyMessage,
} from "./types";

/**
 * Magic number prefix for WebRTC signaling messages.
 * "PVWS" = PeerVault WebRTC Signaling
 * This enables instant stream type detection without timing dependencies.
 */
export const SIGNALING_MAGIC = new Uint8Array([0x50, 0x56, 0x57, 0x53]); // "PVWS"
export const SIGNALING_MAGIC_LENGTH = 4;

/**
 * Check if data starts with the signaling magic prefix.
 * This enables instant stream type detection.
 */
export function hasSignalingMagic(data: Uint8Array): boolean {
  if (data.length < SIGNALING_MAGIC_LENGTH) {
    return false;
  }
  return (
    data[0] === SIGNALING_MAGIC[0] &&
    data[1] === SIGNALING_MAGIC[1] &&
    data[2] === SIGNALING_MAGIC[2] &&
    data[3] === SIGNALING_MAGIC[3]
  );
}

/**
 * Serialize a signaling message to binary format.
 *
 * Format:
 * - 4 bytes: magic "PVWS"
 * - 1 byte: message type
 * - 8 bytes: timestamp (big-endian)
 * - remaining: message-specific payload
 */
export function serializeSignalingMessage(message: SignalingMessage): Uint8Array {
  const encoder = new TextEncoder();
  const magicLen = SIGNALING_MAGIC_LENGTH;

  switch (message.type) {
    case SignalingMessageType.UPGRADE_REQUEST:
    case SignalingMessageType.UPGRADE_ACCEPT:
    case SignalingMessageType.READY: {
      // No payload
      const buffer = new Uint8Array(magicLen + 9);
      buffer.set(SIGNALING_MAGIC, 0);
      buffer[magicLen] = message.type;
      writeTimestamp(buffer, magicLen + 1, message.timestamp);
      return buffer;
    }

    case SignalingMessageType.UPGRADE_REJECT: {
      const msg = message as UpgradeRejectMessage;
      const reasonBytes = encoder.encode(msg.reason);
      const buffer = new Uint8Array(magicLen + 9 + 4 + reasonBytes.length);
      buffer.set(SIGNALING_MAGIC, 0);
      buffer[magicLen] = message.type;
      writeTimestamp(buffer, magicLen + 1, message.timestamp);
      writeUint32(buffer, magicLen + 9, reasonBytes.length);
      buffer.set(reasonBytes, magicLen + 13);
      return buffer;
    }

    case SignalingMessageType.OFFER:
    case SignalingMessageType.ANSWER: {
      const msg = message as OfferMessage | AnswerMessage;
      const sdpBytes = encoder.encode(msg.sdp);
      const buffer = new Uint8Array(magicLen + 9 + 4 + sdpBytes.length);
      buffer.set(SIGNALING_MAGIC, 0);
      buffer[magicLen] = message.type;
      writeTimestamp(buffer, magicLen + 1, message.timestamp);
      writeUint32(buffer, magicLen + 9, sdpBytes.length);
      buffer.set(sdpBytes, magicLen + 13);
      return buffer;
    }

    case SignalingMessageType.ICE_CANDIDATE: {
      const msg = message as IceCandidateMessage;
      const candidateBytes = encoder.encode(msg.candidate);
      const sdpMidBytes = msg.sdpMid ? encoder.encode(msg.sdpMid) : new Uint8Array(0);
      const sdpMLineIndex = msg.sdpMLineIndex ?? -1;

      // Format: magic + type + timestamp + candidateLen + candidate + sdpMidLen + sdpMid + sdpMLineIndex
      const buffer = new Uint8Array(
        magicLen + 9 + 4 + candidateBytes.length + 4 + sdpMidBytes.length + 4,
      );

      let offset = 0;
      buffer.set(SIGNALING_MAGIC, offset);
      offset += magicLen;
      buffer[offset++] = message.type;
      writeTimestamp(buffer, offset, message.timestamp);
      offset += 8;

      writeUint32(buffer, offset, candidateBytes.length);
      offset += 4;
      buffer.set(candidateBytes, offset);
      offset += candidateBytes.length;

      writeUint32(buffer, offset, sdpMidBytes.length);
      offset += 4;
      buffer.set(sdpMidBytes, offset);
      offset += sdpMidBytes.length;

      writeInt32(buffer, offset, sdpMLineIndex);
      return buffer;
    }

    default:
      throw new Error(`Unknown signaling message type: ${(message as SignalingMessage).type}`);
  }
}

/**
 * Deserialize a signaling message from binary format.
 * Expects the magic prefix to be present.
 */
export function deserializeSignalingMessage(data: Uint8Array): SignalingMessage {
  const decoder = new TextDecoder();
  const magicLen = SIGNALING_MAGIC_LENGTH;

  // Minimum: magic (4) + type (1) + timestamp (8) = 13 bytes
  if (data.length < magicLen + 9) {
    throw new Error("Signaling message too short");
  }

  // Verify magic prefix
  if (!hasSignalingMagic(data)) {
    throw new Error("Invalid signaling message: missing magic prefix");
  }

  // Skip magic prefix for parsing
  const type = data[magicLen] as SignalingMessageType;
  const timestamp = readTimestamp(data, magicLen + 1);

  switch (type) {
    case SignalingMessageType.UPGRADE_REQUEST:
      return { type, timestamp } as UpgradeRequestMessage;

    case SignalingMessageType.UPGRADE_ACCEPT:
      return { type, timestamp } as UpgradeAcceptMessage;

    case SignalingMessageType.READY:
      return { type, timestamp } as ReadyMessage;

    case SignalingMessageType.UPGRADE_REJECT: {
      const reasonLength = readUint32(data, magicLen + 9);
      const reason = decoder.decode(data.slice(magicLen + 13, magicLen + 13 + reasonLength));
      return { type, timestamp, reason } as UpgradeRejectMessage;
    }

    case SignalingMessageType.OFFER: {
      const sdpLength = readUint32(data, magicLen + 9);
      const sdp = decoder.decode(data.slice(magicLen + 13, magicLen + 13 + sdpLength));
      return { type, timestamp, sdp } as OfferMessage;
    }

    case SignalingMessageType.ANSWER: {
      const sdpLength = readUint32(data, magicLen + 9);
      const sdp = decoder.decode(data.slice(magicLen + 13, magicLen + 13 + sdpLength));
      return { type, timestamp, sdp } as AnswerMessage;
    }

    case SignalingMessageType.ICE_CANDIDATE: {
      let offset = magicLen + 9;

      const candidateLength = readUint32(data, offset);
      offset += 4;
      const candidate = decoder.decode(data.slice(offset, offset + candidateLength));
      offset += candidateLength;

      const sdpMidLength = readUint32(data, offset);
      offset += 4;
      const sdpMid =
        sdpMidLength > 0
          ? decoder.decode(data.slice(offset, offset + sdpMidLength))
          : null;
      offset += sdpMidLength;

      const sdpMLineIndex = readInt32(data, offset);

      return {
        type,
        timestamp,
        candidate,
        sdpMid,
        sdpMLineIndex: sdpMLineIndex >= 0 ? sdpMLineIndex : null,
      } as IceCandidateMessage;
    }

    default:
      throw new Error(`Unknown signaling message type: ${type}`);
  }
}

/**
 * Create an upgrade request message.
 */
export function createUpgradeRequest(): UpgradeRequestMessage {
  return {
    type: SignalingMessageType.UPGRADE_REQUEST,
    timestamp: Date.now(),
  };
}

/**
 * Create an upgrade accept message.
 */
export function createUpgradeAccept(): UpgradeAcceptMessage {
  return {
    type: SignalingMessageType.UPGRADE_ACCEPT,
    timestamp: Date.now(),
  };
}

/**
 * Create an upgrade reject message.
 */
export function createUpgradeReject(reason: string): UpgradeRejectMessage {
  return {
    type: SignalingMessageType.UPGRADE_REJECT,
    timestamp: Date.now(),
    reason,
  };
}

/**
 * Create an SDP offer message.
 */
export function createOffer(sdp: string): OfferMessage {
  return {
    type: SignalingMessageType.OFFER,
    timestamp: Date.now(),
    sdp,
  };
}

/**
 * Create an SDP answer message.
 */
export function createAnswer(sdp: string): AnswerMessage {
  return {
    type: SignalingMessageType.ANSWER,
    timestamp: Date.now(),
    sdp,
  };
}

/**
 * Create an ICE candidate message.
 */
export function createIceCandidate(
  candidate: RTCIceCandidate,
): IceCandidateMessage {
  return {
    type: SignalingMessageType.ICE_CANDIDATE,
    timestamp: Date.now(),
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
  };
}

/**
 * Create a ready message.
 */
export function createReady(): ReadyMessage {
  return {
    type: SignalingMessageType.READY,
    timestamp: Date.now(),
  };
}

/**
 * Check if a message type is a signaling message.
 */
export function isSignalingMessageType(type: number): boolean {
  return type >= 0x30 && type <= 0x36;
}

// Helper functions for binary encoding/decoding

function writeTimestamp(buffer: Uint8Array, offset: number, timestamp: number): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  view.setBigUint64(offset, BigInt(timestamp), false);
}

function readTimestamp(buffer: Uint8Array, offset: number): number {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  return Number(view.getBigUint64(offset, false));
}

function writeUint32(buffer: Uint8Array, offset: number, value: number): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  view.setUint32(offset, value, false);
}

function readUint32(buffer: Uint8Array, offset: number): number {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  return view.getUint32(offset, false);
}

function writeInt32(buffer: Uint8Array, offset: number, value: number): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  view.setInt32(offset, value, false);
}

function readInt32(buffer: Uint8Array, offset: number): number {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  return view.getInt32(offset, false);
}
