//! Host Interface - What the core needs from the host application
//!
//! This trait defines the minimal interface that any host application must implement
//! to use PeerVault. The goal is to keep this as small as possible while covering
//! all necessary functionality.
//!
//! # Implementation Notes
//!
//! - All operations should be non-blocking where possible
//! - File paths are relative to the vault root
//! - Storage keys are namespaced to avoid conflicts with host data

use std::future::Future;
use std::pin::Pin;

/// Result type for async host operations
pub type HostResult<T> = Pin<Box<dyn Future<Output = Result<T, HostError>> + Send>>;

/// Errors that can occur in host operations
#[derive(Debug, Clone)]
pub enum HostError {
    /// File or directory not found
    NotFound(String),
    /// Permission denied
    PermissionDenied(String),
    /// I/O error
    IoError(String),
    /// Storage error
    StorageError(String),
    /// Invalid path
    InvalidPath(String),
    /// Operation not supported by this host
    NotSupported(String),
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(s) => write!(f, "not found: {}", s),
            Self::PermissionDenied(s) => write!(f, "permission denied: {}", s),
            Self::IoError(s) => write!(f, "I/O error: {}", s),
            Self::StorageError(s) => write!(f, "storage error: {}", s),
            Self::InvalidPath(s) => write!(f, "invalid path: {}", s),
            Self::NotSupported(s) => write!(f, "not supported: {}", s),
        }
    }
}

impl std::error::Error for HostError {}

/// File metadata returned by list operations
#[derive(Debug, Clone)]
pub struct FileInfo {
    /// Relative path from vault root
    pub path: String,
    /// True if this is a directory
    pub is_dir: bool,
    /// File size in bytes (0 for directories)
    pub size: u64,
    /// Last modification time (Unix timestamp ms)
    pub mtime: u64,
}

/// Progress information for long-running operations
#[derive(Debug, Clone)]
pub struct Progress {
    /// Current operation description
    pub operation: String,
    /// Current item being processed
    pub current_item: Option<String>,
    /// Items completed
    pub completed: usize,
    /// Total items (if known)
    pub total: Option<usize>,
    /// Bytes transferred
    pub bytes: u64,
}

/// Peer status change notification
#[derive(Debug, Clone)]
pub enum PeerStatus {
    Connected,
    Disconnected,
    Syncing,
    Synced,
    Error(String),
}

/// Request for user approval (e.g., pairing)
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub kind: ApprovalKind,
    pub peer_id: String,
    pub peer_name: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub enum ApprovalKind {
    /// New device wants to pair
    PairRequest,
    /// Peer wants to share vault key
    KeyShareRequest,
}

// ============================================================================
// Transport Provider - Host-provided network transport
// ============================================================================

/// Connection information for a peer
#[derive(Debug, Clone)]
pub struct PeerAddress {
    /// Unique peer identifier (e.g., public key hex)
    pub peer_id: String,
    /// Connection ticket/address for reconnection
    pub ticket: String,
    /// Optional human-readable name
    pub name: Option<String>,
}

/// Incoming data from a peer
#[derive(Debug, Clone)]
pub struct IncomingData {
    /// Peer that sent the data
    pub peer_id: String,
    /// Stream ID (for multiplexing)
    pub stream_id: u32,
    /// The data payload
    pub data: Vec<u8>,
}

/// Stream opened by a peer
#[derive(Debug, Clone)]
pub struct IncomingStream {
    /// Peer that opened the stream
    pub peer_id: String,
    /// Stream ID
    pub stream_id: u32,
    /// Protocol identifier (e.g., "/pv/sync/1")
    pub protocol: String,
}

/// Connection state change
#[derive(Debug, Clone)]
pub enum ConnectionState {
    /// Peer connected
    Connected(PeerAddress),
    /// Peer disconnected
    Disconnected { peer_id: String, reason: String },
    /// Connection failed
    Failed { peer_id: String, error: String },
}

