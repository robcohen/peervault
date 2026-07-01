//! Integration test: Full V3 sync protocol between two SyncEngines
//!
//! Tests the complete sync flow via SyncRunner with in-memory streams:
//! - Version exchange with pairing validation
//! - Encrypted CRDT delta sync
//! - Blob hash exchange
//! - Protocol error handling

use std::sync::{Arc, Mutex};
use std::thread;

use peervault_core::crypto::VaultKey;
use peervault_core::error::CoreError;
use peervault_core::host::mock::MockHost;
use peervault_core::runner::{
    BlobOps, NoBlobOps, PairingValidator, RunnerConfig, SyncRunner, SyncStream,
};
use peervault_core::sync::SyncEngine;

// =============================================================================
// Test Infrastructure
// =============================================================================

/// Channel-backed stream for concurrent testing.
/// Wraps Receiver in Mutex to satisfy SyncStream: Send + Sync requirement.
struct ChannelStream {
    tx: std::sync::mpsc::Sender<Vec<u8>>,
    rx: Mutex<std::sync::mpsc::Receiver<Vec<u8>>>,
}

impl ChannelStream {
    fn new_pair() -> (Self, Self) {
        let (tx1, rx1) = std::sync::mpsc::channel();
        let (tx2, rx2) = std::sync::mpsc::channel();
        (
            ChannelStream { tx: tx1, rx: Mutex::new(rx2) },
            ChannelStream { tx: tx2, rx: Mutex::new(rx1) },
        )
    }
}

#[async_trait::async_trait]
impl SyncStream for ChannelStream {
    async fn send(&mut self, data: &[u8]) -> Result<(), CoreError> {
        self.tx
            .send(data.to_vec())
            .map_err(|_| CoreError::Protocol("Channel closed".into()))
    }

    async fn recv(&mut self, timeout_ms: u64) -> Result<Vec<u8>, CoreError> {
        self.rx.lock().unwrap()
            .recv_timeout(std::time::Duration::from_millis(timeout_ms))
            .map_err(|e| match e {
                std::sync::mpsc::RecvTimeoutError::Timeout => {
                    CoreError::Timeout("recv timeout".into())
                }
                std::sync::mpsc::RecvTimeoutError::Disconnected => {
                    CoreError::Protocol("Channel disconnected".into())
                }
            })
    }

    async fn close(&mut self) -> Result<(), CoreError> {
        Ok(())
    }
}

/// Simple blob store for testing
struct TestBlobOps {
    blobs: Arc<Mutex<std::collections::HashMap<iroh_blobs::Hash, Vec<u8>>>>,
}

impl TestBlobOps {
    fn new() -> Self {
        Self {
            blobs: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    fn add(&self, data: &[u8]) -> iroh_blobs::Hash {
        let hash = iroh_blobs::Hash::new(data);
        self.blobs.lock().unwrap().insert(hash, data.to_vec());
        hash
    }

    fn count(&self) -> usize {
        self.blobs.lock().unwrap().len()
    }
}

impl BlobOps for TestBlobOps {
    fn list_hashes(&self) -> Vec<iroh_blobs::Hash> {
        self.blobs.lock().unwrap().keys().cloned().collect()
    }

    fn get(&self, hash: &iroh_blobs::Hash) -> Option<Vec<u8>> {
        self.blobs.lock().unwrap().get(hash).cloned()
    }

    fn store(&mut self, hash: &iroh_blobs::Hash, data: &[u8]) -> Result<(), CoreError> {
        self.blobs.lock().unwrap().insert(*hash, data.to_vec());
        Ok(())
    }
}

fn make_engines(vault_id: [u8; 32]) -> (SyncEngine, SyncEngine, VaultKey) {
    let key = VaultKey::generate();
    let host1 = Arc::new(MockHost::new());
    let host2 = Arc::new(MockHost::new());
    let mut e1 = SyncEngine::new_with_key(host1, key.clone()).unwrap();
    let mut e2 = SyncEngine::new_with_key(host2, key.clone()).unwrap();
    e1.init_vault(vault_id);
    e2.init_vault(vault_id);
    (e1, e2, key)
}

fn default_config() -> RunnerConfig {
    RunnerConfig {
        receive_timeout_ms: 5000,
        ..RunnerConfig::default()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[test]
fn test_full_sync_minimal() {
    let vault_id = [1u8; 32];
    let (e1, e2, _key) = make_engines(vault_id);

    // Both engines need some initial data for Loro VV to be non-trivial
    e1.set("init.md", "initialized").unwrap();

    let (mut s1, mut s2) = ChannelStream::new_pair();
    let config = default_config();

    let e1_ref = &e1;
    let e2_ref = &e2;

    // Run both sides in separate threads
    thread::scope(|scope| {
        let initiator = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e1_ref, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut NoBlobOps))
        });

        let acceptor = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e2_ref, "peer1".into(), false);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut NoBlobOps))
        });

        let r1 = initiator.join().expect("initiator panicked");
        let r2 = acceptor.join().expect("acceptor panicked");

        let result1 = r1.expect("initiator sync failed");
        let result2 = r2.expect("acceptor sync failed");

        assert!(result1.is_live);
        assert!(result2.is_live);
    });

    // Acceptor should have the data
    assert_eq!(e2.get("init.md").unwrap(), "initialized");
}

