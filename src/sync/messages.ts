/**
 * Sync Message Serialization
 *
 * Encodes and decodes sync protocol messages for network transmission.
 */

import {
  SyncMessageType,
  SyncErrorCode,
  type AnySyncMessage,
  type VersionInfoMessage,
  type SnapshotRequestMessage,
  type SnapshotMessage,
  type SnapshotChunkMessage,
  type UpdatesMessage,
  type SyncCompleteMessage,
  type PingMessage,
  type PongMessage,
  type ErrorMessage,
  type BlobHashesMessage,
  type BlobRequestMessage,
  type BlobDataMessage,
  type BlobSyncCompleteMessage,
  type PeerRemovedMessage,
} from "./types";
import { SyncErrors } from "../errors";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Helper for building binary messages incrementally.
 */
class MessageWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(size: number) {
    this.buffer = new ArrayBuffer(size);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  /** Write message header (type + timestamp) */
  writeHeader(type: SyncMessageType, timestamp: number): this {
    this.view.setUint8(this.offset++, type);
    this.view.setBigUint64(this.offset, BigInt(timestamp), false);
    this.offset += 8;
    return this;
  }

  writeU8(value: number): this {
    this.view.setUint8(this.offset++, value);
    return this;
  }

  writeU16(value: number): this {
    this.view.setUint16(this.offset, value, false);
    this.offset += 2;
    return this;
  }

  writeU32(value: number): this {
    this.view.setUint32(this.offset, value, false);
    this.offset += 4;
    return this;
  }

  /** Write length-prefixed bytes (u32 length + data) */
  writeBytes(data: Uint8Array): this {
    this.view.setUint32(this.offset, data.length, false);
    this.offset += 4;
    this.bytes.set(data, this.offset);
    this.offset += data.length;
    return this;
  }

  /** Write length-prefixed string (u32 length + UTF-8) */
  writeString(str: string): this {
    const encoded = TEXT_ENCODER.encode(str);
    return this.writeBytes(encoded);
  }

  /** Write short string (u16 length + UTF-8) */
  writeShortString(str: string): this {
    const encoded = TEXT_ENCODER.encode(str);
    this.view.setUint16(this.offset, encoded.length, false);
    this.offset += 2;
    this.bytes.set(encoded, this.offset);
    this.offset += encoded.length;
    return this;
  }

  /** Write optional short string (u16 length, 0 if null) */
  writeOptionalShortString(str: string | undefined): this {
    if (str) {
      return this.writeShortString(str);
    }
    this.view.setUint16(this.offset, 0, false);
    this.offset += 2;
    return this;
  }

  /** Write raw bytes without length prefix */
  writeRaw(data: Uint8Array): this {
    this.bytes.set(data, this.offset);
    this.offset += data.length;
    return this;
  }

  finish(): Uint8Array {
    return this.bytes;
  }
}

/**
 * Helper for reading binary messages.
 */
class MessageReader {
  private view: DataView;
  private offset = 9; // Skip header (type + timestamp already parsed)

  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  readU8(): number {
    return this.view.getUint8(this.offset++);
  }

