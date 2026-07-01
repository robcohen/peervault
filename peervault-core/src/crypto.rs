//! End-to-End Encryption for PeerVault
//!
//! This module provides content encryption using XChaCha20-Poly1305.
//! All document content is encrypted before storage and syncing.
//!
//! ## Key Hierarchy
//!
//! ```text
//! User Passphrase (optional)
//!       |
//!       v (Argon2id, memory-hard)
//! Vault Master Key (32 bytes)
//!       |
//!       +---> Content Encryption Key (derived per-document)
//!       |
//!       +---> Key Wrapping Key (for sharing vault key with peers)
//! ```
//!
//! ## Encryption Format
//!
//! Encrypted content format: `nonce (24 bytes) || ciphertext || tag (16 bytes)`
//!
//! ## Key Exchange
//!
//! Uses ECIES (Elliptic Curve Integrated Encryption Scheme) with X25519 for
//! secure key wrapping between peers.

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;

/// Size of the vault master key in bytes
pub const KEY_SIZE: usize = 32;

/// Size of the XChaCha20 nonce in bytes
pub const NONCE_SIZE: usize = 24;

/// Size of the Poly1305 authentication tag
pub const TAG_SIZE: usize = 16;

/// Encryption overhead (nonce + tag)
pub const OVERHEAD: usize = NONCE_SIZE + TAG_SIZE;

/// Error type for crypto operations
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// Key derivation failed
    KeyDerivation(String),
    /// Encryption failed
    Encryption(String),
    /// Decryption failed (likely wrong key or tampered data)
    Decryption(String),
    /// Invalid input data
    InvalidInput(String),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::KeyDerivation(msg) => write!(f, "Key derivation error: {}", msg),
            CryptoError::Encryption(msg) => write!(f, "Encryption error: {}", msg),
            CryptoError::Decryption(msg) => write!(f, "Decryption error: {}", msg),
            CryptoError::InvalidInput(msg) => write!(f, "Invalid input: {}", msg),
        }
    }
}

impl std::error::Error for CryptoError {}

/// Result type for crypto operations
pub type CryptoResult<T> = Result<T, CryptoError>;

/// Vault encryption key
///
/// This is the master key used to encrypt all content in a vault.
/// It can be:
/// - Generated randomly for a new vault
/// - Derived from a user passphrase
/// - Received from a peer during pairing
#[derive(Clone)]
pub struct VaultKey {
    /// The raw key bytes
    key: [u8; KEY_SIZE],
}

impl VaultKey {
    /// Generate a new random vault key
    pub fn generate() -> Self {
        let mut key = [0u8; KEY_SIZE];
        rand::thread_rng().fill_bytes(&mut key);
        Self { key }
    }

    /// Derive a vault key from a passphrase.
    ///
    /// Uses Argon2id (memory-hard) with the vault ID as the salt. HKDF (the previous
    /// KDF) is fast and lets an attacker who obtains any ciphertext brute-force a
    /// low-entropy passphrase at billions/sec; Argon2id makes that far more expensive.
    ///
    /// The vault ID is used as a deterministic salt so both devices derive the same
    /// key from the same passphrase without having to store/exchange a random salt.
    pub fn from_passphrase(passphrase: &str, vault_id: &[u8; 32]) -> CryptoResult<Self> {
        if passphrase.is_empty() {
            return Err(CryptoError::InvalidInput("Passphrase cannot be empty".into()));
        }

        let mut key = [0u8; KEY_SIZE];
        argon2::Argon2::default()
            .hash_password_into(passphrase.as_bytes(), vault_id, &mut key)
            .map_err(|e| CryptoError::KeyDerivation(e.to_string()))?;

        Ok(Self { key })
    }

    /// Create a vault key from raw bytes
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != KEY_SIZE {
            return Err(CryptoError::InvalidInput(format!(
                "Key must be {} bytes, got {}",
                KEY_SIZE,
                bytes.len()
            )));
        }

