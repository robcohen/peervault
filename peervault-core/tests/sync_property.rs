//! Property-based tests for the sync engine.
//!
//! The core correctness claim of a CRDT sync engine is: **it converges to the
//! same state regardless of the order (or duplication) in which updates are
//! delivered.** The example-based tests cover the happy path; these use
//! `proptest` to attack that claim with randomized op sequences and delivery
//! orders, plus a set of hostile-input cases asserting the runner errors
//! cleanly (never panics or hangs) on malformed wire data.

use std::collections::VecDeque;
use std::sync::Arc;

use proptest::prelude::*;

use peervault_core::crypto::VaultKey;
use peervault_core::error::CoreError;
use peervault_core::host::mock::MockHost;
use peervault_core::runner::{RunnerConfig, SyncRunner, SyncStream};
use peervault_core::sync::SyncEngine;

const VAULT_ID: [u8; 32] = [0x5a; 32];

fn make_engine(key: VaultKey) -> SyncEngine {
    let host = Arc::new(MockHost::new());
    let mut e = SyncEngine::new_with_key(host, key).unwrap();
    e.init_vault(VAULT_ID);
    e
}

/// A single CRDT operation applied to one engine.
#[derive(Debug, Clone)]
enum Op {
    Set { engine: usize, path: usize, content: String },
    Delete { engine: usize, path: usize },
}

fn op_strategy(n_engines: usize, n_paths: usize) -> impl Strategy<Value = Op> {
    prop_oneof![
        (0..n_engines, 0..n_paths, "[a-z0-9 ]{0,40}")
            .prop_map(|(engine, path, content)| Op::Set { engine, path, content }),
        (0..n_engines, 0..n_paths).prop_map(|(engine, path)| Op::Delete { engine, path }),
    ]
}

fn path_name(i: usize) -> String {
    format!("notes/file{}.md", i)
}

fn apply(engines: &[SyncEngine], op: &Op) {
    match op {
        Op::Set { engine, path, content } => {
            engines[*engine].set(&path_name(*path), content).unwrap();
        }
        Op::Delete { engine, path } => {
            // Deleting a missing path is a no-op in the store; ignore the result.
            let _ = engines[*engine].delete(&path_name(*path));
        }
    }
}

/// Deliver `from`'s updates (since `to`'s version) into `to`, encrypted end to end.
fn deliver(engines: &[SyncEngine], from: usize, to: usize) -> bool {
    if from == to {
        return false;
    }
    let vv = engines[to].version_vector();
    let delta = engines[from].export_updates_since(&vv).unwrap();
    let before = engines[to].version_vector();
    engines[to].import_updates(&delta).unwrap();
    engines[to].version_vector() != before
}

