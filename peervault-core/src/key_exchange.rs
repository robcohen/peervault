//! Vault Key Exchange Service
//!
//! Handles peer-to-peer vault key exchange during pairing using ECIES.
//!
//! ## Protocol Flow (ECIES)
//!
//! 1. Requester sends Request with their X25519 public key
//! 2. Responder encrypts vault key using ECIES (with requester's public key)
//! 3. Responder sends Response with encrypted vault key
//! 4. Requester decrypts vault key using their secret key
//!
//! ECIES (Elliptic Curve Integrated Encryption Scheme) handles:
//! - Ephemeral key generation
//! - ECDH key agreement
//! - Key derivation (HKDF)
//! - Authenticated encryption (XChaCha20-Poly1305)

use ecies::{PublicKey, SecretKey};

use crate::crypto::{VaultKey, CryptoError};
use crate::protocol::keys::{Message, Request, Response, KeyError, error_codes};

/// Key exchange session state
pub struct KeyExchangeSession {
    /// Our ephemeral secret key
    secret_key: SecretKey,
    /// Our ephemeral public key
    public_key: PublicKey,
    /// Whether we're the initiator (requester) or responder
    is_initiator: bool,
    /// The peer's public key bytes (set after receiving their message)
    peer_public_key: Option<[u8; 32]>,
}

impl KeyExchangeSession {
    /// Create a new key exchange session as the initiator (requesting a key)
    pub fn new_initiator() -> Self {
        let (secret_key, public_key) = ecies::utils::generate_keypair();

        Self {
            secret_key,
            public_key,
            is_initiator: true,
            peer_public_key: None,
        }
    }

    /// Create a new key exchange session as the responder (providing a key)
    pub fn new_responder() -> Self {
        let (secret_key, public_key) = ecies::utils::generate_keypair();

        Self {
            secret_key,
            public_key,
            is_initiator: false,
            peer_public_key: None,
        }
    }

    /// Get our public key (to send to peer)
    pub fn public_key(&self) -> [u8; 32] {
        *self.public_key.as_bytes()
    }

    /// Create a key request message (as initiator)
    pub fn create_request(&self, has_existing_key: bool) -> Message {
        Message::Request(Request {
            public_key: *self.public_key.as_bytes(),
            has_existing_key,
        })
    }

    /// Process an incoming request and create response (as responder)
    ///
    /// Returns the Response message to send back.
    /// If we don't have a vault key, returns an error.
    pub fn handle_request(
        &mut self,
        request: &Request,
        vault_key: Option<&VaultKey>,
    ) -> Result<Message, KeyExchangeError> {
        // Store peer's public key
        self.peer_public_key = Some(request.public_key);

        // If peer already has a key and we don't, that's an error
        // (we can't provide what we don't have)
        let vault_key = match vault_key {
            Some(key) => key,
            None => {
                return Ok(Message::Error(KeyError {
                    code: error_codes::NO_KEY,
                    message: "No vault key available".into(),
                }));
            }
        };

        // Encrypt the vault key for the peer using ECIES
        // (our secret key is not needed - ECIES uses ephemeral keys internally)
        let encrypted_key = vault_key
            .wrap_for_peer(&request.public_key, self.secret_key.as_bytes())
            .map_err(KeyExchangeError::Crypto)?;

        Ok(Message::Response(Response {
            public_key: *self.public_key.as_bytes(),
            encrypted_key,
            is_new_key: false, // We're sharing an existing key
        }))
    }

    /// Process an incoming response and extract the vault key (as initiator)
    pub fn handle_response(&mut self, response: &Response) -> Result<VaultKey, KeyExchangeError> {
        // Store peer's public key
        self.peer_public_key = Some(response.public_key);

        // Decrypt the vault key using our secret key
        // (peer public key is not needed - ECIES includes ephemeral pubkey in ciphertext)
        let vault_key = VaultKey::unwrap_from_peer(
            &response.encrypted_key,
            &response.public_key,
            self.secret_key.as_bytes(),
        )
        .map_err(KeyExchangeError::Crypto)?;

        Ok(vault_key)
    }

