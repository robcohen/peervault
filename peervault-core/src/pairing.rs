//! Pairing-ticket encoding — the composite ticket a host shares to invite a
//! new device.
//!
//! Format (identical to the TypeScript hosts, so tickets interop across
//! Obsidian, VSCode, and native daemons):
//!
//! `base64( JSON({ t: <iroh transport ticket>, k: <vault key hex>,
//!                 v: <vault id hex>, n: <one-time nonce hex> }) )`

use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// A parsed pairing ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingTicket {
    /// The iroh transport ticket (endpoint addresses).
    pub transport: String,
    /// Vault encryption key (hex).
    pub key_hex: String,
    /// Vault id (hex) — the joiner adopts this.
    pub vault_id: String,
    /// One-time pairing nonce (hex), registered on the inviting side.
    pub nonce: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Wire {
    t: String,
    k: String,
    v: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    n: Option<String>,
}

/// Encode a pairing ticket (TS-compatible).
pub fn encode(ticket: &PairingTicket) -> String {
    let wire = Wire {
        t: ticket.transport.clone(),
        k: ticket.key_hex.clone(),
        v: ticket.vault_id.clone(),
        n: ticket.nonce.clone(),
    };
    // Serializing a struct of strings cannot fail.
    let json = serde_json::to_string(&wire).expect("serialize pairing ticket");
    base64::engine::general_purpose::STANDARD.encode(json)
}

/// Decode a pairing ticket. Returns `None` if the input is not a pairing
/// ticket (e.g. a bare iroh transport ticket) — mirroring the TS parser.
pub fn decode(s: &str) -> Option<PairingTicket> {
    let json = base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()?;
    let wire: Wire = serde_json::from_slice(&json).ok()?;
    if wire.t.is_empty() || wire.k.is_empty() || wire.v.is_empty() {
        return None;
    }
    Some(PairingTicket {
        transport: wire.t,
        key_hex: wire.k,
        vault_id: wire.v,
        nonce: wire.n,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let t = PairingTicket {
            transport: "nodeadbeef".into(),
            key_hex: "aa".repeat(32),
            vault_id: "bb".repeat(32),
            nonce: Some("cc".repeat(32)),
        };
        assert_eq!(decode(&encode(&t)).unwrap(), t);
    }

    #[test]
    fn parses_ts_generated_ticket() {
        // Byte-for-byte what the TS host produces:
        // btoa(JSON.stringify({t: "ticket123", k: "deadbeef", v: "cafe", n: "0123"}))
        let ts = "eyJ0IjoidGlja2V0MTIzIiwiayI6ImRlYWRiZWVmIiwidiI6ImNhZmUiLCJuIjoiMDEyMyJ9";
        let parsed = decode(ts).unwrap();
        assert_eq!(parsed.transport, "ticket123");
        assert_eq!(parsed.key_hex, "deadbeef");
        assert_eq!(parsed.vault_id, "cafe");
        assert_eq!(parsed.nonce.as_deref(), Some("0123"));
    }

    #[test]
    fn rejects_bare_transport_ticket() {
        assert!(decode("nodeadbeefnotbase64json").is_none());
    }
}
