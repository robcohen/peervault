//! WASM Bindings for PeerVault Core
//!
//! This module provides JavaScript-friendly bindings for the PeerVault core.
//! It exposes a high-level API that can be called from TypeScript/JavaScript.

#![cfg(feature = "wasm")]

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
use js_sys::{Promise, Function, Uint8Array};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::crypto::{VaultKey, CryptoError};
use crate::net::{IrohTransport, IrohConnection, IrohStream, Ticket};
use iroh::SecretKey;
use crate::store::{LoroStore, DocStore};
use crate::cloud::{CloudConfig, CloudSync, CloudSyncState, SyncPhase};
use crate::sync::SyncEngine;
use crate::runner::{SyncRunner, RunnerConfig, SyncStream, BlobOps};
use iroh_blobs::Hash;
use base64::Engine as _;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

/// Initialize the WASM module (call once at startup)
#[wasm_bindgen(start)]
pub fn init() {
    // Set up better panic messages in browser console
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    // Initialize tracing to output to browser console
    init_tracing();
}

/// Initialize tracing subscriber for WASM
///
/// This routes all tracing::debug!, tracing::info!, etc. to the browser console.
/// The default level is INFO, but can be adjusted with setLogLevel().
fn init_tracing() {
    use tracing_subscriber::prelude::*;

    // Build the subscriber - outputs to browser console via tracing-subscriber-wasm
    // NOTE: We explicitly avoid using any timer since std::time doesn't work in WASM
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)  // Browser console doesn't support ANSI colors
        .without_time()    // Critical: skip time since std::time panics in WASM
        .with_level(true)
        .with_target(true) // Show module paths
        .with_writer(tracing_subscriber_wasm::MakeConsoleWriter::default());

    // Use try_init to avoid panic if already initialized
    let _ = tracing_subscriber::registry()
        .with(fmt_layer)
        .with(tracing_subscriber::filter::LevelFilter::INFO)
        .try_init();
}

/// Set the logging level dynamically
///
/// Valid levels: "trace", "debug", "info", "warn", "error", "off"
#[wasm_bindgen(js_name = setLogLevel)]
pub fn set_log_level(level: &str) -> Result<(), JsValue> {
    // Note: Dynamic level changes require reload of the tracing subscriber
    // For now, this is a hint that users should use the browser console filtering
    web_sys::console::info_1(&JsValue::from_str(
        &format!("Log level hint: {}. Use browser console filtering for dynamic control.", level)
    ));
    Ok(())
}

// ============================================================================
// JavaScript Transport Provider
// ============================================================================

/// Peer address info for WASM
#[derive(Debug, Clone)]
struct WasmPeerAddress {
    peer_id: String,
    ticket: String,
    name: Option<String>,
}


/// Main PeerVault instance for WASM
///
/// This is the primary interface for JavaScript code to interact with PeerVault.
#[wasm_bindgen]
pub struct WasmPeerVault {
    /// The Iroh transport layer
    transport: Arc<RwLock<Option<IrohTransport>>>,
    /// The document store
    store: Arc<RwLock<Option<LoroStore>>>,
    /// Active peer connections (peer_id -> connection)
    connections: Arc<RwLock<HashMap<String, IrohConnection>>>,
    /// Vault ID (32 bytes)
    vault_id: [u8; 32],
    /// Device name
    device_name: String,
    /// Custom relay URL (if set, overrides default)
    relay_url: Option<String>,
    /// Event callback for JS
    on_event: Option<Function>,
    /// Storage change callback - called when store state changes
    /// Host should persist the state when this is called
    on_storage_change: Option<Function>,
    /// Encryption key for content (required for sync)
    encryption_key: Arc<RwLock<Option<VaultKey>>>,
    /// Cloud sync instance (optional)
    cloud_sync: Arc<RwLock<Option<CloudSync>>>,
    /// Pending pairing nonces (nonce_hex -> expires_at_ms)
    /// Used for one-time ticket validation.
    /// Plain std lock: only ever touched momentarily (never held across .await), so
    /// this avoids tokio's `blocking_*` which panics if called in an async context.
    pending_pairings: Arc<std::sync::RwLock<HashMap<String, u64>>>,
    /// Known peer IDs (peer_id -> added_at_ms)
    /// Peers that have successfully completed pairing. Plain std lock (see above).
    known_peers: Arc<std::sync::RwLock<HashMap<String, u64>>>,
    /// iroh-blobs bridge for V3 blob transfer
    blobs_bridge: Arc<RwLock<Option<crate::blobs_bridge::BlobsBridge>>>,
    /// iroh-gossip bridge for real-time CRDT delta broadcast
    gossip_bridge: Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
    /// Shutdown signal for background tasks (accept loop, gossip receiver/debounce).
    /// `stop()` sets it to `true`; long-running loops `select!` on it and exit.
    /// `start()` resets it to `false` so a stop→start cycle re-arms cleanly.
    shutdown: tokio::sync::watch::Sender<bool>,
}

#[wasm_bindgen]
impl WasmPeerVault {
    /// Create a new PeerVault instance
    ///
    /// @param vault_id - 32-byte vault identifier (hex string)
    /// @param device_name - Human-readable device name
    #[wasm_bindgen(constructor)]
    pub fn new(vault_id: &str, device_name: &str) -> Result<WasmPeerVault, JsValue> {
        let vault_id_bytes = hex::decode(vault_id)
            .map_err(|e| JsValue::from_str(&format!("Invalid vault_id hex: {}", e)))?;

        if vault_id_bytes.len() != 32 {
            return Err(JsValue::from_str("vault_id must be 32 bytes (64 hex chars)"));
        }

        let mut vault_id = [0u8; 32];
        vault_id.copy_from_slice(&vault_id_bytes);

        Ok(WasmPeerVault {
            transport: Arc::new(RwLock::new(None)),
            store: Arc::new(RwLock::new(None)),
            connections: Arc::new(RwLock::new(HashMap::new())),
            vault_id,
            device_name: device_name.to_string(),
            relay_url: None,
            on_event: None,
            on_storage_change: None,
            encryption_key: Arc::new(RwLock::new(None)),
            cloud_sync: Arc::new(RwLock::new(None)),
            pending_pairings: Arc::new(std::sync::RwLock::new(HashMap::new())),
            known_peers: Arc::new(std::sync::RwLock::new(HashMap::new())),
            blobs_bridge: Arc::new(RwLock::new(None)),
            gossip_bridge: Arc::new(RwLock::new(None)),
            shutdown: tokio::sync::watch::channel(false).0,
        })
    }

    /// Set the event callback
    ///
    /// The callback receives events as JSON strings with format:
    /// { "type": "event_type", "data": {...} }
    #[wasm_bindgen(js_name = setEventCallback)]
    pub fn set_event_callback(&mut self, callback: Function) {
        self.on_event = Some(callback);
    }

    /// Set the storage change callback
    ///
    /// This callback is invoked whenever the store state changes.
    /// The host should call `export()` and persist the result.
    ///
    /// For Obsidian: Save to `.obsidian/plugins/peervault/state.bin`
    /// For browser: Save to IndexedDB
    #[wasm_bindgen(js_name = setStorageCallback)]
    pub fn set_storage_callback(&mut self, callback: Function) {
        self.on_storage_change = Some(callback);
    }

    /// Set the relay URL to use for P2P connections
    ///
    /// Must be called before `start()` or `startWithState()`.
    /// If not set, the default relay (n0.computer) will be used.
    ///
    /// @param url - Relay URL (e.g., "https://use1-1.relay.n0.computer" or "http://localhost:3340")
    #[wasm_bindgen(js_name = setRelayUrl)]
    pub fn set_relay_url(&mut self, url: &str) {
        self.relay_url = Some(url.to_string());
    }

    /// Get the currently configured relay URL
    #[wasm_bindgen(js_name = getRelayUrl)]
    pub fn get_relay_url(&self) -> Option<String> {
        self.relay_url.clone()
    }

    // =========================================================================
    // Encryption Key Management
    // =========================================================================

    /// Generate a new random encryption key
    ///
    /// Call this when creating a new vault. The key should be persisted
    /// by the host (e.g., in Obsidian plugin settings).
    #[wasm_bindgen(js_name = generateEncryptionKey)]
    pub fn generate_encryption_key(&self) -> Promise {
        let key_store = self.encryption_key.clone();

        future_to_promise(async move {
            let key = VaultKey::generate();
            let key_bytes = key.as_bytes().to_vec();
            *key_store.write().await = Some(key);

            // Return the key as hex for storage
            Ok(JsValue::from_str(&hex::encode(&key_bytes)))
        })
    }

    /// Set encryption key from a hex string
    ///
    /// Use this to restore a previously generated key.
    #[wasm_bindgen(js_name = setEncryptionKey)]
    pub fn set_encryption_key(&self, key_hex: &str) -> Promise {
        let key_store = self.encryption_key.clone();
        let key_hex = key_hex.to_string();

        future_to_promise(async move {
            let key_bytes = hex::decode(&key_hex)
                .map_err(|e| JsValue::from_str(&format!("Invalid key hex: {}", e)))?;

            let key = VaultKey::from_bytes(&key_bytes)
                .map_err(|e| JsValue::from_str(&format!("Invalid key: {}", e)))?;

            *key_store.write().await = Some(key);
            Ok(JsValue::TRUE)
        })
    }

    /// Derive encryption key from a passphrase
    ///
    /// Use this when the user provides a passphrase instead of storing a key.
    /// The same passphrase + vault_id always produces the same key.
    #[wasm_bindgen(js_name = deriveEncryptionKey)]
    pub fn derive_encryption_key(&self, passphrase: &str) -> Promise {
        let key_store = self.encryption_key.clone();
        let vault_id = self.vault_id;
        let passphrase = passphrase.to_string();

        future_to_promise(async move {
            let key = VaultKey::from_passphrase(&passphrase, &vault_id)
                .map_err(|e| JsValue::from_str(&format!("Key derivation failed: {}", e)))?;

            *key_store.write().await = Some(key);
            Ok(JsValue::TRUE)
        })
    }

    /// Check if encryption key is set
    #[wasm_bindgen(js_name = hasEncryptionKey)]
    pub fn has_encryption_key(&self) -> Promise {
        let key_store = self.encryption_key.clone();

        future_to_promise(async move {
            let has_key = key_store.read().await.is_some();
            Ok(JsValue::from_bool(has_key))
        })
    }

    /// Get the current encryption key as hex (for backup/export)
    #[wasm_bindgen(js_name = getEncryptionKey)]
    pub fn get_encryption_key(&self) -> Promise {
        let key_store = self.encryption_key.clone();

        future_to_promise(async move {
            match key_store.read().await.as_ref() {
                Some(key) => Ok(JsValue::from_str(&hex::encode(key.as_bytes()))),
                None => Ok(JsValue::NULL),
            }
        })
    }

