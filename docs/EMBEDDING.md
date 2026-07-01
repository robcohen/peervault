# Embedding PeerVault in a new host

PeerVault's engine is host-agnostic: **`peervault_core::vault::PeerVault`** owns
lifecycle, pairing, P2P sync (iroh), live gossip sync, CRDT document ops,
encryption, and cloud backup. A "plugin" for any platform — Obsidian, VSCode,
vim, a custom app — is an *adapter* that supplies IO and UI around that engine.
The multi-host contract is proven by `peervault-core/tests/native_embed.rs`:
two engines on plain tokio pair over real iroh and converge, no browser
involved.

## The two embedding modes

| Mode | Who | How |
|---|---|---|
| **WASM** | JS/TS hosts (Obsidian, VSCode, browser) | `wasm-pack` package; `WasmPeerVault` in `wasm.rs` is a thin shim over `PeerVault` |
| **Native** | Rust apps, CLIs, daemons | `peervault-core` as an rlib; call `PeerVault` directly on tokio |

For editors that can't host a QUIC stack in-process (Zed, vim), the daemon
exists: **`hosts/peervaultd/`** — run it in any directory (`peervaultd run`),
pair with `peervaultd ctl ticket` / `--join <ticket>`, and every editor sees
synced files. `peervaultd lsp` speaks a minimal LSP handshake on stdio so
editor extensions can launch it as a workspace sidecar — **`hosts/zed/`** is
exactly that (a ~40-line Zed extension). Pairing tickets are TS-compatible
(`peervault_core::pairing`), so daemon ↔ Obsidian ↔ VSCode pairing interops.

Known issue: the daemon's file-deletion propagation has a race under gossip
echo (tracked; creates/edits/joins are validated). The engine itself handles
cross-peer deletion correctly — see `tests/native_embed.rs` and
`tests/delete_repro.rs`.

## What a host must provide

1. **Callbacks** (set before `start`):
   - `set_event_callback` — receives typed [`WasmEvent`](../peervault-core/src/events.rs)
     values (JSON strings across the WASM boundary; the TS types are generated
     via ts-rs into `src/core/generated/`).
   - `set_storage_callback` — receives exported store state to persist.
2. **State persistence**: persist what the storage callback delivers (or call
   `export()` yourself) and boot with `start_with_state(bytes)`.
3. **File IO applying reconcile plans**: after sync/gossip events, call
   `reconcile_plan(dirty_paths)` and apply the result — write `upserts` whose
   content differs (`get(path)`), remove `deletes`. The core owns the
   remote-deletion baseline, so deletion semantics are identical on every host.
   Pass paths with un-ingested local edits as `dirty_paths` — they are never
   scheduled for deletion.
4. **Local change ingestion**: watch your platform's file/buffer events and
   call `set(path, content)` / `delete(path)` (debounce rapid edits).
5. **Pairing UX**: show `get_ticket()` + a generated one-time nonce
   (`register_pairing_nonce`) on the inviting side; call
   `connect_peer_with_pairing(ticket, nonce, device_name)` on the joining side.

## Minimal native embedding

```rust
use peervault_core::vault::PeerVault;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut vault = PeerVault::new(VAULT_ID_HEX, "my-host")?;
    vault.set_event_callback(Arc::new(|event| println!("{event:?}")));
    vault.set_encryption_key(KEY_HEX).await?;
    vault.start().await?; // or start_with_state(&saved)

    println!("share this ticket: {}", vault.get_ticket().await?);
    // ... ingest local changes with vault.set(...), apply vault.reconcile_plan(...)
    vault.stop().await?;
    Ok(())
}
```

See `tests/native_embed.rs` for the full two-engine pairing + convergence flow
(run with `PEERVAULT_NATIVE_P2P=1`, optionally `PEERVAULT_TEST_RELAY=` a local
relay such as the docker/e2e one).

## TypeScript hosts

`src/core/peer-vault-client.ts` is Obsidian-free except for `ObsidianStorage`:
implement the three-method `HostStorage` interface over your platform's storage
and reuse `PeerVaultClient` unchanged. `src/main.ts` shows the remaining host
duties (file watching, applying reconcile plans with your file API, settings UI).

## Runtime notes

- The core spawns background tasks through [`crate::rt`] — `tokio::spawn` on
  native (futures are `Send`), `spawn_local` on wasm. Native hosts need a tokio
  runtime with time enabled (`#[tokio::main]` defaults are fine).
- `stop()` cancels the accept loop and gossip tasks via a watch signal; a
  `stop()` → `start()` cycle is supported.
- Events, errors (`CoreError` → coded JS `Error` in the shim), and the
  `ReconcilePlan` are the stable host contract; everything else is internal.
