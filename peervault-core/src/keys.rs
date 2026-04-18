//! Key Manager - Vault encryption key management
//!
//! Handles:
//! - Vault key storage (encrypted with device secret)
//! - Key exchange with peers using ECIES (X25519 + XChaCha20-Poly1305)
//! - Key derivation for cloud backup encryption

use std::sync::Arc;
use ecies::{SecretKey, PublicKey};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use sha2::{Sha256, Digest};
use crate::host::HostInterface;
use crate::error::CoreError;

const STORAGE_KEY_VAULT_KEY: &str = "peervault:vault-key";
const STORAGE_KEY_DEVICE_SECRET: &str = "peervault:device-secret";

/// Manages the vault encryption key
pub struct KeyManager {
    host: Arc<dyn HostInterface>,
    /// Cached decrypted vault key (if we have it)
    cached_key: Option<[u8; 32]>,
    /// Our static X25519 key pair for key exchange (ECIES)
    exchange_secret: Option<SecretKey>,
    exchange_public: Option<PublicKey>,
    /// Device secret for encrypting vault key at rest
    device_secret: Option<[u8; 32]>,
}

impl KeyManager {
    pub fn new(host: Arc<dyn HostInterface>) -> Result<Self, CoreError> {
        Ok(Self {
            host,
            cached_key: None,
            exchange_secret: None,
            exchange_public: None,
            device_secret: None,
        })
    }

    /// Check if we have the vault key
    pub fn has_key(&self) -> bool {
        self.cached_key.is_some()
    }

    /// Get the vault key (if we have it)
    pub fn get_key(&self) -> Option<&[u8; 32]> {
        self.cached_key.as_ref()
    }

    /// Set the vault key
    pub fn set_key(&mut self, key: &[u8]) -> Result<(), CoreError> {
        if key.len() != 32 {
            return Err(CoreError::Crypto("vault key must be 32 bytes".into()));
        }

        let mut vault_key = [0u8; 32];
        vault_key.copy_from_slice(key);
        self.cached_key = Some(vault_key);

        Ok(())
    }

    /// Generate a new vault key
    pub fn generate_key(&mut self) -> Result<[u8; 32], CoreError> {
        let key = self.host.random_bytes(32);
        let mut vault_key = [0u8; 32];
        vault_key.copy_from_slice(&key);
        self.set_key(&vault_key)?;
        Ok(vault_key)
    }

    /// Ensure we have an exchange keypair
    fn ensure_exchange_keypair(&mut self) {
        if self.exchange_secret.is_none() {
            // Generate new keypair using ecies
            let (secret, public) = ecies::utils::generate_keypair();
            self.exchange_secret = Some(secret);
            self.exchange_public = Some(public);
        }
    }

    /// Ensure we have a device secret for encrypting vault key at rest
    fn ensure_device_secret(&mut self) {
        if self.device_secret.is_none() {
            let secret_bytes = self.host.random_bytes(32);
            let mut secret_arr = [0u8; 32];
            secret_arr.copy_from_slice(&secret_bytes);
            self.device_secret = Some(secret_arr);
        }
    }

    /// Get our public key for key exchange
    pub fn exchange_public_key(&mut self) -> [u8; 32] {
        self.ensure_exchange_keypair();
        *self.exchange_public.as_ref().unwrap().as_bytes()
    }

    /// Encrypt vault key for a peer's public key using ECIES
    ///
    /// ECIES handles ephemeral key generation, ECDH, key derivation, and encryption internally.
    pub fn encrypt_key_for_peer(&self, peer_public_key: &[u8; 32]) -> Result<Vec<u8>, CoreError> {
        let vault_key = self.cached_key.ok_or_else(|| {
            CoreError::Crypto("no vault key to encrypt".into())
        })?;

        // ECIES encrypt - handles everything internally
        ecies::encrypt(peer_public_key, &vault_key)
            .map_err(|e| CoreError::Crypto(format!("ECIES encryption failed: {}", e)))
    }

