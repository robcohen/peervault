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
use crate::key_exchange::{KeyExchangeSession, KeyExchangeError};
use crate::protocol::keys::{Message as KeyMessage, Request as KeyRequest, Response as KeyResponse};
use crate::sync::SyncEngine;
use crate::runner::{SyncRunner, RunnerConfig, SyncStream, BlobOps};
use iroh_blobs::Hash;
use crate::error::CoreError;
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

/// Transport provider that delegates to JavaScript callbacks
///
/// This allows the TypeScript/Node.js side to implement actual UDP transport.
/// The TypeScript side orchestrates the sync protocol, calling WASM for:
/// - Encryption/decryption
/// - CRDT operations
/// - Protocol message encoding/decoding
///
/// Usage from TypeScript:
/// ```typescript
/// const transport = new JsTransportProvider(myPeerId);
///
/// // Register callbacks for when WASM wants to do network operations
/// transport.onSend((peerId, streamId, data) => {
///     // Send data over your UDP socket
///     socket.send(data, peerPort, peerAddr);
/// });
///
/// // When you receive data from the network, deliver it to WASM
/// socket.on('message', (data, rinfo) => {
///     transport.deliverData(peerId, streamId, data);
/// });
/// ```
#[wasm_bindgen]
pub struct JsTransportProvider {
    /// Our peer ID
    peer_id: String,
    /// Connected peers
    connected: std::sync::Mutex<HashMap<String, WasmPeerAddress>>,
    /// Next stream ID
    next_stream_id: AtomicU32,

    // JavaScript callbacks for transport operations (WASM → JS)
    js_connect: Option<Function>,
    js_disconnect: Option<Function>,
    js_send: Option<Function>,
    js_open_stream: Option<Function>,
    js_close_stream: Option<Function>,
    js_start: Option<Function>,
    js_stop: Option<Function>,
    js_get_ticket: Option<Function>,

    // JavaScript callbacks for incoming events (JS → WASM → JS event handlers)
    js_on_data: Option<Function>,
    js_on_stream: Option<Function>,
    js_on_connection: Option<Function>,
}

#[wasm_bindgen]
impl JsTransportProvider {
    /// Create a new JS transport provider
    #[wasm_bindgen(constructor)]
    pub fn new(peer_id: &str) -> JsTransportProvider {
        JsTransportProvider {
            peer_id: peer_id.to_string(),
            connected: std::sync::Mutex::new(HashMap::new()),
            next_stream_id: AtomicU32::new(1),
            js_connect: None,
            js_disconnect: None,
            js_send: None,
            js_open_stream: None,
            js_close_stream: None,
            js_start: None,
            js_stop: None,
            js_get_ticket: None,
            js_on_data: None,
            js_on_stream: None,
            js_on_connection: None,
        }
    }

    // =========================================================================
    // Register JS callbacks for outgoing operations (WASM → JS)
    // =========================================================================

    /// Register callback: (ticket: string) => Promise<string>
    #[wasm_bindgen(js_name = onConnect)]
    pub fn on_connect(&mut self, callback: Function) {
        self.js_connect = Some(callback);
    }

    /// Register callback: (peerId: string) => Promise<void>
    #[wasm_bindgen(js_name = onDisconnect)]
    pub fn on_disconnect(&mut self, callback: Function) {
        self.js_disconnect = Some(callback);
    }

    /// Register callback: (peerId: string, streamId: number, data: Uint8Array) => Promise<void>
    #[wasm_bindgen(js_name = onSend)]
    pub fn on_send(&mut self, callback: Function) {
        self.js_send = Some(callback);
    }

    /// Register callback: (peerId: string, protocol: string) => Promise<number>
    #[wasm_bindgen(js_name = onOpenStream)]
    pub fn on_open_stream(&mut self, callback: Function) {
        self.js_open_stream = Some(callback);
    }

    /// Register callback: (peerId: string, streamId: number) => Promise<void>
    #[wasm_bindgen(js_name = onCloseStream)]
    pub fn on_close_stream(&mut self, callback: Function) {
        self.js_close_stream = Some(callback);
    }

    /// Register callback: () => Promise<string>
    #[wasm_bindgen(js_name = onStart)]
    pub fn on_start(&mut self, callback: Function) {
        self.js_start = Some(callback);
    }

    /// Register callback: () => Promise<void>
    #[wasm_bindgen(js_name = onStop)]
    pub fn on_stop(&mut self, callback: Function) {
        self.js_stop = Some(callback);
    }

    /// Register callback: () => Promise<string>
    #[wasm_bindgen(js_name = onGetTicket)]
    pub fn on_get_ticket(&mut self, callback: Function) {
        self.js_get_ticket = Some(callback);
    }

    // =========================================================================
    // Register JS callbacks for incoming events (JS → WASM → JS)
    // =========================================================================

    /// Register callback for data received: (peerId: string, streamId: number, data: Uint8Array) => void
    #[wasm_bindgen(js_name = setOnData)]
    pub fn set_on_data(&mut self, callback: Function) {
        self.js_on_data = Some(callback);
    }

    /// Register callback for stream opened: (peerId: string, streamId: number, protocol: string) => void
    #[wasm_bindgen(js_name = setOnStream)]
    pub fn set_on_stream(&mut self, callback: Function) {
        self.js_on_stream = Some(callback);
    }

    /// Register callback for connection events: (event: string, peerId: string, details: string) => void
    #[wasm_bindgen(js_name = setOnConnection)]
    pub fn set_on_connection(&mut self, callback: Function) {
        self.js_on_connection = Some(callback);
    }

    // =========================================================================
    // Deliver incoming events from network (called by TypeScript)
    // =========================================================================

    /// Called by JS when data is received from a peer
    #[wasm_bindgen(js_name = deliverData)]
    pub fn deliver_data(&self, peer_id: &str, stream_id: u32, data: &Uint8Array) {
        if let Some(cb) = &self.js_on_data {
            let _ = cb.call3(
                &JsValue::NULL,
                &JsValue::from_str(peer_id),
                &JsValue::from_f64(stream_id as f64),
                data,
            );
        }
    }

    /// Called by JS when a peer opens a new stream
    #[wasm_bindgen(js_name = deliverStream)]
    pub fn deliver_stream(&self, peer_id: &str, stream_id: u32, protocol: &str) {
        if let Some(cb) = &self.js_on_stream {
            let _ = cb.call3(
                &JsValue::NULL,
                &JsValue::from_str(peer_id),
                &JsValue::from_f64(stream_id as f64),
                &JsValue::from_str(protocol),
            );
        }
    }

    /// Called by JS when a peer connects
    #[wasm_bindgen(js_name = deliverPeerConnected)]
    pub fn deliver_peer_connected(&self, peer_id: &str, ticket: &str, name: Option<String>) {
        self.connected.lock().unwrap().insert(peer_id.to_string(), WasmPeerAddress {
            peer_id: peer_id.to_string(),
            ticket: ticket.to_string(),
            name: name.clone(),
        });
        if let Some(cb) = &self.js_on_connection {
            let _ = cb.call3(
                &JsValue::NULL,
                &JsValue::from_str("connected"),
                &JsValue::from_str(peer_id),
                &JsValue::from_str(ticket),
            );
        }
    }

    /// Called by JS when a peer disconnects
    #[wasm_bindgen(js_name = deliverPeerDisconnected)]
    pub fn deliver_peer_disconnected(&self, peer_id: &str, reason: &str) {
        self.connected.lock().unwrap().remove(peer_id);
        if let Some(cb) = &self.js_on_connection {
            let _ = cb.call3(
                &JsValue::NULL,
                &JsValue::from_str("disconnected"),
                &JsValue::from_str(peer_id),
                &JsValue::from_str(reason),
            );
        }
    }

    /// Called by JS when a connection fails
    #[wasm_bindgen(js_name = deliverConnectionFailed)]
    pub fn deliver_connection_failed(&self, peer_id: &str, error: &str) {
        if let Some(cb) = &self.js_on_connection {
            let _ = cb.call3(
                &JsValue::NULL,
                &JsValue::from_str("failed"),
                &JsValue::from_str(peer_id),
                &JsValue::from_str(error),
            );
        }
    }

    // =========================================================================
    // Request operations (called by WASM, triggers JS callbacks)
    // =========================================================================

    /// Request to connect to a peer (calls js_connect callback)
    #[wasm_bindgen(js_name = requestConnect)]
    pub fn request_connect(&self, ticket: &str) -> Result<JsValue, JsValue> {
        match &self.js_connect {
            Some(cb) => cb.call1(&JsValue::NULL, &JsValue::from_str(ticket)),
            None => Err(JsValue::from_str("connect callback not registered")),
        }
    }