    /// Clear the encryption key from memory
    #[wasm_bindgen(js_name = clearEncryptionKey)]
    pub fn clear_encryption_key(&self) -> Promise {
        let key_store = self.encryption_key.clone();

        future_to_promise(async move {
            *key_store.write().await = None;
            Ok(JsValue::TRUE)
        })
    }

    // =========================================================================
    // Blob Encryption (for P2P transfer)
    // =========================================================================

    /// Encrypt blob data for P2P transfer
    ///
    /// Use this to encrypt blob data before sending to a peer.
    /// Requires that a vault key is set.
    #[wasm_bindgen(js_name = encryptBlob)]
    pub fn encrypt_blob(&self, data: &Uint8Array) -> Promise {
        let encryption_key = self.encryption_key.clone();
        let data = data.to_vec();

        future_to_promise(async move {
            let key = encryption_key.read().await.clone()
                .ok_or_else(|| JsValue::from_str("No encryption key set"))?;

            let encrypted = key.encrypt(&data)
                .map_err(|e| JsValue::from_str(&format!("Encryption failed: {}", e)))?;

            let arr = Uint8Array::new_with_length(encrypted.len() as u32);
            arr.copy_from(&encrypted);
            Ok(arr.into())
        })
    }

    /// Decrypt blob data received from peer
    ///
    /// Use this to decrypt blob data received from a peer.
    /// Requires that a vault key is set.
    #[wasm_bindgen(js_name = decryptBlob)]
    pub fn decrypt_blob(&self, encrypted_data: &Uint8Array) -> Promise {
        let encryption_key = self.encryption_key.clone();
        let data = encrypted_data.to_vec();

        future_to_promise(async move {
            let key = encryption_key.read().await.clone()
                .ok_or_else(|| JsValue::from_str("No encryption key set"))?;

            let decrypted = key.decrypt(&data)
                .map_err(|e| JsValue::from_str(&format!("Decryption failed: {}", e)))?;

            let arr = Uint8Array::new_with_length(decrypted.len() as u32);
            arr.copy_from(&decrypted);
            Ok(arr.into())
        })
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /// Start the PeerVault (initializes transport and store)
    ///
    /// This also starts a background accept loop that listens for incoming
    /// peer connections and emits events via the event callback.
    #[wasm_bindgen]
    pub fn start(&self) -> Promise {
        let transport = self.transport.clone();
        let store = self.store.clone();
        let connections = self.connections.clone();
        let vault_id = self.vault_id;
        let _device_name = self.device_name.clone();
        let relay_url = self.relay_url.clone();
        let on_event = self.on_event.clone();
        let pending_pairings = self.pending_pairings.clone();
        let known_peers = self.known_peers.clone();
        let blobs_bridge = self.blobs_bridge.clone();
        let gossip_bridge_arc = self.gossip_bridge.clone();
        let encryption_key = self.encryption_key.clone();
        // Re-arm the shutdown signal (so a stop→start cycle works) and hand the
        // accept loop a receiver it selects on.
        let _ = self.shutdown.send(false);
        let shutdown_rx = self.shutdown.subscribe();

        future_to_promise(async move {
            // Create BlobsBridge
            let host = Arc::new(crate::host::mock::MockHost::new());
            let blob_bridge = crate::blobs_bridge::BlobsBridge::new(host)
                .map_err(|e| JsValue::from_str(&format!("Failed to create blobs bridge: {}", e)))?;
            let mem_store = blob_bridge.mem_store().clone();

            // Build endpoint, then create GossipBridge (needs endpoint for Gossip),
            // then create transport (registers Gossip on Router)
            use iroh::{RelayMap, RelayMode, RelayUrl};
            let secret_key = SecretKey::generate();
            let relay_mode = match relay_url.as_deref() {
                Some(url) => {
                    let relay: RelayUrl = url.parse()
                        .map_err(|e| JsValue::from_str(&format!("Invalid relay URL: {}", e)))?;
                    RelayMode::Custom(RelayMap::from_iter(vec![relay]))
                }
                None => {
                    let relay: RelayUrl = "https://use1-1.relay.n0.computer".parse()
                        .map_err(|e| JsValue::from_str(&format!("Default relay URL parse failed: {}", e)))?;
                    RelayMode::Custom(RelayMap::from_iter(vec![relay]))
                }
            };
            let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .secret_key(secret_key.clone())
                .relay_mode(relay_mode)
                .bind()
                .await
                .map_err(|e| JsValue::from_str(&format!("Endpoint bind failed: {}", e)))?;

            // GossipBridge creates Gossip bound to this endpoint
            let gossip_br = crate::gossip_bridge::GossipBridge::new(&endpoint, vault_id);

            // Transport registers the same Gossip on its Router
            let iroh_transport = IrohTransport::from_endpoint(
                endpoint,
                secret_key,
                mem_store,
                gossip_br.gossip().clone(),
            );

            // Create the store
            let loro_store = LoroStore::new(vault_id);

            // Store them
            *transport.write().await = Some(iroh_transport);
            *store.write().await = Some(loro_store);
            *blobs_bridge.write().await = Some(blob_bridge);
            *gossip_bridge_arc.write().await = Some(gossip_br);

            // Start accept loop in background
            let transport_for_accept = transport.clone();
            let connections_for_accept = connections.clone();
            let store_for_accept = store.clone();
            let on_event_for_accept = on_event.clone();
            let pending_pairings_for_accept = pending_pairings.clone();
            let known_peers_for_accept = known_peers.clone();
            let encryption_key_for_accept = encryption_key.clone();
            let blobs_bridge_for_accept = blobs_bridge.clone();
            let gossip_bridge_for_accept = gossip_bridge_arc.clone();
            let shutdown_for_accept = shutdown_rx.clone();
            wasm_bindgen_futures::spawn_local(async move {
                run_accept_loop(
                    transport_for_accept,
                    connections_for_accept,
                    store_for_accept,
                    on_event_for_accept,
                    pending_pairings_for_accept,
                    known_peers_for_accept,
                    encryption_key_for_accept,
                    blobs_bridge_for_accept,
                    gossip_bridge_for_accept,
                    shutdown_for_accept,
                ).await;
            });

            Ok(JsValue::TRUE)
        })
    }

    /// Start with previously persisted state
    ///
    /// Use this instead of `start()` when you have saved state from a previous session.
    /// Pass the data from a previous `export()` call.
    #[wasm_bindgen(js_name = startWithState)]
    pub fn start_with_state(&self, initial_state: &Uint8Array) -> Promise {
        let transport = self.transport.clone();
        let store = self.store.clone();
        let connections = self.connections.clone();
        let vault_id = self.vault_id;
        let _device_name = self.device_name.clone();
        let relay_url = self.relay_url.clone();
        let initial_data = initial_state.to_vec();
        let on_event = self.on_event.clone();
        let pending_pairings = self.pending_pairings.clone();
        let known_peers = self.known_peers.clone();
        let blobs_bridge = self.blobs_bridge.clone();
        let gossip_bridge_arc = self.gossip_bridge.clone();
        let encryption_key = self.encryption_key.clone();
        // Re-arm the shutdown signal (so a stop→start cycle works) and hand the
        // accept loop a receiver it selects on.
        let _ = self.shutdown.send(false);
        let shutdown_rx = self.shutdown.subscribe();

        future_to_promise(async move {
            // Create BlobsBridge
            let host = Arc::new(crate::host::mock::MockHost::new());
            let bridge = crate::blobs_bridge::BlobsBridge::new(host)
                .map_err(|e| JsValue::from_str(&format!("Failed to create blobs bridge: {}", e)))?;
            let mem_store = bridge.mem_store().clone();

            // Build endpoint, GossipBridge, then transport (same as start())
            use iroh::{RelayMap, RelayMode, RelayUrl};
            let secret_key = SecretKey::generate();
            let relay_mode = match relay_url.as_deref() {
                Some(url) => {
                    let relay: RelayUrl = url.parse()
                        .map_err(|e| JsValue::from_str(&format!("Invalid relay URL: {}", e)))?;
                    RelayMode::Custom(RelayMap::from_iter(vec![relay]))
                }
                None => {
                    let relay: RelayUrl = "https://use1-1.relay.n0.computer".parse()
                        .map_err(|e| JsValue::from_str(&format!("Default relay URL parse failed: {}", e)))?;
                    RelayMode::Custom(RelayMap::from_iter(vec![relay]))
                }
            };
            let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .secret_key(secret_key.clone())
                .relay_mode(relay_mode)
                .bind()
                .await
                .map_err(|e| JsValue::from_str(&format!("Endpoint bind failed: {}", e)))?;

            let gossip_br = crate::gossip_bridge::GossipBridge::new(&endpoint, vault_id);
            let iroh_transport = IrohTransport::from_endpoint(
                endpoint, secret_key, mem_store, gossip_br.gossip().clone(),
            );

            // Create the store and import saved state
            let loro_store = LoroStore::new(vault_id);
            loro_store.import_snapshot(&initial_data)
                .map_err(|e| JsValue::from_str(&format!("Failed to import state: {}", e)))?;

            // Store them
            *transport.write().await = Some(iroh_transport);
            *store.write().await = Some(loro_store);
            *blobs_bridge.write().await = Some(bridge);
            *gossip_bridge_arc.write().await = Some(gossip_br);

            // Start accept loop in background
            let transport_for_accept = transport.clone();
            let connections_for_accept = connections.clone();
            let store_for_accept = store.clone();
            let on_event_for_accept = on_event.clone();
            let pending_pairings_for_accept = pending_pairings.clone();
            let known_peers_for_accept = known_peers.clone();
            let encryption_key_for_accept = encryption_key.clone();
            let blobs_bridge_for_accept = blobs_bridge.clone();
            let gossip_bridge_for_accept = gossip_bridge_arc.clone();
            let shutdown_for_accept = shutdown_rx.clone();
            wasm_bindgen_futures::spawn_local(async move {
                run_accept_loop(
                    transport_for_accept,
                    connections_for_accept,
                    store_for_accept,
                    on_event_for_accept,
                    pending_pairings_for_accept,
                    known_peers_for_accept,
                    encryption_key_for_accept,
                    blobs_bridge_for_accept,
                    gossip_bridge_for_accept,
                    shutdown_for_accept,
                ).await;
            });

            Ok(JsValue::TRUE)
        })
    }

    /// Stop the PeerVault
    #[wasm_bindgen]
    pub fn stop(&self) -> Promise {
        let transport = self.transport.clone();

        // Signal shutdown FIRST, before contending for the transport write lock.
        // The accept loop holds a transport read guard across `accept().await`; the
        // signal makes it break and release the guard so `take()` below can proceed
        // (otherwise stop() would hang until a connection happened to arrive).
        let _ = self.shutdown.send(true);

        future_to_promise(async move {
            if let Some(t) = transport.write().await.take() {
                t.close().await;
            }
            Ok(JsValue::TRUE)
        })
    }

    /// Get our connection ticket for sharing with peers
    #[wasm_bindgen(js_name = getTicket)]
    pub fn get_ticket(&self) -> Promise {
        let transport = self.transport.clone();

        future_to_promise(async move {
            let guard = transport.read().await;
            let t = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Transport not started"))?;

            let ticket = t.create_ticket()
                .await
                .map_err(|e| JsValue::from_str(&format!("Failed to create ticket: {}", e)))?;

            Ok(JsValue::from_str(&ticket.to_string()))
        })
    }

    /// Get our node ID (public key)
    #[wasm_bindgen(js_name = getNodeId)]
    pub fn get_node_id(&self) -> Promise {
        let transport = self.transport.clone();

        future_to_promise(async move {
            let guard = transport.read().await;
            let t = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Transport not started"))?;

            Ok(JsValue::from_str(&t.node_id().to_string()))
        })
    }

    // =========================================================================
    // Pairing Management
    // =========================================================================

    /// Register a one-time pairing nonce
    ///
    /// Called by JS when generating a pairing ticket. The nonce can only be
    /// used once and expires after the given timestamp.
    #[wasm_bindgen(js_name = registerPairingNonce)]
    pub fn register_pairing_nonce(&self, nonce: &str, expires_at_ms: f64) {
        let mut pending = self.pending_pairings.write().unwrap();
        pending.insert(nonce.to_string(), expires_at_ms as u64);
        web_sys::console::log_1(&JsValue::from_str(&format!(
            "[WASM] Registered pairing nonce: {}...",
            short(&nonce, 16)
        )));
    }

    /// Validate and consume a pairing nonce
    ///
    /// Returns true if the nonce was valid and has been consumed.
    /// Returns false if the nonce was invalid, expired, or already used.
    #[wasm_bindgen(js_name = validatePairingNonce)]
    pub fn validate_pairing_nonce(&self, nonce: &str) -> bool {
        let mut pending = self.pending_pairings.write().unwrap();

        // Check if nonce exists
        if let Some(&expires_at) = pending.get(nonce) {
            // Check if expired
            let now = js_sys::Date::now() as u64;
            if now > expires_at {
                pending.remove(nonce);
                web_sys::console::log_1(&JsValue::from_str(&format!(
                    "[WASM] Pairing nonce expired: {}...",
                    short(&nonce, 16)
                )));
                return false;
            }

            // Valid - consume it
            pending.remove(nonce);
            web_sys::console::log_1(&JsValue::from_str(&format!(
                "[WASM] Pairing nonce validated and consumed: {}...",
                short(&nonce, 16)
            )));
            true
        } else {
            web_sys::console::log_1(&JsValue::from_str(&format!(
                "[WASM] Unknown pairing nonce: {}...",
                short(&nonce, 16)
            )));
            false
        }
    }

    /// Check if a peer is known (already paired)
    #[wasm_bindgen(js_name = isKnownPeer)]
    pub fn is_known_peer(&self, peer_id: &str) -> bool {
        self.known_peers.read().unwrap().contains_key(peer_id)
    }

    /// Add a peer to the known peers list
    #[wasm_bindgen(js_name = addKnownPeer)]
    pub fn add_known_peer(&self, peer_id: &str) {
        let now = js_sys::Date::now() as u64;
        self.known_peers.write().unwrap().insert(peer_id.to_string(), now);
        web_sys::console::log_1(&JsValue::from_str(&format!(
            "[WASM] Added known peer: {}...",
            short(&peer_id, 16)
        )));
    }

    /// Remove a peer from the known peers list
    #[wasm_bindgen(js_name = removeKnownPeer)]
    pub fn remove_known_peer(&self, peer_id: &str) {
        self.known_peers.write().unwrap().remove(peer_id);
    }

    /// Get list of known peer IDs
    #[wasm_bindgen(js_name = getKnownPeers)]
    pub fn get_known_peers(&self) -> Vec<JsValue> {
        self.known_peers.read().unwrap()
            .keys()
            .map(|k| JsValue::from_str(k))
            .collect()
    }

    // =========================================================================
    // Peer Connection
    // =========================================================================

    /// Connect to a peer using their ticket and run sync
    ///
    /// This connects to the peer, stores the connection, opens a stream,
    /// and runs the sync protocol to exchange CRDT updates.
    ///
    /// For new pairing, use connectPeerWithPairing instead.
    #[wasm_bindgen(js_name = connectPeer)]
    pub fn connect_peer(&self, ticket_str: &str) -> Promise {
        self.connect_peer_with_pairing(ticket_str, JsValue::NULL, JsValue::NULL)
    }

    /// Connect to a peer with pairing nonce for one-time pairing
    ///
    /// This is the same as connectPeer but includes the pairing nonce
    /// for validating new peer connections.
    #[wasm_bindgen(js_name = connectPeerWithPairing)]
    pub fn connect_peer_with_pairing(
        &self,
        ticket_str: &str,
        pairing_nonce: JsValue,
        our_device_name: JsValue,
    ) -> Promise {
        let transport = self.transport.clone();
        let connections = self.connections.clone();
        let store = self.store.clone();
        let device_name = self.device_name.clone();
        let on_event = self.on_event.clone();
        let encryption_key = self.encryption_key.clone();
        let blobs_bridge = self.blobs_bridge.clone();
        let gossip_bridge = self.gossip_bridge.clone();
        let shutdown = self.shutdown.subscribe();
        let ticket_str = ticket_str.to_string();

        // Convert JsValue to Option<String>
        let pairing_nonce: Option<String> = if pairing_nonce.is_null() || pairing_nonce.is_undefined() {
            None
        } else {
            pairing_nonce.as_string()
        };

        future_to_promise(async move {
            info!("connectPeer: parsing ticket, nonce={}",
                pairing_nonce.as_deref().map(|n| short(n, 16)).unwrap_or("none"));
            let ticket = Ticket::from_string(&ticket_str)
                .map_err(|e| JsValue::from_str(&format!("Invalid ticket: {}", e)))?;

            let peer_id = ticket.node_id.to_string();
            info!("connectPeer: peer_id={}", short(&peer_id, 16));

            // Helper: create SyncEngine from store + key
            async fn create_sync_engine(
                store: &Arc<RwLock<Option<LoroStore>>>,
                enc_key: &Arc<RwLock<Option<VaultKey>>>,
            ) -> Result<SyncEngine, JsValue> {
                let store_guard = store.read().await;
                let loro_store = store_guard.as_ref()
                    .ok_or_else(|| JsValue::from_str("Store not initialized"))?;
                let key_guard = enc_key.read().await;
                let vault_key = key_guard.clone()
                    .ok_or_else(|| JsValue::from_str("No encryption key"))?;
                drop(key_guard);
                let real_vault_id = *loro_store.vault_id();
                let host = Arc::new(crate::host::mock::MockHost::new());
                let mut engine = SyncEngine::new_with_key(host, vault_key)
                    .map_err(|e| JsValue::from_str(&format!("SyncEngine: {}", e)))?;
                // Carry the real vault id into the temporary sync engine so the
                // VERSION_INFO we send advertises the actual vault (new_with_key
                // starts at all-zeros and import does not restore it). Must run
                // before import so the data lands in the correctly-identified store.
                engine.init_vault(real_vault_id);
                let snapshot = loro_store.export_snapshot()
                    .map_err(|e| JsValue::from_str(&format!("Export snapshot: {}", e)))?;
                drop(store_guard);
                engine.import_snapshot_raw(&snapshot)
                    .map_err(|e| JsValue::from_str(&format!("Import snapshot: {}", e)))?;
                Ok(engine)
            }

            // Helper: import results back
            async fn import_engine_results(
                engine: &SyncEngine,
                store: &Arc<RwLock<Option<LoroStore>>>,
            ) -> Result<(), JsValue> {
                let updated = engine.export_snapshot_raw()
                    .map_err(|e| JsValue::from_str(&format!("Export: {}", e)))?;
                let store_guard = store.read().await;
                let loro_store = store_guard.as_ref()
                    .ok_or_else(|| JsValue::from_str("Store not initialized"))?;
                loro_store.import_snapshot(&updated)
                    .map_err(|e| JsValue::from_str(&format!("Import: {}", e)))?;
                Ok(())
            }

            // Get or create connection
            let mut stream = {
                // Check existing connection
                let connections_guard = connections.read().await;
                if let Some(existing_conn) = connections_guard.get(&peer_id) {
                    if !existing_conn.is_closed() {
                        info!("connectPeer: reusing existing connection to {}", short(&peer_id, 16));
                        let s = existing_conn.open_stream().await
                            .map_err(|e| JsValue::from_str(&format!("Open stream: {}", e)))?;
                        drop(connections_guard);
                        s
                    } else {
                        drop(connections_guard);
                        // Fall through to new connection
                        info!("connectPeer: connecting...");
                        let connection = {
                            let guard = transport.read().await;
                            let t = guard.as_ref()
                                .ok_or_else(|| JsValue::from_str("Transport not started"))?;
                            t.connect(&ticket).await
                                .map_err(|e| JsValue::from_str(&format!("Connect failed: {}", e)))?
                        };
                        connections.write().await.insert(peer_id.clone(), connection);
                        let cg = connections.read().await;
                        let conn = cg.get(&peer_id).ok_or_else(|| JsValue::from_str("Connection lost"))?;
                        let s = conn.open_stream().await
                            .map_err(|e| JsValue::from_str(&format!("Open stream: {}", e)))?;
                        drop(cg);
                        s
                    }
                } else {
                    drop(connections_guard);
                    info!("connectPeer: connecting...");
                    let connection = {
                        let guard = transport.read().await;
                        let t = guard.as_ref()
                            .ok_or_else(|| JsValue::from_str("Transport not started"))?;
                        t.connect(&ticket).await
                            .map_err(|e| JsValue::from_str(&format!("Connect failed: {}", e)))?
                    };
                    info!("connectPeer: connected!");
                    connections.write().await.insert(peer_id.clone(), connection);
                    let cg = connections.read().await;
                    let conn = cg.get(&peer_id).ok_or_else(|| JsValue::from_str("Connection lost"))?;
                    let s = conn.open_stream().await
                        .map_err(|e| JsValue::from_str(&format!("Open stream: {}", e)))?;
                    drop(cg);
                    s
                }
            };

            // Run V3 sync
            let engine = create_sync_engine(&store, &encryption_key).await?;

            let bridge_guard = blobs_bridge.read().await;
            let transport_guard = transport.read().await;

            run_initiator_sync_v3(
                &peer_id,
                &mut stream,
                &engine,
                &device_name,
                None,
                None,
                pairing_nonce,
                bridge_guard.as_ref(),
                transport_guard.as_ref().map(|t| t.endpoint()),
                &on_event,
            ).await?;

            drop(bridge_guard);
            drop(transport_guard);

            import_engine_results(&engine, &store).await?;

            // Subscribe to gossip for real-time updates with this peer
            let gossip_guard = gossip_bridge.read().await;
            if let Some(ref gb) = *gossip_guard {
                let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
                    .map_err(|e| JsValue::from_str(&format!("Invalid peer ID: {}", e)))?;
                match gb.subscribe_with_receiver(vec![peer_endpoint_id]).await {
                    Ok(Some(receiver)) => {
                        // First subscription — spawn receiver + debounce tasks
                        let store_for_gossip = store.clone();
                        let enc_key_for_gossip = encryption_key.clone();
                        let on_event_for_gossip = on_event.clone();
                        let shutdown_for_gossip = shutdown.clone();
                        wasm_bindgen_futures::spawn_local(async move {
                            run_gossip_receiver(
                                receiver,
                                store_for_gossip,
                                enc_key_for_gossip,
                                on_event_for_gossip,
                                shutdown_for_gossip,
                            ).await;
                        });

                        // Spawn debounce task
                        let gb_for_debounce = gossip_bridge.clone();
                        let store_for_debounce = store.clone();
                        let enc_for_debounce = encryption_key.clone();
                        let notify = gb.change_notify();
                        let on_event_for_debounce = on_event.clone();
                        let shutdown_for_debounce = shutdown.clone();
                        wasm_bindgen_futures::spawn_local(async move {
                            run_gossip_debounce(
                                gb_for_debounce,
                                store_for_debounce,
                                enc_for_debounce,
                                notify,
                                on_event_for_debounce,
                                shutdown_for_debounce,
                            ).await;
                        });
                    }
                    Ok(None) => {} // Already subscribed, peers added
                    Err(e) => {
                        warn!("Failed to subscribe to gossip: {}", e);
                    }
                }
            }
            drop(gossip_guard);

            Ok(JsValue::from_str(&peer_id))
        })
    }

    /// Set a document in the store
    ///
    /// If an encryption key is set, content will be encrypted before storage.
    #[wasm_bindgen]
    pub fn set(&self, key: &str, content: &Uint8Array) -> Promise {
        let store = self.store.clone();
        let encryption_key = self.encryption_key.clone();
        let gossip_bridge = self.gossip_bridge.clone();
        let key = key.to_string();
        let content = content.to_vec();

        future_to_promise(async move {
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Store not started"))?;

            // Capture version vector before write (for delta export)
            let vv_before = s.version_vector();

            // Encrypt content if key is available
            let content_to_store = match encryption_key.read().await.as_ref() {
                Some(enc_key) => {
                    enc_key.encrypt(&content)
                        .map_err(|e| JsValue::from_str(&format!("Encryption failed: {}", e)))?
                }
                None => content,
            };

            // Convert bytes to string (base64 for encrypted, UTF-8 for plaintext)
            use base64::Engine;
            let content_str = if encryption_key.read().await.is_some() {
                base64::engine::general_purpose::STANDARD.encode(&content_to_store)
            } else {
                String::from_utf8_lossy(&content_to_store).to_string()
            };

            s.set_text(&key, &content_str)
                .map_err(|e| JsValue::from_str(&format!("Failed to set: {}", e)))?;

            // Notify gossip of change (debounced — will batch and broadcast)
            let gossip_guard = gossip_bridge.read().await;
            if let Some(ref gb) = *gossip_guard {
                if gb.is_subscribed().await {
                    gb.notify_change(vv_before).await;
                }
            }

            Ok(JsValue::TRUE)
        })
    }

    /// Get a document from the store
    ///
    /// If an encryption key is set, content will be decrypted after retrieval.
    #[wasm_bindgen]
    pub fn get(&self, key: &str) -> Promise {
        let store = self.store.clone();
        let encryption_key = self.encryption_key.clone();
        let key = key.to_string();

        future_to_promise(async move {
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Store not started"))?;

            let content_opt = s.get_text(&key)
                .map_err(|e| JsValue::from_str(&format!("Failed to get: {}", e)))?;

            match content_opt {
                Some(content_str) => {
                    use base64::Engine;

                    // Try to decode from base64 (encrypted content) first
                    // If that fails, content was stored as raw text (before encryption was enabled)
                    let maybe_enc_key = encryption_key.read().await;
                    let plaintext = if let Some(enc_key) = maybe_enc_key.as_ref() {
                        // Try base64 decode first (encrypted format)
                        match base64::engine::general_purpose::STANDARD.decode(&content_str) {
                            Ok(decoded) => {
                                // Successfully decoded base64, now decrypt
                                enc_key.decrypt(&decoded)
                                    .map_err(|e| JsValue::from_str(&format!("Decryption failed: {}", e)))?
                            }
                            Err(_) => {
                                // Base64 decode failed - content is raw text (stored before encryption was enabled)
                                // Return as-is without decryption
                                content_str.into_bytes()
                            }
                        }
                    } else {
                        // No encryption key - content is raw bytes
                        content_str.into_bytes()
                    };

                    let arr = Uint8Array::new_with_length(plaintext.len() as u32);
                    arr.copy_from(&plaintext);
                    Ok(arr.into())
                }
                None => Ok(JsValue::NULL),
            }
        })
    }

    /// Delete a document from the store
    #[wasm_bindgen]
    pub fn delete(&self, key: &str) -> Promise {
        let store = self.store.clone();
        let encryption_key = self.encryption_key.clone();
        let gossip_bridge = self.gossip_bridge.clone();
        let key = key.to_string();

        future_to_promise(async move {
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Store not started"))?;

            // Capture VV before delete (for delta export)
            let vv_before = s.version_vector();

            s.delete_file(&key)
                .map_err(|e| JsValue::from_str(&format!("Failed to delete: {}", e)))?;

            // Notify gossip of change (debounced)
            let gossip_guard = gossip_bridge.read().await;
            if let Some(ref gb) = *gossip_guard {
                if gb.is_subscribed().await {
                    gb.notify_change(vv_before).await;
                }
            }

            Ok(JsValue::TRUE)
        })
    }

    /// List all documents (optionally filtered by prefix)
    #[wasm_bindgen]
    pub fn list(&self, prefix: Option<String>) -> Promise {
        let store = self.store.clone();

        future_to_promise(async move {
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Store not started"))?;

            let files = s.list_files(prefix.as_deref())
                .map_err(|e| JsValue::from_str(&format!("Failed to list: {}", e)))?;

            // Convert to JSON array of paths
            let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
            let json = serde_json::to_string(&paths)
                .map_err(|e| JsValue::from_str(&format!("Failed to serialize: {}", e)))?;

            Ok(JsValue::from_str(&json))
        })
    }

    /// Get the version vector of the store (for comparing sync state)
    ///
    /// Returns a hex-encoded version vector that can be compared between peers.
    #[wasm_bindgen(js_name = getVersionVector)]
    pub fn get_version_vector(&self) -> Promise {
        let store = self.store.clone();

        future_to_promise(async move {
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Store not started"))?;

            let vv = s.version_vector();
            Ok(JsValue::from_str(&hex::encode(&vv)))
        })
    }

    /// Export the store state as a serialized blob
    #[wasm_bindgen]
    pub fn export(&self) -> Promise {
        let store = self.store.clone();

        future_to_promise(async move {
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Store not started"))?;

            let data = s.export_snapshot()
                .map_err(|e| JsValue::from_str(&format!("Failed to export: {}", e)))?;

            let arr = Uint8Array::new_with_length(data.len() as u32);
            arr.copy_from(&data);
            Ok(arr.into())
        })
    }

    /// Import store state from a serialized blob
    #[wasm_bindgen]
    pub fn import(&self, data: &Uint8Array) -> Promise {
        let store = self.store.clone();
        let data = data.to_vec();

        future_to_promise(async move {
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Store not started"))?;

            s.import_snapshot(&data)
                .map_err(|e| JsValue::from_str(&format!("Failed to import: {}", e)))?;

            Ok(JsValue::TRUE)
        })
    }

    // =========================================================================
    // Cloud Sync
    // =========================================================================

    /// Configure cloud storage (S3-compatible)
    ///
    /// @param config - JSON object with cloud configuration:
    /// {
    ///   "endpoint": "https://s3.amazonaws.com",
    ///   "bucket": "my-bucket",
    ///   "region": "us-east-1",
    ///   "accessKeyId": "...",
    ///   "secretAccessKey": "...",
    ///   "pathPrefix": "backups/vault1" (optional)
    /// }
    #[wasm_bindgen(js_name = configureCloudStorage)]
    pub fn configure_cloud_storage(&self, config_json: &str) -> Promise {
        let cloud_sync_store = self.cloud_sync.clone();
        let encryption_key = self.encryption_key.clone();
        let config_json = config_json.to_string();

        future_to_promise(async move {
            // Parse config
            let config: CloudConfigJs = serde_json::from_str(&config_json)
                .map_err(|e| JsValue::from_str(&format!("Invalid config JSON: {}", e)))?;

            // Require encryption key
            let key_guard = encryption_key.read().await;
            let vault_key = key_guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Encryption key must be set before configuring cloud storage"))?;

            // Create CloudConfig
            let cloud_config = CloudConfig::new(
                &config.endpoint,
                &config.bucket,
                &config.region,
                &config.access_key_id,
                &config.secret_access_key,
            )
            .with_prefix(&config.path_prefix.unwrap_or_default())
            .with_insecure_http(config.allow_insecure_http.unwrap_or(false));

            // Create CloudSync instance
            let cloud = CloudSync::new(cloud_config, vault_key.as_bytes())
                .map_err(|e| JsValue::from_str(&format!("Failed to create cloud sync: {}", e)))?;

            *cloud_sync_store.write().await = Some(cloud);

            Ok(JsValue::TRUE)
        })
    }

    /// Sync with cloud storage
    ///
    /// Uploads local changes and downloads remote changes.
    /// Returns a JSON object with sync statistics.
    #[wasm_bindgen(js_name = syncCloud)]
    pub fn sync_cloud(&self) -> Promise {
        let cloud_sync = self.cloud_sync.clone();
        let store = self.store.clone();

        future_to_promise(async move {
            let mut cloud_guard = cloud_sync.write().await;
            let cloud = cloud_guard.as_mut()
                .ok_or_else(|| JsValue::from_str("Cloud storage not configured"))?;

            let store_guard = store.read().await;
            let loro_store = store_guard.as_ref()
                .ok_or_else(|| JsValue::from_str("Store not started"))?;

            // CloudSync works directly with LoroStore via CloudSyncable trait
            let result = cloud.sync(loro_store).await
                .map_err(|e| JsValue::from_str(&format!("Cloud sync failed: {}", e)))?;

            // Return result as JSON
            let result_json = serde_json::json!({
                "deltasUploaded": result.deltas_uploaded,
                "deltasDownloaded": result.deltas_downloaded,
                "blobsUploaded": result.blobs_uploaded,
                "blobsDownloaded": result.blobs_downloaded,
                "bytesUploaded": result.bytes_uploaded,
                "bytesDownloaded": result.bytes_downloaded,
                "compacted": result.compacted,
                "errors": result.errors,
            });

            Ok(JsValue::from_str(&result_json.to_string()))
        })
    }

    /// Get cloud sync status
    ///
    /// Returns JSON with current sync state:
    /// {
    ///   "phase": "idle" | "preparing" | "downloading" | "uploading" | "compacting" | "finalizing" | "error",
    ///   "pendingUploads": number,
    ///   "pendingDownloads": number,
    ///   "lastSyncedAt": string | null,
    ///   "error": string | null
    /// }
    #[wasm_bindgen(js_name = getCloudStatus)]
    pub fn get_cloud_status(&self) -> Promise {
        let cloud_sync = self.cloud_sync.clone();

        future_to_promise(async move {
            let guard = cloud_sync.read().await;

            match guard.as_ref() {
                Some(cloud) => {
                    let state = cloud.state();
                    let phase_str = match state.phase {
                        SyncPhase::Idle => "idle",
                        SyncPhase::Preparing => "preparing",
                        SyncPhase::Downloading => "downloading",
                        SyncPhase::Uploading => "uploading",
                        SyncPhase::Compacting => "compacting",
                        SyncPhase::Finalizing => "finalizing",
                        SyncPhase::Error => "error",
                    };

                    let status_json = serde_json::json!({
                        "configured": true,
                        "phase": phase_str,
                        "pendingUploads": state.pending_uploads,
                        "pendingDownloads": state.pending_downloads,
                        "lastSyncedAt": state.last_synced_at,
                        "error": state.error,
                    });

                    Ok(JsValue::from_str(&status_json.to_string()))
                }
                None => {
                    let status_json = serde_json::json!({
                        "configured": false,
                        "phase": "idle",
                        "pendingUploads": 0,
                        "pendingDownloads": 0,
                        "lastSyncedAt": null,
                        "error": null,
                    });

                    Ok(JsValue::from_str(&status_json.to_string()))
                }
            }
        })
    }

    /// Upload a blob to cloud storage
    ///
    /// Returns the content hash (for reference in CRDT documents)
    #[wasm_bindgen(js_name = uploadCloudBlob)]
    pub fn upload_cloud_blob(&self, data: &Uint8Array, mime_type: Option<String>) -> Promise {
        let cloud_sync = self.cloud_sync.clone();
        let data = data.to_vec();

        future_to_promise(async move {
            let mut guard = cloud_sync.write().await;
            let cloud = guard.as_mut()
                .ok_or_else(|| JsValue::from_str("Cloud storage not configured"))?;

            let hash = cloud.upload_blob(&data, mime_type.as_deref()).await
                .map_err(|e| JsValue::from_str(&format!("Failed to upload blob: {}", e)))?;

            Ok(JsValue::from_str(&hash))
        })
    }

    /// Download a blob from cloud storage
    ///
    /// @param hash - The content hash returned from uploadCloudBlob
    #[wasm_bindgen(js_name = downloadCloudBlob)]
    pub fn download_cloud_blob(&self, hash: &str) -> Promise {
        let cloud_sync = self.cloud_sync.clone();
        let hash = hash.to_string();

        future_to_promise(async move {
            let mut guard = cloud_sync.write().await;
            let cloud = guard.as_mut()
                .ok_or_else(|| JsValue::from_str("Cloud storage not configured"))?;

            let data = cloud.download_blob(&hash).await
                .map_err(|e| JsValue::from_str(&format!("Failed to download blob: {}", e)))?;

            let arr = Uint8Array::new_with_length(data.len() as u32);
            arr.copy_from(&data);
            Ok(arr.into())
        })
    }

    /// Clear cloud storage configuration
    #[wasm_bindgen(js_name = clearCloudStorage)]
    pub fn clear_cloud_storage(&self) -> Promise {
        let cloud_sync = self.cloud_sync.clone();

        future_to_promise(async move {
            *cloud_sync.write().await = None;
            Ok(JsValue::TRUE)
        })
    }
}

// =============================================================================
// V3 Sync Protocol (binary, async, with pairing + blobs)
// =============================================================================

use tracing::{info, warn, debug};

use crate::blobs_bridge::BlobsBridge;


/// Run sync as INITIATOR using V3 binary protocol.
///
/// Protocol: VersionInfo → Updates → BlobHashes → BlobTransfer → SyncComplete
/// Truncate a string to at most `n` bytes on a UTF-8 char boundary, without panicking.
///
/// Used for log/error truncation of attacker-controlled strings (pairing nonces,
/// peer ids) where naive byte slicing (`&s[..n]`) can panic mid-codepoint.
/// Build a JS `Error` carrying a stable machine-readable `code` alongside the
/// human message, so the TypeScript layer can branch on the failure kind instead
/// of string-matching. Backward compatible: `.message` is unchanged; `.code` is
/// additive.
fn js_error(code: &str, message: &str) -> JsValue {
    let err = js_sys::Error::new(message);
    let _ = js_sys::Reflect::set(&err, &JsValue::from_str("code"), &JsValue::from_str(code));
    err.into()
}

/// Map a `CoreError` to a coded JS error, preserving the actionable variants
/// (e.g. `KEY_CONFLICT`, `DELTA_TOO_LARGE`) that the plugin needs to distinguish.
fn core_err_to_js(e: crate::error::CoreError) -> JsValue {
    use crate::error::CoreError;
    let code = match &e {
        CoreError::KeyConflict { .. } => "KEY_CONFLICT",
        CoreError::DeltaTooLarge { .. } => "DELTA_TOO_LARGE",
        CoreError::Crypto(_) => "CRYPTO",
        CoreError::Timeout(_) => "TIMEOUT",
        CoreError::Protocol(_) => "PROTOCOL",
        CoreError::Crdt(_) => "CRDT",
        CoreError::Host(_) => "HOST",
        CoreError::Store(_) => "STORE",
        CoreError::Config(_) => "CONFIG",
        CoreError::Internal(_) => "INTERNAL",
    };
    js_error(code, &e.to_string())
}

fn short(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Adapts an `IrohStream` to the runner's `SyncStream` trait (same length-prefix
/// framing that `send_sync_msg`/`recv_sync_msg` use).
struct SyncStreamAdapter<'a>(&'a mut IrohStream);

#[async_trait::async_trait]
impl crate::runner::SyncStream for SyncStreamAdapter<'_> {
    async fn send(&mut self, data: &[u8]) -> Result<(), crate::error::CoreError> {
        self.0.send(data).await.map_err(|e| crate::error::CoreError::Protocol(e.to_string()))
    }
    async fn recv(&mut self, _timeout_ms: u64) -> Result<Vec<u8>, crate::error::CoreError> {
        self.0.recv().await.map_err(|e| crate::error::CoreError::Protocol(e.to_string()))
    }
    async fn close(&mut self) -> Result<(), crate::error::CoreError> {
        Ok(())
    }
}

