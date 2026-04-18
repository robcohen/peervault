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
/// Configuration for sync session (local definition, replaces net::sync_runner::SyncConfig)
pub struct SyncConfig {
    pub vault_id: [u8; 32],
    pub hostname: String,
    pub nickname: Option<String>,
    pub has_vault_key: bool,
    pub plugin_version: Option<String>,
}
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
        let conn = self.connections.get_mut(peer_id).ok_or_else(|| {
            CoreError::Transport(crate::transport::TransportError::PeerNotFound(peer_id.into()))
        })?;

        // Open sync stream
        let stream = conn.connection.open_stream(protocols::SYNC).await?;

        // Create or reset session
        let session = conn.sync_session.get_or_insert_with(SyncSession::new);
        *session = SyncSession::new();

        // Create sync config
        let config = SyncConfig {
            vault_id: self.config.vault_id,
            hostname: self.config.device_name.clone(),
            nickname: None,
            has_vault_key: false, // TODO: check key manager
            plugin_version: Some("0.1.0".to_string()),
        };

        // Run initiator sync protocol using Loro-based sync
        // Note: This requires adapting the stream to IrohStream
        // For now, we use the sync_runner functions with our transport stream

        // The sync_runner module uses IrohStream, but we need to adapt it
        // to work with our generic Transport trait. This is a placeholder
        // that shows the intended flow:

        let mut result = SyncResult {
            peers_synced: 0,
            changes_sent: 0,
            changes_received: 0,
            blobs_sent: 0,
            blobs_received: 0,
            errors: Vec::new(),
        };

        // Exchange version vectors and sync using Loro
        use crate::protocol::sync::{self as proto, Message, PROTOCOL_VERSION};

        // Step 1: Send VERSION_INFO
        let version_info = Message::VersionInfo(proto::VersionInfo {
            protocol_version: PROTOCOL_VERSION,
            vault_id: config.vault_id,
            version_bytes: engine.version_vector(),
            hostname: config.hostname.clone(),
            nickname: config.nickname.clone(),
            has_vault_key: config.has_vault_key,
            plugin_version: config.plugin_version.clone(),
            pairing_nonce: None,
            supports_iroh_blobs: true,
        });

        let encoded = version_info.encode()
            .map_err(|e| CoreError::Crdt(format!("encode version_info: {}", e)))?;
        stream.send(&encoded).await?;
        session.start();

        // Step 2: Receive peer's VERSION_INFO
        let response = stream.recv().await?;
        let peer_msg = Message::decode(&response)
            .map_err(|e| CoreError::Crdt(format!("decode version_info: {}", e)))?;

        let peer_info = match peer_msg {
            Message::VersionInfo(v) => v,
            Message::Error(e) => return Err(CoreError::Crdt(format!("peer error: {}", e.message))),
            _ => return Err(CoreError::Crdt("expected VersionInfo".into())),
        };

        // Validate vault ID
        if peer_info.vault_id != config.vault_id {
            return Err(CoreError::Crdt("vault ID mismatch".into()));
        }

        session.set_peer_version(peer_info.version_bytes.clone());
        session.set_peer_has_vault_key(peer_info.has_vault_key);

        // Step 3: Check if already synced
        if engine.is_synced_with(&peer_info.version_bytes) {
            // Already in sync - send SyncComplete
            let complete = Message::SyncComplete(proto::SyncComplete {
                version_bytes: engine.version_vector(),
            });
            let encoded = complete.encode()
                .map_err(|e| CoreError::Crdt(format!("encode sync_complete: {}", e)))?;
            stream.send(&encoded).await?;
            session.complete();
        } else {
            // Export updates since peer's version and send
            let updates = engine.export_updates_since(&peer_info.version_bytes)?;
            result.changes_sent = updates.len(); // Approximate

            let updates_msg = Message::Updates(proto::Updates {
                data: updates,
                op_count: 0, // We don't track individual ops
            });
            let encoded = updates_msg.encode()
                .map_err(|e| CoreError::Crdt(format!("encode updates: {}", e)))?;
            stream.send(&encoded).await?;

            // Step 4: Receive updates and sync complete
            loop {
                let response = stream.recv().await?;
                let msg = Message::decode(&response)
                    .map_err(|e| CoreError::Crdt(format!("decode response: {}", e)))?;

                match msg {
                    Message::Updates(updates) => {
                        result.changes_received = updates.data.len(); // Approximate
                        engine.import_updates(&updates.data)?;
                    }
                    Message::Snapshot(snapshot) => {
                        engine.import_snapshot(&snapshot.data)?;
                    }
                    Message::SyncComplete(complete) => {
                        session.set_peer_version(complete.version_bytes);
                        session.complete();

                        // Send our completion
                        let our_complete = Message::SyncComplete(proto::SyncComplete {
                            version_bytes: engine.version_vector(),
                        });
                        let encoded = our_complete.encode()
                            .map_err(|e| CoreError::Crdt(format!("encode sync_complete: {}", e)))?;
                        stream.send(&encoded).await?;
                        break;
                    }
                    Message::Ping(ping) => {
                        let pong = Message::Pong(proto::Pong {
                            seq: ping.seq,
                            timestamp: ping.timestamp,
                        });
                        let encoded = pong.encode()
                            .map_err(|e| CoreError::Crdt(format!("encode pong: {}", e)))?;
                        stream.send(&encoded).await?;
                    }
                    Message::Error(e) => {
                        return Err(CoreError::Crdt(format!("peer error: {}", e.message)));
                    }
                    _ => {
                        // Ignore unexpected messages
                    }
                }
            }
        }

        result.peers_synced = 1;
        Ok(result)
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
