-------------------------- MODULE sync_protocol_v3 --------------------------
(*
 * TLA+ Specification for PeerVault Sync Protocol v3 (COMPREHENSIVE)
 *
 * This spec models the ACTUAL protocol from peervault-core/src/protocol.rs:
 * - Sync Protocol (/pv/sync/1)
 * - Key Exchange Protocol (/pv/keys/1)
 * - Session state machine
 * - Blob sync phase
 *
 * NOT modeled (to keep state space tractable):
 * - Mesh Protocol (peer gossip)
 * - Loro CRDT merge semantics (treated as opaque)
 * - Network failures and retries
 *)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Peers,
    Files,
    Blobs,          \* Set of blob hashes
    MaxVersion,
    NULL

VARIABLES
    \* Per-peer state
    crdtState,          \* crdtState[peer][file] = {version, data, encrypted, keyId} or NULL
    vaultKey,           \* vaultKey[peer] = key or NULL (the actual encryption key)
    versionVector,      \* versionVector[peer] = Loro version (simplified to integer)
    endpointReady,      \* endpointReady[peer] = TRUE when connected to relay
    blobStore,          \* blobStore[peer] = set of blob hashes we have

    \* Session state (per peer pair)
    sessionState,       \* sessionState[peer1][peer2] = state enum

    \* Network
    messages,           \* Set of in-flight messages

    \* Key exchange state
    keyExchange,        \* keyExchange[peer1][peer2] = {state, ourPubKey, theirPubKey} or NULL

    \* Analysis
    syncHistory

-----------------------------------------------------------------------------
(* Type Definitions *)

\* Session states (from actual implementation)
SessionState == {
    "disconnected",
    "connecting",
    "exchanging_versions",
    "syncing_crdt",
    "syncing_blobs",
    "live",
    "error"
}

\* Key exchange states
KeyExchangeState == {
    "none",
    "requested",
    "responded",
    "complete"
}

\* Sync message types (from protocol.rs)
SyncMessageType == {
    "VersionInfo",
    "Updates",
    "SnapshotRequest",
    "Snapshot",
    "SyncComplete",
    "Ping",
    "Pong",
    "Error",
    "BlobHashes",
    "BlobRequest",
    "BlobData",
    "BlobSyncComplete"
}

\* Key message types
KeyMessageType == {
    "KeyRequest",
    "KeyResponse",
    "KeyError"
}

-----------------------------------------------------------------------------
(* Helper Operators *)

Range(seq) == {seq[i] : i \in 1..Len(seq)}

HasKey(peer) == vaultKey[peer] /= NULL

\* Explicit ordering for peers (needed for deterministic tie-breaking)
\* Use CHOOSE to create a deterministic ordering - works for any finite set
\* The "first" peer in the enumeration wins in conflicts
PeerLessThan(p1, p2) ==
    LET EnumeratePeers == CHOOSE seq \in [1..Cardinality(Peers) -> Peers]:
            \A i, j \in 1..Cardinality(Peers): i /= j => seq[i] /= seq[j]
        IndexOf(p) == CHOOSE i \in 1..Cardinality(Peers): EnumeratePeers[i] = p
    IN IndexOf(p1) < IndexOf(p2)

\* Check if vault IDs match (simplified - in real protocol this is a 32-byte hash)
VaultIdMatches(p1, p2) == TRUE  \* Assume same vault for now

\* Can read content based on encryption and key
CanRead(peer, content) ==
    IF content = NULL THEN FALSE
    ELSE IF content.encrypted = FALSE THEN TRUE
    ELSE vaultKey[peer] = content.keyId

-----------------------------------------------------------------------------
(* Initial State *)

Init ==
    /\ crdtState = [p \in Peers |-> [f \in Files |-> NULL]]
    /\ vaultKey = [p \in Peers |-> NULL]
    /\ versionVector = [p \in Peers |-> 0]
    /\ endpointReady = [p \in Peers |-> FALSE]
    /\ blobStore = [p \in Peers |-> {}]
    /\ sessionState = [p1 \in Peers |-> [p2 \in Peers |-> "disconnected"]]
    /\ messages = {}
    /\ keyExchange = [p1 \in Peers |-> [p2 \in Peers |-> NULL]]
    /\ syncHistory = <<>>

-----------------------------------------------------------------------------
(* Connection Actions *)

