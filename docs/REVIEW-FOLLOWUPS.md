# Review follow-ups

Tracks the items surfaced by the full code review and the follow-up architecture
review. The original review backlog and the architecture-review batches have
since landed; what remains are a few items **deliberately deferred**, each with
its rationale below.

## Done

The full-review backlog and the six architecture-review batches shipped across
PRs #8–#22:

- **Dependency modernization** — iroh 1.0 stack (iroh 1.0.1, iroh-blobs 0.103,
  iroh-gossip 0.101, iroh-tickets 1.0), bincode 2 (via `wire::` `config::legacy()`,
  wire-compatible), reqwest 0.13, rand 0.10, chacha20poly1305 0.11, thiserror 2,
  loro 1.13; dropped dead deps (hkdf, urlencoding, n0-future); nix toolchain bump
  (rustc 1.96, wasm-pack 0.15); CI action pinned.
- **Crypto hardening** — Argon2id passphrase KDF, OS-keychain (`safeStorage`) key
  at rest, `zeroize` on key material, AEAD associated data on cloud objects,
  removal of the dormant unauthenticated key-exchange path.
- **Sync correctness** — deadlock fix (initiator drives `SyncComplete`), handshake
  vault-id adoption, converged the live sync onto the unit-tested `SyncRunner`,
  `blocking_read`→`std` locks, shutdown hang + background-task-leak fixes.
- **Cloud** — applied-delta tracking, download size cap, snapshot-change re-read,
  and `meta.json` optimistic concurrency (ETag `If-Match` compare-and-swap;
  validated against MinIO, which honors it).
- **Architecture** — deleted ~2,580 lines of dead "Path A" (incl. a duplicate
  crypto stack), structured `{code}` errors across the WASM boundary, `dyn DocStore`
  (swappable CRDT backend), typed WASM events via ts-rs, peer-list lockstep,
  property-based CRDT convergence + hostile-input tests.

## Deferred (with rationale)

### 1. Live `Transport` trait — decided **against**

Abstracting `IrohTransport` behind a `Transport` trait was investigated and
rejected: it would re-create the dead `Transport`/`Connection`/`Stream` hierarchy
removed in the Path-A deletion. The networking stack is coupled to iroh
**end-to-end** — `gossip_bridge` and `blobs_bridge` take `&iroh::Endpoint`
directly (built on iroh-gossip / iroh-blobs), so any `Transport` trait must expose
`fn endpoint(&self) -> &iroh::Endpoint`, leaking the concrete type and defeating
the abstraction. You cannot swap the transport without also replacing gossip +
blobs. The protocol layer that *is* worth abstracting (`SyncRunner`) already has
its `SyncStream` seam (used by the integration + property tests). Revisit only if
a concrete second transport (non-iroh QUIC, or a full in-memory mesh for testing)
actually materializes — otherwise YAGNI.

### 2. AAD on content encryption — needs a versioned migration

`VaultKey::encrypt` (content/CRDT deltas) uses no associated data, while
`CloudEncryption` binds the object key as AAD. Adding AAD to `VaultKey` would give
the same anti-substitution property, but it is a **wire/at-rest format change**:
existing `state.bin` and in-flight deltas encrypted without AAD would fail to
decrypt. Requires a version byte on the ciphertext + a read path that accepts both
formats, not a silent flip. Defer until we do a deliberate format-version bump.

### 3. Full peer-list dedup — larger state-ownership change

PR #20 fixed the correctness bug (removed peers now leave the core's `known_peers`
too). The fuller change — make the Rust core the single source of truth for the
peer list and drop the TS `peers.json` shadow entirely — is larger: `known_peers`
stores only ids, while `peers.json` also holds name + ticket, so the core would
need to expose (and persist) that metadata first. Left as its own PR.

### 4. S3 client testability — no HTTP-layer trait

`S3Client` embeds `reqwest::Client` with no HTTP trait, so retry/backoff and the
`meta.json` conflict path can only be exercised behind the env-gated MinIO suite,
not in CI. Extracting an `HttpClient` trait would let those paths run against a
mock in CI. Nice-to-have; not blocking.

### 5. Hosted-cloud validation

SigV4 + delta/blob/snapshot round-trips and the `If-Match` CAS are validated
against **MinIO** (`tests/cloud_minio.rs`, gated by `PEERVAULT_MINIO_TEST=1`), not
the hosted providers (AWS S3 / R2 / B2). Worth a manual pass before advertising
those backends as supported.
