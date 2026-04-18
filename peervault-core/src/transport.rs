//! Transport Layer Abstraction
//!
//! Provides a clean interface over various transport mechanisms:
//! - Iroh QUIC (relay-assisted P2P)
//! - WebRTC (browser environments)
//! - Local/memory transport (testing)
//!
//! # Design Principles
//!
//! 1. **Protocol per stream**: Each protocol (sync, blob, keys, mesh) gets its own stream
//! 2. **Bidirectional streams**: All streams support send and receive
//! 3. **Connection != Stream**: A connection can have multiple concurrent streams
//! 4. **Graceful degradation**: If direct connection fails, fall back to relay

use std::future::Future;
use std::pin::Pin;

/// Async result type for transport operations
pub type TransportResult<T> = Pin<Box<dyn Future<Output = Result<T, TransportError>> + Send>>;

/// Transport errors
#[derive(Debug, Clone)]
pub enum TransportError {
    /// Failed to connect to peer
    ConnectionFailed(String),
    /// Connection was closed
    ConnectionClosed,
    /// Stream was closed
    StreamClosed,
    /// Timeout waiting for operation
    Timeout,
    /// Invalid ticket format
    InvalidTicket(String),
    /// Peer not found
    PeerNotFound(String),
    /// Protocol negotiation failed
    ProtocolError(String),
    /// Generic I/O error
    IoError(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConnectionFailed(s) => write!(f, "connection failed: {}", s),
            Self::ConnectionClosed => write!(f, "connection closed"),
            Self::StreamClosed => write!(f, "stream closed"),
            Self::Timeout => write!(f, "operation timed out"),
            Self::InvalidTicket(s) => write!(f, "invalid ticket: {}", s),
            Self::PeerNotFound(s) => write!(f, "peer not found: {}", s),
            Self::ProtocolError(s) => write!(f, "protocol error: {}", s),
            Self::IoError(s) => write!(f, "I/O error: {}", s),
        }
    }
}

impl std::error::Error for TransportError {}

/// Protocol identifiers for stream multiplexing
///
/// Following libp2p convention of path-like protocol IDs
pub mod protocols {
    /// CRDT synchronization protocol
    pub const SYNC: &str = "/pv/sync/1";
    /// Blob (binary content) transfer protocol
    pub const BLOB: &str = "/pv/blob/1";
    /// Vault key exchange protocol
    pub const KEYS: &str = "/pv/keys/1";
    /// Peer mesh discovery protocol
    pub const MESH: &str = "/pv/mesh/1";
    /// Connection control protocol
    pub const CTRL: &str = "/pv/ctrl/1";
}

/// Information about a peer for connection
#[derive(Debug, Clone)]
pub struct PeerAddress {
    /// Unique peer identifier (public key or derived)
    pub peer_id: String,
    /// Connection ticket (contains addresses, relay info)
    pub ticket: Option<String>,
    /// Known relay addresses
    pub relay_addrs: Vec<String>,
    /// Known direct addresses (IP:port)
    pub direct_addrs: Vec<String>,
}

/// Connection statistics
#[derive(Debug, Clone, Default)]
pub struct ConnectionStats {
    /// Bytes sent on this connection
    pub bytes_sent: u64,
    /// Bytes received on this connection
    pub bytes_received: u64,
    /// Round-trip time in milliseconds (if known)
    pub rtt_ms: Option<u32>,
    /// True if connection is via relay
    pub is_relayed: bool,
    /// Number of active streams
    pub active_streams: usize,
}

