//! Sync Engine - Loro CRDT based synchronization
//!
//! Uses Loro's built-in sync capabilities:
//! 1. Exchange version vectors - compare document states
//! 2. Export updates since peer's version
//! 3. Import updates from peer
//! 4. Exchange blob hashes and transfer missing blobs
//! 5. Enter live mode for incremental updates
//!
//! All exported data is encrypted with the vault key for defense in depth,
//! even when transported over an already-encrypted connection.

use std::sync::Arc;
use tokio::sync::RwLock;
use iroh_blobs::Hash;
use crate::host::HostInterface;
use crate::error::CoreError;
use crate::store::{LoroStore, DocStore};
use crate::crypto::VaultKey;

const STORAGE_KEY_DOC: &str = "peervault:sync:doc";
const STORAGE_KEY_VAULT_KEY: &str = "peervault:vault:key";

/// The sync engine manages document state using Loro CRDTs
///
/// All vaults are encrypted - a VaultKey is required for operation.
pub struct SyncEngine {
    host: Arc<dyn HostInterface>,
    /// Our peer ID (for tracking who made changes)
    peer_id: String,
    /// The Loro document store
    store: LoroStore,
    /// Vault encryption key (required)
    vault_key: Arc<RwLock<Option<VaultKey>>>,
}

impl SyncEngine {
    /// Create a new sync engine
    ///
    /// The vault key must be set via `set_vault_key` before any sync operations.
    pub fn new(host: Arc<dyn HostInterface>) -> Result<Self, CoreError> {
        // Generate a peer ID for this device
        let peer_id_bytes = host.random_bytes(16);
        let peer_id = hex::encode(&peer_id_bytes);

        // Generate a vault ID (will be set properly on init)
        let vault_id = [0u8; 32];

        Ok(Self {
            host,
            peer_id,
            store: LoroStore::new(vault_id),
            vault_key: Arc::new(RwLock::new(None)),
        })
    }

    /// Create a new sync engine with a vault key
    pub fn new_with_key(host: Arc<dyn HostInterface>, vault_key: VaultKey) -> Result<Self, CoreError> {
        let mut engine = Self::new(host)?;
        // Initialize the key by replacing the field directly — avoids blocking_write,
        // which panics if new_with_key is ever called inside an async runtime context.
        engine.vault_key = Arc::new(RwLock::new(Some(vault_key)));
        Ok(engine)
    }

    /// Initialize with a specific vault ID
    pub fn init_vault(&mut self, vault_id: [u8; 32]) {
        self.store = LoroStore::new(vault_id);
    }

    /// Set the vault encryption key
    pub async fn set_vault_key(&self, key: VaultKey) {
        *self.vault_key.write().await = Some(key);
    }

    /// Check if vault key is set
    pub async fn has_vault_key(&self) -> bool {
        self.vault_key.read().await.is_some()
    }

    /// Get a clone of the vault key (for sharing during pairing)
    pub async fn get_vault_key(&self) -> Option<VaultKey> {
        self.vault_key.read().await.clone()
    }

    /// Generate a new vault key
    pub async fn generate_vault_key(&self) -> VaultKey {
        let key = VaultKey::generate();
        *self.vault_key.write().await = Some(key.clone());
        key
    }

    /// Get the vault key, returning an error if not set
    fn require_vault_key_sync(&self) -> Result<VaultKey, CoreError> {
        self.vault_key.blocking_read()
            .clone()
            .ok_or_else(|| CoreError::Crypto("Vault key not set".into()))
    }

    /// Get our peer ID
    pub fn peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Get the vault ID
    pub fn vault_id(&self) -> &[u8; 32] {
        self.store.vault_id()
    }

    /// Get our version vector (for sync comparison)
    pub fn version_vector(&self) -> Vec<u8> {
        self.store.version_vector()
    }

    /// Check if in sync with peer (same version vector)
    pub fn is_synced_with(&self, peer_vv: &[u8]) -> bool {
        self.store.version_vector() == peer_vv
    }

