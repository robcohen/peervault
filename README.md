# PeerVault

P2P sync for Obsidian using Loro CRDT and Iroh transport. Sync your vaults directly between devices without a central server.

## Features

- **Conflict-free sync** - Concurrent edits merge automatically using Loro CRDTs
- **Offline-first** - Full functionality without network; sync when peers connect
- **No central server** - Direct P2P connections via Iroh with relay fallback
- **End-to-end encrypted** - All data encrypted in transit
- **Full history** - Edit history preserved; deletions are recoverable
- **Device groups** - Organize devices with per-group sync policies

## Installation

### From Release

1. Download the latest release from [Releases](https://github.com/robcohen/peervault/releases)
2. Extract to your vault's `.obsidian/plugins/peervault/` directory
3. Enable the plugin in Obsidian Settings > Community Plugins

### From Source

```bash
# Clone the repository
git clone https://github.com/robcohen/peervault.git
cd peervault

# Install dependencies
bun install

# Build
bun run build

# Copy to your vault
cp -r dist/* /path/to/vault/.obsidian/plugins/peervault/
```

## Usage

### Pairing Devices

1. Open PeerVault settings on both devices
2. On Device A: Click "Show QR Code" or copy the connection ticket
3. On Device B: Scan the QR code or paste the ticket
4. Accept the pairing request on Device A

### Syncing

Sync happens automatically when devices are connected. You can also:
- Click the status bar icon to see sync status
- Use Command Palette: "PeerVault: Sync now"
- Configure auto-sync interval in settings

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Obsidian Plugin                       │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ File Watcher│  │  Plugin UI  │  │ Peer Management │  │
│  └──────┬──────┘  └─────────────┘  └────────┬────────┘  │
│         │                                    │          │
│  ┌──────▼──────────────────────────┐  ┌─────▼───────┐  │
│  │      Loro Document Manager       │  │ Iroh WASM   │  │
│  │  - LoroTree for file hierarchy   │  │ - Endpoint  │  │
│  │  - LoroText for file content     │  │ - Streams   │  │
│  └──────┬──────────────────────────┘  └─────┬───────┘  │
│         │                                    │          │
│  ┌──────▼────────────────────────────────────▼───────┐  │
│  │                  Sync Protocol                     │  │
│  │  - Version vector exchange                         │  │
│  │  - Incremental update sync                         │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `DocumentManager` | `src/core/document-manager.ts` | Loro document operations, file tree |
| `VaultSync` | `src/core/vault-sync.ts` | File watcher, vault ↔ CRDT sync |
| `PeerManager` | `src/peer/peer-manager.ts` | Peer connections, pairing |
| `SyncSession` | `src/sync/sync-session.ts` | Sync protocol implementation |
| `IrohTransport` | `src/transport/iroh-transport.ts` | P2P networking via WASM |

### Technology Stack

| Component | Library | Purpose |
|-----------|---------|---------|
| CRDT Engine | [loro-crdt](https://loro.dev) | Conflict-free data structures |
| P2P Transport | [Iroh](https://iroh.computer) (WASM) | NAT traversal, encrypted streams |
| Encryption | [TweetNaCl](https://tweetnacl.js.org) | End-to-end encryption |
| Plugin Host | Obsidian Plugin API | File access, UI integration |

## Development

### Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Rust](https://rustup.rs) (for WASM builds)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)

### Commands

```bash
# Install dependencies
bun install

# Development build with watch
bun run dev

# Production build
bun run build

# Type check
bun run check

# Run tests
bun test

# Lint
bun run lint

# Format code
bun run format
```

### Building WASM

The Iroh transport uses a custom WASM module:

```bash
# Build WASM (requires Rust + wasm-pack)
just wasm

# Clean WASM build
just wasm-clean

# Verify WASM has no env imports
just wasm-check
```

### Project Structure

```
peervault/
├── src/
│   ├── core/           # Document management, vault sync
│   ├── peer/           # Peer management, groups
│   ├── sync/           # Sync protocol, messages
│   ├── transport/      # Iroh transport layer
│   ├── ui/             # Settings, modals, status bar
│   └── utils/          # Shared utilities
├── peervault-iroh/     # Rust WASM bindings for Iroh
├── spec/               # Design specifications
└── tests/              # Test suites
```

### Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/document-manager.test.ts

# Run with coverage
bun test --coverage
```

## Specifications

Detailed design documents are in the `/spec` directory:

| Spec | Description |
|------|-------------|
| [00-overview](spec/00-overview.md) | System architecture |
| [01-data-model](spec/01-data-model.md) | Loro document schemas |
| [04-sync-protocol](spec/04-sync-protocol.md) | Sync message protocol |
| [05-transport-iroh](spec/05-transport-iroh.md) | P2P networking |
| [10-security](spec/10-security.md) | Threat model, encryption |
| [15-peer-groups](spec/15-peer-groups.md) | Device groups |

## Troubleshooting

### Connection Issues

1. **Devices not finding each other**: Ensure both devices have internet access. PeerVault uses relay servers for NAT traversal.

2. **Slow connections**: Try setting a custom relay server closer to your location in Advanced Settings.

3. **Sync stuck**: Use "PeerVault: Sync now" command or restart the plugin.

### Data Issues

1. **Missing files after sync**: Check if the files are in excluded folders (Settings > Sync > Excluded Folders).

2. **Conflicts**: PeerVault auto-merges most conflicts. For complex conflicts, check the Conflicts tab in settings.

3. **Corrupted state**: Use "Reset Local State" in Danger Zone (this re-syncs from scratch).

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`bun test`)
5. Run type check (`bun run check`)
6. Commit with a descriptive message
7. Push and open a Pull Request

## License

[MIT](LICENSE)
