//! Integration tests for the S3-compatible cloud backend against a local MinIO.
//!
//! These exercise the AWS Signature V4 signing path end-to-end against a real
//! S3-compatible server — in particular `list_objects`, whose canonical request
//! was previously malformed and rejected with 403.
//!
//! Requires a running MinIO (see `just minio-start`). Gated behind the
//! `PEERVAULT_MINIO_TEST` env var so the suite is skipped when no server is
//! available (e.g. in CI without MinIO provisioned).

use std::sync::Mutex;

use peervault_core::cloud::{CloudConfig, CloudSync, CloudSyncable, S3Client};
use peervault_core::CoreError;

fn enabled() -> bool {
    std::env::var("PEERVAULT_MINIO_TEST").is_ok()
}

fn minio_config(prefix: &str) -> CloudConfig {
    CloudConfig::new(
        "http://127.0.0.1:9000",
        "peervault-test",
        "us-east-1",
        "minioadmin",
        "minioadmin",
    )
    .with_prefix(prefix)
}

/// Minimal in-memory engine so we can drive `CloudSync` without a real CRDT.
struct MockEngine {
    vault_id: [u8; 32],
    delta: Vec<u8>,
    imported: Mutex<Vec<Vec<u8>>>,
}

impl MockEngine {
    fn new(vault_id: [u8; 32], delta: &[u8]) -> Self {
        Self { vault_id, delta: delta.to_vec(), imported: Mutex::new(Vec::new()) }
    }
}

impl CloudSyncable for MockEngine {
    fn vault_id(&self) -> &[u8; 32] {
        &self.vault_id
    }
    fn version_vector(&self) -> Vec<u8> {
        Vec::new()
    }
    fn export_updates_since(&self, _since: &[u8]) -> Result<Vec<u8>, CoreError> {
        Ok(self.delta.clone())
    }
    fn import_updates(&self, data: &[u8]) -> Result<(), CoreError> {
        self.imported.lock().unwrap().push(data.to_vec());
        Ok(())
    }
    fn export_snapshot(&self) -> Result<Vec<u8>, CoreError> {
        Ok(self.delta.clone())
    }
}

#[tokio::test]
async fn s3_put_get_head_list_delete_roundtrip() {
    if !enabled() {
        eprintln!("skipping s3 roundtrip: set PEERVAULT_MINIO_TEST=1 with MinIO running");
        return;
    }
    let client = S3Client::new(minio_config("it-roundtrip")).expect("client");

    let body = b"hello peervault".to_vec();
    client
        .put_object("deltas/a.enc", body.clone(), Some("application/octet-stream"))
        .await
        .expect("put a");
    client
        .put_object("deltas/b.enc", b"second".to_vec(), Some("application/octet-stream"))
        .await
        .expect("put b");

    // GET round-trips the exact bytes.
    assert_eq!(client.get_object("deltas/a.enc").await.expect("get a"), body);

    // HEAD finds the object.
    assert!(client.head_object("deltas/a.enc").await.expect("head").is_some());

    // LIST — the previously-broken SigV4 path. Keys come back with the configured
    // path prefix stripped.
    let keys: Vec<String> = client
        .list_objects("deltas/")
        .await
        .expect("list")
        .into_iter()
        .map(|o| o.key)
        .collect();
    assert!(keys.iter().any(|k| k == "deltas/a.enc"), "list missing a: {keys:?}");
    assert!(keys.iter().any(|k| k == "deltas/b.enc"), "list missing b: {keys:?}");

    // DELETE removes them.
    client.delete_object("deltas/a.enc").await.expect("del a");
    client.delete_object("deltas/b.enc").await.expect("del b");
    let after = client.list_objects("deltas/").await.expect("list after");
    assert!(after.is_empty(), "expected empty after delete, got {after:?}");
}

#[tokio::test]
async fn cloudsync_delta_roundtrip_between_engines() {
    if !enabled() {
        eprintln!("skipping cloudsync roundtrip: set PEERVAULT_MINIO_TEST=1");
        return;
    }
    let vault_id = [7u8; 32];
    let key = [9u8; 32];
    let prefix = "it-cloudsync";

    // Engine A uploads a delta to the cloud.
    let a = MockEngine::new(vault_id, b"alpha-delta-payload");
    let mut sync_a = CloudSync::new(minio_config(prefix), &key).expect("sync a");
    sync_a.sync(&a).await.expect("A sync (upload)");

    // Engine B (sharing vault id + key) syncs and must download + import A's delta.
    // This drives download_deltas -> list_objects (the fixed SigV4 path) -> get -> decrypt.
    let b = MockEngine::new(vault_id, b"beta-local");
    let mut sync_b = CloudSync::new(minio_config(prefix), &key).expect("sync b");
    sync_b.sync(&b).await.expect("B sync (download)");

    let imported = b.imported.lock().unwrap();
    assert!(
        imported.iter().any(|d| d == b"alpha-delta-payload"),
        "B did not import A's delta via the cloud: {imported:?}"
    );
}

#[tokio::test]
async fn cloudsync_blob_roundtrip_with_encrypted_index() {
    if !enabled() {
        eprintln!("skipping blob roundtrip: set PEERVAULT_MINIO_TEST=1");
        return;
    }
    let key = [3u8; 32];
    let prefix = "it-blob";
    let mut sync = CloudSync::new(minio_config(prefix), &key).expect("sync");

    let data = b"binary-blob-content-1234567890".to_vec();
    let hash = sync.upload_blob(&data, Some("application/octet-stream")).await.expect("upload blob");

    // download_blob verifies the SHA-256 internally.
    assert_eq!(sync.download_blob(&hash).await.expect("download blob"), data);

    // The blob index must be encrypted at rest: not plaintext JSON, and it must not
    // leak the blob hash in cleartext.
    let raw = S3Client::new(minio_config(prefix))
        .expect("raw client")
        .get_object("blob-index.json")
        .await
        .expect("get blob-index");
    assert!(!raw.starts_with(b"["), "blob-index.json is plaintext JSON (should be encrypted)");
    assert!(
        !String::from_utf8_lossy(&raw).contains(&hash),
        "blob-index leaks the content hash in cleartext"
    );
}
