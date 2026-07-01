//! Host-agnostic PeerVault engine.
//!
//! `PeerVault` is the embeddable core: lifecycle (start/stop), pairing,
//! peer-to-peer sync orchestration (accept loop, initiator/acceptor protocol,
//! gossip live-sync), CRDT document ops, encryption-key management, and cloud
//! sync. It has no JavaScript/wasm dependencies — hosts embed it either
//! natively (tokio) or through the thin wasm-bindgen shim in `wasm.rs`.
//!
//! Host integration points:
//! - [`crate::events::EventCallback`] — typed event notifications
//! - [`crate::events::StateCallback`] — store-state persistence
//! - [`crate::rt`] — runtime shim (spawn/sleep) selected per target

use std::sync::Arc;
use tokio::sync::RwLock;

use crate::crypto::VaultKey;
use crate::error::CoreError;
use crate::events::{EventCallback, StateCallback};
use crate::net::{IrohTransport, IrohConnection, IrohStream, Ticket};
use iroh::SecretKey;
use crate::store::{LoroStore, DocStore};
use crate::cloud::{CloudConfig, CloudSync, SyncPhase};
use crate::sync::SyncEngine;
use crate::runner::{SyncStream, BlobOps};
use base64::Engine as _;
use std::collections::HashMap;

/// Main PeerVault instance for WASM
///
/// This is the primary interface for JavaScript code to interact with PeerVault.
#[derive(Clone)]
pub struct PeerVault {
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
    on_event: Option<EventCallback>,
    /// Storage change callback - called when store state changes
    /// Host should persist the state when this is called
    on_storage_change: Option<StateCallback>,
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
    /// Baseline of CRDT keys at the last disk reconcile — used to detect remote
    /// deletions (keys that vanished from the store). Owned by the core so every
    /// host gets identical deletion semantics; momentary std lock (never held
    /// across await).
    reconcile_baseline: Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
}
impl PeerVault {
    /// Create a new PeerVault instance
    ///
    /// @param vault_id - 32-byte vault identifier (hex string)
    /// @param device_name - Human-readable device name
    pub fn new(vault_id: &str, device_name: &str) -> Result<PeerVault, CoreError> {
        let vault_id_bytes = hex::decode(vault_id)
            .map_err(|e| CoreError::Protocol(format!("Invalid vault_id hex: {}", e)))?;

        if vault_id_bytes.len() != 32 {
            return Err(CoreError::Protocol("vault_id must be 32 bytes (64 hex chars)".to_string()));
        }

        let mut vault_id = [0u8; 32];
        vault_id.copy_from_slice(&vault_id_bytes);

        Ok(PeerVault {
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
            reconcile_baseline: Arc::new(std::sync::RwLock::new(std::collections::HashSet::new())),
        })
    }

    /// Set the event callback
    ///
    /// The callback receives events as JSON strings with format:
    /// { "type": "event_type", "data": {...} }
    pub fn set_event_callback(&mut self, callback: EventCallback) {
        self.on_event = Some(callback);
    }

    /// Set the storage change callback
    ///
    /// This callback is invoked whenever the store state changes.
    /// The host should call `export()` and persist the result.
    ///
    /// For Obsidian: Save to `.obsidian/plugins/peervault/state.bin`
    /// For browser: Save to IndexedDB
    pub fn set_storage_callback(&mut self, callback: StateCallback) {
        self.on_storage_change = Some(callback);
    }

    /// Set the relay URL to use for P2P connections
    ///
    /// Must be called before `start()` or `startWithState()`.
    /// If not set, the default relay (n0.computer) will be used.
    ///
    /// @param url - Relay URL (e.g., "https://use1-1.relay.n0.computer" or "http://localhost:3340")
    pub fn set_relay_url(&mut self, url: &str) {
        self.relay_url = Some(url.to_string());
    }

    /// Get the currently configured relay URL
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
    pub async fn generate_encryption_key(&self) -> Result<String, CoreError> {
        let key_store = self.encryption_key.clone();

        
            let key = VaultKey::generate();
            let key_bytes = key.as_bytes().to_vec();
            *key_store.write().await = Some(key);

            // Return the key as hex for storage
            Ok(hex::encode(&key_bytes))
        
    }

    /// Set encryption key from a hex string
    ///
    /// Use this to restore a previously generated key.
    pub async fn set_encryption_key(&self, key_hex: &str) -> Result<(), CoreError> {
        let key_store = self.encryption_key.clone();
        let key_hex = key_hex.to_string();

        
            let key_bytes = hex::decode(&key_hex)
                .map_err(|e| CoreError::Protocol(format!("Invalid key hex: {}", e)))?;

            let key = VaultKey::from_bytes(&key_bytes)
                .map_err(|e| CoreError::Protocol(format!("Invalid key: {}", e)))?;

            *key_store.write().await = Some(key);
            Ok(())
        
    }

    /// Derive encryption key from a passphrase
    ///
    /// Use this when the user provides a passphrase instead of storing a key.
    /// The same passphrase + vault_id always produces the same key.
    pub async fn derive_encryption_key(&self, passphrase: &str) -> Result<(), CoreError> {
        let key_store = self.encryption_key.clone();
        let vault_id = self.vault_id;
        let passphrase = passphrase.to_string();

        
            let key = VaultKey::from_passphrase(&passphrase, &vault_id)
                .map_err(|e| CoreError::Protocol(format!("Key derivation failed: {}", e)))?;

            *key_store.write().await = Some(key);
            Ok(())
        
    }