/// Transport provider trait - implemented by host to provide network transport
///
/// This allows the WASM module to use whatever transport the host provides:
/// - Obsidian/Electron: Real UDP via Node.js dgram
/// - Browser: WebSocket to a local reflector
/// - Native: Direct QUIC/UDP
///
/// The transport handles:
/// - Connection management (connect, accept, disconnect)
/// - Stream multiplexing (multiple logical streams per connection)
/// - Reliable, ordered delivery (like QUIC streams)
pub trait TransportProvider: Send + Sync + 'static {
    // ========================================================================
    // Lifecycle
    // ========================================================================

    /// Start the transport and begin accepting connections
    ///
    /// Returns our ticket/address that can be shared with peers
    fn start(&self) -> HostResult<String>;

    /// Stop the transport and close all connections
    fn stop(&self) -> HostResult<()>;

    /// Get our connection ticket for sharing
    fn get_ticket(&self) -> HostResult<String>;

    /// Get our peer ID (public key or unique identifier)
    fn get_peer_id(&self) -> String;

    // ========================================================================
    // Connection Management
    // ========================================================================

    /// Connect to a peer using their ticket
    ///
    /// Returns the peer's ID on success
    fn connect(&self, ticket: &str) -> HostResult<String>;

    /// Disconnect from a peer
    fn disconnect(&self, peer_id: &str) -> HostResult<()>;

    /// Get list of connected peers
    fn connected_peers(&self) -> Vec<PeerAddress>;

    /// Check if connected to a specific peer
    fn is_connected(&self, peer_id: &str) -> bool;

    // ========================================================================
    // Stream Operations (multiplexed reliable streams)
    // ========================================================================

    /// Open a new stream to a peer
    ///
    /// Returns the stream ID
    fn open_stream(&self, peer_id: &str, protocol: &str) -> HostResult<u32>;

    /// Send data on a stream
    fn send(&self, peer_id: &str, stream_id: u32, data: &[u8]) -> HostResult<()>;

    /// Close a stream
    fn close_stream(&self, peer_id: &str, stream_id: u32) -> HostResult<()>;

    // ========================================================================
    // Callbacks (host -> core)
    // ========================================================================

    /// Register callback for incoming data
    ///
    /// Called when data arrives on any stream
    fn on_data(&self, callback: Box<dyn Fn(IncomingData) + Send + Sync>);

    /// Register callback for incoming streams
    ///
    /// Called when a peer opens a new stream to us
    fn on_stream(&self, callback: Box<dyn Fn(IncomingStream) + Send + Sync>);

    /// Register callback for connection state changes
    fn on_connection(&self, callback: Box<dyn Fn(ConnectionState) + Send + Sync>);
}