  readU16(): number {
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  readU32(): number {
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  /** Read length-prefixed bytes (u32 length + data) */
  readBytes(): Uint8Array {
    const len = this.readU32();
    const bytes = this.data.slice(this.offset, this.offset + len);
    this.offset += len;
    return bytes;
  }

  /** Read length-prefixed string (u32 length + UTF-8) */
  readString(): string {
    return TEXT_DECODER.decode(this.readBytes());
  }

  /** Read short string (u16 length + UTF-8) */
  readShortString(): string {
    const len = this.readU16();
    const str = TEXT_DECODER.decode(this.data.slice(this.offset, this.offset + len));
    this.offset += len;
    return str;
  }

  /** Read optional short string (returns undefined if length is 0) */
  readOptionalShortString(): string | undefined {
    const len = this.readU16();
    if (len === 0) return undefined;
    const str = TEXT_DECODER.decode(this.data.slice(this.offset, this.offset + len));
    this.offset += len;
    return str;
  }

  /** Read remaining bytes */
  readRemaining(): Uint8Array {
    return this.data.slice(this.offset);
  }
}

/** Calculate serialized size of a string (4-byte length + UTF-8 bytes) */
function stringSize(str: string): number {
  return 4 + TEXT_ENCODER.encode(str).length;
}

/** Calculate serialized size of a short string (2-byte length + UTF-8 bytes) */
function shortStringSize(str: string): number {
  return 2 + TEXT_ENCODER.encode(str).length;
}

/** Calculate serialized size of optional short string */
function optionalShortStringSize(str: string | undefined): number {
  return str ? shortStringSize(str) : 2;
}

/**
 * Serialize a sync message to bytes.
 */
export function serializeMessage(message: AnySyncMessage): Uint8Array {
  switch (message.type) {
    case SyncMessageType.VERSION_INFO:
      return serializeVersionInfo(message);
    case SyncMessageType.SNAPSHOT_REQUEST:
      return serializeSnapshotRequest(message);
    case SyncMessageType.SNAPSHOT:
      return serializeSnapshot(message);
    case SyncMessageType.SNAPSHOT_CHUNK:
      return serializeSnapshotChunk(message);
    case SyncMessageType.UPDATES:
      return serializeUpdates(message);
    case SyncMessageType.SYNC_COMPLETE:
      return serializeSyncComplete(message);
    case SyncMessageType.PING:
      return serializePing(message);
    case SyncMessageType.PONG:
      return serializePong(message);
    case SyncMessageType.ERROR:
      return serializeError(message);
    case SyncMessageType.BLOB_HASHES:
      return serializeBlobHashes(message);
    case SyncMessageType.BLOB_REQUEST:
      return serializeBlobRequest(message);
    case SyncMessageType.BLOB_DATA:
      return serializeBlobData(message);
    case SyncMessageType.BLOB_SYNC_COMPLETE:
      return serializeBlobSyncComplete(message);
    case SyncMessageType.PEER_REMOVED:
      return serializePeerRemoved(message);
    default:
      throw SyncErrors.invalidMessage(
        (message as AnySyncMessage).type,
      );
  }
}

/**
 * Deserialize bytes to a sync message.
 */
export function deserializeMessage(data: Uint8Array): AnySyncMessage {
  if (data.length < 9) {
    throw SyncErrors.protocolError("Message too short");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0) as SyncMessageType;
  const timestamp = Number(view.getBigUint64(1, false));

  switch (type) {
    case SyncMessageType.VERSION_INFO:
      return deserializeVersionInfo(data, timestamp);
    case SyncMessageType.SNAPSHOT_REQUEST:
      return deserializeSnapshotRequest(timestamp);
    case SyncMessageType.SNAPSHOT:
      return deserializeSnapshot(data, timestamp);
    case SyncMessageType.SNAPSHOT_CHUNK:
      return deserializeSnapshotChunk(data, timestamp);
    case SyncMessageType.UPDATES:
      return deserializeUpdates(data, timestamp);
    case SyncMessageType.SYNC_COMPLETE:
      return deserializeSyncComplete(data, timestamp);
    case SyncMessageType.PING:
      return deserializePing(data, timestamp);
    case SyncMessageType.PONG:
      return deserializePong(data, timestamp);
    case SyncMessageType.ERROR:
      return deserializeError(data, timestamp);
    case SyncMessageType.BLOB_HASHES:
      return deserializeBlobHashes(data, timestamp);
    case SyncMessageType.BLOB_REQUEST:
      return deserializeBlobRequest(data, timestamp);
    case SyncMessageType.BLOB_DATA:
      return deserializeBlobData(data, timestamp);
    case SyncMessageType.BLOB_SYNC_COMPLETE:
      return deserializeBlobSyncComplete(data, timestamp);
    case SyncMessageType.PEER_REMOVED:
      return deserializePeerRemoved(data, timestamp);
    default:
      throw SyncErrors.invalidMessage(type);
  }
}

// ============================================================================
// VERSION_INFO
// ============================================================================

/**
 * VERSION_INFO format:
 * - u8: type (0x01)
 * - u64: timestamp
 * - u32: vaultId length
 * - bytes: vaultId (UTF-8)
 * - u32: versionBytes length
 * - bytes: versionBytes
 * - u32: ticket length
 * - bytes: ticket (UTF-8)
 * - u16: hostname length
 * - bytes: hostname (UTF-8)
 * - u16: nickname length (0 if none)
 * - bytes: nickname (UTF-8, optional)
 */
function serializeVersionInfo(msg: VersionInfoMessage): Uint8Array {
  const vaultIdBytes = TEXT_ENCODER.encode(msg.vaultId);
  const ticketBytes = TEXT_ENCODER.encode(msg.ticket);
  const hostnameBytes = TEXT_ENCODER.encode(msg.hostname);
  const nicknameBytes = msg.nickname ? TEXT_ENCODER.encode(msg.nickname) : null;
  const totalLength =
    1 +
    8 +
    4 + vaultIdBytes.length +
    4 + msg.versionBytes.length +
    4 + ticketBytes.length +
    2 + hostnameBytes.length +
    2 + (nicknameBytes?.length || 0);

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint32(offset, vaultIdBytes.length, false);
  offset += 4;
  bytes.set(vaultIdBytes, offset);
  offset += vaultIdBytes.length;

  view.setUint32(offset, msg.versionBytes.length, false);
  offset += 4;
  bytes.set(msg.versionBytes, offset);
  offset += msg.versionBytes.length;

  view.setUint32(offset, ticketBytes.length, false);
  offset += 4;
  bytes.set(ticketBytes, offset);
  offset += ticketBytes.length;

  view.setUint16(offset, hostnameBytes.length, false);
  offset += 2;
  bytes.set(hostnameBytes, offset);
  offset += hostnameBytes.length;

  view.setUint16(offset, nicknameBytes?.length || 0, false);
  offset += 2;
  if (nicknameBytes) {
    bytes.set(nicknameBytes, offset);
  }

  return bytes;
}

function deserializeVersionInfo(
  data: Uint8Array,
  timestamp: number,
): VersionInfoMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9; // Skip type and timestamp

  const vaultIdLen = view.getUint32(offset, false);
  offset += 4;
  const vaultId = TEXT_DECODER.decode(data.slice(offset, offset + vaultIdLen));
  offset += vaultIdLen;

  const versionBytesLen = view.getUint32(offset, false);
  offset += 4;
  const versionBytes = data.slice(offset, offset + versionBytesLen);
  offset += versionBytesLen;

  const ticketLen = view.getUint32(offset, false);
  offset += 4;
  const ticket = TEXT_DECODER.decode(data.slice(offset, offset + ticketLen));
  offset += ticketLen;

  const hostnameLen = view.getUint16(offset, false);
  offset += 2;
  const hostname = TEXT_DECODER.decode(data.slice(offset, offset + hostnameLen));
  offset += hostnameLen;

  const nicknameLen = view.getUint16(offset, false);
  offset += 2;
  const nickname = nicknameLen > 0
    ? TEXT_DECODER.decode(data.slice(offset, offset + nicknameLen))
    : undefined;

  return {
    type: SyncMessageType.VERSION_INFO,
    timestamp,
    vaultId,
    versionBytes,
    ticket,
    hostname,
    nickname,
  };
}

// ============================================================================
// SNAPSHOT_REQUEST
// ============================================================================

/**
 * SNAPSHOT_REQUEST format:
 * - u8: type (0x03)
 * - u64: timestamp
 */
function serializeSnapshotRequest(msg: SnapshotRequestMessage): Uint8Array {
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);

