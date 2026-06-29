//! Cloud Sync - Main sync flow for S3-compatible cloud storage
//!
//! Implements:
//! - Delta upload/download with encryption
//! - Snapshot compaction
//! - Blob sync (content-addressed)
//! - Retry logic with exponential backoff

#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::cloud::{
    CloudConfig, CloudMeta, DeltaInfo, BlobInfo,
    CloudSyncState, CloudSyncResult, SyncPhase,
    CloudEncryption, S3Client, S3Error,
};
use crate::error::CoreError;

/// Trait for document stores that can sync with cloud
///
/// Implemented by both SyncEngine (for native) and LoroStore (for WASM)
pub trait CloudSyncable {
    /// Get the vault ID
    fn vault_id(&self) -> &[u8; 32];

    /// Get the version vector (for sync comparison)
    fn version_vector(&self) -> Vec<u8>;

    /// Export updates since a version
    fn export_updates_since(&self, since: &[u8]) -> Result<Vec<u8>, CoreError>;

    /// Import updates
    fn import_updates(&self, data: &[u8]) -> Result<(), CoreError>;

    /// Export full snapshot
    fn export_snapshot(&self) -> Result<Vec<u8>, CoreError>;
}

// Implement CloudSyncable for SyncEngine
impl CloudSyncable for crate::sync::SyncEngine {
    fn vault_id(&self) -> &[u8; 32] {
        self.vault_id()
    }

    fn version_vector(&self) -> Vec<u8> {
        self.version_vector()
    }

    fn export_updates_since(&self, since: &[u8]) -> Result<Vec<u8>, CoreError> {
        self.export_updates_since(since)
    }

    fn import_updates(&self, data: &[u8]) -> Result<(), CoreError> {
        self.import_updates(data)
    }

    fn export_snapshot(&self) -> Result<Vec<u8>, CoreError> {
        self.export_snapshot()
    }
}

// Implement CloudSyncable for LoroStore (for WASM use)
impl CloudSyncable for crate::store::LoroStore {
    fn vault_id(&self) -> &[u8; 32] {
        <crate::store::LoroStore as crate::store::DocStore>::vault_id(self)
    }

    fn version_vector(&self) -> Vec<u8> {
        <crate::store::LoroStore as crate::store::DocStore>::version_vector(self)
    }

    fn export_updates_since(&self, since: &[u8]) -> Result<Vec<u8>, CoreError> {
        <crate::store::LoroStore as crate::store::DocStore>::export_updates(self, Some(since))
            .map_err(CoreError::Store)
    }

    fn import_updates(&self, data: &[u8]) -> Result<(), CoreError> {
        <crate::store::LoroStore as crate::store::DocStore>::import_updates(self, data)
            .map_err(CoreError::Store)
    }

    fn export_snapshot(&self) -> Result<Vec<u8>, CoreError> {
        <crate::store::LoroStore as crate::store::DocStore>::export_snapshot(self)
            .map_err(CoreError::Store)
    }
}

/// Maximum retries for transient errors
const MAX_RETRIES: u32 = 3;

/// Base delay for exponential backoff
const BASE_DELAY_MS: u64 = 1000;

/// Max delay cap
const MAX_DELAY_MS: u64 = 30_000;

/// Delta count threshold for compaction
const COMPACT_THRESHOLD: u32 = 50;

/// Cloud sync service
pub struct CloudSync {
    config: CloudConfig,
    s3: S3Client,
    encryption: CloudEncryption,
    state: CloudSyncState,
    /// Snapshot version we have already downloaded and imported this session,
    /// so we don't re-download the (potentially large) snapshot every sync.
    applied_snapshot_version: Option<String>,
}

impl CloudSync {
    /// Create a new cloud sync instance
    pub fn new(config: CloudConfig, vault_key: &[u8; 32]) -> Result<Self, CloudSyncError> {
        let s3 = S3Client::new(config.clone())
            .map_err(|e| CloudSyncError::S3(e.to_string()))?;

        let encryption = CloudEncryption::new(vault_key);

        Ok(Self {
            config,
            s3,
            encryption,
            state: CloudSyncState::default(),
            applied_snapshot_version: None,
        })
    }