/// The host interface trait
///
/// Implementations of this trait provide the core with access to:
/// - File system operations (for vault files)
/// - Key-value storage (for settings, peer list, etc.)
/// - User notifications and approvals
///
/// # Example Implementation (pseudocode)
///
/// ```ignore
/// struct ObsidianHost {
///     vault_path: PathBuf,
///     plugin_data: PluginData,
/// }
///
/// impl HostInterface for ObsidianHost {
///     fn read_file(&self, path: &str) -> HostResult<Vec<u8>> {
///         Box::pin(async move {
///             let full_path = self.vault_path.join(path);
///             tokio::fs::read(full_path).await
///                 .map_err(|e| HostError::IoError(e.to_string()))
///         })
///     }
///     // ... other methods
/// }
/// ```
pub trait HostInterface: Send + Sync + 'static {
    // ========================================================================
    // File System Operations
    // ========================================================================

    /// Read a file's contents
    ///
    /// Path is relative to vault root (e.g., "notes/daily.md")
    fn read_file(&self, path: &str) -> HostResult<Vec<u8>>;

    /// Write a file (creates parent directories as needed)
    fn write_file(&self, path: &str, data: &[u8]) -> HostResult<()>;

    /// Delete a file
    fn delete_file(&self, path: &str) -> HostResult<()>;

    /// Rename/move a file
    fn rename_file(&self, from: &str, to: &str) -> HostResult<()>;

    /// List files in a directory (non-recursive)
    ///
    /// Returns empty vec for empty directories, error for non-existent paths
    fn list_dir(&self, path: &str) -> HostResult<Vec<FileInfo>>;

    /// List all files in the vault (recursive)
    ///
    /// Used for initial sync to discover all files
    fn list_all_files(&self) -> HostResult<Vec<FileInfo>>;

    /// Check if a path exists
    fn exists(&self, path: &str) -> HostResult<bool>;

    /// Get file metadata
    fn file_info(&self, path: &str) -> HostResult<FileInfo>;

    // ========================================================================
    // Key-Value Storage (for core's internal data)
    // ========================================================================

    /// Get a value from storage
    ///
    /// Keys are namespaced (e.g., "peervault:peers", "peervault:vault-key")
    fn storage_get(&self, key: &str) -> HostResult<Option<Vec<u8>>>;

    /// Set a value in storage
    fn storage_set(&self, key: &str, value: &[u8]) -> HostResult<()>;

    /// Delete a value from storage
    fn storage_delete(&self, key: &str) -> HostResult<()>;

    /// List all keys with a given prefix
    fn storage_list(&self, prefix: &str) -> HostResult<Vec<String>>;

    // ========================================================================
    // Notifications (core -> host)
    // ========================================================================

    /// Notify host of sync progress
    ///
    /// Called periodically during sync operations
    fn notify_progress(&self, progress: Progress);

    /// Notify host of peer status change
    fn notify_peer_status(&self, peer_id: &str, status: PeerStatus);

    /// Notify host of a file change from sync
    ///
    /// Host may want to refresh UI, trigger indexing, etc.
    fn notify_file_changed(&self, path: &str);

    /// Notify host of an error
    fn notify_error(&self, error: &str);

    // ========================================================================
    // User Interaction
    // ========================================================================

    /// Request user approval for an action
    ///
    /// Returns true if user approves, false if denied
    /// Host should show appropriate UI (dialog, notification, etc.)
    fn request_approval(&self, request: ApprovalRequest) -> HostResult<bool>;

    // ========================================================================
    // Platform Info
    // ========================================================================

    /// Get device/platform name (e.g., "MacBook Pro", "Pixel 7")
    fn device_name(&self) -> String;

    /// Get current time in milliseconds since Unix epoch
    fn now_millis(&self) -> u64;

    /// Generate cryptographically secure random bytes
    fn random_bytes(&self, len: usize) -> Vec<u8>;
}

// ============================================================================
// Mock Implementation (for tests and WASM)
// ============================================================================