  view.setUint8(0, msg.type);
  view.setBigUint64(1, BigInt(msg.timestamp), false);

  return new Uint8Array(buffer);
}

function deserializeSnapshotRequest(timestamp: number): SnapshotRequestMessage {
  return {
    type: SyncMessageType.SNAPSHOT_REQUEST,
    timestamp,
  };
}

// ============================================================================
// SNAPSHOT
// ============================================================================

/**
 * SNAPSHOT format:
 * - u8: type (0x04)
 * - u64: timestamp
 * - u32: totalSize
 * - u32: snapshot length
 * - bytes: snapshot
 */
function serializeSnapshot(msg: SnapshotMessage): Uint8Array {
  const totalLength = 1 + 8 + 4 + 4 + msg.snapshot.length;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint32(offset, msg.totalSize, false);
  offset += 4;

  view.setUint32(offset, msg.snapshot.length, false);
  offset += 4;
  bytes.set(msg.snapshot, offset);

  return bytes;
}

function deserializeSnapshot(
  data: Uint8Array,
  timestamp: number,
): SnapshotMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9;

  const totalSize = view.getUint32(offset, false);
  offset += 4;

  const snapshotLen = view.getUint32(offset, false);
  offset += 4;
  const snapshot = data.slice(offset, offset + snapshotLen);

  return {
    type: SyncMessageType.SNAPSHOT,
    timestamp,
    snapshot,
    totalSize,
  };
}

