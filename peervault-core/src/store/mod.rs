//! Document Store - Loro CRDT-based storage
//!
//! This module provides document storage using Loro CRDTs.
//! The data model matches the TypeScript implementation:
//! - LoroDoc with LoroTree for file structure
//! - LoroText for text content
//! - Binary files reference blobs by hash
//!
//! Designed for future compatibility with iroh-docs when it ships WASM.

pub mod loro_store;

pub use loro_store::LoroStore;

use serde::{Deserialize, Serialize};

/// 32-byte hash type (SHA-256)
pub type Hash = [u8; 32];

/// Version vector bytes (serialized from Loro)
pub type VersionVector = Vec<u8>;

/// File node type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileType {
    /// Regular text file
    File,
    /// Binary file (content stored in blob store)
    Binary,
    /// Directory/folder
    Folder,
}

/// Metadata for a file node in the tree
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    /// File path (e.g., "notes/todo.md")
    pub path: String,
    /// File type
    pub file_type: FileType,
    /// MIME type (for binary files)
    pub mime_type: Option<String>,
    /// Modification time (Unix timestamp seconds)
    pub mtime: u64,
    /// Creation time (Unix timestamp seconds)
    pub ctime: u64,
    /// Whether this file is deleted (soft delete)
    pub deleted: bool,
    /// Blob hash (for binary files)
    pub blob_hash: Option<Hash>,
}

/// Result type for store operations
pub type StoreResult<T> = Result<T, StoreError>;

/// Error type for store operations
#[derive(Debug, Clone)]
pub enum StoreError {
    /// Document not found
    NotFound(String),
    /// Blob not found for hash
    BlobNotFound(Hash),
    /// Invalid path
    InvalidPath(String),
    /// Loro error
    Loro(String),
    /// Serialization error
    Serialization(String),
    /// Other error
    Other(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound(path) => write!(f, "document not found: {}", path),
            StoreError::BlobNotFound(hash) => write!(f, "blob not found: {}", hex::encode(hash)),
            StoreError::InvalidPath(path) => write!(f, "invalid path: {}", path),
            StoreError::Loro(msg) => write!(f, "loro error: {}", msg),
            StoreError::Serialization(msg) => write!(f, "serialization error: {}", msg),
            StoreError::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for StoreError {}

/// Sync statistics
#[derive(Debug, Clone, Default)]
pub struct SyncStats {
    /// Operations sent to peer
    pub ops_sent: usize,
    /// Operations received from peer
    pub ops_received: usize,
    /// Bytes sent
    pub bytes_sent: u64,
    /// Bytes received
    pub bytes_received: u64,
}

/// Document store trait
///
/// Abstracts document storage for future iroh-docs compatibility.
pub trait DocStore: Send + Sync {
    /// Get the vault ID
    fn vault_id(&self) -> &[u8; 32];

    /// Get the current version vector (for sync comparison)
    fn version_vector(&self) -> VersionVector;

    /// Export updates since a given version
    /// If `since` is None, exports full snapshot
    fn export_updates(&self, since: Option<&[u8]>) -> StoreResult<Vec<u8>>;

    /// Import updates from peer
    fn import_updates(&self, data: &[u8]) -> StoreResult<()>;

    /// Export full document snapshot
    fn export_snapshot(&self) -> StoreResult<Vec<u8>>;

    /// Import full document snapshot
    fn import_snapshot(&self, data: &[u8]) -> StoreResult<()>;

    /// Get text content for a file
    fn get_text(&self, path: &str) -> StoreResult<Option<String>>;

    /// Set text content for a file
    fn set_text(&self, path: &str, content: &str) -> StoreResult<()>;

    /// Get file metadata
    fn get_file(&self, path: &str) -> StoreResult<Option<FileNode>>;

    /// Delete a file (soft delete)
    fn delete_file(&self, path: &str) -> StoreResult<()>;

    /// List all files (optionally filtered by prefix)
    fn list_files(&self, prefix: Option<&str>) -> StoreResult<Vec<FileNode>>;

    /// Create a folder
    fn create_folder(&self, path: &str) -> StoreResult<()>;

    /// Set binary file (stores blob hash reference)
    fn set_binary(&self, path: &str, blob_hash: Hash, mime_type: Option<&str>) -> StoreResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_type() {
        assert_eq!(FileType::File, FileType::File);
        assert_ne!(FileType::File, FileType::Binary);
    }
}