/// Transport trait - the main entry point for networking
///
/// A transport manages connections to peers and provides our node identity.
pub trait Transport: Send + Sync + 'static {
    /// The connection type this transport produces
    type Connection: Connection;

    /// Get our node's unique identifier
    fn node_id(&self) -> String;

    /// Get a ticket that others can use to connect to us
    fn get_ticket(&self) -> String;

    /// Connect to a peer
    ///
    /// Returns a connection that can be used to open streams
    fn connect(&self, peer: &PeerAddress) -> TransportResult<Self::Connection>;

    /// Accept an incoming connection
    ///
    /// This is typically called in a loop to accept connections
    fn accept(&self) -> TransportResult<Self::Connection>;

    /// Parse a ticket string into peer address info
    fn parse_ticket(&self, ticket: &str) -> Result<PeerAddress, TransportError>;
}

/// A connection to a peer
///
/// Connections are multiplexed - multiple streams can be open simultaneously.
/// Each stream is associated with a protocol identifier.
pub trait Connection: Send + Sync + 'static {
    /// The stream type this connection produces
    type Stream: Stream;

    /// Get the peer's identifier
    fn peer_id(&self) -> String;

    /// Open a new stream for a specific protocol
    ///
    /// The protocol ID is sent to the peer so they know what protocol to use.
    fn open_stream(&self, protocol: &str) -> TransportResult<Self::Stream>;

    /// Accept an incoming stream
    ///
    /// Returns the protocol ID and the stream. The peer chose the protocol.
    fn accept_stream(&self) -> TransportResult<(String, Self::Stream)>;

    /// Close the connection gracefully
    fn close(&self) -> TransportResult<()>;

    /// Check if the connection is still alive
    fn is_alive(&self) -> bool;

    /// Get connection statistics
    fn stats(&self) -> ConnectionStats;
}

/// A bidirectional stream for message exchange
///
/// Streams provide ordered, reliable delivery within a connection.
pub trait Stream: Send + Sync + 'static {
    /// Get a unique identifier for this stream (for debugging)
    fn id(&self) -> String;

    /// Send data on the stream
    ///
    /// Data is framed - each send() results in one recv() on the other side.
    fn send(&self, data: &[u8]) -> TransportResult<()>;

    /// Receive data from the stream
    ///
    /// Blocks until data is available or the stream is closed.
    fn recv(&self) -> TransportResult<Vec<u8>>;

    /// Receive with timeout
    fn recv_timeout(&self, timeout_ms: u64) -> TransportResult<Vec<u8>>;

    /// Close the stream gracefully
    fn close(&self) -> TransportResult<()>;
}

// ============================================================================
// Stream Helpers
// ============================================================================

/// Length-prefixed message framing
///
/// All protocol messages are sent as:
/// - u32 big-endian length
/// - payload bytes
pub mod framing {
    use super::*;

    /// Maximum message size (16 MB)
    pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;

    /// Send a length-prefixed message
    pub async fn send_framed<S: Stream>(stream: &S, data: &[u8]) -> Result<(), TransportError> {
        if data.len() > MAX_MESSAGE_SIZE {
            return Err(TransportError::ProtocolError(
                format!("message too large: {} bytes", data.len())
            ));
        }

        let len = (data.len() as u32).to_be_bytes();
        let mut frame = Vec::with_capacity(4 + data.len());
        frame.extend_from_slice(&len);
        frame.extend_from_slice(data);

        stream.send(&frame).await
    }

    /// Receive a length-prefixed message
    pub async fn recv_framed<S: Stream>(stream: &S) -> Result<Vec<u8>, TransportError> {
        // First read the length prefix
        let len_bytes = stream.recv().await?;
        if len_bytes.len() < 4 {
            return Err(TransportError::ProtocolError("incomplete length prefix".into()));
        }

        let len = u32::from_be_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;

        if len > MAX_MESSAGE_SIZE {
            return Err(TransportError::ProtocolError(
                format!("message too large: {} bytes", len)
            ));
        }

        // The rest of the data should follow
        if len_bytes.len() > 4 {
            Ok(len_bytes[4..].to_vec())
        } else {
            stream.recv().await
        }
    }
}

// ============================================================================
// Mock Transport for Testing
// ============================================================================

