//! Events emitted from the WASM core to the host (JS/TS).
//!
//! This enum is the single source of truth for the WASM→host event schema. It
//! serializes to a `{ "type": "...", ... }` tagged object, and the matching
//! TypeScript type is generated from it via `ts-rs`:
//!
//! ```sh
//! cargo test --features ts-export export_ts_bindings
//! ```
//!
//! which (re)writes `src/core/generated/events.ts`. Because both the Rust
//! emission and the TS consumer derive from this definition, a field rename here
//! becomes a compile error on the TypeScript side instead of a silent
//! undefined-at-runtime.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "../../src/core/generated/events.ts"))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WasmEvent {
    /// A point-to-point sync with a peer finished.
    SyncComplete {
        peer_id: String,
        /// "incoming" (we accepted) or "outgoing" (we initiated).
        direction: String,
        updates_received: usize,
        updates_sent: usize,
    },
    /// A new peer completed pairing (acceptor side).
    PairingComplete {
        peer_id: String,
        device_name: String,
    },
    /// The document changed from a remote source (gossip delta imported).
    DocumentChanged {
        source: String,
        bytes: usize,
    },
    /// A gossip neighbor joined the topic.
    GossipNeighborUp {
        peer_id: String,
    },
    /// A gossip neighbor left the topic.
    GossipNeighborDown {
        peer_id: String,
    },
    /// A CRDT delta exceeded the gossip size limit; a point-to-point sync is
    /// needed to reconcile.
    SyncNeeded {
        reason: String,
        size: usize,
        max: usize,
    },
    /// An incoming connection was accepted.
    PeerConnected {
        peer_id: String,
        direction: String,
    },
}

#[cfg(all(test, feature = "ts-export"))]
mod ts_export {
    use super::*;
    use ts_rs::TS;

    /// Regenerates `src/core/generated/events.ts` from `WasmEvent`.
    #[test]
    fn export_ts_bindings() {
        WasmEvent::export_all().expect("export TS bindings");
    }
}

/// Host event callback. On wasm the host is single-threaded JS (`Rc`, no `Send`);
/// on native it may be called from any runtime thread (`Arc + Send + Sync`).
#[cfg(target_arch = "wasm32")]
pub type EventCallback = std::rc::Rc<dyn Fn(&WasmEvent)>;
#[cfg(not(target_arch = "wasm32"))]
pub type EventCallback = std::sync::Arc<dyn Fn(&WasmEvent) + Send + Sync>;

/// Host state-persistence callback, invoked with the exported store state
/// whenever it changes. Same threading split as `EventCallback`.
#[cfg(target_arch = "wasm32")]
pub type StateCallback = std::rc::Rc<dyn Fn(&[u8])>;
#[cfg(not(target_arch = "wasm32"))]
pub type StateCallback = std::sync::Arc<dyn Fn(&[u8]) + Send + Sync>;