// ============================================================================
// SNAPSHOT_CHUNK
// ============================================================================

/**
 * SNAPSHOT_CHUNK format:
 * - u8: type (0x05)
 * - u64: timestamp
 * - u32: chunkIndex
 * - u32: totalChunks
 * - u32: data length
 * - bytes: data
 */
function serializeSnapshotChunk(msg: SnapshotChunkMessage): Uint8Array {
  const totalLength = 1 + 8 + 4 + 4 + 4 + msg.data.length;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint32(offset, msg.chunkIndex, false);
  offset += 4;

  view.setUint32(offset, msg.totalChunks, false);
  offset += 4;

  view.setUint32(offset, msg.data.length, false);
  offset += 4;
  bytes.set(msg.data, offset);

  return bytes;
}

function deserializeSnapshotChunk(
  data: Uint8Array,
  timestamp: number,
): SnapshotChunkMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9;

  const chunkIndex = view.getUint32(offset, false);
  offset += 4;

  const totalChunks = view.getUint32(offset, false);
  offset += 4;

  const dataLen = view.getUint32(offset, false);
  offset += 4;
  const chunkData = data.slice(offset, offset + dataLen);

  return {
    type: SyncMessageType.SNAPSHOT_CHUNK,
    timestamp,
    chunkIndex,
    totalChunks,
    data: chunkData,
  };
}

// ============================================================================
// UPDATES
// ============================================================================

/**
 * UPDATES format:
 * - u8: type (0x02)
 * - u64: timestamp
 * - u32: opCount
 * - u32: updates length
 * - bytes: updates
 */
function serializeUpdates(msg: UpdatesMessage): Uint8Array {
  const totalLength = 1 + 8 + 4 + 4 + msg.updates.length;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint32(offset, msg.opCount, false);
  offset += 4;

  view.setUint32(offset, msg.updates.length, false);
  offset += 4;
  bytes.set(msg.updates, offset);

  return bytes;
}

function deserializeUpdates(
  data: Uint8Array,
  timestamp: number,
): UpdatesMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9;

  const opCount = view.getUint32(offset, false);
  offset += 4;

  const updatesLen = view.getUint32(offset, false);
  offset += 4;
  const updates = data.slice(offset, offset + updatesLen);

  return {
    type: SyncMessageType.UPDATES,
    timestamp,
    opCount,
    updates,
  };
}

// ============================================================================
// SYNC_COMPLETE
// ============================================================================

/**
 * SYNC_COMPLETE format:
 * - u8: type (0x06)
 * - u64: timestamp
 * - u32: versionBytes length
 * - bytes: versionBytes
 */
function serializeSyncComplete(msg: SyncCompleteMessage): Uint8Array {
  const totalLength = 1 + 8 + 4 + msg.versionBytes.length;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint32(offset, msg.versionBytes.length, false);
  offset += 4;
  bytes.set(msg.versionBytes, offset);

  return bytes;
}

function deserializeSyncComplete(
  data: Uint8Array,
  timestamp: number,
): SyncCompleteMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9;

  const versionBytesLen = view.getUint32(offset, false);
  offset += 4;
  const versionBytes = data.slice(offset, offset + versionBytesLen);

  return {
    type: SyncMessageType.SYNC_COMPLETE,
    timestamp,
    versionBytes,
  };
}

// ============================================================================
// PING/PONG
// ============================================================================

/**
 * PING/PONG format:
 * - u8: type (0x08 or 0x09)
 * - u64: timestamp
 * - u32: seq
 */
function serializePing(msg: PingMessage): Uint8Array {
  const buffer = new ArrayBuffer(13);
  const view = new DataView(buffer);

  view.setUint8(0, msg.type);
  view.setBigUint64(1, BigInt(msg.timestamp), false);
  view.setUint32(9, msg.seq, false);

  return new Uint8Array(buffer);
}

