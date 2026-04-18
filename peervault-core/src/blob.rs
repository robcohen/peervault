//! Blob Store - Content-addressed binary storage
//!
//! Handles:
//! - Content-addressed storage (Blake3 hash → data)
//! - Blob exchange between peers
//! - MIME type tracking
//!
//! Uses `iroh-blobs` types for compatibility with the Iroh ecosystem.

use std::sync::Arc;
use iroh_blobs::Hash;
use crate::host::HostInterface;
use crate::error::CoreError;

const BLOB_KEY_PREFIX: &str = "peervault:blob:";
const BLOB_META_PREFIX: &str = "peervault:blob-meta:";

/// Blob metadata
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlobMeta {
    /// Content hash (Blake3)
    pub hash: Hash,
    /// Size in bytes
    pub size: u64,
    /// MIME type (optional)
    pub mime_type: Option<String>,
    /// When the blob was stored (Unix timestamp ms)
    pub stored_at: u64,
}

/// Content-addressed blob store
pub struct BlobStore {
    host: Arc<dyn HostInterface>,
}

impl BlobStore {
    pub fn new(host: Arc<dyn HostInterface>) -> Result<Self, CoreError> {
        Ok(Self { host })
    }

    /// Compute Blake3 hash of data (via iroh-blobs)
    pub fn hash(data: &[u8]) -> Hash {
        Hash::new(data)
    }

    /// Convert hash to hex string
    pub fn hash_to_hex(hash: &Hash) -> String {
        hash.to_hex()
    }

    /// Parse hex string to hash
    pub fn hex_to_hash(s: &str) -> Result<Hash, CoreError> {
        s.parse()
            .map_err(|e| CoreError::Internal(format!("invalid hex: {}", e)))
    }

    /// Check if we have a blob
    pub async fn has(&self, hash: &Hash) -> bool {
        let key = format!("{}{}", BLOB_KEY_PREFIX, Self::hash_to_hex(hash));
        match self.host.storage_get(&key).await {
            Ok(Some(_)) => true,
            _ => false,
        }
    }

    /// Get a blob's data
    pub async fn get(&self, hash: &Hash) -> Option<Vec<u8>> {
        let key = format!("{}{}", BLOB_KEY_PREFIX, Self::hash_to_hex(hash));
        self.host.storage_get(&key).await.ok().flatten()
    }

    /// Get a blob's metadata
    pub async fn get_meta(&self, hash: &Hash) -> Option<BlobMeta> {
        let key = format!("{}{}", BLOB_META_PREFIX, Self::hash_to_hex(hash));
        let data = self.host.storage_get(&key).await.ok().flatten()?;
        bincode::deserialize(&data).ok()
    }

    /// Store a blob (verifies hash)
    pub async fn put(&self, data: &[u8]) -> Result<Hash, CoreError> {
        self.put_with_mime(data, None).await
    }

    /// Store a blob with MIME type
    pub async fn put_with_mime(
        &self,
        data: &[u8],
        mime_type: Option<String>,
    ) -> Result<Hash, CoreError> {
        let hash = Self::hash(data);
        let hex_hash = Self::hash_to_hex(&hash);

        // Store the blob data
        let blob_key = format!("{}{}", BLOB_KEY_PREFIX, hex_hash);
        self.host.storage_set(&blob_key, data).await
            .map_err(CoreError::from)?;

        // Store metadata
        let meta = BlobMeta {
            hash,
            size: data.len() as u64,
            mime_type,
            stored_at: self.host.now_millis(),
        };
        let meta_key = format!("{}{}", BLOB_META_PREFIX, hex_hash);
        let meta_bytes = bincode::serialize(&meta)
            .map_err(|e| CoreError::Internal(format!("serialize meta: {}", e)))?;
        self.host.storage_set(&meta_key, &meta_bytes).await
            .map_err(CoreError::from)?;

        Ok(hash)
    }

    /// Store a blob with pre-computed hash (for receiving from peers)
    /// Returns error if hash doesn't match
    pub async fn put_verified(
        &self,
        data: &[u8],
        expected_hash: &Hash,
        mime_type: Option<String>,
    ) -> Result<(), CoreError> {
        let actual_hash = Self::hash(data);
        if actual_hash != *expected_hash {
            return Err(CoreError::Internal(format!(
                "blob hash mismatch: expected {}, got {}",
                expected_hash,
                actual_hash
            )));
        }

        let hex_hash = Self::hash_to_hex(expected_hash);

        // Store the blob data
        let blob_key = format!("{}{}", BLOB_KEY_PREFIX, hex_hash);
        self.host.storage_set(&blob_key, data).await
            .map_err(CoreError::from)?;

        // Store metadata
        let meta = BlobMeta {
            hash: *expected_hash,
            size: data.len() as u64,
            mime_type,
            stored_at: self.host.now_millis(),
        };
        let meta_key = format!("{}{}", BLOB_META_PREFIX, hex_hash);
        let meta_bytes = bincode::serialize(&meta)
            .map_err(|e| CoreError::Internal(format!("serialize meta: {}", e)))?;
        self.host.storage_set(&meta_key, &meta_bytes).await
            .map_err(CoreError::from)?;

        Ok(())
    }

