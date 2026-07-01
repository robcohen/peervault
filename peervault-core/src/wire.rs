//! Bincode wire encoding helpers.
//!
//! Centralizes bincode 2.x with `config::legacy()`, which is byte-compatible with
//! bincode 1.x — so upgrading the crate did NOT change the on-wire format used by
//! the sync protocol and blob metadata.

use serde::{de::DeserializeOwned, Serialize};

/// Serialize a value to bytes (bincode 1.x-compatible layout).
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, bincode::error::EncodeError> {
    bincode::serde::encode_to_vec(value, bincode::config::legacy())
}

/// Deserialize a value from bytes.
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, bincode::error::DecodeError> {
    bincode::serde::decode_from_slice(bytes, bincode::config::legacy()).map(|(v, _)| v)
}