    /// Export updates since peer's version (encrypted)
    ///
    /// The returned data is encrypted with the vault key.
    pub fn export_updates_since(&self, peer_vv: &[u8]) -> Result<Vec<u8>, CoreError> {
        let key = self.require_vault_key_sync()?;
        let plaintext = self.store.export_updates(Some(peer_vv))
            .map_err(|e| CoreError::Crdt(e.to_string()))?;
        key.encrypt(&plaintext)
            .map_err(|e| CoreError::Crypto(e.to_string()))
    }

    /// Export updates since peer's version (unencrypted, for internal use)
    pub fn export_updates_since_raw(&self, peer_vv: &[u8]) -> Result<Vec<u8>, CoreError> {
        self.store.export_updates(Some(peer_vv))
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Export full snapshot (encrypted)
    ///
    /// The returned data is encrypted with the vault key.
    pub fn export_snapshot(&self) -> Result<Vec<u8>, CoreError> {
        let key = self.require_vault_key_sync()?;
        let plaintext = self.store.export_snapshot()
            .map_err(|e| CoreError::Crdt(e.to_string()))?;
        key.encrypt(&plaintext)
            .map_err(|e| CoreError::Crypto(e.to_string()))
    }

    /// Export full snapshot (unencrypted, for internal use)
    pub fn export_snapshot_raw(&self) -> Result<Vec<u8>, CoreError> {
        self.store.export_snapshot()
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Import updates from peer (encrypted)
    ///
    /// The data must be encrypted with the vault key.
    pub fn import_updates(&self, encrypted_data: &[u8]) -> Result<(), CoreError> {
        let key = self.require_vault_key_sync()?;
        let plaintext = key.decrypt(encrypted_data)
            .map_err(|e| CoreError::Crypto(e.to_string()))?;
        self.store.import_updates(&plaintext)
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Import updates from peer (unencrypted, for internal use)
    pub fn import_updates_raw(&self, data: &[u8]) -> Result<(), CoreError> {
        self.store.import_updates(data)
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Import snapshot from peer (encrypted)
    ///
    /// The data must be encrypted with the vault key.
    pub fn import_snapshot(&self, encrypted_data: &[u8]) -> Result<(), CoreError> {
        let key = self.require_vault_key_sync()?;
        let plaintext = key.decrypt(encrypted_data)
            .map_err(|e| CoreError::Crypto(e.to_string()))?;
        self.store.import_snapshot(&plaintext)
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Import snapshot from peer (unencrypted, for internal use)
    pub fn import_snapshot_raw(&self, data: &[u8]) -> Result<(), CoreError> {
        self.store.import_snapshot(data)
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Get a document by path
    pub fn get(&self, path: &str) -> Option<String> {
        self.store.get_text(path).ok().flatten()
    }

    /// Set a document (called when user edits locally)
    pub fn set(&self, path: &str, content: &str) -> Result<(), CoreError> {
        self.store.set_text(path, content)
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Delete a document
    pub fn delete(&self, path: &str) -> Result<(), CoreError> {
        self.store.delete_file(path)
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Get all document paths
    pub fn list_paths(&self) -> Vec<String> {
        self.store.list_files(None)
            .unwrap_or_default()
            .into_iter()
            .map(|f| f.path)
            .collect()
    }

    /// Apply a local change
    pub fn apply_local(&self, change: crate::LocalChange) -> Result<(), CoreError> {
        match change.kind {
            crate::ChangeKind::Create { content } => {
                let text = String::from_utf8_lossy(&content);
                self.set(&change.path, &text)
            }
            crate::ChangeKind::Modify { content } => {
                let text = String::from_utf8_lossy(&content);
                self.set(&change.path, &text)
            }
            crate::ChangeKind::Delete => self.delete(&change.path),
            crate::ChangeKind::Rename { new_path } => {
                if let Some(content) = self.get(&change.path) {
                    self.delete(&change.path)?;
                    self.set(&new_path, &content)
                } else {
                    Ok(())
                }
            }
        }
    }

    /// Get number of pending changes
    pub fn pending_count(&self) -> usize {
        0 // Loro handles this internally
    }

    /// Export state for persistence (encrypted)
    pub fn export_state(&self) -> Result<Vec<u8>, CoreError> {
        let key = self.require_vault_key_sync()?;
        let plaintext = self.store.export_snapshot()
            .map_err(|e| CoreError::Crdt(e.to_string()))?;
        key.encrypt(&plaintext)
            .map_err(|e| CoreError::Crypto(e.to_string()))
    }

    /// Import state from persistence (encrypted)
    pub fn import_state(&self, encrypted_data: &[u8]) -> Result<(), CoreError> {
        let key = self.require_vault_key_sync()?;
        let plaintext = key.decrypt(encrypted_data)
            .map_err(|e| CoreError::Crypto(e.to_string()))?;
        self.store.import_snapshot(&plaintext)
            .map_err(|e| CoreError::Crdt(e.to_string()))
    }

    /// Load state from storage
    pub async fn load(&self) -> Result<(), CoreError> {
        // Load encrypted state
        if let Some(data) = self.host.storage_get(STORAGE_KEY_DOC).await
            .map_err(CoreError::from)?
        {
            self.import_state(&data)?;
        }
        Ok(())
    }

    /// Save state to storage
    pub async fn save(&self) -> Result<(), CoreError> {
        let data = self.export_state()?;
        self.host.storage_set(STORAGE_KEY_DOC, &data).await
            .map_err(CoreError::from)?;
        Ok(())
    }

    /// Save vault key to storage (encrypted with device secret)
    pub async fn save_vault_key(&self, device_secret: &[u8; 32]) -> Result<(), CoreError> {
        let vault_key = self.vault_key.read().await;
        if let Some(key) = vault_key.as_ref() {
            // Use device secret to wrap the vault key
            let wrapper = VaultKey::from_bytes(device_secret)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            let encrypted = wrapper.encrypt(key.as_bytes())
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            self.host.storage_set(STORAGE_KEY_VAULT_KEY, &encrypted).await
                .map_err(CoreError::from)?;
        }
        Ok(())
    }

    /// Load vault key from storage (decrypt with device secret)
    pub async fn load_vault_key(&self, device_secret: &[u8; 32]) -> Result<bool, CoreError> {
        if let Some(encrypted) = self.host.storage_get(STORAGE_KEY_VAULT_KEY).await
            .map_err(CoreError::from)?
        {
            let wrapper = VaultKey::from_bytes(device_secret)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            let key_bytes = wrapper.decrypt(&encrypted)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            let vault_key = VaultKey::from_bytes(&key_bytes)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            *self.vault_key.write().await = Some(vault_key);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    // =========================================================================
    // Blob Sync Support
    // =========================================================================

    /// Encrypt blob data for transfer
    pub fn encrypt_blob(&self, data: &[u8]) -> Result<Vec<u8>, CoreError> {
        let key = self.require_vault_key_sync()?;
        key.encrypt(data)
            .map_err(|e| CoreError::Crypto(e.to_string()))
    }

    /// Decrypt blob data received from peer
    pub fn decrypt_blob(&self, encrypted_data: &[u8]) -> Result<Vec<u8>, CoreError> {
        let key = self.require_vault_key_sync()?;
        key.decrypt(encrypted_data)
            .map_err(|e| CoreError::Crypto(e.to_string()))
    }
}

/// Sync session state machine
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncState {
    /// Initial state
    Idle,
    /// Exchanging version vectors
    ExchangingVersions,
    /// Syncing CRDT updates
    SyncingUpdates,
    /// Exchanging blob hashes
    ExchangingBlobHashes,
    /// Syncing blobs
    SyncingBlobs,
    /// Sync complete, in live mode
    Live,
    /// Error state
    Error,
}

/// Manages a sync session with a single peer
pub struct SyncSession {
    state: SyncState,
    /// Peer's version vector
    peer_vv: Option<Vec<u8>>,
    /// Whether peer has vault key
    peer_has_vault_key: bool,
    /// Our blob hashes (sent to peer)
    our_blob_hashes: Vec<Hash>,
    /// Peer's blob hashes
    peer_blob_hashes: Vec<Hash>,
    /// Blobs we need from peer
    blobs_needed: Vec<Hash>,
    /// Blobs peer needs from us
    blobs_to_send: Vec<Hash>,
    /// Count of blobs received
    blobs_received: usize,
    /// Count of blobs sent
    blobs_sent: usize,
}

impl SyncSession {
    pub fn new() -> Self {
        Self {
            state: SyncState::Idle,
            peer_vv: None,
            peer_has_vault_key: false,
            our_blob_hashes: Vec::new(),
            peer_blob_hashes: Vec::new(),
            blobs_needed: Vec::new(),
            blobs_to_send: Vec::new(),
            blobs_received: 0,
            blobs_sent: 0,
        }
    }

    pub fn state(&self) -> SyncState {
        self.state
    }

    /// Start sync session
    pub fn start(&mut self) {
        self.state = SyncState::ExchangingVersions;
    }

    /// Set peer's version vector
    pub fn set_peer_version(&mut self, vv: Vec<u8>) {
        self.peer_vv = Some(vv);
        self.state = SyncState::SyncingUpdates;
    }

    /// Mark CRDT sync as complete, start blob sync
    pub fn updates_complete(&mut self) {
        self.state = SyncState::ExchangingBlobHashes;
    }

    /// Mark sync as complete (both CRDT and blobs)
    pub fn complete(&mut self) {
        self.state = SyncState::Live;
    }

    /// Mark session as errored
    pub fn set_error(&mut self) {
        self.state = SyncState::Error;
    }

    /// Check if in live mode
    pub fn is_live(&self) -> bool {
        self.state == SyncState::Live
    }

    /// Check if peer has vault key
    pub fn peer_has_vault_key(&self) -> bool {
        self.peer_has_vault_key
    }

    /// Set peer's vault key status
    pub fn set_peer_has_vault_key(&mut self, has_key: bool) {
        self.peer_has_vault_key = has_key;
    }

    /// Get peer's version vector
    pub fn peer_version(&self) -> Option<&[u8]> {
        self.peer_vv.as_deref()
    }

    // =========================================================================
    // Blob Sync Methods
    // =========================================================================

    /// Set our blob hashes (to send to peer)
    pub fn set_our_blob_hashes(&mut self, hashes: Vec<Hash>) {
        self.our_blob_hashes = hashes;
    }

    /// Get our blob hashes
    pub fn our_blob_hashes(&self) -> &[Hash] {
        &self.our_blob_hashes
    }

    /// Set peer's blob hashes and compute what we need
    pub fn set_peer_blob_hashes(&mut self, hashes: Vec<Hash>) {
        // Compute what we need from peer (they have, we don't)
        let our_set: std::collections::HashSet<Hash> = self.our_blob_hashes.iter().copied().collect();
        self.blobs_needed = hashes.iter().filter(|h| !our_set.contains(*h)).copied().collect();

        // Compute what peer needs from us (we have, they don't)
        let peer_set: std::collections::HashSet<Hash> = hashes.iter().copied().collect();
        self.blobs_to_send = self.our_blob_hashes.iter().filter(|h| !peer_set.contains(*h)).copied().collect();

        self.peer_blob_hashes = hashes;
        self.state = SyncState::SyncingBlobs;
    }

    /// Get list of blobs we need from peer
    pub fn blobs_needed(&self) -> &[Hash] {
        &self.blobs_needed
    }

    /// Get list of blobs to send to peer
    pub fn blobs_to_send(&self) -> &[Hash] {
        &self.blobs_to_send
    }

    /// Record that a blob was received
    pub fn blob_received(&mut self, hash: &Hash) {
        self.blobs_needed.retain(|h| h != hash);
        self.blobs_received += 1;
    }

    /// Record that a blob was sent
    pub fn blob_sent(&mut self, hash: &Hash) {
        self.blobs_to_send.retain(|h| h != hash);
        self.blobs_sent += 1;
    }

    /// Check if all blobs have been synced
    pub fn blobs_synced(&self) -> bool {
        self.blobs_needed.is_empty() && self.blobs_to_send.is_empty()
    }

    /// Get blob sync statistics
    pub fn blob_stats(&self) -> (usize, usize) {
        (self.blobs_received, self.blobs_sent)
    }

    /// Get number of pending blobs (total to receive + send)
    pub fn pending_blobs(&self) -> usize {
        self.blobs_needed.len() + self.blobs_to_send.len()
    }
}

impl Default for SyncSession {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of merging with peer
#[derive(Debug, Clone)]
pub struct MergeResult {
    /// Number of CRDT operations imported
    pub ops_imported: usize,
    /// Whether there were conflicts
    pub had_conflicts: bool,
    /// Number of blobs received
    pub blobs_received: usize,
    /// Number of blobs sent
    pub blobs_sent: usize,
}

/// Result of blob sync phase
#[derive(Debug, Clone)]
pub struct BlobSyncResult {
    /// Number of blobs received from peer
    pub received: usize,
    /// Number of blobs sent to peer
    pub sent: usize,
    /// Bytes received
    pub bytes_received: u64,
    /// Bytes sent
    pub bytes_sent: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::mock::MockHost;

    fn create_engine_with_key(host: Arc<MockHost>) -> SyncEngine {
        let key = VaultKey::generate();
        SyncEngine::new_with_key(host, key).unwrap()
    }

    #[test]
    fn test_set_get() {
        let host = Arc::new(MockHost::new());
        let engine = create_engine_with_key(host);

        engine.set("test.md", "hello world").unwrap();

        let content = engine.get("test.md").unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_delete() {
        let host = Arc::new(MockHost::new());
        let engine = create_engine_with_key(host);

        engine.set("test.md", "content").unwrap();
        assert!(engine.get("test.md").is_some());

        engine.delete("test.md").unwrap();
        // After delete, file is soft-deleted so get returns None
        assert!(engine.get("test.md").is_none());
    }

    #[test]
    fn test_sync_between_engines() {
        let host1 = Arc::new(MockHost::new());
        let host2 = Arc::new(MockHost::new());

        // Both engines need the same vault key
        let vault_key = VaultKey::generate();
        let engine1 = SyncEngine::new_with_key(host1, vault_key.clone()).unwrap();
        let engine2 = SyncEngine::new_with_key(host2, vault_key).unwrap();

        // Engine 1 creates a file
        engine1.set("test.md", "hello").unwrap();

        // Get engine 1's state (encrypted)
        let snapshot = engine1.export_snapshot().unwrap();

        // Import into engine 2 (decrypted with same key)
        engine2.import_snapshot(&snapshot).unwrap();

        // Engine 2 should have the file
        assert_eq!(engine2.get("test.md").unwrap(), "hello");
    }

    #[test]
    fn test_incremental_sync() {
        let host1 = Arc::new(MockHost::new());
        let host2 = Arc::new(MockHost::new());

        // Both engines need the same vault key
        let vault_key = VaultKey::generate();
        let engine1 = SyncEngine::new_with_key(host1, vault_key.clone()).unwrap();
        let engine2 = SyncEngine::new_with_key(host2, vault_key).unwrap();

        // Initial sync using raw (unencrypted) for setup
        let snapshot = engine1.export_snapshot_raw().unwrap();
        engine2.import_snapshot_raw(&snapshot).unwrap();

        // Engine 1 makes a change
        engine1.set("new.md", "new content").unwrap();

        // Get engine 2's version
        let vv2 = engine2.version_vector();

        // Export only updates since engine 2's version (encrypted)
        let updates = engine1.export_updates_since(&vv2).unwrap();

        // Import updates into engine 2 (decrypted with same key)
        engine2.import_updates(&updates).unwrap();

        // Engine 2 should have the new file
        assert_eq!(engine2.get("new.md").unwrap(), "new content");
    }

    #[test]
    fn test_sync_fails_without_key() {
        let host = Arc::new(MockHost::new());
        let engine = SyncEngine::new(host).unwrap();

        engine.set("test.md", "hello").unwrap();

        // Export should fail without vault key
        let result = engine.export_snapshot();
        assert!(result.is_err());
    }

    #[test]
    fn test_sync_fails_with_wrong_key() {
        let host1 = Arc::new(MockHost::new());
        let host2 = Arc::new(MockHost::new());

        // Each engine has a different key
        let engine1 = create_engine_with_key(host1);
        let engine2 = create_engine_with_key(host2);

        // Engine 1 creates a file
        engine1.set("test.md", "secret").unwrap();

        // Get engine 1's encrypted state
        let snapshot = engine1.export_snapshot().unwrap();

        // Engine 2 tries to import with wrong key - should fail
        let result = engine2.import_snapshot(&snapshot);
        assert!(result.is_err());
    }

    #[test]
    fn test_blob_sync_session() {
        let mut session = SyncSession::new();

        // Start session
        session.start();
        assert_eq!(session.state(), SyncState::ExchangingVersions);

        // Set peer version
        session.set_peer_version(vec![1, 2, 3]);
        assert_eq!(session.state(), SyncState::SyncingUpdates);

        // Complete CRDT sync, start blob sync
        session.updates_complete();
        assert_eq!(session.state(), SyncState::ExchangingBlobHashes);

        // Set our blob hashes (use Hash::new to create proper hashes)
        use iroh_blobs::Hash;
        let hash1 = Hash::new(&[1u8]);
        let hash2 = Hash::new(&[2u8]);
        let hash3 = Hash::new(&[3u8]);
        session.set_our_blob_hashes(vec![hash1, hash2]);

        // Set peer's hashes (they have hash2 and hash3)
        session.set_peer_blob_hashes(vec![hash2, hash3]);
        assert_eq!(session.state(), SyncState::SyncingBlobs);

        // We need hash3 from peer (they have, we don't)
        assert_eq!(session.blobs_needed(), &[hash3]);

        // We need to send hash1 to peer (we have, they don't)
        assert_eq!(session.blobs_to_send(), &[hash1]);

        // Record receiving a blob
        session.blob_received(&hash3);
        assert!(session.blobs_needed().is_empty());

        // Record sending a blob
        session.blob_sent(&hash1);
        assert!(session.blobs_to_send().is_empty());

        // All blobs synced
        assert!(session.blobs_synced());
        assert_eq!(session.blob_stats(), (1, 1)); // 1 received, 1 sent

        // Complete session
        session.complete();
        assert!(session.is_live());
    }

    #[test]
    fn test_blob_encryption() {
        let host = Arc::new(MockHost::new());
        let engine = create_engine_with_key(host);

        let blob_data = b"binary blob content";

        // Encrypt blob
        let encrypted = engine.encrypt_blob(blob_data).unwrap();
        assert_ne!(encrypted, blob_data);

        // Decrypt blob
        let decrypted = engine.decrypt_blob(&encrypted).unwrap();
        assert_eq!(decrypted, blob_data);
    }

    #[test]
    fn test_blob_decryption_fails_with_wrong_key() {
        let host1 = Arc::new(MockHost::new());
        let host2 = Arc::new(MockHost::new());

        let engine1 = create_engine_with_key(host1);
        let engine2 = create_engine_with_key(host2);

        let blob_data = b"secret blob";

        // Encrypt with engine1's key
        let encrypted = engine1.encrypt_blob(blob_data).unwrap();

        // Try to decrypt with engine2's different key - should fail
        let result = engine2.decrypt_blob(&encrypted);
        assert!(result.is_err());
    }
}