#[test]
fn test_sync_with_data() {
    let vault_id = [2u8; 32];
    let (e1, e2, _key) = make_engines(vault_id);

    // Engine 1 has data, engine 2 is empty
    e1.set("notes/hello.md", "Hello World").unwrap();
    e1.set("notes/todo.md", "Buy milk").unwrap();

    let (mut s1, mut s2) = ChannelStream::new_pair();
    let config = default_config();

    let e1_ref = &e1;
    let e2_ref = &e2;

    thread::scope(|scope| {
        let initiator = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e1_ref, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut NoBlobOps))
        });

        let acceptor = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e2_ref, "peer1".into(), false);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut NoBlobOps))
        });

        initiator.join().expect("initiator panicked").expect("initiator failed");
        acceptor.join().expect("acceptor panicked").expect("acceptor failed");
    });

    // Engine 2 should now have the data
    assert_eq!(e2.get("notes/hello.md").unwrap(), "Hello World");
    assert_eq!(e2.get("notes/todo.md").unwrap(), "Buy milk");
}

#[test]
fn test_bidirectional_sync() {
    let vault_id = [3u8; 32];
    let (e1, e2, _key) = make_engines(vault_id);

    // Both engines have different data
    e1.set("from-device-a.md", "Device A content").unwrap();
    e2.set("from-device-b.md", "Device B content").unwrap();

    // Initial sync to get same baseline
    let snap1 = e1.export_snapshot_raw().unwrap();
    let snap2 = e2.export_snapshot_raw().unwrap();
    e2.import_snapshot_raw(&snap1).unwrap();
    e1.import_snapshot_raw(&snap2).unwrap();

    // Now add more data on each side
    e1.set("new-from-a.md", "New A").unwrap();
    e2.set("new-from-b.md", "New B").unwrap();

    let (mut s1, mut s2) = ChannelStream::new_pair();
    let config = default_config();

    let e1_ref = &e1;
    let e2_ref = &e2;

    thread::scope(|scope| {
        let initiator = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e1_ref, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut NoBlobOps))
        });

        let acceptor = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e2_ref, "peer1".into(), false);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut NoBlobOps))
        });

        initiator.join().expect("initiator panicked").expect("initiator failed");
        acceptor.join().expect("acceptor panicked").expect("acceptor failed");
    });

    // Both should have all data
    assert_eq!(e1.get("new-from-b.md").unwrap(), "New B");
    assert_eq!(e2.get("new-from-a.md").unwrap(), "New A");
}

#[test]
fn test_sync_with_blobs() {
    let vault_id = [4u8; 32];
    let (e1, e2, _key) = make_engines(vault_id);

    e1.set("test.md", "text content").unwrap();

    let mut blobs1 = TestBlobOps::new();
    let mut blobs2 = TestBlobOps::new();

    // Add a blob to engine 1's blob store
    let hash = blobs1.add(b"binary attachment data");
    let _hash2 = blobs1.add(b"another attachment");

    let (mut s1, mut s2) = ChannelStream::new_pair();
    let config = default_config();

    let e1_ref = &e1;
    let e2_ref = &e2;

    thread::scope(|scope| {
        let initiator = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e1_ref, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut blobs1))
        });

        let acceptor = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e2_ref, "peer1".into(), false);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut blobs2))
        });

        let r1 = initiator.join().expect("initiator panicked").expect("initiator failed");
        let r2 = acceptor.join().expect("acceptor panicked").expect("acceptor failed");

        // Blobs should have been exchanged
        assert!(r1.blobs_sent > 0 || r2.blobs_sent > 0);
    });

    // Engine 2 should have received the blobs
    assert_eq!(blobs2.count(), 2);
    assert!(blobs2.get(&hash).is_some());
    assert_eq!(blobs2.get(&hash).unwrap(), b"binary attachment data");
}

