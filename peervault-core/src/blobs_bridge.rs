//! Blobs Bridge - Bridges iroh-blobs MemStore with HostInterface persistence
//!
//! iroh-blobs MemStore is ephemeral (in-memory only, required for WASM).
//! HostInterface provides persistent key-value storage (Obsidian plugin data).
//!
//! This bridge:
//! - Hydrates specific blobs from HostInterface into MemStore on demand
//! - Persists newly received blobs from MemStore back to HostInterface
//! - Provides accessors for BlobsProtocol and Downloader integration

use iroh::Endpoint;
use iroh_blobs::api::downloader::Downloader;
use iroh_blobs::store::mem::MemStore;
use iroh_blobs::Hash;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::blob::BlobStore;
use crate::error::CoreError;
use crate::host::HostInterface;

/// Bridge between iroh-blobs in-memory store and persistent HostInterface storage
pub struct BlobsBridge {
    /// iroh-blobs in-memory store (used for transfer protocol)
    mem: MemStore,
    /// Persistent storage via HostInterface
    blob_store: BlobStore,
}

impl BlobsBridge {
    /// Create a new bridge with a fresh MemStore
    pub fn new(host: Arc<dyn HostInterface>) -> Result<Self, CoreError> {
        let mem = MemStore::new();
        let blob_store = BlobStore::new(host)?;
        Ok(Self { mem, blob_store })
    }

    /// Get the MemStore (for BlobsProtocol and Downloader)
    pub fn mem_store(&self) -> &MemStore {
        &self.mem
    }

    /// List all blob hashes in persistent storage
    pub async fn list_host_hashes(&self) -> Result<Vec<Hash>, CoreError> {
        self.blob_store.list_hashes().await
    }

    /// Check if a blob exists in persistent storage
    pub async fn has_in_host(&self, hash: &Hash) -> bool {
        self.blob_store.has(hash).await
    }

    /// Load specific blobs from HostInterface into MemStore
    /// (called before sync to make our blobs available for serving)
    pub async fn hydrate_hashes(&self, hashes: &[Hash]) -> Result<usize, CoreError> {
        let mut count = 0;
        for hash in hashes {
            // Skip if already in MemStore
            if self.mem.has(*hash).await.unwrap_or(false) {
                continue;
            }

            // Load from persistent storage
            if let Some(data) = self.blob_store.get(hash).await {
                self.mem.add_slice(&data).await
                    .map_err(|e| CoreError::Internal(format!("MemStore add failed: {}", e)))?;
                count += 1;
            }
        }
        Ok(count)
    }

    /// Persist a blob from MemStore to HostInterface
    /// (called after receiving a blob via iroh-blobs transfer)
    pub async fn persist_blob(&self, hash: &Hash) -> Result<(), CoreError> {
        // Skip if already persisted
        if self.blob_store.has(hash).await {
            return Ok(());
        }

        // Read from MemStore
        let data = self.mem.get_bytes(*hash).await
            .map_err(|e| CoreError::Internal(format!("MemStore get failed: {}", e)))?;

        // Write to persistent storage with hash verification
        self.blob_store.put_verified(&data, hash, None).await?;

        Ok(())
    }

    /// V3 blob exchange using iroh-blobs transfer protocol.
    ///
    /// 1. Hydrates blobs we're sending into MemStore (so BlobsProtocol serves them)
    /// 2. Downloads missing blobs from peer via iroh-blobs Downloader (Bao verified)
    /// 3. Persists downloaded blobs to HostInterface
    ///
    /// The peer's BlobsProtocol automatically serves requested blobs from their MemStore.
    pub async fn exchange_blobs_v3(
        &self,
        endpoint: &Endpoint,
        peer_id: iroh::EndpointId,
        need_from_peer: &[Hash],
        send_to_peer: &[Hash],
    ) -> Result<(usize, usize), CoreError> {
        // Step 1: Hydrate blobs we need to serve to peer
        if !send_to_peer.is_empty() {
            let hydrated = self.hydrate_hashes(send_to_peer).await?;
            info!("Hydrated {} blobs into MemStore for serving", hydrated);
        }

        // Step 2: Download missing blobs via iroh-blobs protocol
        let mut downloaded = 0;
        if !need_from_peer.is_empty() {
            info!("Downloading {} blobs via iroh-blobs from peer", need_from_peer.len());

            let downloader = Downloader::new(&self.mem, endpoint);
            let providers = vec![peer_id];

            for hash in need_from_peer {
                debug!("Downloading blob {}", hash.to_hex());
                match downloader.download(*hash, providers.clone()).await {
                    Ok(()) => {
                        // Persist to HostInterface
                        self.persist_blob(hash).await?;
                        downloaded += 1;
                    }
                    Err(e) => {
                        warn!("Failed to download blob {}: {}", hash.to_hex(), e);
                        return Err(CoreError::Internal(format!(
                            "iroh-blobs download failed for {}: {}",
                            hash.to_hex(), e
                        )));
                    }
                }
            }

            info!("Downloaded and persisted {} blobs", downloaded);
        }

        Ok((downloaded, send_to_peer.len()))
    }
}
