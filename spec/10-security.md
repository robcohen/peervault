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
| Edit history | Automerge change history | Medium |
| Peer list | Who you sync with | Medium |
| Private key | Iroh endpoint identity | Critical |
| Tickets | Connection information | High (temporary) |

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
│     Mitigation: Automerge vector clocks                     │
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

**Desktop (Electron):**
- Store encrypted in Obsidian plugin data
- Consider OS keychain integration (future)

**Mobile:**
- Use platform secure storage (iOS Keychain, Android Keystore)
- Fall back to encrypted file if unavailable

```typescript
class SecureKeyStorage {
  private readonly STORAGE_KEY = 'peervault-keypair';

  async store(keypair: Keypair): Promise<void> {
    // Encrypt with device-specific key
    const encrypted = await this.encrypt(keypair.toBytes());

    // Store in plugin data
    await this.plugin.saveData({
      ...await this.plugin.loadData(),
      [this.STORAGE_KEY]: encrypted,
    });
  }

  async load(): Promise<Keypair | null> {
    const data = await this.plugin.loadData();
    const encrypted = data?.[this.STORAGE_KEY];

    if (!encrypted) return null;

    const bytes = await this.decrypt(encrypted);
    return Keypair.fromBytes(bytes);
  }

  private async encrypt(data: Uint8Array): Promise<string> {
    // Use Web Crypto API with device-derived key
    const key = await this.deriveDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      data,
    );

    // Combine IV + ciphertext, base64 encode
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  }
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

### Current: Unencrypted .crdt Files

.crdt files are stored unencrypted. Security relies on:
- OS file permissions
- Full-disk encryption (recommended)
- Obsidian vault location

### Future: Encrypted Storage

```typescript
// Future consideration: encrypt .crdt files
interface EncryptedStorage {
  /**
   * Encrypt documents before writing to disk.
   * Key derived from user passphrase or device key.
   */
  encrypt(doc: Uint8Array): Promise<Uint8Array>;
  decrypt(encrypted: Uint8Array): Promise<Uint8Array>;
}
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

## Security Audit Checklist

| Item | Status | Notes |
|------|--------|-------|
| Transport encryption | ✅ | Via Iroh/QUIC TLS 1.3 |
| Peer authentication | ✅ | Public key verification |
| Peer authorization | ✅ | Allowlist model |
| Key storage | ⚠️ | Basic encryption, no OS keychain |
| Data at rest | ⚠️ | Unencrypted, relies on OS |
| Ticket security | ⚠️ | No expiration |
| Input validation | ✅ | Automerge validates structure |
| DoS protection | ⚠️ | Basic size limits |

## Dependencies

- Iroh (QUIC/TLS for transport security)
- Web Crypto API (key encryption)
- Automerge (data integrity)

## Open Questions

1. **OS keychain integration**: Worth the complexity?
2. **Encrypted storage**: Performance impact? User experience for passphrase?
3. **Read-only peers**: Implement in v1 or defer?
4. **Audit logging**: Log security events for review?
