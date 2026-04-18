-------------------------- MODULE sync_protocol_v5 --------------------------
(*
 * TLA+ Specification for PeerVault Sync Protocol v5 (BLOB CONSISTENCY)
 *
 * Extends v4 to verify data integrity for "Folder Sync":
 * 1. Referential Integrity: Docs depending on blobs must not be live without them
 * 2. Blob Reconciliation: Models set difference logic for transfers
 * 3. Key Conflict Resolution: "Last Write Wins" strategy to solve deadlock
 *
 * This verifies the logic in `peervault-core/src/runner.rs` and `blob.rs`.
 *)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Peers,
    VaultIds,
    BlobHashes,     \* Set of possible blob hashes (e.g. {b1, b2})
    Docs,           \* Set of document paths (e.g. {d1, d2})
    MaxVersion,
    NULL

VARIABLES
    \* --- Per-peer state ---
    vaultId,
    vaultKey,
    vaultKeyTs,         \* Timestamp of key generation (for conflict resolution)
    versionVector,
    
    \* Data State (Split for dependency tracking)
    docState,           \* docState[p][d] = {version, refs={b1...}}
    blobStore,          \* blobStore[p] = Set of BlobHashes we have
    
    endpointReady,

    \* --- Session State ---
    sessionState,       \* idle -> connecting -> exchanging_versions -> ...
    
    \* Sync Tracking
    versionInfoSent,
    versionInfoRecv,
    knownRemoteBlobs,   \* knownRemoteBlobs[p1][p2] = Set of blobs p2 told p1 about
    
    \* Network
    messages,
    keyExchange

-----------------------------------------------------------------------------
(* Type Definitions *)

SessionState == {
    "idle", "connecting", "exchanging_versions", 
    "syncing_updates", "syncing_blobs", "live", 
    "closed", "error"
}

MessageTypes == {
    "VersionInfo", "Updates", "BlobHashes", 
    "BlobRequest", "BlobData", "SyncComplete", 
    "Ping", "Pong", "KeyRequest", "KeyResponse", "Error"
}

-----------------------------------------------------------------------------
(* Helper Operators *)

HasKey(peer) == vaultKey[peer] /= NULL
HasVault(peer) == vaultId[peer] /= NULL

SameVault(p1, p2) == 
    /\ HasVault(p1) /\ HasVault(p2) 
    /\ vaultId[p1] = vaultId[p2]

VersionInfoExchanged(p1, p2) ==
    versionInfoSent[p1][p2] /\ versionInfoRecv[p1][p2]

\* Dependencies for a doc
Refs(doc) == IF doc = NULL THEN {} ELSE doc.refs

\* Check if all dependencies for a doc are met locally
DependenciesMet(peer, doc) ==
    Refs(doc) \subseteq blobStore[peer]

-----------------------------------------------------------------------------
(* Initial State *)

Init ==
    /\ vaultId = [p \in Peers |-> NULL]
    /\ vaultKey = [p \in Peers |-> NULL]
    /\ vaultKeyTs = [p \in Peers |-> 0]
    /\ versionVector = [p \in Peers |-> 0]
    /\ docState = [p \in Peers |-> [d \in Docs |-> NULL]]
    /\ blobStore = [p \in Peers |-> {}]
    /\ endpointReady = [p \in Peers |-> FALSE]
    /\ sessionState = [p1 \in Peers |-> [p2 \in Peers |-> "idle"]]
    /\ versionInfoSent = [p1 \in Peers |-> [p2 \in Peers |-> FALSE]]
    /\ versionInfoRecv = [p1 \in Peers |-> [p2 \in Peers |-> FALSE]]
    /\ knownRemoteBlobs = [p1 \in Peers |-> [p2 \in Peers |-> {}]]
    /\ messages = {}
    /\ keyExchange = [p1 \in Peers |-> [p2 \in Peers |-> NULL]]

-----------------------------------------------------------------------------
(* Connection & Setup *)

BecomeReady(peer) ==
    /\ endpointReady[peer] = FALSE
    /\ endpointReady' = [endpointReady EXCEPT ![peer] = TRUE]
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                   sessionState, versionInfoSent, versionInfoRecv, knownRemoteBlobs, 
                   messages, keyExchange>>