/// A `BlobOps` that only reports a fixed hash list; blob bytes are transferred
/// out-of-band via iroh-blobs, so get/store are unused.
struct StaticBlobOps {
    hashes: Vec<iroh_blobs::Hash>,
}

impl crate::runner::BlobOps for StaticBlobOps {
    fn list_hashes(&self) -> Vec<iroh_blobs::Hash> {
        self.hashes.clone()
    }
    fn get(&self, _hash: &iroh_blobs::Hash) -> Option<Vec<u8>> {
        None
    }
    fn store(&mut self, _hash: &iroh_blobs::Hash, _data: &[u8]) -> Result<(), crate::error::CoreError> {
        Ok(())
    }
}

/// Run the initiator side of the V3 sync via the unit-tested `SyncRunner`:
/// version exchange (+ vault-id validation) + CRDT updates + SyncComplete, then
/// out-of-band iroh-blobs transfer coordinated on the sync stream.
async fn run_initiator_sync_v3(
    peer_id: &str,
    stream: &mut IrohStream,
    engine: &SyncEngine,
    hostname: &str,
    nickname: Option<&str>,
    plugin_version: Option<&str>,
    pairing_nonce: Option<String>,
    blobs_bridge: Option<&BlobsBridge>,
    endpoint: Option<&iroh::Endpoint>,
    on_event: &Option<Function>,
) -> Result<(), JsValue> {
    use crate::runner::{SyncRunner, RunnerConfig};
    let ce = core_err_to_js;

    let cfg = RunnerConfig {
        hostname: hostname.to_string(),
        nickname: nickname.map(|s| s.to_string()),
        plugin_version: plugin_version.map(|s| s.to_string()),
        pairing_nonce,
        ..Default::default()
    };
    let mut runner = SyncRunner::new(cfg, engine, peer_id.to_string(), true);
    let mut adapter = SyncStreamAdapter(stream);

    // Phases 1-2: version exchange + CRDT updates + SyncComplete.
    runner.run_crdt_only(&mut adapter).await.map_err(ce)?;

    // Phase 3: out-of-band iroh-blobs transfer.
    if runner.peer_supports_iroh_blobs() {
        if let (Some(bridge), Some(ep)) = (blobs_bridge, endpoint) {
            let our_hashes = bridge.list_host_hashes().await
                .map_err(|e| JsValue::from_str(&format!("List blobs failed: {}", e)))?;
            let static_blobs = StaticBlobOps { hashes: our_hashes };
            let (need, send) = runner.exchange_blob_hashes(&mut adapter, &static_blobs).await.map_err(ce)?;
            if !need.is_empty() || !send.is_empty() {
                let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
                    .map_err(|e| JsValue::from_str(&format!("Invalid peer ID: {}", e)))?;
                bridge.exchange_blobs_v3(ep, peer_endpoint_id, &need, &send).await
                    .map_err(|e| JsValue::from_str(&format!("Blob transfer failed: {}", e)))?;
            }
            runner.send_blob_sync_complete(&mut adapter, send.len()).await.map_err(ce)?;
        }
    }

    if let Some(ref callback) = on_event {
        let event = serde_json::json!({
            "type": "sync_complete",
            "peer_id": peer_id,
            "direction": "outgoing",
            "updates_received": runner.result().updates_received,
            "updates_sent": runner.result().updates_sent,
        });
        let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&event.to_string()));
    }
    Ok(())
}


