# Security Model Spec

## Purpose

Define the security architecture for PeerVault, including threat model, trust relationships, encryption, and access control.

## Requirements

- **REQ-SEC-01**: All peer-to-peer communication MUST be encrypted
- **REQ-SEC-02**: Peers MUST be authenticated before sync
- **REQ-SEC-03**: Private keys MUST be stored securely
- **REQ-SEC-04**: Only explicitly paired peers can access vault data
- **REQ-SEC-05**: Compromised peer MUST NOT compromise other peers' data

## Threat Model

### Assets to Protect

| Asset | Description | Sensitivity |
|-------|-------------|-------------|
| Vault content | Markdown files, notes | High |
| Edit history | Loro version history | Medium |
| Peer list | Who you sync with | Medium |
| Private key | Iroh endpoint identity | Critical |
| Tickets | Connection information | High (temporary) |
| Encryption passphrase | Data-at-rest key | Critical |

### Threat Actors

| Actor | Capability | Motivation |
|-------|------------|------------|
| Network eavesdropper | Passive traffic analysis | Data theft |
| Active attacker | MITM, packet injection | Data theft, manipulation |
| Malicious peer | Full protocol access | Data theft, corruption |
| Compromised device | Full local access | All data |
| Relay operator | Relayed traffic access | Metadata collection |

### Threat Scenarios

```
┌────────────────────────────────────────────────────────────┐
│                      Threat Scenarios                       │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Eavesdropping                                          │
│     Attacker ──[sniff]──► Encrypted stream                 │
│     Mitigation: All traffic encrypted (Iroh/QUIC)          │
│                                                             │
│  2. Man-in-the-Middle                                       │
│     Peer A ◄──[attacker]──► Peer B                         │
│     Mitigation: Public key authentication                   │
│                                                             │
│  3. Replay Attack                                           │
│     Attacker ──[replay old sync]──► Peer                   │
│     Mitigation: Loro version vectors                        │
│                                                             │
│  4. Unauthorized Peer                                       │
│     Unknown ──[connect]──► Your endpoint                   │
│     Mitigation: Peer allowlist, reject unknown             │
│                                                             │
│  5. Malicious Document                                      │
│     Peer ──[send huge doc]──► Your device                  │
│     Mitigation: Size limits, resource quotas               │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Trust Model

### Trust Relationships

```
                    ┌─────────────────┐
                    │  Your Device    │
                    │  (Full Trust)   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
       ┌──────────┐   ┌──────────┐   ┌──────────┐
       │ Paired   │   │ Paired   │   │ Paired   │
       │ Peer A   │   │ Peer B   │   │ Peer C   │
       │ (Trusted)│   │ (Trusted)│   │ (Trusted)│
       └──────────┘   └──────────┘   └──────────┘
              │              │              │
              └──────────────┴──────────────┘
                             │
                    (Peers trust each other
                     transitively for sync)
```

### Trust Levels

| Level | Description | Capabilities |
|-------|-------------|--------------|
| **Self** | Your own devices | Full read/write, admin |
| **Paired Peer** | Explicitly added peer | Full read/write sync |
| **Unknown** | Connection without pairing | Rejected |

### Trust Decisions

1. **Pairing**: User explicitly adds peer via ticket
2. **Sync**: Only paired peers can initiate sync
3. **Data**: All data from paired peers is accepted (CRDT merge)

**Important**: Once paired, a peer can send any data. The trust model is binary (paired or not), not granular.

## Encryption

### Transport Encryption (Iroh)

Iroh uses QUIC with TLS 1.3:
- All traffic encrypted
- Forward secrecy via ephemeral keys
- Peer authentication via public keys

```
┌─────────────┐                      ┌─────────────┐
│   Peer A    │                      │   Peer B    │
│             │                      │             │
│ Private Key │                      │ Private Key │
│ Public Key  │◄────── TLS 1.3 ─────►│ Public Key  │
│             │    Encrypted QUIC    │             │
└─────────────┘                      └─────────────┘
```

### Key Management

```typescript
interface KeyManagement {
  /**
   * Generate new keypair on first run.
   * Store securely in plugin data.
   */
  generateKeypair(): Promise<Keypair>;

  /**
   * Load existing keypair from storage.
   */
  loadKeypair(): Promise<Keypair | null>;

  /**
   * Get public key (NodeId) for sharing.
   */
  getPublicKey(): string;

  /**
   * Securely wipe key from memory.
   */
  destroyKey(): void;
}
```

### Key Storage

**Platform-specific secure storage with fallbacks:**

| Platform | Primary Storage | Fallback |
|----------|-----------------|----------|
| iOS | Keychain Services | Encrypted file with passphrase |
| Android | Android Keystore | Encrypted file with passphrase |
| macOS (Electron) | macOS Keychain via safeStorage | Encrypted plugin data |
| Windows (Electron) | DPAPI via safeStorage | Encrypted plugin data |
| Linux (Electron) | Secret Service/libsecret via safeStorage | Encrypted plugin data |
| Web (unsupported) | N/A | Encrypted IndexedDB (session only) |

```typescript
/**
 * Storage backend interface for platform-specific implementations.
 */
