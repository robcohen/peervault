//! Cloud Encryption - XSalsa20-Poly1305 encryption for cloud storage
//!
//! Uses NaCl secretbox (XSalsa20-Poly1305) with:
//! - 32-byte key (from vault key)
//! - 24-byte random nonce (prepended to ciphertext)
//! - 16-byte authentication tag (appended by Poly1305)

use rand::Rng;
use xsalsa20poly1305::{
    aead::{Aead, KeyInit},
    XSalsa20Poly1305, Nonce,
};

/// Nonce size for XSalsa20-Poly1305 (24 bytes)
pub const NONCE_SIZE: usize = 24;

/// Authentication tag size (16 bytes)
pub const TAG_SIZE: usize = 16;

/// Cloud encryption using XSalsa20-Poly1305
pub struct CloudEncryption {
    cipher: XSalsa20Poly1305,
}

impl CloudEncryption {
    /// Create a new encryption instance from a 32-byte vault key
    pub fn new(key: &[u8; 32]) -> Self {
        let cipher = XSalsa20Poly1305::new(key.into());
        Self { cipher }
    }

    /// Encrypt data with a random nonce
    /// Returns: nonce (24 bytes) || ciphertext || tag (16 bytes)
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, EncryptionError> {
        let mut nonce_bytes = [0u8; NONCE_SIZE];
        rand::rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from(nonce_bytes);

        let ciphertext = self.cipher
            .encrypt(&nonce, plaintext)
            .map_err(|_| EncryptionError::EncryptionFailed)?;

        // Prepend nonce to ciphertext
        let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend(ciphertext);

        Ok(result)
    }

    /// Decrypt data (expects nonce || ciphertext || tag format)
    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>, EncryptionError> {
        if data.len() < NONCE_SIZE + TAG_SIZE {
            return Err(EncryptionError::InvalidCiphertext);
        }

        let (nonce_bytes, ciphertext) = data.split_at(NONCE_SIZE);
        let nonce = Nonce::from_slice(nonce_bytes);

        self.cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| EncryptionError::DecryptionFailed)
    }

    /// Calculate overhead added by encryption (nonce + tag)
    pub const fn overhead() -> usize {
        NONCE_SIZE + TAG_SIZE
    }
}

/// Encryption errors
#[derive(Debug, Clone, thiserror::Error)]
pub enum EncryptionError {
    #[error("Encryption failed")]
    EncryptionFailed,

    #[error("Decryption failed (wrong key or corrupted data)")]
    DecryptionFailed,

    #[error("Invalid ciphertext (too short)")]
    InvalidCiphertext,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [0x42u8; 32];
        let encryption = CloudEncryption::new(&key);

        let plaintext = b"Hello, cloud sync!";
        let ciphertext = encryption.encrypt(plaintext).unwrap();

        // Ciphertext should be larger due to nonce + tag
        assert_eq!(ciphertext.len(), plaintext.len() + CloudEncryption::overhead());

        let decrypted = encryption.decrypt(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_different_nonces() {
        let key = [0x42u8; 32];
        let encryption = CloudEncryption::new(&key);

        let plaintext = b"Same message";
        let ct1 = encryption.encrypt(plaintext).unwrap();
        let ct2 = encryption.encrypt(plaintext).unwrap();

        // Different nonces should produce different ciphertext
        assert_ne!(ct1, ct2);

        // But both should decrypt to same plaintext
        assert_eq!(encryption.decrypt(&ct1).unwrap(), plaintext);
        assert_eq!(encryption.decrypt(&ct2).unwrap(), plaintext);
    }

    #[test]
    fn test_wrong_key() {
        let key1 = [0x42u8; 32];
        let key2 = [0x43u8; 32];

        let enc1 = CloudEncryption::new(&key1);
        let enc2 = CloudEncryption::new(&key2);

        let plaintext = b"Secret data";
        let ciphertext = enc1.encrypt(plaintext).unwrap();

        // Wrong key should fail decryption
        assert!(enc2.decrypt(&ciphertext).is_err());
    }

    #[test]
    fn test_tampered_data() {
        let key = [0x42u8; 32];
        let encryption = CloudEncryption::new(&key);

        let plaintext = b"Important data";
        let mut ciphertext = encryption.encrypt(plaintext).unwrap();

        // Tamper with ciphertext
        if let Some(byte) = ciphertext.get_mut(NONCE_SIZE + 5) {
            *byte ^= 0xFF;
        }

        // Should fail authentication
        assert!(encryption.decrypt(&ciphertext).is_err());
    }

    #[test]
    fn test_empty_plaintext() {
        let key = [0x42u8; 32];
        let encryption = CloudEncryption::new(&key);

        let plaintext = b"";
        let ciphertext = encryption.encrypt(plaintext).unwrap();

        assert_eq!(ciphertext.len(), CloudEncryption::overhead());

        let decrypted = encryption.decrypt(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_large_data() {
        let key = [0x42u8; 32];
        let encryption = CloudEncryption::new(&key);

        // 1MB of data
        let plaintext: Vec<u8> = (0..1_000_000).map(|i| (i % 256) as u8).collect();
        let ciphertext = encryption.encrypt(&plaintext).unwrap();

        let decrypted = encryption.decrypt(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }
}
