/**
 * Encrypted Storage Adapter
 *
 * Wraps a StorageAdapter to provide transparent encryption at rest.
 * Files are encrypted with NaCl secretbox (XSalsa20-Poly1305) before being
 * written to storage, and decrypted when read.
 *
 * Encryption format:
 * - Bytes 0-3: Magic number 'PVE1' (PeerVault Encrypted v1)
 * - Byte 4: Format version (0x01)
 * - Bytes 5-15: Reserved (zeros)
 * - Bytes 16+: nonce (24 bytes) || ciphertext
 *
 * Backward compatible: Files without the magic header are read as plaintext.
 */

import type { StorageAdapter } from "../types";
import type { EncryptionService } from "../crypto/encryption";

/** Magic number for encrypted files: 'PVE1' */
const MAGIC = new Uint8Array([0x50, 0x56, 0x45, 0x31]); // 'P', 'V', 'E', '1'

/** Format version */
const FORMAT_VERSION = 0x01;

/** Total header size */
const HEADER_SIZE = 16;

/**
 * Check if data has the encrypted file header.
 */
function hasEncryptionHeader(data: Uint8Array): boolean {
  if (data.length < HEADER_SIZE) {
    return false;
  }

  // Check magic number
  return (
    data[0] === MAGIC[0] &&
    data[1] === MAGIC[1] &&
    data[2] === MAGIC[2] &&
    data[3] === MAGIC[3]
  );
}

/**
 * Create the encryption header.
 */
function createHeader(): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  header.set(MAGIC, 0);
  header[4] = FORMAT_VERSION;
  // Bytes 5-15 are reserved (already zeros)
  return header;
}

/**
 * Encrypted Storage Adapter
 *
 * Wraps any StorageAdapter to add transparent encryption.
 * When encryption is enabled:
 * - Writes encrypt data before storing
 * - Reads decrypt data after loading
 *
 * When encryption is disabled:
 * - Writes pass through unchanged
 * - Reads can still decrypt encrypted data (backward compatible)
 */
export class EncryptedStorageAdapter implements StorageAdapter {
  constructor(
    private inner: StorageAdapter,
    private encryption: EncryptionService,
  ) {}

  /**
   * Read data from storage, decrypting if necessary.
   */
  async read(key: string): Promise<Uint8Array | null> {
    const data = await this.inner.read(key);
    if (!data) return null;

    // Check for encryption header
    if (hasEncryptionHeader(data)) {
      // Verify format version
      const version = data[4];
      if (version !== FORMAT_VERSION) {
        throw new Error(
          `Unsupported encrypted file format version: ${version}`,
        );
      }

      // Extract encrypted payload (skip header)
      const encryptedPayload = data.slice(HEADER_SIZE);

      // Decrypt
      if (!this.encryption.isEnabled()) {
        throw new Error("Cannot read encrypted file: encryption not unlocked");
      }

      try {
        return this.encryption.decrypt(encryptedPayload);
      } catch (error) {
        throw new Error(`Failed to decrypt file "${key}": ${error}`);
      }
    }

    // No header - return as plaintext (backward compatible)
    return data;
  }

  /**
   * Write data to storage, encrypting if enabled.
   */
  async write(key: string, data: Uint8Array): Promise<void> {
    if (this.encryption.isEnabled()) {
      // Encrypt the data
      const encrypted = this.encryption.encrypt(data);

      // Create header + encrypted payload
      const header = createHeader();
      const combined = new Uint8Array(HEADER_SIZE + encrypted.length);
      combined.set(header, 0);
      combined.set(encrypted, HEADER_SIZE);

      await this.inner.write(key, combined);
    } else {
      // Pass through unencrypted
      await this.inner.write(key, data);
    }
  }

  /**
   * Delete a key from storage.
   */
  async delete(key: string): Promise<void> {
    await this.inner.delete(key);
  }

  /**
   * List all keys with optional prefix.
   */
  async list(prefix?: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  /**
   * Check if a key exists.
   */
  async exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }

  /**
   * Check if a stored file is encrypted.
   */
  async isFileEncrypted(key: string): Promise<boolean> {
    const data = await this.inner.read(key);
    if (!data) return false;
    return hasEncryptionHeader(data);
  }

  /**
   * Re-encrypt all storage with the current key.
   * Used when enabling encryption or changing keys.
   *
   * @param onProgress Progress callback (percent, message)
   */
  async reencryptAll(
    onProgress?: (percent: number, message: string) => void,
  ): Promise<{ encrypted: number; skipped: number; failed: string[] }> {
    const progress = onProgress ?? (() => {});
    const keys = await this.inner.list();
    const failed: string[] = [];
    let encryptedCount = 0;
    let skipped = 0;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      progress((i / keys.length) * 100, `Processing ${key}`);

      try {
        // Read raw data from inner storage
        const rawData = await this.inner.read(key);
        if (!rawData) {
          skipped++;
          continue;
        }

        // If already encrypted, decrypt first
        let plaintext: Uint8Array;
        if (hasEncryptionHeader(rawData)) {
          const encryptedPayload = rawData.slice(HEADER_SIZE);
          plaintext = this.encryption.decrypt(encryptedPayload);
        } else {
          plaintext = rawData;
        }

        // Re-encrypt with current key
        const encryptedData = this.encryption.encrypt(plaintext);
        const header = createHeader();
        const combined = new Uint8Array(HEADER_SIZE + encryptedData.length);
        combined.set(header, 0);
        combined.set(encryptedData, HEADER_SIZE);

        await this.inner.write(key, combined);
        encryptedCount++;
      } catch (error) {
        failed.push(key);
      }
    }

    progress(100, "Re-encryption complete");
    return { encrypted: encryptedCount, skipped, failed };
  }

  /**
   * Decrypt all storage (disable encryption at rest).
   *
   * @param onProgress Progress callback (percent, message)
   */
  async decryptAll(
    onProgress?: (percent: number, message: string) => void,
  ): Promise<{ decrypted: number; skipped: number; failed: string[] }> {
    const progress = onProgress ?? (() => {});
    const keys = await this.inner.list();
    const failed: string[] = [];
    let decrypted = 0;
    let skipped = 0;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      progress((i / keys.length) * 100, `Processing ${key}`);

      try {
        const rawData = await this.inner.read(key);
        if (!rawData) {
          skipped++;
          continue;
        }

        // Only process encrypted files
        if (hasEncryptionHeader(rawData)) {
          const encryptedPayload = rawData.slice(HEADER_SIZE);
          const plaintext = this.encryption.decrypt(encryptedPayload);

          // Write back as plaintext
          await this.inner.write(key, plaintext);
          decrypted++;
        } else {
          skipped++;
        }
      } catch (error) {
        failed.push(key);
      }
    }

    progress(100, "Decryption complete");
    return { decrypted, skipped, failed };
  }

  /**
   * Get the inner storage adapter.
   */
  getInner(): StorageAdapter {
    return this.inner;
  }
}