interface KeyStorageBackend {
  readonly name: string;
  readonly isSecure: boolean;  // True if hardware-backed or OS-protected
  isAvailable(): Promise<boolean>;
  store(key: string, data: Uint8Array): Promise<void>;
  load(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/**
 * iOS Keychain backend using Capacitor Secure Storage.
 */
class IOSKeychainBackend implements KeyStorageBackend {
  readonly name = 'iOS Keychain';
  readonly isSecure = true;

  async isAvailable(): Promise<boolean> {
    return Platform.isIOS && 'SecureStoragePlugin' in window;
  }

  async store(key: string, data: Uint8Array): Promise<void> {
    const { SecureStoragePlugin } = await import('@capacitor-community/secure-storage');
    await SecureStoragePlugin.set({
      key,
      value: this.uint8ArrayToBase64(data),
    });
  }

  async load(key: string): Promise<Uint8Array | null> {
    const { SecureStoragePlugin } = await import('@capacitor-community/secure-storage');
    try {
      const { value } = await SecureStoragePlugin.get({ key });
      return value ? this.base64ToUint8Array(value) : null;
    } catch {
      return null;  // Key not found
    }
  }

  async delete(key: string): Promise<void> {
    const { SecureStoragePlugin } = await import('@capacitor-community/secure-storage');
    await SecureStoragePlugin.remove({ key });
  }

  private uint8ArrayToBase64(data: Uint8Array): string {
    return btoa(String.fromCharCode(...data));
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    return new Uint8Array(atob(base64).split('').map(c => c.charCodeAt(0)));
  }
}

/**
 * Android Keystore backend.
 */
class AndroidKeystoreBackend implements KeyStorageBackend {
  readonly name = 'Android Keystore';
  readonly isSecure = true;

  async isAvailable(): Promise<boolean> {
    return Platform.isAndroid && 'SecureStoragePlugin' in window;
  }

  async store(key: string, data: Uint8Array): Promise<void> {
    const { SecureStoragePlugin } = await import('@capacitor-community/secure-storage');
    await SecureStoragePlugin.set({
      key,
      value: btoa(String.fromCharCode(...data)),
    });
  }

  async load(key: string): Promise<Uint8Array | null> {
    const { SecureStoragePlugin } = await import('@capacitor-community/secure-storage');
    try {
      const { value } = await SecureStoragePlugin.get({ key });
      return value ? new Uint8Array(atob(value).split('').map(c => c.charCodeAt(0))) : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const { SecureStoragePlugin } = await import('@capacitor-community/secure-storage');
    await SecureStoragePlugin.remove({ key });
  }
}

/**
 * Electron safeStorage backend (uses OS keychain/credential manager).
 */
class ElectronSafeStorageBackend implements KeyStorageBackend {
  readonly name: string;
  readonly isSecure = true;

  constructor() {
    this.name = Platform.isMacOS ? 'macOS Keychain' :
                Platform.isWindows ? 'Windows DPAPI' :
                'Linux Secret Service';
  }

  async isAvailable(): Promise<boolean> {
    if (!Platform.isElectron) return false;
    try {
      const { safeStorage } = require('electron');
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async store(key: string, data: Uint8Array): Promise<void> {
    const { safeStorage } = require('electron');
    const encrypted = safeStorage.encryptString(btoa(String.fromCharCode(...data)));
    await this.writeToFile(key, encrypted);
  }

  async load(key: string): Promise<Uint8Array | null> {
    const { safeStorage } = require('electron');
    const encrypted = await this.readFromFile(key);
    if (!encrypted) return null;
    const decrypted = safeStorage.decryptString(encrypted);
    return new Uint8Array(atob(decrypted).split('').map(c => c.charCodeAt(0)));
  }

  async delete(key: string): Promise<void> {
    await this.deleteFile(key);
  }

  private async writeToFile(key: string, data: Buffer): Promise<void> {
    const fs = require('fs').promises;
    const path = require('path');
    const filePath = path.join(this.getStorageDir(), `${key}.enc`);
    await fs.writeFile(filePath, data);
  }

  private async readFromFile(key: string): Promise<Buffer | null> {
    const fs = require('fs').promises;
    const path = require('path');
    const filePath = path.join(this.getStorageDir(), `${key}.enc`);
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  private async deleteFile(key: string): Promise<void> {
    const fs = require('fs').promises;
    const path = require('path');
    const filePath = path.join(this.getStorageDir(), `${key}.enc`);
    try { await fs.unlink(filePath); } catch { /* ignore */ }
  }

  private getStorageDir(): string {
    const { app } = require('electron');
    return app.getPath('userData');
  }
}

/**
 * Passphrase-encrypted file storage fallback.
 * Used when platform secure storage is unavailable.
 */
class EncryptedFileBackend implements KeyStorageBackend {
  readonly name = 'Encrypted File (Passphrase)';
  readonly isSecure = false;  // Depends on passphrase strength

  private passphrase: string | null = null;

  async isAvailable(): Promise<boolean> {
    return true;  // Always available as fallback
  }

  setPassphrase(passphrase: string): void {
    this.passphrase = passphrase;
  }

  async store(key: string, data: Uint8Array): Promise<void> {
    if (!this.passphrase) throw new Error('Passphrase required for encrypted storage');

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const derivedKey = await this.deriveKey(this.passphrase, salt);

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      derivedKey,
      data,
    );

    // Format: salt (16) + iv (12) + ciphertext
    const combined = new Uint8Array(16 + 12 + encrypted.byteLength);
    combined.set(salt);
    combined.set(iv, 16);
    combined.set(new Uint8Array(encrypted), 28);

    await this.plugin.saveData({
      ...await this.plugin.loadData(),
      [key]: btoa(String.fromCharCode(...combined)),
    });
  }

  async load(key: string): Promise<Uint8Array | null> {
    if (!this.passphrase) throw new Error('Passphrase required for encrypted storage');

    const data = await this.plugin.loadData();
    const encoded = data?.[key];
    if (!encoded) return null;

    const combined = new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)));
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const ciphertext = combined.slice(28);

    const derivedKey = await this.deriveKey(this.passphrase, salt);

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        derivedKey,
        ciphertext,
      );
      return new Uint8Array(decrypted);
    } catch {
      throw new Error('Invalid passphrase or corrupted data');
    }
  }

  async delete(key: string): Promise<void> {
    const data = await this.plugin.loadData();
    if (data?.[key]) {
      delete data[key];
      await this.plugin.saveData(data);
    }
  }

  private async deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100_000,  // OWASP recommendation
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private plugin: any;  // Obsidian plugin instance
}

/**
 * Main key storage class with automatic fallback handling.
 */
class SecureKeyStorage {
  private readonly STORAGE_KEY = 'peervault-keypair';
  private backend: KeyStorageBackend | null = null;
  private readonly backends: KeyStorageBackend[];

  constructor(private plugin: any) {
    // Order by security preference
    this.backends = [
      new IOSKeychainBackend(),
      new AndroidKeystoreBackend(),
      new ElectronSafeStorageBackend(),
      new EncryptedFileBackend(),
    ];
  }

  /**
   * Initialize storage, selecting the best available backend.
   * Returns the selected backend info.
   */
  async initialize(passphrase?: string): Promise<{
    backend: string;
    isSecure: boolean;
    requiresPassphrase: boolean;
  }> {
    for (const backend of this.backends) {
      if (await backend.isAvailable()) {
        this.backend = backend;

        // Set passphrase for fallback backend
        if (backend instanceof EncryptedFileBackend && passphrase) {
          backend.setPassphrase(passphrase);
        }

        return {
          backend: backend.name,
          isSecure: backend.isSecure,
          requiresPassphrase: backend instanceof EncryptedFileBackend,
        };
      }
    }

    throw new Error('No key storage backend available');
  }

  async store(keypair: Keypair): Promise<void> {
    if (!this.backend) throw new Error('Storage not initialized');
    await this.backend.store(this.STORAGE_KEY, keypair.toBytes());
  }

  async load(): Promise<Keypair | null> {
    if (!this.backend) throw new Error('Storage not initialized');
    const data = await this.backend.load(this.STORAGE_KEY);
    return data ? Keypair.fromBytes(data) : null;
  }

  async delete(): Promise<void> {
    if (!this.backend) throw new Error('Storage not initialized');
    await this.backend.delete(this.STORAGE_KEY);
  }

  /**
   * Migrate keys from one backend to another (e.g., when upgrading).
   */
  async migrate(targetBackend: KeyStorageBackend): Promise<void> {
    if (!this.backend) throw new Error('Storage not initialized');
    const data = await this.backend.load(this.STORAGE_KEY);
    if (data) {
      await targetBackend.store(this.STORAGE_KEY, data);
      await this.backend.delete(this.STORAGE_KEY);
      this.backend = targetBackend;
    }
  }
}
```

#### Passphrase Requirements

When using the encrypted file fallback, enforce minimum passphrase strength:

```typescript
interface PassphraseValidation {
  isValid: boolean;
  strength: 'weak' | 'fair' | 'strong';
  issues: string[];
}

