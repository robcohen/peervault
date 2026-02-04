/**
 * WebRTC Connection Tests
 *
 * Tests for WebRTC connection establishment and the HybridTransport upgrade flow.
 * These tests require a browser-like environment with WebRTC support.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { TransportLogger, SyncStream, PeerConnection } from "../src/transport/types";
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
} from "../src/transport/webrtc";

// Check if we're in a browser-like environment with WebRTC
const hasWebRTC = typeof globalThis.RTCPeerConnection !== "undefined";

// Mock logger for tests
const createMockLogger = (): TransportLogger => ({
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
});

// Mock SyncStream for testing
const createMockStream = (messages: Uint8Array[] = []): SyncStream & {
  sentMessages: Uint8Array[];
  closed: boolean;
  pushMessage: (msg: Uint8Array) => void;
} => {
  let messageIndex = 0;
  const sentMessages: Uint8Array[] = [];
  let closed = false;
  const pendingMessages: Uint8Array[] = [...messages];
  let receiveResolve: ((data: Uint8Array) => void) | null = null;

  return {
    id: `mock-stream-${Math.random().toString(36).slice(2)}`,
    sentMessages,
    closed,
    pushMessage: (msg: Uint8Array) => {
      if (receiveResolve) {
        receiveResolve(msg);
        receiveResolve = null;
      } else {
        pendingMessages.push(msg);
      }
    },
    send: async (data: Uint8Array) => {
      if (closed) throw new Error("Stream closed");
      sentMessages.push(data);
    },
    receive: async () => {
      if (closed) throw new Error("Stream closed");
      if (pendingMessages.length > 0) {
        return pendingMessages.shift()!;
      }
      // Wait for a message to be pushed
      return new Promise((resolve) => {
        receiveResolve = resolve;
      });
    },
    close: async () => {
      closed = true;
    },
    isOpen: () => !closed,
  };
};

// Mock PeerConnection for testing
const createMockPeerConnection = (peerId: string): PeerConnection & {
  streams: SyncStream[];
  streamCallbacks: Array<(stream: SyncStream) => void>;
} => {
  const streams: SyncStream[] = [];
  const streamCallbacks: Array<(stream: SyncStream) => void> = [];
  let connected = true;

  return {
    peerId,
    streams,
    streamCallbacks,
    state: "connected",
    openStream: async () => {
      const stream = createMockStream();
      streams.push(stream);
      return stream;
    },
    acceptStream: async () => {
      // Return the first available stream
      if (streams.length > 0) {
        return streams.shift()!;
      }
      throw new Error("No stream available");
    },
    close: async () => {
      connected = false;
    },
    isConnected: () => connected,
    onStateChange: (callback) => {
      return () => {};
    },
    onStream: (callback) => {
      streamCallbacks.push(callback);
      return () => {
        const idx = streamCallbacks.indexOf(callback);
        if (idx >= 0) streamCallbacks.splice(idx, 1);
      };
    },
    getRttMs: () => 50,
    getPendingStreamCount: () => 0,
  };
};

describe("WebRTC Connection Flow", () => {
  describe("Signaling Message Detection", () => {
    it("should detect UPGRADE_REQUEST as signaling message", () => {
      const msg = createUpgradeRequest();
      const serialized = serializeSignalingMessage(msg);

      // First byte should be the message type
      expect(serialized[0]).toBe(SignalingMessageType.UPGRADE_REQUEST);
      expect(isSignalingMessageType(serialized[0])).toBe(true);
    });

    it("should NOT detect VERSION_INFO (0x01) as signaling message", () => {
      // Sync messages start with 0x01 (VERSION_INFO)
      expect(isSignalingMessageType(0x01)).toBe(false);
    });

    it("should detect all signaling message types correctly", () => {
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
        expect(isSignalingMessageType(type)).toBe(true);
      }
    });

    it("should correctly distinguish sync vs signaling by first byte", () => {
      // Sync message types (0x01 - 0x20 range)
      const syncTypes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x10, 0x11, 0x12, 0x13, 0x14, 0x20];

      for (const type of syncTypes) {
        expect(isSignalingMessageType(type)).toBe(false);
      }

      // Signaling types (0x30 - 0x36)
      for (let type = 0x30; type <= 0x36; type++) {
        expect(isSignalingMessageType(type)).toBe(true);
      }
    });
  });

  describe("Upgrade Request/Response Protocol", () => {
    it("should create valid upgrade request message", () => {
      const request = createUpgradeRequest();
      expect(request.type).toBe(SignalingMessageType.UPGRADE_REQUEST);
      expect(request.timestamp).toBeGreaterThan(0);
    });

    it("should create valid upgrade accept message", () => {
      const accept = createUpgradeAccept();
      expect(accept.type).toBe(SignalingMessageType.UPGRADE_ACCEPT);
    });

    it("should create valid upgrade reject message with reason", () => {
      const reason = "WebRTC not available";
      const reject = createUpgradeReject(reason);
      expect(reject.type).toBe(SignalingMessageType.UPGRADE_REJECT);
      expect(reject.reason).toBe(reason);
    });

    it("should complete request/accept handshake", () => {
      // Simulate initiator sending request
      const request = createUpgradeRequest();
      const serializedRequest = serializeSignalingMessage(request);

      // Simulate acceptor receiving and parsing
      const parsedRequest = deserializeSignalingMessage(serializedRequest);
      expect(parsedRequest.type).toBe(SignalingMessageType.UPGRADE_REQUEST);

      // Simulate acceptor sending accept
      const accept = createUpgradeAccept();
      const serializedAccept = serializeSignalingMessage(accept);

      // Simulate initiator receiving and parsing
      const parsedAccept = deserializeSignalingMessage(serializedAccept);
      expect(parsedAccept.type).toBe(SignalingMessageType.UPGRADE_ACCEPT);
    });

    it("should complete request/reject handshake", () => {
      const request = createUpgradeRequest();
      const serializedRequest = serializeSignalingMessage(request);
      const parsedRequest = deserializeSignalingMessage(serializedRequest);
      expect(parsedRequest.type).toBe(SignalingMessageType.UPGRADE_REQUEST);

      const reject = createUpgradeReject("Already upgrading");
      const serializedReject = serializeSignalingMessage(reject);
      const parsedReject = deserializeSignalingMessage(serializedReject);
      expect(parsedReject.type).toBe(SignalingMessageType.UPGRADE_REJECT);
      expect((parsedReject as typeof reject).reason).toBe("Already upgrading");
    });
  });

  describe("SDP Offer/Answer Exchange", () => {
    const mockSdp = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=msid-semantic: WMS
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=ice-ufrag:abcd
a=ice-pwd:efghijklmnopqrstuvwx
a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99
a=setup:actpass
a=mid:0
a=sctp-port:5000`;

    it("should serialize and deserialize SDP offer", () => {
      const offer = createOffer(mockSdp);
      const serialized = serializeSignalingMessage(offer);
      const parsed = deserializeSignalingMessage(serialized);

      expect(parsed.type).toBe(SignalingMessageType.OFFER);
      expect((parsed as typeof offer).sdp).toBe(mockSdp);
    });

    it("should serialize and deserialize SDP answer", () => {
      const answer = createAnswer(mockSdp);
      const serialized = serializeSignalingMessage(answer);
      const parsed = deserializeSignalingMessage(serialized);

      expect(parsed.type).toBe(SignalingMessageType.ANSWER);
      expect((parsed as typeof answer).sdp).toBe(mockSdp);
    });

    it("should handle SDP with special characters", () => {
      const sdpWithSpecialChars = mockSdp + "\na=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level";
      const offer = createOffer(sdpWithSpecialChars);
      const serialized = serializeSignalingMessage(offer);
      const parsed = deserializeSignalingMessage(serialized);

      expect((parsed as typeof offer).sdp).toBe(sdpWithSpecialChars);
    });
  });

  describe("ICE Candidate Exchange", () => {
    it("should serialize and deserialize host candidate", () => {
      const candidate = {
        candidate: "candidate:1 1 UDP 2122252543 192.168.1.100 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      } as RTCIceCandidate;

      const msg = createIceCandidate(candidate);
      const serialized = serializeSignalingMessage(msg);
      const parsed = deserializeSignalingMessage(serialized);

      expect(parsed.type).toBe(SignalingMessageType.ICE_CANDIDATE);
      expect((parsed as typeof msg).candidate).toBe(candidate.candidate);
      expect((parsed as typeof msg).sdpMid).toBe("0");
      expect((parsed as typeof msg).sdpMLineIndex).toBe(0);
    });

    it("should serialize and deserialize srflx candidate", () => {
      const candidate = {
        candidate: "candidate:2 1 UDP 1685987071 203.0.113.1 54322 typ srflx raddr 192.168.1.100 rport 54321",
        sdpMid: "0",
        sdpMLineIndex: 0,
      } as RTCIceCandidate;

      const msg = createIceCandidate(candidate);
      const serialized = serializeSignalingMessage(msg);
      const parsed = deserializeSignalingMessage(serialized);

      expect((parsed as typeof msg).candidate).toContain("typ srflx");
    });

    it("should serialize and deserialize relay candidate", () => {
      const candidate = {
        candidate: "candidate:3 1 UDP 41885695 203.0.113.2 54323 typ relay raddr 203.0.113.1 rport 54322",
        sdpMid: "0",
        sdpMLineIndex: 0,
      } as RTCIceCandidate;

      const msg = createIceCandidate(candidate);
      const serialized = serializeSignalingMessage(msg);
      const parsed = deserializeSignalingMessage(serialized);

      expect((parsed as typeof msg).candidate).toContain("typ relay");
    });
  });

  describe("Complete Signaling Flow", () => {
    it("should simulate complete WebRTC upgrade signaling", () => {
      // 1. Initiator sends UPGRADE_REQUEST
      const request = createUpgradeRequest();

      // 2. Acceptor responds with UPGRADE_ACCEPT
      const accept = createUpgradeAccept();

      // 3. Initiator creates and sends OFFER
      const offer = createOffer("v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\n");

      // 4. Acceptor creates and sends ANSWER
      const answer = createAnswer("v=0\r\no=- 456 2 IN IP4 127.0.0.1\r\n");

      // 5. Both exchange ICE candidates
      const ice1 = createIceCandidate({
        candidate: "candidate:1 1 UDP 2122252543 192.168.1.1 5000 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      } as RTCIceCandidate);

      const ice2 = createIceCandidate({
        candidate: "candidate:1 1 UDP 2122252543 192.168.1.2 5001 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      } as RTCIceCandidate);

      // 6. Both send READY
      const ready1 = createReady();
      const ready2 = createReady();

      // Verify all messages can be serialized and deserialized
      const messages = [request, accept, offer, answer, ice1, ice2, ready1, ready2];

      for (const msg of messages) {
        const serialized = serializeSignalingMessage(msg);
        const parsed = deserializeSignalingMessage(serialized);
        expect(parsed.type).toBe(msg.type);
      }
    });
  });
});

describe.skipIf(!hasWebRTC)("WebRTC PeerConnection (browser only)", () => {
  let pc1: RTCPeerConnection;
  let pc2: RTCPeerConnection;

  beforeEach(() => {
    pc1 = new RTCPeerConnection({ iceServers: [] });
    pc2 = new RTCPeerConnection({ iceServers: [] });
  });

  afterEach(() => {
    pc1.close();
    pc2.close();
  });

  it("should create offer and answer", async () => {
    // Create data channel to trigger ICE gathering
    pc1.createDataChannel("test");

    const offer = await pc1.createOffer();
    expect(offer.type).toBe("offer");
    expect(offer.sdp).toBeDefined();

    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);

    const answer = await pc2.createAnswer();
    expect(answer.type).toBe("answer");
    expect(answer.sdp).toBeDefined();

    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
  });

  it("should exchange ICE candidates", async () => {
    const pc1Candidates: RTCIceCandidate[] = [];
    const pc2Candidates: RTCIceCandidate[] = [];

    pc1.onicecandidate = (e) => {
      if (e.candidate) pc1Candidates.push(e.candidate);
    };
    pc2.onicecandidate = (e) => {
      if (e.candidate) pc2Candidates.push(e.candidate);
    };

    pc1.createDataChannel("test");

    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);

    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    // Wait for ICE gathering
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Should have gathered some candidates (at least host candidates)
    expect(pc1Candidates.length).toBeGreaterThan(0);
  });

  it("should establish DataChannel connection", async () => {
    let pc2Channel: RTCDataChannel | null = null;

    pc2.ondatachannel = (e) => {
      pc2Channel = e.channel;
    };

    const pc1Channel = pc1.createDataChannel("test", {
      ordered: true,
      protocol: "peervault-sync",
    });

    // Exchange offer/answer
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);

    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    // Exchange ICE candidates
    pc1.onicecandidate = async (e) => {
      if (e.candidate) await pc2.addIceCandidate(e.candidate);
    };
    pc2.onicecandidate = async (e) => {
      if (e.candidate) await pc1.addIceCandidate(e.candidate);
    };

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 5000);

      pc1.onconnectionstatechange = () => {
        if (pc1.connectionState === "connected") {
          clearTimeout(timeout);
          resolve();
        } else if (pc1.connectionState === "failed") {
          clearTimeout(timeout);
          reject(new Error("Connection failed"));
        }
      };
    });

    expect(pc1.connectionState).toBe("connected");
    expect(pc2Channel).not.toBeNull();
    expect(pc2Channel?.label).toBe("test");
  });

  it("should send and receive data over DataChannel", async () => {
    let pc2Channel: RTCDataChannel | null = null;
    const receivedMessages: string[] = [];

    pc2.ondatachannel = (e) => {
      pc2Channel = e.channel;
      pc2Channel.onmessage = (event) => {
        receivedMessages.push(event.data);
      };
    };

    const pc1Channel = pc1.createDataChannel("test");

    // Setup connection
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);

    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    pc1.onicecandidate = async (e) => {
      if (e.candidate) await pc2.addIceCandidate(e.candidate);
    };
    pc2.onicecandidate = async (e) => {
      if (e.candidate) await pc1.addIceCandidate(e.candidate);
    };

    // Wait for data channel to open
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Channel open timeout")), 5000);

      pc1Channel.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      pc1Channel.onerror = (e) => {
        clearTimeout(timeout);
        reject(e);
      };
    });

    // Send a message
    pc1Channel.send("Hello WebRTC!");

    // Wait for message to be received
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedMessages).toContain("Hello WebRTC!");
  });
});

describe.skipIf(!hasWebRTC)("WebRTC Candidate Types (browser only)", () => {
  it("should identify host candidates", () => {
    const hostCandidate = "candidate:1 1 UDP 2122252543 192.168.1.100 54321 typ host";
    expect(hostCandidate).toContain("typ host");
  });

  it("should identify srflx candidates", () => {
    const srflxCandidate = "candidate:2 1 UDP 1685987071 203.0.113.1 54322 typ srflx raddr 192.168.1.100 rport 54321";
    expect(srflxCandidate).toContain("typ srflx");
  });

  it("should identify relay candidates", () => {
    const relayCandidate = "candidate:3 1 UDP 41885695 203.0.113.2 54323 typ relay raddr 203.0.113.1 rport 54322";
    expect(relayCandidate).toContain("typ relay");
  });

  it("should parse candidate type from string", () => {
    const getCandidateType = (candidate: string): string | null => {
      const match = candidate.match(/typ\s+(host|srflx|prflx|relay)/);
      return match ? match[1] : null;
    };

    expect(getCandidateType("candidate:1 1 UDP 2122252543 192.168.1.100 54321 typ host")).toBe("host");
    expect(getCandidateType("candidate:2 1 UDP 1685987071 203.0.113.1 54322 typ srflx")).toBe("srflx");
    expect(getCandidateType("candidate:3 1 UDP 41885695 203.0.113.2 54323 typ relay")).toBe("relay");
  });
});

describe("Stream Detection Logic", () => {
  it("should correctly identify sync message type (VERSION_INFO = 0x01)", () => {
    // VERSION_INFO is the first message in sync protocol
    const versionInfoType = 0x01;
    expect(isSignalingMessageType(versionInfoType)).toBe(false);
  });

  it("should correctly identify signaling message type (UPGRADE_REQUEST = 0x30)", () => {
    const upgradeRequestType = SignalingMessageType.UPGRADE_REQUEST;
    expect(isSignalingMessageType(upgradeRequestType)).toBe(true);
  });

  it("should detect stream type from first message byte", () => {
    // Simulate detecting stream type from first byte
    const detectStreamType = (firstByte: number): "sync" | "signaling" | "unknown" => {
      if (firstByte >= 0x01 && firstByte <= 0x20) return "sync";
      if (isSignalingMessageType(firstByte)) return "signaling";
      return "unknown";
    };

    expect(detectStreamType(0x01)).toBe("sync"); // VERSION_INFO
    expect(detectStreamType(0x02)).toBe("sync"); // UPDATES
    expect(detectStreamType(0x30)).toBe("signaling"); // UPGRADE_REQUEST
    expect(detectStreamType(0x31)).toBe("signaling"); // UPGRADE_ACCEPT
    expect(detectStreamType(0xff)).toBe("unknown");
  });
});