    /// Create a response with a newly generated key (for new vault creation)
    pub fn create_new_key_response(
        &mut self,
        peer_public_key: &[u8; 32],
    ) -> Result<(VaultKey, Message), KeyExchangeError> {
        // Store peer's public key
        self.peer_public_key = Some(*peer_public_key);

        // Generate a new vault key
        let vault_key = VaultKey::generate();

        // Encrypt it for the peer using ECIES
        let encrypted_key = vault_key
            .wrap_for_peer(peer_public_key, self.secret_key.as_bytes())
            .map_err(KeyExchangeError::Crypto)?;

        let response = Message::Response(Response {
            public_key: *self.public_key.as_bytes(),
            encrypted_key,
            is_new_key: true,
        });

        Ok((vault_key, response))
    }
}

impl Drop for KeyExchangeSession {
    fn drop(&mut self) {
        // ecies::SecretKey handles its own zeroization
    }
}

/// Key exchange errors
#[derive(Debug)]
pub enum KeyExchangeError {
    /// Cryptographic operation failed
    Crypto(CryptoError),
    /// Protocol error
    Protocol(String),
    /// Peer rejected key exchange
    Rejected(String),
}

impl std::fmt::Display for KeyExchangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyExchangeError::Crypto(e) => write!(f, "Crypto error: {}", e),
            KeyExchangeError::Protocol(msg) => write!(f, "Protocol error: {}", msg),
            KeyExchangeError::Rejected(msg) => write!(f, "Key exchange rejected: {}", msg),
        }
    }
}

impl std::error::Error for KeyExchangeError {}

impl From<CryptoError> for KeyExchangeError {
    fn from(e: CryptoError) -> Self {
        KeyExchangeError::Crypto(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_exchange_flow() {
        // Alice wants to get the vault key from Bob

        // Alice creates a session as initiator
        let mut alice = KeyExchangeSession::new_initiator();
        let request = alice.create_request(false);

        // Bob has the vault key
        let bob_vault_key = VaultKey::generate();
        let mut bob = KeyExchangeSession::new_responder();

        // Bob receives request and creates response
        let request_data = match request {
            Message::Request(r) => r,
            _ => panic!("Expected request"),
        };
        let response = bob.handle_request(&request_data, Some(&bob_vault_key)).unwrap();

        // Alice receives response and extracts key
        let response_data = match response {
            Message::Response(r) => r,
            _ => panic!("Expected response"),
        };
        let alice_vault_key = alice.handle_response(&response_data).unwrap();

        // Keys should match
        assert_eq!(alice_vault_key.as_bytes(), bob_vault_key.as_bytes());
    }

    #[test]
    fn test_new_key_generation() {
        // Alice requests a key, Bob generates a new one

        let mut alice = KeyExchangeSession::new_initiator();
        let request = alice.create_request(false);

        let mut bob = KeyExchangeSession::new_responder();

        // Get Alice's public key from the request
        let alice_public = match &request {
            Message::Request(r) => r.public_key,
            _ => panic!("Expected request"),
        };

        // Bob creates a new key
        let (bob_vault_key, response) = bob.create_new_key_response(&alice_public).unwrap();

        // Verify it's marked as a new key
        let response_data = match response {
            Message::Response(r) => {
                assert!(r.is_new_key);
                r
            }
            _ => panic!("Expected response"),
        };

        // Alice extracts the key
        let alice_vault_key = alice.handle_response(&response_data).unwrap();

        // Keys should match
        assert_eq!(alice_vault_key.as_bytes(), bob_vault_key.as_bytes());
    }

    #[test]
    fn test_no_key_error() {
        let mut alice = KeyExchangeSession::new_initiator();
        let request = alice.create_request(false);

        let mut bob = KeyExchangeSession::new_responder();

        // Bob has no key
        let request_data = match request {
            Message::Request(r) => r,
            _ => panic!("Expected request"),
        };
        let response = bob.handle_request(&request_data, None).unwrap();

        // Should get an error response
        match response {
            Message::Error(e) => {
                assert_eq!(e.code, error_codes::NO_KEY);
            }
            _ => panic!("Expected error"),
        }
    }

    #[test]
    fn test_message_roundtrip() {
        let session = KeyExchangeSession::new_initiator();
        let request = session.create_request(true);

        // Encode and decode
        let encoded = request.encode().unwrap();
        let decoded = Message::decode(&encoded).unwrap();

        match decoded {
            Message::Request(r) => {
                assert_eq!(r.public_key, session.public_key());
                assert!(r.has_existing_key);
            }
            _ => panic!("Wrong message type"),
        }
    }
}
