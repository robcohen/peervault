//! Protocol Messages
//!
//! Defines the wire format for all protocol messages.
//! Uses Loro's native export format for document sync.
//!
//! # Sync Protocol (Loro CRDT)
//!
//! Uses Loro's built-in sync:
//! 1. Exchange version vectors
//! 2. Export/import updates or snapshots
//! 3. Enter live mode

use std::io;
use serde::{Serialize, Deserialize};
use iroh_blobs::Hash;

// ============================================================================
// Sync Protocol Messages (/pv/sync/1)
// ============================================================================

pub mod sync {
    use super::*;

    /// Message type tags for sync protocol
    /// Matches the TypeScript implementation
    #[repr(u8)]
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub enum MessageType {
        /// Initial version exchange
        VersionInfo = 0x01,
        /// Loro updates payload
        Updates = 0x02,
        /// Request a full document snapshot
        SnapshotRequest = 0x03,
        /// Full document snapshot
        Snapshot = 0x04,
        /// Sync complete acknowledgment
        SyncComplete = 0x06,
        /// Error message
        Error = 0x07,
        /// Keep-alive ping
        Ping = 0x08,
        /// Keep-alive pong
        Pong = 0x09,
        /// Blob hashes we have
        BlobHashes = 0x10,
        /// Request specific blobs
        BlobRequest = 0x11,
        /// Blob data
        BlobData = 0x12,
        /// Blob sync complete
        BlobSyncComplete = 0x13,
    }

    impl TryFrom<u8> for MessageType {
        type Error = ();
        fn try_from(v: u8) -> Result<Self, ()> {
            match v {
                0x01 => Ok(Self::VersionInfo),
                0x02 => Ok(Self::Updates),
                0x03 => Ok(Self::SnapshotRequest),
                0x04 => Ok(Self::Snapshot),
                0x06 => Ok(Self::SyncComplete),
                0x07 => Ok(Self::Error),
                0x08 => Ok(Self::Ping),
                0x09 => Ok(Self::Pong),
                0x10 => Ok(Self::BlobHashes),
                0x11 => Ok(Self::BlobRequest),
                0x12 => Ok(Self::BlobData),
                0x13 => Ok(Self::BlobSyncComplete),
                _ => Err(()),
            }
        }
    }

    /// Protocol version (v3 adds iroh-blobs transfer support)
    pub const PROTOCOL_VERSION: u8 = 3;

    /// Version info message - initial handshake
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct VersionInfo {
        /// Protocol version
        pub protocol_version: u8,
        /// Vault identifier
        pub vault_id: [u8; 32],
        /// Loro version vector (serialized)
        pub version_bytes: Vec<u8>,
        /// Device hostname
        pub hostname: String,
        /// Device nickname (optional)
        pub nickname: Option<String>,
        /// Whether we have the vault encryption key
        pub has_vault_key: bool,
        /// Plugin version (for compatibility checks)
        pub plugin_version: Option<String>,
        /// One-time pairing nonce (optional, only for new peers)
        #[serde(default)]
        pub pairing_nonce: Option<String>,
        /// Whether this peer supports iroh-blobs transfer (v3+)
        #[serde(default)]
        pub supports_iroh_blobs: bool,
    }

    /// Updates message - contains Loro export data
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Updates {
        /// Loro update payload
        pub data: Vec<u8>,
        /// Number of operations in this update
        pub op_count: usize,
    }

    /// Snapshot request message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct SnapshotRequest {}

    /// Snapshot message - full document
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Snapshot {
        /// Loro snapshot data
        pub data: Vec<u8>,
    }