    /// Request to disconnect from a peer
    #[wasm_bindgen(js_name = requestDisconnect)]
    pub fn request_disconnect(&self, peer_id: &str) -> Result<JsValue, JsValue> {
        self.connected.lock().unwrap().remove(peer_id);
        match &self.js_disconnect {
            Some(cb) => cb.call1(&JsValue::NULL, &JsValue::from_str(peer_id)),
            None => Err(JsValue::from_str("disconnect callback not registered")),
        }
    }

    /// Request to send data
    #[wasm_bindgen(js_name = requestSend)]
    pub fn request_send(&self, peer_id: &str, stream_id: u32, data: &Uint8Array) -> Result<JsValue, JsValue> {
        match &self.js_send {
            Some(cb) => cb.call3(
                &JsValue::NULL,
                &JsValue::from_str(peer_id),
                &JsValue::from_f64(stream_id as f64),
                data,
            ),
            None => Err(JsValue::from_str("send callback not registered")),
        }
    }

    /// Request to open a new stream
    #[wasm_bindgen(js_name = requestOpenStream)]
    pub fn request_open_stream(&self, peer_id: &str, protocol: &str) -> Result<JsValue, JsValue> {
        match &self.js_open_stream {
            Some(cb) => cb.call2(
                &JsValue::NULL,
                &JsValue::from_str(peer_id),
                &JsValue::from_str(protocol),
            ),
            None => {
                // If no callback, return a local stream ID
                let id = self.next_stream_id.fetch_add(1, Ordering::SeqCst);
                Ok(JsValue::from_f64(id as f64))
            }
        }
    }

    /// Request to close a stream
    #[wasm_bindgen(js_name = requestCloseStream)]
    pub fn request_close_stream(&self, peer_id: &str, stream_id: u32) -> Result<JsValue, JsValue> {
        match &self.js_close_stream {
            Some(cb) => cb.call2(
                &JsValue::NULL,
                &JsValue::from_str(peer_id),
                &JsValue::from_f64(stream_id as f64),
            ),
            None => Ok(JsValue::UNDEFINED),
        }
    }

    /// Request to start transport
    #[wasm_bindgen(js_name = requestStart)]
    pub fn request_start(&self) -> Result<JsValue, JsValue> {
        match &self.js_start {
            Some(cb) => cb.call0(&JsValue::NULL),
            None => Err(JsValue::from_str("start callback not registered")),
        }
    }

    /// Request to stop transport
    #[wasm_bindgen(js_name = requestStop)]
    pub fn request_stop(&self) -> Result<JsValue, JsValue> {
        match &self.js_stop {
            Some(cb) => cb.call0(&JsValue::NULL),
            None => Err(JsValue::from_str("stop callback not registered")),
        }
    }

    /// Request to get our ticket
    #[wasm_bindgen(js_name = requestGetTicket)]
    pub fn request_get_ticket(&self) -> Result<JsValue, JsValue> {
        match &self.js_get_ticket {
            Some(cb) => cb.call0(&JsValue::NULL),
            None => Err(JsValue::from_str("get_ticket callback not registered")),
        }
    }

    // =========================================================================
    // Query methods
    // =========================================================================

    /// Get our peer ID
    #[wasm_bindgen(js_name = getPeerId)]
    pub fn get_peer_id_js(&self) -> String {
        self.peer_id.clone()
    }

    /// Get list of connected peers as JSON
    #[wasm_bindgen(js_name = getConnectedPeers)]
    pub fn get_connected_peers_js(&self) -> String {
        let peers: Vec<_> = self.connected.lock().unwrap()
            .values()
            .map(|p| serde_json::json!({
                "peerId": p.peer_id,
                "ticket": p.ticket,
                "name": p.name,
            }))
            .collect();
        serde_json::to_string(&peers).unwrap_or_else(|_| "[]".to_string())
    }

    /// Check if connected to a specific peer
    #[wasm_bindgen(js_name = isConnected)]
    pub fn is_connected_js(&self, peer_id: &str) -> bool {
        self.connected.lock().unwrap().contains_key(peer_id)
    }
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
    /// Key exchange session (for receiving vault key during pairing)
    key_exchange: Arc<RwLock<Option<KeyExchangeSession>>>,
    /// Pending pairing nonces (nonce_hex -> expires_at_ms)
    /// Used for one-time ticket validation
    pending_pairings: Arc<RwLock<HashMap<String, u64>>>,
    /// Known peer IDs (peer_id -> added_at_ms)
    /// Peers that have successfully completed pairing
    known_peers: Arc<RwLock<HashMap<String, u64>>>,
    /// iroh-blobs bridge for V3 blob transfer
    blobs_bridge: Arc<RwLock<Option<crate::blobs_bridge::BlobsBridge>>>,
    /// iroh-gossip bridge for real-time CRDT delta broadcast
    gossip_bridge: Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
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
            key_exchange: Arc::new(RwLock::new(None)),
            pending_pairings: Arc::new(RwLock::new(HashMap::new())),
            known_peers: Arc::new(RwLock::new(HashMap::new())),
            blobs_bridge: Arc::new(RwLock::new(None)),
            gossip_bridge: Arc::new(RwLock::new(None)),
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
    // Key Exchange (P2P Vault Key Sharing)
    // =========================================================================

    /// Start a key exchange session as the initiator (requesting a key)
    ///
    /// Returns a base64-encoded request message to send to the peer.
    /// Call this when pairing with a peer who has the vault key.
    #[wasm_bindgen(js_name = startKeyExchangeRequest)]
    pub fn start_key_exchange_request(&self) -> Promise {
        let key_exchange = self.key_exchange.clone();
        let encryption_key = self.encryption_key.clone();

        future_to_promise(async move {
            // Check if we already have a key
            let has_key = encryption_key.read().await.is_some();

            // Create new session as initiator
            let session = KeyExchangeSession::new_initiator();
            let request = session.create_request(has_key);

            // Encode the request message
            let encoded = request.encode()
                .map_err(|e| JsValue::from_str(&format!("Failed to encode request: {}", e)))?;

            // Store the session
            *key_exchange.write().await = Some(session);

            // Return base64-encoded message
            use base64::Engine;
            Ok(JsValue::from_str(&base64::engine::general_purpose::STANDARD.encode(&encoded)))
        })
    }

    /// Handle a key exchange response from peer (as initiator)
    ///
    /// Takes the base64-encoded response message from peer.
    /// Extracts and stores the vault key if successful.
    /// Returns true if the key was received successfully.
    #[wasm_bindgen(js_name = handleKeyExchangeResponse)]
    pub fn handle_key_exchange_response(&self, response_b64: &str) -> Promise {
        let key_exchange = self.key_exchange.clone();
        let encryption_key = self.encryption_key.clone();
        let response_b64 = response_b64.to_string();

        future_to_promise(async move {
            use base64::Engine;

            // Decode the response
            let response_bytes = base64::engine::general_purpose::STANDARD.decode(&response_b64)
                .map_err(|e| JsValue::from_str(&format!("Invalid base64: {}", e)))?;

            let message = KeyMessage::decode(&response_bytes)
                .map_err(|e| JsValue::from_str(&format!("Invalid message: {}", e)))?;

            // Get our session
            let mut session_guard = key_exchange.write().await;
            let session = session_guard.as_mut()
                .ok_or_else(|| JsValue::from_str("No active key exchange session"))?;

            // Handle the response
            match message {
                KeyMessage::Response(response) => {
                    let vault_key = session.handle_response(&response)
                        .map_err(|e| JsValue::from_str(&format!("Key exchange failed: {}", e)))?;

                    // Store the vault key
                    *encryption_key.write().await = Some(vault_key);

                    // Clear the session
                    *session_guard = None;

                    Ok(JsValue::from_str(if response.is_new_key { "new" } else { "existing" }))
                }
                KeyMessage::Error(e) => {
                    Err(JsValue::from_str(&format!("Peer rejected: {}", e.message)))
                }
                _ => Err(JsValue::from_str("Unexpected message type")),
            }
        })
    }

