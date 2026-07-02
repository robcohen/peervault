# PeerVault for VSCode

P2P workspace sync using Loro CRDTs and iroh transport — no servers required.
Concurrent edits merge automatically; everything is end-to-end encrypted with a
vault key shared during pairing.

## Pairing two machines

1. Machine A: `PeerVault: Copy Pairing Ticket` (command palette) — sends the
   ticket to machine B out of band.
2. Machine B: `PeerVault: Add Peer (paste ticket)` — the workspace adopts A's
   vault identity (one window reload) and syncs.

Edits then flow both ways live (gossip) with automatic conflict-free merging.

## Commands

- **PeerVault: Copy Pairing Ticket** — invite another device (single-use, 10 min)
- **PeerVault: Add Peer (paste ticket)** — join a peer's vault
- **PeerVault: Sync Now** — force a full sync
- **PeerVault: Show Status** — node id + peer list

## Settings

- `peervault.enabled` — enable sync for this workspace
- `peervault.deviceName` — name shown to peers (default: hostname)
- `peervault.relayUrl` — custom iroh relay (default: public n0 relay)
- `peervault.maxFileSizeMb` — initial-scan size cap

## Notes

- Requires VSCode ≥ 1.101 (Node 22 extension host).
- `.git/`, `.vscode/`, `node_modules/` are never synced.
- Built on the same Rust engine as the PeerVault Obsidian plugin — see the
  [repository](https://github.com/robcohen/peervault) and `docs/EMBEDDING.md`.