    /// Get current sync state
    pub fn state(&self) -> &CloudSyncState {
        &self.state
    }

    /// Perform a full sync cycle
    pub async fn sync<E: CloudSyncable>(&mut self, engine: &E) -> Result<CloudSyncResult, CloudSyncError> {
        let mut result = CloudSyncResult::default();

        self.state.phase = SyncPhase::Preparing;
        self.state.error = None;

        // Step 1: Fetch or create cloud metadata
        let mut meta = self.fetch_or_create_meta(engine).await?;

        // Step 1b: Download and import the base snapshot if one exists and we
        // haven't applied it yet. Without this, a fresh device (or one that synced
        // before a compaction) would only fetch post-compaction deltas and end up
        // with an incomplete vault.
        if let Some(version) = meta.snapshot_version.clone() {
            if self.applied_snapshot_version.as_deref() != Some(version.as_str()) {
                self.state.phase = SyncPhase::Downloading;
                match self.s3.get_object("state.enc").await {
                    Ok(encrypted) => {
                        let snapshot = self.encryption.decrypt(&encrypted)
                            .map_err(|e| CloudSyncError::Encryption(e.to_string()))?;
                        // Loro's import auto-detects snapshot vs update payloads.
                        engine.import_updates(&snapshot)?;
                        result.bytes_downloaded += encrypted.len() as u64;
                        self.applied_snapshot_version = Some(version);
                    }
                    Err(S3Error::NotFound(_)) => {
                        warn!("meta references snapshot {} but state.enc is missing", version);
                    }
                    Err(e) => return Err(CloudSyncError::S3(e.to_string())),
                }
            }
        }

        // Step 2: Download any remote deltas we don't have
        self.state.phase = SyncPhase::Downloading;
        let download_result = self.download_deltas(engine, &meta).await?;
        result.deltas_downloaded = download_result.count;
        result.bytes_downloaded += download_result.bytes;

        // Step 3: Upload local changes as deltas
        self.state.phase = SyncPhase::Uploading;
        let upload_result = self.upload_delta(engine, &mut meta).await?;
        result.deltas_uploaded = upload_result.count;
        result.bytes_uploaded += upload_result.bytes;

        // Step 4: Check if compaction is needed
        if meta.delta_count >= COMPACT_THRESHOLD {
            self.state.phase = SyncPhase::Compacting;
            self.compact(engine, &mut meta).await?;
            result.compacted = true;
        }

        // Step 5: Update metadata
        self.state.phase = SyncPhase::Finalizing;
        meta.last_sync = Some(iso_now());
        self.upload_meta(&meta).await?;

        self.state.phase = SyncPhase::Idle;
        self.state.last_synced_at = meta.last_sync.clone();
        self.state.pending_uploads = 0;
        self.state.pending_downloads = 0;

        info!(
            "Cloud sync complete: {} deltas up, {} down, {} bytes transferred",
            result.deltas_uploaded,
            result.deltas_downloaded,
            result.bytes_uploaded + result.bytes_downloaded
        );

        Ok(result)
    }

    /// Upload a blob (content-addressed)
    pub async fn upload_blob(&mut self, data: &[u8], mime_type: Option<&str>) -> Result<String, CloudSyncError> {
        use sha2::{Sha256, Digest};

        let hash = hex::encode(Sha256::digest(data));
        let key = format!("blobs/{}.enc", hash);

        // Check if blob already exists
        match self.s3.head_object(&key).await {
            Ok(Some(_)) => {
                debug!("Blob {} already exists", hash);
                return Ok(hash);
            }
            Ok(None) => {}
            Err(e) if !matches!(e, S3Error::NotFound(_)) => {
                return Err(CloudSyncError::S3(e.to_string()));
            }
            _ => {}
        }

        // Encrypt and upload
        let encrypted = self.encryption.encrypt(data)
            .map_err(|e| CloudSyncError::Encryption(e.to_string()))?;

        self.with_retry(|| async {
            self.s3.put_object(&key, encrypted.clone(), Some("application/octet-stream")).await
        }).await?;

        // Update blob index
        let blob_info = BlobInfo {
            hash: hash.clone(),
            size: data.len(),
            mime_type: mime_type.map(String::from),
            uploaded_at: iso_now(),
        };
        self.update_blob_index(&blob_info).await?;

        info!("Uploaded blob {} ({} bytes)", hash, data.len());
        Ok(hash)
    }

