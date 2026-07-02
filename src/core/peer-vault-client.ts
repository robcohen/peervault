/**
 * PeerVaultClient - Clean TypeScript wrapper for Rust WASM
 *
 * Uses WasmPeerVault directly - it has transport built-in.
 * This wrapper just adapts Obsidian's APIs to the WASM interface.
 */

import type { App } from "obsidian";
// Generated from the Rust `WasmEvent` enum via ts-rs — the single source of truth
// for the WASM→host event schema. Regenerate with:
//   cd peervault-core && cargo test --features "ts-export test-utils" --lib export_ts_bindings
import type { Event as WasmEvent } from "./generated/events";
import type { ReconcilePlan } from "./generated/reconcile";

// =============================================================================
// Types
// =============================================================================

export interface PeerInfo {
  id: string;
  name: string;
  ticket: string;
  lastSeen: number;
  isConnected: boolean;
}

export interface SyncResult {
  success: boolean;
  peerId: string;
  updatesReceived: number;
  updatesSent: number;
  error?: string;
}

export interface ClientConfig {
  /** Vault identifier (derived from vault path) */
  vaultId: string;
  /** Device display name */
  deviceName: string;
  /** Optional relay URL (if not set, uses default n0.computer relay) */
  relayUrl?: string;
}

export type ClientEvent =
  | { type: "initialized"; nodeId: string }
  | { type: "peer-connected"; peerId: string; peerName: string }
  | { type: "peer-disconnected"; peerId: string; reason: string }
  | { type: "sync-started"; peerId: string }
  | { type: "sync-complete"; peerId: string; result: SyncResult }
  | { type: "sync-error"; peerId: string; error: string }
  | { type: "file-changed"; path: string; source: "local" | "remote" }
  | { type: "gossip-update"; bytes: number }
  | { type: "pairing-request"; peerId: string; peerName: string }
  | { type: "error"; message: string };

export type EventHandler = (event: ClientEvent) => void;

/**
 * Stable error codes surfaced by the WASM core (on the `.code` property of the
 * thrown `Error`). Lets callers branch on the failure kind instead of matching
 * on human-readable message strings.
 */
export type PeerVaultErrorCode =
  | "KEY_CONFLICT"
  | "DELTA_TOO_LARGE"
  | "CRYPTO"
  | "TIMEOUT"
  | "PROTOCOL"
  | "CRDT"
  | "HOST"
  | "STORE"
  | "CONFIG"
  | "INTERNAL";

/** Extract the machine-readable code from an error thrown by the WASM core, if any. */
export function errorCode(e: unknown): PeerVaultErrorCode | undefined {
  if (e && typeof e === "object" && "code" in e) {
    return (e as { code?: PeerVaultErrorCode }).code;
  }
  return undefined;
}

// =============================================================================
// WASM Module Types (from peervault-core)
// =============================================================================

interface WasmPeerVault {
  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Transport
  getNodeId(): Promise<string>;
  getTicket(): Promise<string>;
  connectPeer(ticket: string): Promise<string>; // Returns peer ID
  connectPeerWithPairing(ticket: string, pairingNonce: string | null, deviceName: string | null): Promise<string>;
  setRelayUrl(url: string): void;
  getRelayUrl(): string | null;

  // Pairing (one-time ticket validation)
  registerPairingNonce(nonce: string, expiresAtMs: number): void;
  validatePairingNonce(nonce: string): boolean;
  isKnownPeer(peerId: string): boolean;
  addKnownPeer(peerId: string): void;
  removeKnownPeer(peerId: string): void;
  getKnownPeers(): string[];

  // Encryption
  generateEncryptionKey(): Promise<string>;
  setEncryptionKey(keyHex: string): Promise<void>;
  getEncryptionKey(): Promise<string | null>;
  hasEncryptionKey(): Promise<boolean>;
  deriveEncryptionKey(passphrase: string): Promise<string>;
  clearEncryptionKey(): Promise<void>;

  // CRDT operations
  set(key: string, content: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string | null): Promise<string[]>;
  reconcilePlan(dirtyPaths: string[]): Promise<string>; // JSON ReconcilePlan

  // State persistence
  export(): Promise<Uint8Array>;
  import(data: Uint8Array): Promise<void>;
  startWithState(state: Uint8Array): Promise<void>;