BecomeReady(peer) ==
    /\ endpointReady[peer] = FALSE
    /\ endpointReady' = [endpointReady EXCEPT ![peer] = TRUE]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, blobStore,
                   sessionState, messages, keyExchange, syncHistory>>

\* Initiate connection to peer
Connect(from, to) ==
    /\ endpointReady[from] /\ endpointReady[to]
    /\ sessionState[from][to] = "disconnected"
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "connecting"]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   messages, keyExchange, syncHistory>>

\* Connection established - send VersionInfo
SendVersionInfo(from, to) ==
    /\ sessionState[from][to] = "connecting"
    /\ messages' = messages \cup {[
           type |-> "VersionInfo",
           from |-> from,
           to |-> to,
           payload |-> [
               versionVector |-> versionVector[from],
               hasVaultKey |-> HasKey(from)
           ]
       ]}
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "exchanging_versions"]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   keyExchange, syncHistory>>

-----------------------------------------------------------------------------
(* Key Exchange Protocol *)

\* Request vault key from peer who has it
RequestKey(from, to) ==
    /\ ~HasKey(from)
    /\ HasKey(to)  \* They must have a key to share
    /\ keyExchange[from][to] = NULL
    /\ messages' = messages \cup {[
           type |-> "KeyRequest",
           from |-> from,
           to |-> to,
           payload |-> [publicKey |-> from]  \* Simplified: use peer ID as pubkey
       ]}
    /\ keyExchange' = [keyExchange EXCEPT ![from][to] = [
           state |-> "requested",
           ourPubKey |-> from
       ]]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   sessionState, syncHistory>>

\* Respond to key request with encrypted key
RespondKey(from, to) ==
    /\ \E m \in messages: m.type = "KeyRequest" /\ m.from = from /\ m.to = to
    /\ HasKey(to)  \* We have a key to share
    /\ messages' = (messages \ {m \in messages: m.type = "KeyRequest"
                                                /\ m.from = from /\ m.to = to})
                   \cup {[
                       type |-> "KeyResponse",
                       from |-> to,
                       to |-> from,
                       payload |-> [
                           publicKey |-> to,
                           encryptedKey |-> vaultKey[to]  \* In reality, encrypted with shared secret
                       ]
                   ]}
    /\ keyExchange' = [keyExchange EXCEPT ![to][from] = [
           state |-> "responded"
       ]]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   sessionState, syncHistory>>

\* Receive key response and install key
\* Also re-encrypts all local content with the new key (simplified model of re-encryption)
ReceiveKey(peer) ==
    /\ \E m \in messages: m.type = "KeyResponse" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "KeyResponse" /\ m.to = peer
           newKey == msg.payload.encryptedKey
           \* Re-encrypt all content with new key
           ReEncrypted == [f \in Files |->
               IF crdtState[peer][f] = NULL THEN NULL
               ELSE IF crdtState[peer][f].encrypted = FALSE THEN crdtState[peer][f]
               ELSE [crdtState[peer][f] EXCEPT !.keyId = newKey]]
       IN /\ vaultKey' = [vaultKey EXCEPT ![peer] = newKey]
          /\ crdtState' = [crdtState EXCEPT ![peer] = ReEncrypted]
          /\ keyExchange' = [keyExchange EXCEPT
                 ![peer][msg.from] = [state |-> "complete"]]
    /\ messages' = messages \ {m \in messages: m.type = "KeyResponse" /\ m.to = peer}
    /\ UNCHANGED <<versionVector, endpointReady, blobStore,
                   sessionState, syncHistory>>

\* Request to adopt peer's key when there's a conflict (both have different keys)
\* IMPORTANT: Use deterministic tie-breaker - "greater" peer adopts from "lesser" peer
\* This prevents bidirectional key exchange leading to key swap
RequestKeyConflict(from, to) ==
    /\ HasKey(from) /\ HasKey(to)  \* Both have keys
    /\ vaultKey[from] /= vaultKey[to]  \* Keys don't match
    \* Either side is in an active sync state (not disconnected)
    /\ sessionState[from][to] /= "disconnected"
    /\ keyExchange[from][to] = NULL
    \* Tie-breaker: "from" only requests if their key > peer's key (ordering by keyId)
    \* The peer with the "smaller" key wins, the peer with "larger" key adopts
    /\ vaultKey[from] /= to  \* Don't request if we already have their key
    \* Only the peer with the "greater" order initiates key conflict resolution
    \* (the "lesser" peer's key wins - they keep their key, greater adopts)
    /\ PeerLessThan(to, from)  \* from > to in ordering, so from adopts to's key
    /\ messages' = messages \cup {[
           type |-> "KeyRequest",
           from |-> from,
           to |-> to,
           payload |-> [publicKey |-> from, isConflictResolution |-> TRUE]
       ]}
    /\ keyExchange' = [keyExchange EXCEPT ![from][to] = [
           state |-> "requested",
           ourPubKey |-> from
       ]]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   sessionState, syncHistory>>