#[cfg(any(test, feature = "wasm", feature = "test-utils"))]
pub mod mock {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Mutex, atomic::{AtomicU32, Ordering}};

    /// In-memory mock host for testing
    pub struct MockHost {
        files: Mutex<HashMap<String, Vec<u8>>>,
        storage: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl MockHost {
        pub fn new() -> Self {
            Self {
                files: Mutex::new(HashMap::new()),
                storage: Mutex::new(HashMap::new()),
            }
        }
    }

    /// Mock transport provider for testing
    pub struct MockTransportProvider {
        peer_id: String,
        ticket: String,
        connected: Mutex<HashMap<String, PeerAddress>>,
        next_stream_id: AtomicU32,
        // Callbacks stored but not used in basic mock
        data_callback: Mutex<Option<Box<dyn Fn(IncomingData) + Send + Sync>>>,
        stream_callback: Mutex<Option<Box<dyn Fn(IncomingStream) + Send + Sync>>>,
        connection_callback: Mutex<Option<Box<dyn Fn(ConnectionState) + Send + Sync>>>,
    }

    impl MockTransportProvider {
        pub fn new() -> Self {
            Self {
                peer_id: "mock-peer-id".to_string(),
                ticket: "mock-ticket".to_string(),
                connected: Mutex::new(HashMap::new()),
                next_stream_id: AtomicU32::new(1),
                data_callback: Mutex::new(None),
                stream_callback: Mutex::new(None),
                connection_callback: Mutex::new(None),
            }
        }

        /// Simulate receiving data from a peer (for testing)
        pub fn simulate_incoming_data(&self, peer_id: &str, stream_id: u32, data: Vec<u8>) {
            if let Some(cb) = self.data_callback.lock().unwrap().as_ref() {
                cb(IncomingData {
                    peer_id: peer_id.to_string(),
                    stream_id,
                    data,
                });
            }
        }

        /// Simulate a peer opening a stream (for testing)
        pub fn simulate_incoming_stream(&self, peer_id: &str, stream_id: u32, protocol: &str) {
            if let Some(cb) = self.stream_callback.lock().unwrap().as_ref() {
                cb(IncomingStream {
                    peer_id: peer_id.to_string(),
                    stream_id,
                    protocol: protocol.to_string(),
                });
            }
        }

        /// Simulate a peer connecting (for testing)
        pub fn simulate_peer_connected(&self, peer_id: &str, ticket: &str) {
            let addr = PeerAddress {
                peer_id: peer_id.to_string(),
                ticket: ticket.to_string(),
                name: None,
            };
            self.connected.lock().unwrap().insert(peer_id.to_string(), addr.clone());
            if let Some(cb) = self.connection_callback.lock().unwrap().as_ref() {
                cb(ConnectionState::Connected(addr));
            }
        }
    }

    impl TransportProvider for MockTransportProvider {
        fn start(&self) -> HostResult<String> {
            let ticket = self.ticket.clone();
            Box::pin(async move { Ok(ticket) })
        }

        fn stop(&self) -> HostResult<()> {
            Box::pin(async { Ok(()) })
        }

        fn get_ticket(&self) -> HostResult<String> {
            let ticket = self.ticket.clone();
            Box::pin(async move { Ok(ticket) })
        }

        fn get_peer_id(&self) -> String {
            self.peer_id.clone()
        }

        fn connect(&self, ticket: &str) -> HostResult<String> {
            let peer_id = format!("peer-from-{}", ticket);
            let addr = PeerAddress {
                peer_id: peer_id.clone(),
                ticket: ticket.to_string(),
                name: None,
            };
            self.connected.lock().unwrap().insert(peer_id.clone(), addr);
            Box::pin(async move { Ok(peer_id) })
        }

        fn disconnect(&self, peer_id: &str) -> HostResult<()> {
            self.connected.lock().unwrap().remove(peer_id);
            Box::pin(async { Ok(()) })
        }

        fn connected_peers(&self) -> Vec<PeerAddress> {
            self.connected.lock().unwrap().values().cloned().collect()
        }

        fn is_connected(&self, peer_id: &str) -> bool {
            self.connected.lock().unwrap().contains_key(peer_id)
        }

        fn open_stream(&self, peer_id: &str, _protocol: &str) -> HostResult<u32> {
            let connected = self.connected.lock().unwrap();
            let peer_id_owned = peer_id.to_string();
            if !connected.contains_key(peer_id) {
                return Box::pin(async move {
                    Err(HostError::NotFound(format!("peer not connected: {}", peer_id_owned)))
                });
            }
            let stream_id = self.next_stream_id.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(stream_id) })
        }

        fn send(&self, peer_id: &str, _stream_id: u32, _data: &[u8]) -> HostResult<()> {
            let connected = self.connected.lock().unwrap();
            let peer_id_owned = peer_id.to_string();
            if !connected.contains_key(peer_id) {
                return Box::pin(async move {
                    Err(HostError::NotFound(format!("peer not connected: {}", peer_id_owned)))
                });
            }
            // In a real implementation, data would be sent over the network
            Box::pin(async { Ok(()) })
        }

        fn close_stream(&self, _peer_id: &str, _stream_id: u32) -> HostResult<()> {
            Box::pin(async { Ok(()) })
        }

        fn on_data(&self, callback: Box<dyn Fn(IncomingData) + Send + Sync>) {
            *self.data_callback.lock().unwrap() = Some(callback);
        }

        fn on_stream(&self, callback: Box<dyn Fn(IncomingStream) + Send + Sync>) {
            *self.stream_callback.lock().unwrap() = Some(callback);
        }

        fn on_connection(&self, callback: Box<dyn Fn(ConnectionState) + Send + Sync>) {
            *self.connection_callback.lock().unwrap() = Some(callback);
        }
    }

    impl HostInterface for MockHost {
        fn read_file(&self, path: &str) -> HostResult<Vec<u8>> {
            let files = self.files.lock().unwrap();
            let data = files.get(path).cloned();
            let path_owned = path.to_string();
            Box::pin(async move {
                data.ok_or_else(|| HostError::NotFound(path_owned))
            })
        }

        fn write_file(&self, path: &str, data: &[u8]) -> HostResult<()> {
            let mut files = self.files.lock().unwrap();
            files.insert(path.to_string(), data.to_vec());
            Box::pin(async { Ok(()) })
        }

        fn delete_file(&self, path: &str) -> HostResult<()> {
            let mut files = self.files.lock().unwrap();
            files.remove(path);
            Box::pin(async { Ok(()) })
        }

        fn rename_file(&self, from: &str, to: &str) -> HostResult<()> {
            let mut files = self.files.lock().unwrap();
            if let Some(data) = files.remove(from) {
                files.insert(to.to_string(), data);
            }
            Box::pin(async { Ok(()) })
        }

        fn list_dir(&self, _path: &str) -> HostResult<Vec<FileInfo>> {
            Box::pin(async { Ok(vec![]) })
        }

        fn list_all_files(&self) -> HostResult<Vec<FileInfo>> {
            let files = self.files.lock().unwrap();
            let infos: Vec<FileInfo> = files.keys().map(|path| FileInfo {
                path: path.clone(),
                is_dir: false,
                size: files.get(path).map(|d| d.len() as u64).unwrap_or(0),
                mtime: 0,
            }).collect();
            Box::pin(async move { Ok(infos) })
        }

        fn exists(&self, path: &str) -> HostResult<bool> {
            let files = self.files.lock().unwrap();
            let exists = files.contains_key(path);
            Box::pin(async move { Ok(exists) })
        }

        fn file_info(&self, path: &str) -> HostResult<FileInfo> {
            let files = self.files.lock().unwrap();
            let path_owned = path.to_string();
            let info = files.get(path).map(|data| FileInfo {
                path: path_owned.clone(),
                is_dir: false,
                size: data.len() as u64,
                mtime: 0,
            });
            Box::pin(async move {
                info.ok_or_else(|| HostError::NotFound(path_owned))
            })
        }

        fn storage_get(&self, key: &str) -> HostResult<Option<Vec<u8>>> {
            let storage = self.storage.lock().unwrap();
            let data = storage.get(key).cloned();
            Box::pin(async move { Ok(data) })
        }

        fn storage_set(&self, key: &str, value: &[u8]) -> HostResult<()> {
            let mut storage = self.storage.lock().unwrap();
            storage.insert(key.to_string(), value.to_vec());
            Box::pin(async { Ok(()) })
        }

        fn storage_delete(&self, key: &str) -> HostResult<()> {
            let mut storage = self.storage.lock().unwrap();
            storage.remove(key);
            Box::pin(async { Ok(()) })
        }

        fn storage_list(&self, prefix: &str) -> HostResult<Vec<String>> {
            let storage = self.storage.lock().unwrap();
            let keys: Vec<String> = storage.keys()
                .filter(|k| k.starts_with(prefix))
                .cloned()
                .collect();
            Box::pin(async move { Ok(keys) })
        }

        fn notify_progress(&self, _progress: Progress) {}
        fn notify_peer_status(&self, _peer_id: &str, _status: PeerStatus) {}
        fn notify_file_changed(&self, _path: &str) {}
        fn notify_error(&self, _error: &str) {}

        fn request_approval(&self, _request: ApprovalRequest) -> HostResult<bool> {
            Box::pin(async { Ok(true) }) // Auto-approve in tests
        }

        fn device_name(&self) -> String {
            "Test Device".into()
        }

        fn now_millis(&self) -> u64 {
            web_time::SystemTime::now()
                .duration_since(web_time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        }

        fn random_bytes(&self, len: usize) -> Vec<u8> {
            // In WASM this type is used as the production host, so it MUST return
            // cryptographically secure randomness (rand pulls entropy from the
            // browser crypto API via getrandom's `js` backend). Native test builds
            // keep deterministic zeros so test vectors stay reproducible.
            #[cfg(feature = "wasm")]
            {
                use rand::Rng;
                let mut bytes = vec![0u8; len];
                rand::rng().fill_bytes(&mut bytes);
                bytes
            }
            #[cfg(not(feature = "wasm"))]
            {
                vec![0u8; len] // Deterministic for testing
            }
        }
    }
}