    /// Sync complete message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct SyncComplete {
        /// Final version vector
        pub version_bytes: Vec<u8>,
    }

    /// Ping message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Ping {
        pub seq: u32,
        pub timestamp: u64,
    }

    /// Pong message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Pong {
        pub seq: u32,
        pub timestamp: u64,
    }

    /// Error message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct SyncError {
        pub code: u8,
        pub message: String,
    }

    /// Error codes
    pub mod error_codes {
        pub const UNKNOWN: u8 = 0;
        pub const VERSION_MISMATCH: u8 = 1;
        pub const VAULT_MISMATCH: u8 = 2;
        pub const INVALID_MESSAGE: u8 = 3;
        pub const INTERNAL_ERROR: u8 = 4;
        /// Pairing nonce invalid, expired, or already used
        pub const PAIRING_REJECTED: u8 = 5;
        /// Both peers have vault keys but they don't match
        /// This happens when two devices independently created the same vault
        pub const KEY_CONFLICT: u8 = 6;
    }

    /// Blob hashes message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct BlobHashes {
        pub hashes: Vec<Hash>,
    }

    /// Blob request message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct BlobRequest {
        pub hashes: Vec<Hash>,
    }

    /// Blob data message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct BlobData {
        pub hash: Hash,
        pub data: Vec<u8>,
        pub mime_type: Option<String>,
    }

    /// Blob sync complete message
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct BlobSyncComplete {
        pub blob_count: usize,
    }

    /// All sync messages
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub enum Message {
        VersionInfo(VersionInfo),
        Updates(Updates),
        SnapshotRequest(SnapshotRequest),
        Snapshot(Snapshot),
        SyncComplete(SyncComplete),
        Ping(Ping),
        Pong(Pong),
        Error(SyncError),
        BlobHashes(BlobHashes),
        BlobRequest(BlobRequest),
        BlobData(BlobData),
        BlobSyncComplete(BlobSyncComplete),
    }

    impl Message {
        pub fn encode(&self) -> io::Result<Vec<u8>> {
            let tag = match self {
                Message::VersionInfo(_) => MessageType::VersionInfo as u8,
                Message::Updates(_) => MessageType::Updates as u8,
                Message::SnapshotRequest(_) => MessageType::SnapshotRequest as u8,
                Message::Snapshot(_) => MessageType::Snapshot as u8,
                Message::SyncComplete(_) => MessageType::SyncComplete as u8,
                Message::Ping(_) => MessageType::Ping as u8,
                Message::Pong(_) => MessageType::Pong as u8,
                Message::Error(_) => MessageType::Error as u8,
                Message::BlobHashes(_) => MessageType::BlobHashes as u8,
                Message::BlobRequest(_) => MessageType::BlobRequest as u8,
                Message::BlobData(_) => MessageType::BlobData as u8,
                Message::BlobSyncComplete(_) => MessageType::BlobSyncComplete as u8,
            };

            let payload = bincode::serialize(self)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

            let mut result = Vec::with_capacity(1 + payload.len());
            result.push(tag);
            result.extend_from_slice(&payload);
            Ok(result)
        }

        pub fn decode(data: &[u8]) -> io::Result<Self> {
            if data.is_empty() {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "empty message"));
            }

            bincode::deserialize(&data[1..])
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }

        pub fn message_type(&self) -> MessageType {
            match self {
                Message::VersionInfo(_) => MessageType::VersionInfo,
                Message::Updates(_) => MessageType::Updates,
                Message::SnapshotRequest(_) => MessageType::SnapshotRequest,
                Message::Snapshot(_) => MessageType::Snapshot,
                Message::SyncComplete(_) => MessageType::SyncComplete,
                Message::Ping(_) => MessageType::Ping,
                Message::Pong(_) => MessageType::Pong,
                Message::Error(_) => MessageType::Error,
                Message::BlobHashes(_) => MessageType::BlobHashes,
                Message::BlobRequest(_) => MessageType::BlobRequest,
                Message::BlobData(_) => MessageType::BlobData,
                Message::BlobSyncComplete(_) => MessageType::BlobSyncComplete,
            }
        }
    }
}

// ============================================================================
// Key Exchange Protocol Messages (/pv/keys/1)
// ============================================================================

pub mod keys {
    use super::*;

    /// Message type tags for key exchange protocol
    #[repr(u8)]
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub enum MessageType {
        /// Request vault key
        Request = 0x30,
        /// Provide vault key
        Response = 0x31,
        /// Key exchange error
        Error = 0x32,
    }

    impl TryFrom<u8> for MessageType {
        type Error = ();
        fn try_from(v: u8) -> Result<Self, ()> {
            match v {
                0x30 => Ok(Self::Request),
                0x31 => Ok(Self::Response),
                0x32 => Ok(Self::Error),
                _ => Err(()),
            }
        }
    }

    /// Request - ask for vault key
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Request {
        /// Our X25519 public key for key encapsulation
        pub public_key: [u8; 32],
        /// Whether we already have a key
        pub has_existing_key: bool,
    }