    /// Decrypt vault key from peer using ECIES
    pub fn decrypt_key_from_peer(&mut self, encrypted: &[u8]) -> Result<(), CoreError> {
        self.ensure_exchange_keypair();
        let our_secret = self.exchange_secret.as_ref().unwrap();

        // ECIES decrypt - handles everything internally
        let plaintext = ecies::decrypt(our_secret.as_bytes(), encrypted)
            .map_err(|e| CoreError::Crypto(format!("ECIES decryption failed: {}", e)))?;

        if plaintext.len() != 32 {
            return Err(CoreError::Crypto(format!(
                "decrypted key wrong size: {} bytes",
                plaintext.len()
            )));
        }

        let mut vault_key = [0u8; 32];
        vault_key.copy_from_slice(&plaintext);
        self.cached_key = Some(vault_key);

        Ok(())
    }

    /// Compute key ID (SHA-256 hash of vault key)
    pub fn key_id(&self) -> Option<[u8; 32]> {
        self.cached_key.map(|key| {
            let mut hasher = Sha256::new();
            hasher.update(&key);
            hasher.finalize().into()
        })
    }

    /// Encrypt data with the vault key (for cloud backup)
    pub fn encrypt_data(&self, data: &[u8]) -> Result<Vec<u8>, CoreError> {
        let vault_key = self.cached_key.ok_or_else(|| {
            CoreError::Crypto("no vault key".into())
        })?;

        // Generate nonce
        let nonce_bytes = self.host.random_bytes(12);
        let nonce = Nonce::from_slice(&nonce_bytes);

        // Encrypt
        let cipher = ChaCha20Poly1305::new_from_slice(&vault_key)
            .map_err(|e| CoreError::Crypto(format!("cipher init failed: {}", e)))?;
        let ciphertext = cipher.encrypt(nonce, data)
            .map_err(|e| CoreError::Crypto(format!("encryption failed: {}", e)))?;

        // Return nonce || ciphertext
        let mut result = Vec::with_capacity(12 + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);

        Ok(result)
    }

    /// Decrypt data with the vault key (for cloud backup)
    pub fn decrypt_data(&self, encrypted: &[u8]) -> Result<Vec<u8>, CoreError> {
        if encrypted.len() < 12 + 16 {
            return Err(CoreError::Crypto("encrypted data too short".into()));
        }

        let vault_key = self.cached_key.ok_or_else(|| {
            CoreError::Crypto("no vault key".into())
        })?;

        let nonce = Nonce::from_slice(&encrypted[..12]);
        let ciphertext = &encrypted[12..];

        let cipher = ChaCha20Poly1305::new_from_slice(&vault_key)
            .map_err(|e| CoreError::Crypto(format!("cipher init failed: {}", e)))?;
        cipher.decrypt(nonce, ciphertext)
            .map_err(|e| CoreError::Crypto(format!("decryption failed: {}", e)))
    }

    /// Encrypt vault key for storage using device secret
    fn encrypt_for_storage(&self, vault_key: &[u8; 32]) -> Result<Vec<u8>, CoreError> {
        let device_secret = self.device_secret.ok_or_else(|| {
            CoreError::Crypto("no device secret".into())
        })?;

        let nonce_bytes = self.host.random_bytes(12);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let cipher = ChaCha20Poly1305::new_from_slice(&device_secret)
            .map_err(|e| CoreError::Crypto(format!("cipher init failed: {}", e)))?;
        let ciphertext = cipher.encrypt(nonce, vault_key.as_ref())
            .map_err(|e| CoreError::Crypto(format!("encryption failed: {}", e)))?;

        let mut result = Vec::with_capacity(12 + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);

        Ok(result)
    }

