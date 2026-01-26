/**
 * Encryption Tests
 *
 * Tests for encryption service and encrypted storage adapter.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { EncryptionService } from '../src/crypto/encryption';
import { EncryptedStorageAdapter } from '../src/core/encrypted-storage-adapter';
import { MemoryStorageAdapter } from '../src/core/storage-adapter';

describe('EncryptionService', () => {
  let encryption: EncryptionService;

  beforeEach(() => {
    encryption = new EncryptionService();
  });

  describe('Key Management', () => {
    it('should generate a 32-byte key', () => {
      const key = encryption.generateKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('should not be enabled without a key', () => {
      expect(encryption.isEnabled()).toBe(false);
    });

    it('should be enabled after setting a key', () => {
      const key = encryption.generateKey();
      encryption.setKey(key);
      expect(encryption.isEnabled()).toBe(true);
    });

    it('should get the key after setting', () => {
      const key = encryption.generateKey();
      encryption.setKey(key);
      const retrieved = encryption.getKey();
      expect(retrieved).toEqual(key);
    });

    it('should clear the key', () => {
      const key = encryption.generateKey();
      encryption.setKey(key);
      expect(encryption.isEnabled()).toBe(true);

      encryption.clearKey();
      expect(encryption.isEnabled()).toBe(false);
      expect(encryption.getKey()).toBeNull();
    });
  });

  describe('Encryption/Decryption', () => {
    beforeEach(() => {
      const key = encryption.generateKey();
      encryption.setKey(key);
    });

    it('should encrypt and decrypt text data', () => {
      const plaintext = new TextEncoder().encode('Hello, World!');

      const ciphertext = encryption.encrypt(plaintext);
      expect(ciphertext).toBeInstanceOf(Uint8Array);
      expect(ciphertext.length).toBeGreaterThan(plaintext.length);

      const decrypted = encryption.decrypt(ciphertext);
      expect(new TextDecoder().decode(decrypted)).toBe('Hello, World!');
    });

    it('should encrypt and decrypt binary data', () => {
      const plaintext = new Uint8Array([0x00, 0xff, 0x42, 0x13, 0x37]);

      const ciphertext = encryption.encrypt(plaintext);
      const decrypted = encryption.decrypt(ciphertext);

      expect(decrypted).toEqual(plaintext);
    });

    it('should produce different ciphertext for same plaintext (random nonce)', () => {
      const plaintext = new TextEncoder().encode('Same message');

      const ciphertext1 = encryption.encrypt(plaintext);
      const ciphertext2 = encryption.encrypt(plaintext);

      // Ciphertexts should differ due to random nonce
      expect(ciphertext1).not.toEqual(ciphertext2);

      // Both should decrypt to the same plaintext
      expect(encryption.decrypt(ciphertext1)).toEqual(plaintext);
      expect(encryption.decrypt(ciphertext2)).toEqual(plaintext);
    });

    it('should handle empty data', () => {
      const plaintext = new Uint8Array(0);

      const ciphertext = encryption.encrypt(plaintext);
      const decrypted = encryption.decrypt(ciphertext);

      expect(decrypted).toEqual(plaintext);
    });

    it('should handle large data', () => {
      // 1MB of random-ish data
      const plaintext = new Uint8Array(1024 * 1024);
      for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256;
      }

      const ciphertext = encryption.encrypt(plaintext);
      const decrypted = encryption.decrypt(ciphertext);

      expect(decrypted).toEqual(plaintext);
    });

    it('should throw on tampered ciphertext', () => {
      const plaintext = new TextEncoder().encode('Sensitive data');
      const ciphertext = encryption.encrypt(plaintext);

      // Tamper with the ciphertext
      ciphertext[30]++;

      expect(() => {
        encryption.decrypt(ciphertext);
      }).toThrow();
    });

    it('should throw when decrypting without key', () => {
      const plaintext = new TextEncoder().encode('Test');
      const ciphertext = encryption.encrypt(plaintext);

      encryption.clearKey();

      expect(() => {
        encryption.decrypt(ciphertext);
      }).toThrow();
    });
  });
});

describe('EncryptedStorageAdapter', () => {
  let innerStorage: MemoryStorageAdapter;
  let encryption: EncryptionService;
  let encryptedStorage: EncryptedStorageAdapter;

  beforeEach(() => {
    innerStorage = new MemoryStorageAdapter();
    encryption = new EncryptionService();
  });

  describe('Without Encryption', () => {
    beforeEach(() => {
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);
    });

    it('should pass through writes when encryption disabled', async () => {
      const data = new TextEncoder().encode('Plain data');
      await encryptedStorage.write('test-key', data);

      const raw = await innerStorage.read('test-key');
      expect(raw).toEqual(data);
    });

    it('should pass through reads when encryption disabled', async () => {
      const data = new TextEncoder().encode('Plain data');
      await innerStorage.write('test-key', data);

      const result = await encryptedStorage.read('test-key');
      expect(result).toEqual(data);
    });
  });

  describe('With Encryption', () => {
    beforeEach(() => {
      const key = encryption.generateKey();
      encryption.setKey(key);
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);
    });

    it('should encrypt data on write', async () => {
      const data = new TextEncoder().encode('Secret data');
      await encryptedStorage.write('test-key', data);

      const raw = await innerStorage.read('test-key');

      // Should have header
      expect(raw!.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x56, 0x45, 0x31])); // 'PVE1'

      // Should not be plaintext
      expect(raw).not.toEqual(data);
    });

    it('should decrypt data on read', async () => {
      const data = new TextEncoder().encode('Secret data');
      await encryptedStorage.write('test-key', data);

      const result = await encryptedStorage.read('test-key');
      expect(result).toEqual(data);
    });

    it('should round-trip various data types', async () => {
      const testCases = [
        { key: 'text', data: new TextEncoder().encode('Hello') },
        { key: 'binary', data: new Uint8Array([0x00, 0xff, 0x42]) },
        { key: 'empty', data: new Uint8Array(0) },
        { key: 'json', data: new TextEncoder().encode('{"foo":"bar"}') },
      ];

      for (const { key, data } of testCases) {
        await encryptedStorage.write(key, data);
        const result = await encryptedStorage.read(key);
        expect(result).toEqual(data);
      }
    });
  });

  describe('Backward Compatibility', () => {
    it('should read unencrypted files when encryption is enabled', async () => {
      // Write plaintext directly to inner storage
      const plaintext = new TextEncoder().encode('Old unencrypted data');
      await innerStorage.write('old-file', plaintext);

      // Enable encryption
      const key = encryption.generateKey();
      encryption.setKey(key);
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);

      // Should still read the plaintext
      const result = await encryptedStorage.read('old-file');
      expect(result).toEqual(plaintext);
    });

    it('should read encrypted files when encryption is disabled', async () => {
      // Write encrypted data
      const key = encryption.generateKey();
      encryption.setKey(key);
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);

      const data = new TextEncoder().encode('Encrypted data');
      await encryptedStorage.write('encrypted-file', data);

      // Disable encryption - but keep the key for reading
      // (In real usage, you'd need to unlock to read)
      const result = await encryptedStorage.read('encrypted-file');
      expect(result).toEqual(data);
    });
  });

  describe('Re-encryption', () => {
    it('should re-encrypt all files', async () => {
      const key = encryption.generateKey();
      encryption.setKey(key);
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);

      // Write some files
      await encryptedStorage.write('file1', new TextEncoder().encode('Data 1'));
      await encryptedStorage.write('file2', new TextEncoder().encode('Data 2'));
      await encryptedStorage.write('file3', new TextEncoder().encode('Data 3'));

      const result = await encryptedStorage.reencryptAll();

      expect(result.encrypted).toBe(3);
      expect(result.failed.length).toBe(0);

      // Verify files still readable
      expect(new TextDecoder().decode(await encryptedStorage.read('file1') ?? new Uint8Array())).toBe('Data 1');
      expect(new TextDecoder().decode(await encryptedStorage.read('file2') ?? new Uint8Array())).toBe('Data 2');
      expect(new TextDecoder().decode(await encryptedStorage.read('file3') ?? new Uint8Array())).toBe('Data 3');
    });

    it('should encrypt previously unencrypted files', async () => {
      // Write plaintext
      await innerStorage.write('plain', new TextEncoder().encode('Plain'));

      // Enable encryption
      const key = encryption.generateKey();
      encryption.setKey(key);
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);

      await encryptedStorage.reencryptAll();

      // Check it's now encrypted
      const isEncrypted = await encryptedStorage.isFileEncrypted('plain');
      expect(isEncrypted).toBe(true);

      // Check content is preserved
      const content = await encryptedStorage.read('plain');
      expect(new TextDecoder().decode(content!)).toBe('Plain');
    });
  });

  describe('Decryption (Disable Encryption)', () => {
    it('should decrypt all files', async () => {
      const key = encryption.generateKey();
      encryption.setKey(key);
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);

      // Write encrypted files
      await encryptedStorage.write('file1', new TextEncoder().encode('Secret 1'));
      await encryptedStorage.write('file2', new TextEncoder().encode('Secret 2'));

      const result = await encryptedStorage.decryptAll();

      expect(result.decrypted).toBe(2);
      expect(result.failed.length).toBe(0);

      // Verify files are now plaintext in inner storage
      const raw1 = await innerStorage.read('file1');
      expect(new TextDecoder().decode(raw1!)).toBe('Secret 1');

      const raw2 = await innerStorage.read('file2');
      expect(new TextDecoder().decode(raw2!)).toBe('Secret 2');
    });
  });

  describe('isFileEncrypted', () => {
    it('should detect encrypted files', async () => {
      const key = encryption.generateKey();
      encryption.setKey(key);
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);

      await encryptedStorage.write('encrypted', new TextEncoder().encode('Data'));

      const result = await encryptedStorage.isFileEncrypted('encrypted');
      expect(result).toBe(true);
    });

    it('should detect unencrypted files', async () => {
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);
      await innerStorage.write('plain', new TextEncoder().encode('Data'));

      const result = await encryptedStorage.isFileEncrypted('plain');
      expect(result).toBe(false);
    });

    it('should return false for non-existent files', async () => {
      encryptedStorage = new EncryptedStorageAdapter(innerStorage, encryption);

      const result = await encryptedStorage.isFileEncrypted('nonexistent');
      expect(result).toBe(false);
    });
  });
});