\* Generate new vault key (first device)
\* GUARD: Cannot generate key while in an active session or pending key exchange
GenerateKey(peer) ==
    /\ ~HasKey(peer)
    \* Cannot change key while in any active session
    /\ \A other \in Peers: sessionState[peer][other] = "disconnected"
    \* Cannot generate if we have a pending key request
    /\ \A other \in Peers: keyExchange[peer][other] = NULL
    /\ vaultKey' = [vaultKey EXCEPT ![peer] = peer]  \* Simplified: use peer ID as key
    /\ UNCHANGED <<crdtState, versionVector, endpointReady, blobStore,
                   sessionState, messages, keyExchange, syncHistory>>

-----------------------------------------------------------------------------
(* Sync Protocol *)

\* Receive VersionInfo and decide what to exchange
ReceiveVersionInfo(peer) ==
    /\ \E m \in messages: m.type = "VersionInfo" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "VersionInfo" /\ m.to = peer
           theirVersion == msg.payload.versionVector
           ourVersion == versionVector[peer]
       IN \* If they're behind, send Updates; if we're behind, we wait for theirs
          IF theirVersion < ourVersion THEN
              \* Send our updates
              /\ messages' = (messages \ {msg}) \cup {[
                     type |-> "Updates",
                     from |-> peer,
                     to |-> msg.from,
                     payload |-> [
                         version |-> ourVersion,
                         data |-> crdtState[peer]
                     ]
                 ]}
              /\ sessionState' = [sessionState EXCEPT ![peer][msg.from] = "syncing_crdt"]
          ELSE
              \* We're behind or equal - wait for their updates or proceed
              /\ messages' = messages \ {msg}
              /\ sessionState' = [sessionState EXCEPT ![peer][msg.from] = "syncing_crdt"]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   keyExchange, syncHistory>>

\* Receive Updates and apply to CRDT
ReceiveUpdates(peer) ==
    /\ \E m \in messages: m.type = "Updates" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "Updates" /\ m.to = peer
           theirData == msg.payload.data
           \* Merge function: take their data if we can read it, else keep ours
           MergedState == [f \in Files |->
               IF theirData[f] /= NULL /\ CanRead(peer, theirData[f])
               THEN theirData[f]
               ELSE crdtState[peer][f]]
       IN \* Apply updates (simplified - just take their state if readable)
          /\ crdtState' = [crdtState EXCEPT ![peer] = MergedState]
          /\ versionVector' = [versionVector EXCEPT
                 ![peer] = IF msg.payload.version > versionVector[peer]
                           THEN msg.payload.version
                           ELSE versionVector[peer]]
    /\ messages' = messages \ {m \in messages: m.type = "Updates" /\ m.to = peer}
    /\ UNCHANGED <<vaultKey, endpointReady, blobStore, sessionState, keyExchange, syncHistory>>

\* Send blob hashes for blob sync phase
SendBlobHashes(from, to) ==
    /\ sessionState[from][to] = "syncing_crdt"
    /\ messages' = messages \cup {[
           type |-> "BlobHashes",
           from |-> from,
           to |-> to,
           payload |-> blobStore[from]
       ]}
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "syncing_blobs"]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   keyExchange, syncHistory>>

