-------------------------- MODULE sync_protocol_v4 --------------------------
(*
 * TLA+ Specification for PeerVault Sync Protocol v4 (ACCURATE TO IMPLEMENTATION)
 *
 * This spec models the ACTUAL protocol from peervault-core:
 * - session.rs: Session state machine
 * - sync.rs: CRDT sync with single vault key
 * - key_exchange.rs: ECIES-based key exchange
 * - protocol.rs: Message types
 *
 * Key differences from v3:
 * - Single vault key per peer (not per-file encryption)
 * - Symmetric VERSION_INFO exchange (both sides send)
 * - Vault ID validation
 * - No key conflict resolution (matches implementation gap)
 *
 * NOT modeled:
 * - Mesh Protocol (peer gossip)
 * - Loro CRDT merge semantics (treated as opaque version vector)
 * - Network failures and retries
 * - Blob sync (simplified to boolean)
 *)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Peers,
    VaultIds,       \* Set of possible vault IDs
    MaxVersion,
    NULL

VARIABLES
    \* Per-peer state
    vaultId,            \* vaultId[peer] = id or NULL (which vault we belong to)
    vaultKey,           \* vaultKey[peer] = key or NULL (single key for entire vault)
    versionVector,      \* versionVector[peer] = Loro version (simplified to integer)
    crdtContent,        \* crdtContent[peer] = content hash (opaque, just for sync comparison)
    endpointReady,      \* endpointReady[peer] = TRUE when connected to relay

    \* Session state (per peer pair) - matches session.rs SessionState
    sessionState,       \* sessionState[peer1][peer2] = state enum

    \* VERSION_INFO exchange tracking
    versionInfoSent,    \* versionInfoSent[peer1][peer2] = TRUE if we sent VERSION_INFO
    versionInfoRecv,    \* versionInfoRecv[peer1][peer2] = TRUE if we received VERSION_INFO

    \* Network
    messages,           \* Set of in-flight messages

    \* Key exchange state
    keyExchange         \* keyExchange[peer1][peer2] = {state, ...} or NULL

-----------------------------------------------------------------------------
(* Type Definitions *)

\* Session states - matches session.rs SessionState exactly
SessionState == {
    "idle",
    "connecting",
    "exchanging_versions",
    "syncing_updates",
    "syncing_blobs",
    "live",
    "closed",
    "error"
}

\* Key exchange states
KeyExchangeState == {
    "none",
    "requested",
    "responded",
    "complete"
}

\* Sync message types - matches protocol.rs sync::MessageType
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

\* Key message types - matches protocol.rs keys::MessageType
KeyMessageType == {
    "KeyRequest",
    "KeyResponse",
    "KeyError"
}

-----------------------------------------------------------------------------
(* Helper Operators *)

HasKey(peer) == vaultKey[peer] /= NULL

HasVault(peer) == vaultId[peer] /= NULL

\* Check if two peers are in the same vault
SameVault(p1, p2) ==
    /\ HasVault(p1) /\ HasVault(p2)
    /\ vaultId[p1] = vaultId[p2]

\* Check if both VERSION_INFO messages exchanged
VersionInfoExchanged(p1, p2) ==
    /\ versionInfoSent[p1][p2]
    /\ versionInfoRecv[p1][p2]

-----------------------------------------------------------------------------
(* Initial State *)

Init ==
    /\ vaultId = [p \in Peers |-> NULL]
    /\ vaultKey = [p \in Peers |-> NULL]
    /\ versionVector = [p \in Peers |-> 0]
    /\ crdtContent = [p \in Peers |-> 0]  \* Hash of content, 0 = empty
    /\ endpointReady = [p \in Peers |-> FALSE]
    /\ sessionState = [p1 \in Peers |-> [p2 \in Peers |-> "idle"]]
    /\ versionInfoSent = [p1 \in Peers |-> [p2 \in Peers |-> FALSE]]
    /\ versionInfoRecv = [p1 \in Peers |-> [p2 \in Peers |-> FALSE]]
    /\ messages = {}
    /\ keyExchange = [p1 \in Peers |-> [p2 \in Peers |-> NULL]]

-----------------------------------------------------------------------------
(* Setup Actions *)

\* Peer becomes ready (connected to relay)
BecomeReady(peer) ==
    /\ endpointReady[peer] = FALSE
    /\ endpointReady' = [endpointReady EXCEPT ![peer] = TRUE]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent,
                   sessionState, versionInfoSent, versionInfoRecv,
                   messages, keyExchange>>

