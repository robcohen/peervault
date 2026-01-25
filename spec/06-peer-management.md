# Peer Management Spec

## Purpose

Define how peers are discovered, paired, stored, and managed throughout the lifecycle of vault synchronization.

## Requirements

- **REQ-PM-01**: MUST support manual pairing via ticket/QR code
- **REQ-PM-02**: MUST persist known peers across restarts
- **REQ-PM-03**: MUST auto-reconnect to known peers on startup
- **REQ-PM-04**: MUST allow removing peers
- **REQ-PM-05**: MUST display peer connection status

## Peer Data Model

```typescript
interface Peer {
  /** Iroh NodeId (public key) */
  nodeId: string;

  /** User-assigned name for this peer */
  name: string;

  /** Last known connection ticket */
  ticket: string;

  /** When this peer was added */
  addedAt: string;

  /** Last successful sync timestamp */
  lastSyncAt: string | null;

  /** Whether to auto-connect on startup */
  autoConnect: boolean;
}

interface PeerState {
  /** Static peer info */
  peer: Peer;

  /** Current connection status */
  status: 'disconnected' | 'connecting' | 'connected' | 'syncing';

  /** Active connection if connected */
  connection: PeerConnection | null;

  /** Last error if any */
  lastError: string | null;
}
```

## Interface

```typescript
interface PeerManager {
  /**
   * Get all known peers.
   */
  getPeers(): Peer[];

  /**
   * Get current state of all peers.
   */
  getPeerStates(): PeerState[];

  /**
   * Add a new peer via their ticket.
   * @returns The new peer, or existing peer if already known
   */
  addPeer(ticket: string, name: string): Promise<Peer>;

  /**
   * Remove a peer and disconnect.
   */
  removePeer(nodeId: string): Promise<void>;

  /**
   * Update peer settings.
   */
  updatePeer(nodeId: string, updates: Partial<Pick<Peer, 'name' | 'autoConnect'>>): Promise<void>;

  /**
   * Manually trigger connection to a peer.
   */
  connectToPeer(nodeId: string): Promise<void>;

  /**
   * Disconnect from a peer (but keep in peer list).
   */
  disconnectPeer(nodeId: string): Promise<void>;

  /**
   * Connect to all auto-connect peers.
   */
  connectAll(): Promise<void>;

  /**
   * Subscribe to peer state changes.
   */
  onPeerStateChange(callback: (states: PeerState[]) => void): () => void;
}
```

## Pairing Flow

### Device A (Initiator)

```
1. User clicks "Add Device"
2. Generate ticket: transport.generateTicket()
3. Display as QR code + copyable text
4. Wait for incoming connection
5. On connect: add peer, start sync
```

### Device B (Joiner)

```
1. User clicks "Join Device"
2. Scan QR code or paste ticket
3. Connect: transport.connectWithTicket(ticket)
4. On connect: add peer, start sync
```

## Sequence Diagrams

### Device Pairing Flow

```
┌──────────┐          ┌─────────┐          ┌──────────┐
│ Device A │          │   User  │          │ Device B │
│(Initiator)│          │         │          │ (Joiner) │
└────┬─────┘          └────┬────┘          └────┬─────┘
     │                     │                    │
     │  Click "Add Device" │                    │
     │◄────────────────────│                    │
     │                     │                    │
     │  generateTicket()   │                    │
     │─────────┐           │                    │
     │         │           │                    │
     │◄────────┘           │                    │
     │                     │                    │
     │  Display QR Code    │                    │
     │────────────────────►│                    │
     │                     │                    │
     │                     │  Scan QR / Paste   │
     │                     │───────────────────►│
     │                     │                    │
     │                     │     Click "Join"   │
     │                     │───────────────────►│
     │                     │                    │
     │                     │  connectWithTicket()
     │◄─────────────────── Iroh Connection ────►│
     │                     │                    │
     │  onIncomingConnection()                  │
     │─────────┐           │                    │
     │         │           │                    │
     │◄────────┘           │                    │
     │                     │                    │
     │  Prompt for name    │                    │
     │────────────────────►│                    │
     │                     │                    │
     │  "MacBook Pro"      │                    │
     │◄────────────────────│                    │
     │                     │                    │
     │  addPeer()          │      addPeer()     │
     │─────────┐           │    ┌───────────────│
     │         │           │    │               │
     │◄────────┘           │    └──────────────►│
     │                     │                    │
     │◄════════════ Begin Sync ════════════════►│
     │                     │                    │
     │  "Connected!"       │    "Connected!"    │
     │────────────────────►│◄───────────────────│
     │                     │                    │
```