        let mut key = [0u8; KEY_SIZE];
        key.copy_from_slice(bytes);
        Ok(Self { key })
    }

    /// Get the raw key bytes
    ///
    /// Use with caution - this exposes the key material.
    pub fn as_bytes(&self) -> &[u8; KEY_SIZE] {
        &self.key
    }

    /// Encrypt content
    ///
    /// Returns: `nonce (24 bytes) || ciphertext || tag (16 bytes)`
    pub fn encrypt(&self, plaintext: &[u8]) -> CryptoResult<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new_from_slice(&self.key)
            .map_err(|e| CryptoError::Encryption(e.to_string()))?;

        // Generate random nonce
        let mut nonce_bytes = [0u8; NONCE_SIZE];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);

        // Encrypt
        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| CryptoError::Encryption(e.to_string()))?;

        // Prepend nonce to ciphertext
        let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);

        Ok(result)
    }

    /// Decrypt content
    ///
    /// Input format: `nonce (24 bytes) || ciphertext || tag (16 bytes)`
    pub fn decrypt(&self, ciphertext: &[u8]) -> CryptoResult<Vec<u8>> {
        if ciphertext.len() < OVERHEAD {
            return Err(CryptoError::InvalidInput(format!(
                "Ciphertext too short: {} bytes, minimum {}",
                ciphertext.len(),
                OVERHEAD
            )));
        }

        let cipher = XChaCha20Poly1305::new_from_slice(&self.key)
            .map_err(|e| CryptoError::Decryption(e.to_string()))?;

        // Extract nonce and ciphertext
        let nonce = XNonce::from_slice(&ciphertext[..NONCE_SIZE]);
        let encrypted = &ciphertext[NONCE_SIZE..];

        // Decrypt
        cipher
            .decrypt(nonce, encrypted)
            .map_err(|_| CryptoError::Decryption("Decryption failed - wrong key or tampered data".into()))
    }

    /// Wrap this key for sharing with a peer using ECIES
    ///
    /// Uses the peer's X25519 public key to encrypt our vault key.
    /// The peer can then unwrap it with their private key.
    ///
    /// Note: The `_our_secret_key` parameter is no longer needed with ECIES
    /// (ephemeral keys are generated internally), but kept for API compatibility.
    pub fn wrap_for_peer(&self, peer_public_key: &[u8; 32], _our_secret_key: &[u8; 32]) -> CryptoResult<Vec<u8>> {
        ecies::encrypt(peer_public_key, &self.key)
            .map_err(|e| CryptoError::Encryption(format!("ECIES encrypt failed: {}", e)))
    }

    /// Unwrap a vault key received from a peer using ECIES
    ///
    /// Note: The `_peer_public_key` parameter is no longer needed with ECIES
    /// (the ephemeral public key is included in the ciphertext), but kept for API compatibility.
    pub fn unwrap_from_peer(
        wrapped_key: &[u8],
        _peer_public_key: &[u8; 32],
        our_secret_key: &[u8; 32],
    ) -> CryptoResult<Self> {
        let key_bytes = ecies::decrypt(our_secret_key, wrapped_key)
            .map_err(|e| CryptoError::Decryption(format!("ECIES decrypt failed: {}", e)))?;

        Self::from_bytes(&key_bytes)
    }
}

impl std::fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Don't expose key material in debug output
        f.debug_struct("VaultKey")
            .field("key", &"[REDACTED]")
            .finish()
    }
}

impl Drop for VaultKey {
    fn drop(&mut self) {
        // Securely wipe key material on drop. `zeroize` uses volatile writes + a
        // compiler fence so the zeroing can't be optimized away (unlike `fill(0)`).
        use zeroize::Zeroize;
        self.key.zeroize();
    }
}

/// Content encryptor that wraps a VaultKey
///
/// Provides a convenient interface for encrypting document content.
pub struct ContentEncryptor {
    key: VaultKey,
}

impl ContentEncryptor {
    /// Create a new content encryptor
    pub fn new(key: VaultKey) -> Self {
        Self { key }
    }

    /// Encrypt document content
    pub fn encrypt(&self, content: &[u8]) -> CryptoResult<Vec<u8>> {
        self.key.encrypt(content)
    }

    /// Decrypt document content
    pub fn decrypt(&self, encrypted: &[u8]) -> CryptoResult<Vec<u8>> {
        self.key.decrypt(encrypted)
    }

    /// Check if content appears to be encrypted
    ///
    /// This is a heuristic check - encrypted content should be at least
    /// OVERHEAD bytes and not valid UTF-8 in most cases.
    pub fn is_likely_encrypted(data: &[u8]) -> bool {
        data.len() >= OVERHEAD
    }