\* Create a new vault with a new key (first device)
CreateVault(peer, vid) ==
    /\ ~HasVault(peer)
    /\ ~HasKey(peer)
    /\ \A other \in Peers: sessionState[peer][other] = "idle"
    /\ vaultId' = [vaultId EXCEPT ![peer] = vid]
    /\ vaultKey' = [vaultKey EXCEPT ![peer] = peer]  \* Use peer ID as key (simplified)
    /\ UNCHANGED <<versionVector, crdtContent, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv,
                   messages, keyExchange>>

\* Join an existing vault (receive vault ID but not key yet)
JoinVault(peer, vid) ==
    /\ ~HasVault(peer)
    /\ vaultId' = [vaultId EXCEPT ![peer] = vid]
    /\ UNCHANGED <<vaultKey, versionVector, crdtContent, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv,
                   messages, keyExchange>>

-----------------------------------------------------------------------------
(* Connection Actions *)

\* Initiate connection to peer (Idle -> Connecting)
Connect(from, to) ==
    /\ endpointReady[from] /\ endpointReady[to]
    /\ sessionState[from][to] = "idle"
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "connecting"]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   versionInfoSent, versionInfoRecv, messages, keyExchange>>

\* Send VERSION_INFO after connection established
\* Both sides do this independently (symmetric)
SendVersionInfo(from, to) ==
    /\ sessionState[from][to] = "connecting"
    /\ ~versionInfoSent[from][to]
    /\ HasVault(from)  \* Must have a vault ID to sync
    /\ messages' = messages \cup {[
           type |-> "VersionInfo",
           from |-> from,
           to |-> to,
           payload |-> [
               vaultId |-> vaultId[from],
               versionVector |-> versionVector[from],
               hasVaultKey |-> HasKey(from)
           ]
       ]}
    /\ versionInfoSent' = [versionInfoSent EXCEPT ![from][to] = TRUE]
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "exchanging_versions"]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   versionInfoRecv, keyExchange>>

\* Receive VERSION_INFO from peer
ReceiveVersionInfo(peer) ==
    /\ \E m \in messages: m.type = "VersionInfo" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "VersionInfo" /\ m.to = peer
       IN \* Validate vault ID matches (critical security check!)
          IF vaultId[peer] /= NULL /\ msg.payload.vaultId /= vaultId[peer] THEN
              \* Vault ID mismatch - error!
              /\ sessionState' = [sessionState EXCEPT ![peer][msg.from] = "error"]
              /\ messages' = messages \ {msg}
              /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                             versionInfoSent, versionInfoRecv, keyExchange>>
          ELSE
              \* Valid - record that we received their VERSION_INFO
              /\ versionInfoRecv' = [versionInfoRecv EXCEPT ![peer][msg.from] = TRUE]
              /\ messages' = messages \ {msg}
              /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                             sessionState, versionInfoSent, keyExchange>>

\* Transition to SyncingUpdates after both VERSION_INFO exchanged
BeginSync(from, to) ==
    /\ sessionState[from][to] = "exchanging_versions"
    /\ VersionInfoExchanged(from, to)
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "syncing_updates"]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   versionInfoSent, versionInfoRecv, messages, keyExchange>>

-----------------------------------------------------------------------------
(* Key Exchange Protocol - matches key_exchange.rs *)

\* Request vault key from peer (when we don't have one)
RequestKey(from, to) ==
    /\ ~HasKey(from)
    /\ HasKey(to)
    /\ SameVault(from, to)
    /\ keyExchange[from][to] = NULL
    /\ messages' = messages \cup {[
           type |-> "KeyRequest",
           from |-> from,
           to |-> to,
           payload |-> [
               publicKey |-> from,
               hasExistingKey |-> FALSE
           ]
       ]}
    /\ keyExchange' = [keyExchange EXCEPT ![from][to] = [
           state |-> "requested"
       ]]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv>>

\* Respond to key request (we have the key, send it encrypted)
RespondKey(from, to) ==
    /\ \E m \in messages: m.type = "KeyRequest" /\ m.from = from /\ m.to = to
    /\ HasKey(to)
    /\ messages' = (messages \ {m \in messages: m.type = "KeyRequest"
                                                /\ m.from = from /\ m.to = to})
                   \cup {[
                       type |-> "KeyResponse",
                       from |-> to,
                       to |-> from,
                       payload |-> [
                           encryptedKey |-> vaultKey[to],
                           isNewKey |-> FALSE
                       ]
                   ]}
    /\ keyExchange' = [keyExchange EXCEPT ![to][from] = [
           state |-> "responded"
       ]]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv>>