### Connection Lifecycle

```
┌────────────┐     ┌────────────┐     ┌────────────┐     ┌────────────┐
│Disconnected│     │ Connecting │     │ Connected  │     │  Syncing   │
└─────┬──────┘     └─────┬──────┘     └─────┬──────┘     └─────┬──────┘
      │                  │                  │                  │
      │ connectToPeer()  │                  │                  │
      │─────────────────►│                  │                  │
      │                  │                  │                  │
      │                  │ success          │                  │
      │                  │─────────────────►│                  │
      │                  │                  │                  │
      │                  │                  │ syncWithPeer()   │
      │                  │                  │─────────────────►│
      │                  │                  │                  │
      │                  │                  │ sync complete    │
      │                  │                  │◄─────────────────│
      │                  │                  │                  │
      │                  │ connection       │                  │
      │                  │ failed           │                  │
      │◄─────────────────│                  │                  │
      │                  │                  │                  │
      │ scheduleReconnect()                 │                  │
      │────────┐         │                  │                  │
      │        │ (10s)   │                  │                  │
      │◄───────┘         │                  │                  │
      │                  │                  │                  │
      │                  │                  │ disconnect       │
      │◄─────────────────────────────────────────────────────│
      │                  │                  │                  │
      │ if autoConnect:  │                  │                  │
      │ scheduleReconnect()                 │                  │
      │                  │                  │                  │
```

### Incoming Connection Handling

```
┌────────────┐     ┌────────────┐     ┌────────────┐
│   Iroh     │     │   Peer     │     │   Sync     │
│ Transport  │     │  Manager   │     │  Engine    │
└─────┬──────┘     └─────┬──────┘     └─────┬──────┘
      │                  │                  │
      │ incoming         │                  │
      │ connection       │                  │
      │─────────────────►│                  │
      │                  │                  │
      │                  │ is nodeId in     │
      │                  │ peers list?      │
      │                  │─────────┐        │
      │                  │         │        │
      │                  │◄────────┘        │
      │                  │                  │
      │                  │ [if unknown]     │
      │                  │ reject & close   │
      │◄─────────────────│                  │
      │                  │                  │
      │                  │ [if known]       │
      │                  │ updateState()    │
      │                  │─────────┐        │
      │                  │         │        │
      │                  │◄────────┘        │
      │                  │                  │
      │                  │ syncWithPeer()   │
      │                  │─────────────────►│
      │                  │                  │
      │                  │                  │ begin sync
      │                  │                  │─────────┐
      │                  │                  │         │
      │                  │                  │◄────────┘
      │                  │                  │
```

### Implementation