    /// Download a blob by hash
    pub async fn download_blob(&mut self, hash: &str) -> Result<Vec<u8>, CloudSyncError> {
        let key = format!("blobs/{}.enc", hash);

        let encrypted = self.with_retry(|| async {
            self.s3.get_object(&key).await
        }).await?;

        let decrypted = self.encryption.decrypt(&encrypted)
            .map_err(|e| CloudSyncError::Encryption(e.to_string()))?;

        // Verify hash
        use sha2::{Sha256, Digest};
        let computed_hash = hex::encode(Sha256::digest(&decrypted));
        if computed_hash != hash {
            return Err(CloudSyncError::Corruption(format!(
                "Blob hash mismatch: expected {}, got {}",
                hash, computed_hash
            )));
        }

        debug!("Downloaded blob {} ({} bytes)", hash, decrypted.len());
        Ok(decrypted)
    }

    /// Fetch cloud metadata or create new
    async fn fetch_or_create_meta<E: CloudSyncable>(&self, engine: &E) -> Result<CloudMeta, CloudSyncError> {
        match self.s3.get_object("meta.json").await {
            Ok(data) => {
                let meta: CloudMeta = serde_json::from_slice(&data)
                    .map_err(|e| CloudSyncError::Corruption(format!("Invalid meta.json: {}", e)))?;

                // Verify vault ID
                let vault_id = hex::encode(engine.vault_id());
                if meta.vault_id != vault_id {
                    return Err(CloudSyncError::VaultMismatch {
                        expected: vault_id,
                        found: meta.vault_id,
                    });
                }

                Ok(meta)
            }
            Err(S3Error::NotFound(_)) => {
                // Create new metadata
                Ok(CloudMeta::new(*engine.vault_id()))
            }
            Err(e) => Err(CloudSyncError::S3(e.to_string())),
        }
    }

    /// Upload metadata
    async fn upload_meta(&self, meta: &CloudMeta) -> Result<(), CloudSyncError> {
        let data = serde_json::to_vec_pretty(meta)
            .map_err(|e| CloudSyncError::Corruption(format!("Serialize meta: {}", e)))?;

        self.s3.put_object("meta.json", data, Some("application/json")).await
            .map_err(|e| CloudSyncError::S3(e.to_string()))
    }

    /// Download remote deltas
    async fn download_deltas<E: CloudSyncable>(&mut self, engine: &E, meta: &CloudMeta) -> Result<TransferStats, CloudSyncError> {
        let mut stats = TransferStats::default();

        // List all deltas
        let objects = self.s3.list_objects("deltas/").await
            .map_err(|e| CloudSyncError::S3(e.to_string()))?;

        self.state.pending_downloads = objects.len();

        for obj in objects {
            // Skip if we've already applied this delta
            // (In a real impl, we'd track applied deltas)

            let encrypted = self.with_retry(|| async {
                // obj.key already includes the "deltas/" sub-prefix (list_objects
                // only strips the configured path_prefix), so use it as-is.
                self.s3.get_object(&obj.key).await
            }).await?;

            let delta_data = self.encryption.decrypt(&encrypted)
                .map_err(|e| CloudSyncError::Encryption(e.to_string()))?;

            // Import delta into sync engine
            engine.import_updates(&delta_data)?;

            stats.count += 1;
            stats.bytes += encrypted.len() as u64;
            self.state.pending_downloads = self.state.pending_downloads.saturating_sub(1);

            debug!("Applied delta {} ({} bytes)", obj.key, delta_data.len());
        }

        Ok(stats)
    }