    /// Check if encryption key is set
    pub async fn has_encryption_key(&self) -> Result<bool, CoreError> {
        let key_store = self.encryption_key.clone();

        
            let has_key = key_store.read().await.is_some();
            Ok(has_key)
        
    }

    /// Get the current encryption key as hex (for backup/export)
    pub async fn get_encryption_key(&self) -> Result<Option<String>, CoreError> {
        Ok(self.encryption_key.read().await.as_ref().map(|key| hex::encode(key.as_bytes())))
    }

    /// Clear the encryption key from memory
    pub async fn clear_encryption_key(&self) -> Result<(), CoreError> {
        let key_store = self.encryption_key.clone();

        
            *key_store.write().await = None;
            Ok(())
        
    }

    // =========================================================================
    // Blob Encryption (for P2P transfer)
    // =========================================================================

    /// Encrypt blob data for P2P transfer
    ///
    /// Use this to encrypt blob data before sending to a peer.
    /// Requires that a vault key is set.
    pub async fn encrypt_blob(&self, data: &[u8]) -> Result<Vec<u8>, CoreError> {
        let encryption_key = self.encryption_key.clone();
        let data = data.to_vec();

        
            let key = encryption_key.read().await.clone()
                .ok_or_else(|| CoreError::Protocol("No encryption key set".to_string()))?;

            let encrypted = key.encrypt(&data)
                .map_err(|e| CoreError::Protocol(format!("Encryption failed: {}", e)))?;

                        Ok(encrypted)
        
    }

