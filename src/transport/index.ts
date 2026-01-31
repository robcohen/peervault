export type {
  Transport,
  PeerConnection,
  SyncStream,
  TransportConfig,
  TransportStorage,
  TransportLogger,
  TransportEvents,
  ConnectionState,
} from "./types";

export { PEERVAULT_ALPN } from "./types";
export { IrohTransport, initIrohWasm, isIrohWasmReady } from "./iroh-transport";

// Hybrid transport (Iroh + WebRTC)
export { HybridTransport, HybridConnection } from "./hybrid-transport";
export type { HybridTransportConfig } from "./hybrid-transport";

// WebRTC module
export * from "./webrtc";