    /// Response - provide vault key
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Response {
        /// Responder's X25519 public key for key agreement
        pub public_key: [u8; 32],
        /// Encrypted vault key (encrypted with shared secret from ECDH)
        pub encrypted_key: Vec<u8>,
        /// Whether this is a newly generated key
        pub is_new_key: bool,
    }

    /// Error response for key exchange
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct KeyError {
        /// Error code
        pub code: u8,
        /// Error message
        pub message: String,
    }

    /// Key exchange error codes
    pub mod error_codes {
        /// No vault key available
        pub const NO_KEY: u8 = 1;
        /// Key exchange rejected
        pub const REJECTED: u8 = 2;
        /// Invalid public key
        pub const INVALID_KEY: u8 = 3;
    }

    /// All key exchange messages
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub enum Message {
        Request(Request),
        Response(Response),
        Error(KeyError),
    }

    impl Message {
        pub fn encode(&self) -> io::Result<Vec<u8>> {
            let tag = match self {
                Message::Request(_) => MessageType::Request as u8,
                Message::Response(_) => MessageType::Response as u8,
                Message::Error(_) => MessageType::Error as u8,
            };

            let payload = bincode::serialize(self)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

            let mut result = Vec::with_capacity(1 + payload.len());
            result.push(tag);
            result.extend_from_slice(&payload);
            Ok(result)
        }

        pub fn decode(data: &[u8]) -> io::Result<Self> {
            if data.is_empty() {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "empty message"));
            }

            bincode::deserialize(&data[1..])
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }
    }
}

// Mesh protocol messages removed — replaced by iroh-gossip for peer discovery
// and real-time CRDT delta broadcast.

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_info_roundtrip() {
        let msg = sync::Message::VersionInfo(sync::VersionInfo {
            protocol_version: sync::PROTOCOL_VERSION,
            vault_id: [1u8; 32],
            version_bytes: vec![1, 2, 3, 4],
            hostname: "TestDevice".into(),
            nickname: Some("MyDevice".into()),
            has_vault_key: true,
            plugin_version: Some("0.3.0".into()),
            pairing_nonce: Some("abc123".into()),
            supports_iroh_blobs: true,
        });

        let encoded = msg.encode().unwrap();
        let decoded = sync::Message::decode(&encoded).unwrap();

        match decoded {
            sync::Message::VersionInfo(v) => {
                assert_eq!(v.vault_id, [1u8; 32]);
                assert_eq!(v.hostname, "TestDevice");
                assert!(v.has_vault_key);
                assert_eq!(v.pairing_nonce, Some("abc123".into()));
            }
            _ => panic!("wrong message type"),
        }
    }

    #[test]
    fn test_updates_roundtrip() {
        let msg = sync::Message::Updates(sync::Updates {
            data: vec![1, 2, 3, 4, 5],
            op_count: 42,
        });

        let encoded = msg.encode().unwrap();
        let decoded = sync::Message::decode(&encoded).unwrap();

        match decoded {
            sync::Message::Updates(u) => {
                assert_eq!(u.data, vec![1, 2, 3, 4, 5]);
                assert_eq!(u.op_count, 42);
            }
            _ => panic!("wrong message type"),
        }
    }

    #[test]
    fn test_key_exchange_request_roundtrip() {
        let msg = keys::Message::Request(keys::Request {
            public_key: [42u8; 32],
            has_existing_key: false,
        });

        let encoded = msg.encode().unwrap();
        let decoded = keys::Message::decode(&encoded).unwrap();

        match decoded {
            keys::Message::Request(r) => {
                assert_eq!(r.public_key, [42u8; 32]);
                assert!(!r.has_existing_key);
            }
            _ => panic!("wrong message type"),
        }
    }

    #[test]
    fn test_key_exchange_response_roundtrip() {
        let msg = keys::Message::Response(keys::Response {
            public_key: [43u8; 32],
            encrypted_key: vec![1, 2, 3, 4, 5],
            is_new_key: true,
        });

        let encoded = msg.encode().unwrap();
        let decoded = keys::Message::decode(&encoded).unwrap();

        match decoded {
            keys::Message::Response(r) => {
                assert_eq!(r.public_key, [43u8; 32]);
                assert_eq!(r.encrypted_key, vec![1, 2, 3, 4, 5]);
                assert!(r.is_new_key);
            }
            _ => panic!("wrong message type"),
        }
    }
}