function deserializePing(data: Uint8Array, timestamp: number): PingMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    type: SyncMessageType.PING,
    timestamp,
    seq: view.getUint32(9, false),
  };
}

function serializePong(msg: PongMessage): Uint8Array {
  const buffer = new ArrayBuffer(13);
  const view = new DataView(buffer);

  view.setUint8(0, msg.type);
  view.setBigUint64(1, BigInt(msg.timestamp), false);
  view.setUint32(9, msg.seq, false);

  return new Uint8Array(buffer);
}

function deserializePong(data: Uint8Array, timestamp: number): PongMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    type: SyncMessageType.PONG,
    timestamp,
    seq: view.getUint32(9, false),
  };
}

// ============================================================================
// ERROR
// ============================================================================

/**
 * ERROR format:
 * - u8: type (0x07)
 * - u64: timestamp
 * - u8: error code
 * - u32: message length
 * - bytes: message (UTF-8)
 */
function serializeError(msg: ErrorMessage): Uint8Array {
  const messageBytes = TEXT_ENCODER.encode(msg.message);
  const totalLength = 1 + 8 + 1 + 4 + messageBytes.length;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint8(offset++, msg.code);

  view.setUint32(offset, messageBytes.length, false);
  offset += 4;
  bytes.set(messageBytes, offset);

  return bytes;
}

function deserializeError(data: Uint8Array, timestamp: number): ErrorMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9;

  const code = view.getUint8(offset++) as SyncErrorCode;

  const messageLen = view.getUint32(offset, false);
  offset += 4;
  const message = TEXT_DECODER.decode(data.slice(offset, offset + messageLen));

  return {
    type: SyncMessageType.ERROR,
    timestamp,
    code,
    message,
  };
}

// ============================================================================
// Message Creation Helpers
// ============================================================================

export function createVersionInfoMessage(
  vaultId: string,
  versionBytes: Uint8Array,
  ticket: string,
  hostname: string,
  nickname?: string,
): VersionInfoMessage {
  return {
    type: SyncMessageType.VERSION_INFO,
    timestamp: Date.now(),
    vaultId,
    versionBytes,
    ticket,
    hostname,
    nickname,
  };
}

export function createSnapshotRequestMessage(): SnapshotRequestMessage {
  return {
    type: SyncMessageType.SNAPSHOT_REQUEST,
    timestamp: Date.now(),
  };
}

export function createSnapshotMessage(
  snapshot: Uint8Array,
  totalSize?: number,
): SnapshotMessage {
  return {
    type: SyncMessageType.SNAPSHOT,
    timestamp: Date.now(),
    snapshot,
    totalSize: totalSize ?? snapshot.length,
  };
}

export function createSnapshotChunkMessage(
  chunkIndex: number,
  totalChunks: number,
  data: Uint8Array,
): SnapshotChunkMessage {
  return {
    type: SyncMessageType.SNAPSHOT_CHUNK,
    timestamp: Date.now(),
    chunkIndex,
    totalChunks,
    data,
  };
}

export function createUpdatesMessage(
  updates: Uint8Array,
  opCount: number,
): UpdatesMessage {
  return {
    type: SyncMessageType.UPDATES,
    timestamp: Date.now(),
    updates,
    opCount,
  };
}

export function createSyncCompleteMessage(
  versionBytes: Uint8Array,
): SyncCompleteMessage {
  return {
    type: SyncMessageType.SYNC_COMPLETE,
    timestamp: Date.now(),
    versionBytes,
  };
}

export function createPingMessage(seq: number): PingMessage {
  return {
    type: SyncMessageType.PING,
    timestamp: Date.now(),
    seq,
  };
}

export function createPongMessage(seq: number): PongMessage {
  return {
    type: SyncMessageType.PONG,
    timestamp: Date.now(),
    seq,
  };
}

export function createErrorMessage(
  code: SyncErrorCode,
  message: string,
): ErrorMessage {
  return {
    type: SyncMessageType.ERROR,
    timestamp: Date.now(),
    code,
    message,
  };
}

// ============================================================================
// BLOB_HASHES
// ============================================================================

/**
 * BLOB_HASHES format:
 * - u8: type (0x10)
 * - u64: timestamp
 * - u32: hash count
 * - for each hash:
 *   - u16: hash length
 *   - bytes: hash (UTF-8)
 */