```typescript
class PeerManagerImpl implements PeerManager {
  private peers: Map<string, Peer> = new Map();
  private states: Map<string, PeerState> = new Map();
  private stateListeners: ((states: PeerState[]) => void)[] = [];

  async addPeer(ticket: string, name: string): Promise<Peer> {
    // Parse ticket to get NodeId
    const parsedTicket = Ticket.parse(ticket);
    const nodeId = parsedTicket.nodeAddr().nodeId().toString();

    // Check if already known
    if (this.peers.has(nodeId)) {
      return this.peers.get(nodeId)!;
    }

    // Create peer record
    const peer: Peer = {
      nodeId,
      name,
      ticket,
      addedAt: new Date().toISOString(),
      lastSyncAt: null,
      autoConnect: true,
    };

    // Persist
    this.peers.set(nodeId, peer);
    await this.savePeers();

    // Initialize state
    this.states.set(nodeId, {
      peer,
      status: 'disconnected',
      connection: null,
      lastError: null,
    });

    // Auto-connect
    this.connectToPeer(nodeId);

    this.notifyStateChange();
    return peer;
  }

  async connectToPeer(nodeId: string): Promise<void> {
    const peer = this.peers.get(nodeId);
    if (!peer) throw new Error('Unknown peer');

    const state = this.states.get(nodeId)!;
    if (state.status === 'connected' || state.status === 'connecting') {
      return;
    }

    this.updateState(nodeId, { status: 'connecting', lastError: null });

    try {
      const connection = await this.transport.connectWithTicket(peer.ticket);

      this.updateState(nodeId, {
        status: 'connected',
        connection,
      });

      // Start sync
      this.syncEngine.syncWithPeer(connection);

      // Handle disconnection
      connection.onDisconnect(() => {
        this.handleDisconnect(nodeId);
      });
    } catch (err) {
      this.updateState(nodeId, {
        status: 'disconnected',
        lastError: err.message,
      });

      // Schedule retry
      this.scheduleReconnect(nodeId);
    }
  }

  private handleDisconnect(nodeId: string): void {
    this.updateState(nodeId, {
      status: 'disconnected',
      connection: null,
    });

    const peer = this.peers.get(nodeId);
    if (peer?.autoConnect) {
      this.scheduleReconnect(nodeId);
    }
  }

  private scheduleReconnect(nodeId: string): void {
    setTimeout(() => {
      const state = this.states.get(nodeId);
      if (state?.status === 'disconnected') {
        this.connectToPeer(nodeId);
      }
    }, 10000); // Retry after 10s
  }
}
```

## Persistence

Store peers in plugin data.json:

```typescript
// data.json
{
  "peers": [
    {
      "nodeId": "abc123...",
      "name": "MacBook Pro",
      "ticket": "iroh-ticket:...",
      "addedAt": "2024-01-15T10:30:00Z",
      "lastSyncAt": "2024-01-15T12:00:00Z",
      "autoConnect": true
    }
  ],
  "settings": {
    // other plugin settings
  }
}
```

```typescript
async savePeers(): Promise<void> {
  const data = await this.plugin.loadData() ?? {};
  data.peers = Array.from(this.peers.values());
  await this.plugin.saveData(data);
}

async loadPeers(): Promise<void> {
  const data = await this.plugin.loadData();
  if (data?.peers) {
    for (const peer of data.peers) {
      this.peers.set(peer.nodeId, peer);
      this.states.set(peer.nodeId, {
        peer,
        status: 'disconnected',
        connection: null,
        lastError: null,
      });
    }
  }
}
```

## Incoming Connections

Handle connections initiated by other peers:

```typescript
constructor(private transport: IrohTransport) {
  transport.onIncomingConnection(this.handleIncoming.bind(this));
}

private async handleIncoming(conn: PeerConnection): Promise<void> {
  const nodeId = conn.peerId;

  // Check if known peer
  if (!this.peers.has(nodeId)) {
    // Unknown peer - could prompt user or reject
    // For now, reject unknown peers
    console.log('Rejected unknown peer:', nodeId);
    conn.close();
    return;
  }

  // Update state
  this.updateState(nodeId, {
    status: 'connected',
    connection: conn,
  });

  // Start sync
  this.syncEngine.syncWithPeer(conn);
}
```

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- Iroh Transport (05-transport-iroh.md)
- Sync Engine (04-sync-protocol.md)
- Obsidian Plugin API for persistence

## Presence & Awareness (v2)

Presence information shows what peers are doing in real-time. Unlike document CRDTs, presence is ephemeral and doesn't need persistence.

### Awareness Data Model