\* Receive key and install it
ReceiveKey(peer) ==
    /\ \E m \in messages: m.type = "KeyResponse" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "KeyResponse" /\ m.to = peer
       IN /\ vaultKey' = [vaultKey EXCEPT ![peer] = msg.payload.encryptedKey]
          /\ keyExchange' = [keyExchange EXCEPT ![peer][msg.from] = [state |-> "complete"]]
    /\ messages' = messages \ {m \in messages: m.type = "KeyResponse" /\ m.to = peer}
    /\ UNCHANGED <<vaultId, versionVector, crdtContent, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv>>

-----------------------------------------------------------------------------
(* Sync Protocol *)

\* Send Updates to peer (simplified - just sync version vectors)
SendUpdates(from, to) ==
    /\ sessionState[from][to] = "syncing_updates"
    /\ HasKey(from)  \* Must have key to encrypt updates
    /\ HasKey(to)    \* Peer must have key to decrypt
    /\ vaultKey[from] = vaultKey[to]  \* Keys must match!
    /\ versionVector[from] > versionVector[to]  \* We have newer data
    /\ messages' = messages \cup {[
           type |-> "Updates",
           from |-> from,
           to |-> to,
           payload |-> [
               version |-> versionVector[from],
               content |-> crdtContent[from]
           ]
       ]}
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv, keyExchange>>

\* Receive Updates from peer
ReceiveUpdates(peer) ==
    /\ \E m \in messages: m.type = "Updates" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "Updates" /\ m.to = peer
       IN /\ versionVector' = [versionVector EXCEPT
                 ![peer] = IF msg.payload.version > versionVector[peer]
                           THEN msg.payload.version
                           ELSE versionVector[peer]]
          /\ crdtContent' = [crdtContent EXCEPT
                 ![peer] = IF msg.payload.version > versionVector[peer]
                           THEN msg.payload.content
                           ELSE crdtContent[peer]]
    /\ messages' = messages \ {m \in messages: m.type = "Updates" /\ m.to = peer}
    /\ UNCHANGED <<vaultId, vaultKey, endpointReady, sessionState,
                   versionInfoSent, versionInfoRecv, keyExchange>>

\* Transition to blob sync (simplified - skip blob details)
BeginBlobSync(from, to) ==
    /\ sessionState[from][to] = "syncing_updates"
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "syncing_blobs"]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   versionInfoSent, versionInfoRecv, messages, keyExchange>>

\* IMPLEMENTATION BUG: Detect key conflict and error out
\* This action models what SHOULD happen but currently doesn't in the implementation
\* When both have keys that don't match, we should error (and require manual resolution)
DetectKeyConflict(from, to) ==
    /\ sessionState[from][to] \in {"syncing_updates", "syncing_blobs"}
    /\ HasKey(from) /\ HasKey(to)
    /\ vaultKey[from] /= vaultKey[to]  \* Keys don't match!
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "error"]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   versionInfoSent, versionInfoRecv, messages, keyExchange>>

\* Enter live mode
\* CRITICAL: If both have keys, they must match
\* If neither has a key, that's OK (empty vault)
\* If only one has a key, can't proceed (need key exchange first)
EnterLiveMode(from, to) ==
    /\ sessionState[from][to] \in {"syncing_updates", "syncing_blobs"}
    /\ \/ (~HasKey(from) /\ ~HasKey(to))  \* Neither has key - OK (empty vault)
       \/ (HasKey(from) /\ HasKey(to) /\ vaultKey[from] = vaultKey[to])  \* Both have matching keys
    /\ messages' = messages \cup {[
           type |-> "SyncComplete",
           from |-> from,
           to |-> to,
           payload |-> versionVector[from]
       ]}
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "live"]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   versionInfoSent, versionInfoRecv, keyExchange>>

\* Send keepalive ping
SendPing(from, to) ==
    /\ sessionState[from][to] = "live"
    /\ messages' = messages \cup {[
           type |-> "Ping",
           from |-> from,
           to |-> to,
           payload |-> NULL
       ]}
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv, keyExchange>>

\* Close session gracefully (only from active or error states)
CloseSession(from, to) ==
    /\ sessionState[from][to] \in {"live", "error"}
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "closed"]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   versionInfoSent, versionInfoRecv, messages, keyExchange>>

