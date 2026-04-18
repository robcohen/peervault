# PeerVault Protocol Specifications

Formal TLA+ specifications for the PeerVault sync protocol.

## Files

| File | Description | Status |
|------|-------------|--------|
| `sync_protocol.tla` | Original (buggy) protocol design | Deprecated |
| `sync_protocol_v2.tla` | Fixed content format issues | Deprecated |
| `sync_protocol_v3.tla` | Comprehensive model with key exchange | Superseded by v4 |
| `sync_protocol_v4.tla` | Accurate model of implementation (found key conflict bug) | Superseded by v5 |
| `sync_protocol_v5.tla` | **Blob consistency + LWW key resolution + session guards** | Current |

## Running the Model Checker

```bash
cd specs

# Check the current protocol (v4)
nix develop .. --command tlc -config sync_protocol_v4.cfg sync_protocol_v4.tla

# Should output:
# Model checking completed. No error has been found.
# 25,353,689 states generated, 5,726,732 distinct states found
```

## TLC Results Summary

### v5 Protocol (Current - With Blob Consistency)

```
Partial verification (state space too large for full exhaustive check):
- 2.7+ billion states generated over 10+ hours
- No invariant violations found
- Queue still growing (285M states remaining when stopped)
```

**Key Improvements Over v4:**
- Added session state guards to `ReceiveUpdates`, `ReceiveBlobData`, `ReceiveBlobHashes`, `ReceiveVersionInfo`
- Fixed `ReferentialIntegrity` violation where live mode was entered before blobs were received
- Messages can only be processed when session is in the correct state

**Verified Invariants:**
- `ReferentialIntegrity` - Live mode peers have all blobs referenced by their documents

### v4 Protocol (Superseded)

```
Model checking completed. No error has been found.
25,353,689 states generated, 5,726,732 distinct states found
Depth: 89, Finished in 2min 16s
```

**Verified Invariants:**
- `LiveModeKeyAgreement` - Live mode requires matching keys (or no keys)
- `LiveModeSameVault` - Live mode peers share vault ID
- `KeyExchangeCorrect` - Key exchange results in matching keys
- `NoKeyConflictInLiveMode` - Can't reach live mode with mismatched keys

---

## v4 Spec: Accurate Implementation Model

The v4 spec models the **actual** protocol from `peervault-core`:

### What It Models

1. **Session State Machine** (from `session.rs`)
   - `idle` → `connecting` → `exchanging_versions` → `syncing_updates` → `syncing_blobs` → `live`
   - `error` and `closed` terminal states

2. **Single Vault Key** (from `sync.rs`)
   - One key per vault (not per-file)
   - All content encrypted with vault key

3. **Symmetric VERSION_INFO Exchange**
   - Both peers send VERSION_INFO after connecting
   - Includes `vault_id`, `version_vector`, `has_vault_key`

4. **Key Exchange Protocol** (from `key_exchange.rs`)
   - ECIES-based: Request → Response with encrypted key
   - Only works when one peer has key, other doesn't

### Bug Found: Key Conflict Deadlock (FIXED)

**Scenario:**
1. Device A creates vault V1 → gets key A
2. Device B independently creates vault V1 → gets key B
3. They connect and exchange VERSION_INFO
4. Both have `has_vault_key=true` but different keys
5. **DEADLOCK**: Can't enter live mode (keys mismatch), no resolution mechanism

**Evidence from TLC:**
```
State 4: A creates vault V1, vaultKey = A
State 5: B creates vault V1, vaultKey = B (DIFFERENT!)
State 6-15: Connect, exchange versions, reach syncing_blobs
State 16+: Write content, but can't sync - DEADLOCK
```

**Fix in v4 Spec:** Added `DetectKeyConflict` action that transitions to error state when keys mismatch during sync.

**Implementation Fix (Applied):** Added key conflict detection in `peervault-core/src/runner.rs`:
```rust
// In exchange_updates():
Message::Updates(updates) => {
    match self.engine.import_updates(&updates.data) {
        Ok(()) => { ... }
        Err(CoreError::Crypto(_)) => {
            // Decryption failed - this is a key conflict
            self.send_error(stream, error_codes::KEY_CONFLICT,
                "Vault key mismatch - both devices have different encryption keys")?;
            return Err(CoreError::KeyConflict {
                our_device: self.config.hostname.clone(),
                peer_device: self.result.peer_hostname.clone(),
            });
        }
        Err(e) => return Err(e),
    }
}
```