/// Handle incoming streams using V3 binary protocol (acceptor side).
async fn handle_incoming_streams_v3(
    peer_id: String,
    connections: Arc<RwLock<HashMap<String, IrohConnection>>>,
    store: Arc<RwLock<Option<LoroStore>>>,
    on_event: Option<Function>,
    pending_pairings: Arc<std::sync::RwLock<HashMap<String, u64>>>,
    known_peers: Arc<std::sync::RwLock<HashMap<String, u64>>>,
    encryption_key: Arc<RwLock<Option<VaultKey>>>,
    blobs_bridge_arc: Arc<RwLock<Option<BlobsBridge>>>,
    gossip_bridge_arc: Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
    transport: Arc<RwLock<Option<IrohTransport>>>,
    shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let result = handle_incoming_streams_v3_inner(
        &peer_id, &connections, &store, &on_event,
        &pending_pairings, &known_peers, &encryption_key,
        &blobs_bridge_arc, &gossip_bridge_arc, &transport, &shutdown,
    ).await;

    if let Err(e) = result {
        warn!("Incoming sync from {} failed: {:?}", short(&peer_id, 16), e);
    }
}

/// Pairing validator backing the runner's acceptor-side check with snapshots of
/// the wasm pairing state (same logic as `validate_pairing`).
struct WasmPairingValidator {
    known: std::collections::HashMap<String, u64>,
    pending: std::collections::HashMap<String, u64>,
    now_ms: u64,
}