#[cfg(test)]
pub mod mock {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// In-memory mock transport for testing
    pub struct MockTransport {
        node_id: String,
        pending_connections: Arc<Mutex<VecDeque<MockConnection>>>,
    }

    impl MockTransport {
        pub fn new(node_id: &str) -> Self {
            Self {
                node_id: node_id.to_string(),
                pending_connections: Arc::new(Mutex::new(VecDeque::new())),
            }
        }

        /// Create a pair of connected transports for testing
        pub fn create_pair() -> (Self, Self) {
            let t1 = Self::new("peer-a");
            let t2 = Self::new("peer-b");
            // In a real implementation, we'd wire these together
            (t1, t2)
        }
    }

    pub struct MockConnection {
        peer_id: String,
        streams: Arc<Mutex<VecDeque<(String, MockStream)>>>,
    }

    pub struct MockStream {
        id: String,
        send_buffer: Arc<Mutex<VecDeque<Vec<u8>>>>,
        recv_buffer: Arc<Mutex<VecDeque<Vec<u8>>>>,
    }

    impl Transport for MockTransport {
        type Connection = MockConnection;

        fn node_id(&self) -> String {
            self.node_id.clone()
        }

        fn get_ticket(&self) -> String {
            format!("mock-ticket-{}", self.node_id)
        }

        fn connect(&self, peer: &PeerAddress) -> TransportResult<Self::Connection> {
            let peer_id = peer.peer_id.clone();
            Box::pin(async move {
                Ok(MockConnection {
                    peer_id,
                    streams: Arc::new(Mutex::new(VecDeque::new())),
                })
            })
        }

        fn accept(&self) -> TransportResult<Self::Connection> {
            Box::pin(async {
                Err(TransportError::Timeout) // No pending connections in mock
            })
        }

        fn parse_ticket(&self, ticket: &str) -> Result<PeerAddress, TransportError> {
            Ok(PeerAddress {
                peer_id: ticket.replace("mock-ticket-", ""),
                ticket: Some(ticket.to_string()),
                relay_addrs: vec![],
                direct_addrs: vec![],
            })
        }
    }

    impl Connection for MockConnection {
        type Stream = MockStream;

        fn peer_id(&self) -> String {
            self.peer_id.clone()
        }

        fn open_stream(&self, protocol: &str) -> TransportResult<Self::Stream> {
            let stream = MockStream {
                id: format!("{}-{}", self.peer_id, protocol),
                send_buffer: Arc::new(Mutex::new(VecDeque::new())),
                recv_buffer: Arc::new(Mutex::new(VecDeque::new())),
            };
            Box::pin(async { Ok(stream) })
        }

        fn accept_stream(&self) -> TransportResult<(String, Self::Stream)> {
            Box::pin(async {
                Err(TransportError::Timeout)
            })
        }

        fn close(&self) -> TransportResult<()> {
            Box::pin(async { Ok(()) })
        }

        fn is_alive(&self) -> bool {
            true
        }

        fn stats(&self) -> ConnectionStats {
            ConnectionStats::default()
        }
    }

    impl Stream for MockStream {
        fn id(&self) -> String {
            self.id.clone()
        }

        fn send(&self, data: &[u8]) -> TransportResult<()> {
            let data = data.to_vec();
            let mut buf = self.send_buffer.lock().unwrap();
            buf.push_back(data);
            Box::pin(async { Ok(()) })
        }

        fn recv(&self) -> TransportResult<Vec<u8>> {
            let mut buf = self.recv_buffer.lock().unwrap();
            let data = buf.pop_front();
            Box::pin(async move {
                data.ok_or(TransportError::StreamClosed)
            })
        }

        fn recv_timeout(&self, _timeout_ms: u64) -> TransportResult<Vec<u8>> {
            self.recv()
        }

        fn close(&self) -> TransportResult<()> {
            Box::pin(async { Ok(()) })
        }
    }
}