    /// Decrypt blob data received from peer
    ///
    /// Use this to decrypt blob data received from a peer.
    /// Requires that a vault key is set.
    pub async fn decrypt_blob(&self, encrypted_data: &[u8]) -> Result<Vec<u8>, CoreError> {
        let encryption_key = self.encryption_key.clone();
        let data = encrypted_data.to_vec();

        
            let key = encryption_key.read().await.clone()
                .ok_or_else(|| CoreError::Protocol("No encryption key set".to_string()))?;

            let decrypted = key.decrypt(&data)
                .map_err(|e| CoreError::Protocol(format!("Decryption failed: {}", e)))?;

                        Ok(decrypted)
        
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /// Start the PeerVault (initializes transport and store)
    ///
    /// This also starts a background accept loop that listens for incoming
    /// peer connections and emits events via the event callback.
    pub async fn start(&self) -> Result<(), CoreError> {
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

        
            // Create BlobsBridge
            let host = Arc::new(crate::host::mock::MockHost::new());
            let blob_bridge = crate::blobs_bridge::BlobsBridge::new(host)
                .map_err(|e| CoreError::Protocol(format!("Failed to create blobs bridge: {}", e)))?;
            let mem_store = blob_bridge.mem_store().clone();

            // Build endpoint, then create GossipBridge (needs endpoint for Gossip),
            // then create transport (registers Gossip on Router)
            use iroh::{RelayMap, RelayMode, RelayUrl};
            let secret_key = SecretKey::generate();
            let relay_mode = match relay_url.as_deref() {
                Some(url) => {
                    let relay: RelayUrl = url.parse()
                        .map_err(|e| CoreError::Protocol(format!("Invalid relay URL: {}", e)))?;
                    RelayMode::Custom(RelayMap::from_iter(vec![relay]))
                }
                None => {
                    let relay: RelayUrl = "https://use1-1.relay.n0.computer".parse()
                        .map_err(|e| CoreError::Protocol(format!("Default relay URL parse failed: {}", e)))?;
                    RelayMode::Custom(RelayMap::from_iter(vec![relay]))
                }
            };
            let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .secret_key(secret_key.clone())
                .relay_mode(relay_mode)
                .bind()
                .await
                .map_err(|e| CoreError::Protocol(format!("Endpoint bind failed: {}", e)))?;

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
            seed_reconcile_baseline(&self.reconcile_baseline, &loro_store);

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
            crate::rt::spawn(async move {
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

            Ok(())
        
    }

    /// Start with previously persisted state
    ///
    /// Use this instead of `start()` when you have saved state from a previous session.
    /// Pass the data from a previous `export()` call.
    pub async fn start_with_state(&self, initial_state: &[u8]) -> Result<(), CoreError> {
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

        
            // Create BlobsBridge
            let host = Arc::new(crate::host::mock::MockHost::new());
            let bridge = crate::blobs_bridge::BlobsBridge::new(host)
                .map_err(|e| CoreError::Protocol(format!("Failed to create blobs bridge: {}", e)))?;
            let mem_store = bridge.mem_store().clone();

            // Build endpoint, GossipBridge, then transport (same as start())
            use iroh::{RelayMap, RelayMode, RelayUrl};
            let secret_key = SecretKey::generate();
            let relay_mode = match relay_url.as_deref() {
                Some(url) => {
                    let relay: RelayUrl = url.parse()
                        .map_err(|e| CoreError::Protocol(format!("Invalid relay URL: {}", e)))?;
                    RelayMode::Custom(RelayMap::from_iter(vec![relay]))
                }
                None => {
                    let relay: RelayUrl = "https://use1-1.relay.n0.computer".parse()
                        .map_err(|e| CoreError::Protocol(format!("Default relay URL parse failed: {}", e)))?;
                    RelayMode::Custom(RelayMap::from_iter(vec![relay]))
                }
            };
            let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .secret_key(secret_key.clone())
                .relay_mode(relay_mode)
                .bind()
                .await
                .map_err(|e| CoreError::Protocol(format!("Endpoint bind failed: {}", e)))?;

            let gossip_br = crate::gossip_bridge::GossipBridge::new(&endpoint, vault_id);
            let iroh_transport = IrohTransport::from_endpoint(
                endpoint, secret_key, mem_store, gossip_br.gossip().clone(),
            );

            // Create the store and import saved state
            let loro_store = LoroStore::new(vault_id);
            loro_store.import_snapshot(&initial_data)
                .map_err(|e| CoreError::Protocol(format!("Failed to import state: {}", e)))?;
            seed_reconcile_baseline(&self.reconcile_baseline, &loro_store);

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
            crate::rt::spawn(async move {
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

            Ok(())
        
    }

    /// Stop the PeerVault
    pub async fn stop(&self) -> Result<(), CoreError> {
        let transport = self.transport.clone();

        // Signal shutdown FIRST, before contending for the transport write lock.
        // The accept loop holds a transport read guard across `accept().await`; the
        // signal makes it break and release the guard so `take()` below can proceed
        // (otherwise stop() would hang until a connection happened to arrive).
        let _ = self.shutdown.send(true);

        
            if let Some(t) = transport.write().await.take() {
                t.close().await;
            }
            Ok(())
        
    }

    /// Get our connection ticket for sharing with peers
    pub async fn get_ticket(&self) -> Result<String, CoreError> {
        let transport = self.transport.clone();

        
            let guard = transport.read().await;
            let t = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Transport not started".to_string()))?;

            let ticket = t.create_ticket()
                .await
                .map_err(|e| CoreError::Protocol(format!("Failed to create ticket: {}", e)))?;

            Ok(ticket.to_string())
        
    }

    /// Get our node ID (public key)
    pub async fn get_node_id(&self) -> Result<String, CoreError> {
        let transport = self.transport.clone();

        
            let guard = transport.read().await;
            let t = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Transport not started".to_string()))?;

            Ok(t.node_id().to_string())
        
    }

    // =========================================================================
    // Pairing Management
    // =========================================================================

    /// Register a one-time pairing nonce
    ///
    /// Called by JS when generating a pairing ticket. The nonce can only be
    /// used once and expires after the given timestamp.
    pub fn register_pairing_nonce(&self, nonce: &str, expires_at_ms: u64) {
        let mut pending = self.pending_pairings.write().unwrap();
        pending.insert(nonce.to_string(), expires_at_ms);
        tracing::info!("{}", format!(
            "[WASM] Registered pairing nonce: {}...",
            short(&nonce, 16)
        ));
    }

    /// Validate and consume a pairing nonce
    ///
    /// Returns true if the nonce was valid and has been consumed.
    /// Returns false if the nonce was invalid, expired, or already used.
    pub fn validate_pairing_nonce(&self, nonce: &str) -> bool {
        let mut pending = self.pending_pairings.write().unwrap();

        // Check if nonce exists
        if let Some(&expires_at) = pending.get(nonce) {
            // Check if expired
            let now = web_time::SystemTime::now().duration_since(web_time::SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            if now > expires_at {
                pending.remove(nonce);
                tracing::info!("{}", format!(
                    "[WASM] Pairing nonce expired: {}...",
                    short(&nonce, 16)
                ));
                return false;
            }

            // Valid - consume it
            pending.remove(nonce);
            tracing::info!("{}", format!(
                "[WASM] Pairing nonce validated and consumed: {}...",
                short(&nonce, 16)
            ));
            true
        } else {
            tracing::info!("{}", format!(
                "[WASM] Unknown pairing nonce: {}...",
                short(&nonce, 16)
            ));
            false
        }
    }

    /// Check if a peer is known (already paired)
    pub fn is_known_peer(&self, peer_id: &str) -> bool {
        self.known_peers.read().unwrap().contains_key(peer_id)
    }

    /// Add a peer to the known peers list
    pub fn add_known_peer(&self, peer_id: &str) {
        let now = web_time::SystemTime::now().duration_since(web_time::SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        self.known_peers.write().unwrap().insert(peer_id.to_string(), now);
        tracing::info!("{}", format!(
            "[WASM] Added known peer: {}...",
            short(&peer_id, 16)
        ));
    }

    /// Remove a peer from the known peers list
    pub fn remove_known_peer(&self, peer_id: &str) {
        self.known_peers.write().unwrap().remove(peer_id);
    }

    /// Get list of known peer IDs
    pub fn get_known_peers(&self) -> Vec<String> {
        self.known_peers.read().unwrap()
            .keys()
            .map(|k| k.clone())
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
    pub async fn connect_peer(&self, ticket_str: &str) -> Result<String, CoreError> {
        self.connect_peer_with_pairing(ticket_str, None, None).await
    }

    /// Connect to a peer with pairing nonce for one-time pairing
    ///
    /// This is the same as connectPeer but includes the pairing nonce
    /// for validating new peer connections.
    pub async fn connect_peer_with_pairing(
        &self,
        ticket_str: &str,
        pairing_nonce: Option<String>,
        _our_device_name: Option<String>,
    ) -> Result<String, CoreError> {
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

        
            info!("connectPeer: parsing ticket, nonce={}",
                pairing_nonce.as_deref().map(|n| short(n, 16)).unwrap_or("none"));
            let ticket = Ticket::from_string(&ticket_str)
                .map_err(|e| CoreError::Protocol(format!("Invalid ticket: {}", e)))?;

            let peer_id = ticket.node_id.to_string();
            info!("connectPeer: peer_id={}", short(&peer_id, 16));

            // Helper: create SyncEngine from store + key
            async fn create_sync_engine(
                store: &Arc<RwLock<Option<LoroStore>>>,
                enc_key: &Arc<RwLock<Option<VaultKey>>>,
            ) -> Result<SyncEngine, CoreError> {
                let store_guard = store.read().await;
                let loro_store = store_guard.as_ref()
                    .ok_or_else(|| CoreError::Protocol("Store not initialized".to_string()))?;
                let key_guard = enc_key.read().await;
                let vault_key = key_guard.clone()
                    .ok_or_else(|| CoreError::Protocol("No encryption key".to_string()))?;
                drop(key_guard);
                let real_vault_id = *loro_store.vault_id();
                let host = Arc::new(crate::host::mock::MockHost::new());
                let mut engine = SyncEngine::new_with_key(host, vault_key)
                    .map_err(|e| CoreError::Protocol(format!("SyncEngine: {}", e)))?;
                // Carry the real vault id into the temporary sync engine so the
                // VERSION_INFO we send advertises the actual vault (new_with_key
                // starts at all-zeros and import does not restore it). Must run
                // before import so the data lands in the correctly-identified store.
                engine.init_vault(real_vault_id);
                let snapshot = loro_store.export_snapshot()
                    .map_err(|e| CoreError::Protocol(format!("Export snapshot: {}", e)))?;
                drop(store_guard);
                engine.import_snapshot_raw(&snapshot)
                    .map_err(|e| CoreError::Protocol(format!("Import snapshot: {}", e)))?;
                Ok(engine)
            }

            // Helper: import results back
            async fn import_engine_results(
                engine: &SyncEngine,
                store: &Arc<RwLock<Option<LoroStore>>>,
            ) -> Result<(), CoreError> {
                let updated = engine.export_snapshot_raw()
                    .map_err(|e| CoreError::Protocol(format!("Export: {}", e)))?;
                let store_guard = store.read().await;
                let loro_store = store_guard.as_ref()
                    .ok_or_else(|| CoreError::Protocol("Store not initialized".to_string()))?;
                loro_store.import_snapshot(&updated)
                    .map_err(|e| CoreError::Protocol(format!("Import: {}", e)))?;
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
                            .map_err(|e| CoreError::Protocol(format!("Open stream: {}", e)))?;
                        drop(connections_guard);
                        s
                    } else {
                        drop(connections_guard);
                        // Fall through to new connection
                        info!("connectPeer: connecting...");
                        let connection = {
                            let guard = transport.read().await;
                            let t = guard.as_ref()
                                .ok_or_else(|| CoreError::Protocol("Transport not started".to_string()))?;
                            t.connect(&ticket).await
                                .map_err(|e| CoreError::Protocol(format!("Connect failed: {}", e)))?
                        };
                        connections.write().await.insert(peer_id.clone(), connection);
                        let cg = connections.read().await;
                        let conn = cg.get(&peer_id).ok_or_else(|| CoreError::Protocol("Connection lost".to_string()))?;
                        let s = conn.open_stream().await
                            .map_err(|e| CoreError::Protocol(format!("Open stream: {}", e)))?;
                        drop(cg);
                        s
                    }
                } else {
                    drop(connections_guard);
                    info!("connectPeer: connecting...");
                    let connection = {
                        let guard = transport.read().await;
                        let t = guard.as_ref()
                            .ok_or_else(|| CoreError::Protocol("Transport not started".to_string()))?;
                        t.connect(&ticket).await
                            .map_err(|e| CoreError::Protocol(format!("Connect failed: {}", e)))?
                    };
                    info!("connectPeer: connected!");
                    connections.write().await.insert(peer_id.clone(), connection);
                    let cg = connections.read().await;
                    let conn = cg.get(&peer_id).ok_or_else(|| CoreError::Protocol("Connection lost".to_string()))?;
                    let s = conn.open_stream().await
                        .map_err(|e| CoreError::Protocol(format!("Open stream: {}", e)))?;
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
                    .map_err(|e| CoreError::Protocol(format!("Invalid peer ID: {}", e)))?;
                match gb.subscribe_with_receiver(vec![peer_endpoint_id]).await {
                    Ok(Some(receiver)) => {
                        // First subscription — spawn receiver + debounce tasks
                        let store_for_gossip = store.clone();
                        let enc_key_for_gossip = encryption_key.clone();
                        let on_event_for_gossip = on_event.clone();
                        let shutdown_for_gossip = shutdown.clone();
                        crate::rt::spawn(async move {
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
                        crate::rt::spawn(async move {
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

            Ok(peer_id)
        
    }

    /// Set a document in the store
    ///
    /// If an encryption key is set, content will be encrypted before storage.
    pub async fn set(&self, key: &str, content: &[u8]) -> Result<(), CoreError> {
        let store = self.store.clone();
        let encryption_key = self.encryption_key.clone();
        let gossip_bridge = self.gossip_bridge.clone();
        let key = key.to_string();
        let content = content.to_vec();

        
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Store not started".to_string()))?;

            // Capture version vector before write (for delta export)
            let vv_before = s.version_vector();

            // Encrypt content if key is available
            let content_to_store = match encryption_key.read().await.as_ref() {
                Some(enc_key) => {
                    enc_key.encrypt(&content)
                        .map_err(|e| CoreError::Protocol(format!("Encryption failed: {}", e)))?
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
                .map_err(|e| CoreError::Protocol(format!("Failed to set: {}", e)))?;

            // Notify gossip of change (debounced — will batch and broadcast)
            let gossip_guard = gossip_bridge.read().await;
            if let Some(ref gb) = *gossip_guard {
                if gb.is_subscribed().await {
                    gb.notify_change(vv_before).await;
                }
            }

            Ok(())
        
    }

    /// Get a document from the store
    ///
    /// If an encryption key is set, content will be decrypted after retrieval.
    pub async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CoreError> {
        let store = self.store.clone();
        let encryption_key = self.encryption_key.clone();
        let key = key.to_string();

        
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Store not started".to_string()))?;

            let content_opt = s.get_text(&key)
                .map_err(|e| CoreError::Protocol(format!("Failed to get: {}", e)))?;

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
                                    .map_err(|e| CoreError::Protocol(format!("Decryption failed: {}", e)))?
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

                                        Ok(Some(plaintext))
                }
                None => Ok(None),
            }
        
    }

    /// Delete a document from the store
    pub async fn delete(&self, key: &str) -> Result<(), CoreError> {
        let store = self.store.clone();
        let _encryption_key = self.encryption_key.clone();
        let gossip_bridge = self.gossip_bridge.clone();
        let key = key.to_string();

        
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Store not started".to_string()))?;

            // Capture VV before delete (for delta export)
            let vv_before = s.version_vector();

            s.delete_file(&key)
                .map_err(|e| CoreError::Protocol(format!("Failed to delete: {}", e)))?;

            // Notify gossip of change (debounced)
            let gossip_guard = gossip_bridge.read().await;
            if let Some(ref gb) = *gossip_guard {
                if gb.is_subscribed().await {
                    gb.notify_change(vv_before).await;
                }
            }

            Ok(())
        
    }

    /// List all documents (optionally filtered by prefix)
    pub async fn list(&self, prefix: Option<String>) -> Result<String, CoreError> {
        let store = self.store.clone();

        
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Store not started".to_string()))?;

            let files = s.list_files(prefix.as_deref())
                .map_err(|e| CoreError::Protocol(format!("Failed to list: {}", e)))?;

            // Convert to JSON array of paths
            let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
            let json = serde_json::to_string(&paths)
                .map_err(|e| CoreError::Protocol(format!("Failed to serialize: {}", e)))?;

            Ok(json)
        
    }

    /// Get the version vector of the store (for comparing sync state)
    ///
    /// Returns a hex-encoded version vector that can be compared between peers.
    pub async fn get_version_vector(&self) -> Result<String, CoreError> {
        let store = self.store.clone();

        
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Store not started".to_string()))?;

            let vv = s.version_vector();
            Ok(hex::encode(&vv))
        
    }

    /// Export the store state as a serialized blob
    pub async fn export(&self) -> Result<Vec<u8>, CoreError> {
        let store = self.store.clone();

        
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Store not started".to_string()))?;

            let data = s.export_snapshot()
                .map_err(|e| CoreError::Protocol(format!("Failed to export: {}", e)))?;

                        Ok(data)
        
    }

    /// Import store state from a serialized blob
    pub async fn import(&self, data: &[u8]) -> Result<(), CoreError> {
        let store = self.store.clone();
        let data = data.to_vec();

        
            let guard = store.read().await;
            let s = guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Store not started".to_string()))?;

            s.import_snapshot(&data)
                .map_err(|e| CoreError::Protocol(format!("Failed to import: {}", e)))?;

            Ok(())
        
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
    pub async fn configure_cloud_storage(&self, config_json: &str) -> Result<(), CoreError> {
        let cloud_sync_store = self.cloud_sync.clone();
        let encryption_key = self.encryption_key.clone();
        let config_json = config_json.to_string();

        
            // Parse config
            let config: CloudConfigJs = serde_json::from_str(&config_json)
                .map_err(|e| CoreError::Protocol(format!("Invalid config JSON: {}", e)))?;

            // Require encryption key
            let key_guard = encryption_key.read().await;
            let vault_key = key_guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Encryption key must be set before configuring cloud storage".to_string()))?;

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
                .map_err(|e| CoreError::Protocol(format!("Failed to create cloud sync: {}", e)))?;

            *cloud_sync_store.write().await = Some(cloud);

            Ok(())
        
    }

    /// Sync with cloud storage
    ///
    /// Uploads local changes and downloads remote changes.
    /// Returns a JSON object with sync statistics.
    pub async fn sync_cloud(&self) -> Result<String, CoreError> {
        let cloud_sync = self.cloud_sync.clone();
        let store = self.store.clone();

        
            let mut cloud_guard = cloud_sync.write().await;
            let cloud = cloud_guard.as_mut()
                .ok_or_else(|| CoreError::Protocol("Cloud storage not configured".to_string()))?;

            let store_guard = store.read().await;
            let loro_store = store_guard.as_ref()
                .ok_or_else(|| CoreError::Protocol("Store not started".to_string()))?;

            // CloudSync works directly with LoroStore via CloudSyncable trait
            let result = cloud.sync(loro_store).await
                .map_err(|e| CoreError::Protocol(format!("Cloud sync failed: {}", e)))?;

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

            Ok(result_json.to_string())
        
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
    pub async fn get_cloud_status(&self) -> Result<String, CoreError> {
        let cloud_sync = self.cloud_sync.clone();

        
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

                    Ok(status_json.to_string())
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

                    Ok(status_json.to_string())
                }
            }
        
    }

    /// Upload a blob to cloud storage
    ///
    /// Returns the content hash (for reference in CRDT documents)
    pub async fn upload_cloud_blob(&self, data: &[u8], mime_type: Option<String>) -> Result<String, CoreError> {
        let cloud_sync = self.cloud_sync.clone();
        let data = data.to_vec();

        
            let mut guard = cloud_sync.write().await;
            let cloud = guard.as_mut()
                .ok_or_else(|| CoreError::Protocol("Cloud storage not configured".to_string()))?;

            let hash = cloud.upload_blob(&data, mime_type.as_deref()).await
                .map_err(|e| CoreError::Protocol(format!("Failed to upload blob: {}", e)))?;

            Ok(hash)
        
    }

    /// Download a blob from cloud storage
    ///
    /// @param hash - The content hash returned from uploadCloudBlob
    pub async fn download_cloud_blob(&self, hash: &str) -> Result<Vec<u8>, CoreError> {
        let cloud_sync = self.cloud_sync.clone();
        let hash = hash.to_string();

        
            let mut guard = cloud_sync.write().await;
            let cloud = guard.as_mut()
                .ok_or_else(|| CoreError::Protocol("Cloud storage not configured".to_string()))?;

            let data = cloud.download_blob(&hash).await
                .map_err(|e| CoreError::Protocol(format!("Failed to download blob: {}", e)))?;

                        Ok(data)
        
    }

    /// Clear cloud storage configuration
    pub async fn clear_cloud_storage(&self) -> Result<(), CoreError> {
        let cloud_sync = self.cloud_sync.clone();

        
            *cloud_sync.write().await = None;
            Ok(())
        
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
/// Emit a typed `WasmEvent` to the host callback as a JSON string. Centralizes
/// serialization so every event shares one schema (see `crate::events`).
fn emit_event(on_event: &Option<EventCallback>, event: &crate::events::WasmEvent) {
    if let Some(cb) = on_event {
        cb(event);
    }
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
    on_event: &Option<EventCallback>,
) -> Result<(), CoreError> {
    use crate::runner::{SyncRunner, RunnerConfig};
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
    runner.run_crdt_only(&mut adapter).await?;

    // Phase 3: out-of-band iroh-blobs transfer.
    if runner.peer_supports_iroh_blobs() {
        if let (Some(bridge), Some(ep)) = (blobs_bridge, endpoint) {
            let our_hashes = bridge.list_host_hashes().await
                .map_err(|e| CoreError::Protocol(format!("List blobs failed: {}", e)))?;
            let static_blobs = StaticBlobOps { hashes: our_hashes };
            let (need, send) = runner.exchange_blob_hashes(&mut adapter, &static_blobs).await?;
            if !need.is_empty() || !send.is_empty() {
                let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
                    .map_err(|e| CoreError::Protocol(format!("Invalid peer ID: {}", e)))?;
                bridge.exchange_blobs_v3(ep, peer_endpoint_id, &need, &send).await
                    .map_err(|e| CoreError::Protocol(format!("Blob transfer failed: {}", e)))?;
            }
            runner.send_blob_sync_complete(&mut adapter, send.len()).await?;
        }
    }

    emit_event(&on_event, &crate::events::WasmEvent::SyncComplete {
        peer_id: peer_id.to_string(),
        direction: "outgoing".into(),
        updates_received: runner.result().updates_received,
        updates_sent: runner.result().updates_sent,
    });
    Ok(())
}


/// Handle incoming streams using V3 binary protocol (acceptor side).
async fn handle_incoming_streams_v3(
    peer_id: String,
    connections: Arc<RwLock<HashMap<String, IrohConnection>>>,
    store: Arc<RwLock<Option<LoroStore>>>,
    on_event: Option<EventCallback>,
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
    on_event: &Option<EventCallback>,
    pending_pairings: &Arc<std::sync::RwLock<HashMap<String, u64>>>,
    known_peers: &Arc<std::sync::RwLock<HashMap<String, u64>>>,
    encryption_key: &Arc<RwLock<Option<VaultKey>>>,
    blobs_bridge_arc: &Arc<RwLock<Option<BlobsBridge>>>,
    gossip_bridge_arc: &Arc<RwLock<Option<crate::gossip_bridge::GossipBridge>>>,
    transport: &Arc<RwLock<Option<IrohTransport>>>,
    shutdown: &tokio::sync::watch::Receiver<bool>,
) -> Result<(), CoreError> {
    // Accept a stream from the connection
    let mut stream = {
        let connections_guard = connections.read().await;
        let conn = connections_guard.get(peer_id)
            .ok_or_else(|| CoreError::Protocol("Connection lost".to_string()))?;
        conn.accept_stream().await
            .map_err(|e| CoreError::Protocol(format!("Accept stream failed: {}", e)))?
    };

    // Snapshot local vault id + encryption key + store state (independent of the peer).
    let local_vault_id = {
        let store_guard = store.read().await;
        *store_guard.as_ref()
            .ok_or_else(|| CoreError::Protocol("Store not initialized".to_string()))?
            .vault_id()
    };
    let vault_key = encryption_key.read().await.clone()
        .ok_or_else(|| CoreError::Protocol("No encryption key".to_string()))?;
    let snapshot = {
        let store_guard = store.read().await;
        store_guard.as_ref()
            .ok_or_else(|| CoreError::Protocol("Store not initialized".to_string()))?
            .export_snapshot()
            .map_err(|e| CoreError::Protocol(format!("Export snapshot failed: {}", e)))?
    };

    // Build the temporary sync engine. init_vault carries the real vault id (new_with_key
    // starts at zero and import does not restore it) so the VERSION_INFO we send and the
    // vault-id validation are correct.
    let host = Arc::new(crate::host::mock::MockHost::new());
    let mut engine = SyncEngine::new_with_key(host, vault_key)?;
    engine.init_vault(local_vault_id);
    engine.import_snapshot_raw(&snapshot)?;

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
        runner.run_crdt_only(&mut adapter).await?;

        // Out-of-band iroh-blobs transfer.
        if runner.peer_supports_iroh_blobs() {
            let bridge_guard = blobs_bridge_arc.read().await;
            let transport_guard = transport.read().await;
            if let (Some(bridge), Some(tp)) = (bridge_guard.as_ref(), transport_guard.as_ref()) {
                let our_hashes = bridge.list_host_hashes().await
                    .map_err(|e| CoreError::Protocol(format!("List blobs failed: {}", e)))?;
                let static_blobs = StaticBlobOps { hashes: our_hashes };
                let (need, send) = runner.exchange_blob_hashes(&mut adapter, &static_blobs).await?;
                if !need.is_empty() || !send.is_empty() {
                    let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
                        .map_err(|e| CoreError::Protocol(format!("Invalid peer ID: {}", e)))?;
                    bridge.exchange_blobs_v3(tp.endpoint(), peer_endpoint_id, &need, &send).await
                        .map_err(|e| CoreError::Protocol(format!("Blob transfer: {}", e)))?;
                }
                runner.send_blob_sync_complete(&mut adapter, send.len()).await?;
            }
        }
    }

    // Consume the pairing nonce + auto-add the peer once sync succeeded.
    if runner.result().pairing_is_new {
        if let Some(nonce) = &runner.result().pairing_nonce {
            pending_pairings.write().unwrap().remove(nonce);
        }
        known_peers.write().unwrap().insert(peer_id.to_string(), now_ms);
        emit_event(&on_event, &crate::events::WasmEvent::PairingComplete {
            peer_id: peer_id.to_string(),
            device_name: runner.result().peer_hostname.clone(),
        });
    }

    let updates_received = runner.result().updates_received;
    let updates_sent = runner.result().updates_sent;

    // Import the synced state back into the shared LoroStore.
    {
        let updated_snapshot = engine.export_snapshot_raw()?;
        let store_guard = store.read().await;
        let loro_store = store_guard.as_ref()
            .ok_or_else(|| CoreError::Protocol("Store not initialized".to_string()))?;
        loro_store.import_snapshot(&updated_snapshot)
            .map_err(|e| CoreError::Protocol(format!("Import snapshot: {}", e)))?;
    }

    emit_event(&on_event, &crate::events::WasmEvent::SyncComplete {
        peer_id: peer_id.to_string(),
        direction: "incoming".into(),
        updates_received,
        updates_sent,
    });

    // Subscribe to gossip for real-time updates (acceptor side)
    let gossip_guard = gossip_bridge_arc.read().await;
    if let Some(ref gb) = *gossip_guard {
        let peer_endpoint_id: iroh::EndpointId = peer_id.parse()
            .map_err(|e| CoreError::Protocol(format!("Invalid peer ID: {}", e)))?;
        match gb.subscribe_with_receiver(vec![peer_endpoint_id]).await {
            Ok(Some(receiver)) => {
                let store_for_gossip = store.clone();
                let enc_key_for_gossip = encryption_key.clone();
                let on_event_for_gossip = on_event.clone();
                let shutdown_for_gossip = shutdown.clone();
                crate::rt::spawn(async move {
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
                crate::rt::spawn(async move {
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
    on_event: Option<EventCallback>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    use futures::StreamExt;
    use iroh_gossip::api::Event;

    info!("Gossip receiver started");

    loop {
        // Stop cleanly on shutdown (select yields None → while exits).
        while let Some(event) = tokio::select! {
            biased;
            _ = shutdown.changed() => None,
            ev = receiver.next() => ev,
        } {
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
                        emit_event(&on_event, &crate::events::WasmEvent::DocumentChanged {
                            source: "gossip".into(),
                            bytes: plaintext.len(),
                        });
                    }
                }
                Ok(Event::NeighborUp(peer)) => {
                    info!("Gossip: neighbor joined: {}", peer);
                    emit_event(&on_event, &crate::events::WasmEvent::GossipNeighborUp {
                        peer_id: peer.to_string(),
                    });
                }
                Ok(Event::NeighborDown(peer)) => {
                    info!("Gossip: neighbor left: {}", peer);
                    emit_event(&on_event, &crate::events::WasmEvent::GossipNeighborDown {
                        peer_id: peer.to_string(),
                    });
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
    on_event: Option<EventCallback>,
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
        crate::rt::sleep(200).await;

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
                emit_event(&on_event, &crate::events::WasmEvent::SyncNeeded {
                    reason: "delta_too_large".into(),
                    size,
                    max,
                });
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
    on_event: Option<EventCallback>,
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
                emit_event(&on_event, &crate::events::WasmEvent::PeerConnected {
                    peer_id: peer_id.clone(),
                    direction: "incoming".into(),
                });

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

                crate::rt::spawn(async move {
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
                crate::rt::sleep(200).await;
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



/// Reconciliation plan — computed by the core, applied by the host's IO layer.
///
/// `upserts` are the store's current keys (the host writes any whose disk
/// content differs); `deletes` are keys that were present at the previous
/// reconcile but have since vanished from the store (deleted on a peer) and are
/// not shielded by a pending local edit.
#[derive(Debug, Clone, serde::Serialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "../../src/core/generated/reconcile.ts"))]
pub struct ReconcilePlan {
    pub upserts: Vec<String>,
    pub deletes: Vec<String>,
}

/// Internal CRDT keys that never correspond to vault files on disk.
const INTERNAL_KEY_PREFIX: &str = "_crdt/";

fn store_keys(store: &LoroStore) -> std::collections::HashSet<String> {
    store
        .list_files(None)
        .map(|files| {
            files
                .into_iter()
                .map(|f| f.path)
                .filter(|p| !p.starts_with(INTERNAL_KEY_PREFIX))
                .collect()
        })
        .unwrap_or_default()
}

/// Seed the remote-deletion baseline from the store's current keys. Without
/// this, the baseline would start empty after every restart and the first
/// reconcile of a session would miss deletions that happened on a peer while
/// we were offline (a later local re-scan would then resurrect the file).
/// Seeding from the CRDT (not disk) is safe: a file deleted remotely while we
/// were offline is still in our persisted CRDT now, so it enters the baseline
/// and is removed once the delete delta arrives.
fn seed_reconcile_baseline(
    baseline: &Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
    store: &LoroStore,
) {
    *baseline.write().unwrap() = store_keys(store);
}

impl PeerVault {
    /// Compute the disk-reconciliation plan for the store's current state.
    ///
    /// `dirty_paths` are paths with local edits not yet ingested into the CRDT
    /// (e.g. pending debounce timers): their absence from the store is expected,
    /// so they are never scheduled for deletion — deleting them would silently
    /// destroy a file the user just created. Advances the baseline to the
    /// current keys.
    pub async fn reconcile_plan(&self, dirty_paths: Vec<String>) -> Result<ReconcilePlan, CoreError> {
        let store_guard = self.store.read().await;
        let store = store_guard
            .as_ref()
            .ok_or_else(|| CoreError::Protocol("Store not initialized".to_string()))?;
        let current = store_keys(store);
        drop(store_guard);

        let dirty: std::collections::HashSet<String> = dirty_paths.into_iter().collect();
        let mut baseline = self.reconcile_baseline.write().unwrap();
        let deletes: Vec<String> = baseline
            .iter()
            .filter(|p| !current.contains(*p) && !dirty.contains(*p))
            .cloned()
            .collect();
        *baseline = current.clone();
        drop(baseline);

        let mut upserts: Vec<String> = current.into_iter().collect();
        upserts.sort();
        let mut deletes = deletes;
        deletes.sort();
        Ok(ReconcilePlan { upserts, deletes })
    }
}

#[cfg(test)]
mod reconcile_tests {
    use super::*;

    async fn vault_with_store() -> PeerVault {
        let pv = PeerVault::new(
            "aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11",
            "test",
        )
        .unwrap();
        let store = LoroStore::new(*pv_store_vault_id());
        *pv.store.write().await = Some(store);
        pv
    }

    fn pv_store_vault_id() -> &'static [u8; 32] {
        &[0xaa; 32]
    }

    fn set(pv: &PeerVault, path: &str) {
        futures::executor::block_on(async {
            let guard = pv.store.read().await;
            guard.as_ref().unwrap().set_text(path, "content").unwrap();
        });
    }

    fn delete(pv: &PeerVault, path: &str) {
        futures::executor::block_on(async {
            let guard = pv.store.read().await;
            guard.as_ref().unwrap().delete_file(path).unwrap();
        });
    }

    #[tokio::test]
    async fn detects_remote_deletion() {
        let pv = vault_with_store().await;
        set(&pv, "a.md");
        set(&pv, "b.md");
        pv.reconcile_plan(vec![]).await.unwrap(); // baseline = {a, b}

        delete(&pv, "b.md"); // as if a peer's delete delta arrived
        let plan = pv.reconcile_plan(vec![]).await.unwrap();
        assert_eq!(plan.deletes, vec!["b.md".to_string()]);
        assert!(plan.upserts.contains(&"a.md".to_string()));
    }

    #[tokio::test]
    async fn pending_local_edit_is_never_deleted() {
        let pv = vault_with_store().await;
        set(&pv, "new.md");
        pv.reconcile_plan(vec![]).await.unwrap(); // baseline = {new.md}

        delete(&pv, "new.md"); // vanished from the store...
        // ...but the user just re-created it locally (pending ingest).
        let plan = pv
            .reconcile_plan(vec!["new.md".to_string()])
            .await
            .unwrap();
        assert!(plan.deletes.is_empty(), "dirty path must be shielded: {:?}", plan.deletes);
    }

    #[tokio::test]
    async fn baseline_advances_so_deletes_fire_once() {
        let pv = vault_with_store().await;
        set(&pv, "x.md");
        pv.reconcile_plan(vec![]).await.unwrap();
        delete(&pv, "x.md");
        let first = pv.reconcile_plan(vec![]).await.unwrap();
        assert_eq!(first.deletes, vec!["x.md".to_string()]);
        let second = pv.reconcile_plan(vec![]).await.unwrap();
        assert!(second.deletes.is_empty(), "delete must not repeat: {:?}", second.deletes);
    }

    #[tokio::test]
    async fn internal_keys_are_invisible() {
        let pv = vault_with_store().await;
        set(&pv, "_crdt/meta");
        set(&pv, "real.md");
        let plan = pv.reconcile_plan(vec![]).await.unwrap();
        assert_eq!(plan.upserts, vec!["real.md".to_string()]);
    }
}