impl crate::runner::PairingValidator for WasmPairingValidator {
    fn validate(&self, peer_id: &str, nonce: Option<&str>) -> Result<bool, String> {
        if self.known.contains_key(peer_id) {
            return Ok(false); // known peer, not newly paired
        }
        let nonce = nonce.ok_or_else(|| "Unknown peer, pairing nonce required".to_string())?;
        let expires = self.pending.get(nonce)
            .ok_or_else(|| format!("Unknown pairing nonce: {}...", short(nonce, 16)))?;
        if self.now_ms > *expires {
            return Err("Pairing nonce expired".to_string());
        }
        Ok(true) // new peer with a valid nonce
    }
}

/// Handle an incoming V3 sync stream (acceptor side) via the unit-tested `SyncRunner`.
async fn handle_incoming_streams_v3_inner(
    peer_id: &str,
    connections: &Arc<RwLock<HashMap<String, IrohConnection>>>,
    store: &Arc<RwLock<Option<LoroStore>>>,
    on_event: &Option<Function>,
    pending_pairings: &Arc<std::sync::RwLock<HashMap<String, u64>>>,
    known_peers: &Arc<std::sync::RwLock<HashMap<String, u64>>>,
    encryption_key: &Arc<RwLock<Option<VaultKey>>>,
    blobs_bridge_arc: &Arc<RwLock<Option<BlobsBridge>>>,
    gossip_bridge_arc: &Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
    transport: &Arc<RwLock<Option<IrohTransport>>>,
    shutdown: &tokio::sync::watch::Receiver<bool>,
) -> Result<(), JsValue> {
    let ce = core_err_to_js;

    // Accept a stream from the connection
    let mut stream = {
        let connections_guard = connections.read().await;
        let conn = connections_guard.get(peer_id)
            .ok_or_else(|| JsValue::from_str("Connection lost"))?;
        conn.accept_stream().await
            .map_err(|e| JsValue::from_str(&format!("Accept stream failed: {}", e)))?
    };

    // Snapshot local vault id + encryption key + store state (independent of the peer).
    let local_vault_id = {
        let store_guard = store.read().await;
        *store_guard.as_ref()
            .ok_or_else(|| JsValue::from_str("Store not initialized"))?
            .vault_id()
    };
    let vault_key = encryption_key.read().await.clone()
        .ok_or_else(|| JsValue::from_str("No encryption key"))?;
    let snapshot = {
        let store_guard = store.read().await;
        store_guard.as_ref()
            .ok_or_else(|| JsValue::from_str("Store not initialized"))?
            .export_snapshot()
            .map_err(|e| JsValue::from_str(&format!("Export snapshot failed: {}", e)))?
    };

    // Build the temporary sync engine. init_vault carries the real vault id (new_with_key
    // starts at zero and import does not restore it) so the VERSION_INFO we send and the
    // vault-id validation are correct.
    let host = Arc::new(crate::host::mock::MockHost::new());
    let mut engine = SyncEngine::new_with_key(host, vault_key).map_err(ce)?;
    engine.init_vault(local_vault_id);
    engine.import_snapshot_raw(&snapshot).map_err(ce)?;

    // Acceptor pairing validator (snapshots avoid holding locks during sync).
    let now_ms = web_time::SystemTime::now()
        .duration_since(web_time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let validator = WasmPairingValidator {
        known: known_peers.read().unwrap().clone(),
        pending: pending_pairings.read().unwrap().clone(),
        now_ms,
    };

    let cfg = crate::runner::RunnerConfig {
        hostname: format!("PeerVault-{}", &hex::encode(engine.vault_id())[..8]),
        ..Default::default()
    };
    let mut runner = crate::runner::SyncRunner::with_validator(
        cfg, &engine, peer_id.to_string(), false, validator,
    );

    {
        let mut adapter = SyncStreamAdapter(&mut stream);
        // Version exchange (vault-id + protocol + pairing validation) + updates + SyncComplete.
        runner.run_crdt_only(&mut adapter).await.map_err(ce)?;

        // Out-of-band iroh-blobs transfer.
        if runner.peer_supports_iroh_blobs() {
            let bridge_guard = blobs_bridge_arc.read().await;
            let transport_guard = transport.read().await;
            if let (Some(bridge), Some(tp)) = (bridge_guard.as_ref(), transport_guard.as_ref()) {
                let our_hashes = bridge.list_host_hashes().await
                    .map_err(|e| JsValue::from_str(&format!("List blobs failed: {}", e)))?;
                let static_blobs = StaticBlobOps { hashes: our_hashes };
                let (need, send) = runner.exchange_blob_hashes(&mut adapter, &static_blobs).await.map_err(ce)?;
                if !need.is_empty() || !send.is_empty() {
                    let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
                        .map_err(|e| JsValue::from_str(&format!("Invalid peer ID: {}", e)))?;
                    bridge.exchange_blobs_v3(tp.endpoint(), peer_endpoint_id, &need, &send).await
                        .map_err(|e| JsValue::from_str(&format!("Blob transfer: {}", e)))?;
                }
                runner.send_blob_sync_complete(&mut adapter, send.len()).await.map_err(ce)?;
            }
        }
    }

    // Consume the pairing nonce + auto-add the peer once sync succeeded.
    if runner.result().pairing_is_new {
        if let Some(nonce) = &runner.result().pairing_nonce {
            pending_pairings.write().unwrap().remove(nonce);
        }
        known_peers.write().unwrap().insert(peer_id.to_string(), now_ms);
        if let Some(ref callback) = on_event {
            let event = serde_json::json!({
                "type": "pairing_complete",
                "peer_id": peer_id,
                "device_name": runner.result().peer_hostname,
            });
            let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&event.to_string()));
        }
    }

    let updates_received = runner.result().updates_received;
    let updates_sent = runner.result().updates_sent;

    // Import the synced state back into the shared LoroStore.
    {
        let updated_snapshot = engine.export_snapshot_raw().map_err(ce)?;
        let store_guard = store.read().await;
        let loro_store = store_guard.as_ref()
            .ok_or_else(|| JsValue::from_str("Store not initialized"))?;
        loro_store.import_snapshot(&updated_snapshot)
            .map_err(|e| JsValue::from_str(&format!("Import snapshot: {}", e)))?;
    }

    if let Some(ref callback) = on_event {
        let event = serde_json::json!({
            "type": "sync_complete",
            "peer_id": peer_id,
            "direction": "incoming",
            "updates_received": updates_received,
            "updates_sent": updates_sent,
        });
        let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&event.to_string()));
    }

    // Subscribe to gossip for real-time updates (acceptor side)
    let gossip_guard = gossip_bridge_arc.read().await;
    if let Some(ref gb) = *gossip_guard {
        let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
            .map_err(|e| JsValue::from_str(&format!("Invalid peer ID: {}", e)))?;
        match gb.subscribe_with_receiver(vec![peer_endpoint_id]).await {
            Ok(Some(receiver)) => {
                let store_for_gossip = store.clone();
                let enc_key_for_gossip = encryption_key.clone();
                let on_event_for_gossip = on_event.clone();
                let shutdown_for_gossip = shutdown.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    run_gossip_receiver(
                        receiver,
                        store_for_gossip,
                        enc_key_for_gossip,
                        on_event_for_gossip,
                        shutdown_for_gossip,
                    ).await;
                });

                let gb_for_debounce = gossip_bridge_arc.clone();
                let store_for_debounce = store.clone();
                let enc_for_debounce = encryption_key.clone();
                let notify = gb.change_notify();
                let on_event_for_debounce = on_event.clone();
                let shutdown_for_debounce = shutdown.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    run_gossip_debounce(
                        gb_for_debounce,
                        store_for_debounce,
                        enc_for_debounce,
                        notify,
                        on_event_for_debounce,
                        shutdown_for_debounce,
                    ).await;
                });
            }
            Ok(None) => {}
            Err(e) => {
                warn!("Acceptor: failed to subscribe to gossip: {}", e);
            }
        }
    }
    drop(gossip_guard);

    Ok(())
}

