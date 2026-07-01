//! Native embedding proof: the host-agnostic `PeerVault` engine running on
//! plain tokio — no browser, no wasm, no JavaScript.
//!
//! Two engines pair over real iroh (tickets carry direct localhost addresses,
//! so no relay round-trip is required) and converge on a document via the
//! live gossip path. This is the acceptance test for the multi-host goal:
//! anything a vim plugin / CLI / custom app needs is exercised here.
//!
//! Gated behind `PEERVAULT_NATIVE_P2P=1` because it binds sockets and uses
//! real networking (kept out of default CI like the MinIO suite).

use std::sync::Arc;
use std::time::Duration;

use peervault_core::vault::PeerVault;

fn enabled() -> bool {
    std::env::var("PEERVAULT_NATIVE_P2P").is_ok()
}

const VAULT_ID_HEX: &str = "aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11";
const KEY_HEX: &str = "0101010101010101010101010101010101010101010101010101010101010101";

#[tokio::test(flavor = "multi_thread")]
async fn two_native_engines_pair_and_converge() {
    if !enabled() {
        eprintln!("skipping native p2p test: set PEERVAULT_NATIVE_P2P=1");
        return;
    }

    // Relay: the public n0 relay may be unreachable in sandboxes; point both
    // engines at a local relay (e.g. the docker/e2e one on :3340) when set.
    let relay = std::env::var("PEERVAULT_TEST_RELAY").ok();

    // --- Engine A (acceptor) ---
    let mut a = PeerVault::new(VAULT_ID_HEX, "native-a").expect("vault a");
    if let Some(ref url) = relay {
        a.set_relay_url(url);
    }
    let a_events: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    {
        let sink = a_events.clone();
        a.set_event_callback(Arc::new(move |event| {
            if let Ok(json) = serde_json::to_string(event) {
                sink.lock().unwrap().push(json);
            }
        }));
    }
    a.set_encryption_key(KEY_HEX).await.expect("key a");
    a.start().await.expect("start a");
    let ticket = a.get_ticket().await.expect("ticket a");

    // One-time pairing nonce, as the Obsidian host does when generating a ticket.
    let nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    a.register_pairing_nonce(nonce, now_ms + 60_000);

    // --- Engine B (initiator) ---
    let mut b = PeerVault::new(VAULT_ID_HEX, "native-b").expect("vault b");
    if let Some(ref url) = relay {
        b.set_relay_url(url);
    }
    b.set_encryption_key(KEY_HEX).await.expect("key b");
    b.start().await.expect("start b");

    let peer_id = b
        .connect_peer_with_pairing(&ticket, Some(nonce.to_string()), Some("native-b".into()))
        .await
        .expect("pair + initial sync");
    assert!(!peer_id.is_empty(), "connect returned empty peer id");

    // A must now know B (pairing consumed the nonce and auto-added the peer).
    let known = a.get_known_peers();
    assert!(!known.is_empty(), "acceptor did not record the paired peer");

    // --- Live convergence via gossip ---
    b.set("notes/native.md", b"hello from a native host").await.expect("set on b");

    let mut converged = false;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(Some(bytes)) = a.get("notes/native.md").await {
            assert_eq!(bytes, b"hello from a native host");
            converged = true;
            break;
        }
    }
    assert!(converged, "document did not converge to engine A within 30s; events: {:?}", a_events.lock().unwrap());

    // Typed events flowed through the native callback (no JS involved).
    let events = a_events.lock().unwrap().join("\n");
    assert!(
        events.contains("pairing_complete") || events.contains("peer_connected"),
        "no pairing/connection events observed natively: {events}"
    );

    // --- Clean shutdown (exercises the watch-based cancellation natively) ---
    b.stop().await.expect("stop b");
    a.stop().await.expect("stop a");
}