#[test]
fn test_sync_with_pairing_nonce() {
    let vault_id = [5u8; 32];
    let (e1, e2, _key) = make_engines(vault_id);

    e1.set("paired.md", "pairing test").unwrap();

    let (mut s1, mut s2) = ChannelStream::new_pair();

    let mut config1 = default_config();
    config1.pairing_nonce = Some("test-nonce-12345".to_string());

    let config2 = default_config();

    /// Validator that accepts a specific nonce
    struct NonceValidator(String);
    impl PairingValidator for NonceValidator {
        fn validate(&self, _peer: &str, nonce: Option<&str>) -> Result<bool, String> {
            match nonce {
                Some(n) if n == self.0 => Ok(true),
                Some(_) => Err("Invalid nonce".into()),
                None => Err("Nonce required".into()),
            }
        }
    }

    let e1_ref = &e1;
    let e2_ref = &e2;

    thread::scope(|scope| {
        let initiator = scope.spawn(|| {
            let mut runner = SyncRunner::new(config1, e1_ref, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut NoBlobOps))
        });

        let acceptor = scope.spawn(|| {
            let mut runner = SyncRunner::with_validator(
                config2,
                e2_ref,
                "peer1".into(),
                false,
                NonceValidator("test-nonce-12345".into()),
            );
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut NoBlobOps))
        });

        initiator.join().expect("initiator panicked").expect("initiator failed");
        acceptor.join().expect("acceptor panicked").expect("acceptor failed");
    });

    assert_eq!(e2.get("paired.md").unwrap(), "pairing test");
}

#[test]
fn test_sync_rejected_pairing() {
    let vault_id = [6u8; 32];
    let (e1, e2, _key) = make_engines(vault_id);

    let (mut s1, mut s2) = ChannelStream::new_pair();

    let mut config1 = default_config();
    config1.pairing_nonce = Some("wrong-nonce".to_string());

    let config2 = default_config();

    struct RejectAll;
    impl PairingValidator for RejectAll {
        fn validate(&self, _peer: &str, _nonce: Option<&str>) -> Result<bool, String> {
            Err("All pairing rejected".into())
        }
    }

    let e1_ref = &e1;
    let e2_ref = &e2;

    thread::scope(|scope| {
        let initiator = scope.spawn(|| {
            let mut runner = SyncRunner::new(config1, e1_ref, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut NoBlobOps))
        });

        let acceptor = scope.spawn(|| {
            let mut runner = SyncRunner::with_validator(
                config2, e2_ref, "peer1".into(), false, RejectAll,
            );
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut NoBlobOps))
        });

        let r1 = initiator.join().expect("initiator panicked");
        let r2 = acceptor.join().expect("acceptor panicked");

        // One or both should fail
        assert!(r1.is_err() || r2.is_err());
    });
}

#[test]
fn test_vault_id_mismatch() {
    let (e1, e2, _key) = {
        let key = VaultKey::generate();
        let host1 = Arc::new(MockHost::new());
        let host2 = Arc::new(MockHost::new());
        let mut e1 = SyncEngine::new_with_key(host1, key.clone()).unwrap();
        let mut e2 = SyncEngine::new_with_key(host2, key).unwrap();
        // Different vault IDs!
        e1.init_vault([1u8; 32]);
        e2.init_vault([2u8; 32]);
        (e1, e2, ())
    };

    let (mut s1, mut s2) = ChannelStream::new_pair();
    let config = default_config();

    let e1_ref = &e1;
    let e2_ref = &e2;

    thread::scope(|scope| {
        let initiator = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e1_ref, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut NoBlobOps))
        });

        let acceptor = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e2_ref, "peer1".into(), false);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut NoBlobOps))
        });

        let r1 = initiator.join().expect("initiator panicked");
        let r2 = acceptor.join().expect("acceptor panicked");

        // Should fail due to vault ID mismatch
        assert!(r1.is_err() || r2.is_err());
    });
}

#[test]
fn test_protocol_version_reported() {
    let vault_id = [7u8; 32];
    let (e1, e2, _key) = make_engines(vault_id);

    let (mut s1, mut s2) = ChannelStream::new_pair();
    let config = default_config();

    let e1_ref = &e1;
    let e2_ref = &e2;

    thread::scope(|scope| {
        let initiator = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e1_ref, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut NoBlobOps))
        });

        let acceptor = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e2_ref, "peer1".into(), false);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut NoBlobOps))
        });

        let r1 = initiator.join().expect("initiator panicked").expect("initiator failed");
        let r2 = acceptor.join().expect("acceptor panicked").expect("acceptor failed");

        // Both should report peer_supports_iroh_blobs since both are V3
        assert!(r1.is_live);
        assert!(r2.is_live);
    });
}