    /// Upload local changes as a delta
    async fn upload_delta<E: CloudSyncable>(&mut self, engine: &E, meta: &mut CloudMeta) -> Result<TransferStats, CloudSyncError> {
        let mut stats = TransferStats::default();

        // Export updates since last snapshot version
        let since_version = meta.snapshot_version.as_ref()
            .and_then(|v| hex::decode(v).ok())
            .unwrap_or_default();

        let delta_data = engine.export_updates_since(&since_version)?;

        if delta_data.is_empty() {
            debug!("No local changes to upload");
            return Ok(stats);
        }

        // Generate delta ID and encrypt
        let delta_id = DeltaInfo::generate_id(&delta_data);
        let encrypted = self.encryption.encrypt(&delta_data)
            .map_err(|e| CloudSyncError::Encryption(e.to_string()))?;

        let key = format!("deltas/{}.enc", delta_id);

        self.with_retry(|| async {
            self.s3.put_object(&key, encrypted.clone(), Some("application/octet-stream")).await
        }).await?;

        stats.count = 1;
        stats.bytes = encrypted.len() as u64;
        meta.delta_count += 1;

        info!("Uploaded delta {} ({} bytes)", delta_id, delta_data.len());
        Ok(stats)
    }

    /// Compact deltas into a snapshot
    async fn compact<E: CloudSyncable>(&mut self, engine: &E, meta: &mut CloudMeta) -> Result<(), CloudSyncError> {
        info!("Compacting {} deltas into snapshot", meta.delta_count);

        // Snapshot the delta set BEFORE exporting, then delete ONLY those keys.
        // compact() runs after download_deltas in the same sync, so every delta
        // listed here is already imported into the engine (and thus captured by the
        // snapshot). Deltas uploaded concurrently after this point are excluded from
        // the deletion list and survive for the next sync — avoiding silent loss of
        // a concurrent uploader's changes.
        let to_delete = self.s3.list_objects("deltas/").await
            .map_err(|e| CloudSyncError::S3(e.to_string()))?;

        // Export full snapshot
        let snapshot = engine.export_snapshot()?;
        let encrypted = self.encryption.encrypt(&snapshot)
            .map_err(|e| CloudSyncError::Encryption(e.to_string()))?;

        // Upload snapshot
        self.with_retry(|| async {
            self.s3.put_object("state.enc", encrypted.clone(), Some("application/octet-stream")).await
        }).await?;

        // Delete only the deltas captured above.
        for obj in to_delete {
            // obj.key already includes the "deltas/" sub-prefix.
            let _ = self.s3.delete_object(&obj.key).await;
        }

        // Update metadata
        meta.last_snapshot = Some(iso_now());
        meta.snapshot_version = Some(hex::encode(engine.version_vector()));
        meta.delta_count = 0;

        info!("Compaction complete ({} bytes)", snapshot.len());
        Ok(())
    }

    /// Update blob index
    async fn update_blob_index(&self, blob: &BlobInfo) -> Result<(), CloudSyncError> {
        // Fetch existing index or create new. The index is encrypted at rest so the
        // storage provider cannot read blob hashes, sizes or MIME types. A corrupt
        // index is treated as a hard error rather than silently overwritten (which
        // would discard every prior entry).
        let mut index: Vec<BlobInfo> = match self.s3.get_object("blob-index.json").await {
            Ok(encrypted) => {
                let data = self.encryption.decrypt(&encrypted)
                    .map_err(|e| CloudSyncError::Encryption(e.to_string()))?;
                serde_json::from_slice(&data)
                    .map_err(|e| CloudSyncError::Corruption(format!("Invalid blob-index.json: {}", e)))?
            }
            Err(S3Error::NotFound(_)) => Vec::new(),
            Err(e) => return Err(CloudSyncError::S3(e.to_string())),
        };

        // Add blob if not already present
        if !index.iter().any(|b| b.hash == blob.hash) {
            index.push(blob.clone());

            let data = serde_json::to_vec(&index)
                .map_err(|e| CloudSyncError::Corruption(format!("Serialize blob index: {}", e)))?;
            let encrypted = self.encryption.encrypt(&data)
                .map_err(|e| CloudSyncError::Encryption(e.to_string()))?;

            self.s3.put_object("blob-index.json", encrypted, Some("application/octet-stream")).await
                .map_err(|e| CloudSyncError::S3(e.to_string()))?;
        }

        Ok(())
    }

