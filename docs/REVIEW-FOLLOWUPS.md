# Review follow-ups

Items identified during the full review that are **not** addressed in this PR, with
the reason each was deferred. Most need the Docker e2e environment (Obsidian + Xvfb
+ relay), which can't run in a sandbox without Docker/root/user-namespaces.

## 1. Validate end-to-end (needs Docker)

- [ ] **Sync deadlock fix — real two-device run.** The fix (initiator drives
  `SyncComplete`) is compile-verified on native + wasm32 and backed by the in-memory
  `sync_integration` (8) / `sync_stress` (13) tests, but the live path
  (`wasm.rs::run_initiator_sync_v3` / `handle_incoming_streams_v3_inner`) was never
  run against real iroh streams here. Run `bun run test:e2e` (suites `01-pairing`,
  `02-sync-basic`, `08-mesh-sync`).
- [ ] **TypeScript changes in a real Obsidian instance** (echo-loop guard, remote
  deletions, vault-id adoption, single-flight sync). Type-checked only (`tsc`).
- [ ] **Cloud sync against AWS S3 / R2 / B2.** SigV4 + delta/blob/snapshot round-trips
  are validated against **MinIO** (`tests/cloud_minio.rs`, gated by
  `PEERVAULT_MINIO_TEST=1`), not the hosted providers.

## 2. Dependency upgrades (Tier 3 — breaking, need e2e)

- [ ] **iroh 1.0 stack** (the dominant debt): `iroh` 0.95→1.0.1, `iroh-blobs`
  0.97→0.103, `iroh-gossip` 0.95→0.101, `iroh-tickets` 0.2→1.0. Breaking API changes
  across `net/transport.rs`, `gossip_bridge.rs`, `blobs_bridge.rs`,
  `sync_handler.rs`, `wasm.rs`.
- [ ] **wasm-bindgen pin skew.** `Cargo.toml` pins `=0.2.105` but the dev-shell CLI is
  0.2.108 (latest 0.2.126) — `just wasm` will fail on the mismatch. Realign; likely
  resolves as part of the iroh upgrade.
- [ ] **Blanket `cargo update` is blocked.** It advances the RustCrypto pre-release
  crates (`ed25519`/`pkcs8`/`signature` rc→final), breaking `ed25519-dalek` (pinned
  via iroh). The remaining minor patches (anyhow, rustls, quinn, hyper, …) move with
  the iroh upgrade. Only `loro` 1.13.6 + `thiserror` 2 were applied in this PR.
- [ ] **bincode 1 → 2/3.** Changes the default wire encoding (the V3 sync format) and
  3.0 dropped the `serde` feature. Target bincode 2.0.1 with `config::legacy()`, add a
  wire round-trip test, and validate cross-version sync under the e2e before merging.
- [ ] **reqwest 0.13, rand 0.10, chacha20poly1305 0.11, hkdf 0.13** — major bumps,
  one at a time with tests.

## 3. Code follow-ups (from the review, deferred to keep this PR verifiable)

- [ ] **Converge the two sync state machines.** `wasm.rs`'s V3 functions duplicate
  `runner.rs::SyncRunner` (the tested one). Route `connect_peer` through the runner so
  the live path is the integration-tested path. Needs e2e to confirm the iroh-blobs
  bridge integration.
- [ ] **`blocking_read`/`blocking_write` on tokio `RwLock` in WASM exports**
  (`wasm.rs`, `sync.rs`). Latent hang risk; convert pairing/known-peer maps to
  `std::sync` (never held across `.await`) or make the methods async. Runtime-context
  dependent — validate in the WASM runtime / e2e.

## 4. Crypto hardening (flagged in review, not yet implemented)

- [ ] **Passphrase KDF**: `VaultKey::from_passphrase` uses HKDF-SHA256 (fast). Switch
  to Argon2id with a random per-vault salt (`crypto.rs`).
- [ ] **Vault key at rest**: stored as plaintext hex inside the vault folder
  (`peer-vault-client.ts`); move to OS keychain / Electron `safeStorage`.
- [ ] **Zeroize** key material (`VaultKey`, `KeyManager`, decrypted buffers) with the
  `zeroize` crate; current `fill(0)` is elidable.
- [ ] **AEAD associated data**: bind cloud objects to their key/version to prevent
  swap/rollback by a malicious backend (`cloud/encryption.rs`).
- [ ] **Dormant unauthenticated key exchange** (`key_exchange.rs` /
  `wasm.rs::handleKeyExchangeRequest`): not currently wired to the network, but gate
  it behind pairing or remove it so it can't be exposed later.

## 5. Cloud sync residual

- [ ] **Applied-delta tracking**: `download_deltas` re-fetches every delta each sync
  (idempotent but wasteful); track applied delta ids (`sync.rs`).
- [ ] **Download size cap**: bound `get_object` / total per-sync bytes (OOM risk on
  large/hostile objects).
- [ ] **Compaction**: now deletes only the pre-snapshot delta set; a fully concurrent-
  safe design needs conditional writes / a compaction lease.