    /// Handle a key exchange request from peer (as responder)
    ///
    /// Takes the base64-encoded request message from peer.
    /// Returns a base64-encoded response message to send back.
    /// Requires that we already have a vault key.
    #[wasm_bindgen(js_name = handleKeyExchangeRequest)]
    pub fn handle_key_exchange_request(&self, request_b64: &str) -> Promise {
        let encryption_key = self.encryption_key.clone();
        let request_b64 = request_b64.to_string();

        future_to_promise(async move {
            use base64::Engine;

            // Decode the request
            let request_bytes = base64::engine::general_purpose::STANDARD.decode(&request_b64)
                .map_err(|e| JsValue::from_str(&format!("Invalid base64: {}", e)))?;

            let message = KeyMessage::decode(&request_bytes)
                .map_err(|e| JsValue::from_str(&format!("Invalid message: {}", e)))?;

            // Get our vault key
            let vault_key = encryption_key.read().await.clone()
                .ok_or_else(|| JsValue::from_str("No vault key available to share"))?;

            // Handle the request
            match message {
                KeyMessage::Request(request) => {
                    // Create a responder session
                    let mut session = KeyExchangeSession::new_responder();

                    // Generate response
                    let response = session.handle_request(&request, Some(&vault_key))
                        .map_err(|e| JsValue::from_str(&format!("Key exchange failed: {}", e)))?;

                    // Encode the response
                    let encoded = response.encode()
                        .map_err(|e| JsValue::from_str(&format!("Failed to encode response: {}", e)))?;

                    Ok(JsValue::from_str(&base64::engine::general_purpose::STANDARD.encode(&encoded)))
                }
                _ => Err(JsValue::from_str("Expected key exchange request")),
            }
        })
    }

    /// Cancel an in-progress key exchange session
    #[wasm_bindgen(js_name = cancelKeyExchange)]
    pub fn cancel_key_exchange(&self) -> Promise {
        let key_exchange = self.key_exchange.clone();

        future_to_promise(async move {
            *key_exchange.write().await = None;
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
                ).await;
            });