function validatePassphrase(passphrase: string): PassphraseValidation {
  const issues: string[] = [];

  if (passphrase.length < 12) {
    issues.push('Must be at least 12 characters');
  }
  if (!/[A-Z]/.test(passphrase)) {
    issues.push('Should include uppercase letters');
  }
  if (!/[a-z]/.test(passphrase)) {
    issues.push('Should include lowercase letters');
  }
  if (!/[0-9]/.test(passphrase)) {
    issues.push('Should include numbers');
  }

  const strength = issues.length === 0 ? 'strong' :
                   issues.length <= 2 ? 'fair' : 'weak';

  return {
    isValid: passphrase.length >= 8,  // Minimum requirement
    strength,
    issues,
  };
}
```

## Authentication

### Peer Authentication Flow

```
┌─────────────────────────────────────────────────────────────┐
│                  Peer Authentication                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Connection Attempt                                       │
│     ┌────────┐                          ┌────────┐          │
│     │ Peer A │ ────── Connect ────────► │ Peer B │          │
│     └────────┘                          └────────┘          │
│                                                              │
│  2. TLS Handshake (Iroh/QUIC)                               │
│     - Exchange public keys                                   │
│     - Verify signatures                                      │
│     - Establish encrypted channel                            │
│                                                              │
│  3. Application-Level Check                                  │
│     ┌────────┐                          ┌────────┐          │
│     │ Peer A │                          │ Peer B │          │
│     └────┬───┘                          └────┬───┘          │
│          │                                   │               │
│          │  Is Peer A's NodeId in           │               │
│          │  my paired peers list?           │               │
│          │                                   │               │
│          │         ┌─────────┐              │               │
│          │         │  Yes?   │              │               │
│          │         └────┬────┘              │               │
│          │              │                   │               │
│          │    ┌─────────┴─────────┐        │               │
│          │    ▼                   ▼        │               │
│          │  Accept             Reject      │               │
│          │  (sync)             (close)     │               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
class PeerAuthenticator {
  constructor(private peerManager: PeerManager) {}

  /**
   * Verify incoming connection is from a paired peer.
   */
  authenticate(connection: IncomingConnection): AuthResult {
    const remoteNodeId = connection.remoteNodeId();

    // Check if this NodeId is in our paired peers
    const peer = this.peerManager.getPeerByNodeId(remoteNodeId);

    if (!peer) {
      return {
        allowed: false,
        reason: 'Unknown peer',
        nodeId: remoteNodeId,
      };
    }

    return {
      allowed: true,
      peer,
      nodeId: remoteNodeId,
    };
  }
}
```

## Access Control

### Current Model (v1)

Binary access: paired peers have full read/write access.

### Future Considerations (v2+)

| Access Level | Capabilities |
|--------------|--------------|
| Owner | Full access, can add/remove peers |
| Editor | Read/write sync |
| Viewer | Read-only sync |

**Not implemented in v1** - adds significant complexity.

## Ticket Security

Tickets contain sensitive connection information:

```typescript
interface TicketSecurity {
  /**
   * Tickets should be:
   * - Transmitted securely (QR code in person, encrypted message)
   * - Used once and discarded
   * - Time-limited if possible
   */
}
```

### Best Practices for Users

1. Share tickets in person via QR code when possible
2. If sending remotely, use encrypted channel (Signal, etc.)
3. Don't post tickets publicly
4. Tickets remain valid until endpoint restarts

### Ticket Expiration (Future)

```typescript
// Future: Time-limited tickets
interface TimedTicket {
  ticket: string;
  expiresAt: Date;
  usageCount: number;
  maxUsages: number;
}
```

## Data at Rest

### Encrypted Storage (Implemented)

The `.loro` file is encrypted at rest using AES-256-GCM with a user-provided passphrase:

```typescript
interface EncryptedStorageConfig {
  /** Encryption algorithm */
  algorithm: 'AES-256-GCM';

  /** Key derivation function */
  kdf: 'PBKDF2';

  /** KDF iterations (minimum 100,000) */
  iterations: number;

  /** Salt length in bytes */
  saltLength: 16;
}

class EncryptedStorage {
  private key: CryptoKey | null = null;

  /**
   * Derive encryption key from user passphrase.
   * Called on plugin startup - user must enter passphrase.
   */
  async unlock(passphrase: string, salt: Uint8Array): Promise<void> {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    this.key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt Loro document before writing to disk.
   */
  async encrypt(doc: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new Error('Storage locked');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.key,
      doc
    );

    // Prepend IV to ciphertext
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), iv.length);
    return result;
  }

  /**
   * Decrypt Loro document after reading from disk.
   */
  async decrypt(encrypted: Uint8Array): Promise<Uint8Array> {
    if (!this.key) throw new Error('Storage locked');

    const iv = encrypted.slice(0, 12);
    const ciphertext = encrypted.slice(12);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.key,
      ciphertext
    );

    return new Uint8Array(plaintext);
  }

  /**
   * Lock storage - clear key from memory.
   */
  lock(): void {
    this.key = null;
  }
}
```

### Passphrase Requirements

| Requirement | Value |
|-------------|-------|
| Minimum length | 8 characters |
| Recommended length | 16+ characters |
| Stored | Never (derived key only) |
| Recovery | Not possible without passphrase |

### User Flow

```
┌─────────────────────────────────────────────────────────────┐
│                  Encryption User Flow                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  First Run:                                                  │
│  1. User enables encryption in settings                      │
│  2. User creates passphrase                                  │
│  3. Salt generated and stored in meta.json                   │
│  4. Existing .loro file encrypted                            │
│                                                              │
│  Subsequent Runs:                                            │
│  1. Plugin detects encrypted storage                         │
│  2. Prompts user for passphrase                              │
│  3. Derives key and unlocks storage                          │
│  4. Sync operations proceed normally                         │
│                                                              │
│  Wrong Passphrase:                                           │
│  - Decryption fails with authentication error                │
│  - User prompted to retry (max 3 attempts)                   │
│  - Plugin disabled after 3 failures                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Security Recommendations for Users

1. **Enable full-disk encryption** on all devices
2. **Share tickets securely** - in person or via encrypted messaging
3. **Review paired peers** periodically, remove unused
4. **Keep Obsidian updated** for security patches
5. **Don't sync sensitive vaults** on shared/public devices

## Incident Response

### Compromised Device

If a paired device is compromised:

1. Remove the device from paired peers on all other devices
2. Device's NodeId is immediately blocked
3. Historical data already synced cannot be revoked
4. Consider rotating vault if sensitive data exposed

### Lost Device

1. Remove from paired peers
2. Historical access cannot be revoked
3. No remote wipe capability (no central server)

## Peer Revocation Mechanism