Based on [Yjs Awareness CRDT](https://docs.yjs.dev/getting-started/adding-awareness):

```typescript
/**
 * Ephemeral presence state for a peer.
 * Broadcast frequently, not persisted.
 */
interface PeerPresence {
  /** Peer's node ID */
  peerId: string;

  /** User-assigned display name */
  userName: string;

  /** Assigned color for UI (hex) */
  userColor: string;

  /** Currently active file (if any) */
  activeFile?: string;

  /** Cursor position in active file (character offset) */
  cursorPosition?: number;

  /** Selection range (if selecting text) */
  selection?: { start: number; end: number };

  /** Current activity */
  activity: 'idle' | 'viewing' | 'editing' | 'syncing';

  /** Timestamp of last update */
  lastUpdate: number;
}

/**
 * Aggregated awareness state for all peers.
 */
interface AwarenessState {
  /** Map of peerId -> presence */
  peers: Map<string, PeerPresence>;

  /** Local peer's presence (what we broadcast) */
  localPresence: PeerPresence;
}
```

### Awareness Protocol

Presence uses a lightweight state-based CRDT that broadcasts the full local state periodically:

```typescript
interface AwarenessManager {
  /**
   * Update local presence state.
   */
  setLocalPresence(update: Partial<PeerPresence>): void;

  /**
   * Get current presence for all peers.
   */
  getAwarenessState(): AwarenessState;

  /**
   * Subscribe to presence changes.
   */
  onAwarenessChange(callback: (state: AwarenessState) => void): void;

  /**
   * Start broadcasting presence.
   */
  start(): void;

  /**
   * Stop broadcasting (on disconnect/unload).
   */
  stop(): void;
}

class AwarenessManagerImpl implements AwarenessManager {
  private state: AwarenessState;
  private broadcastInterval: NodeJS.Timeout | null = null;

  private readonly BROADCAST_INTERVAL_MS = 1000;  // Every second
  private readonly STALE_THRESHOLD_MS = 5000;     // Consider stale after 5s

  start(): void {
    // Broadcast our presence periodically
    this.broadcastInterval = setInterval(() => {
      this.broadcastPresence();
      this.pruneStalePresence();
    }, this.BROADCAST_INTERVAL_MS);
  }

  private async broadcastPresence(): void {
    const message: PresenceMessage = {
      type: 'presence',
      presence: this.state.localPresence,
    };

    // Send to all connected peers
    for (const peer of this.peerManager.getConnectedPeers()) {
      await peer.connection.sendPresence(message);
    }
  }

  private pruneStalePresence(): void {
    const now = Date.now();
    for (const [peerId, presence] of this.state.peers) {
      if (now - presence.lastUpdate > this.STALE_THRESHOLD_MS) {
        this.state.peers.delete(peerId);
        this.emit('awarenessChange', this.state);
      }
    }
  }

  handlePresenceMessage(peerId: string, message: PresenceMessage): void {
    this.state.peers.set(peerId, {
      ...message.presence,
      lastUpdate: Date.now(),
    });
    this.emit('awarenessChange', this.state);
  }
}
```

### Presence UI Integration

```typescript
// Show who's viewing the same file
function renderFilePresence(
  filePath: string,
  awareness: AwarenessState
): PeerPresence[] {
  return Array.from(awareness.peers.values())
    .filter(p => p.activeFile === filePath);
}

// Show cursor positions in editor
function renderCursors(
  filePath: string,
  awareness: AwarenessState
): CursorDecoration[] {
  return Array.from(awareness.peers.values())
    .filter(p => p.activeFile === filePath && p.cursorPosition !== undefined)
    .map(p => ({
      position: p.cursorPosition!,
      selection: p.selection,
      color: p.userColor,
      label: p.userName,
    }));
}
```

### Presence Message Format

```typescript
type PresenceMessage =
  | { type: 'presence'; presence: PeerPresence }
  | { type: 'presence-query' }  // Request current presence from peer
  | { type: 'presence-leave' }; // Explicit disconnect notification
```

### Privacy Considerations

Presence reveals user activity. Configurable options:

```typescript
interface PresenceConfig {
  /** Enable presence broadcasting */
  enabled: boolean;

  /** Share which file is currently open */
  shareActiveFile: boolean;

  /** Share cursor position */
  shareCursor: boolean;

  /** Share when typing (activity: 'editing') */
  shareEditingStatus: boolean;
}

const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  enabled: true,
  shareActiveFile: true,
  shareCursor: false,        // Off by default (privacy)
  shareEditingStatus: true,
};
```

## Pairing Rate Limiting

Prevent brute-force and denial-of-service attacks during the pairing process.

### Rate Limits

| Action | Limit | Window | Lockout |
|--------|-------|--------|---------|
| Generate ticket | 5/min | 1 minute | 5 min cooldown |
| Parse/validate ticket | 10/min | 1 minute | 5 min cooldown |
| Connection attempts | 3/min per IP | 1 minute | 15 min cooldown |
| Failed auth attempts | 3 total | Per session | Close connection |

### Implementation

```typescript
interface RateLimitConfig {
  /** Max attempts allowed */
  maxAttempts: number;

  /** Time window in ms */
  windowMs: number;

  /** Lockout duration after exceeding limit */
  lockoutMs: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  ticketGeneration: { maxAttempts: 5, windowMs: 60000, lockoutMs: 300000 },
  ticketValidation: { maxAttempts: 10, windowMs: 60000, lockoutMs: 300000 },
  connectionAttempts: { maxAttempts: 3, windowMs: 60000, lockoutMs: 900000 },
  failedAuth: { maxAttempts: 3, windowMs: 0, lockoutMs: 0 }, // Per-session
};

class PairingRateLimiter {
  private attempts = new Map<string, number[]>();
  private lockouts = new Map<string, number>();

  /**
   * Check if an action is allowed.
   * @returns true if allowed, false if rate limited
   */
  check(action: string, identifier: string): boolean {
    const key = `${action}:${identifier}`;
    const config = RATE_LIMITS[action];

    if (!config) return true;

    // Check lockout
    const lockoutExpiry = this.lockouts.get(key);
    if (lockoutExpiry && Date.now() < lockoutExpiry) {
      return false;
    }

    // Clean old attempts
    const now = Date.now();
    const attempts = this.attempts.get(key) || [];
    const recentAttempts = attempts.filter(t => t > now - config.windowMs);

    // Check limit
    if (recentAttempts.length >= config.maxAttempts) {
      this.lockouts.set(key, now + config.lockoutMs);
      return false;
    }

    // Record attempt
    recentAttempts.push(now);
    this.attempts.set(key, recentAttempts);

    return true;
  }

  /**
   * Get remaining time before lockout expires.
   */
  getLockoutRemaining(action: string, identifier: string): number {
    const key = `${action}:${identifier}`;
    const lockoutExpiry = this.lockouts.get(key);

    if (!lockoutExpiry) return 0;

    const remaining = lockoutExpiry - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Clear lockout (e.g., after successful action).
   */
  clearLockout(action: string, identifier: string): void {
    const key = `${action}:${identifier}`;
    this.lockouts.delete(key);
    this.attempts.delete(key);
  }
}
```

### Integration with Peer Manager

```typescript
class PeerManagerImpl implements PeerManager {
  private rateLimiter = new PairingRateLimiter();

  async generateTicket(): Promise<string> {
    const identifier = 'local'; // Local device

    if (!this.rateLimiter.check('ticketGeneration', identifier)) {
      const remaining = this.rateLimiter.getLockoutRemaining('ticketGeneration', identifier);
      throw new Error(`Rate limited. Try again in ${Math.ceil(remaining / 1000)}s`);
    }

    return this.transport.generateTicket();
  }

  async addPeer(ticket: string, name: string): Promise<Peer> {
    const identifier = 'local';

    if (!this.rateLimiter.check('ticketValidation', identifier)) {
      const remaining = this.rateLimiter.getLockoutRemaining('ticketValidation', identifier);
      throw new Error(`Too many attempts. Try again in ${Math.ceil(remaining / 1000)}s`);
    }

    try {
      const parsedTicket = Ticket.parse(ticket);
      // ... rest of addPeer logic

      // Clear lockout on success
      this.rateLimiter.clearLockout('ticketValidation', identifier);

      return peer;
    } catch (error) {
      // Let rate limiter track the failed attempt
      throw error;
    }
  }

  private async handleIncoming(conn: PeerConnection): Promise<void> {
    const nodeId = conn.peerId;

    // Rate limit by peer ID
    if (!this.rateLimiter.check('connectionAttempts', nodeId)) {
      console.log(`Rate limited peer: ${nodeId}`);
      conn.close();
      return;
    }

    // Check if known peer
    if (!this.peers.has(nodeId)) {
      console.log('Rejected unknown peer:', nodeId);
      conn.close();
      return;
    }

    // ... rest of handleIncoming logic
  }
}
```

### Ticket Expiration

Tickets should have a limited validity period:

```typescript
interface TicketOptions {
  /** Ticket validity duration in seconds */
  expiresIn: number;

  /** Include relay hints for NAT traversal */
  includeRelayHints: boolean;
}

const DEFAULT_TICKET_OPTIONS: TicketOptions = {
  expiresIn: 300, // 5 minutes
  includeRelayHints: true,
};

async function generateTimeLimitedTicket(
  transport: IrohTransport,
  options: TicketOptions = DEFAULT_TICKET_OPTIONS
): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = await transport.generateTicket();

  // Ticket metadata (stored locally, not encoded in ticket)
  const expiresAt = new Date(Date.now() + options.expiresIn * 1000);

  return { ticket, expiresAt };
}

function isTicketExpired(ticketMeta: { expiresAt: Date }): boolean {
  return new Date() > ticketMeta.expiresAt;
}
```

## Deep Link Pairing

Enable pairing via `obsidian://` URLs for easier cross-device pairing without QR scanning.

### URI Scheme

```
obsidian://peervault?action=pair&ticket=<encoded-ticket>&name=<suggested-name>
```

### URL Components

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | Must be `pair` |
| `ticket` | Yes | URL-encoded Iroh ticket |
| `name` | No | Suggested name for the initiating device |
| `vault` | No | Vault ID hint (for multi-vault) |

### Implementation

```typescript
/**
 * Deep link handler for PeerVault pairing.
 */
class DeepLinkHandler {
  private readonly PROTOCOL = 'obsidian';
  private readonly HOST = 'peervault';

  constructor(private plugin: PeerVaultPlugin) {
    // Register URI handler with Obsidian
    this.plugin.registerObsidianProtocolHandler('peervault', this.handleUri.bind(this));
  }

  /**
   * Handle incoming deep link.
   */
  private async handleUri(params: ObsidianProtocolData): Promise<void> {
    const action = params.action;

    if (action !== 'pair') {
      new Notice(`Unknown PeerVault action: ${action}`);
      return;
    }

    await this.handlePairAction(params);
  }

  private async handlePairAction(params: ObsidianProtocolData): Promise<void> {
    const ticket = params.ticket;
    const suggestedName = params.name ? decodeURIComponent(params.name) : undefined;
    const vaultHint = params.vault;

    if (!ticket) {
      new Notice('Invalid pairing link: missing ticket');
      return;
    }

    // Validate ticket format
    try {
      const decoded = decodeURIComponent(ticket);
      Ticket.parse(decoded);
    } catch (error) {
      new Notice(`Invalid pairing link: ${error.message}`);
      return;
    }

    // Check vault hint matches current vault
    if (vaultHint && vaultHint !== this.plugin.getVaultId()) {
      const proceed = await this.confirmVaultMismatch(vaultHint);
      if (!proceed) return;
    }

    // Show pairing confirmation modal
    new DeepLinkPairModal(
      this.plugin.app,
      this.plugin,
      decodeURIComponent(ticket),
      suggestedName
    ).open();
  }

  private async confirmVaultMismatch(expectedVault: string): Promise<boolean> {
    return new Promise(resolve => {
      const modal = new Modal(this.plugin.app);
      modal.contentEl.createEl('h2', { text: 'Vault Mismatch' });
      modal.contentEl.createEl('p', {
        text: `This pairing link is for a different vault. Proceed anyway?`,
      });

      const buttons = modal.contentEl.createDiv({ cls: 'modal-buttons' });

      buttons.createEl('button', { text: 'Cancel' }).onclick = () => {
        modal.close();
        resolve(false);
      };

      buttons.createEl('button', { text: 'Proceed', cls: 'mod-warning' }).onclick = () => {
        modal.close();
        resolve(true);
      };

      modal.open();
    });
  }

  /**
   * Generate a deep link for pairing.
   */
  generatePairingLink(ticket: string, deviceName?: string): string {
    const params = new URLSearchParams({
      action: 'pair',
      ticket: encodeURIComponent(ticket),
    });

    if (deviceName) {
      params.set('name', encodeURIComponent(deviceName));
    }

    // Include vault ID for multi-vault disambiguation
    const vaultId = this.plugin.getVaultId();
    if (vaultId) {
      params.set('vault', vaultId);
    }

    return `obsidian://peervault?${params.toString()}`;
  }
}