    /// Delete a blob
    pub async fn delete(&self, hash: &Hash) -> Result<(), CoreError> {
        let hex_hash = Self::hash_to_hex(hash);
        let blob_key = format!("{}{}", BLOB_KEY_PREFIX, hex_hash);
        let meta_key = format!("{}{}", BLOB_META_PREFIX, hex_hash);

        self.host.storage_delete(&blob_key).await.map_err(CoreError::from)?;
        self.host.storage_delete(&meta_key).await.map_err(CoreError::from)?;

        Ok(())
    }

    /// Verify data matches expected hash
    pub fn verify(data: &[u8], expected: &Hash) -> bool {
        Self::hash(data) == *expected
    }

    /// List all blob hashes we have
    pub async fn list_hashes(&self) -> Result<Vec<Hash>, CoreError> {
        let keys = self.host.storage_list(BLOB_KEY_PREFIX).await
            .map_err(CoreError::from)?;

        let mut hashes = Vec::new();
        for key in keys {
            if let Some(hex_hash) = key.strip_prefix(BLOB_KEY_PREFIX) {
                if let Ok(hash) = Self::hex_to_hash(hex_hash) {
                    hashes.push(hash);
                }
            }
        }
        Ok(hashes)
    }

    /// List all blobs with metadata
    pub async fn list(&self) -> Result<Vec<BlobMeta>, CoreError> {
        let hashes = self.list_hashes().await?;
        let mut metas = Vec::with_capacity(hashes.len());
        for hash in hashes {
            if let Some(meta) = self.get_meta(&hash).await {
                metas.push(meta);
            }
        }
        Ok(metas)
    }

    /// Get total size of all blobs
    pub async fn total_size(&self) -> Result<u64, CoreError> {
        let metas = self.list().await?;
        Ok(metas.iter().map(|m| m.size).sum())
    }

    /// Find blobs we have that peer doesn't (based on their hash list)
    pub async fn find_missing_for_peer(&self, peer_hashes: &[Hash]) -> Result<Vec<Hash>, CoreError> {
        let our_hashes = self.list_hashes().await?;

        // Build a set of peer hashes for fast lookup
        let peer_set: std::collections::HashSet<Hash> = peer_hashes.iter().copied().collect();

        Ok(our_hashes.into_iter().filter(|h| !peer_set.contains(h)).collect())
    }

    /// Find blobs peer has that we don't
    pub async fn find_needed_from_peer(&self, peer_hashes: &[Hash]) -> Result<Vec<Hash>, CoreError> {
        let our_hashes = self.list_hashes().await?;
        let our_set: std::collections::HashSet<Hash> = our_hashes.into_iter().collect();

        Ok(peer_hashes.iter().filter(|h| !our_set.contains(*h)).copied().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::mock::MockHost;

    #[tokio::test]
    async fn test_put_get() {
        let host = Arc::new(MockHost::new());
        let store = BlobStore::new(host).unwrap();

        let data = b"Hello, World!";
        let hash = store.put(data).await.unwrap();

        // Should be able to retrieve
        let retrieved = store.get(&hash).await.unwrap();
        assert_eq!(&retrieved, data);

        // Hash should match
        assert!(store.has(&hash).await);
    }

    #[tokio::test]
    async fn test_verify() {
        let data = b"test data";
        let hash = BlobStore::hash(data);
        assert!(BlobStore::verify(data, &hash));

        let wrong_data = b"wrong data";
        assert!(!BlobStore::verify(wrong_data, &hash));
    }

    #[tokio::test]
    async fn test_put_verified() {
        let host = Arc::new(MockHost::new());
        let store = BlobStore::new(host).unwrap();

        let data = b"verified data";
        let hash = BlobStore::hash(data);

        // Should succeed with correct hash
        store.put_verified(data, &hash, None).await.unwrap();

        // Should fail with wrong hash
        let wrong_hash: Hash = "0000000000000000000000000000000000000000000000000000000000000000".parse().unwrap();
        let result = store.put_verified(data, &wrong_hash, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_hashes() {
        let host = Arc::new(MockHost::new());
        let store = BlobStore::new(host).unwrap();

        let hash1 = store.put(b"data1").await.unwrap();
        let hash2 = store.put(b"data2").await.unwrap();
        let hash3 = store.put(b"data3").await.unwrap();

        let hashes = store.list_hashes().await.unwrap();
        assert_eq!(hashes.len(), 3);
        assert!(hashes.contains(&hash1));
        assert!(hashes.contains(&hash2));
        assert!(hashes.contains(&hash3));
    }

    #[test]
    fn test_hash_hex_roundtrip() {
        let data = b"test";
        let hash = BlobStore::hash(data);
        let hex = BlobStore::hash_to_hex(&hash);
        let parsed = BlobStore::hex_to_hash(&hex).unwrap();
        assert_eq!(hash, parsed);
    }
}