When a peer needs to be revoked (lost device, compromised, no longer trusted), the revocation must propagate to all other peers in the network.

### Revocation Levels

| Level | Action | Effect |
|-------|--------|--------|
| **Soft** | Mark peer as "paused" | No sync, can reconnect later |
| **Hard** | Mark peer as "blocked" | Reject all connections permanently |
| **Urgent** | Broadcast block to all peers | Network-wide immediate block |

### Revocation Data Structure

```typescript
interface PeerRevocation {
  /** The revoked peer's NodeId */
  revokedNodeId: string;

  /** When revocation was issued */
  revokedAt: number;

  /** Who issued the revocation */
  revokedBy: string;

  /** Revocation level */
  level: 'soft' | 'hard' | 'urgent';

  /** Human-readable reason */
  reason: string;

  /** Cryptographic proof (signature) */
  signature: string;
}
```

### Revocation Protocol

```typescript
class PeerRevocationManager {
  private revocations = new Map<string, PeerRevocation>();

  /**
   * Revoke a peer's access.
   */
  async revokePeer(
    nodeId: string,
    level: PeerRevocation['level'],
    reason: string
  ): Promise<void> {
    const revocation: PeerRevocation = {
      revokedNodeId: nodeId,
      revokedAt: Date.now(),
      revokedBy: this.transport.getNodeId(),
      level,
      reason,
      signature: '', // Filled below
    };

    // Sign the revocation
    revocation.signature = await this.signRevocation(revocation);

    // Store locally
    this.revocations.set(nodeId, revocation);
    await this.persistRevocations();

    // Disconnect if connected
    await this.transport.disconnectPeer(nodeId);

    // For urgent revocations, broadcast to all peers
    if (level === 'urgent') {
      await this.broadcastRevocation(revocation);
    }
  }

  /**
   * Check if a peer is revoked.
   */
  isRevoked(nodeId: string): boolean {
    const revocation = this.revocations.get(nodeId);
    if (!revocation) return false;

    // Soft revocations can be cleared
    if (revocation.level === 'soft') {
      return true; // Still revoked until explicitly cleared
    }

    return true;
  }

  /**
   * Handle incoming revocation from another peer.
   */
  async handleIncomingRevocation(revocation: PeerRevocation): Promise<void> {
    // Verify signature
    if (!await this.verifyRevocationSignature(revocation)) {
      console.warn('Invalid revocation signature, ignoring');
      return;
    }

    // Check if we trust the revoker
    if (!this.isTrustedPeer(revocation.revokedBy)) {
      console.warn('Revocation from untrusted peer, ignoring');
      return;
    }

    // Apply revocation
    const existing = this.revocations.get(revocation.revokedNodeId);
    if (!existing || existing.revokedAt < revocation.revokedAt) {
      this.revocations.set(revocation.revokedNodeId, revocation);
      await this.persistRevocations();

      // Disconnect if we're connected to the revoked peer
      if (this.transport.isConnectedTo(revocation.revokedNodeId)) {
        await this.transport.disconnectPeer(revocation.revokedNodeId);
      }
    }
  }

  /**
   * Broadcast revocation to all known peers.
   */
  private async broadcastRevocation(revocation: PeerRevocation): Promise<void> {
    const message = {
      type: 'revocation',
      payload: revocation,
    };

    for (const peer of this.peerManager.getConnectedPeers()) {
      if (peer.nodeId !== revocation.revokedNodeId) {
        try {
          await this.transport.sendMessage(peer.nodeId, message);
        } catch (error) {
          console.warn(`Failed to broadcast revocation to ${peer.nodeId}:`, error);
        }
      }
    }
  }

  /**
   * Sign a revocation for verification.
   * Uses TweetNaCl for Ed25519 signatures.
   */
  private signRevocation(revocation: PeerRevocation, secretKey: Uint8Array): string {
    const data = JSON.stringify({
      revokedNodeId: revocation.revokedNodeId,
      revokedAt: revocation.revokedAt,
      revokedBy: revocation.revokedBy,
      level: revocation.level,
      reason: revocation.reason,
    });

    const messageBytes = new TextEncoder().encode(data);
    const signature = nacl.sign.detached(messageBytes, secretKey);
    return nacl.util.encodeBase64(signature);
  }

  /**
   * Verify a revocation signature.
   * Uses TweetNaCl for Ed25519 verification.
   */
  private verifyRevocationSignature(revocation: PeerRevocation): boolean {
    const data = JSON.stringify({
      revokedNodeId: revocation.revokedNodeId,
      revokedAt: revocation.revokedAt,
      revokedBy: revocation.revokedBy,
      level: revocation.level,
      reason: revocation.reason,
    });

    const messageBytes = new TextEncoder().encode(data);
    const signatureBytes = nacl.util.decodeBase64(revocation.signature);
    const publicKeyBytes = nacl.util.decodeBase64(revocation.revokedBy);

    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  }
}
```

### Revocation UI

```typescript
class RevokePeerModal extends Modal {
  constructor(
    app: App,
    private peer: Peer,
    private revocationManager: PeerRevocationManager
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: `Revoke Peer: ${this.peer.name}` });

    // Warning
    contentEl.createEl('p', {
      text: 'Revoking a peer will permanently block them from syncing with you.',
      cls: 'revoke-warning',
    });

    // Revocation level
    let selectedLevel: PeerRevocation['level'] = 'hard';

    new Setting(contentEl)
      .setName('Revocation Level')
      .setDesc('How severely to revoke this peer')
      .addDropdown(dropdown => {
        dropdown
          .addOption('soft', 'Soft (can reconnect later)')
          .addOption('hard', 'Hard (permanent block)')
          .addOption('urgent', 'Urgent (broadcast to all peers)')
          .setValue('hard')
          .onChange(value => {
            selectedLevel = value as PeerRevocation['level'];
          });
      });

    // Reason
    let reason = '';

    new Setting(contentEl)
      .setName('Reason')
      .setDesc('Why are you revoking this peer?')
      .addTextArea(text => {
        text
          .setPlaceholder('Device lost, compromised, etc.')
          .onChange(value => { reason = value; });
      });

    // Confirm button
    new Setting(contentEl)
      .addButton(btn => {
        btn
          .setButtonText('Revoke Peer')
          .setWarning()
          .onClick(async () => {
            await this.revocationManager.revokePeer(
              this.peer.nodeId,
              selectedLevel,
              reason
            );
            this.close();
            new Notice(`Peer ${this.peer.name} has been revoked`);
          });
      })
      .addButton(btn => {
        btn
          .setButtonText('Cancel')
          .onClick(() => this.close());
      });
  }
}
```

### Revocation List Sync

Revocations are stored in a separate Loro document that syncs between peers:

```typescript
interface RevocationListDoc {
  /** Map of nodeId -> revocation */
  revocations: LoroMap<PeerRevocation>;

  /** Version for sync */
  version: number;
}

class RevocationListSync {
  private doc: LoroDoc;

  constructor() {
    this.doc = new LoroDoc();
  }

  /**
   * Sync revocation list with a peer.
   * Uses same protocol as vault sync but separate document.
   */
  async syncRevocations(peer: string): Promise<void> {
    const peerVersion = await this.transport.getRevocationVersion(peer);
    const localVersion = this.doc.version();

    if (needsUpdatesFrom(localVersion, peerVersion)) {
      const updates = await this.transport.getRevocationUpdates(peer, localVersion);
      this.doc.import(updates);
      await this.applyNewRevocations();
    }

    // Send our updates
    const ourUpdates = this.doc.export({ mode: 'update', from: peerVersion });
    await this.transport.sendRevocationUpdates(peer, ourUpdates);
  }

  private async applyNewRevocations(): Promise<void> {
    const revocations = this.doc.getMap('revocations');
    for (const [nodeId, revocation] of revocations.entries()) {
      await this.revocationManager.handleIncomingRevocation(revocation);
    }
  }
}
```

### Recovery from Revocation

```typescript
class RevocationRecovery {
  /**
   * Re-authorize a soft-revoked peer.
   * Hard revocations cannot be recovered.
   */
  async restorePeer(nodeId: string): Promise<boolean> {
    const revocation = this.revocationManager.getRevocation(nodeId);

    if (!revocation) {
      return false; // Not revoked
    }

    if (revocation.level !== 'soft') {
      throw new Error('Cannot restore hard-revoked peer');
    }

    // Remove revocation
    await this.revocationManager.removeRevocation(nodeId);

    // Re-enable peer
    await this.peerManager.enablePeer(nodeId);

    return true;
  }
}
```

## Read-Only Peers

Read-only peers can receive updates but cannot send changes. This is useful for:
- Shared reference vaults
- Archive devices
- Public documentation

### Implementation

```typescript
interface PeerPermissions {
  /** Can this peer send changes to us? */
  canWrite: boolean;

  /** Can this peer request our data? */
  canRead: boolean;
}

class ReadOnlyPeerEnforcement {
  /**
   * Filter incoming changes from read-only peers.
   * Called before importing updates.
   */
  filterIncomingUpdates(
    peerId: string,
    updates: Uint8Array,
    permissions: PeerPermissions
  ): Uint8Array | null {
    if (!permissions.canWrite) {
      // Reject all updates from read-only peers
      console.warn(`Rejected updates from read-only peer: ${peerId}`);
      return null;
    }
    return updates;
  }

  /**
   * Handle connection from read-only peer.
   * Only send our updates, ignore their changes.
   */
  async handleReadOnlySync(
    connection: IrohConnection,
    doc: LoroDoc
  ): Promise<void> {
    // Send our full state
    const snapshot = doc.export({ mode: 'snapshot' });
    connection.send({ type: 'snapshot', data: snapshot });

    // Don't wait for or accept their updates
    connection.send({ type: 'sync-complete' });
  }
}
```

### UI Indication

Read-only peers are marked in the peer list:
- 👁️ icon instead of sync icon
- "Read-only" badge
- Cannot send changes from this device

## Key Rotation

Key rotation allows changing the encryption passphrase or NodeId (Iroh identity) when needed.

### Passphrase Rotation

Change the encryption passphrase without losing data:

```typescript
class PassphraseRotation {
  /**
   * Rotate encryption passphrase.
   * Must be done while unlocked with current passphrase.
   */
  async rotatePassphrase(
    storage: EncryptedStorage,
    currentPassphrase: string,
    newPassphrase: string
  ): Promise<void> {
    // 1. Verify current passphrase works
    const salt = await this.loadSalt();
    await storage.unlock(currentPassphrase, salt);

    // 2. Read and decrypt all data
    const decryptedData = await storage.readDecrypted();

    // 3. Generate new salt
    const newSalt = crypto.getRandomValues(new Uint8Array(16));

    // 4. Lock storage (clears old key)
    storage.lock();

    // 5. Unlock with new passphrase (derives new key)
    await storage.unlock(newPassphrase, newSalt);

    // 6. Re-encrypt and save with new key
    await storage.writeEncrypted(decryptedData);

    // 7. Update salt in meta.json
    await this.saveSalt(newSalt);
  }

  /**
   * Validate passphrase meets requirements.
   */
  validatePassphrase(passphrase: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (passphrase.length < 8) {
      errors.push('Passphrase must be at least 8 characters');
    }
    if (passphrase.length < 16) {
      errors.push('Consider using 16+ characters for better security');
    }

    return { valid: errors.length === 0 || passphrase.length >= 8, errors };
  }
}
```

### Password Strength Validation

Comprehensive password strength validation using entropy calculation and common pattern detection.

#### Strength Levels

| Level | Score | Description | Use Case |
|-------|-------|-------------|----------|
| **Weak** | 0-1 | Easily guessable | Rejected |
| **Fair** | 2 | Somewhat guessable | Warning, discouraged |
| **Good** | 3 | Safely unguessable | Acceptable |
| **Strong** | 4 | Very unguessable | Recommended |

#### Strength Validator