\* Complete sync and enter live mode
\* GUARD: Keys must match before entering live mode
\* GUARD: All our encrypted content must be readable with our current key
EnterLiveMode(from, to) ==
    /\ sessionState[from][to] \in {"syncing_crdt", "syncing_blobs"}
    \* Key agreement check: either both have no key, or both have same key
    /\ \/ (~HasKey(from) /\ ~HasKey(to))
       \/ (HasKey(from) /\ HasKey(to) /\ vaultKey[from] = vaultKey[to])
    \* All our encrypted content must use our current key (no stale keys)
    /\ \A f \in Files:
           \/ crdtState[from][f] = NULL
           \/ (crdtState[from][f] /= NULL /\ crdtState[from][f].encrypted = FALSE)
           \/ (crdtState[from][f] /= NULL /\ crdtState[from][f].keyId = vaultKey[from])
    /\ messages' = messages \cup {[
           type |-> "SyncComplete",
           from |-> from,
           to |-> to,
           payload |-> versionVector[from]
       ]}
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "live"]
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   keyExchange, syncHistory>>

\* Send keepalive ping
SendPing(from, to) ==
    /\ sessionState[from][to] = "live"
    /\ messages' = messages \cup {[
           type |-> "Ping",
           from |-> from,
           to |-> to,
           payload |-> NULL
       ]}
    /\ UNCHANGED <<crdtState, vaultKey, versionVector, endpointReady, blobStore,
                   sessionState, keyExchange, syncHistory>>

-----------------------------------------------------------------------------
(* File Operations *)

WriteFile(peer, file, content) ==
    /\ versionVector[peer] < MaxVersion
    \* Cannot write while a key exchange is pending (key might change)
    /\ \A other \in Peers:
           \/ keyExchange[peer][other] = NULL
           \/ (keyExchange[peer][other] /= NULL /\ keyExchange[peer][other].state = "complete")
    \* Cannot write while in a session with a peer who has a different key (conflict not resolved)
    /\ \A other \in Peers:
           \/ sessionState[peer][other] = "disconnected"
           \/ ~HasKey(peer) \/ ~HasKey(other)  \* At least one has no key
           \/ vaultKey[peer] = vaultKey[other]  \* Keys match
    /\ LET envelope == [
           version |-> versionVector[peer] + 1,
           encrypted |-> HasKey(peer),
           keyId |-> vaultKey[peer],
           data |-> content
       ]
       IN crdtState' = [crdtState EXCEPT ![peer][file] = envelope]
    /\ versionVector' = [versionVector EXCEPT ![peer] = @ + 1]
    /\ UNCHANGED <<vaultKey, endpointReady, blobStore, sessionState, messages,
                   keyExchange, syncHistory>>

-----------------------------------------------------------------------------
(* Next State *)

Next ==
    \/ \E p \in Peers: BecomeReady(p)
    \/ \E p \in Peers: GenerateKey(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ Connect(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendVersionInfo(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ RequestKey(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ RequestKeyConflict(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ RespondKey(p1, p2)
    \/ \E p \in Peers: ReceiveKey(p)
    \/ \E p \in Peers: ReceiveVersionInfo(p)
    \/ \E p \in Peers: ReceiveUpdates(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendBlobHashes(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ EnterLiveMode(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendPing(p1, p2)
    \/ \E p \in Peers, f \in Files, c \in {"c1", "c2"}: WriteFile(p, f, c)

-----------------------------------------------------------------------------
(* Invariants *)

\* No content read errors
NoReadErrors ==
    \A p1, p2 \in Peers:
        \A f \in Files:
            (sessionState[p1][p2] = "live" /\ crdtState[p1][f] /= NULL)
            => CanRead(p2, crdtState[p1][f])

\* Key exchange completes correctly
KeyExchangeCorrect ==
    \A p1, p2 \in Peers:
        (keyExchange[p1][p2] /= NULL /\ keyExchange[p1][p2].state = "complete")
        => (vaultKey[p1] /= NULL /\ vaultKey[p1] = vaultKey[p2])

\* Session state transitions are valid
ValidSessionTransitions ==
    \A p1, p2 \in Peers:
        sessionState[p1][p2] \in SessionState

\* Only sync in live mode if keys match
LiveModeRequiresKeyAgreement ==
    \A p1, p2 \in Peers:
        (sessionState[p1][p2] = "live" /\ HasKey(p1))
        => (HasKey(p2) /\ vaultKey[p1] = vaultKey[p2])

-----------------------------------------------------------------------------
(* Specification *)

Spec == Init /\ [][Next]_<<crdtState, vaultKey, versionVector, endpointReady,
                           blobStore, sessionState, messages, keyExchange,
                           syncHistory>>

=============================================================================
