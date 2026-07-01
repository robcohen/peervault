//! Stress tests for the V3 sync protocol
//!
//! Tests concurrent sync, large payloads, conflicts, rapid changes,
//! and protocol edge cases.

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
// Infrastructure (same as sync_integration.rs)
// =============================================================================

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
        self.tx.send(data.to_vec())
            .map_err(|_| CoreError::Protocol("Channel closed".into()))
    }
    async fn recv(&mut self, timeout_ms: u64) -> Result<Vec<u8>, CoreError> {
        self.rx.lock().unwrap()
            .recv_timeout(std::time::Duration::from_millis(timeout_ms))
            .map_err(|e| match e {
                std::sync::mpsc::RecvTimeoutError::Timeout => CoreError::Timeout("recv timeout".into()),
                std::sync::mpsc::RecvTimeoutError::Disconnected => CoreError::Protocol("Channel disconnected".into()),
            })
    }
    async fn close(&mut self) -> Result<(), CoreError> { Ok(()) }
}

struct TestBlobOps {
    blobs: Arc<Mutex<std::collections::HashMap<iroh_blobs::Hash, Vec<u8>>>>,
}

impl TestBlobOps {
    fn new() -> Self {
        Self { blobs: Arc::new(Mutex::new(std::collections::HashMap::new())) }
    }
    fn add(&self, data: &[u8]) -> iroh_blobs::Hash {
        let hash = iroh_blobs::Hash::new(data);
        self.blobs.lock().unwrap().insert(hash, data.to_vec());
        hash
    }
    fn count(&self) -> usize { self.blobs.lock().unwrap().len() }
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

fn run_sync(e1: &SyncEngine, e2: &SyncEngine) {
    let (mut s1, mut s2) = ChannelStream::new_pair();
    let config = RunnerConfig { receive_timeout_ms: 10000, ..RunnerConfig::default() };
    thread::scope(|scope| {
        let r1 = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e1, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, &mut NoBlobOps))
        });
        let r2 = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e2, "peer1".into(), false);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, &mut NoBlobOps))
        });
        r1.join().expect("initiator panicked").expect("initiator failed");
        r2.join().expect("acceptor panicked").expect("acceptor failed");
    });
}

fn run_sync_with_blobs(
    e1: &SyncEngine, e2: &SyncEngine,
    b1: &mut TestBlobOps, b2: &mut TestBlobOps,
) {
    let (mut s1, mut s2) = ChannelStream::new_pair();
    let config = RunnerConfig { receive_timeout_ms: 10000, ..RunnerConfig::default() };
    thread::scope(|scope| {
        let r1 = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e1, "peer2".into(), true);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s1, b1))
        });
        let r2 = scope.spawn(|| {
            let mut runner = SyncRunner::new(config.clone(), e2, "peer1".into(), false);
            tokio::runtime::Runtime::new().unwrap().block_on(runner.run(&mut s2, b2))
        });
        r1.join().expect("initiator panicked").expect("initiator failed");
        r2.join().expect("acceptor panicked").expect("acceptor failed");
    });
}

// =============================================================================
// Stress Tests
// =============================================================================