  // Callbacks
  setEventCallback(callback: (eventJson: string) => void): void;
  setStorageCallback(callback: (stateData: Uint8Array) => void): void;

  // Cleanup
  free(): void;
}

interface WasmModule {
  default: () => Promise<void>;
  WasmPeerVault: { new (vaultId: string, deviceName: string): WasmPeerVault };
}

// =============================================================================
// Storage Helper
// =============================================================================

const DATA_DIR = ".obsidian/plugins/peervault/data";

// On-disk format markers for the persisted vault key (first byte).
// Legacy keys have no marker (raw ASCII hex, first byte 0x30-0x66), which is
// distinguishable from these markers.
const KEY_FMT_PLAINTEXT = 0x00;
const KEY_FMT_SAFE_STORAGE = 0x01;

/**
 * Electron safeStorage (OS keychain-backed), if reachable from this context.
 * Returns null on mobile or when the API isn't exposed to the renderer, in which
 * case the vault key falls back to plaintext-at-rest (the prior behaviour).
 */
function getSafeStorage(): any | null {
  try {
    // globalThis-based so this file typechecks without DOM libs (Node hosts).
    const req = (globalThis as any).window?.require ?? (globalThis as any).require;
    const electron = req?.("electron");
    const ss = electron?.safeStorage ?? electron?.remote?.safeStorage;
    return ss && typeof ss.isEncryptionAvailable === "function" ? ss : null;
  } catch {
    return null;
  }
}

/**
 * Host storage abstraction — the only platform-specific dependency of
 * `PeerVaultClient`. Obsidian implements it over the vault adapter
 * (`ObsidianStorage`); other hosts (VSCode, custom apps) implement these three
 * methods over their own storage and reuse the client unchanged.
 */
export interface HostStorage {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Obsidian-backed HostStorage (plugin data dir via the vault adapter). */
export class ObsidianStorage implements HostStorage {
  constructor(private app: App) {}

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const data = await this.app.vault.adapter.readBinary(`${DATA_DIR}/${key}`);
      return new Uint8Array(data);
    } catch {
      return null;
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.ensureDir();
    await this.app.vault.adapter.writeBinary(`${DATA_DIR}/${key}`, value.buffer as ArrayBuffer);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.app.vault.adapter.remove(`${DATA_DIR}/${key}`);
    } catch {
      // Ignore
    }
  }

  private async ensureDir(): Promise<void> {
    try {
      await this.app.vault.adapter.mkdir(DATA_DIR);
    } catch {
      // Already exists
    }
  }
}

// =============================================================================
// PeerVaultClient
// =============================================================================

export class PeerVaultClient {
  private config: ClientConfig;
  private storage: HostStorage;
  private handlers: EventHandler[] = [];

  private wasmModule: WasmModule | null = null;
  private vault: WasmPeerVault | null = null;
  private _nodeId: string | null = null;
  private _initialized = false;
  private _syncInProgress = false;

  // Peer tracking (persisted separately since WASM doesn't expose peer list)
  private peers: PeerInfo[] = [];

  // Pending pairing nonces (nonce -> expiration timestamp)
  // Each nonce is valid for 10 minutes and can only be used once
  private pendingPairings: Map<string, number> = new Map();
  private static PAIRING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