/**
 * Modal shown when user opens a pairing deep link.
 */
class DeepLinkPairModal extends Modal {
  constructor(
    app: App,
    private plugin: PeerVaultPlugin,
    private ticket: string,
    private suggestedName?: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Pair with Device' });

    contentEl.createEl('p', {
      text: 'You received a pairing request from another device.',
    });

    // Name input
    let nameValue = this.suggestedName || '';

    new Setting(contentEl)
      .setName('Device Name')
      .setDesc('Name for this device (visible to the other device)')
      .addText(text => {
        text.setValue(nameValue);
        text.setPlaceholder('e.g., Desktop PC');
        text.onChange(value => { nameValue = value; });
      });

    // Buttons
    const buttons = contentEl.createDiv({ cls: 'modal-buttons' });

    buttons.createEl('button', { text: 'Cancel' }).onclick = () => {
      this.close();
    };

    const pairBtn = buttons.createEl('button', {
      text: 'Pair',
      cls: 'mod-cta',
    });

    pairBtn.onclick = async () => {
      if (!nameValue.trim()) {
        new Notice('Please enter a device name');
        return;
      }

      pairBtn.disabled = true;
      pairBtn.setText('Connecting...');

      try {
        await this.plugin.peerManager.addPeer(this.ticket, nameValue.trim());
        new Notice(`Connected to ${nameValue.trim()}`);
        this.close();
      } catch (error) {
        new Notice(`Pairing failed: ${error.message}`);
        pairBtn.disabled = false;
        pairBtn.setText('Pair');
      }
    };
  }
}
```

### Generating Shareable Links

```typescript
/**
 * Enhanced add device modal with deep link support.
 */
