//! Cloud sync types and configuration

use serde::{Deserialize, Serialize};

/// S3-compatible storage configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudConfig {
    /// S3 endpoint URL (e.g., "https://s3.amazonaws.com" or "https://minio.example.com")
    pub endpoint: String,
    /// Bucket name
    pub bucket: String,
    /// AWS region (e.g., "us-east-1")
    pub region: String,
    /// Access key ID
    pub access_key_id: String,
    /// Secret access key
    pub secret_access_key: String,
    /// Path prefix within bucket (e.g., "backups/vault1")
    pub path_prefix: String,
}

impl CloudConfig {
    /// Create a new cloud configuration
    pub fn new(
        endpoint: impl Into<String>,
        bucket: impl Into<String>,
        region: impl Into<String>,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            bucket: bucket.into(),
            region: region.into(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            path_prefix: String::new(),
        }
    }

    /// Set path prefix
    pub fn with_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.path_prefix = prefix.into();
        self
    }

    /// Get the full path for an object
    pub fn object_path(&self, key: &str) -> String {
        if self.path_prefix.is_empty() {
            key.to_string()
        } else {
            format!("{}/{}", self.path_prefix.trim_end_matches('/'), key)
        }
    }
}

/// Cloud vault metadata (stored as meta.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudMeta {
    /// Schema version
    pub version: u32,
    /// Vault ID (hex)
    pub vault_id: String,
    /// Last snapshot timestamp (ISO 8601)
    pub last_snapshot: Option<String>,
    /// Loro version vector of snapshot (hex)
    pub snapshot_version: Option<String>,
    /// Number of deltas since last snapshot
    pub delta_count: u32,
    /// Last sync timestamp (ISO 8601)
    pub last_sync: Option<String>,
}

impl CloudMeta {
    /// Create new metadata for a vault
    pub fn new(vault_id: [u8; 32]) -> Self {
        Self {
            version: 1,
            vault_id: hex::encode(vault_id),
            last_snapshot: None,
            snapshot_version: None,
            delta_count: 0,
            last_sync: None,
        }
    }
}

/// Delta metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaInfo {
    /// Delta ID (timestamp-hash format)
    pub id: String,
    /// Timestamp (milliseconds since epoch)
    pub timestamp: u64,
    /// Content hash (first 16 hex chars of SHA-256)
    pub hash: String,
    /// Size in bytes (encrypted)
    pub size: usize,
}

impl DeltaInfo {
    /// Create delta info from ID and size
    pub fn from_id(id: &str, size: usize) -> Option<Self> {
        let parts: Vec<&str> = id.split('-').collect();
        if parts.len() != 2 {
            return None;
        }

        let timestamp: u64 = parts[0].parse().ok()?;
        let hash = parts[1].to_string();

        Some(Self {
            id: id.to_string(),
            timestamp,
            hash,
            size,
        })
    }

    /// Generate a delta ID from data
    pub fn generate_id(data: &[u8]) -> String {
        use sha2::{Sha256, Digest};

        let timestamp = web_time::SystemTime::now()
            .duration_since(web_time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut hasher = Sha256::new();
        hasher.update(data);
        let hash = hasher.finalize();
        let hash_hex = hex::encode(&hash[..8]); // First 16 hex chars

        format!("{}-{}", timestamp, hash_hex)
    }
}

/// Blob metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobInfo {
    /// Content hash (SHA-256, hex)
    pub hash: String,
    /// Size in bytes (plaintext)
    pub size: usize,
    /// MIME type (optional)
    pub mime_type: Option<String>,
    /// Upload timestamp (ISO 8601)
    pub uploaded_at: String,
}

/// Cloud sync state for progress reporting
#[derive(Debug, Clone, Default)]
pub struct CloudSyncState {
    /// Current phase
    pub phase: SyncPhase,
    /// Pending uploads count
    pub pending_uploads: usize,
    /// Pending downloads count
    pub pending_downloads: usize,
    /// Last successful sync (ISO 8601)
    pub last_synced_at: Option<String>,
    /// Current error message
    pub error: Option<String>,
}

/// Sync phase
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SyncPhase {
    #[default]
    Idle,
    Preparing,
    Downloading,
    Uploading,
    Compacting,
    Finalizing,
    Error,
}

/// Cloud sync result
#[derive(Debug, Clone, Default)]
pub struct CloudSyncResult {
    /// Number of deltas uploaded
    pub deltas_uploaded: usize,
    /// Number of deltas downloaded
    pub deltas_downloaded: usize,
    /// Number of blobs uploaded
    pub blobs_uploaded: usize,
    /// Number of blobs downloaded
    pub blobs_downloaded: usize,
    /// Bytes uploaded
    pub bytes_uploaded: u64,
    /// Bytes downloaded
    pub bytes_downloaded: u64,
    /// Whether compaction was performed
    pub compacted: bool,
    /// Errors encountered (non-fatal)
    pub errors: Vec<String>,
}

/// S3 error codes that are retryable
pub fn is_retryable_error(status: u16, error_code: Option<&str>) -> bool {
    // 5xx errors are retryable
    if status >= 500 {
        return true;
    }

    // 429 Too Many Requests
    if status == 429 {
        return true;
    }

    // Specific S3 error codes
    if let Some(code) = error_code {
        matches!(code,
            "SlowDown" |
            "ServiceUnavailable" |
            "InternalError" |
            "RequestTimeout" |
            "RequestTimeTooSkewed"
        )
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_delta_id_generation() {
        let data = b"test delta data";
        let id = DeltaInfo::generate_id(data);

        // Should be timestamp-hash format
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 2);

        // Timestamp should be parseable
        let _ts: u64 = parts[0].parse().unwrap();

        // Hash should be 16 hex chars
        assert_eq!(parts[1].len(), 16);
    }

    #[test]
    fn test_delta_info_from_id() {
        let id = "1704067200000-abcdef0123456789";
        let info = DeltaInfo::from_id(id, 1024).unwrap();

        assert_eq!(info.timestamp, 1704067200000);
        assert_eq!(info.hash, "abcdef0123456789");
        assert_eq!(info.size, 1024);
    }

    #[test]
    fn test_cloud_config_path() {
        let config = CloudConfig::new(
            "https://s3.amazonaws.com",
            "my-bucket",
            "us-east-1",
            "access-key",
            "secret-key",
        ).with_prefix("backups/vault1");

        assert_eq!(config.object_path("state.enc"), "backups/vault1/state.enc");
        assert_eq!(config.object_path("deltas/123.enc"), "backups/vault1/deltas/123.enc");
    }
}