  constructor(storage: HostStorage, config: ClientConfig) {
    this.config = config;
    this.storage = storage;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async initialize(): Promise<void> {
    if (this._initialized) return;

    // Load WASM module
    // @ts-ignore - resolved by esbuild
    this.wasmModule = await import("../../peervault-core/pkg/peervault_core.js");
    await this.wasmModule!.default();

    // Create vault instance
    this.vault = new this.wasmModule!.WasmPeerVault(
      this.config.vaultId,
      this.config.deviceName
    );

    // Set relay URL if provided
    if (this.config.relayUrl) {
      this.vault.setRelayUrl(this.config.relayUrl);
    }

    // Set up event callback
    this.vault.setEventCallback((eventJson: string) => {
      this.handleWasmEvent(eventJson);
    });

    // Set up storage callback for state persistence
    this.vault.setStorageCallback((stateData: Uint8Array) => {
      this.storage.set("state.bin", stateData).catch((e) => {
        console.error("[PeerVault] Failed to persist state:", e);
      });
    });

    // Try to restore previous state
    const savedState = await this.storage.get("state.bin");
    if (savedState) {
      await this.vault.startWithState(savedState);
    } else {
      await this.vault.start();
    }

    // Get node ID
    this._nodeId = await this.vault.getNodeId();

    // Load encryption key if saved
    await this.loadEncryptionKey();

    // Load peer list
    await this.loadPeers();

    this._initialized = true;
    this.emit({ type: "initialized", nodeId: this._nodeId });
  }

  async shutdown(): Promise<void> {
    if (this.vault) {
      await this.vault.stop();
      this.vault.free();
      this.vault = null;
    }
    this._initialized = false;
  }

  // ===========================================================================
  // Encryption
  // ===========================================================================

  async hasEncryptionKey(): Promise<boolean> {
    if (!this.vault) return false;
    return this.vault.hasEncryptionKey();
  }

  async generateEncryptionKey(): Promise<string> {
    if (!this.vault) throw new Error("Not initialized");
    const keyHex = await this.vault.generateEncryptionKey();
    await this.persistEncryptionKey(keyHex);
    return keyHex;
  }

  async setEncryptionKey(keyHex: string): Promise<void> {
    if (!this.vault) throw new Error("Not initialized");
    await this.vault.setEncryptionKey(keyHex);
    await this.persistEncryptionKey(keyHex);
  }

  async deriveEncryptionKey(passphrase: string): Promise<string> {
    if (!this.vault) throw new Error("Not initialized");
    const keyHex = await this.vault.deriveEncryptionKey(passphrase);
    await this.persistEncryptionKey(keyHex);
    return keyHex;
  }

  async getEncryptionKey(): Promise<string | null> {
    if (!this.vault) return null;
    return this.vault.getEncryptionKey();
  }

  async clearEncryptionKey(): Promise<void> {
    if (!this.vault) return;
    await this.vault.clearEncryptionKey();
    await this.storage.delete("encryption-key");
  }

  /** Persist the vault key, encrypted via the OS keychain (safeStorage) when available. */
  private async persistEncryptionKey(keyHex: string): Promise<void> {
    const ss = getSafeStorage();
    if (ss?.isEncryptionAvailable()) {
      const enc: Uint8Array = ss.encryptString(keyHex);
      const out = new Uint8Array(enc.length + 1);
      out[0] = KEY_FMT_SAFE_STORAGE;
      out.set(enc, 1);
      await this.storage.set("encryption-key", out);
    } else {
      // Fallback (mobile / safeStorage not reachable): plaintext hex, as before.
      const hex = new TextEncoder().encode(keyHex);
      const out = new Uint8Array(hex.length + 1);
      out[0] = KEY_FMT_PLAINTEXT;
      out.set(hex, 1);
      await this.storage.set("encryption-key", out);
    }
  }

  /** Read the persisted vault key, handling safeStorage / plaintext / legacy formats. */
  private async readEncryptionKeyHex(): Promise<string | null> {
    const data = await this.storage.get("encryption-key");
    if (!data || data.length === 0) return null;
    switch (data[0]) {
      case KEY_FMT_SAFE_STORAGE: {
        const ss = getSafeStorage();
        if (!ss) throw new Error("Vault key was sealed with the OS keychain, but safeStorage is unavailable here");
        const Buf = (globalThis as any).Buffer;
        return ss.decryptString(Buf ? Buf.from(data.slice(1)) : data.slice(1));
      }
      case KEY_FMT_PLAINTEXT:
        return new TextDecoder().decode(data.slice(1));
      default:
        // Legacy: raw ASCII hex with no marker byte.
        return new TextDecoder().decode(data);
    }
  }

  private async loadEncryptionKey(): Promise<void> {
    const keyHex = await this.readEncryptionKeyHex();
    if (keyHex && this.vault) {
      await this.vault.setEncryptionKey(keyHex);
    }
  }

  // ===========================================================================
  // Peers
  // ===========================================================================

  async getTicket(): Promise<string> {
    if (!this.vault) throw new Error("Not initialized");
    return this.vault.getTicket();
  }

  async getPairingTicket(): Promise<string> {
    if (!this.vault) throw new Error("Not initialized");

    // Clean up expired nonces
    this.cleanupExpiredPairings();

    // Ensure we have an encryption key
    let keyHex = await this.vault.getEncryptionKey();
    if (!keyHex) {
      keyHex = await this.generateEncryptionKey();
    }

    const transportTicket = await this.vault.getTicket();

    // Generate a unique one-time nonce (32 random bytes as hex)
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    // Store the nonce with expiration (both local and WASM)
    const expiresAt = Date.now() + PeerVaultClient.PAIRING_TIMEOUT_MS;
    this.pendingPairings.set(nonce, expiresAt);
    this.vault.registerPairingNonce(nonce, expiresAt);
    // Do not log the nonce — it is a one-time pairing secret and logs are exportable.
    console.log("[PeerVault] Created pairing ticket (nonce expires in 10 min)");

    // Combine: base64(JSON({ t: ticket, k: key, v: vaultId, n: nonce }))
    const pairingData = {
      t: transportTicket,
      k: keyHex,
      v: this.config.vaultId,
      n: nonce,  // One-time pairing nonce
    };

    return btoa(JSON.stringify(pairingData));
  }

  private cleanupExpiredPairings(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.pendingPairings.entries()) {
      if (now > expiresAt) {
        this.pendingPairings.delete(nonce);
      }
    }
  }