CreateVault(peer, vid, ts) ==
    /\ ~HasVault(peer)
    /\ vaultId' = [vaultId EXCEPT ![peer] = vid]
    /\ vaultKey' = [vaultKey EXCEPT ![peer] = peer]
    /\ vaultKeyTs' = [vaultKeyTs EXCEPT ![peer] = ts]
    /\ UNCHANGED <<versionVector, docState, blobStore, endpointReady, sessionState,
                   versionInfoSent, versionInfoRecv, knownRemoteBlobs, messages, keyExchange>>

Connect(from, to) ==
    /\ endpointReady[from] /\ endpointReady[to]
    /\ sessionState[from][to] = "idle"
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "connecting"]
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                   endpointReady, versionInfoSent, versionInfoRecv, knownRemoteBlobs, messages, keyExchange>>

-----------------------------------------------------------------------------
(* Conflict Resolution (LWW on Key) *)

\* Solve Deadlock: If keys mismatch, adopt the one with higher timestamp
ResolveKeyConflict(peer, other, otherKey, otherTs) ==
    /\ HasKey(peer)
    /\ vaultKey[peer] /= otherKey
    /\ otherTs > vaultKeyTs[peer] \* They are newer, they win
    /\ vaultKey' = [vaultKey EXCEPT ![peer] = otherKey]
    /\ vaultKeyTs' = [vaultKeyTs EXCEPT ![peer] = otherTs]
    \* Reset session to re-sync with new key
    /\ sessionState' = [sessionState EXCEPT ![peer][other] = "idle"]
    /\ UNCHANGED <<vaultId, versionVector, docState, blobStore, endpointReady,
                   versionInfoSent, versionInfoRecv, knownRemoteBlobs, messages, keyExchange>>

-----------------------------------------------------------------------------
(* Protocol: Handshake *)

SendVersionInfo(from, to) ==
    /\ sessionState[from][to] = "connecting"
    /\ ~versionInfoSent[from][to]
    /\ HasVault(from)
    /\ messages' = messages \cup {[
           type |-> "VersionInfo",
           from |-> from,
           to |-> to,
           payload |-> [
               vaultId |-> vaultId[from],
               key |-> vaultKey[from],
               ts |-> vaultKeyTs[from]
           ]
       ]}
    /\ versionInfoSent' = [versionInfoSent EXCEPT ![from][to] = TRUE]
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "exchanging_versions"]
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                   endpointReady, versionInfoRecv, knownRemoteBlobs, keyExchange>>

ReceiveVersionInfo(peer) ==
    /\ \E m \in messages: m.type = "VersionInfo" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "VersionInfo" /\ m.to = peer
           sender == msg.from
       IN
       \* Guard: Only process VERSION_INFO during connection/version exchange phases
       /\ sessionState[peer][sender] \in {"connecting", "exchanging_versions"}
       /\ IF msg.payload.vaultId /= vaultId[peer] THEN
              /\ messages' = messages \ {msg}
              /\ sessionState' = [sessionState EXCEPT ![peer][sender] = "error"]
              /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                             endpointReady, versionInfoSent, versionInfoRecv, knownRemoteBlobs, keyExchange>>
          ELSE IF msg.payload.key /= vaultKey[peer] THEN
              \* Key Conflict! Try to resolve.
              IF msg.payload.ts > vaultKeyTs[peer] THEN
                  ResolveKeyConflict(peer, sender, msg.payload.key, msg.payload.ts)
              ELSE
                  \* We stick to our key, wait for them to adopt ours (or deadlock if equal)
                  /\ messages' = messages \ {msg}
                  /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                                 endpointReady, sessionState, versionInfoSent, versionInfoRecv,
                                 knownRemoteBlobs, keyExchange>>
          ELSE
              \* Valid match
              /\ versionInfoRecv' = [versionInfoRecv EXCEPT ![peer][sender] = TRUE]
              /\ messages' = messages \ {msg}
              /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                             endpointReady, sessionState, versionInfoSent, knownRemoteBlobs, keyExchange>>