    /// Retry with exponential backoff
    async fn with_retry<F, Fut, T>(&self, mut f: F) -> Result<T, CloudSyncError>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T, S3Error>>,
    {
        let mut attempt = 0;
        let mut delay = BASE_DELAY_MS;

        loop {
            match f().await {
                Ok(result) => return Ok(result),
                Err(e) => {
                    attempt += 1;

                    if attempt >= MAX_RETRIES || !self.s3.is_retryable(&e) {
                        return Err(CloudSyncError::S3(e.to_string()));
                    }

                    warn!("S3 error (attempt {}): {}, retrying in {}ms", attempt, e, delay);

                    // tokio's timer reactor isn't available on wasm32, where calling
                    // tokio::time::sleep panics. Only sleep on native; on wasm retry
                    // immediately (still bounded by MAX_RETRIES).
                    #[cfg(not(target_arch = "wasm32"))]
                    tokio::time::sleep(Duration::from_millis(delay)).await;

                    delay = (delay * 2).min(MAX_DELAY_MS);
                }
            }
        }
    }
}

/// Transfer statistics
#[derive(Debug, Default)]
struct TransferStats {
    count: usize,
    bytes: u64,
}

/// Get current time as ISO 8601 string
fn iso_now() -> String {
    use web_time::SystemTime;

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Simple ISO 8601 formatting
    let secs_per_day = 86400u64;
    let secs_per_hour = 3600u64;
    let secs_per_min = 60u64;

    let days = now / secs_per_day;
    let remaining = now % secs_per_day;
    let hours = remaining / secs_per_hour;
    let remaining = remaining % secs_per_hour;
    let mins = remaining / secs_per_min;
    let secs = remaining % secs_per_min;

    let (year, month, day) = days_to_ymd(days);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, mins, secs
    )
}

/// Convert days since epoch to year/month/day
fn days_to_ymd(days: u64) -> (u32, u32, u32) {
    let mut remaining = days as i64;
    let mut year = 1970i32;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let days_in_months: [i64; 12] = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u32;
    for days_in_month in days_in_months {
        if remaining < days_in_month {
            break;
        }
        remaining -= days_in_month;
        month += 1;
    }

    (year as u32, month, remaining as u32 + 1)
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Cloud sync errors
#[derive(Debug, Clone, thiserror::Error)]
pub enum CloudSyncError {
    #[error("S3 error: {0}")]
    S3(String),

    #[error("Encryption error: {0}")]
    Encryption(String),

    #[error("Data corruption: {0}")]
    Corruption(String),

    #[error("Vault ID mismatch: expected {expected}, found {found}")]
    VaultMismatch { expected: String, found: String },

    #[error("CRDT error: {0}")]
    Crdt(String),
}

impl From<crate::error::CoreError> for CloudSyncError {
    fn from(e: crate::error::CoreError) -> Self {
        CloudSyncError::Crdt(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_iso_now() {
        let iso = iso_now();
        // Should be in format YYYY-MM-DDTHH:MM:SSZ
        assert!(iso.len() == 20);
        assert!(iso.ends_with('Z'));
        assert!(iso.contains('T'));
    }

    #[test]
    fn test_days_to_ymd() {
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        assert_eq!(days_to_ymd(365), (1971, 1, 1));
        // 1704067200 seconds / 86400 = 19723 days since epoch
        assert_eq!(days_to_ymd(19723), (2024, 1, 1));
    }
}