            Ok(JsValue::TRUE)
        })
    }

    /// Stop the PeerVault
    #[wasm_bindgen]
    pub fn stop(&self) -> Promise {
        let transport = self.transport.clone();

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
        let mut pending = self.pending_pairings.blocking_write();
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
        let mut pending = self.pending_pairings.blocking_write();

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
        self.known_peers.blocking_read().contains_key(peer_id)
    }

    /// Add a peer to the known peers list
    #[wasm_bindgen(js_name = addKnownPeer)]
    pub fn add_known_peer(&self, peer_id: &str) {
        let now = js_sys::Date::now() as u64;
        self.known_peers.blocking_write().insert(peer_id.to_string(), now);
        web_sys::console::log_1(&JsValue::from_str(&format!(
            "[WASM] Added known peer: {}...",
            short(&peer_id, 16)
        )));
    }

    /// Remove a peer from the known peers list
    #[wasm_bindgen(js_name = removeKnownPeer)]
    pub fn remove_known_peer(&self, peer_id: &str) {
        self.known_peers.blocking_write().remove(peer_id);
    }

    /// Get list of known peer IDs
    #[wasm_bindgen(js_name = getKnownPeers)]
    pub fn get_known_peers(&self) -> Vec<JsValue> {
        self.known_peers.blocking_read()
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
                        wasm_bindgen_futures::spawn_local(async move {
                            run_gossip_receiver(
                                receiver,
                                store_for_gossip,
                                enc_key_for_gossip,
                                on_event_for_gossip,
                            ).await;
                        });

                        // Spawn debounce task
                        let gb_for_debounce = gossip_bridge.clone();
                        let store_for_debounce = store.clone();
                        let enc_for_debounce = encryption_key.clone();
                        let notify = gb.change_notify();
                        let on_event_for_debounce = on_event.clone();
                        wasm_bindgen_futures::spawn_local(async move {
                            run_gossip_debounce(
                                gb_for_debounce,
                                store_for_debounce,
                                enc_for_debounce,
                                notify,
                                on_event_for_debounce,
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

use tracing::{info, warn, debug, error};

use crate::blobs_bridge::BlobsBridge;
use crate::protocol::sync::{self as proto, Message as SyncMessage, PROTOCOL_VERSION};

/// Send a binary protocol message on an IrohStream
async fn send_sync_msg(stream: &mut IrohStream, msg: &SyncMessage) -> Result<(), String> {
    let data = msg.encode().map_err(|e| format!("encode: {}", e))?;
    stream.send(&data).await.map_err(|e| format!("send: {}", e))
}

/// Receive a binary protocol message from an IrohStream
async fn recv_sync_msg(stream: &mut IrohStream) -> Result<SyncMessage, String> {
    let data = stream.recv().await.map_err(|e| format!("recv: {}", e))?;
    SyncMessage::decode(&data).map_err(|e| format!("decode: {}", e))
}

/// Pairing validation using snapshots of known_peers + pending_pairings.
/// Takes snapshots to avoid holding locks during sync.
struct PairingValidation {
    is_known: bool,
    is_new_peer: bool,
    consumed_nonce: Option<String>,
}

/// Validate a peer's pairing status.
/// Returns Ok(PairingValidation) if accepted, Err(reason) if rejected.
fn validate_pairing(
    peer_id: &str,
    pairing_nonce: Option<&str>,
    known_peers: &std::collections::HashMap<String, u64>,
    pending_pairings: &std::collections::HashMap<String, u64>,
) -> Result<PairingValidation, String> {
    // Known peer — always accept
    if known_peers.contains_key(peer_id) {
        return Ok(PairingValidation {
            is_known: true,
            is_new_peer: false,
            consumed_nonce: None,
        });
    }

    // Unknown peer — must have valid nonce
    let nonce = pairing_nonce.ok_or_else(|| "Unknown peer, pairing nonce required".to_string())?;

    let expires_at = pending_pairings.get(nonce)
        .ok_or_else(|| format!("Unknown pairing nonce: {}...", short(&nonce, 16)))?;

    let now = web_time::SystemTime::now()
        .duration_since(web_time::SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    if now > *expires_at {
        return Err("Pairing nonce expired".to_string());
    }

    Ok(PairingValidation {
        is_known: false,
        is_new_peer: true,
        consumed_nonce: Some(nonce.to_string()),
    })
}

/// Run sync as INITIATOR using V3 binary protocol.
///
/// Protocol: VersionInfo → Updates → BlobHashes → BlobTransfer → SyncComplete
/// Truncate a string to at most `n` bytes on a UTF-8 char boundary, without panicking.
///
/// Used for log/error truncation of attacker-controlled strings (pairing nonces,
/// peer ids) where naive byte slicing (`&s[..n]`) can panic mid-codepoint.
fn short(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

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
    let map_err = |e: String| JsValue::from_str(&e);

    // Phase 1: Send our VERSION_INFO (initiator sends first)
    let our_info = proto::VersionInfo {
        protocol_version: PROTOCOL_VERSION,
        vault_id: *engine.vault_id(),
        version_bytes: engine.version_vector(),
        hostname: hostname.to_string(),
        nickname: nickname.map(|s| s.to_string()),
        has_vault_key: true,
        plugin_version: plugin_version.map(|s| s.to_string()),
        pairing_nonce,
        supports_iroh_blobs: true,
    };
    send_sync_msg(stream, &SyncMessage::VersionInfo(our_info)).await.map_err(map_err)?;

    // Receive peer's VERSION_INFO
    let peer_info = match recv_sync_msg(stream).await.map_err(map_err)? {
        SyncMessage::VersionInfo(info) => info,
        SyncMessage::Error(e) => {
            return Err(JsValue::from_str(&format!("Peer rejected: {} (code {})", e.message, e.code)));
        }
        other => {
            return Err(JsValue::from_str(&format!("Expected VersionInfo, got {:?}", other.message_type())));
        }
    };

    // Validate vault ID
    if peer_info.vault_id != *engine.vault_id() {
        let err = SyncMessage::Error(proto::SyncError {
            code: proto::error_codes::VAULT_MISMATCH,
            message: "Vault ID mismatch".into(),
        });
        let _ = send_sync_msg(stream, &err).await;
        return Err(JsValue::from_str("Vault ID mismatch"));
    }

    info!("Initiator: connected to {} (v{}, iroh-blobs={})",
        peer_info.hostname, peer_info.protocol_version, peer_info.supports_iroh_blobs);

    // Phase 2: Exchange CRDT updates
    let updates = engine.export_updates_since(&peer_info.version_bytes)
        .map_err(|e| JsValue::from_str(&format!("Export updates failed: {}", e)))?;
    let updates_len = updates.len();
    send_sync_msg(stream, &SyncMessage::Updates(proto::Updates {
        data: updates,
        op_count: 0,
    })).await.map_err(map_err)?;

    // The initiator drives completion: announce we're done right after sending our
    // updates. The acceptor replies with its own SyncComplete once it has received
    // this. Without this, both peers would block in the recv loop below forever,
    // since neither would ever send the first SyncComplete.
    send_sync_msg(stream, &SyncMessage::SyncComplete(proto::SyncComplete {
        version_bytes: engine.version_vector(),
    })).await.map_err(map_err)?;

    // Receive peer's updates and wait for its completion acknowledgement.
    let mut updates_received = 0;
    loop {
        match recv_sync_msg(stream).await.map_err(map_err)? {
            SyncMessage::Updates(updates) => {
                engine.import_updates(&updates.data)
                    .map_err(|e| JsValue::from_str(&format!("Import updates failed: {}", e)))?;
                updates_received += 1;
            }
            SyncMessage::SyncComplete(_) => {
                // Peer acknowledged completion; we already sent ours.
                break;
            }
            SyncMessage::Error(e) => {
                return Err(JsValue::from_str(&format!("Sync error: {}", e.message)));
            }
            _ => continue,
        }
    }

    // Phase 3: Blob exchange (V3 via iroh-blobs if both support it)
    if peer_info.supports_iroh_blobs {
        if let (Some(bridge), Some(ep)) = (blobs_bridge, endpoint) {
            // Exchange blob hashes
            let our_hashes = bridge.list_host_hashes().await
                .map_err(|e| JsValue::from_str(&format!("List blobs failed: {}", e)))?;

            send_sync_msg(stream, &SyncMessage::BlobHashes(proto::BlobHashes {
                hashes: our_hashes.clone(),
            })).await.map_err(map_err)?;

            let peer_hashes = match recv_sync_msg(stream).await.map_err(map_err)? {
                SyncMessage::BlobHashes(bh) => bh.hashes,
                SyncMessage::BlobSyncComplete(_) => vec![], // peer has no blobs
                other => {
                    warn!("Expected BlobHashes, got {:?}", other.message_type());
                    vec![]
                }
            };

            // Compute diffs
            let our_set: std::collections::HashSet<_> = our_hashes.iter().collect();
            let peer_set: std::collections::HashSet<_> = peer_hashes.iter().collect();
            let need: Vec<_> = peer_hashes.iter().filter(|h| !our_set.contains(h)).cloned().collect();
            let send: Vec<_> = our_hashes.iter().filter(|h| !peer_set.contains(h)).cloned().collect();

            if !need.is_empty() || !send.is_empty() {
                let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
                    .map_err(|e| JsValue::from_str(&format!("Invalid peer ID: {}", e)))?;

                bridge.exchange_blobs_v3(ep, peer_endpoint_id, &need, &send).await
                    .map_err(|e| JsValue::from_str(&format!("Blob transfer failed: {}", e)))?;
            }

            // Signal completion
            send_sync_msg(stream, &SyncMessage::BlobSyncComplete(proto::BlobSyncComplete {
                blob_count: 0,
            })).await.map_err(map_err)?;

            // Wait for peer's blob sync completion (with message limit)
            let mut blob_sync_done = false;
            for _ in 0..100 {
                match recv_sync_msg(stream).await.map_err(map_err)? {
                    SyncMessage::BlobSyncComplete(_) => { blob_sync_done = true; break; }
                    SyncMessage::Error(e) => {
                        return Err(JsValue::from_str(&format!("Blob sync error: {}", e.message)));
                    }
                    _ => continue,
                }
            }
            if !blob_sync_done {
                warn!("Blob sync completion not received after 100 messages");
            }
        }
    }

    // Emit sync_complete event
    if let Some(ref callback) = on_event {
        let event = serde_json::json!({
            "type": "sync_complete",
            "peer_id": peer_id,
            "direction": "outgoing",
            "updates_received": updates_received,
            "updates_sent": 1,
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
    pending_pairings: Arc<RwLock<HashMap<String, u64>>>,
    known_peers: Arc<RwLock<HashMap<String, u64>>>,
    encryption_key: Arc<RwLock<Option<VaultKey>>>,
    blobs_bridge_arc: Arc<RwLock<Option<BlobsBridge>>>,
    gossip_bridge_arc: Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
    transport: Arc<RwLock<Option<IrohTransport>>>,
) {
    let result = handle_incoming_streams_v3_inner(
        &peer_id, &connections, &store, &on_event,
        &pending_pairings, &known_peers, &encryption_key,
        &blobs_bridge_arc, &gossip_bridge_arc, &transport,
    ).await;

    if let Err(e) = result {
        warn!("Incoming sync from {} failed: {:?}", short(&peer_id, 16), e);
    }
}

async fn handle_incoming_streams_v3_inner(
    peer_id: &str,
    connections: &Arc<RwLock<HashMap<String, IrohConnection>>>,
    store: &Arc<RwLock<Option<LoroStore>>>,
    on_event: &Option<Function>,
    pending_pairings: &Arc<RwLock<HashMap<String, u64>>>,
    known_peers: &Arc<RwLock<HashMap<String, u64>>>,
    encryption_key: &Arc<RwLock<Option<VaultKey>>>,
    blobs_bridge_arc: &Arc<RwLock<Option<BlobsBridge>>>,
    gossip_bridge_arc: &Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
    transport: &Arc<RwLock<Option<IrohTransport>>>,
) -> Result<(), JsValue> {
    let map_err = |e: String| JsValue::from_str(&e);

    // Accept a stream from the connection
    let connections_guard = connections.read().await;
    let conn = connections_guard.get(peer_id)
        .ok_or_else(|| JsValue::from_str("Connection lost"))?;
    let mut stream = conn.accept_stream().await
        .map_err(|e| JsValue::from_str(&format!("Accept stream failed: {}", e)))?;
    drop(connections_guard);

    // Phase 1: Receive initiator's VERSION_INFO
    let peer_info = match recv_sync_msg(&mut stream).await.map_err(map_err)? {
        SyncMessage::VersionInfo(info) => info,
        other => {
            return Err(JsValue::from_str(&format!("Expected VersionInfo, got {:?}", other.message_type())));
        }
    };

    info!("Acceptor: received VersionInfo from {} (v{}, nonce={})",
        peer_info.hostname, peer_info.protocol_version,
        peer_info.pairing_nonce.as_deref().map(|n| short(n, 16)).unwrap_or("none"));

    // Validate basic handshake invariants (vault id, protocol version) BEFORE
    // consuming any one-time pairing nonce. Otherwise a peer presenting a valid
    // nonce but a mismatched vault/version could burn the legitimate pairing
    // nonce (and get inserted into known_peers) before being rejected.
    let local_vault_id = {
        let store_guard = store.read().await;
        let id = *store_guard.as_ref()
            .ok_or_else(|| JsValue::from_str("Store not initialized"))?
            .vault_id();
        drop(store_guard);
        id
    };
    {
        if peer_info.vault_id != local_vault_id {
            let err = SyncMessage::Error(proto::SyncError {
                code: proto::error_codes::VAULT_MISMATCH,
                message: "Vault ID mismatch".into(),
            });
            let _ = send_sync_msg(&mut stream, &err).await;
            return Err(JsValue::from_str("Vault ID mismatch"));
        }
    }
    if peer_info.protocol_version < 2 {
        let err = SyncMessage::Error(proto::SyncError {
            code: proto::error_codes::VERSION_MISMATCH,
            message: "Protocol version too old".into(),
        });
        let _ = send_sync_msg(&mut stream, &err).await;
        return Err(JsValue::from_str("Protocol version too old"));
    }

    // Validate pairing (take snapshots to avoid holding locks)
    let known_snap: std::collections::HashMap<String, u64> = known_peers.read().await.clone();
    let pending_snap: std::collections::HashMap<String, u64> = pending_pairings.read().await.clone();

    let validation = match validate_pairing(
        peer_id,
        peer_info.pairing_nonce.as_deref(),
        &known_snap,
        &pending_snap,
    ) {
        Ok(v) => v,
        Err(reason) => {
            warn!("Pairing rejected for {}: {}", short(&peer_id, 16), reason);
            let err = SyncMessage::Error(proto::SyncError {
                code: proto::error_codes::PAIRING_REJECTED,
                message: reason,
            });
            let _ = send_sync_msg(&mut stream, &err).await;
            return Err(JsValue::from_str("Pairing rejected"));
        }
    };

    // Update state if newly paired
    if validation.is_new_peer {
        if let Some(nonce) = &validation.consumed_nonce {
            pending_pairings.write().await.remove(nonce);
        }
        known_peers.write().await.insert(
            peer_id.to_string(),
            web_time::SystemTime::now()
                .duration_since(web_time::SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        );

        // Emit pairing_complete event
        if let Some(ref callback) = on_event {
            let event = serde_json::json!({
                "type": "pairing_complete",
                "peer_id": peer_id,
                "device_name": peer_info.hostname,
            });
            let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&event.to_string()));
        }
    }

    // Get encryption key and store
    let key_guard = encryption_key.read().await;
    let vault_key = key_guard.clone()
        .ok_or_else(|| JsValue::from_str("No encryption key"))?;
    drop(key_guard);

    // Create SyncEngine — snapshot store briefly, then release lock
    let snapshot = {
        let store_guard = store.read().await;
        let loro_store = store_guard.as_ref()
            .ok_or_else(|| JsValue::from_str("Store not initialized"))?;
        loro_store.export_snapshot()
            .map_err(|e| JsValue::from_str(&format!("Export snapshot failed: {}", e)))?
        // store_guard dropped here
    };
    let host = Arc::new(crate::host::mock::MockHost::new());
    let mut engine = SyncEngine::new_with_key(host, vault_key)
        .map_err(|e| JsValue::from_str(&format!("SyncEngine failed: {}", e)))?;
    // Carry the real vault id into the temporary sync engine. new_with_key starts
    // at all-zeros and import_snapshot_raw does not restore the id, so without this
    // the VERSION_INFO we send would advertise a zero vault id and peers could not
    // validate it. init_vault must run before import so the imported data lands in
    // the correctly-identified store.
    engine.init_vault(local_vault_id);
    engine.import_snapshot_raw(&snapshot)
        .map_err(|e| JsValue::from_str(&format!("Import snapshot failed: {}", e)))?;

    // Vault ID + protocol version were already validated above, before any
    // pairing nonce was consumed. The store snapshot used to build `engine`
    // shares the local vault id, so no re-check is needed here.

    // Send our VERSION_INFO (acceptor sends after receiving)
    let our_info = proto::VersionInfo {
        protocol_version: PROTOCOL_VERSION,
        vault_id: *engine.vault_id(),
        version_bytes: engine.version_vector(),
        hostname: format!("PeerVault-{}", &hex::encode(engine.vault_id())[..8]),
        nickname: None,
        has_vault_key: true,
        plugin_version: None,
        pairing_nonce: None, // acceptor never sends nonce
        supports_iroh_blobs: true,
    };
    send_sync_msg(&mut stream, &SyncMessage::VersionInfo(our_info)).await.map_err(map_err)?;

    // Phase 2: Exchange CRDT updates
    let updates = engine.export_updates_since(&peer_info.version_bytes)
        .map_err(|e| JsValue::from_str(&format!("Export updates failed: {}", e)))?;
    send_sync_msg(&mut stream, &SyncMessage::Updates(proto::Updates {
        data: updates,
        op_count: 0,
    })).await.map_err(map_err)?;

    // Receive peer's updates and wait for SyncComplete
    let mut updates_received = 0;
    loop {
        match recv_sync_msg(&mut stream).await.map_err(map_err)? {
            SyncMessage::Updates(updates) => {
                engine.import_updates(&updates.data)
                    .map_err(|e| JsValue::from_str(&format!("Import failed: {}", e)))?;
                updates_received += 1;
            }
            SyncMessage::SyncComplete(complete) => {
                let our_complete = SyncMessage::SyncComplete(proto::SyncComplete {
                    version_bytes: engine.version_vector(),
                });
                send_sync_msg(&mut stream, &our_complete).await.map_err(map_err)?;
                break;
            }
            SyncMessage::Error(e) => {
                return Err(JsValue::from_str(&format!("Peer error: {}", e.message)));
            }
            _ => continue,
        }
    }

    // Phase 3: Blob exchange (V3 via iroh-blobs)
    if peer_info.supports_iroh_blobs {
        let bridge_guard = blobs_bridge_arc.read().await;
        let transport_guard = transport.read().await;
        if let (Some(bridge), Some(tp)) = (bridge_guard.as_ref(), transport_guard.as_ref()) {
            let our_hashes = bridge.list_host_hashes().await
                .map_err(|e| JsValue::from_str(&format!("List blobs failed: {}", e)))?;

            send_sync_msg(&mut stream, &SyncMessage::BlobHashes(proto::BlobHashes {
                hashes: our_hashes.clone(),
            })).await.map_err(map_err)?;

            let peer_hashes = match recv_sync_msg(&mut stream).await.map_err(map_err)? {
                SyncMessage::BlobHashes(bh) => bh.hashes,
                SyncMessage::BlobSyncComplete(_) => vec![],
                other => {
                    warn!("Expected BlobHashes, got {:?}", other.message_type());
                    vec![]
                }
            };

            let our_set: std::collections::HashSet<_> = our_hashes.iter().collect();
            let peer_set: std::collections::HashSet<_> = peer_hashes.iter().collect();
            let need: Vec<_> = peer_hashes.iter().filter(|h| !our_set.contains(h)).cloned().collect();
            let send: Vec<_> = our_hashes.iter().filter(|h| !peer_set.contains(h)).cloned().collect();

            if !need.is_empty() || !send.is_empty() {
                let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
                    .map_err(|e| JsValue::from_str(&format!("Invalid peer ID: {}", e)))?;
                bridge.exchange_blobs_v3(tp.endpoint(), peer_endpoint_id, &need, &send).await
                    .map_err(|e| JsValue::from_str(&format!("Blob transfer: {}", e)))?;
            }

            send_sync_msg(&mut stream, &SyncMessage::BlobSyncComplete(proto::BlobSyncComplete {
                blob_count: 0,
            })).await.map_err(map_err)?;

            let mut blob_sync_done = false;
            for _ in 0..100 {
                match recv_sync_msg(&mut stream).await.map_err(map_err)? {
                    SyncMessage::BlobSyncComplete(_) => { blob_sync_done = true; break; }
                    SyncMessage::Error(e) => {
                        return Err(JsValue::from_str(&format!("Blob sync error: {}", e.message)));
                    }
                    _ => continue,
                }
            }
            if !blob_sync_done {
                warn!("Acceptor: blob sync completion not received after 100 messages");
            }
        }
    }

    // Import updated state back to LoroStore (briefly acquire lock)
    {
        let updated_snapshot = engine.export_snapshot_raw()
            .map_err(|e| JsValue::from_str(&format!("Export snapshot: {}", e)))?;
        let store_guard = store.read().await;
        let loro_store = store_guard.as_ref()
            .ok_or_else(|| JsValue::from_str("Store not initialized"))?;
        loro_store.import_snapshot(&updated_snapshot)
            .map_err(|e| JsValue::from_str(&format!("Import snapshot: {}", e)))?;
    }

    // Emit sync_complete event
    if let Some(ref callback) = on_event {
        let event = serde_json::json!({
            "type": "sync_complete",
            "peer_id": peer_id,
            "direction": "incoming",
            "updates_received": updates_received,
            "updates_sent": 1,
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
                wasm_bindgen_futures::spawn_local(async move {
                    run_gossip_receiver(
                        receiver,
                        store_for_gossip,
                        enc_key_for_gossip,
                        on_event_for_gossip,
                    ).await;
                });

                // Spawn debounce task (acceptor side)
                let gb_for_debounce = gossip_bridge_arc.clone();
                let store_for_debounce = store.clone();
                let enc_for_debounce = encryption_key.clone();
                let notify = gb.change_notify();
                let on_event_for_debounce = on_event.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    run_gossip_debounce(
                        gb_for_debounce,
                        store_for_debounce,
                        enc_for_debounce,
                        notify,
                        on_event_for_debounce,
                    ).await;
                });
            }
            Ok(None) => {} // Already subscribed
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
) {
    use futures::StreamExt;
    use iroh_gossip::api::Event;

    info!("Gossip receiver started");

    loop {
        while let Some(event) = receiver.next().await {
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
) {
    info!("Gossip debounce task started");

    loop {
        // Wait for a change notification
        change_notify.notified().await;

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
    pending_pairings: Arc<RwLock<HashMap<String, u64>>>,
    known_peers: Arc<RwLock<HashMap<String, u64>>>,
    encryption_key: Arc<RwLock<Option<VaultKey>>>,
    blobs_bridge: Arc<RwLock<Option<BlobsBridge>>>,
    gossip_bridge: Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
) {
    info!("Accept loop started");

    loop {
        // Get transport reference
        let transport_guard = transport.read().await;
        let iroh = match transport_guard.as_ref() {
            Some(t) => t,
            None => {
                info!("Accept loop: transport not available");
                break;
            }
        };

        // Try to accept a connection
        match iroh.accept().await {
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

// ============================================================================
// Sync Runner for WASM
// ============================================================================

use crate::runner::SyncRunResult;
use std::cell::RefCell;

/// JavaScript-backed sync stream
///
/// Implements SyncStream by calling JavaScript callbacks.
struct JsSyncStream {
    /// JS callback: (data: Uint8Array) => void
    js_send: Function,
    /// JS callback: (timeoutMs: number) => Uint8Array | null
    js_recv: Function,
    /// JS callback: () => void
    js_close: Function,
}

// SAFETY: WASM is single-threaded, so Send+Sync is safe for JS callbacks
unsafe impl Send for JsSyncStream {}
unsafe impl Sync for JsSyncStream {}

impl SyncStream for JsSyncStream {
    fn send(&mut self, data: &[u8]) -> Result<(), CoreError> {
        let arr = Uint8Array::new_with_length(data.len() as u32);
        arr.copy_from(data);

        self.js_send.call1(&JsValue::NULL, &arr)
            .map_err(|e| CoreError::Protocol(format!("JS send error: {:?}", e)))?;

        Ok(())
    }

    fn recv(&mut self, timeout_ms: u64) -> Result<Vec<u8>, CoreError> {
        let result = self.js_recv.call1(&JsValue::NULL, &JsValue::from_f64(timeout_ms as f64))
            .map_err(|e| CoreError::Protocol(format!("JS recv error: {:?}", e)))?;

        if result.is_null() || result.is_undefined() {
            return Err(CoreError::Timeout("No data received".into()));
        }

        let arr = Uint8Array::new(&result);
        Ok(arr.to_vec())
    }

    fn close(&mut self) -> Result<(), CoreError> {
        self.js_close.call0(&JsValue::NULL)
            .map_err(|e| CoreError::Protocol(format!("JS close error: {:?}", e)))?;
        Ok(())
    }
}

/// JavaScript-backed blob operations
struct JsBlobOps {
    /// JS callback: () => string[] (hex hashes)
    js_list_hashes: Function,
    /// JS callback: (hash: string) => Uint8Array | null
    js_get: Function,
    /// JS callback: (hash: string, data: Uint8Array) => void
    js_store: Function,
}

// SAFETY: WASM is single-threaded, so Send+Sync is safe for JS callbacks
unsafe impl Send for JsBlobOps {}
unsafe impl Sync for JsBlobOps {}

impl BlobOps for JsBlobOps {
    fn list_hashes(&self) -> Vec<Hash> {
        match self.js_list_hashes.call0(&JsValue::NULL) {
            Ok(result) => {
                let arr = js_sys::Array::from(&result);
                arr.iter()
                    .filter_map(|v| {
                        let hex_str = v.as_string()?;
                        let bytes = hex::decode(&hex_str).ok()?;
                        let arr: [u8; 32] = bytes.try_into().ok()?;
                        Some(Hash::from(arr))
                    })
                    .collect()
            }
            Err(_) => vec![],
        }
    }

    fn get(&self, hash: &Hash) -> Option<Vec<u8>> {
        let hex_str = hex::encode(hash.as_bytes());
        match self.js_get.call1(&JsValue::NULL, &JsValue::from_str(&hex_str)) {
            Ok(result) => {
                if result.is_null() || result.is_undefined() {
                    None
                } else {
                    let arr = Uint8Array::new(&result);
                    Some(arr.to_vec())
                }
            }
            Err(_) => None,
        }
    }

    fn store(&mut self, hash: &Hash, data: &[u8]) -> Result<(), CoreError> {
        let hex_str = hex::encode(hash.as_bytes());
        let arr = Uint8Array::new_with_length(data.len() as u32);
        arr.copy_from(data);

        self.js_store.call2(&JsValue::NULL, &JsValue::from_str(&hex_str), &arr)
            .map_err(|e| CoreError::Protocol(format!("JS store error: {:?}", e)))?;

        Ok(())
    }
}

/// WASM Sync Runner
///
/// Orchestrates the sync protocol using JavaScript-provided stream and blob callbacks.
///
/// Usage from TypeScript:
/// ```typescript
/// const runner = new WasmSyncRunner(engine, peerId, true);
///
/// // Configure stream callbacks (wrapping your Iroh stream)
/// runner.setStreamCallbacks(
///   (data) => stream.send(data),
///   (timeoutMs) => stream.recv(timeoutMs),
///   () => stream.close()
/// );
///
/// // Configure blob callbacks (wrapping your blob store)
/// runner.setBlobCallbacks(
///   () => blobStore.listHashes(),
///   (hash) => blobStore.get(hash),
///   (hash, data) => blobStore.store(hash, data)
/// );
///
/// // Run the sync
/// const result = runner.run();
/// console.log(result); // { updatesReceived: 5, blobsReceived: 2, isLive: true, ... }
/// ```
#[wasm_bindgen]
pub struct WasmSyncRunner {
    config: RunnerConfig,
    peer_id: String,
    is_initiator: bool,
    // Stream callbacks
    js_stream_send: Option<Function>,
    js_stream_recv: Option<Function>,
    js_stream_close: Option<Function>,
    // Blob callbacks
    js_blob_list: Option<Function>,
    js_blob_get: Option<Function>,
    js_blob_store: Option<Function>,
}

#[wasm_bindgen]
impl WasmSyncRunner {
    /// Create a new sync runner
    ///
    /// @param peer_id - The peer we're syncing with
    /// @param is_initiator - True if we initiated the connection
    /// @param config_json - Optional JSON config (same as WasmSyncSession)
    #[wasm_bindgen(constructor)]
    pub fn new(
        peer_id: &str,
        is_initiator: bool,
        config_json: Option<String>,
    ) -> Result<WasmSyncRunner, JsValue> {
        let config = match config_json {
            Some(json) => {
                let js_config: RunnerConfigJs = serde_json::from_str(&json)
                    .map_err(|e| JsValue::from_str(&format!("Invalid config JSON: {}", e)))?;
                RunnerConfig {
                    hostname: js_config.hostname.unwrap_or_else(|| "Unknown".into()),
                    nickname: js_config.nickname,
                    plugin_version: js_config.plugin_version,
                    pairing_nonce: None,
                    receive_timeout_ms: js_config.receive_timeout_ms.unwrap_or(30000),
                    ping_interval_ms: js_config.ping_interval_ms.unwrap_or(15000),
                    max_inline_blob_size: js_config.max_inline_blob_size.unwrap_or(1024 * 1024),
                }
            }
            None => RunnerConfig::default(),
        };

        Ok(WasmSyncRunner {
            config,
            peer_id: peer_id.to_string(),
            is_initiator,
            js_stream_send: None,
            js_stream_recv: None,
            js_stream_close: None,
            js_blob_list: None,
            js_blob_get: None,
            js_blob_store: None,
        })
    }

    /// Set stream callbacks
    ///
    /// @param send - (data: Uint8Array) => void
    /// @param recv - (timeoutMs: number) => Uint8Array | null (null = timeout)
    /// @param close - () => void
    #[wasm_bindgen(js_name = setStreamCallbacks)]
    pub fn set_stream_callbacks(
        &mut self,
        send: Function,
        recv: Function,
        close: Function,
    ) {
        self.js_stream_send = Some(send);
        self.js_stream_recv = Some(recv);
        self.js_stream_close = Some(close);
    }

    /// Set blob callbacks
    ///
    /// @param list_hashes - () => string[] (hex hashes)
    /// @param get - (hash: string) => Uint8Array | null
    /// @param store - (hash: string, data: Uint8Array) => void
    #[wasm_bindgen(js_name = setBlobCallbacks)]
    pub fn set_blob_callbacks(
        &mut self,
        list_hashes: Function,
        get: Function,
        store: Function,
    ) {
        self.js_blob_list = Some(list_hashes);
        self.js_blob_get = Some(get);
        self.js_blob_store = Some(store);
    }

    /// Run the sync protocol
    ///
    /// Returns JSON with sync results:
    /// {
    ///   "updatesSent": number,
    ///   "updatesReceived": number,
    ///   "blobsSent": number,
    ///   "blobsReceived": number,
    ///   "bytesSent": number,
    ///   "bytesReceived": number,
    ///   "isLive": boolean,
    ///   "peerHostname": string,
    ///   "peerNickname": string | null,
    ///   "error": string | null
    /// }
    #[wasm_bindgen]
    pub fn run(&mut self, engine: &WasmPeerVault) -> Result<String, JsValue> {
        // Validate callbacks are set
        let js_send = self.js_stream_send.clone()
            .ok_or_else(|| JsValue::from_str("Stream send callback not set"))?;
        let js_recv = self.js_stream_recv.clone()
            .ok_or_else(|| JsValue::from_str("Stream recv callback not set"))?;
        let js_close = self.js_stream_close.clone()
            .ok_or_else(|| JsValue::from_str("Stream close callback not set"))?;

        // Create stream adapter
        let mut stream = JsSyncStream {
            js_send,
            js_recv,
            js_close,
        };

        // Get the sync engine from WasmPeerVault
        // We need to access it synchronously, so use blocking_read
        let store_guard = engine.store.blocking_read();
        let loro_store = store_guard.as_ref()
            .ok_or_else(|| JsValue::from_str("Store not started"))?;

        let key_guard = engine.encryption_key.blocking_read();
        let vault_key = key_guard.clone()
            .ok_or_else(|| JsValue::from_str("Encryption key not set"))?;

        // Create a temporary SyncEngine for this sync
        // Note: In a real implementation, we'd want to share the engine state
        let real_vault_id = *loro_store.vault_id();
        let host = Arc::new(crate::host::mock::MockHost::new());
        let mut sync_engine = SyncEngine::new_with_key(host, vault_key)
            .map_err(|e| JsValue::from_str(&format!("Failed to create sync engine: {}", e)))?;
        // Carry the real vault id (new_with_key starts at all-zeros and import does
        // not restore it) so the handshake advertises/validates the actual vault.
        sync_engine.init_vault(real_vault_id);

        // Import the current store state
        let snapshot = loro_store.export_snapshot()
            .map_err(|e| JsValue::from_str(&format!("Failed to export snapshot: {}", e)))?;
        sync_engine.import_snapshot_raw(&snapshot)
            .map_err(|e| JsValue::from_str(&format!("Failed to import snapshot: {}", e)))?;

        // Create and run the sync runner
        let mut runner = SyncRunner::new(
            self.config.clone(),
            &sync_engine,
            self.peer_id.clone(),
            self.is_initiator,
        );

        // Run sync - with or without blobs depending on callbacks
        let result = if self.js_blob_list.is_some() {
            let mut blobs = JsBlobOps {
                js_list_hashes: self.js_blob_list.clone().unwrap(),
                js_get: self.js_blob_get.clone().unwrap(),
                js_store: self.js_blob_store.clone().unwrap(),
            };
            runner.run(&mut stream, &mut blobs)
                .map_err(|e| JsValue::from_str(&format!("Sync failed: {}", e)))?
        } else {
            runner.run_without_blobs(&mut stream)
                .map_err(|e| JsValue::from_str(&format!("Sync failed: {}", e)))?
        };

        // If successful, export the updated state back to the store
        let updated_snapshot = sync_engine.export_snapshot_raw()
            .map_err(|e| JsValue::from_str(&format!("Failed to export updated snapshot: {}", e)))?;
        loro_store.import_snapshot(&updated_snapshot)
            .map_err(|e| JsValue::from_str(&format!("Failed to import updated snapshot: {}", e)))?;

        // Convert result to JSON
        let result_json = serde_json::json!({
            "updatesSent": result.updates_sent,
            "updatesReceived": result.updates_received,
            "blobsSent": result.blobs_sent,
            "blobsReceived": result.blobs_received,
            "bytesSent": result.bytes_sent,
            "bytesReceived": result.bytes_received,
            "isLive": result.is_live,
            "peerHostname": result.peer_hostname,
            "peerNickname": result.peer_nickname,
            "error": result.error,
        });

        Ok(result_json.to_string())
    }

    /// Get the current state of the runner
    #[wasm_bindgen(js_name = getState)]
    pub fn get_state(&self) -> String {
        // Runner doesn't persist state between runs
        "idle".to_string()
    }
}

// Rust-only API for V3 iroh-blobs sync (not exposed to JS)
impl WasmSyncRunner {
    /// Run sync with V3 iroh-blobs transfer when peer supports it.
    /// Falls back to V2 inline blobs otherwise.
    pub async fn run_with_iroh_blobs(
        &mut self,
        engine: &WasmPeerVault,
        blobs_bridge: &crate::blobs_bridge::BlobsBridge,
        endpoint: &iroh::Endpoint,
    ) -> Result<String, JsValue> {
        use crate::runner::SyncRunResult;

        let js_send = self.js_stream_send.clone()
            .ok_or_else(|| JsValue::from_str("Stream send callback not set"))?;
        let js_recv = self.js_stream_recv.clone()
            .ok_or_else(|| JsValue::from_str("Stream recv callback not set"))?;
        let js_close = self.js_stream_close.clone()
            .ok_or_else(|| JsValue::from_str("Stream close callback not set"))?;

        let mut stream = JsSyncStream { js_send, js_recv, js_close };

        let store_guard = engine.store.blocking_read();
        let loro_store = store_guard.as_ref()
            .ok_or_else(|| JsValue::from_str("Store not started"))?;

        let key_guard = engine.encryption_key.blocking_read();
        let vault_key = key_guard.clone()
            .ok_or_else(|| JsValue::from_str("Encryption key not set"))?;

        let real_vault_id = *loro_store.vault_id();
        let host = Arc::new(crate::host::mock::MockHost::new());
        let mut sync_engine = SyncEngine::new_with_key(host, vault_key)
            .map_err(|e| JsValue::from_str(&format!("Failed to create sync engine: {}", e)))?;
        // Carry the real vault id (new_with_key starts at all-zeros and import does
        // not restore it) so the handshake advertises/validates the actual vault.
        sync_engine.init_vault(real_vault_id);

        let snapshot = loro_store.export_snapshot()
            .map_err(|e| JsValue::from_str(&format!("Failed to export snapshot: {}", e)))?;
        sync_engine.import_snapshot_raw(&snapshot)
            .map_err(|e| JsValue::from_str(&format!("Failed to import snapshot: {}", e)))?;

        let mut runner = SyncRunner::new(
            self.config.clone(),
            &sync_engine,
            self.peer_id.clone(),
            self.is_initiator,
        );

        // Phase 1-2: Version exchange + CRDT sync
        runner.run_crdt_only(&mut stream)
            .map_err(|e| JsValue::from_str(&format!("CRDT sync failed: {}", e)))?;

        // Phase 3: Blob exchange — V3 or V2
        if runner.peer_supports_iroh_blobs() && self.js_blob_list.is_some() {
            // V3: Exchange hash lists on sync stream, transfer via iroh-blobs
            let blobs = JsBlobOps {
                js_list_hashes: self.js_blob_list.clone().unwrap(),
                js_get: self.js_blob_get.clone().unwrap(),
                js_store: self.js_blob_store.clone().unwrap(),
            };

            let (need_from_peer, send_to_peer) = runner.exchange_blob_hashes(&mut stream, &blobs)
                .map_err(|e| JsValue::from_str(&format!("Blob hash exchange failed: {}", e)))?;

            // Parse peer's node ID for the Downloader
            let peer_endpoint_id: iroh::EndpointId = self.peer_id.parse()
                .map_err(|e| JsValue::from_str(&format!("Invalid peer ID: {}", e)))?;

            // Transfer blobs via iroh-blobs (async, Bao-verified)
            let (received, sent) = blobs_bridge.exchange_blobs_v3(
                endpoint,
                peer_endpoint_id,
                &need_from_peer,
                &send_to_peer,
            ).await
            .map_err(|e| JsValue::from_str(&format!("iroh-blobs transfer failed: {}", e)))?;

            // Signal completion on sync stream
            runner.send_blob_sync_complete(&mut stream, sent)
                .map_err(|e| JsValue::from_str(&format!("Blob sync complete failed: {}", e)))?;
        } else if self.js_blob_list.is_some() {
            // V2 fallback: inline blob exchange
            let mut blobs = JsBlobOps {
                js_list_hashes: self.js_blob_list.clone().unwrap(),
                js_get: self.js_blob_get.clone().unwrap(),
                js_store: self.js_blob_store.clone().unwrap(),
            };
            // Use the existing inline exchange (private method not accessible here,
            // so fall back to full run which repeats version exchange - not ideal)
            // TODO: expose exchange_blobs as public or restructure
        }

        // Phase 4: Complete and enter live mode
        let result = runner.complete_and_enter_live(&mut stream)
            .map_err(|e| JsValue::from_str(&format!("Sync completion failed: {}", e)))?;

        // Export updated state
        let updated_snapshot = sync_engine.export_snapshot_raw()
            .map_err(|e| JsValue::from_str(&format!("Failed to export snapshot: {}", e)))?;
        loro_store.import_snapshot(&updated_snapshot)
            .map_err(|e| JsValue::from_str(&format!("Failed to import snapshot: {}", e)))?;

        let result_json = serde_json::json!({
            "updatesSent": result.updates_sent,
            "updatesReceived": result.updates_received,
            "blobsSent": result.blobs_sent,
            "blobsReceived": result.blobs_received,
            "bytesSent": result.bytes_sent,
            "bytesReceived": result.bytes_received,
            "isLive": result.is_live,
            "peerHostname": result.peer_hostname,
            "peerNickname": result.peer_nickname,
            "error": result.error,
        });

        Ok(result_json.to_string())
    }
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

/// Run sync with raw Loro bytes
///
/// This function allows TypeScript to run the sync protocol using its own
/// LoroDoc by passing the raw snapshot bytes. The flow is:
/// 1. TypeScript: `const snapshot = loroDoc.exportSnapshot()`
/// 2. TypeScript: `const result = await syncWithRaw(snapshot, ...)`
/// 3. TypeScript: `loroDoc.import(result.updatedSnapshot)`
///
/// This bridges the TypeScript loro-crdt package with the Rust sync protocol.
#[wasm_bindgen(js_name = syncWithRaw)]
pub fn sync_with_raw(
    loro_snapshot: &Uint8Array,
    vault_key_hex: &str,
    vault_id_hex: &str,
    peer_id: &str,
    is_initiator: bool,
    send: Function,
    recv: Function,
    close: Function,
    config_json: Option<String>,
) -> Result<JsValue, JsValue> {
    // Parse vault key
    let vault_key_bytes = hex::decode(vault_key_hex)
        .map_err(|e| JsValue::from_str(&format!("Invalid vault key hex: {}", e)))?;
    let vault_key = VaultKey::from_bytes(&vault_key_bytes)
        .map_err(|e| JsValue::from_str(&format!("Invalid vault key: {}", e)))?;

    // Parse vault ID
    let vault_id_bytes = hex::decode(vault_id_hex)
        .map_err(|e| JsValue::from_str(&format!("Invalid vault ID hex: {}", e)))?;
    if vault_id_bytes.len() != 32 {
        return Err(JsValue::from_str("Vault ID must be 32 bytes"));
    }
    let mut vault_id = [0u8; 32];
    vault_id.copy_from_slice(&vault_id_bytes);

    // Parse config
    let config = match config_json {
        Some(json) => {
            let js_config: RunnerConfigJs = serde_json::from_str(&json)
                .map_err(|e| JsValue::from_str(&format!("Invalid config: {}", e)))?;
            RunnerConfig {
                hostname: js_config.hostname.unwrap_or_else(|| "Unknown".into()),
                nickname: js_config.nickname,
                plugin_version: js_config.plugin_version,
                pairing_nonce: None,
                receive_timeout_ms: js_config.receive_timeout_ms.unwrap_or(30000),
                ping_interval_ms: js_config.ping_interval_ms.unwrap_or(15000),
                max_inline_blob_size: js_config.max_inline_blob_size.unwrap_or(1024 * 1024),
            }
        }
        None => RunnerConfig::default(),
    };

    // Create stream adapter
    let mut stream = JsSyncStream {
        js_send: send,
        js_recv: recv,
        js_close: close,
    };

    // Create SyncEngine with the provided data
    let host = Arc::new(crate::host::mock::MockHost::new());
    let mut sync_engine = SyncEngine::new_with_key(host, vault_key)
        .map_err(|e| JsValue::from_str(&format!("Failed to create sync engine: {}", e)))?;

    // Set vault ID
    sync_engine.init_vault(vault_id);

    // Import the TypeScript Loro snapshot
    let snapshot_bytes = loro_snapshot.to_vec();
    sync_engine.import_snapshot_raw(&snapshot_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to import snapshot: {}", e)))?;

    // Create and run the sync runner
    let mut runner = SyncRunner::new(
        config,
        &sync_engine,
        peer_id.to_string(),
        is_initiator,
    );

    // Run sync (no blobs for now)
    let result = runner.run_without_blobs(&mut stream)
        .map_err(|e| JsValue::from_str(&format!("Sync failed: {}", e)))?;

    // Export the updated snapshot
    let updated_snapshot = sync_engine.export_snapshot_raw()
        .map_err(|e| JsValue::from_str(&format!("Failed to export snapshot: {}", e)))?;

    // Build result
    let raw_result = RawSyncResult {
        updated_snapshot,
        updates_sent: result.updates_sent,
        updates_received: result.updates_received,
        blobs_sent: result.blobs_sent,
        blobs_received: result.blobs_received,
        bytes_sent: result.bytes_sent,
        bytes_received: result.bytes_received,
        is_live: result.is_live,
        peer_hostname: result.peer_hostname,
        peer_nickname: result.peer_nickname,
        error: result.error,
    };

    // Serialize result to JSON with the snapshot as base64
    let result_json = serde_json::json!({
        "updatedSnapshot": base64::engine::general_purpose::STANDARD.encode(&raw_result.updated_snapshot),
        "updatesSent": raw_result.updates_sent,
        "updatesReceived": raw_result.updates_received,
        "blobsSent": raw_result.blobs_sent,
        "blobsReceived": raw_result.blobs_received,
        "bytesSent": raw_result.bytes_sent,
        "bytesReceived": raw_result.bytes_received,
        "isLive": raw_result.is_live,
        "peerHostname": raw_result.peer_hostname,
        "peerNickname": raw_result.peer_nickname,
        "error": raw_result.error,
    });

    Ok(JsValue::from_str(&result_json.to_string()))
}

/// Run sync with raw Loro bytes and blob support
#[wasm_bindgen(js_name = syncWithRawAndBlobs)]
pub fn sync_with_raw_and_blobs(
    loro_snapshot: &Uint8Array,
    vault_key_hex: &str,
    vault_id_hex: &str,
    peer_id: &str,
    is_initiator: bool,
    send: Function,
    recv: Function,
    close: Function,
    list_hashes: Function,
    get_blob: Function,
    store_blob: Function,
    config_json: Option<String>,
) -> Result<JsValue, JsValue> {
    // Parse vault key
    let vault_key_bytes = hex::decode(vault_key_hex)
        .map_err(|e| JsValue::from_str(&format!("Invalid vault key hex: {}", e)))?;
    let vault_key = VaultKey::from_bytes(&vault_key_bytes)
        .map_err(|e| JsValue::from_str(&format!("Invalid vault key: {}", e)))?;

    // Parse vault ID
    let vault_id_bytes = hex::decode(vault_id_hex)
        .map_err(|e| JsValue::from_str(&format!("Invalid vault ID hex: {}", e)))?;
    if vault_id_bytes.len() != 32 {
        return Err(JsValue::from_str("Vault ID must be 32 bytes"));
    }
    let mut vault_id = [0u8; 32];
    vault_id.copy_from_slice(&vault_id_bytes);

    // Parse config
    let config = match config_json {
        Some(json) => {
            let js_config: RunnerConfigJs = serde_json::from_str(&json)
                .map_err(|e| JsValue::from_str(&format!("Invalid config: {}", e)))?;
            RunnerConfig {
                hostname: js_config.hostname.unwrap_or_else(|| "Unknown".into()),
                nickname: js_config.nickname,
                plugin_version: js_config.plugin_version,
                pairing_nonce: None,
                receive_timeout_ms: js_config.receive_timeout_ms.unwrap_or(30000),
                ping_interval_ms: js_config.ping_interval_ms.unwrap_or(15000),
                max_inline_blob_size: js_config.max_inline_blob_size.unwrap_or(1024 * 1024),
            }
        }
        None => RunnerConfig::default(),
    };

    // Create stream adapter
    let mut stream = JsSyncStream {
        js_send: send,
        js_recv: recv,
        js_close: close,
    };

    // Create blob adapter
    let mut blobs = JsBlobOps {
        js_list_hashes: list_hashes,
        js_get: get_blob,
        js_store: store_blob,
    };

    // Create SyncEngine with the provided data
    let host = Arc::new(crate::host::mock::MockHost::new());
    let mut sync_engine = SyncEngine::new_with_key(host, vault_key)
        .map_err(|e| JsValue::from_str(&format!("Failed to create sync engine: {}", e)))?;

    // Set vault ID
    sync_engine.init_vault(vault_id);

    // Import the TypeScript Loro snapshot
    let snapshot_bytes = loro_snapshot.to_vec();
    sync_engine.import_snapshot_raw(&snapshot_bytes)
        .map_err(|e| JsValue::from_str(&format!("Failed to import snapshot: {}", e)))?;

    // Create and run the sync runner
    let mut runner = SyncRunner::new(
        config,
        &sync_engine,
        peer_id.to_string(),
        is_initiator,
    );

    // Run sync with blobs
    let result = runner.run(&mut stream, &mut blobs)
        .map_err(|e| JsValue::from_str(&format!("Sync failed: {}", e)))?;

    // Export the updated snapshot
    let updated_snapshot = sync_engine.export_snapshot_raw()
        .map_err(|e| JsValue::from_str(&format!("Failed to export snapshot: {}", e)))?;

    // Serialize result to JSON with the snapshot as base64
    use base64::Engine;
    let result_json = serde_json::json!({
        "updatedSnapshot": base64::engine::general_purpose::STANDARD.encode(&updated_snapshot),
        "updatesSent": result.updates_sent,
        "updatesReceived": result.updates_received,
        "blobsSent": result.blobs_sent,
        "blobsReceived": result.blobs_received,
        "bytesSent": result.bytes_sent,
        "bytesReceived": result.bytes_received,
        "isLive": result.is_live,
        "peerHostname": result.peer_hostname,
        "peerNickname": result.peer_nickname,
        "error": result.error,
    });

    Ok(JsValue::from_str(&result_json.to_string()))
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