class AddDeviceModalWithDeepLink extends Modal {
  private ticket: string = '';
  private deepLink: string = '';

  async onOpen(): Promise<void> {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Add Device' });

    // Generate ticket and deep link
    this.ticket = await this.plugin.peerManager.generateTicket();
    this.deepLink = this.plugin.deepLinkHandler.generatePairingLink(
      this.ticket,
      this.plugin.settings.deviceName
    );

    // Tabs: QR Code | Link
    const tabs = contentEl.createDiv({ cls: 'peervault-tabs' });

    const qrTab = tabs.createEl('button', { text: 'QR Code', cls: 'active' });
    const linkTab = tabs.createEl('button', { text: 'Share Link' });

    const qrContent = contentEl.createDiv({ cls: 'tab-content' });
    const linkContent = contentEl.createDiv({ cls: 'tab-content hidden' });

    qrTab.onclick = () => {
      qrTab.addClass('active');
      linkTab.removeClass('active');
      qrContent.removeClass('hidden');
      linkContent.addClass('hidden');
    };

    linkTab.onclick = () => {
      linkTab.addClass('active');
      qrTab.removeClass('active');
      linkContent.removeClass('hidden');
      qrContent.addClass('hidden');
    };

    // QR Content
    this.renderQrContent(qrContent);

    // Link Content
    this.renderLinkContent(linkContent);

    // Status
    contentEl.createEl('p', {
      text: 'Waiting for connection...',
      cls: 'peervault-waiting',
    });
  }