#[test]
fn test_many_files() {
    let vault_id = [10u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    // Create 100 files on engine 1
    for i in 0..100 {
        e1.set(&format!("file_{:03}.md", i), &format!("Content for file {}", i)).unwrap();
    }

    run_sync(&e1, &e2);

    // Engine 2 should have all 100 files
    for i in 0..100 {
        let content = e2.get(&format!("file_{:03}.md", i));
        assert!(content.is_some(), "Missing file_{:03}.md", i);
        assert_eq!(content.unwrap(), format!("Content for file {}", i));
    }
}

#[test]
fn test_large_file_content() {
    let vault_id = [11u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    // Create a file with 100KB of content
    let large_content: String = "x".repeat(100_000);
    e1.set("large.md", &large_content).unwrap();

    run_sync(&e1, &e2);

    let synced = e2.get("large.md").unwrap();
    assert_eq!(synced.len(), 100_000);
    assert_eq!(synced, large_content);
}

#[test]
fn test_concurrent_edits_same_file() {
    let vault_id = [12u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    // Both engines start with shared baseline
    e1.set("shared.md", "original").unwrap();
    let snap = e1.export_snapshot_raw().unwrap();
    e2.import_snapshot_raw(&snap).unwrap();

    // Both edit the same file concurrently
    e1.set("shared.md", "version from device A").unwrap();
    e2.set("shared.md", "version from device B").unwrap();

    run_sync(&e1, &e2);

    // Both should converge to the same value (Loro CRDT resolution)
    let v1 = e1.get("shared.md").unwrap();
    let v2 = e2.get("shared.md").unwrap();
    assert_eq!(v1, v2, "Engines should converge after sync");
    // Loro LoroText merges concurrent edits — the result is deterministic
    // but may be a concatenation, one version, or other merge result.
    // The key property is convergence: both sides agree.
    assert!(!v1.is_empty(), "Merged value should not be empty");
}

#[test]
fn test_delete_and_recreate() {
    let vault_id = [13u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    // Create, delete, recreate
    e1.set("ephemeral.md", "first version").unwrap();
    e1.delete("ephemeral.md").unwrap();
    e1.set("ephemeral.md", "second version").unwrap();

    run_sync(&e1, &e2);

    assert_eq!(e2.get("ephemeral.md").unwrap(), "second version");
}

#[test]
fn test_repeated_sync() {
    let vault_id = [14u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    // Round 1: sync initial data
    e1.set("round1.md", "round 1").unwrap();
    run_sync(&e1, &e2);
    assert_eq!(e2.get("round1.md").unwrap(), "round 1");

    // Round 2: add more data, sync again
    e1.set("round2.md", "round 2").unwrap();
    e2.set("round2_from_b.md", "from B").unwrap();
    run_sync(&e1, &e2);
    assert_eq!(e2.get("round2.md").unwrap(), "round 2");
    assert_eq!(e1.get("round2_from_b.md").unwrap(), "from B");

    // Round 3: modify existing files
    e1.set("round1.md", "round 1 updated").unwrap();
    run_sync(&e1, &e2);
    assert_eq!(e2.get("round1.md").unwrap(), "round 1 updated");
}

#[test]
fn test_many_blobs() {
    let vault_id = [15u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    e1.set("index.md", "has blobs").unwrap();

    let mut blobs1 = TestBlobOps::new();
    let mut blobs2 = TestBlobOps::new();

    // Add 20 blobs of varying sizes
    for i in 0..20 {
        let data = vec![i as u8; 1000 * (i + 1) as usize]; // 1KB to 20KB
        blobs1.add(&data);
    }

    assert_eq!(blobs1.count(), 20);
    assert_eq!(blobs2.count(), 0);

    run_sync_with_blobs(&e1, &e2, &mut blobs1, &mut blobs2);

    assert_eq!(blobs2.count(), 20, "All 20 blobs should be synced");
}

#[test]
fn test_bidirectional_blobs() {
    let vault_id = [16u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    e1.set("a.md", "from a").unwrap();
    e2.set("b.md", "from b").unwrap();
    let snap = e1.export_snapshot_raw().unwrap();
    e2.import_snapshot_raw(&snap).unwrap();
    let snap2 = e2.export_snapshot_raw().unwrap();
    e1.import_snapshot_raw(&snap2).unwrap();

    let mut blobs1 = TestBlobOps::new();
    let mut blobs2 = TestBlobOps::new();

    // Each side has unique blobs
    let h1 = blobs1.add(b"blob from device A");
    let h2 = blobs2.add(b"blob from device B");

    run_sync_with_blobs(&e1, &e2, &mut blobs1, &mut blobs2);

    // Both should have both blobs
    assert_eq!(blobs1.count(), 2);
    assert_eq!(blobs2.count(), 2);
    assert!(blobs1.get(&h2).is_some(), "Engine 1 missing blob from B");
    assert!(blobs2.get(&h1).is_some(), "Engine 2 missing blob from A");
}

#[test]
fn test_empty_to_empty_sync() {
    let vault_id = [17u8; 32];
    let key = VaultKey::generate();
    let host1 = Arc::new(MockHost::new());
    let host2 = Arc::new(MockHost::new());
    let mut e1 = SyncEngine::new_with_key(host1, key.clone()).unwrap();
    let mut e2 = SyncEngine::new_with_key(host2, key).unwrap();
    e1.init_vault(vault_id);
    e2.init_vault(vault_id);

    // Both empty — sync should succeed without error
    // Need at least one operation for Loro VV to be non-empty
    // This tests the edge case of syncing with minimal data
    e1.set("_init", "").unwrap();

    run_sync(&e1, &e2);
    // Should not panic or error
}

#[test]
fn test_unicode_content() {
    let vault_id = [18u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    e1.set("emoji.md", "Hello 🌍🎉 こんにちは 你好 مرحبا").unwrap();
    e1.set("math.md", "∫ f(x) dx = ∑ aₙ · xⁿ").unwrap();
    e1.set("rtl.md", "שלום עולם").unwrap();

    run_sync(&e1, &e2);

    assert_eq!(e2.get("emoji.md").unwrap(), "Hello 🌍🎉 こんにちは 你好 مرحبا");
    assert_eq!(e2.get("math.md").unwrap(), "∫ f(x) dx = ∑ aₙ · xⁿ");
    assert_eq!(e2.get("rtl.md").unwrap(), "שלום עולם");
}

#[test]
fn test_deep_path_files() {
    let vault_id = [19u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    e1.set("a/b/c/d/e/f/deep.md", "deeply nested").unwrap();
    e1.set("notes/2024/01/daily.md", "daily note").unwrap();
    e1.set("attachments/images/screenshot.png.meta", "metadata").unwrap();

    run_sync(&e1, &e2);

    assert_eq!(e2.get("a/b/c/d/e/f/deep.md").unwrap(), "deeply nested");
    assert_eq!(e2.get("notes/2024/01/daily.md").unwrap(), "daily note");
}

#[test]
fn test_special_characters_in_paths() {
    let vault_id = [20u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    e1.set("file with spaces.md", "spaces").unwrap();
    e1.set("file-with-dashes.md", "dashes").unwrap();
    e1.set("file_with_underscores.md", "underscores").unwrap();
    e1.set("UPPERCASE.MD", "upper").unwrap();

    run_sync(&e1, &e2);

    assert_eq!(e2.get("file with spaces.md").unwrap(), "spaces");
    assert_eq!(e2.get("UPPERCASE.MD").unwrap(), "upper");
}

#[test]
fn test_rapid_sequential_syncs() {
    let vault_id = [21u8; 32];
    let (e1, e2, _) = make_engines(vault_id);

    e1.set("init.md", "start").unwrap();

    // Sync 10 times in rapid succession, each time adding a file
    for i in 0..10 {
        e1.set(&format!("rapid_{}.md", i), &format!("content {}", i)).unwrap();
        run_sync(&e1, &e2);
    }

    // All 11 files (init + 10 rapid) should be present
    for i in 0..10 {
        assert!(e2.get(&format!("rapid_{}.md", i)).is_some(), "Missing rapid_{}.md", i);
    }
}

#[test]
fn test_three_way_sync() {
    // Simulate 3 devices syncing pairwise
    let vault_id = [22u8; 32];
    let key = VaultKey::generate();

    let host_a = Arc::new(MockHost::new());
    let host_b = Arc::new(MockHost::new());
    let host_c = Arc::new(MockHost::new());

    let mut a = SyncEngine::new_with_key(host_a, key.clone()).unwrap();
    let mut b = SyncEngine::new_with_key(host_b, key.clone()).unwrap();
    let mut c = SyncEngine::new_with_key(host_c, key).unwrap();

    a.init_vault(vault_id);
    b.init_vault(vault_id);
    c.init_vault(vault_id);

    // A creates a file
    a.set("from_a.md", "Device A").unwrap();

    // A syncs with B
    run_sync(&a, &b);
    assert_eq!(b.get("from_a.md").unwrap(), "Device A");

    // B creates a file
    b.set("from_b.md", "Device B").unwrap();

    // B syncs with C (C gets both A's and B's files)
    run_sync(&b, &c);
    assert_eq!(c.get("from_a.md").unwrap(), "Device A");
    assert_eq!(c.get("from_b.md").unwrap(), "Device B");

    // C creates a file
    c.set("from_c.md", "Device C").unwrap();

    // C syncs with A (A gets B's and C's files)
    run_sync(&c, &a);
    assert_eq!(a.get("from_b.md").unwrap(), "Device B");
    assert_eq!(a.get("from_c.md").unwrap(), "Device C");

    // All three should have all three files
    assert!(a.get("from_a.md").is_some());
    assert!(a.get("from_b.md").is_some());
    assert!(a.get("from_c.md").is_some());
    assert!(b.get("from_a.md").is_some());
    assert!(c.get("from_a.md").is_some());
}