```typescript
interface PasswordStrengthResult {
  /** Strength score 0-4 */
  score: number;

  /** Estimated crack time in seconds */
  crackTimeSeconds: number;

  /** Human-readable crack time */
  crackTimeDisplay: string;

  /** Specific feedback messages */
  feedback: {
    warning: string | null;
    suggestions: string[];
  };

  /** Whether password meets minimum requirements */
  valid: boolean;
}

class PasswordStrengthValidator {
  // Common password patterns to check against
  private readonly COMMON_PASSWORDS = new Set([
    'password', '12345678', 'qwerty', 'letmein', 'welcome',
    'monkey', 'dragon', 'master', 'login', 'passw0rd',
    // Load extended list from bundled file
  ]);

  private readonly KEYBOARD_PATTERNS = [
    'qwertyuiop', 'asdfghjkl', 'zxcvbnm',
    '1234567890', '0987654321',
    'qazwsx', 'edcrfv',
  ];

  /**
   * Validate password strength with detailed feedback.
   */
  validateStrength(password: string): PasswordStrengthResult {
    const checks = [
      this.checkLength(password),
      this.checkCommonPasswords(password),
      this.checkKeyboardPatterns(password),
      this.checkRepeatedChars(password),
      this.checkSequentialChars(password),
      this.checkCharacterVariety(password),
    ];

    // Aggregate results
    const issues = checks.filter(c => c.issue);
    const entropy = this.calculateEntropy(password);
    const crackTime = this.estimateCrackTime(entropy);

    const score = this.calculateScore(password, entropy, issues.length);

    return {
      score,
      crackTimeSeconds: crackTime,
      crackTimeDisplay: this.formatCrackTime(crackTime),
      feedback: {
        warning: issues[0]?.message || null,
        suggestions: issues.slice(1).map(i => i.message),
      },
      valid: score >= 2 && password.length >= 8,
    };
  }

  private checkLength(password: string): CheckResult {
    if (password.length < 8) {
      return { issue: true, message: 'Password is too short' };
    }
    if (password.length < 12) {
      return { issue: true, message: 'Consider a longer password for better security' };
    }
    return { issue: false };
  }

  private checkCommonPasswords(password: string): CheckResult {
    const lower = password.toLowerCase();
    if (this.COMMON_PASSWORDS.has(lower)) {
      return { issue: true, message: 'This is a commonly used password' };
    }
    // Check if password contains common password as substring
    for (const common of this.COMMON_PASSWORDS) {
      if (lower.includes(common) && common.length > 4) {
        return { issue: true, message: `Avoid common words like "${common}"` };
      }
    }
    return { issue: false };
  }

  private checkKeyboardPatterns(password: string): CheckResult {
    const lower = password.toLowerCase();
    for (const pattern of this.KEYBOARD_PATTERNS) {
      if (lower.includes(pattern.slice(0, 4))) {
        return { issue: true, message: 'Avoid keyboard patterns like "qwerty"' };
      }
    }
    return { issue: false };
  }

  private checkRepeatedChars(password: string): CheckResult {
    // Check for repeated characters (e.g., "aaaaaa")
    if (/(.)\1{3,}/.test(password)) {
      return { issue: true, message: 'Avoid repeated characters' };
    }
    return { issue: false };
  }

  private checkSequentialChars(password: string): CheckResult {
    // Check for sequential characters (e.g., "abcdef", "123456")
    const chars = password.split('');
    let sequential = 0;

    for (let i = 1; i < chars.length; i++) {
      if (chars[i].charCodeAt(0) === chars[i - 1].charCodeAt(0) + 1) {
        sequential++;
        if (sequential >= 3) {
          return { issue: true, message: 'Avoid sequential characters like "abc" or "123"' };
        }
      } else {
        sequential = 0;
      }
    }
    return { issue: false };
  }

  private checkCharacterVariety(password: string): CheckResult {
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSpecial = /[^a-zA-Z0-9]/.test(password);

    const varietyCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

    if (varietyCount < 2) {
      return { issue: true, message: 'Use a mix of letters, numbers, and symbols' };
    }
    return { issue: false };
  }

  private calculateEntropy(password: string): number {
    // Character set size
    let charsetSize = 0;
    if (/[a-z]/.test(password)) charsetSize += 26;
    if (/[A-Z]/.test(password)) charsetSize += 26;
    if (/[0-9]/.test(password)) charsetSize += 10;
    if (/[^a-zA-Z0-9]/.test(password)) charsetSize += 32;

    // Entropy = log2(charsetSize^length)
    return password.length * Math.log2(charsetSize || 1);
  }

  private estimateCrackTime(entropy: number): number {
    // Assume 10 billion guesses per second (modern hardware)
    const guessesPerSecond = 1e10;
    const possibleCombinations = Math.pow(2, entropy);
    return possibleCombinations / guessesPerSecond / 2; // Average time
  }

  private calculateScore(password: string, entropy: number, issueCount: number): number {
    // Base score from entropy
    let score = 0;
    if (entropy >= 60) score = 4;
    else if (entropy >= 40) score = 3;
    else if (entropy >= 28) score = 2;
    else if (entropy >= 18) score = 1;

    // Reduce score for issues
    score = Math.max(0, score - Math.floor(issueCount / 2));

    return score;
  }

  private formatCrackTime(seconds: number): string {
    if (seconds < 1) return 'instantly';
    if (seconds < 60) return `${Math.round(seconds)} seconds`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
    if (seconds < 2592000) return `${Math.round(seconds / 86400)} days`;
    if (seconds < 31536000) return `${Math.round(seconds / 2592000)} months`;
    if (seconds < 3153600000) return `${Math.round(seconds / 31536000)} years`;
    return 'centuries';
  }
}

interface CheckResult {
  issue: boolean;
  message?: string;
}
```

#### Password Strength UI

```typescript
class PasswordStrengthMeter {
  private container: HTMLElement;
  private validator = new PasswordStrengthValidator();

  constructor(parent: HTMLElement) {
    this.container = parent.createDiv({ cls: 'password-strength-meter' });
  }

  update(password: string): PasswordStrengthResult {
    const result = this.validator.validateStrength(password);

    // Clear previous content
    this.container.empty();

    // Strength bar
    const bar = this.container.createDiv({ cls: 'strength-bar' });
    const fill = bar.createDiv({
      cls: `strength-fill strength-${result.score}`,
    });
    fill.style.width = `${(result.score + 1) * 20}%`;

    // Strength label
    const labels = ['Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
    const label = this.container.createDiv({
      cls: 'strength-label',
      text: labels[result.score],
    });

    // Crack time estimate
    const crackTime = this.container.createDiv({
      cls: 'crack-time',
      text: `Time to crack: ${result.crackTimeDisplay}`,
    });

    // Feedback
    if (result.feedback.warning) {
      this.container.createDiv({
        cls: 'strength-warning',
        text: result.feedback.warning,
      });
    }

    for (const suggestion of result.feedback.suggestions) {
      this.container.createDiv({
        cls: 'strength-suggestion',
        text: suggestion,
      });
    }

    return result;
  }
}
```

#### CSS for Strength Meter

```css
.password-strength-meter {
  margin-top: 8px;
}

.strength-bar {
  height: 4px;
  background: var(--background-modifier-border);
  border-radius: 2px;
  overflow: hidden;
}

.strength-fill {
  height: 100%;
  transition: width 0.3s ease;
}

.strength-0 { background: var(--text-error); }
.strength-1 { background: #f59e0b; } /* orange */
.strength-2 { background: #eab308; } /* yellow */
.strength-3 { background: #22c55e; } /* green */
.strength-4 { background: #16a34a; } /* dark green */

.strength-label {
  font-size: var(--font-ui-small);
  margin-top: 4px;
}

.crack-time {
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
}

.strength-warning {
  color: var(--text-error);
  font-size: var(--font-ui-small);
  margin-top: 4px;
}

.strength-suggestion {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
}
```

### NodeId Rotation (Identity Reset)

Rotating the NodeId creates a new identity. All peers must re-pair:

```typescript
class NodeIdRotation {
  /**
   * Generate new Iroh identity.
   * WARNING: This breaks all existing peer connections!
   */
  async rotateNodeId(transport: IrohTransport): Promise<{
    newNodeId: string;
    backupRequired: boolean;
  }> {
    // 1. Disconnect all peers
    await transport.disconnectAll();

    // 2. Backup current identity (optional)
    const oldNodeId = transport.getNodeId();
    await this.backupIdentity(oldNodeId);

    // 3. Generate new secret key
    await transport.regenerateIdentity();

    // 4. Get new NodeId
    const newNodeId = transport.getNodeId();

    return {
      newNodeId,
      backupRequired: true, // Peers need to re-pair
    };
  }

  /**
   * Backup identity for recovery.
   */
  private async backupIdentity(nodeId: string): Promise<void> {
    const backup = {
      nodeId,
      timestamp: new Date().toISOString(),
      reason: 'rotation',
    };
    // Store in secure backup location (not in sync data)
    await this.storage.writeBackup(`identity-${nodeId.slice(0, 8)}.json`, backup);
  }
}
```

