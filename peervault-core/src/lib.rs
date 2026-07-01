//! PeerVault Core - Portable P2P Document Sync
//!
//! This crate contains the core protocol logic for PeerVault, designed to be:
//! - Compiled to WASM for embedding in JS/TS applications
//! - Linked natively for CLI tools or native apps
//! - Host-agnostic through trait-based abstractions
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────┐
//! │           Host Application              │
//! │     (implements HostInterface)          │
//! └─────────────────┬───────────────────────┘
//!                   │
//!         ┌─────────▼─────────┐
//!         │   PeerVaultCore   │
//!         │                   │
//!         │  ┌─────────────┐  │
//!         │  │ SyncEngine  │  │  ← CRDT sync protocol
//!         │  ├─────────────┤  │
//!         │  │ BlobStore   │  │  ← Content-addressed storage
//!         │  ├─────────────┤  │
//!         │  │ KeyManager  │  │  ← Vault key management
//!         │  ├─────────────┤  │
//!         │  │ PeerManager │  │  ← Peer discovery & state
//!         │  └─────────────┘  │
//!         └─────────┬─────────┘
//!                   │
//!         ┌─────────▼─────────┐
//!         │    Transport      │
//!         │ (implements Transport)
//!         └───────────────────┘
//! ```

pub mod host;
pub mod transport;
pub mod protocol;
pub mod wire;
pub mod sync;
pub mod session;
pub mod runner;
pub mod blob;
pub mod blobs_bridge;
pub mod gossip_bridge;
pub mod sync_handler;
pub mod keys;
pub mod peer;
pub mod error;
pub mod store;
pub mod net;
pub mod crypto;
pub mod key_exchange;
pub mod cloud;

#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(feature = "wasm")]
pub mod wasm_transport;

use std::sync::Arc;

/// Core configuration
#[derive(Debug, Clone)]
pub struct CoreConfig {
    /// Unique identifier for this vault (derived from content or user-chosen)
    pub vault_id: [u8; 32],

    /// Human-readable device name
    pub device_name: String,

    /// Optional nickname for this device
    pub nickname: Option<String>,

    /// Enable automatic peer discovery via mesh gossip
    pub enable_mesh_discovery: bool,

    /// Sync interval for periodic background sync (None = manual only)
    pub auto_sync_interval_secs: Option<u64>,

    /// Maximum concurrent peer connections
    pub max_peers: usize,
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            vault_id: [0; 32],
            device_name: "Unknown Device".into(),
            nickname: None,
            enable_mesh_discovery: true,
            auto_sync_interval_secs: Some(60),
            max_peers: 10,
        }
    }
}

/// Main entry point for the PeerVault core
pub struct PeerVaultCore<H: host::HostInterface, T: transport::Transport> {
    config: CoreConfig,
    host: Arc<H>,
    transport: Arc<T>,
    sync_engine: sync::SyncEngine,
    blob_store: blob::BlobStore,
    key_manager: keys::KeyManager,
    peer_manager: peer::PeerManager<T>,
}

impl<H: host::HostInterface, T: transport::Transport> PeerVaultCore<H, T> {
    /// Create a new core instance
    pub fn new(config: CoreConfig, host: Arc<H>, transport: Arc<T>) -> Result<Self, error::CoreError> {
        Ok(Self {
            config: config.clone(),
            host: host.clone(),
            transport: transport.clone(),
            sync_engine: sync::SyncEngine::new(host.clone())?,
            blob_store: blob::BlobStore::new(host.clone())?,
            key_manager: keys::KeyManager::new(host.clone())?,
            peer_manager: peer::PeerManager::new(config, transport)?,
        })
    }

    /// Start the core (begins accepting connections, runs background tasks)
    pub async fn start(&mut self) -> std::result::Result<(), error::CoreError> {
        self.peer_manager.start().await?;
        Ok(())
    }

    /// Stop the core gracefully
    pub async fn stop(&mut self) -> std::result::Result<(), error::CoreError> {
        self.peer_manager.stop().await?;
        Ok(())
    }

    /// Trigger a sync with all connected peers
    pub async fn sync_all(&mut self) -> std::result::Result<SyncResult, error::CoreError> {
        self.peer_manager.sync_all(&mut self.sync_engine, &self.blob_store).await
    }

    /// Sync with a specific peer
    pub async fn sync_peer(&mut self, peer_id: &str) -> std::result::Result<SyncResult, error::CoreError> {
        self.peer_manager.sync_peer(peer_id, &mut self.sync_engine, &self.blob_store).await
    }

    /// Add a peer by their connection ticket
    pub async fn add_peer(&mut self, ticket: &str) -> std::result::Result<PeerInfo, error::CoreError> {
        self.peer_manager.add_peer(ticket).await
    }

    /// Remove a peer
    pub async fn remove_peer(&mut self, peer_id: &str) -> std::result::Result<(), error::CoreError> {
        self.peer_manager.remove_peer(peer_id).await
    }

    /// Get our connection ticket for sharing
    pub fn get_ticket(&self) -> String {
        self.transport.get_ticket()
    }

    /// Get list of known peers
    pub fn get_peers(&self) -> Vec<PeerInfo> {
        self.peer_manager.get_peers()
    }

    /// Check if we have the vault encryption key
    pub fn has_vault_key(&self) -> bool {
        self.key_manager.has_key()
    }

    /// Set the vault encryption key (for cloud backup)
    pub fn set_vault_key(&mut self, key: &[u8]) -> std::result::Result<(), error::CoreError> {
        self.key_manager.set_key(key)
    }

    /// Request vault key from a peer that has it
    pub async fn request_vault_key(&mut self, peer_id: &str) -> std::result::Result<(), error::CoreError> {
        self.peer_manager.request_vault_key(peer_id, &mut self.key_manager).await
    }

    /// Apply a local change (called by host when user edits)
    pub fn apply_local_change(&mut self, change: LocalChange) -> std::result::Result<(), error::CoreError> {
        self.sync_engine.apply_local(change)?;
        // Notify peers of update (non-blocking)
        self.peer_manager.broadcast_update();
        Ok(())
    }

    /// Get current sync status
    pub fn get_status(&self) -> CoreStatus {
        CoreStatus {
            peer_count: self.peer_manager.connected_count(),
            syncing: self.peer_manager.is_syncing(),
            has_vault_key: self.key_manager.has_key(),
            pending_changes: self.sync_engine.pending_count(),
        }
    }
}

/// Result of a sync operation
#[derive(Debug, Clone)]
pub struct SyncResult {
    pub peers_synced: usize,
    pub changes_sent: usize,
    pub changes_received: usize,
    pub blobs_sent: usize,
    pub blobs_received: usize,
    pub errors: Vec<String>,
}

/// Information about a peer
#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    pub nickname: Option<String>,
    pub connected: bool,
    pub last_seen: u64,
    pub last_synced: Option<u64>,
}

/// A local change to apply
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalChange {
    pub path: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ChangeKind {
    Create { content: Vec<u8> },
    Modify { content: Vec<u8> },
    Delete,
    Rename { new_path: String },
}

/// Current status of the core
#[derive(Debug, Clone)]
pub struct CoreStatus {
    pub peer_count: usize,
    pub syncing: bool,
    pub has_vault_key: bool,
    pub pending_changes: usize,
}

// Re-export key types
pub use host::HostInterface;
pub use transport::{Transport, Connection, Stream};
pub use error::CoreError;
