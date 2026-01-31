/**
 * WebRTC Transport Types
 *
 * Type definitions for WebRTC DataChannel transport layer.
 * Used as an optional upgrade from Iroh relay for direct LAN connections.
 */

/**
 * WebRTC configuration options.
 */
export interface WebRTCConfig {
  /** ICE servers (empty for LAN-only, add STUN/TURN for internet) */
  iceServers: RTCIceServer[];

  /** Timeout for ICE gathering in milliseconds */
  iceGatheringTimeout: number;

  /** Timeout for connection establishment in milliseconds */
  connectionTimeout: number;

  /** Maximum buffered amount before applying backpressure (bytes) */
  maxBufferedAmount: number;

  /** Timeout for signaling operations in milliseconds */
  signalingTimeout: number;
}

/**
 * Default WebRTC configuration for LAN-only connections.
 */
export const DEFAULT_WEBRTC_CONFIG: WebRTCConfig = {
  iceServers: [], // No STUN/TURN - LAN only
  iceGatheringTimeout: 5000,
  connectionTimeout: 10000,
  maxBufferedAmount: 1024 * 1024, // 1MB
  signalingTimeout: 5000,
};

/**
 * WebRTC signaling message types.
 * These are exchanged over Iroh to establish WebRTC connections.
 */
export enum SignalingMessageType {
  /** Request to upgrade connection to WebRTC */
  UPGRADE_REQUEST = 0x30,

  /** Accept WebRTC upgrade */
  UPGRADE_ACCEPT = 0x31,

  /** Reject WebRTC upgrade (WebRTC not available or disabled) */
  UPGRADE_REJECT = 0x32,

  /** SDP offer */
  OFFER = 0x33,

  /** SDP answer */
  ANSWER = 0x34,

  /** ICE candidate */
  ICE_CANDIDATE = 0x35,

  /** WebRTC connection ready (both sides confirmed) */
  READY = 0x36,
}

/**
 * Base signaling message structure.
 */
export interface SignalingMessageBase {
  type: SignalingMessageType;
  timestamp: number;
}

/**
 * Request to upgrade connection to WebRTC.
 */
export interface UpgradeRequestMessage extends SignalingMessageBase {
  type: SignalingMessageType.UPGRADE_REQUEST;
}

/**
 * Accept WebRTC upgrade.
 */
export interface UpgradeAcceptMessage extends SignalingMessageBase {
  type: SignalingMessageType.UPGRADE_ACCEPT;
}

/**
 * Reject WebRTC upgrade.
 */
export interface UpgradeRejectMessage extends SignalingMessageBase {
  type: SignalingMessageType.UPGRADE_REJECT;
  reason: string;
}

/**
 * SDP offer message.
 */
export interface OfferMessage extends SignalingMessageBase {
  type: SignalingMessageType.OFFER;
  sdp: string;
}

/**
 * SDP answer message.
 */
export interface AnswerMessage extends SignalingMessageBase {
  type: SignalingMessageType.ANSWER;
  sdp: string;
}

/**
 * ICE candidate message.
 */
export interface IceCandidateMessage extends SignalingMessageBase {
  type: SignalingMessageType.ICE_CANDIDATE;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/**
 * WebRTC connection ready message.
 */
export interface ReadyMessage extends SignalingMessageBase {
  type: SignalingMessageType.READY;
}

/**
 * Union type of all signaling messages.
 */
export type SignalingMessage =
  | UpgradeRequestMessage
  | UpgradeAcceptMessage
  | UpgradeRejectMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | ReadyMessage;

/**
 * ICE candidate type (for metrics).
 */
export type IceCandidateType = "host" | "srflx" | "prflx" | "relay";

/**
 * WebRTC connection metrics.
 */
export interface WebRTCConnectionMetrics {
  /** Whether using a direct connection (host candidate) */
  isDirect: boolean;

  /** Type of local ICE candidate selected */
  localCandidateType: IceCandidateType | null;

  /** Type of remote ICE candidate selected */
  remoteCandidateType: IceCandidateType | null;

  /** Local IP address (if available) */
  localAddress?: string;

  /** Remote IP address (if available) */
  remoteAddress?: string;

  /** Round-trip time in milliseconds */
  rttMs?: number;

  /** Bytes sent */
  bytesSent: number;

  /** Bytes received */
  bytesReceived: number;

  /** Connection established timestamp */
  connectedAt?: number;
}

/**
 * WebRTC feature detection result.
 */
export interface WebRTCSupport {
  /** Whether WebRTC is available */
  available: boolean;

  /** Whether RTCPeerConnection is available */
  hasPeerConnection: boolean;

  /** Whether RTCDataChannel is available */
  hasDataChannel: boolean;

  /** Gathered ICE candidate types (if tested) */
  candidateTypes?: IceCandidateType[];

  /** Error message if not available */
  error?: string;
}

/**
 * WebRTC connection state.
 */
export type WebRTCConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

/**
 * DataChannel state.
 */
export type DataChannelState = "connecting" | "open" | "closing" | "closed";

/**
 * WebRTC stream configuration.
 */
export interface WebRTCStreamConfig {
  /** Whether the channel should be ordered */
  ordered: boolean;

  /** Maximum retransmits (null for reliable) */
  maxRetransmits: number | null;

  /** Protocol identifier */
  protocol: string;
}

/**
 * Default stream configuration (reliable, ordered - matches Iroh).
 */
export const DEFAULT_STREAM_CONFIG: WebRTCStreamConfig = {
  ordered: true,
  maxRetransmits: null, // Reliable
  protocol: "peervault-sync",
};

/**
 * Constants for WebRTC transport.
 */
export const WEBRTC_CONSTANTS = {
  /** Main data channel label */
  MAIN_CHANNEL_LABEL: "peervault-main",

  /** Stream channel label prefix */
  STREAM_CHANNEL_PREFIX: "stream-",

  /** Signaling stream channel label */
  SIGNALING_CHANNEL_LABEL: "signaling",

  /** Backpressure check interval in milliseconds */
  BACKPRESSURE_CHECK_INTERVAL: 10,

  /** Maximum time to wait for backpressure in milliseconds */
  BACKPRESSURE_TIMEOUT: 30000,
} as const;
