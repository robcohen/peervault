/**
 * End-to-End Encryption
 *
 * Provides symmetric encryption for sync data using AES-256-GCM.
 * Uses Web Crypto API for authenticated encryption.
 */

import { CryptoErrors } from "../errors";

/** Encryption key length in bytes (256 bits) */
const KEY_LENGTH = 32;

/** IV/nonce length in bytes (96 bits for GCM) */
const IV_LENGTH = 12;

/** Auth tag length in bytes */
const TAG_LENGTH = 16;

/**
 * Encryption service for E2E encrypted sync.
 * Uses AES-256-GCM authenticated encryption per spec.
 */
export class EncryptionService {
  private key: CryptoKey | null = null;
  private rawKey: Uint8Array | null = null;
  private enabled = false;

  /**
   * Initialize with an existing key.
   */
  async setKey(key: Uint8Array): Promise<void> {
    if (key.length !== KEY_LENGTH) {
      throw CryptoErrors.invalidKey(
        `expected ${KEY_LENGTH} bytes, got ${key.length}`,
      );
    }

    // Import key for AES-GCM
    // Create a new ArrayBuffer to ensure it's not a SharedArrayBuffer
    const keyBuffer = new ArrayBuffer(key.length);
    new Uint8Array(keyBuffer).set(key);

    this.key = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    this.rawKey = new Uint8Array(key);
    this.enabled = true;
  }

  /**
   * Generate a new random encryption key.
   */
  async generateKey(): Promise<Uint8Array> {
    const key = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
    await this.setKey(key);
    return key;
  }

  /**
   * Get the current raw key (for storage).
   */
  getKey(): Uint8Array | null {
    return this.rawKey;
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
    if (this.rawKey) {
      // Zero out the key in memory
      this.rawKey.fill(0);
    }
    this.rawKey = null;
    this.key = null;
    this.enabled = false;
  }

  /**
   * Encrypt binary data using AES-256-GCM.
   * Returns: IV (12 bytes) || ciphertext || auth tag (16 bytes)
   */
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) {
      throw CryptoErrors.keyNotSet();
    }

    // Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    // Convert plaintext to ArrayBuffer
    const plaintextBuffer = new ArrayBuffer(plaintext.length);
    new Uint8Array(plaintextBuffer).set(plaintext);

    // Encrypt using AES-GCM
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: TAG_LENGTH * 8, // in bits
      },
      this.key,
      plaintextBuffer,
    );

    // Prepend IV to ciphertext (auth tag is appended by AES-GCM)
    const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), IV_LENGTH);

    return result;
  }

  /**
   * Decrypt binary data using AES-256-GCM.
   * Expects: IV (12 bytes) || ciphertext || auth tag (16 bytes)
   */
  async decrypt(encrypted: Uint8Array): Promise<Uint8Array> {
    if (!this.key) {
      throw CryptoErrors.keyNotSet();
    }

    if (encrypted.length < IV_LENGTH + TAG_LENGTH) {
      throw CryptoErrors.decryptionFailed("data too short");
    }

    const iv = encrypted.slice(0, IV_LENGTH);
    const ciphertext = encrypted.slice(IV_LENGTH);

    // Convert ciphertext to ArrayBuffer
    const ciphertextBuffer = new ArrayBuffer(ciphertext.length);
    new Uint8Array(ciphertextBuffer).set(ciphertext);

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          tagLength: TAG_LENGTH * 8, // in bits
        },
        this.key,
        ciphertextBuffer,
      );

      return new Uint8Array(plaintext);
    } catch {
      throw CryptoErrors.decryptionFailed("invalid ciphertext or wrong key");
    }
  }

  /**
   * Encrypt a string to base64.
   */
  async encryptString(plaintext: string): Promise<string> {
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const encrypted = await this.encrypt(plaintextBytes);
    return base64Encode(encrypted);
  }

  /**
   * Decrypt a base64 string.
   */
  async decryptString(encrypted: string): Promise<string> {
    const encryptedBytes = base64Decode(encrypted);
    const decrypted = await this.decrypt(encryptedBytes);
    return new TextDecoder().decode(decrypted);
  }

  /**
   * Encrypt data if encryption is enabled, otherwise pass through.
   */
  async maybeEncrypt(data: Uint8Array): Promise<Uint8Array> {
    if (this.enabled && this.key) {
      return this.encrypt(data);
    }
    return data;
  }

  /**
   * Decrypt data if encryption is enabled, otherwise pass through.
   */
  async maybeDecrypt(data: Uint8Array): Promise<Uint8Array> {
    if (this.enabled && this.key) {
      return this.decrypt(data);
    }
    return data;
  }
}

/**
 * Derive an encryption key from a password using PBKDF2.
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = 100000,
): Promise<Uint8Array> {
  const passwordBytes = new TextEncoder().encode(password);

  // Convert to ArrayBuffer for SubtleCrypto API
  const passwordBuffer = new ArrayBuffer(passwordBytes.length);
  new Uint8Array(passwordBuffer).set(passwordBytes);

  const saltBuffer = new ArrayBuffer(salt.length);
  new Uint8Array(saltBuffer).set(salt);

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations,
      hash: "SHA-256",
    },
    passwordKey,
    KEY_LENGTH * 8,
  );

  return new Uint8Array(derivedBits);
}

/**
 * Generate a random salt for key derivation.
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Export key as base64 for display/backup.
 */
export function exportKey(key: Uint8Array): string {
  return base64Encode(key);
}

/**
 * Import key from base64.
 */
export function importKey(base64Key: string): Uint8Array {
  return base64Decode(base64Key);
}

/**
 * Generate a human-readable recovery phrase from a key.
 * Uses simple hex encoding split into groups.
 */
export function keyToRecoveryPhrase(key: Uint8Array): string {
  const hex = Array.from(key)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Split into 8-character groups
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    groups.push(hex.slice(i, i + 8));
  }

  return groups.join("-");
}

/**
 * Recover key from recovery phrase.
 */
export function recoveryPhraseToKey(phrase: string): Uint8Array {
  const hex = phrase.replace(/-/g, "");
  if (hex.length !== KEY_LENGTH * 2) {
    throw CryptoErrors.invalidKey("invalid recovery phrase length");
  }

  const key = new Uint8Array(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) {
    key[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return key;
}

// Base64 encoding/decoding helpers
function base64Encode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

function base64Decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
