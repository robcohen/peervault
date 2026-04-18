/**
 * Tests for the crypto module
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  // Encryption
  encrypt,
  decrypt,
  encryptString,
  decryptString,
  generateKey,
  constantTimeEqual,
  encryptedSize,
  KEY_LENGTH,
  NONCE_LENGTH,
  TAG_LENGTH,
  // Vault key
  VaultKeyManager,
  deriveDeviceSecret,
  exportKeyWithPassphrase,
  importKeyWithPassphrase,
  // Key exchange
  KeyExchangeSession,
  generateKeyExchangeKeypair,
  encryptVaultKeyForRecipient,
  decryptVaultKeyFromSender,
  serializeKeyBundle,
  deserializeKeyBundle,
} from "../src/crypto";
import type { StorageAdapter } from "../src/types";

// ============================================================================
// Mock Storage Adapter
// ============================================================================

class MockStorageAdapter implements StorageAdapter {
  private data: Map<string, Uint8Array> = new Map();

  async read(key: string): Promise<Uint8Array | null> {
    return this.data.get(key) || null;
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    this.data.set(key, data);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.data.keys());
    if (prefix) {
      return keys.filter((k) => k.startsWith(prefix));
    }
    return keys;
  }

  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  clear(): void {
    this.data.clear();
  }
}

// ============================================================================
// Encryption Tests
// ============================================================================

describe("encryption", () => {
  describe("encrypt/decrypt", () => {
    it("should encrypt and decrypt data", () => {
      const key = generateKey();
      const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).not.toBeNull();
      expect(decrypted).toEqual(plaintext);
    });

    it("should produce different ciphertext for same plaintext (random nonce)", () => {
      const key = generateKey();
      const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

      const encrypted1 = encrypt(plaintext, key);
      const encrypted2 = encrypt(plaintext, key);

      // Ciphertext should be different due to random nonce
      expect(encrypted1).not.toEqual(encrypted2);
    });

    it("should fail decryption with wrong key", () => {
      const key1 = generateKey();
      const key2 = generateKey();
      const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

      const encrypted = encrypt(plaintext, key1);
      const decrypted = decrypt(encrypted, key2);

      expect(decrypted).toBeNull();
    });

    it("should fail decryption if ciphertext is tampered", () => {
      const key = generateKey();
      const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

      const encrypted = encrypt(plaintext, key);

      // Tamper with ciphertext
      encrypted[NONCE_LENGTH + 5] ^= 0xff;

      const decrypted = decrypt(encrypted, key);
      expect(decrypted).toBeNull();
    });

    it("should throw on invalid key length", () => {
      const shortKey = new Uint8Array(16);
      const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

      expect(() => encrypt(plaintext, shortKey)).toThrow(/Invalid key length/);
    });

    it("should throw on data too short for decrypt", () => {
      const key = generateKey();
      const tooShort = new Uint8Array(10);

      expect(() => decrypt(tooShort, key)).toThrow(/too short/);
    });

    it("should handle empty plaintext", () => {
      const key = generateKey();
      const plaintext = new Uint8Array(0);

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).not.toBeNull();
      expect(decrypted!.length).toBe(0);
    });

    it("should handle large plaintext", () => {
      const key = generateKey();
      const plaintext = new Uint8Array(1024 * 1024); // 1MB
      for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = i % 256;
      }

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });
  });

  describe("encryptString/decryptString", () => {
    it("should encrypt and decrypt strings", () => {
      const key = generateKey();
      const text = "Hello, World! 🌍";

      const encrypted = encryptString(text, key);
      const decrypted = decryptString(encrypted, key);

      expect(decrypted).toBe(text);
    });

    it("should handle empty string", () => {
      const key = generateKey();
      const text = "";

      const encrypted = encryptString(text, key);
      const decrypted = decryptString(encrypted, key);

      expect(decrypted).toBe(text);
    });

    it("should handle unicode", () => {
      const key = generateKey();
      const text = "日本語テスト 🎌 مرحبا";

      const encrypted = encryptString(text, key);
      const decrypted = decryptString(encrypted, key);

      expect(decrypted).toBe(text);
    });
  });

  describe("generateKey", () => {
    it("should generate key of correct length", () => {
      const key = generateKey();
      expect(key.length).toBe(KEY_LENGTH);
    });

    it("should generate different keys each time", () => {
      const key1 = generateKey();
      const key2 = generateKey();
      expect(key1).not.toEqual(key2);
    });
  });

  describe("constantTimeEqual", () => {
    it("should return true for equal arrays", () => {
      const a = new Uint8Array([1, 2, 3, 4, 5]);
      const b = new Uint8Array([1, 2, 3, 4, 5]);
      expect(constantTimeEqual(a, b)).toBe(true);
    });

    it("should return false for different arrays", () => {
      const a = new Uint8Array([1, 2, 3, 4, 5]);
      const b = new Uint8Array([1, 2, 3, 4, 6]);
      expect(constantTimeEqual(a, b)).toBe(false);
    });

    it("should return false for different length arrays", () => {
      const a = new Uint8Array([1, 2, 3, 4, 5]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(constantTimeEqual(a, b)).toBe(false);
    });
  });

  describe("encryptedSize", () => {
    it("should calculate correct encrypted size", () => {
      const plaintextSize = 100;
      const expectedSize = NONCE_LENGTH + plaintextSize + TAG_LENGTH;
      expect(encryptedSize(plaintextSize)).toBe(expectedSize);
    });
  });
});

// ============================================================================
// Vault Key Tests
// ============================================================================

describe("vault-key", () => {
  let storage: MockStorageAdapter;
  let deviceSecret: Uint8Array;

  beforeEach(() => {
    storage = new MockStorageAdapter();
    deviceSecret = generateKey(); // Simulate Iroh secret key
  });

  describe("VaultKeyManager", () => {
    it("should generate and store a key", async () => {
      const manager = new VaultKeyManager(storage, deviceSecret);

      expect(await manager.hasKey()).toBe(false);

      const key = await manager.generateAndStoreKey();

      expect(key.length).toBe(KEY_LENGTH);
      expect(await manager.hasKey()).toBe(true);
    });

    it("should retrieve stored key", async () => {
      const manager = new VaultKeyManager(storage, deviceSecret);
      const originalKey = await manager.generateAndStoreKey();

      // Clear cache to force reload from storage
      manager.clearCache();

      const retrievedKey = await manager.getKey();
      expect(retrievedKey).toEqual(originalKey);
    });

    it("should return null if no key exists", async () => {
      const manager = new VaultKeyManager(storage, deviceSecret);
      const key = await manager.getKey();
      expect(key).toBeNull();
    });

    it("should throw if generating key when one exists", async () => {
      const manager = new VaultKeyManager(storage, deviceSecret);
      await manager.generateAndStoreKey();

      await expect(manager.generateAndStoreKey()).rejects.toThrow(/already exists/);
    });

    it("should clear key", async () => {
      const manager = new VaultKeyManager(storage, deviceSecret);
      await manager.generateAndStoreKey();

      await manager.clearKey();

      expect(await manager.hasKey()).toBe(false);
      expect(await manager.getKey()).toBeNull();
    });

    it("should store externally provided key", async () => {
      const manager = new VaultKeyManager(storage, deviceSecret);
      const externalKey = generateKey();

      await manager.storeKey(externalKey);

      const retrievedKey = await manager.getKey();
      expect(retrievedKey).toEqual(externalKey);
    });

    it("should getOrCreateKey - create if none exists", async () => {
      const manager = new VaultKeyManager(storage, deviceSecret);

      const key = await manager.getOrCreateKey();

      expect(key.length).toBe(KEY_LENGTH);
      expect(await manager.hasKey()).toBe(true);
    });

    it("should getOrCreateKey - return existing if exists", async () => {
      const manager = new VaultKeyManager(storage, deviceSecret);
      const originalKey = await manager.generateAndStoreKey();

      const key = await manager.getOrCreateKey();

      expect(key).toEqual(originalKey);
    });

    it("should fail to decrypt with different device secret", async () => {
      const manager1 = new VaultKeyManager(storage, deviceSecret);
      await manager1.generateAndStoreKey();

      // Different device trying to access
      const differentSecret = generateKey();
      const manager2 = new VaultKeyManager(storage, differentSecret);

      const key = await manager2.getKey();
      expect(key).toBeNull();
    });
  });

  describe("deriveDeviceSecret", () => {
    it("should derive deterministic secret from Iroh key", () => {
      const irohKey = generateKey();

      const secret1 = deriveDeviceSecret(irohKey);
      const secret2 = deriveDeviceSecret(irohKey);

      expect(secret1).toEqual(secret2);
    });

    it("should derive different secrets from different keys", () => {
      const irohKey1 = generateKey();
      const irohKey2 = generateKey();

      const secret1 = deriveDeviceSecret(irohKey1);
      const secret2 = deriveDeviceSecret(irohKey2);

      expect(secret1).not.toEqual(secret2);
    });
  });

  describe("exportKeyWithPassphrase/importKeyWithPassphrase", () => {
    it("should export and import key with passphrase", () => {
      const vaultKey = generateKey();
      const passphrase = "correct-horse-battery-staple";

      const bundle = exportKeyWithPassphrase(vaultKey, passphrase);
      const importedKey = importKeyWithPassphrase(bundle, passphrase);

      expect(importedKey).toEqual(vaultKey);
    });

    it("should fail import with wrong passphrase", () => {
      const vaultKey = generateKey();

      const bundle = exportKeyWithPassphrase(vaultKey, "correct-passphrase");
      const importedKey = importKeyWithPassphrase(bundle, "wrong-passphrase");

      expect(importedKey).toBeNull();
    });

    it("should produce different bundles for same key (random salt)", () => {
      const vaultKey = generateKey();
      const passphrase = "same-passphrase";

      const bundle1 = exportKeyWithPassphrase(vaultKey, passphrase);
      const bundle2 = exportKeyWithPassphrase(vaultKey, passphrase);

      expect(bundle1).not.toEqual(bundle2);
    });
  });
});

// ============================================================================
// Key Exchange Tests
// ============================================================================

describe("key-exchange", () => {
  describe("generateKeyExchangeKeypair", () => {
    it("should generate valid keypair", () => {
      const keypair = generateKeyExchangeKeypair();

      expect(keypair.publicKey.length).toBe(KEY_LENGTH);
      expect(keypair.secretKey.length).toBe(KEY_LENGTH);
    });

    it("should generate different keypairs each time", () => {
      const keypair1 = generateKeyExchangeKeypair();
      const keypair2 = generateKeyExchangeKeypair();

      expect(keypair1.publicKey).not.toEqual(keypair2.publicKey);
      expect(keypair1.secretKey).not.toEqual(keypair2.secretKey);
    });
  });

  describe("encryptVaultKeyForRecipient/decryptVaultKeyFromSender", () => {
    it("should encrypt and decrypt vault key", () => {
      const recipientKeypair = generateKeyExchangeKeypair();
      const vaultKey = generateKey();

      const bundle = encryptVaultKeyForRecipient(vaultKey, recipientKeypair.publicKey);
      const decrypted = decryptVaultKeyFromSender(bundle, recipientKeypair.secretKey);

      expect(decrypted).toEqual(vaultKey);
    });

    it("should fail decryption with wrong secret key", () => {
      const recipientKeypair = generateKeyExchangeKeypair();
      const wrongKeypair = generateKeyExchangeKeypair();
      const vaultKey = generateKey();

      const bundle = encryptVaultKeyForRecipient(vaultKey, recipientKeypair.publicKey);
      const decrypted = decryptVaultKeyFromSender(bundle, wrongKeypair.secretKey);

      expect(decrypted).toBeNull();
    });

    it("should produce different ciphertext each time (ephemeral keys)", () => {
      const recipientKeypair = generateKeyExchangeKeypair();
      const vaultKey = generateKey();

      const bundle1 = encryptVaultKeyForRecipient(vaultKey, recipientKeypair.publicKey);
      const bundle2 = encryptVaultKeyForRecipient(vaultKey, recipientKeypair.publicKey);

      // Ephemeral keys should be different
      expect(bundle1.ephemeralPublicKey).not.toEqual(bundle2.ephemeralPublicKey);
    });
  });

  describe("serializeKeyBundle/deserializeKeyBundle", () => {
    it("should serialize and deserialize bundle", () => {
      const recipientKeypair = generateKeyExchangeKeypair();
      const vaultKey = generateKey();

      const bundle = encryptVaultKeyForRecipient(vaultKey, recipientKeypair.publicKey);
      const serialized = serializeKeyBundle(bundle);
      const deserialized = deserializeKeyBundle(serialized);

      expect(deserialized.ephemeralPublicKey).toEqual(bundle.ephemeralPublicKey);
      expect(deserialized.nonce).toEqual(bundle.nonce);
      expect(deserialized.ciphertext).toEqual(bundle.ciphertext);
    });

    it("should throw on malformed data", () => {
      const tooShort = new Uint8Array(10);
      expect(() => deserializeKeyBundle(tooShort)).toThrow(/too short/);
    });

    it("should throw on unsupported version", () => {
      const wrongVersion = new Uint8Array(100);
      wrongVersion[0] = 0x99; // Invalid version
      expect(() => deserializeKeyBundle(wrongVersion)).toThrow(/Unsupported/);
    });
  });

  describe("KeyExchangeSession", () => {
    it("should complete full key exchange between two parties", () => {
      // Alice and Bob each create a session
      const aliceSession = new KeyExchangeSession();
      const bobSession = new KeyExchangeSession();

      // Exchange public keys
      aliceSession.setPeerPublicKey(bobSession.getPublicKey());
      bobSession.setPeerPublicKey(aliceSession.getPublicKey());

      // Alice encrypts vault key for Bob
      const vaultKey = generateKey();
      const encrypted = aliceSession.encryptForPeer(vaultKey);

      // Bob decrypts
      const decrypted = bobSession.decryptFromPeer(encrypted);

      expect(decrypted).toEqual(vaultKey);
    });

    it("should throw if encrypting before setting peer key", () => {
      const session = new KeyExchangeSession();
      const vaultKey = generateKey();

      expect(() => session.encryptForPeer(vaultKey)).toThrow(/Peer public key not set/);
    });

    it("should report whether peer key is set", () => {
      const session = new KeyExchangeSession();
      const otherKeypair = generateKeyExchangeKeypair();

      expect(session.hasPeerPublicKey()).toBe(false);

      session.setPeerPublicKey(otherKeypair.publicKey);

      expect(session.hasPeerPublicKey()).toBe(true);
    });

    it("should allow reuse with different peers", () => {
      const session = new KeyExchangeSession();
      const peer1 = generateKeyExchangeKeypair();
      const peer2 = generateKeyExchangeKeypair();
      const vaultKey = generateKey();

      // Exchange with peer1
      session.setPeerPublicKey(peer1.publicKey);
      const encrypted1 = session.encryptForPeer(vaultKey);

      // Clear and exchange with peer2
      session.clear();
      session.setPeerPublicKey(peer2.publicKey);
      const encrypted2 = session.encryptForPeer(vaultKey);

      // Both should decrypt correctly with respective keys
      const decrypted1 = decryptVaultKeyFromSender(
        deserializeKeyBundle(encrypted1),
        peer1.secretKey
      );
      const decrypted2 = decryptVaultKeyFromSender(
        deserializeKeyBundle(encrypted2),
        peer2.secretKey
      );

      expect(decrypted1).toEqual(vaultKey);
      expect(decrypted2).toEqual(vaultKey);
    });
  });
});
