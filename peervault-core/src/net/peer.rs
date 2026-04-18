//! Peer identity and ticket types
//!
//! Wraps Iroh's EndpointId and ticket format for P2P connections.

use iroh::EndpointId;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Peer identifier - wraps Iroh's EndpointId (ed25519 public key)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PeerId(pub EndpointId);

impl PeerId {
    /// Create from raw bytes (32 bytes ed25519 public key)
    pub fn from_bytes(bytes: &[u8; 32]) -> Self {
        Self(EndpointId::from_bytes(bytes).expect("valid 32 byte key"))
    }

    /// Get the raw bytes
    pub fn as_bytes(&self) -> [u8; 32] {
        *self.0.as_bytes()
    }

    /// Get the inner EndpointId
    pub fn inner(&self) -> &EndpointId {
        &self.0
    }
}

impl From<EndpointId> for PeerId {
    fn from(endpoint_id: EndpointId) -> Self {
        Self(endpoint_id)
    }
}

impl From<PeerId> for EndpointId {
    fn from(peer_id: PeerId) -> Self {
        peer_id.0
    }
}

impl fmt::Display for PeerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for PeerId {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let endpoint_id = EndpointId::from_str(s)?;
        Ok(Self(endpoint_id))
    }
}

/// Connection ticket for peer discovery
///
/// Contains the peer's NodeId and relay/address hints.
/// Serializes to a compact string for sharing via QR codes, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    /// The peer's node ID
    pub node_id: PeerId,
    /// Relay URL hint (if known)
    pub relay_url: Option<String>,
    /// Direct addresses (IP:port) if available
    pub addrs: Vec<String>,
}

impl Ticket {
    /// Create a new ticket with just a node ID
    pub fn new(node_id: PeerId) -> Self {
        Self {
            node_id,
            relay_url: None,
            addrs: Vec::new(),
        }
    }

    /// Create a ticket with relay URL
    pub fn with_relay(node_id: PeerId, relay_url: String) -> Self {
        Self {
            node_id,
            relay_url: Some(relay_url),
            addrs: Vec::new(),
        }
    }

    /// Add direct addresses
    pub fn with_addrs(mut self, addrs: Vec<String>) -> Self {
        self.addrs = addrs;
        self
    }

    /// Serialize to a compact string (base64 JSON for now, could use more compact format)
    pub fn to_string(&self) -> String {
        use base64::Engine;
        let json = serde_json::to_vec(self).expect("ticket serialization");
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&json)
    }

    /// Parse from compact string
    pub fn from_string(s: &str) -> anyhow::Result<Self> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s)?;
        let ticket: Ticket = serde_json::from_slice(&bytes)?;
        Ok(ticket)
    }
}

impl fmt::Display for Ticket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ticket_roundtrip() {
        let node_id = PeerId::from_bytes(&[1u8; 32]);
        let ticket = Ticket::with_relay(node_id, "https://relay.example.com".to_string())
            .with_addrs(vec!["192.168.1.1:4433".to_string()]);

        let encoded = ticket.to_string();
        let decoded = Ticket::from_string(&encoded).unwrap();

        assert_eq!(ticket.node_id, decoded.node_id);
        assert_eq!(ticket.relay_url, decoded.relay_url);
        assert_eq!(ticket.addrs, decoded.addrs);
    }
}