  /**
   * Return the vault ID embedded in a pairing ticket, or null if the ticket is not
   * a pairing ticket. Used by the host to adopt a peer's vault ID before connecting.
   */
  peekVaultId(ticket: string): string | null {
    return this.parsePairingTicket(ticket)?.vaultId ?? null;
  }

  private parsePairingTicket(ticket: string): { transport: string; key: string; vaultId: string; nonce?: string } | null {
    try {
      const json = atob(ticket);
      const data = JSON.parse(json);
      if (data.t && data.k && data.v) {
        return { transport: data.t, key: data.k, vaultId: data.v, nonce: data.n };
      }
    } catch {
      // Not a pairing ticket
    }
    return null;
  }

  async addPeer(ticket: string, name?: string): Promise<string> {
    if (!this.vault) throw new Error("Not initialized");

    // Parse pairing ticket if provided
    const parsed = this.parsePairingTicket(ticket);
    let transportTicket = ticket;
    let pairingNonce: string | null = null;

    if (parsed) {
      transportTicket = parsed.transport;
      pairingNonce = parsed.nonce ?? null;

      // Validate vault ID (skip in test mode via SKIP_VAULT_ID_CHECK env)
      // @ts-ignore - window.process for Node-like env detection
      const skipCheck = typeof window !== 'undefined' && (window as any).E2E_SKIP_VAULT_ID_CHECK;
      if (!skipCheck && parsed.vaultId !== this.config.vaultId) {
        throw new Error("Vault ID mismatch - this ticket is for a different vault");
      }

      // ALWAYS use the shared encryption key from the pairing ticket
      // This ensures both vaults use the same key for data encryption
      if (parsed.key) {
        await this.setEncryptionKey(parsed.key);
        console.log("[PeerVault] Using shared encryption key from pairing ticket");
      }
    }

    // Connect to peer with pairing nonce (for one-time ticket validation).
    // Never log the nonce value itself.
    console.log(`[PeerVault] Connecting to peer (pairing nonce ${pairingNonce ? "present" : "absent"})`);
    let peerId: string;
    try {
      peerId = await this.vault.connectPeerWithPairing(
        transportTicket,
        pairingNonce,
        this.config.deviceName
      );
    } catch (e) {
      // Surface the actionable key-conflict case with a clear, distinct message.
      if (errorCode(e) === "KEY_CONFLICT") {
        throw new Error(
          "Pairing failed: this vault already has a different encryption key than the peer. " +
            "Both devices must share the same vault key."
        );
      }
      throw e;
    }

    // Add to peer list
    const peer: PeerInfo = {
      id: peerId,
      name: name ?? `Peer ${peerId.slice(0, 8)}`,
      ticket: transportTicket,
      lastSeen: Date.now(),
      isConnected: true,
    };

    this.peers.push(peer);
    await this.savePeers();

    this.emit({ type: "peer-connected", peerId, peerName: peer.name });

    return peerId;
  }