function serializeBlobHashes(msg: BlobHashesMessage): Uint8Array {
  const hashBytes = msg.hashes.map((h) => TEXT_ENCODER.encode(h));
  const totalHashBytes = hashBytes.reduce((sum, b) => sum + 2 + b.length, 0);
  const totalLength = 1 + 8 + 4 + totalHashBytes;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint32(offset, msg.hashes.length, false);
  offset += 4;

  for (const hashB of hashBytes) {
    view.setUint16(offset, hashB.length, false);
    offset += 2;
    bytes.set(hashB, offset);
    offset += hashB.length;
  }

  return bytes;
}

function deserializeBlobHashes(
  data: Uint8Array,
  timestamp: number,
): BlobHashesMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9;

  const hashCount = view.getUint32(offset, false);
  offset += 4;

  const hashes: string[] = [];
  for (let i = 0; i < hashCount; i++) {
    const hashLen = view.getUint16(offset, false);
    offset += 2;
    const hash = TEXT_DECODER.decode(data.slice(offset, offset + hashLen));
    offset += hashLen;
    hashes.push(hash);
  }

  return {
    type: SyncMessageType.BLOB_HASHES,
    timestamp,
    hashes,
  };
}

// ============================================================================
// BLOB_REQUEST
// ============================================================================

/**
 * BLOB_REQUEST format:
 * - u8: type (0x11)
 * - u64: timestamp
 * - u32: hash count
 * - for each hash:
 *   - u16: hash length
 *   - bytes: hash (UTF-8)
 */
function serializeBlobRequest(msg: BlobRequestMessage): Uint8Array {
  const hashBytes = msg.hashes.map((h) => TEXT_ENCODER.encode(h));
  const totalHashBytes = hashBytes.reduce((sum, b) => sum + 2 + b.length, 0);
  const totalLength = 1 + 8 + 4 + totalHashBytes;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint32(offset, msg.hashes.length, false);
  offset += 4;

  for (const hashB of hashBytes) {
    view.setUint16(offset, hashB.length, false);
    offset += 2;
    bytes.set(hashB, offset);
    offset += hashB.length;
  }

  return bytes;
}

function deserializeBlobRequest(
  data: Uint8Array,
  timestamp: number,
): BlobRequestMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9;

  const hashCount = view.getUint32(offset, false);
  offset += 4;

  const hashes: string[] = [];
  for (let i = 0; i < hashCount; i++) {
    const hashLen = view.getUint16(offset, false);
    offset += 2;
    const hash = TEXT_DECODER.decode(data.slice(offset, offset + hashLen));
    offset += hashLen;
    hashes.push(hash);
  }

  return {
    type: SyncMessageType.BLOB_REQUEST,
    timestamp,
    hashes,
  };
}

// ============================================================================
// BLOB_DATA
// ============================================================================

/**
 * BLOB_DATA format:
 * - u8: type (0x12)
 * - u64: timestamp
 * - u16: hash length
 * - bytes: hash (UTF-8)
 * - u16: mimeType length (0 if none)
 * - bytes: mimeType (UTF-8)
 * - u32: data length
 * - bytes: data
 */
function serializeBlobData(msg: BlobDataMessage): Uint8Array {
  const hashBytes = TEXT_ENCODER.encode(msg.hash);
  const mimeTypeBytes = msg.mimeType
    ? TEXT_ENCODER.encode(msg.mimeType)
    : new Uint8Array(0);
  const totalLength =
    1 +
    8 +
    2 +
    hashBytes.length +
    2 +
    mimeTypeBytes.length +
    4 +
    msg.data.length;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint16(offset, hashBytes.length, false);
  offset += 2;
  bytes.set(hashBytes, offset);
  offset += hashBytes.length;

  view.setUint16(offset, mimeTypeBytes.length, false);
  offset += 2;
  if (mimeTypeBytes.length > 0) {
    bytes.set(mimeTypeBytes, offset);
    offset += mimeTypeBytes.length;
  }

  view.setUint32(offset, msg.data.length, false);
  offset += 4;
  bytes.set(msg.data, offset);

  return bytes;
}