  private renderQrContent(container: HTMLElement): void {
    container.createEl('p', {
      text: 'Scan this QR code from another device',
    });

    const qrContainer = container.createDiv({ cls: 'peervault-qr' });
    QRCode.toCanvas(qrContainer, this.deepLink, { width: 256 });
  }

  private renderLinkContent(container: HTMLElement): void {
    container.createEl('p', {
      text: 'Share this link to pair devices:',
    });

    // Deep link
    const linkInput = container.createEl('input', {
      type: 'text',
      cls: 'deep-link-input',
    });
    linkInput.value = this.deepLink;
    linkInput.readOnly = true;

    const copyBtn = container.createEl('button', { text: 'Copy Link' });
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(this.deepLink);
      new Notice('Link copied to clipboard');
    };

    // Platform-specific instructions
    container.createEl('h4', { text: 'How to use:' });

    const instructions = container.createEl('ul');
    instructions.createEl('li', {
      text: 'Desktop: Open this link in a browser, or paste in Obsidian',
    });
    instructions.createEl('li', {
      text: 'Mobile: Tap the link or paste it in Obsidian URI input',
    });
    instructions.createEl('li', {
      text: 'Telegram/Discord: Just paste and send - recipients can tap to open',
    });

    // Share via system share sheet (mobile)
    if (navigator.share) {
      const shareBtn = container.createEl('button', { text: 'Share...' });
      shareBtn.onclick = async () => {
        try {
          await navigator.share({
            title: 'PeerVault Pairing',
            text: 'Connect your Obsidian vault with PeerVault',
            url: this.deepLink,
          });
        } catch (error) {
          if (error.name !== 'AbortError') {
            new Notice('Share failed');
          }
        }
      };
    }
  }
}
```

### Security Considerations

```typescript
/**
 * Deep link security measures.
 */