### When to Rotate Keys

| Scenario | Rotate Passphrase | Rotate NodeId |
|----------|-------------------|---------------|
| Suspected passphrase leak | Yes | No |
| Device compromised | Consider | Yes (if device still active) |
| Remove device permanently | No | No (just remove peer) |
| Periodic security hygiene | Optional | No |
| Switch to stronger passphrase | Yes | No |

### User Flow for Passphrase Rotation

```
┌─────────────────────────────────────────────────────────────┐
│                  Passphrase Rotation Flow                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. User opens Settings > Security                           │
│  2. Clicks "Change Passphrase"                               │
│  3. Enters current passphrase (verified)                     │
│  4. Enters new passphrase (validated)                        │
│  5. Confirms new passphrase                                  │
│  6. Progress: "Re-encrypting vault data..."                  │
│  7. Success message                                          │
│  8. All peers continue to work (no re-pairing needed)        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Rollback and Recovery

```typescript
interface KeyRotationState {
  inProgress: boolean;
  phase: 'decrypt' | 'rekey' | 'encrypt' | 'complete';
  backupPath: string | null;
  error: string | null;
}

async function safeRotatePassphrase(
  storage: EncryptedStorage,
  currentPassphrase: string,
  newPassphrase: string
): Promise<void> {
  const state: KeyRotationState = {
    inProgress: true,
    phase: 'decrypt',
    backupPath: null,
    error: null,
  };

  try {
    // 1. Create backup before any changes
    const backupPath = await storage.createBackup('pre-rotation');
    state.backupPath = backupPath;

    // 2. Proceed with rotation
    state.phase = 'decrypt';
    const data = await storage.readDecrypted();

    state.phase = 'rekey';
    const newSalt = crypto.getRandomValues(new Uint8Array(16));
    storage.lock();
    await storage.unlock(newPassphrase, newSalt);

    state.phase = 'encrypt';
    await storage.writeEncrypted(data);
    await saveSalt(newSalt);

    state.phase = 'complete';
    state.inProgress = false;

    // 3. Cleanup backup after successful rotation
    await storage.deleteBackup(backupPath);

  } catch (error) {
    state.error = error.message;

    // Rollback: restore from backup
    if (state.backupPath) {
      await storage.restoreBackup(state.backupPath);
      await storage.unlock(currentPassphrase, await loadSalt());
    }

    throw error;
  }
}
```

## Encryption Optional Flow

Some users may want to sync without encryption (trusted environments, simpler setup). This section defines the optional encryption flow.

### Encryption Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Encrypted** (default) | Passphrase-protected AES-256-GCM | Most users, security-conscious |
| **Unencrypted** | Plain Loro file on disk | Trusted devices, simpler setup |
| **Device-Encrypted** | Rely on OS full-disk encryption | Users with FDE enabled |

### Configuration

```typescript
interface EncryptionConfig {
  /** Encryption mode */
  mode: 'encrypted' | 'unencrypted' | 'device-encrypted';

  /** True if user explicitly chose unencrypted */
  unencryptedConfirmed: boolean;

  /** Salt for passphrase-based encryption */
  salt?: Uint8Array;

  /** Last time encryption settings changed */
  configChangedAt: string;
}

const DEFAULT_CONFIG: EncryptionConfig = {
  mode: 'encrypted',
  unencryptedConfirmed: false,
  configChangedAt: new Date().toISOString(),
};
```

### Storage Adapter Selection

```typescript
class StorageFactory {
  /**
   * Create appropriate storage adapter based on config.
   */
  createStorage(config: EncryptionConfig): StorageAdapter {
    switch (config.mode) {
      case 'encrypted':
        return new EncryptedStorage(config.salt!);

      case 'unencrypted':
        if (!config.unencryptedConfirmed) {
          throw new Error('Unencrypted mode requires explicit confirmation');
        }
        return new PlainStorage();

      case 'device-encrypted':
        // Trust OS-level encryption
        return new PlainStorage({ trustDeviceEncryption: true });
    }
  }
}

/**
 * Plain storage without application-level encryption.
 */
class PlainStorage implements StorageAdapter {
  constructor(private options?: { trustDeviceEncryption?: boolean }) {}

  async save(doc: LoroDoc): Promise<void> {
    const data = doc.export({ mode: 'snapshot' });
    await this.writeFile('vault.loro', data);
  }

  async load(): Promise<LoroDoc> {
    const data = await this.readFile('vault.loro');
    const doc = new LoroDoc();
    doc.import(data);
    return doc;
  }

  async isLocked(): Promise<boolean> {
    return false; // Never locked
  }

  async unlock(passphrase: string): Promise<void> {
    // No-op for plain storage
  }
}
```

### First-Run Encryption Choice

```typescript
class EncryptionSetupWizard {
  /**
   * Show encryption choice during first run.
   */
  async showEncryptionChoice(): Promise<EncryptionConfig> {
    return new Promise(resolve => {
      const modal = new Modal(this.app);

      modal.contentEl.createEl('h2', { text: 'Vault Encryption' });

      modal.contentEl.createEl('p', {
        text: 'PeerVault can encrypt your sync data with a passphrase. ' +
              'This protects your data if your device is lost or compromised.',
      });

      // Option 1: Encrypted (recommended)
      const encryptedOption = modal.contentEl.createDiv({ cls: 'encryption-option' });
      encryptedOption.createEl('h4', { text: '🔒 Encrypted (Recommended)' });
      encryptedOption.createEl('p', {
        text: 'Your data is encrypted with a passphrase. ' +
              "You'll need to enter it when starting Obsidian.",
        cls: 'option-desc',
      });

      const encryptedBtn = encryptedOption.createEl('button', {
        text: 'Use Encryption',
        cls: 'mod-cta',
      });

      // Option 2: Unencrypted
      const unencryptedOption = modal.contentEl.createDiv({ cls: 'encryption-option' });
      unencryptedOption.createEl('h4', { text: '🔓 Unencrypted' });
      unencryptedOption.createEl('p', {
        text: 'Your data is stored in plain text. ' +
              'Choose this if your device has full-disk encryption or you prefer simplicity.',
        cls: 'option-desc warning',
      });

      const unencryptedBtn = unencryptedOption.createEl('button', {
        text: 'Skip Encryption',
      });

      encryptedBtn.onclick = () => {
        modal.close();
        this.showPassphraseSetup(resolve);
      };

      unencryptedBtn.onclick = () => {
        modal.close();
        this.confirmUnencrypted(resolve);
      };

      modal.open();
    });
  }