  /**
   * Compute the disk-reconciliation plan from the core. The core owns the
   * remote-deletion baseline, so every host gets identical deletion semantics.
   * `dirtyPaths`: paths with local edits not yet ingested (never deleted).
   */
  async reconcilePlan(dirtyPaths: string[]): Promise<ReconcilePlan> {
    if (!this.vault) throw new Error("Not initialized");
    const json = await this.vault.reconcilePlan(dirtyPaths);
    return JSON.parse(json) as ReconcilePlan;
  }

  async removePeer(peerId: string): Promise<void> {
    this.peers = this.peers.filter((p) => p.id !== peerId);
    // Keep the WASM core's known-peers set in lockstep with the TS peer list —
    // otherwise a removed peer stays authorized in the core and can re-pair/sync
    // silently (the two lists were drifting).
    try {
      this.vault?.removeKnownPeer(peerId);
    } catch (e) {
      console.warn("[PeerVault] removeKnownPeer failed:", e);
    }
    await this.savePeers();
  }

  getPeers(): PeerInfo[] {
    return [...this.peers];
  }

  // ===========================================================================
  // Sync
  // ===========================================================================

  async syncAll(): Promise<void> {
    // Single-flight: auto-sync, the "sync now" command, and the large-delta
    // fallback can all call this concurrently. Overlapping runs mutate shared peer
    // state and open redundant connections, so skip if one is already in progress.
    if (this._syncInProgress) {
      console.log("[PeerVault] syncAll already in progress, skipping");
      return;
    }
    this._syncInProgress = true;
    try {
      await this.syncAllInner();
    } finally {
      this._syncInProgress = false;
    }
  }