const DEEP_LINK_SECURITY = {
  /**
   * Rate limit deep link processing to prevent abuse.
   */
  rateLimit: {
    maxPerMinute: 5,
    lockoutMinutes: 5,
  },

  /**
   * Require user confirmation before pairing.
   * Never auto-pair from deep links.
   */
  requireConfirmation: true,

  /**
   * Validate ticket cryptographically before showing modal.
   */
  preValidateTicket: true,

  /**
   * Log deep link attempts for debugging.
   */
  logAttempts: true,
};

/**
 * Validate deep link before processing.
 */
function validateDeepLink(params: ObsidianProtocolData): ValidationResult {
  const errors: string[] = [];

  // Required parameters
  if (!params.action) {
    errors.push('Missing action parameter');
  }

  if (params.action === 'pair' && !params.ticket) {
    errors.push('Missing ticket parameter');
  }

  // Ticket format validation (basic)
  if (params.ticket) {
    try {
      const decoded = decodeURIComponent(params.ticket);
      if (!decoded.startsWith('iroh-ticket:') && !decoded.startsWith('node')) {
        errors.push('Invalid ticket format');
      }
    } catch {
      errors.push('Malformed ticket encoding');
    }
  }

  // Length limits
  if (params.ticket && params.ticket.length > 10000) {
    errors.push('Ticket too long');
  }

  if (params.name && params.name.length > 100) {
    errors.push('Name too long');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}
```

### iOS/Android Considerations

```typescript
/**
 * Platform-specific deep link handling.
 */
const PLATFORM_NOTES = {
  iOS: `
    - obsidian:// links work when Obsidian is installed
    - Links may open in default browser first, then redirect
    - Universal Links (https://obsidian.md/peervault/...) are preferred
  `,

  android: `
    - obsidian:// links handled by Intent filter
    - May show app chooser if multiple apps register same scheme
    - Verify links work with latest Obsidian version
  `,

  desktop: `
    - Works when Obsidian is running
    - May require Obsidian to be set as protocol handler
    - Command palette also supports pasting tickets directly
  `,
};
```

## Error Handling

| Error | Recovery |
|-------|----------|
| Invalid ticket | Show error, don't add peer |
| Connection refused | Retry with backoff |
| Peer removed during sync | Abort sync cleanly |
| Presence broadcast fails | Silent fail, retry next interval |
| Deep link rate limited | Show cooldown message |
| Deep link malformed | Show validation error |

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Unknown peer policy | Reject all unknown peers | Only paired peers can connect. Most secure approach. |
| Peer limits | User-configurable | Let users set max peers in settings based on their needs. |
| Peer groups | Yes, support peer groups | Different peers for different vaults. Enables shared reference vaults, team vaults, etc. |