function deserializeBlobData(
  data: Uint8Array,
  timestamp: number,
): BlobDataMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9;

  const hashLen = view.getUint16(offset, false);
  offset += 2;
  const hash = TEXT_DECODER.decode(data.slice(offset, offset + hashLen));
  offset += hashLen;

  const mimeTypeLen = view.getUint16(offset, false);
  offset += 2;
  const mimeType =
    mimeTypeLen > 0
      ? TEXT_DECODER.decode(data.slice(offset, offset + mimeTypeLen))
      : undefined;
  offset += mimeTypeLen;

  const dataLen = view.getUint32(offset, false);
  offset += 4;
  const blobData = data.slice(offset, offset + dataLen);

  return {
    type: SyncMessageType.BLOB_DATA,
    timestamp,
    hash,
    data: blobData,
    mimeType,
  };
}

// ============================================================================
// BLOB_SYNC_COMPLETE
// ============================================================================

/**
 * BLOB_SYNC_COMPLETE format:
 * - u8: type (0x13)
 * - u64: timestamp
 * - u32: blobCount
 */
function serializeBlobSyncComplete(msg: BlobSyncCompleteMessage): Uint8Array {
  const buffer = new ArrayBuffer(13);
  const view = new DataView(buffer);

  view.setUint8(0, msg.type);
  view.setBigUint64(1, BigInt(msg.timestamp), false);
  view.setUint32(9, msg.blobCount, false);

  return new Uint8Array(buffer);
}

function deserializeBlobSyncComplete(
  data: Uint8Array,
  timestamp: number,
): BlobSyncCompleteMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    type: SyncMessageType.BLOB_SYNC_COMPLETE,
    timestamp,
    blobCount: view.getUint32(9, false),
  };
}

// ============================================================================
// Blob Message Creation Helpers
// ============================================================================

export function createBlobHashesMessage(hashes: string[]): BlobHashesMessage {
  return {
    type: SyncMessageType.BLOB_HASHES,
    timestamp: Date.now(),
    hashes,
  };
}

export function createBlobRequestMessage(hashes: string[]): BlobRequestMessage {
  return {
    type: SyncMessageType.BLOB_REQUEST,
    timestamp: Date.now(),
    hashes,
  };
}

export function createBlobDataMessage(
  hash: string,
  data: Uint8Array,
  mimeType?: string,
): BlobDataMessage {
  return {
    type: SyncMessageType.BLOB_DATA,
    timestamp: Date.now(),
    hash,
    data,
    mimeType,
  };
}

export function createBlobSyncCompleteMessage(
  blobCount: number,
): BlobSyncCompleteMessage {
  return {
    type: SyncMessageType.BLOB_SYNC_COMPLETE,
    timestamp: Date.now(),
    blobCount,
  };
}

// ============================================================================
// PEER_REMOVED
// ============================================================================

/**
 * PEER_REMOVED format:
 * - u8: type (0x20)
 * - u64: timestamp
 * - u16: reason length (0 if none)
 * - bytes: reason (UTF-8, optional)
 */
function serializePeerRemoved(msg: PeerRemovedMessage): Uint8Array {
  const reasonBytes = msg.reason ? TEXT_ENCODER.encode(msg.reason) : null;
  const totalLength = 1 + 8 + 2 + (reasonBytes?.length || 0);

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  view.setUint8(offset++, msg.type);
  view.setBigUint64(offset, BigInt(msg.timestamp), false);
  offset += 8;

  view.setUint16(offset, reasonBytes?.length || 0, false);
  offset += 2;
  if (reasonBytes) {
    bytes.set(reasonBytes, offset);
  }

  return bytes;
}

function deserializePeerRemoved(
  data: Uint8Array,
  timestamp: number,
): PeerRemovedMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 9; // Skip type and timestamp

  const reasonLen = view.getUint16(offset, false);
  offset += 2;

  let reason: string | undefined;
  if (reasonLen > 0 && offset + reasonLen <= data.length) {
    reason = TEXT_DECODER.decode(data.slice(offset, offset + reasonLen));
  }

  return {
    type: SyncMessageType.PEER_REMOVED,
    timestamp,
    reason,
  };
}

export function createPeerRemovedMessage(reason?: string): PeerRemovedMessage {
  return {
    type: SyncMessageType.PEER_REMOVED,
    timestamp: Date.now(),
    reason,
  };
}