  private async syncAllInner(): Promise<void> {
    // Reconnect to all known peers and sync with timeout
    const syncTimeout = 15000; // 15 second timeout per peer

    // Log CRDT state before sync
    const beforeFiles = await this.listFiles();
    console.log(`[PeerVault] syncAll: CRDT has ${beforeFiles.length} files before sync`);

    for (const peer of this.peers) {
      try {
        console.log(`[PeerVault] Syncing with peer ${peer.name} (${peer.id.slice(0, 8)})...`);

        // Add timeout to prevent hanging
        const syncPromise = this.vault?.connectPeer(peer.ticket);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Sync timeout after ${syncTimeout}ms`)), syncTimeout);
        });

        const result = await Promise.race([syncPromise, timeoutPromise]);
        peer.lastSeen = Date.now();
        peer.isConnected = true;
        console.log(`[PeerVault] Sync with ${peer.name} completed, result: ${JSON.stringify(result)}`);

        // Log CRDT state after sync
        const afterFiles = await this.listFiles();
        console.log(`[PeerVault] After sync: CRDT has ${afterFiles.length} files`);
      } catch (e) {
        console.error(`[PeerVault] Failed to sync with ${peer.name}:`, e);
        peer.isConnected = false;
      }
    }
    await this.savePeers();
  }

  // ===========================================================================
  // Files (CRDT operations)
  // ===========================================================================

  async setFile(path: string, content: Uint8Array): Promise<void> {
    if (!this.vault) throw new Error("Not initialized");
    await this.vault.set(path, content);
    this.emit({ type: "file-changed", path, source: "local" });
  }

  async getFile(path: string): Promise<Uint8Array | null> {
    if (!this.vault) throw new Error("Not initialized");
    return this.vault.get(path);
  }

  async deleteFile(path: string): Promise<void> {
    if (!this.vault) throw new Error("Not initialized");
    await this.vault.delete(path);
    this.emit({ type: "file-changed", path, source: "local" });
  }

  async listFiles(prefix?: string): Promise<string[]> {
    if (!this.vault) throw new Error("Not initialized");
    const result = await this.vault.list(prefix ?? null);
    // WASM returns JSON string, parse it
    if (typeof result === "string") {
      try {
        return JSON.parse(result);
      } catch {
        return [];
      }
    }
    return Array.isArray(result) ? result : [];
  }

  // ===========================================================================
  // Events
  // ===========================================================================

  on(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private emit(event: ClientEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (e) {
        console.error("[PeerVault] Event handler error:", e);
      }
    }
  }

  private handleWasmEvent(eventJson: string): void {
    try {
      // Typed against the Rust-generated schema: the fields below are checked at
      // compile time, so a rename in the Rust `WasmEvent` breaks the build here.
      const event = JSON.parse(eventJson) as WasmEvent;
      console.log(`[PeerVault] WASM event: ${event.type}`, event);

      // Map WASM events to our client event types.
      switch (event.type) {
        case "peer_connected":
          this.emit({
            type: "peer-connected",
            peerId: event.peer_id,
            peerName: `Peer ${event.peer_id.slice(0, 8)}`,
          });
          break;

        case "sync_complete":
          this.emit({
            type: "sync-complete",
            peerId: event.peer_id,
            result: {
              success: true,
              peerId: event.peer_id,
              updatesReceived: event.updates_received,
              updatesSent: event.updates_sent,
            },
          });
          break;

        case "document_changed":
          // CRDT delta received via gossip — trigger full disk sync.
          this.emit({ type: "gossip-update", bytes: event.bytes });
          break;

        case "pairing_complete":
          // A peer connected with a valid one-time pairing nonce - auto-add them.
          // Fire-and-forget, but catch rejections (savePeers can fail on disk error).
          this.handlePairingComplete(event.peer_id, event.device_name).catch((e) =>
            console.error("[PeerVault] Failed to handle pairing complete:", e)
          );
          break;

        case "sync_needed":
          // Delta too large for gossip — trigger point-to-point sync (with guard).
          console.log(`[PeerVault] Sync needed: ${event.reason} (${event.size} bytes > ${event.max})`);
          // syncAll is now single-flight internally, so just call it.
          this.syncAll().catch((e) =>
            console.error("[PeerVault] Auto sync after large delta failed:", e)
          );
          break;

        case "gossip_neighbor_up":
          console.log(`[PeerVault] Gossip neighbor joined: ${event.peer_id}`);
          for (const peer of this.peers) {
            if (peer.id === event.peer_id) {
              peer.isConnected = true;
              peer.lastSeen = Date.now();
            }
          }
          break;

        case "gossip_neighbor_down":
          console.log(`[PeerVault] Gossip neighbor left: ${event.peer_id}`);
          for (const peer of this.peers) {
            if (peer.id === event.peer_id) {
              peer.isConnected = false;
            }
          }
          break;

        default: {
          // Exhaustiveness: if Rust adds a WasmEvent variant, this errors until
          // it's handled above.
          const _exhaustive: never = event;
          console.log(`[PeerVault] Unhandled WASM event:`, _exhaustive);
        }
      }
    } catch (e) {
      console.error("[PeerVault] Failed to parse WASM event:", e);
    }
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private async handlePairingComplete(peerId: string, deviceName?: string): Promise<void> {
    // Check if peer already exists
    const existing = this.peers.find((p) => p.id === peerId);
    if (existing) {
      console.log(`[PeerVault] Pairing complete - peer ${peerId.slice(0, 8)} already known`);
      existing.isConnected = true;
      existing.lastSeen = Date.now();
      return;
    }

    // Add the new peer
    const peer: PeerInfo = {
      id: peerId,
      name: deviceName ?? `Peer ${peerId.slice(0, 8)}`,
      ticket: "", // We don't have the ticket from this side
      lastSeen: Date.now(),
      isConnected: true,
    };

    this.peers.push(peer);
    await this.savePeers();

    console.log(`[PeerVault] Pairing complete - auto-added peer ${peerId.slice(0, 8)} (${peer.name})`);

    this.emit({
      type: "peer-connected",
      peerId: peerId,
      peerName: peer.name,
    });
  }

  private async loadPeers(): Promise<void> {
    const data = await this.storage.get("peers.json");
    if (data) {
      try {
        const text = new TextDecoder().decode(data);
        this.peers = JSON.parse(text);
        // Mark all as disconnected initially
        for (const peer of this.peers) {
          peer.isConnected = false;
        }
      } catch (e) {
        console.error("[PeerVault] Failed to load peers:", e);
        this.peers = [];
      }
    }
  }

  private async savePeers(): Promise<void> {
    const text = JSON.stringify(this.peers);
    const data = new TextEncoder().encode(text);
    await this.storage.set("peers.json", data);
  }

  // ===========================================================================
  // Accessors
  // ===========================================================================

  get nodeId(): string | null {
    return this._nodeId;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }
}