    /// Get the encryption overhead in bytes
    pub fn overhead() -> usize {
        OVERHEAD
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_key() {
        let key1 = VaultKey::generate();
        let key2 = VaultKey::generate();

        // Keys should be different
        assert_ne!(key1.as_bytes(), key2.as_bytes());
    }

    #[test]
    fn test_key_from_passphrase() {
        let vault_id = [1u8; 32];
        let key1 = VaultKey::from_passphrase("my-secret-passphrase", &vault_id).unwrap();
        let key2 = VaultKey::from_passphrase("my-secret-passphrase", &vault_id).unwrap();

        // Same passphrase + vault_id should produce same key
        assert_eq!(key1.as_bytes(), key2.as_bytes());

        // Different passphrase should produce different key
        let key3 = VaultKey::from_passphrase("different-passphrase", &vault_id).unwrap();
        assert_ne!(key1.as_bytes(), key3.as_bytes());

        // Different vault_id should produce different key
        let vault_id2 = [2u8; 32];
        let key4 = VaultKey::from_passphrase("my-secret-passphrase", &vault_id2).unwrap();
        assert_ne!(key1.as_bytes(), key4.as_bytes());
    }

    #[test]
    fn test_encrypt_decrypt() {
        let key = VaultKey::generate();
        let plaintext = b"Hello, World! This is secret content.";

        let ciphertext = key.encrypt(plaintext).unwrap();

        // Ciphertext should be longer than plaintext (nonce + tag)
        assert_eq!(ciphertext.len(), plaintext.len() + OVERHEAD);

        // Ciphertext should be different from plaintext
        assert_ne!(&ciphertext[NONCE_SIZE..NONCE_SIZE + plaintext.len()], plaintext);

        // Decryption should recover plaintext
        let decrypted = key.decrypt(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_empty() {
        let key = VaultKey::generate();
        let plaintext = b"";

        let ciphertext = key.encrypt(plaintext).unwrap();
        assert_eq!(ciphertext.len(), OVERHEAD);

        let decrypted = key.decrypt(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_wrong_key() {
        let key1 = VaultKey::generate();
        let key2 = VaultKey::generate();
        let plaintext = b"Secret message";

        let ciphertext = key1.encrypt(plaintext).unwrap();

        // Decryption with wrong key should fail
        let result = key2.decrypt(&ciphertext);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_tampered() {
        let key = VaultKey::generate();
        let plaintext = b"Secret message";

        let mut ciphertext = key.encrypt(plaintext).unwrap();

        // Tamper with the ciphertext
        let mid = ciphertext.len() / 2;
        ciphertext[mid] ^= 0xFF;

        // Decryption should fail
        let result = key.decrypt(&ciphertext);
        assert!(result.is_err());
    }

    #[test]
    fn test_key_wrapping() {
        // Generate key pairs for two peers using ecies
        let (bob_secret, bob_public) = ecies::utils::generate_keypair();

        // Alice has a vault key she wants to share with Bob
        let vault_key = VaultKey::generate();

        // Alice wraps the key for Bob (only needs Bob's public key)
        // The second parameter is ignored with ECIES but kept for API compat
        let dummy_secret = [0u8; 32];
        let wrapped = vault_key
            .wrap_for_peer(bob_public.as_bytes(), &dummy_secret)
            .unwrap();

        // Bob unwraps the key (only needs his secret key)
        // The second parameter is ignored with ECIES but kept for API compat
        let dummy_public = [0u8; 32];
        let unwrapped = VaultKey::unwrap_from_peer(
            &wrapped,
            &dummy_public,
            bob_secret.as_bytes(),
        ).unwrap();

        // The keys should match
        assert_eq!(vault_key.as_bytes(), unwrapped.as_bytes());
    }

    #[test]
    fn test_content_encryptor() {
        let key = VaultKey::generate();
        let encryptor = ContentEncryptor::new(key);

        let content = b"Document content here";
        let encrypted = encryptor.encrypt(content).unwrap();
        let decrypted = encryptor.decrypt(&encrypted).unwrap();

        assert_eq!(decrypted, content);
        assert!(ContentEncryptor::is_likely_encrypted(&encrypted));
        assert!(!ContentEncryptor::is_likely_encrypted(content));
    }
}
