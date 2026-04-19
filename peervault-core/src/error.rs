//! Error types for PeerVault Core

use crate::host::HostError;
use crate::transport::TransportError;
use crate::store::StoreError;

/// Core error type
#[derive(Debug)]
pub enum CoreError {
    /// Host interface error
    Host(HostError),
    /// Transport error
    Transport(TransportError),
    /// Store error
    Store(StoreError),
    /// Protocol error
    Protocol(String),
    /// CRDT error
    Crdt(String),
    /// Configuration error
    Config(String),
    /// Encryption/decryption error
    Crypto(String),
    /// Internal error (bug)
    Internal(String),
    /// Timeout error
    Timeout(String),
    /// Key conflict - both peers have different vault keys
    KeyConflict {
        our_device: String,
        peer_device: String,
    },
    /// CRDT delta too large for gossip broadcast
    DeltaTooLarge {
        size: usize,
        max: usize,
    },
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Host(e) => write!(f, "host error: {}", e),
            Self::Transport(e) => write!(f, "transport error: {}", e),
            Self::Store(e) => write!(f, "store error: {}", e),
            Self::Protocol(s) => write!(f, "protocol error: {}", s),
            Self::Crdt(s) => write!(f, "CRDT error: {}", s),
            Self::Config(s) => write!(f, "config error: {}", s),
            Self::Crypto(s) => write!(f, "crypto error: {}", s),
            Self::Internal(s) => write!(f, "internal error: {}", s),
            Self::Timeout(s) => write!(f, "timeout: {}", s),
            Self::KeyConflict { our_device, peer_device } => write!(
                f,
                "Key conflict: '{}' and '{}' have different vault keys",
                our_device, peer_device
            ),
            Self::DeltaTooLarge { size, max } => write!(
                f,
                "CRDT delta too large for gossip: {} bytes (max {})",
                size, max
            ),
        }
    }
}

impl std::error::Error for CoreError {}

impl From<HostError> for CoreError {
    fn from(e: HostError) -> Self {
        Self::Host(e)
    }
}

impl From<TransportError> for CoreError {
    fn from(e: TransportError) -> Self {
        Self::Transport(e)
    }
}

impl From<StoreError> for CoreError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}