/// Background task that receives gossip messages and applies CRDT deltas.
/// Includes retry logic with exponential backoff on connection errors.
async fn run_gossip_receiver(
    mut receiver: iroh_gossip::api::GossipReceiver,
    store: Arc<RwLock<Option<LoroStore>>>,
    encryption_key: Arc<RwLock<Option<VaultKey>>>,
    on_event: Option<Function>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    use futures::StreamExt;
    use iroh_gossip::api::Event;

    info!("Gossip receiver started");

    loop {
        // Stop cleanly on shutdown (select yields None → while exits).
        while let Some(event) = (tokio::select! {
            biased;
            _ = shutdown.changed() => None,
            ev = receiver.next() => ev,
        }) {
            match event {
                Ok(Event::Received(msg)) => {
                    let data = msg.content.to_vec();
                    debug!("Gossip: received {} bytes from {:?}", data.len(), msg.delivered_from);

                    // Decrypt the delta
                    let plaintext = {
                        let key_guard = encryption_key.read().await;
                        match key_guard.as_ref() {
                            Some(key) => match key.decrypt(&data) {
                                Ok(pt) => pt,
                                Err(e) => {
                                    warn!("Gossip: failed to decrypt delta: {}", e);
                                    continue;
                                }
                            },
                            None => data,
                        }
                    };

                    // Import into LoroStore
                    let store_guard = store.read().await;
                    if let Some(ref s) = *store_guard {
                        if let Err(e) = s.import_updates(&plaintext) {
                            warn!("Gossip: failed to import delta: {}", e);
                            continue;
                        }

                        // Emit document_changed event
                        if let Some(ref callback) = on_event {
                            let event = serde_json::json!({
                                "type": "document_changed",
                                "source": "gossip",
                                "bytes": plaintext.len(),
                            });
                            let _ = callback.call1(
                                &JsValue::NULL,
                                &JsValue::from_str(&event.to_string()),
                            );
                        }
                    }
                }
                Ok(Event::NeighborUp(peer)) => {
                    info!("Gossip: neighbor joined: {}", peer);
                    if let Some(ref callback) = on_event {
                        let event = serde_json::json!({
                            "type": "gossip_neighbor_up",
                            "peer_id": peer.to_string(),
                        });
                        let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&event.to_string()));
                    }
                }
                Ok(Event::NeighborDown(peer)) => {
                    info!("Gossip: neighbor left: {}", peer);
                    if let Some(ref callback) = on_event {
                        let event = serde_json::json!({
                            "type": "gossip_neighbor_down",
                            "peer_id": peer.to_string(),
                        });
                        let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&event.to_string()));
                    }
                }
                Ok(Event::Lagged) => {
                    warn!("Gossip: receiver lagged, messages may have been dropped");
                }
                Err(e) => {
                    warn!("Gossip receiver error: {}", e);
                    break; // Break inner loop to trigger reconnect
                }
            }
        }

        // Receiver stream ended — gossip connection dropped.
        // HyParView will attempt to reconnect automatically via its passive view.
        // We just need to wait and the stream will be re-established.
        // If the gossip topic was fully lost, the next connectPeer will re-subscribe.
        info!("Gossip receiver stream ended, stopping");
        break;
    }

    info!("Gossip receiver stopped");
}

