//! Basic WASM-compatible tests
//!
//! These test core logic that runs in both native and WASM.
//! For full WASM integration tests, use `wasm-pack test --node`.

use std::sync::Arc;

use peervault_core::crypto::VaultKey;
use peervault_core::error::CoreError;
use peervault_core::host::mock::MockHost;
use peervault_core::sync::SyncEngine;
use peervault_core::protocol::sync::{Message, VersionInfo, Updates, SyncComplete, PROTOCOL_VERSION};

/// Test that the V3 protocol messages encode/decode correctly
#[test]
fn test_v3_protocol_roundtrip() {
    let vi = VersionInfo {
        protocol_version: PROTOCOL_VERSION,
        vault_id: [42u8; 32],
        version_bytes: vec![1, 2, 3],
        hostname: "TestDevice".into(),
        nickname: Some("MyDevice".into()),
        has_vault_key: true,
        plugin_version: Some("0.3.0".into()),
        pairing_nonce: Some("nonce123".into()),
        supports_iroh_blobs: true,
    };

    let msg = Message::VersionInfo(vi);
    let encoded = msg.encode().unwrap();
    let decoded = Message::decode(&encoded).unwrap();

    match decoded {
        Message::VersionInfo(v) => {
            assert_eq!(v.protocol_version, PROTOCOL_VERSION);
            assert_eq!(v.vault_id, [42u8; 32]);
            assert!(v.supports_iroh_blobs);
            assert_eq!(v.pairing_nonce, Some("nonce123".into()));
            assert_eq!(v.hostname, "TestDevice");
        }
        _ => panic!("Expected VersionInfo"),
    }
}

/// Test that protocol version is 3
#[test]
fn test_protocol_version_is_v3() {
    assert_eq!(PROTOCOL_VERSION, 3);
}

/// Test SyncComplete roundtrip
#[test]
fn test_sync_complete_roundtrip() {
    let msg = Message::SyncComplete(SyncComplete {
        version_bytes: vec![10, 20, 30],
    });
    let encoded = msg.encode().unwrap();
    let decoded = Message::decode(&encoded).unwrap();

    match decoded {
        Message::SyncComplete(sc) => {
            assert_eq!(sc.version_bytes, vec![10, 20, 30]);
        }
        _ => panic!("Expected SyncComplete"),
    }
}

/// Test encrypted sync between two engines (same vault key)
#[test]
fn test_encrypted_delta_sync() {
    let key = VaultKey::generate();
    let host1 = Arc::new(MockHost::new());
    let host2 = Arc::new(MockHost::new());

    let mut e1 = SyncEngine::new_with_key(host1, key.clone()).unwrap();
    let mut e2 = SyncEngine::new_with_key(host2, key).unwrap();

    let vid = [99u8; 32];
    e1.init_vault(vid);
    e2.init_vault(vid);

    // Sync baseline
    let snap = e1.export_snapshot_raw().unwrap();
    e2.import_snapshot_raw(&snap).unwrap();

    // Engine 1 makes changes
    e1.set("file1.md", "content one").unwrap();
    e1.set("file2.md", "content two").unwrap();

    // Export encrypted delta
    let vv2 = e2.version_vector();
    let encrypted_delta = e1.export_updates_since(&vv2).unwrap();
    assert!(!encrypted_delta.is_empty());

    // Import encrypted delta (decrypts internally)
    e2.import_updates(&encrypted_delta).unwrap();

    assert_eq!(e2.get("file1.md").unwrap(), "content one");
    assert_eq!(e2.get("file2.md").unwrap(), "content two");
}

/// Test that wrong key fails decryption
#[test]
fn test_wrong_key_fails() {
    let key1 = VaultKey::generate();
    let key2 = VaultKey::generate();
    let host1 = Arc::new(MockHost::new());
    let host2 = Arc::new(MockHost::new());

    let mut e1 = SyncEngine::new_with_key(host1, key1).unwrap();
    let mut e2 = SyncEngine::new_with_key(host2, key2).unwrap();

    let vid = [77u8; 32];
    e1.init_vault(vid);
    e2.init_vault(vid);

    e1.set("secret.md", "top secret").unwrap();

    let encrypted = e1.export_snapshot().unwrap();
    let result = e2.import_snapshot(&encrypted);
    assert!(result.is_err());
}

/// Test DeltaTooLarge error variant
#[test]
fn test_delta_too_large_error() {
    let err = CoreError::DeltaTooLarge { size: 100000, max: 65536 };
    let msg = format!("{}", err);
    assert!(msg.contains("100000"));
    assert!(msg.contains("65536"));
}

/// Test BlobOps with NoBlobOps
#[test]
fn test_no_blob_ops() {
    use peervault_core::runner::{BlobOps, NoBlobOps};

    let mut noop = NoBlobOps;
    assert!(noop.list_hashes().is_empty());
    assert!(noop.get(&iroh_blobs::Hash::new(b"test")).is_none());
    assert!(noop.store(&iroh_blobs::Hash::new(b"test"), b"data").is_ok());
}