  private async confirmUnencrypted(
    resolve: (config: EncryptionConfig) => void
  ): Promise<void> {
    const confirmed = await this.showConfirmDialog(
      'Are you sure?',
      'Without encryption, anyone with access to your device can read your sync data. ' +
      'Only proceed if your device has full-disk encryption or you understand the risks.',
      'Proceed Without Encryption',
      'Go Back'
    );

    if (confirmed) {
      resolve({
        mode: 'unencrypted',
        unencryptedConfirmed: true,
        configChangedAt: new Date().toISOString(),
      });
    } else {
      this.showEncryptionChoice().then(resolve);
    }
  }

  private async showPassphraseSetup(
    resolve: (config: EncryptionConfig) => void
  ): Promise<void> {
    const modal = new Modal(this.app);

    modal.contentEl.createEl('h2', { text: 'Create Passphrase' });

    modal.contentEl.createEl('p', {
      text: "Choose a strong passphrase. You'll need it every time you open this vault.",
    });

    let passphrase = '';
    let confirm = '';

    new Setting(modal.contentEl)
      .setName('Passphrase')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Enter passphrase');
        text.onChange(value => { passphrase = value; });
      });

    new Setting(modal.contentEl)
      .setName('Confirm')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Confirm passphrase');
        text.onChange(value => { confirm = value; });
      });

    const strengthIndicator = modal.contentEl.createDiv({ cls: 'passphrase-strength' });

    const createBtn = modal.contentEl.createEl('button', {
      text: 'Create Encrypted Storage',
      cls: 'mod-cta',
    });

    createBtn.onclick = () => {
      if (passphrase !== confirm) {
        new Notice('Passphrases do not match');
        return;
      }

      if (passphrase.length < 8) {
        new Notice('Passphrase must be at least 8 characters');
        return;
      }

      modal.close();

      const salt = crypto.getRandomValues(new Uint8Array(16));

      resolve({
        mode: 'encrypted',
        unencryptedConfirmed: false,
        salt,
        configChangedAt: new Date().toISOString(),
      });
    };

    modal.open();
  }
}
```

### Migration Between Modes

```typescript
class EncryptionMigration {
  /**
   * Migrate from unencrypted to encrypted.
   */
  async migrateToEncrypted(
    plainStorage: PlainStorage,
    passphrase: string
  ): Promise<EncryptedStorage> {
    // 1. Load unencrypted data
    const doc = await plainStorage.load();
    const data = doc.export({ mode: 'snapshot' });

    // 2. Create encrypted storage
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encryptedStorage = new EncryptedStorage(salt);

    // 3. Unlock with passphrase
    await encryptedStorage.unlock(passphrase);

    // 4. Save encrypted data
    await encryptedStorage.save(doc);

    // 5. Remove unencrypted file
    await plainStorage.delete();

    // 6. Update config
    await this.updateConfig({
      mode: 'encrypted',
      salt,
      unencryptedConfirmed: false,
      configChangedAt: new Date().toISOString(),
    });

    return encryptedStorage;
  }

  /**
   * Migrate from encrypted to unencrypted.
   * Requires passphrase to decrypt first.
   */
  async migrateToUnencrypted(
    encryptedStorage: EncryptedStorage,
    passphrase: string,
    confirmationCode: string
  ): Promise<PlainStorage> {
    // Require explicit confirmation
    if (confirmationCode !== 'I understand the risks') {
      throw new Error('Confirmation required to disable encryption');
    }

    // 1. Unlock and load encrypted data
    await encryptedStorage.unlock(passphrase);
    const doc = await encryptedStorage.load();

    // 2. Create plain storage
    const plainStorage = new PlainStorage();

    // 3. Save unencrypted data
    await plainStorage.save(doc);

    // 4. Remove encrypted file
    await encryptedStorage.delete();

    // 5. Update config
    await this.updateConfig({
      mode: 'unencrypted',
      unencryptedConfirmed: true,
      salt: undefined,
      configChangedAt: new Date().toISOString(),
    });

    return plainStorage;
  }
}
```

### Settings UI

```typescript
class EncryptionSettings {
  display(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Encryption' });

    const currentMode = this.plugin.settings.encryption.mode;

    // Current status
    const status = containerEl.createDiv({ cls: 'encryption-status' });
    status.createEl('strong', {
      text: `Current mode: ${this.formatMode(currentMode)}`,
    });

    if (currentMode === 'encrypted') {
      // Change passphrase
      new Setting(containerEl)
        .setName('Change passphrase')
        .setDesc('Update your encryption passphrase')
        .addButton(btn => {
          btn.setButtonText('Change');
          btn.onClick(() => this.showChangePassphraseModal());
        });

      // Disable encryption (with warning)
      new Setting(containerEl)
        .setName('Disable encryption')
        .setDesc('Remove encryption from your sync data (not recommended)')
        .addButton(btn => {
          btn.setButtonText('Disable');
          btn.setWarning();
          btn.onClick(() => this.confirmDisableEncryption());
        });
    } else {
      // Enable encryption
      new Setting(containerEl)
        .setName('Enable encryption')
        .setDesc('Protect your sync data with a passphrase')
        .addButton(btn => {
          btn.setButtonText('Enable');
          btn.setCta();
          btn.onClick(() => this.showEnableEncryptionModal());
        });
    }
  }

  private formatMode(mode: string): string {
    switch (mode) {
      case 'encrypted': return '🔒 Encrypted';
      case 'unencrypted': return '🔓 Unencrypted';
      case 'device-encrypted': return '💻 Device-encrypted';
      default: return mode;
    }
  }
}
```

### Security Implications Table

| Mode | Data at Rest | If Device Lost | Setup Complexity |
|------|--------------|----------------|------------------|
| Encrypted | Protected | Safe (without passphrase) | Medium |
| Unencrypted | Vulnerable | Compromised | Low |
| Device-encrypted | Depends on OS | Depends on OS | Low |

## Security Audit Checklist

| Item | Status | Notes |
|------|--------|-------|
| Transport encryption | ✅ | Via Iroh/QUIC TLS 1.3 |
| Peer authentication | ✅ | Public key verification |
| Peer authorization | ✅ | Allowlist model |
| Key storage | ✅ | Passphrase-derived encryption |
| Data at rest | ✅ | AES-256-GCM encryption |
| Ticket security | ⚠️ | No expiration (future improvement) |
| Input validation | ✅ | Loro validates structure |
| DoS protection | ⚠️ | Basic size limits |
| Read-only peers | ✅ | Enforced at sync layer |

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- Iroh (QUIC/TLS for transport security)
- Web Crypto API (encryption, key derivation)
- Loro (data integrity, CRDT validation)

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| OS keychain integration | No, use passphrase | Passphrase-based encryption simpler and more portable across platforms. |
| Encrypted storage | Yes, with user passphrase | Encrypt .crdt files with AES-256-GCM. User enters passphrase on startup. Accept performance tradeoff for security. |
| Read-only peers | Yes, implement in v1 | Support read-only peers that can receive but not send changes. Useful for shared reference vaults. |
| Audit logging | Optional, off by default | Log security events (peer connections, auth failures) when enabled. Power users can enable for troubleshooting. |