BeginSync(from, to) ==
    /\ sessionState[from][to] = "exchanging_versions"
    /\ VersionInfoExchanged(from, to)
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "syncing_updates"]
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                   endpointReady, versionInfoSent, versionInfoRecv, knownRemoteBlobs, messages, keyExchange>>

-----------------------------------------------------------------------------
(* Protocol: Docs *)

SendUpdates(from, to) ==
    /\ sessionState[from][to] = "syncing_updates"
    /\ messages' = messages \cup {[
           type |-> "Updates",
           from |-> from,
           to |-> to,
           payload |-> docState[from] \* Send all docs
       ]}
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                   endpointReady, sessionState, versionInfoSent, versionInfoRecv, 
                   knownRemoteBlobs, keyExchange>>

ReceiveUpdates(peer) ==
    /\ \E m \in messages: m.type = "Updates" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "Updates" /\ m.to = peer
           sender == msg.from
           theirDocs == msg.payload
           \* Merge logic: Take doc with higher version
           merged == [d \in Docs |->
               IF docState[peer][d] = NULL \/ (theirDocs[d] /= NULL /\ theirDocs[d].version > docState[peer][d].version)
               THEN theirDocs[d]
               ELSE docState[peer][d]
           ]
       IN
       \* Guard: Only receive updates during sync phases, not after entering live mode
       /\ sessionState[peer][sender] \in {"syncing_updates", "syncing_blobs"}
       /\ docState' = [docState EXCEPT ![peer] = merged]
       /\ messages' = messages \ {msg}
       /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, blobStore,
                      endpointReady, sessionState, versionInfoSent, versionInfoRecv,
                      knownRemoteBlobs, keyExchange>>

BeginBlobSync(from, to) ==
    /\ sessionState[from][to] = "syncing_updates"
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "syncing_blobs"]
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                   endpointReady, versionInfoSent, versionInfoRecv, knownRemoteBlobs, messages, keyExchange>>

-----------------------------------------------------------------------------
(* Protocol: Blobs (Reconciliation) *)

SendBlobHashes(from, to) ==
    LET msg == [
           type |-> "BlobHashes",
           from |-> from,
           to |-> to,
           payload |-> blobStore[from]
       ]
    IN
    /\ sessionState[from][to] = "syncing_blobs"
    /\ messages' = messages \cup {msg}
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                   endpointReady, sessionState, versionInfoSent, versionInfoRecv, 
                   knownRemoteBlobs, keyExchange>>

ReceiveBlobHashes(peer) ==
    \E m \in messages:
      LET sender == m.from
          needed == m.payload \ blobStore[peer]
          newReq == [type |-> "BlobRequest", from |-> peer, to |-> sender, payload |-> needed]
          newMessages == IF needed /= {} THEN (messages \ {m}) \cup {newReq} ELSE messages \ {m}
      IN
        /\ m.type = "BlobHashes"
        /\ m.to = peer
        \* Guard: Only receive blob hashes during blob sync phase
        /\ sessionState[peer][sender] = "syncing_blobs"
        /\ knownRemoteBlobs' = [knownRemoteBlobs EXCEPT ![peer][sender] = m.payload]
        /\ messages' = newMessages
        /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                       endpointReady, sessionState, versionInfoSent, versionInfoRecv, keyExchange>>

SendBlobData(from, to) ==
    /\ \E m \in messages: m.type = "BlobRequest" /\ m.to = from
    /\ LET req == CHOOSE m \in messages: m.type = "BlobRequest" /\ m.to = from
           hashes == req.payload
           available == hashes \intersect blobStore[from]
       IN /\ messages' = (messages \ {req}) \cup
                         {[type |-> "BlobData", from |-> from, to |-> to, payload |-> h] : h \in available}
          /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                         endpointReady, sessionState, versionInfoSent, versionInfoRecv,
                         knownRemoteBlobs, keyExchange>>

ReceiveBlobData(peer) ==
    /\ \E m \in messages: m.type = "BlobData" /\ m.to = peer
    /\ LET msg == CHOOSE m \in messages: m.type = "BlobData" /\ m.to = peer
           sender == msg.from
           blob == msg.payload
       IN
       \* Guard: Only receive blobs during blob sync phase
       /\ sessionState[peer][sender] = "syncing_blobs"
       /\ blobStore' = [blobStore EXCEPT ![peer] = @ \cup {blob}]
       /\ messages' = messages \ {msg}
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv, knownRemoteBlobs, keyExchange>>