/// Background task that debounces gossip broadcasts.
/// Waits for change notifications, batches over a short window, then broadcasts.
async fn run_gossip_debounce(
    gossip_bridge: Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
    store: Arc<RwLock<Option<LoroStore>>>,
    encryption_key: Arc<RwLock<Option<VaultKey>>>,
    change_notify: Arc<tokio::sync::Notify>,
    on_event: Option<Function>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    info!("Gossip debounce task started");

    loop {
        // Wait for a change notification, or exit on shutdown.
        tokio::select! {
            biased;
            _ = shutdown.changed() => {
                info!("Gossip debounce task: shutdown signaled");
                break;
            }
            _ = change_notify.notified() => {}
        }

        // Debounce: wait 200ms for more changes to accumulate
        let promise = js_sys::Promise::new(&mut |resolve, _| {
            if let Some(window) = web_sys::window() {
                if window.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 200).is_err() {
                    // If setTimeout fails, resolve immediately (broadcast without delay)
                    let _ = resolve.call0(&JsValue::NULL);
                }
            } else {
                // No window (e.g., worker context) — resolve immediately
                let _ = resolve.call0(&JsValue::NULL);
            }
        });
        let _ = wasm_bindgen_futures::JsFuture::from(promise).await;

        // Drain all pending notifications (coalesce rapid changes)
        // Notify is edge-triggered, so this clears any accumulated signals

        // Take the pending VV
        let gossip_guard = gossip_bridge.read().await;
        let gb = match gossip_guard.as_ref() {
            Some(gb) => gb,
            None => continue,
        };

        let pending_vv = match gb.take_pending_vv().await {
            Some(vv) => vv,
            None => continue,
        };

        if !gb.is_subscribed().await {
            continue;
        }

        // Export delta since the captured VV
        let store_guard = store.read().await;
        let delta = match store_guard.as_ref() {
            Some(s) => match s.export_updates(Some(&pending_vv)) {
                Ok(d) if !d.is_empty() => d,
                _ => continue,
            },
            None => continue,
        };
        drop(store_guard);

        // Encrypt
        let enc_key_guard = encryption_key.read().await;
        let encrypted = match enc_key_guard.as_ref() {
            Some(key) => key.encrypt(&delta),
            None => Ok(delta),
        };
        drop(enc_key_guard);
        // Never broadcast plaintext on an encryption failure — skip this delta.
        let encrypted = match encrypted {
            Ok(bytes) => bytes,
            Err(e) => {
                warn!("Gossip: encryption failed, skipping broadcast: {}", e);
                continue;
            }
        };

        // Broadcast (or emit sync_needed if too large)
        match gb.broadcast_delta(&encrypted).await {
            Ok(()) => {
                debug!("Gossip: broadcast {} bytes (debounced)", encrypted.len());
            }
            Err(crate::error::CoreError::DeltaTooLarge { size, max }) => {
                warn!("Delta too large for gossip ({} > {}), peers need point-to-point sync", size, max);
                if let Some(ref callback) = on_event {
                    let event = serde_json::json!({
                        "type": "sync_needed",
                        "reason": "delta_too_large",
                        "size": size,
                        "max": max,
                    });
                    let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&event.to_string()));
                }
            }
            Err(e) => {
                warn!("Gossip broadcast failed: {}", e);
            }
        }
    }
}

// =============================================================================
// Accept Loop
// =============================================================================

/// Background accept loop for incoming peer connections
///
/// This runs continuously in the background, accepting incoming connections,
/// then spawning handlers to accept streams and run sync as the acceptor.
async fn run_accept_loop(
    transport: Arc<RwLock<Option<IrohTransport>>>,
    connections: Arc<RwLock<HashMap<String, IrohConnection>>>,
    store: Arc<RwLock<Option<LoroStore>>>,
    on_event: Option<Function>,
    pending_pairings: Arc<std::sync::RwLock<HashMap<String, u64>>>,
    known_peers: Arc<std::sync::RwLock<HashMap<String, u64>>>,
    encryption_key: Arc<RwLock<Option<VaultKey>>>,
    blobs_bridge: Arc<RwLock<Option<BlobsBridge>>>,
    gossip_bridge: Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    info!("Accept loop started");

    loop {
        if *shutdown.borrow() {
            info!("Accept loop: shutdown signaled");
            break;
        }

        // Get transport reference
        let transport_guard = transport.read().await;
        let iroh = match transport_guard.as_ref() {
            Some(t) => t,
            None => {
                info!("Accept loop: transport not available");
                break;
            }
        };

        // Accept a connection, but bail out immediately if shutdown is signaled so
        // we release the transport read guard (stop() needs the write guard).
        let accepted = tokio::select! {
            biased;
            _ = shutdown.changed() => {
                info!("Accept loop: shutdown during accept");
                break;
            }
            result = iroh.accept() => result,
        };

        match accepted {
            Ok(connection) => {
                let peer_id = connection.peer_id().to_string();
                info!("Accept loop: accepted connection from {}", short(&peer_id, 16));

                // Store the connection
                connections.write().await.insert(peer_id.clone(), connection);

                // Emit event to JavaScript
                if let Some(ref callback) = on_event {
                    let event = serde_json::json!({
                        "type": "peer_connected",
                        "peer_id": peer_id,
                        "direction": "incoming"
                    });
                    let _ = callback.call1(
                        &JsValue::NULL,
                        &JsValue::from_str(&event.to_string()),
                    );
                }

                // Spawn V3 handler for this connection
                let connections_clone = connections.clone();
                let store_clone = store.clone();
                let on_event_clone = on_event.clone();
                let pending_pairings_clone = pending_pairings.clone();
                let known_peers_clone = known_peers.clone();
                let encryption_key_clone = encryption_key.clone();
                let blobs_bridge_clone = blobs_bridge.clone();
                let gossip_bridge_clone = gossip_bridge.clone();
                let transport_clone = transport.clone();
                let shutdown_clone = shutdown.clone();

                wasm_bindgen_futures::spawn_local(async move {
                    handle_incoming_streams_v3(
                        peer_id,
                        connections_clone,
                        store_clone,
                        on_event_clone,
                        pending_pairings_clone,
                        known_peers_clone,
                        encryption_key_clone,
                        blobs_bridge_clone,
                        gossip_bridge_clone,
                        transport_clone,
                        shutdown_clone,
                    ).await;
                });
            }
            Err(e) => {
                let err_str = format!("{}", e);
                if err_str.contains("closed") || err_str.contains("shutdown") {
                    debug!("Transport closed, stopping accept loop");
                    break;
                }
                warn!(error = %e, "Failed to accept connection");
                // Small delay before retrying on error
                let promise = js_sys::Promise::new(&mut |resolve, _| {
                    if let Some(window) = web_sys::window() {
                        let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, 100);
                    } else {
                        let _ = resolve.call0(&JsValue::NULL);
                    }
                });
                let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
            }
        }

        // Release the lock between iterations
        drop(transport_guard);
    }

    info!("Accept loop stopped");
}

/// Cloud config JSON structure for JS interop
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudConfigJs {
    endpoint: String,
    bucket: String,
    region: String,
    access_key_id: String,
    secret_access_key: String,
    path_prefix: Option<String>,
    #[serde(default)]
    allow_insecure_http: Option<bool>,
}

/// Helper to create a vault ID from a string (hashes the input)
#[wasm_bindgen(js_name = createVaultId)]
pub fn create_vault_id(name: &str) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    let hash: [u8; 32] = hasher.finalize().into();
    hex::encode(hash)
}

/// Generate a random vault ID
#[wasm_bindgen(js_name = randomVaultId)]
pub fn random_vault_id() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

// ============================================================================
// Session Management for WASM
// ============================================================================

use crate::session::{LiveModeSession, SessionConfig, SessionState, HealthMetrics};

/// WASM-friendly sync session wrapper
///
/// Manages the lifecycle of a sync session with a peer, including:
/// - State machine transitions
/// - Ping/pong keep-alive
/// - Health metrics (RTT, jitter)
/// - Automatic reconnection with exponential backoff
#[wasm_bindgen]
pub struct WasmSyncSession {
    session: LiveModeSession,
}

#[wasm_bindgen]
impl WasmSyncSession {
    /// Create a new sync session for a peer
    ///
    /// @param peer_id - Unique identifier for the peer
    /// @param config_json - Optional JSON config:
    /// {
    ///   "pingIntervalMs": 15000,
    ///   "pingTimeoutMs": 10000,
    ///   "receiveTimeoutMs": 30000,
    ///   "maxRetries": 5,
    ///   "baseRetryDelayMs": 500,
    ///   "maxRetryDelayMs": 30000
    /// }
    #[wasm_bindgen(constructor)]
    pub fn new(peer_id: &str, config_json: Option<String>) -> Result<WasmSyncSession, JsValue> {
        let config = match config_json {
            Some(json) => {
                let js_config: SessionConfigJs = serde_json::from_str(&json)
                    .map_err(|e| JsValue::from_str(&format!("Invalid config JSON: {}", e)))?;
                SessionConfig {
                    ping_interval_ms: js_config.ping_interval_ms.unwrap_or(15000),
                    ping_timeout_ms: js_config.ping_timeout_ms.unwrap_or(10000),
                    receive_timeout_ms: js_config.receive_timeout_ms.unwrap_or(30000),
                    max_retries: js_config.max_retries.unwrap_or(5),
                    base_retry_delay_ms: js_config.base_retry_delay_ms.unwrap_or(500),
                    max_retry_delay_ms: js_config.max_retry_delay_ms.unwrap_or(30000),
                    ..Default::default()
                }
            }
            None => SessionConfig::default(),
        };

        Ok(WasmSyncSession {
            session: LiveModeSession::new(peer_id.to_string(), config),
        })
    }

