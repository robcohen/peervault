/**
 * WebRTC Transport Module
 *
 * Provides WebRTC DataChannel transport for direct LAN connections.
 * Exports all types, utilities, and feature detection.
 */

// Export types
export type {
  WebRTCConfig,
  SignalingMessage,
  SignalingMessageBase,
  UpgradeRequestMessage,
  UpgradeAcceptMessage,
  UpgradeRejectMessage,
  OfferMessage,
  AnswerMessage,
  IceCandidateMessage,
  ReadyMessage,
  IceCandidateType,
  WebRTCConnectionMetrics,
  WebRTCSupport,
  WebRTCConnectionState,
  DataChannelState,
  WebRTCStreamConfig,
} from "./types";

export {
  SignalingMessageType,
  DEFAULT_WEBRTC_CONFIG,
  DEFAULT_STREAM_CONFIG,
  WEBRTC_CONSTANTS,
} from "./types";

// Export stream
export { WebRTCSyncStream, createWebRTCStream } from "./webrtc-stream";

// Export connection
export { WebRTCPeerConnection, createWebRTCPeerConnection } from "./webrtc-connection";

// Export signaling
export {
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
} from "./signaling";

import type { WebRTCSupport, IceCandidateType } from "./types";

/**
 * Check if WebRTC is available in the current environment.
 *
 * This performs a quick check for RTCPeerConnection and RTCDataChannel.
 * For a more thorough test that checks ICE candidate gathering,
 * use `testWebRTCSupport()`.
 */
export function isWebRTCAvailable(): boolean {
  return (
    typeof RTCPeerConnection !== "undefined" &&
    typeof RTCDataChannel !== "undefined"
  );
}

/**
 * Test WebRTC support with optional ICE candidate gathering.
 *
 * @param testCandidates - If true, attempts to gather ICE candidates (takes ~3 seconds)
 * @returns WebRTCSupport object with availability details
 */
export async function testWebRTCSupport(
  testCandidates = false,
): Promise<WebRTCSupport> {
  const support: WebRTCSupport = {
    available: false,
    hasPeerConnection: typeof RTCPeerConnection !== "undefined",
    hasDataChannel: typeof RTCDataChannel !== "undefined",
  };

  if (!support.hasPeerConnection) {
    support.error = "RTCPeerConnection not available";
    return support;
  }

  if (!support.hasDataChannel) {
    support.error = "RTCDataChannel not available";
    return support;
  }

  // Basic availability confirmed
  support.available = true;

  // Optionally test ICE candidate gathering
  if (testCandidates) {
    try {
      const candidateTypes = await gatherCandidateTypes();
      support.candidateTypes = candidateTypes;

      if (candidateTypes.length === 0) {
        support.error = "No ICE candidates gathered";
      }
    } catch (error) {
      support.error = `ICE gathering failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return support;
}

/**
 * Gather ICE candidate types to check what connection types are available.
 *
 * This creates a temporary RTCPeerConnection and gathers candidates
 * without any STUN/TURN servers to see what host candidates we can get.
 *
 * @returns Array of gathered candidate types
 */
export async function gatherCandidateTypes(): Promise<IceCandidateType[]> {
  const candidateTypes = new Set<IceCandidateType>();

  const pc = new RTCPeerConnection({ iceServers: [] });

  return new Promise<IceCandidateType[]>((resolve) => {
    const timeout = setTimeout(() => {
      pc.close();
      resolve(Array.from(candidateTypes));
    }, 3000);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const type = event.candidate.type as IceCandidateType | undefined;
        if (type) {
          candidateTypes.add(type);
        }
      }
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        pc.close();
        resolve(Array.from(candidateTypes));
      }
    };

    // Create a data channel to trigger ICE gathering
    pc.createDataChannel("test");

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {
        clearTimeout(timeout);
        pc.close();
        resolve([]);
      });
  });
}

/**
 * Check if we have host candidates (for direct LAN connections).
 *
 * @returns True if host candidates are available
 */
export async function hasHostCandidates(): Promise<boolean> {
  const candidateTypes = await gatherCandidateTypes();
  return candidateTypes.includes("host");
}
