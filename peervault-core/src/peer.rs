//! Peer Manager - Connection and session management
//!
//! Handles:
//! - Peer discovery and storage
//! - Connection lifecycle
//! - Sync session management
//! - Protocol stream multiplexing

use std::collections::HashMap;
use std::sync::Arc;
use crate::transport::{Transport, Connection, Stream, protocols};
use crate::sync::{SyncEngine, SyncSession};
use crate::blob::BlobStore;
use crate::keys::KeyManager;
use crate::error::CoreError;
use crate::{CoreConfig, PeerInfo, SyncResult};

/// Manages connections and sync sessions with peers
pub struct PeerManager<T: Transport> {
    config: CoreConfig,
    transport: Arc<T>,
    /// Known peers (persisted)
    peers: HashMap<String, StoredPeer>,
    /// Active connections
    connections: HashMap<String, ActiveConnection<T::Connection>>,
    /// Running flag
    running: bool,
}

/// Persisted peer information
#[derive(Debug, Clone)]
struct StoredPeer {
    info: PeerInfo,
    ticket: String,
}

/// Active connection with a peer
struct ActiveConnection<C: Connection> {
    connection: C,
    sync_session: Option<SyncSession>,
    last_activity: u64,
}

impl<T: Transport> PeerManager<T> {
    pub fn new(config: CoreConfig, transport: Arc<T>) -> Result<Self, CoreError> {
        Ok(Self {
            config,
            transport,
            peers: HashMap::new(),
            connections: HashMap::new(),
            running: false,
        })
    }

    /// Start accepting connections
    pub async fn start(&mut self) -> Result<(), CoreError> {
        self.running = true;
        // In real impl: spawn accept loop task
        Ok(())
    }

    /// Stop gracefully
    pub async fn stop(&mut self) -> Result<(), CoreError> {
        self.running = false;
        // Close all connections
        for (_, conn) in self.connections.drain() {
            let _ = conn.connection.close().await;
        }
        Ok(())
    }

    /// Add a peer by ticket
    pub async fn add_peer(&mut self, ticket: &str) -> Result<PeerInfo, CoreError> {
        let addr = self.transport.parse_ticket(ticket)?;

        // Connect to peer
        let connection = self.transport.connect(&addr).await?;
        let peer_id = connection.peer_id();

        // Open sync stream and do handshake
        let _sync_stream = connection.open_stream(protocols::SYNC).await?;

        // Create peer info
        let info = PeerInfo {
            id: peer_id.clone(),
            name: "Unknown".into(), // Would get from handshake
            nickname: None,
            connected: true,
            last_seen: 0, // Would use current time
            last_synced: None,
        };

        // Store peer
        self.peers.insert(peer_id.clone(), StoredPeer {
            info: info.clone(),
            ticket: ticket.to_string(),
        });

        // Store connection
        self.connections.insert(peer_id, ActiveConnection {
            connection,
            sync_session: Some(SyncSession::new()),
            last_activity: 0,
        });

        Ok(info)
    }

    /// Remove a peer
    pub async fn remove_peer(&mut self, peer_id: &str) -> Result<(), CoreError> {
        // Close connection if active
        if let Some(conn) = self.connections.remove(peer_id) {
            let _ = conn.connection.close().await;
        }

        // Remove from stored peers
        self.peers.remove(peer_id);

        Ok(())
    }

    /// Get list of known peers
    pub fn get_peers(&self) -> Vec<PeerInfo> {
        self.peers.values().map(|p| {
            let mut info = p.info.clone();
            info.connected = self.connections.contains_key(&info.id);
            info
        }).collect()
    }

    /// Get number of connected peers
    pub fn connected_count(&self) -> usize {
        self.connections.len()
    }

    /// Check if any sync is in progress
    pub fn is_syncing(&self) -> bool {
        self.connections.values().any(|c| {
            c.sync_session.as_ref().map(|s| !s.is_live()).unwrap_or(false)
        })
    }

    /// Sync with all connected peers
    pub async fn sync_all(
        &mut self,
        engine: &SyncEngine,
        _blob_store: &BlobStore,
    ) -> Result<SyncResult, CoreError> {
        let mut result = SyncResult {
            peers_synced: 0,
            changes_sent: 0,
            changes_received: 0,
            blobs_sent: 0,
            blobs_received: 0,
            errors: Vec::new(),
        };

        let peer_ids: Vec<String> = self.connections.keys().cloned().collect();

        for peer_id in peer_ids {
            match self.sync_peer_internal(&peer_id, engine).await {
                Ok(peer_result) => {
                    result.peers_synced += 1;
                    result.changes_sent += peer_result.changes_sent;
                    result.changes_received += peer_result.changes_received;
                    result.blobs_sent += peer_result.blobs_sent;
                    result.blobs_received += peer_result.blobs_received;
                }
                Err(e) => {
                    result.errors.push(format!("{}: {}", peer_id, e));
                }
            }
        }

        Ok(result)
    }

    /// Sync with a specific peer
    pub async fn sync_peer(
        &mut self,
        peer_id: &str,
        engine: &SyncEngine,
        _blob_store: &BlobStore,
    ) -> Result<SyncResult, CoreError> {
        self.sync_peer_internal(peer_id, engine).await
    }

    async fn sync_peer_internal(
        &mut self,
        peer_id: &str,
        engine: &SyncEngine,
    ) -> Result<SyncResult, CoreError> {
        // TODO: This native PeerManager path is not used in WASM.
        // The WASM path uses run_initiator_sync_v3 in wasm.rs directly.
        // When a native CLI is needed, this should be updated to use
        // the same V3 binary protocol via IrohStream.
        Err(CoreError::Internal(
            "PeerManager::sync_peer_internal not implemented for native path. \
             Use WasmPeerVault.connectPeer() for WASM.".into()
        ))
    }

    /// Request vault key from a peer
    pub async fn request_vault_key(
        &mut self,
        peer_id: &str,
        key_manager: &mut KeyManager,
    ) -> Result<(), CoreError> {
        let conn = self.connections.get(peer_id).ok_or_else(|| {
            CoreError::Transport(crate::transport::TransportError::PeerNotFound(peer_id.into()))
        })?;

        // Open key exchange stream
        let _key_stream = conn.connection.open_stream(protocols::KEYS).await?;

        // Get our public key
        let _our_public = key_manager.exchange_public_key();

        // In real impl:
        // 1. Send KeyRequest with our public key
        // 2. Receive KeyResponse with encrypted vault key
        // 3. Decrypt and store vault key
        // 4. Send KeyAck

        Ok(())
    }

    /// Broadcast update notification to all connected peers
    pub fn broadcast_update(&self) {
        // In real impl: send Update message on all sync streams
    }
}
