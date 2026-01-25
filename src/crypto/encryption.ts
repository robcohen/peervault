/**
 * End-to-End Encryption
 *
 * Provides symmetric encryption for sync data using NaCl secretbox.
 * Uses XSalsa20-Poly1305 authenticated encryption.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

/** Encryption key length in bytes (256 bits) */
const KEY_LENGTH = nacl.secretbox.keyLength; // 32 bytes

/** Nonce length in bytes */
const NONCE_LENGTH = nacl.secretbox.nonceLength; // 24 bytes

/**
 * Encryption service for E2E encrypted sync.
 */
export class EncryptionService {
  private key: Uint8Array | null = null;
  private enabled = false;

  /**
   * Initialize with an existing key.
   */
  setKey(key: Uint8Array): void {
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Invalid key length: expected ${KEY_LENGTH}, got ${key.length}`);
    }
    this.key = key;
    this.enabled = true;
  }

  /**
   * Generate a new random encryption key.
   */
  generateKey(): Uint8Array {
    const key = nacl.randomBytes(KEY_LENGTH);
    this.key = key;
    this.enabled = true;
    return key;
  }

  /**
   * Get the current key (for storage).
   */
  getKey(): Uint8Array | null {
    return this.key;
  }

  /**
   * Check if encryption is enabled.
   */
  isEnabled(): boolean {
    return this.enabled && this.key !== null;
  }

  /**
   * Enable or disable encryption.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Clear the encryption key.
   */
  clearKey(): void {
    if (this.key) {
      // Zero out the key in memory
      this.key.fill(0);
    }
    this.key = null;
    this.enabled = false;
  }

  /**
   * Encrypt binary data.
   * Returns: nonce (24 bytes) || ciphertext
   */
  encrypt(plaintext: Uint8Array): Uint8Array {
    if (!this.key) {
      throw new Error('Encryption key not set');
    }

    const nonce = nacl.randomBytes(NONCE_LENGTH);
    const ciphertext = nacl.secretbox(plaintext, nonce, this.key);

    // Prepend nonce to ciphertext
    const result = new Uint8Array(NONCE_LENGTH + ciphertext.length);
    result.set(nonce, 0);
    result.set(ciphertext, NONCE_LENGTH);

    return result;
  }

  /**
   * Decrypt binary data.
   * Expects: nonce (24 bytes) || ciphertext
   */
  decrypt(encrypted: Uint8Array): Uint8Array {
    if (!this.key) {
      throw new Error('Encryption key not set');
    }

    if (encrypted.length < NONCE_LENGTH + nacl.secretbox.overheadLength) {
      throw new Error('Invalid encrypted data: too short');
    }

    const nonce = encrypted.slice(0, NONCE_LENGTH);
    const ciphertext = encrypted.slice(NONCE_LENGTH);

    const plaintext = nacl.secretbox.open(ciphertext, nonce, this.key);
    if (!plaintext) {
      throw new Error('Decryption failed: invalid ciphertext or wrong key');
    }

    return plaintext;
  }

  /**
   * Encrypt a string to base64.
   */
  encryptString(plaintext: string): string {
    const plaintextBytes = decodeUTF8(plaintext);
    const encrypted = this.encrypt(plaintextBytes);
    return encodeBase64(encrypted);
  }

  /**
   * Decrypt a base64 string.
   */
  decryptString(encrypted: string): string {
    const encryptedBytes = decodeBase64(encrypted);
    const decrypted = this.decrypt(encryptedBytes);
    return encodeUTF8(decrypted);
  }

  /**
   * Encrypt data if encryption is enabled, otherwise pass through.
   */
  maybeEncrypt(data: Uint8Array): Uint8Array {
    if (this.enabled && this.key) {
      return this.encrypt(data);
    }
    return data;
  }

  /**
   * Decrypt data if encryption is enabled, otherwise pass through.
   */
  maybeDecrypt(data: Uint8Array): Uint8Array {
    if (this.enabled && this.key) {
      return this.decrypt(data);
    }
    return data;
  }
}

/**
 * Derive an encryption key from a password using PBKDF2-like stretching.
 * Note: For production, consider using a proper PBKDF2 or Argon2 implementation.
 * This uses multiple rounds of SHA-256 for basic key stretching.
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = 100000
): Promise<Uint8Array> {
  // Use SubtleCrypto for PBKDF2 if available
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const passwordBytes = decodeUTF8(password);
      // Create new ArrayBuffer to ensure it's not SharedArrayBuffer
      const passwordBuffer = new ArrayBuffer(passwordBytes.length);
      new Uint8Array(passwordBuffer).set(passwordBytes);

      const saltBuffer = new ArrayBuffer(salt.length);
      new Uint8Array(saltBuffer).set(salt);

      const passwordKey = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        'PBKDF2',
        false,
        ['deriveBits']
      );

      const derivedBits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: saltBuffer,
          iterations,
          hash: 'SHA-256',
        },
        passwordKey,
        KEY_LENGTH * 8
      );

      return new Uint8Array(derivedBits);
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: Simple key derivation using nacl hash
  // Combine password and salt, then hash
  const passwordBytes = decodeUTF8(password);
  const combined = new Uint8Array(salt.length + passwordBytes.length);
  combined.set(salt);
  combined.set(passwordBytes, salt.length);
  return nacl.hash(combined).slice(0, KEY_LENGTH);
}

/**
 * Generate a random salt for key derivation.
 */
export function generateSalt(): Uint8Array {
  return nacl.randomBytes(16);
}

/**
 * Export key as base64 for display/backup.
 */
export function exportKey(key: Uint8Array): string {
  return encodeBase64(key);
}

/**
 * Import key from base64.
 */
export function importKey(base64Key: string): Uint8Array {
  return decodeBase64(base64Key);
}

/**
 * Generate a human-readable recovery phrase from a key.
 * Uses simple hex encoding split into groups.
 */
export function keyToRecoveryPhrase(key: Uint8Array): string {
  const hex = Array.from(key)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Split into 8-character groups
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    groups.push(hex.slice(i, i + 8));
  }

  return groups.join('-');
}

/**
 * Recover key from recovery phrase.
 */
export function recoveryPhraseToKey(phrase: string): Uint8Array {
  const hex = phrase.replace(/-/g, '');
  if (hex.length !== KEY_LENGTH * 2) {
    throw new Error('Invalid recovery phrase length');
  }

  const key = new Uint8Array(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) {
    key[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return key;
}

// Singleton instance for the plugin
let encryptionService: EncryptionService | null = null;

/**
 * Get the global encryption service instance.
 */
export function getEncryptionService(): EncryptionService {
  if (!encryptionService) {
    encryptionService = new EncryptionService();
  }
  return encryptionService;
}