/// Run all-pairs delivery until no engine's state changes — a guaranteed-complete
/// gossip round on top of whatever (possibly lossy/reordered) delivery preceded it.
fn drive_to_convergence(engines: &[SyncEngine]) {
    loop {
        let mut changed = false;
        for from in 0..engines.len() {
            for to in 0..engines.len() {
                if deliver(engines, from, to) {
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
}

/// The observable state of an engine: sorted (path, content) pairs.
fn snapshot_state(engine: &SyncEngine) -> Vec<(String, Option<String>)> {
    let mut paths = engine.list_paths();
    paths.sort();
    paths.into_iter().map(|p| { let c = engine.get(&p); (p, c) }).collect()
}

proptest! {
    // A few hundred randomized histories; each history is a random op sequence
    // plus a random (duplicating, reordered) delivery schedule.
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn crdt_converges_under_arbitrary_delivery(
        ops in prop::collection::vec(op_strategy(3, 4), 1..40),
        // A random delivery schedule: pairs of (from, to) applied before the
        // final guaranteed-complete round. May duplicate, skip, or reorder.
        schedule in prop::collection::vec((0usize..3, 0usize..3), 0..60),
    ) {
        let key = VaultKey::generate();
        let engines: Vec<SyncEngine> = (0..3).map(|_| make_engine(key.clone())).collect();

        // Interleave op application with partial (arbitrary-order) delivery.
        for (i, op) in ops.iter().enumerate() {
            apply(&engines, op);
            // Occasionally deliver a scheduled pair mid-history.
            if let Some(&(from, to)) = schedule.get(i) {
                deliver(&engines, from % 3, to % 3);
            }
        }
        // Apply the rest of the schedule (reordered / duplicated deliveries).
        for &(from, to) in &schedule {
            deliver(&engines, from % 3, to % 3);
        }

        // Complete delivery, then all engines must agree exactly.
        drive_to_convergence(&engines);

        // After complete delivery every engine must observe identical content.
        // (We compare observable state, not the raw version-vector bytes: Loro's
        // VV serialization isn't order-canonical, so equal-state engines can carry
        // byte-different-but-semantically-equal VVs.)
        let reference = snapshot_state(&engines[0]);
        for (idx, e) in engines.iter().enumerate().skip(1) {
            let state = snapshot_state(e);
            prop_assert_eq!(
                &state, &reference,
                "engine {} diverged from engine 0 after convergence", idx
            );
        }
    }

    #[test]
    fn import_is_idempotent(
        ops in prop::collection::vec(op_strategy(1, 4), 1..20),
        dup in 1usize..5,
    ) {
        // Applying the same delta N times must equal applying it once.
        let key = VaultKey::generate();
        let source = make_engine(key.clone());
        let engines: Vec<SyncEngine> = (0..2).map(|_| make_engine(key.clone())).collect();
        for op in &ops {
            // All ops target the single source engine.
            match op {
                Op::Set { path, content, .. } => source.set(&path_name(*path), content).unwrap(),
                Op::Delete { path, .. } => { let _ = source.delete(&path_name(*path)); }
            }
        }
        let delta = source.export_updates_since(&engines[0].version_vector()).unwrap();
        // engine[0]: import once. engine[1]: import `dup` times.
        engines[0].import_updates(&delta).unwrap();
        for _ in 0..dup {
            engines[1].import_updates(&delta).unwrap();
        }
        prop_assert_eq!(snapshot_state(&engines[0]), snapshot_state(&engines[1]));
    }
}

// ---------------------------------------------------------------------------
// Hostile / malformed wire input — the runner must error cleanly, never panic.
// ---------------------------------------------------------------------------

/// A stream that yields caller-supplied frames, then reports EOF as a timeout.
struct ScriptedStream {
    incoming: VecDeque<Vec<u8>>,
}

impl ScriptedStream {
    fn new(frames: Vec<Vec<u8>>) -> Self {
        Self { incoming: frames.into() }
    }
}

#[async_trait::async_trait]
impl SyncStream for ScriptedStream {
    async fn send(&mut self, _data: &[u8]) -> Result<(), CoreError> {
        Ok(()) // discard our side's output
    }
    async fn recv(&mut self, _timeout_ms: u64) -> Result<Vec<u8>, CoreError> {
        self.incoming
            .pop_front()
            .ok_or_else(|| CoreError::Timeout("scripted stream exhausted".into()))
    }
    async fn close(&mut self) -> Result<(), CoreError> {
        Ok(())
    }
}

async fn assert_acceptor_errors(frames: Vec<Vec<u8>>) {
    let key = VaultKey::generate();
    let engine = make_engine(key);
    let cfg = RunnerConfig { receive_timeout_ms: 100, ..Default::default() };
    // Acceptor: it receives first, so the first frame is the peer's VersionInfo.
    let mut runner = SyncRunner::new(cfg, &engine, "hostile-peer".into(), false);
    let mut stream = ScriptedStream::new(frames);
    let result = runner.run_crdt_only(&mut stream).await;
    assert!(
        result.is_err(),
        "runner accepted malformed input instead of erroring: {:?}",
        result
    );
}

#[tokio::test]
async fn rejects_random_garbage() {
    assert_acceptor_errors(vec![vec![0xff; 64]]).await;
}

#[tokio::test]
async fn rejects_truncated_frame() {
    // A single byte can't be a valid encoded Message.
    assert_acceptor_errors(vec![vec![0x01]]).await;
}

#[tokio::test]
async fn rejects_empty_frame() {
    assert_acceptor_errors(vec![vec![]]).await;
}

#[tokio::test]
async fn rejects_immediate_eof() {
    // No frames at all — recv times out; must surface as an error, not a hang/panic.
    assert_acceptor_errors(vec![]).await;
}
