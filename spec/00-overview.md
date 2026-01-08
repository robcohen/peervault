# PeerVault: System Overview

## Purpose

PeerVault is an Obsidian plugin that enables peer-to-peer synchronization of markdown vaults using CRDTs. It provides conflict-free sync without requiring a central server.

## Design Principles

1. **Conflict-free by default** - Concurrent edits merge automatically using Automerge CRDTs
2. **Offline-first** - Full functionality without network; sync when peers connect
3. **No central server** - Direct P2P connections via Iroh with relay fallback
4. **File-level granularity** - Each markdown file is one Automerge document
5. **Non-destructive** - Full edit history preserved; deletions are tombstones

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
│  │     Automerge Document Manager   │  │ Iroh WASM   │  │
│  │  - Doc creation/updates          │  │ - Endpoint  │  │
│  │  - Text CRDT operations          │  │ - Streams   │  │
│  └──────┬──────────────────────────┘  └─────┬───────┘  │
│         │                                    │          │
│  ┌──────▼────────────────────────────────────▼───────┐  │
│  │                  Sync Protocol                     │  │
│  │  - Index exchange                                  │  │
│  │  - Document sync via automerge-repo                │  │
│  └──────┬────────────────────────────────────────────┘  │
│         │                                               │
│  ┌──────▼──────┐                                        │
│  │   Storage   │                                        │
│  │  .crdt files│                                        │
│  └─────────────┘                                        │
└─────────────────────────────────────────────────────────┘
```

## Glossary

| Term | Definition |
|------|------------|
| **Vault** | An Obsidian vault (folder of markdown files) |
| **FileDoc** | An Automerge document representing one markdown file |
| **Index** | Automerge document mapping file paths to document IDs |
| **Peer** | Another device/instance running PeerVault |
| **Endpoint** | Iroh network identity (public key) |
| **Ticket** | Connection info for pairing (endpoint + relay hints) |
| **Tombstone** | Marker indicating a file was deleted (preserves history) |

## Technology Stack

| Component | Library | Purpose |
|-----------|---------|---------|
| CRDT Engine | `@automerge/automerge` | Conflict-free data structures |
| Doc Management | `@automerge/automerge-repo` | Document lifecycle, sync protocol |
| P2P Transport | `@aspect/iroh` (WASM) | NAT traversal, encrypted streams |
| Plugin Host | Obsidian Plugin API | File access, UI integration |

## Component Dependencies

```
File Watcher ──────► Automerge Doc Manager ◄────── Sync Protocol
                            │                           │
                            ▼                           │
                        Storage                         │
                                                        │
Peer Management ──────► Iroh Transport ◄────────────────┘
```

## Spec Documents

| Spec | Description |
|------|-------------|
| [01-data-model](./01-data-model.md) | Automerge document schemas |
| [02-storage](./02-storage.md) | Persistence layer |
| [03-file-watcher](./03-file-watcher.md) | Vault change detection |
| [04-sync-protocol](./04-sync-protocol.md) | Document synchronization |
| [05-transport-iroh](./05-transport-iroh.md) | P2P networking |
| [06-peer-management](./06-peer-management.md) | Pairing and discovery |
| [07-plugin-ui](./07-plugin-ui.md) | User interface |
