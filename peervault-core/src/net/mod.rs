//! Network layer using Iroh
//!
//! This module provides the P2P networking stack built on Iroh.
//! Iroh handles QUIC connections with automatic relay fallback and NAT traversal.

pub mod transport;
pub mod peer;
pub mod sync_runner;

pub use transport::{IrohTransport, IrohConnection, IrohStream, PEERVAULT_ALPN};
pub use peer::{PeerId, Ticket};
pub use sync_runner::{run_initiator_sync, run_acceptor_sync};

/// Re-export iroh types we use
pub use iroh::EndpointId;
pub use iroh::SecretKey;
pub use iroh::endpoint::RecvStream;
pub use iroh::endpoint::SendStream;