    /// Decrypt vault key from storage using device secret
    fn decrypt_from_storage(&self, encrypted: &[u8]) -> Result<[u8; 32], CoreError> {
        if encrypted.len() < 12 + 32 + 16 {
            return Err(CoreError::Crypto("stored key too short".into()));
        }

        let device_secret = self.device_secret.ok_or_else(|| {
            CoreError::Crypto("no device secret".into())
        })?;

        let nonce = Nonce::from_slice(&encrypted[..12]);
        let ciphertext = &encrypted[12..];

        let cipher = ChaCha20Poly1305::new_from_slice(&device_secret)
            .map_err(|e| CoreError::Crypto(format!("cipher init failed: {}", e)))?;
        let plaintext = cipher.decrypt(nonce, ciphertext)
            .map_err(|e| CoreError::Crypto(format!("decryption failed: {}", e)))?;

        if plaintext.len() != 32 {
            return Err(CoreError::Crypto("decrypted key wrong size".into()));
        }

        let mut key = [0u8; 32];
        key.copy_from_slice(&plaintext);
        Ok(key)
    }

    /// Load key from storage (called on init)
    pub async fn load(&mut self) -> Result<(), CoreError> {
        // First load device secret
        if let Some(secret_data) = self.host.storage_get(STORAGE_KEY_DEVICE_SECRET).await
            .map_err(CoreError::from)?
        {
            if secret_data.len() == 32 {
                let mut secret = [0u8; 32];
                secret.copy_from_slice(&secret_data);
                self.device_secret = Some(secret);
            }
        } else {
            // Generate and save device secret
            self.ensure_device_secret();
            if let Some(secret) = &self.device_secret {
                self.host.storage_set(STORAGE_KEY_DEVICE_SECRET, secret).await
                    .map_err(CoreError::from)?;
            }
        }

        // Then try to load vault key
        if let Some(encrypted_data) = self.host.storage_get(STORAGE_KEY_VAULT_KEY).await
            .map_err(CoreError::from)?
        {
            match self.decrypt_from_storage(&encrypted_data) {
                Ok(key) => {
                    self.cached_key = Some(key);
                }
                Err(e) => {
                    // Log error but don't fail - key might be corrupted
                    self.host.notify_error(&format!("Failed to decrypt stored vault key: {}", e));
                }
            }
        }

        Ok(())
    }

    /// Save key to storage
    pub async fn save(&self) -> Result<(), CoreError> {
        if let Some(key) = &self.cached_key {
            let encrypted = self.encrypt_for_storage(key)?;
            self.host.storage_set(STORAGE_KEY_VAULT_KEY, &encrypted).await
                .map_err(CoreError::from)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::mock::MockHost;

    #[test]
    fn test_key_generation() {
        let host = Arc::new(MockHost::new());
        let mut km = KeyManager::new(host).unwrap();

        assert!(!km.has_key());

        let key = km.generate_key().unwrap();
        assert!(km.has_key());
        assert_eq!(km.get_key(), Some(&key));
    }

    #[test]
    fn test_key_exchange() {
        let host_a = Arc::new(MockHost::new());
        let host_b = Arc::new(MockHost::new());

        let mut km_a = KeyManager::new(host_a).unwrap();
        let mut km_b = KeyManager::new(host_b).unwrap();

        // A generates a vault key
        let original_key = km_a.generate_key().unwrap();

        // B generates their exchange public key
        let b_public = km_b.exchange_public_key();

        // A encrypts the vault key for B
        let encrypted = km_a.encrypt_key_for_peer(&b_public).unwrap();

        // B decrypts the vault key
        km_b.decrypt_key_from_peer(&encrypted).unwrap();

        // Both should have the same key
        assert_eq!(km_b.get_key(), Some(&original_key));
    }

    #[test]
    fn test_data_encryption() {
        let host = Arc::new(MockHost::new());
        let mut km = KeyManager::new(host).unwrap();
        km.generate_key().unwrap();

        let plaintext = b"Hello, World!";
        let encrypted = km.encrypt_data(plaintext).unwrap();
        let decrypted = km.decrypt_data(&encrypted).unwrap();

        assert_eq!(&decrypted, plaintext);
    }

    #[test]
    fn test_key_id() {
        let host = Arc::new(MockHost::new());
        let mut km = KeyManager::new(host).unwrap();

        assert!(km.key_id().is_none());

        km.generate_key().unwrap();
        let id = km.key_id().unwrap();

        // Key ID should be deterministic
        assert_eq!(km.key_id(), Some(id));
    }
}