**Status:** FIXED - `KEY_CONFLICT` error code (6) added to `protocol.rs`, `KeyConflict` variant added to `CoreError`.

---

## Earlier Spec Versions

### v3: Comprehensive Model (Superseded)

The v3 spec attempted to model key exchange with conflict resolution, but had modeling inaccuracies:

- Assumed per-file encryption (incorrect - vault uses single key)
- Modeled key conflict resolution that doesn't exist in implementation
- Added guards that the implementation doesn't have

**Useful output:** Identified the guards that SHOULD be added to prevent bugs.

### v2: Content Format Fixes

Fixed content format ambiguity issues found in v1.

### v1: Original Protocol

Found basic issues like ticket timing and format ambiguity.

---

## Design Flaws Found Across All Versions

### Flaw 1: Key Conflict Deadlock (v4) - FIXED

**Problem:** Two devices independently create same vault with different keys. No resolution mechanism.

**Status:** FIXED in `peervault-core`:
- Added `KEY_CONFLICT` error code (6) to `protocol.rs`
- Added `KeyConflict` variant to `CoreError` with helpful error message
- Detection in `runner.rs`: Crypto errors during update import are identified as key conflicts

### Flaw 2: Content Format Ambiguity (v1/v2)

**Problem:** Raw vs encrypted content indistinguishable.

**Fix:** Content envelope with `{encrypted, keyId, data}`.

**Status:** Fixed in implementation - single vault key encrypts all content.

### Flaw 3: Ticket Timing (v1/v2)

**Problem:** Ticket generated before relay connection ready.

**Fix:** Wait for `endpoint.online()`.

**Status:** Fixed in implementation.

### Flaw 4: No Key Agreement Before Sync (v3)

**Problem:** Peers never verify keys match before syncing.

**Fix:** Check key status in VERSION_INFO exchange.

**Status:** Partially implemented - `has_vault_key` is exchanged but mismatch not handled.

---

## Safety Invariants

### Verified in v4

| Invariant | Description |
|-----------|-------------|
| `LiveModeKeyAgreement` | Live mode only with matching keys or no keys |
| `LiveModeSameVault` | Live mode peers share same vault ID |
| `KeyExchangeCorrect` | Key exchange results in both having same key |
| `ValidSessionStates` | All session states are valid enum values |
| `KeyMismatchDeadlock` | Keys mismatch → can't reach live mode |

### Not Yet Verified

| Property | Reason |
|----------|--------|
| Content Convergence | Requires liveness/fairness constraints |
| Network Partition Recovery | Not modeled in current spec |
| Blob Sync Correctness | Simplified in v4 (boolean instead of hash sets) |

---

## State Space Complexity

| Spec | Peers | Vaults | Blobs | States Generated | Distinct States | Time |
|------|-------|--------|-------|------------------|-----------------|------|
| v1 | 2 | - | - | <1000 | - | <1s (error found) |
| v2 | 2 | - | - | 476,131 | 73,473 | 2s |
| v3 | 2 | - | - | 6,170,245 | 739,266 | 25s |
| v4 | 2 | 1 | - | 25,353,689 | 5,726,732 | 2m16s |
| v5 | 2 | 1 | 2 | 2,700,000,000+ | 490,000,000+ | 10h+ (partial) |

---

## Implementation Recommendations

Based on TLA+ verification:

1. ~~**Add Key Conflict Detection**~~ ✅ DONE
   - Added `KEY_CONFLICT` error code in `protocol.rs`
   - Added `KeyConflict` variant in `error.rs` with helpful message
   - Detection in `runner.rs` catches crypto errors during update import

2. **Prevent Dual Vault Creation** (Optional)
   - UI could warn when creating vault if one already exists with same ID
   - Or implement LWW key conflict resolution (modeled in v5 spec)

3. **Clear Error Messages** ✅ DONE
   - Error message includes device names and resolution steps
   - "Key conflict: '{device1}' and '{device2}' have different vault keys..."

---

## Future Work

- [x] Model blob sync with actual hash sets (v5)
- [x] Implement key conflict detection in actual code (done in `runner.rs`)
- [ ] Add network partition/recovery scenarios
- [ ] Model mesh protocol for peer discovery
- [ ] Add liveness properties with fairness constraints
- [ ] Implement LWW key conflict resolution (modeled in v5, not yet in code)
