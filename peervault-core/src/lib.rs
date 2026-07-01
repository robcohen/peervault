//! PeerVault Core - Portable P2P Document Sync
//!
//! This crate contains the core protocol logic for PeerVault, designed to be:
//! - Compiled to WASM for embedding in JS/TS applications
//! - Linked natively for CLI tools or native apps
//! - Host-agnostic through the `HostInterface` trait
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────┐
//! │           Host Application              │
//! │     (implements HostInterface)          │
//! └─────────────────┬───────────────────────┘
//!                   │
//!   WasmPeerVault (wasm.rs)  ← wasm-bindgen entry point
//!                   │
//!         ┌─────────▼─────────┐
//!         │  SyncEngine       │  ← CRDT sync (Loro) + vault-key crypto
//!         │  SyncRunner       │  ← V3 wire protocol state machine
//!         │  BlobsBridge      │  ← content-addressed blobs (iroh-blobs)
//!         │  GossipBridge     │  ← live delta broadcast (iroh-gossip)
//!         │  CloudSync        │  ← S3-compatible backup
//!         └─────────┬─────────┘
//!                   │
//!            net::IrohTransport  ← QUIC transport (iroh)
//! ```

pub mod host;
pub mod events;
pub mod rt;
pub mod vault;
pub mod protocol;
pub mod wire;
pub mod sync;
pub mod session;
pub mod runner;
pub mod blob;
pub mod blobs_bridge;
pub mod gossip_bridge;
pub mod sync_handler;
pub mod error;
pub mod store;
pub mod net;
pub mod crypto;
pub mod cloud;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export key types
pub use host::HostInterface;
pub use error::CoreError;