-----------------------------------------------------------------------------
(* Protocol: Completion *)

\* Guard: Only enter live if all blobs referenced by docs are present (or known missing remotely)
\* Ideally: (RemoteBlobs \intersect Needed) \subseteq LocalBlobs
EnterLiveMode(from, to) ==
    /\ sessionState[from][to] = "syncing_blobs"
    \* Check: Do we have all blobs referenced by our docs that the peer also has?
    /\ LET needed == UNION {Refs(docState[from][d]) : d \in Docs}
           remoteHas == knownRemoteBlobs[from][to]
           missing == (needed \intersect remoteHas) \ blobStore[from]
       IN missing = {}
    /\ messages' = messages \cup {[
           type |-> "SyncComplete", from |-> from, to |-> to
       ]}
    /\ sessionState' = [sessionState EXCEPT ![from][to] = "live"]
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                   endpointReady, versionInfoSent, versionInfoRecv, knownRemoteBlobs, keyExchange>>

-----------------------------------------------------------------------------
(* User Actions *)

WriteDoc(peer, doc, refs) ==
    \* Can only write if we have the referenced blobs!
    /\ refs \subseteq blobStore[peer]
    /\ docState' = [docState EXCEPT ![peer][doc] = [
           version |-> IF @ = NULL THEN 1 ELSE @.version + 1,
           refs |-> refs
       ]]
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, blobStore, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv, knownRemoteBlobs, 
                   messages, keyExchange>>

AddBlob(peer, blob) ==
    /\ blobStore' = [blobStore EXCEPT ![peer] = @ \cup {blob}]
    /\ UNCHANGED <<vaultId, vaultKey, vaultKeyTs, versionVector, docState, endpointReady,
                   sessionState, versionInfoSent, versionInfoRecv, knownRemoteBlobs, 
                   messages, keyExchange>>

-----------------------------------------------------------------------------
(* Invariants *)

\* 1. Referential Integrity: Live sessions should have consistent data
ReferentialIntegrity ==
    \A p1, p2 \in Peers:
        (sessionState[p1][p2] = "live") =>
            \A d \in Docs:
                (docState[p1][d] /= NULL) =>
                    (Refs(docState[p1][d]) \intersect knownRemoteBlobs[p1][p2]) \subseteq blobStore[p1]

\* 2. No Deadlock: Peers with different keys eventually resolve or retry
EventualKeyResolution ==
    \A p1, p2 \in Peers:
        (HasKey(p1) /\ HasKey(p2) /\ vaultKey[p1] /= vaultKey[p2])
        ~> (vaultKey[p1] = vaultKey[p2] \/ sessionState[p1][p2] /= "live")

-----------------------------------------------------------------------------
(* Specification *)

Next ==
    \/ \E p \in Peers: BecomeReady(p)
    \/ \E p \in Peers, v \in VaultIds, ts \in 1..5: CreateVault(p, v, ts)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ Connect(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendVersionInfo(p1, p2)
    \/ \E p \in Peers: ReceiveVersionInfo(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ BeginSync(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendUpdates(p1, p2)
    \/ \E p \in Peers: ReceiveUpdates(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ BeginBlobSync(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendBlobHashes(p1, p2)
    \/ \E p \in Peers: ReceiveBlobHashes(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ SendBlobData(p1, p2)
    \/ \E p \in Peers: ReceiveBlobData(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ EnterLiveMode(p1, p2)
    \/ \E p \in Peers, d \in Docs, r \in SUBSET BlobHashes: WriteDoc(p, d, r)
    \/ \E p \in Peers, b \in BlobHashes: AddBlob(p, b)

Spec == Init /\ [][Next]_<<vaultId, vaultKey, vaultKeyTs, versionVector, docState, blobStore,
                           endpointReady, sessionState, versionInfoSent, versionInfoRecv, 
                           knownRemoteBlobs, messages, keyExchange>>

=============================================================================