    /// Get the current session state as a string
    ///
    /// Returns one of: "idle", "connecting", "exchanging_versions",
    /// "syncing_updates", "syncing_blobs", "live", "closed", "error"
    #[wasm_bindgen(js_name = getState)]
    pub fn get_state(&self) -> String {
        match self.session.state() {
            SessionState::Idle => "idle",
            SessionState::Connecting => "connecting",
            SessionState::ExchangingVersions => "exchanging_versions",
            SessionState::SyncingUpdates => "syncing_updates",
            SessionState::SyncingBlobs => "syncing_blobs",
            SessionState::Live => "live",
            SessionState::Closed => "closed",
            SessionState::Error => "error",
        }.to_string()
    }

    /// Get the peer ID
    #[wasm_bindgen(js_name = getPeerId)]
    pub fn get_peer_id(&self) -> String {
        self.session.peer_id().to_string()
    }

    /// Check if session is in live mode
    #[wasm_bindgen(js_name = isLive)]
    pub fn is_live(&self) -> bool {
        self.session.is_live()
    }

    /// Get the last error message (if any)
    #[wasm_bindgen(js_name = getLastError)]
    pub fn get_last_error(&self) -> Option<String> {
        self.session.last_error().map(|s| s.to_string())
    }

    // =========================================================================
    // State Transitions
    // =========================================================================

    /// Start the session (idle → connecting)
    #[wasm_bindgen]
    pub fn start(&mut self) -> Result<(), JsValue> {
        self.session.start()
            .map_err(|e| JsValue::from_str(&format!("{}", e)))
    }

    /// Begin version exchange (connecting → exchanging_versions)
    #[wasm_bindgen(js_name = beginVersionExchange)]
    pub fn begin_version_exchange(&mut self) -> Result<(), JsValue> {
        self.session.begin_version_exchange()
            .map_err(|e| JsValue::from_str(&format!("{}", e)))
    }

    /// Begin update sync (exchanging_versions → syncing_updates)
    #[wasm_bindgen(js_name = beginUpdateSync)]
    pub fn begin_update_sync(&mut self) -> Result<(), JsValue> {
        self.session.begin_update_sync()
            .map_err(|e| JsValue::from_str(&format!("{}", e)))
    }

    /// Begin blob sync (syncing_updates → syncing_blobs)
    #[wasm_bindgen(js_name = beginBlobSync)]
    pub fn begin_blob_sync(&mut self) -> Result<(), JsValue> {
        self.session.begin_blob_sync()
            .map_err(|e| JsValue::from_str(&format!("{}", e)))
    }

    /// Enter live mode (syncing_updates|syncing_blobs → live)
    #[wasm_bindgen(js_name = enterLiveMode)]
    pub fn enter_live_mode(&mut self) -> Result<(), JsValue> {
        self.session.enter_live_mode()
            .map_err(|e| JsValue::from_str(&format!("{}", e)))
    }

    /// Close the session gracefully
    #[wasm_bindgen]
    pub fn close(&mut self) {
        self.session.close();
    }

    /// Set error state with a message
    #[wasm_bindgen(js_name = setError)]
    pub fn set_error(&mut self, error: &str) {
        self.session.set_error(error.to_string());
    }

    // =========================================================================
    // Ping/Pong Keep-alive
    // =========================================================================

    /// Create a ping and return the sequence number
    ///
    /// The TypeScript side should:
    /// 1. Call createPing() to get seq number
    /// 2. Send PING message with seq to peer
    /// 3. When PONG received, call handlePong(seq)
    #[wasm_bindgen(js_name = createPing)]
    pub fn create_ping(&mut self) -> u32 {
        self.session.create_ping()
    }

    /// Handle a pong response, returns RTT in milliseconds
    #[wasm_bindgen(js_name = handlePong)]
    pub fn handle_pong(&mut self, seq: u32) -> Result<f64, JsValue> {
        self.session.handle_pong(seq)
            .map(|rtt| rtt as f64)
            .map_err(|e| JsValue::from_str(&format!("{}", e)))
    }

    /// Handle a missed pong (ping timed out)
    #[wasm_bindgen(js_name = handleMissedPong)]
    pub fn handle_missed_pong(&mut self) {
        self.session.handle_missed_pong();
    }

    /// Check if it's time to send a ping
    #[wasm_bindgen(js_name = shouldSendPing)]
    pub fn should_send_ping(&self) -> bool {
        self.session.should_send_ping()
    }

    /// Check if current ping is overdue (timed out)
    #[wasm_bindgen(js_name = isPingOverdue)]
    pub fn is_ping_overdue(&self) -> bool {
        self.session.is_ping_overdue()
    }

    /// Check if connection appears dead (too many missed pongs)
    #[wasm_bindgen(js_name = isConnectionDead)]
    pub fn is_connection_dead(&self) -> bool {
        self.session.is_connection_dead()
    }

    /// Get ping interval in milliseconds
    #[wasm_bindgen(js_name = getPingIntervalMs)]
    pub fn get_ping_interval_ms(&self) -> f64 {
        self.session.config().ping_interval_ms as f64
    }

    // =========================================================================
    // Health Metrics
    // =========================================================================

    /// Get health metrics as JSON
    ///
    /// Returns:
    /// {
    ///   "avgRttMs": number | null,
    ///   "minRttMs": number | null,
    ///   "maxRttMs": number | null,
    ///   "jitterMs": number | null,
    ///   "bytesSent": number,
    ///   "bytesReceived": number,
    ///   "messagesSent": number,
    ///   "messagesReceived": number,
    ///   "idleMs": number
    /// }
    #[wasm_bindgen(js_name = getHealthMetrics)]
    pub fn get_health_metrics(&self) -> String {
        let m = self.session.metrics();
        serde_json::json!({
            "avgRttMs": m.avg_rtt_ms(),
            "minRttMs": m.min_rtt_ms(),
            "maxRttMs": m.max_rtt_ms(),
            "jitterMs": m.jitter_ms(),
            "bytesSent": m.bytes_sent,
            "bytesReceived": m.bytes_received,
            "messagesSent": m.messages_sent,
            "messagesReceived": m.messages_received,
            "idleMs": m.idle_duration().as_millis() as u64,
        }).to_string()
    }

    /// Record bytes sent (for bandwidth tracking)
    #[wasm_bindgen(js_name = recordSent)]
    pub fn record_sent(&mut self, bytes: u32) {
        self.session.metrics_mut().record_sent(bytes as usize);
    }

    /// Record bytes received (for bandwidth tracking)
    #[wasm_bindgen(js_name = recordReceived)]
    pub fn record_received(&mut self, bytes: u32) {
        self.session.metrics_mut().record_received(bytes as usize);
    }

    // =========================================================================
    // Reconnection
    // =========================================================================

    /// Check if we should attempt reconnection
    #[wasm_bindgen(js_name = shouldReconnect)]
    pub fn should_reconnect(&self) -> bool {
        self.session.should_reconnect()
    }

    /// Get delay before next reconnection attempt (in milliseconds)
    #[wasm_bindgen(js_name = getReconnectDelayMs)]
    pub fn get_reconnect_delay_ms(&self) -> f64 {
        self.session.reconnect_delay().as_millis() as f64
    }

    /// Start a reconnection attempt
    #[wasm_bindgen(js_name = startReconnect)]
    pub fn start_reconnect(&mut self) {
        self.session.start_reconnect();
    }

    /// Mark reconnection as successful
    #[wasm_bindgen(js_name = reconnectSucceeded)]
    pub fn reconnect_succeeded(&mut self) {
        self.session.reconnect_succeeded();
    }

    /// Mark reconnection as failed
    #[wasm_bindgen(js_name = reconnectFailed)]
    pub fn reconnect_failed(&mut self, error: &str) {
        self.session.reconnect_failed(error.to_string());
    }

    /// Get current reconnection attempt count
    #[wasm_bindgen(js_name = getReconnectAttempts)]
    pub fn get_reconnect_attempts(&self) -> u32 {
        self.session.reconnect_state().attempts
    }

    // =========================================================================
    // Duration Queries
    // =========================================================================

    /// Get duration in live mode (milliseconds), or null if not in live mode
    #[wasm_bindgen(js_name = getLiveDurationMs)]
    pub fn get_live_duration_ms(&self) -> Option<f64> {
        self.session.live_duration().map(|d| d.as_millis() as f64)
    }

    /// Get total session duration (milliseconds), or null if not started
    #[wasm_bindgen(js_name = getSessionDurationMs)]
    pub fn get_session_duration_ms(&self) -> Option<f64> {
        self.session.session_duration().map(|d| d.as_millis() as f64)
    }
}

/// Session config for JS interop
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionConfigJs {
    ping_interval_ms: Option<u64>,
    ping_timeout_ms: Option<u64>,
    receive_timeout_ms: Option<u64>,
    max_retries: Option<u32>,
    base_retry_delay_ms: Option<u64>,
    max_retry_delay_ms: Option<u64>,
}


/// Runner config for JS interop
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunnerConfigJs {
    hostname: Option<String>,
    nickname: Option<String>,
    plugin_version: Option<String>,
    receive_timeout_ms: Option<u64>,
    ping_interval_ms: Option<u64>,
    max_inline_blob_size: Option<usize>,
}

// ============================================================================
// Raw Loro Sync (for TypeScript integration)
// ============================================================================

/// Raw sync result for TypeScript
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RawSyncResult {
    /// Updated Loro snapshot (to import back into TypeScript LoroDoc)
    updated_snapshot: Vec<u8>,
    /// Sync statistics
    updates_sent: usize,
    updates_received: usize,
    blobs_sent: usize,
    blobs_received: usize,
    bytes_sent: u64,
    bytes_received: u64,
    is_live: bool,
    peer_hostname: String,
    peer_nickname: Option<String>,
    error: Option<String>,
}


#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn test_create_vault_id() {
        let id = create_vault_id("test-vault");
        assert_eq!(id.len(), 64); // 32 bytes = 64 hex chars
    }

    #[wasm_bindgen_test]
    fn test_random_vault_id() {
        let id1 = random_vault_id();
        let id2 = random_vault_id();
        assert_eq!(id1.len(), 64);
        assert_ne!(id1, id2);
    }
}