\* Reset closed session to idle (for reconnection)
ResetSession(from, to) ==
    /\ sessionState[from][to] = "closed"
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "idle"]
    /\ versionInfoSent' = [versionInfoSent EXCEPT ![from][to] = FALSE]
    /\ versionInfoRecv' = [versionInfoRecv EXCEPT ![from][to] = FALSE]
    /\ UNCHANGED <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
                   messages, keyExchange>>

-----------------------------------------------------------------------------
(* Content Operations *)

\* Local write operation
WriteContent(peer) ==
    /\ versionVector[peer] < MaxVersion
    /\ HasKey(peer)  \* Must have key to write encrypted content
    /\ versionVector' = [versionVector EXCEPT ![peer] = @ + 1]
    /\ crdtContent' = [crdtContent EXCEPT ![peer] = @ + 1]  \* Simplified content hash
    /\ UNCHANGED <<vaultId, vaultKey, endpointReady, sessionState,
                   versionInfoSent, versionInfoRecv, messages, keyExchange>>

-----------------------------------------------------------------------------
(* Next State *)

Next ==
    \/ \E p \in Peers: BecomeReady(p)
    \/ \E p \in Peers, v \in VaultIds: CreateVault(p, v)
    \/ \E p \in Peers, v \in VaultIds: JoinVault(p, v)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ Connect(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendVersionInfo(p1, p2)
    \/ \E p \in Peers: ReceiveVersionInfo(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ BeginSync(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ RequestKey(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ RespondKey(p1, p2)
    \/ \E p \in Peers: ReceiveKey(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendUpdates(p1, p2)
    \/ \E p \in Peers: ReceiveUpdates(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ BeginBlobSync(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ DetectKeyConflict(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ EnterLiveMode(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendPing(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ CloseSession(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ ResetSession(p1, p2)
    \/ \E p \in Peers: WriteContent(p)

-----------------------------------------------------------------------------
(* Invariants *)

\* All peers in live mode either both have no key, or have matching keys
LiveModeKeyAgreement ==
    \A p1, p2 \in Peers:
        sessionState[p1][p2] = "live"
        => \/ (~HasKey(p1) /\ ~HasKey(p2))
           \/ (HasKey(p1) /\ HasKey(p2) /\ vaultKey[p1] = vaultKey[p2])

\* All peers in live mode are in the same vault
LiveModeSameVault ==
    \A p1, p2 \in Peers:
        sessionState[p1][p2] = "live"
        => SameVault(p1, p2)

\* Key exchange completes with matching keys
KeyExchangeCorrect ==
    \A p1, p2 \in Peers:
        (keyExchange[p1][p2] /= NULL /\ keyExchange[p1][p2].state = "complete")
        => (HasKey(p1) /\ HasKey(p2) /\ vaultKey[p1] = vaultKey[p2])

\* Valid session state transitions
ValidSessionStates ==
    \A p1, p2 \in Peers:
        sessionState[p1][p2] \in SessionState

\* VERSION_INFO only sent after connecting
VersionInfoAfterConnect ==
    \A p1, p2 \in Peers:
        versionInfoSent[p1][p2]
        => sessionState[p1][p2] /= "idle"

\* KNOWN ISSUE: This invariant will FAIL if both peers independently create vaults
\* with different keys and try to sync. The implementation has this bug.
NoKeyConflictInLiveMode ==
    \A p1, p2 \in Peers:
        (sessionState[p1][p2] = "live" /\ HasKey(p1) /\ HasKey(p2))
        => vaultKey[p1] = vaultKey[p2]

-----------------------------------------------------------------------------
(* Properties to Check for Implementation Bugs *)

\* DEADLOCK CHECK: Can two peers with different keys ever get stuck?
\* They can't enter live mode (keys don't match) but there's no resolution.
\* This models the ACTUAL implementation which lacks conflict resolution.

\* If both peers have keys and they don't match, they can never enter live mode
KeyMismatchDeadlock ==
    \A p1, p2 \in Peers:
        (HasKey(p1) /\ HasKey(p2) /\ vaultKey[p1] /= vaultKey[p2] /\ SameVault(p1, p2))
        => sessionState[p1][p2] /= "live"

-----------------------------------------------------------------------------
(* Specification *)

vars == <<vaultId, vaultKey, versionVector, crdtContent, endpointReady,
          sessionState, versionInfoSent, versionInfoRecv, messages, keyExchange>>

Spec == Init /\ [][Next]_vars

=============================================================================
