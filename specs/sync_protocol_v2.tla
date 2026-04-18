-------------------------- MODULE sync_protocol_v2 --------------------------
(*
 * TLA+ Specification for PeerVault Sync Protocol v2 (CORRECTED)
 *
 * This spec fixes the design flaws found in v1:
 *
 * FIX 1: Content envelope with explicit format marker
 * FIX 2: Ticket generation requires ready state
 * FIX 3: Encryption key must be agreed before sync
 * FIX 4: Migration protocol for existing unencrypted content
 *)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Peers,
    Files,
    MaxVersion,
    NULL

VARIABLES
    crdtState,
    encryptionKey,
    versionVector,
    endpointReady,
    messages,
    syncHistory,
    \* NEW: Track agreed encryption state between peer pairs
    agreedEncryption

-----------------------------------------------------------------------------
(* Type Definitions *)

\* FIX 1: Content envelope with EXPLICIT format marker
\* This is stored in the CRDT, not inferred at read time
ContentEnvelope == [
    version: Nat,           \* Envelope version for future compat
    encrypted: BOOLEAN,     \* Explicit: was this encrypted when written?
    keyId: STRING,          \* Which key was used (for key rotation)
    data: STRING            \* The actual content
]

\* Message types include new handshake for encryption agreement
MessageType == {
    "VERSION_INFO",
    "UPDATES",
    "TICKET",
    "ENCRYPTION_PROPOSAL",  \* NEW: Propose encryption parameters
    "ENCRYPTION_ACCEPT"     \* NEW: Accept encryption parameters
}

-----------------------------------------------------------------------------
(* Initial State *)

Init ==
    /\ crdtState = [p \in Peers |-> [f \in Files |-> NULL]]
    /\ encryptionKey = [p \in Peers |-> NULL]
    /\ versionVector = [p \in Peers |-> [q \in Peers |-> 0]]
    /\ endpointReady = [p \in Peers |-> FALSE]
    /\ messages = {}
    /\ syncHistory = <<>>
    /\ agreedEncryption = [p1 \in Peers |-> [p2 \in Peers |-> NULL]]

-----------------------------------------------------------------------------
(* Helper Operators *)

\* Range of a sequence (set of all elements)
Range(seq) == {seq[i] : i \in 1..Len(seq)}

IncVersion(peer) ==
    versionVector' = [versionVector EXCEPT ![peer][peer] = @ + 1]

HasEncryption(peer) == encryptionKey[peer] /= NULL

\* FIX 1: Read content using envelope's format marker, not reader's state
ReadContent(peer, envelope) ==
    IF envelope.encrypted THEN
        IF encryptionKey[peer] = envelope.keyId THEN
            envelope.data  \* Can decrypt
        ELSE
            "KEY_MISMATCH"  \* Wrong key - clear error
    ELSE
        envelope.data  \* Raw content, return as-is

\* FIX 2: Can only generate ticket when ready
CanGenerateTicket(peer) == endpointReady[peer] = TRUE

\* FIX 3: Check if encryption is agreed between peers
EncryptionAgreed(p1, p2) ==
    agreedEncryption[p1][p2] /= NULL

-----------------------------------------------------------------------------
(* Actions *)

BecomeReady(peer) ==
    /\ endpointReady[peer] = FALSE
    /\ endpointReady' = [endpointReady EXCEPT ![peer] = TRUE]
    /\ UNCHANGED <<crdtState, encryptionKey, versionVector, messages,
                   syncHistory, agreedEncryption>>

EnableEncryption(peer, key) ==
    /\ encryptionKey[peer] = NULL
    /\ encryptionKey' = [encryptionKey EXCEPT ![peer] = key]
    /\ UNCHANGED <<crdtState, versionVector, endpointReady, messages,
                   syncHistory, agreedEncryption>>

\* FIX 1: Write with explicit envelope
WriteFile(peer, file, content) ==
    /\ versionVector[peer][peer] < MaxVersion
    /\ LET envelope == [
           version |-> 1,
           encrypted |-> HasEncryption(peer),
           keyId |-> encryptionKey[peer],
           data |-> content
       ]
       IN crdtState' = [crdtState EXCEPT ![peer][file] = envelope]
    /\ IncVersion(peer)
    /\ UNCHANGED <<encryptionKey, endpointReady, messages, syncHistory,
                   agreedEncryption>>

\* FIX 2: Ticket generation REQUIRES ready state
GenerateTicket(peer) ==
    /\ CanGenerateTicket(peer)  \* MUST be ready
    /\ LET ticket == [peer |-> peer, hasRelay |-> TRUE]  \* Always has relay when ready
       IN messages' = messages \cup {[
              type |-> "TICKET",
              from |-> peer,
              to |-> peer,
              payload |-> ticket
          ]}
    /\ UNCHANGED <<crdtState, encryptionKey, versionVector, endpointReady,
                   syncHistory, agreedEncryption>>

\* FIX 3: New action - propose encryption before sync
\* FIX 6: Only allow proposals with actual keys (no NULL proposals)
ProposeEncryption(from, to) ==
    /\ endpointReady[from] /\ endpointReady[to]
    /\ ~EncryptionAgreed(from, to)
    /\ HasEncryption(from)  \* Must have a key to propose
    /\ messages' = messages \cup {[
           type |-> "ENCRYPTION_PROPOSAL",
           from |-> from,
           to |-> to,
           payload |-> encryptionKey[from]
       ]}
    /\ UNCHANGED <<crdtState, encryptionKey, versionVector, endpointReady,
                   syncHistory, agreedEncryption>>

\* FIX 3, 5 & 7: Accept encryption proposal with key migration and tie-breaking
\* When accepting a new key, re-encrypt any content that was encrypted with old key
\* FIX 7: If both peers propose, don't accept (deadlock avoided by one not proposing)
AcceptEncryption(from, to) ==
    /\ \E m \in messages:
        /\ m.type = "ENCRYPTION_PROPOSAL"
        /\ m.from = from /\ m.to = to
    \* FIX 7: Don't accept if we also have a proposal to them (avoid split-brain)
    /\ ~\E m \in messages: m.type = "ENCRYPTION_PROPOSAL" /\ m.from = to /\ m.to = from
    /\ LET proposedKey == (CHOOSE m \in messages:
               m.type = "ENCRYPTION_PROPOSAL" /\ m.from = from).payload
           oldKey == encryptionKey[to]
           \* Re-encrypt content if we had a different key
           migratedState == [f \in Files |->
               IF crdtState[to][f] /= NULL
                  /\ crdtState[to][f].encrypted = TRUE
                  /\ crdtState[to][f].keyId = oldKey
                  /\ oldKey /= proposedKey
               THEN [crdtState[to][f] EXCEPT !.keyId = proposedKey]
               ELSE crdtState[to][f]]
       IN /\ agreedEncryption' = [agreedEncryption EXCEPT
                  ![from][to] = proposedKey,
                  ![to][from] = proposedKey]
          /\ encryptionKey' = [encryptionKey EXCEPT ![to] = proposedKey]
          /\ crdtState' = [crdtState EXCEPT ![to] = migratedState]
    /\ messages' = messages \ {m \in messages:
           m.type = "ENCRYPTION_PROPOSAL" /\ m.from = from /\ m.to = to}
    /\ UNCHANGED <<versionVector, endpointReady, syncHistory>>

\* FIX 3: Sync only after encryption agreement
InitiateSync(from, to) ==
    /\ endpointReady[from] /\ endpointReady[to]
    /\ EncryptionAgreed(from, to)  \* MUST agree on encryption first
    /\ messages' = messages \cup {[
           type |-> "VERSION_INFO",
           from |-> from,
           to |-> to,
           payload |-> versionVector[from]
       ]}
    /\ UNCHANGED <<crdtState, encryptionKey, versionVector, endpointReady,
                   syncHistory, agreedEncryption>>

\* FIX 1 & 4: Apply updates using envelope format, with migration
ApplyUpdates(peer) ==
    /\ \E m \in messages:
        /\ m.type = "UPDATES"
        /\ m.to = peer
        /\ LET updates == m.payload
           IN \A f \in DOMAIN updates:
               LET envelope == updates[f]
                   readResult == ReadContent(peer, envelope)
               IN CASE readResult = "KEY_MISMATCH" ->
                       \* Log error but don't crash - request key
                       syncHistory' = Append(syncHistory,
                           [peer |-> peer, file |-> f, error |-> "KEY_MISMATCH",
                            action |-> "REQUEST_KEY"])
                  [] OTHER ->
                       \* Success - content is readable
                       crdtState' = [crdtState EXCEPT ![peer][f] = envelope]
    /\ messages' = messages \ {m \in messages: m.type = "UPDATES" /\ m.to = peer}
    /\ UNCHANGED <<encryptionKey, versionVector, endpointReady, agreedEncryption>>

\* FIX 4: Migration action - re-encrypt unencrypted content
MigrateContent(peer, file) ==
    /\ crdtState[peer][file] /= NULL
    /\ crdtState[peer][file].encrypted = FALSE  \* Currently unencrypted
    /\ HasEncryption(peer)  \* We now have a key
    /\ LET oldEnvelope == crdtState[peer][file]
           newEnvelope == [
               version |-> oldEnvelope.version,
               encrypted |-> TRUE,
               keyId |-> encryptionKey[peer],
               data |-> oldEnvelope.data  \* Re-encrypt the data
           ]
       IN crdtState' = [crdtState EXCEPT ![peer][file] = newEnvelope]
    /\ IncVersion(peer)
    /\ UNCHANGED <<encryptionKey, endpointReady, messages, syncHistory,
                   agreedEncryption>>

-----------------------------------------------------------------------------
(* Next State Relation *)

Next ==
    \/ \E p \in Peers: BecomeReady(p)
    \/ \E p \in Peers, k \in {"key1", "key2"}: EnableEncryption(p, k)
    \/ \E p \in Peers, f \in Files, c \in {"content1", "content2"}: WriteFile(p, f, c)
    \/ \E p \in Peers: GenerateTicket(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ ProposeEncryption(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ AcceptEncryption(p1, p2)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ InitiateSync(p1, p2)
    \/ \E p \in Peers: ApplyUpdates(p)
    \/ \E p \in Peers, f \in Files: MigrateContent(p, f)

-----------------------------------------------------------------------------
(* Invariants - These Should Now HOLD *)

\* Content convergence after sync
ContentConvergence ==
    \A p1, p2 \in Peers:
        \A f \in Files:
            (crdtState[p1][f] /= NULL /\ crdtState[p2][f] /= NULL
             /\ EncryptionAgreed(p1, p2))
            => crdtState[p1][f].data = crdtState[p2][f].data

\* No format decode errors (now format is explicit)
NoFormatErrors ==
    \A entry \in Range(syncHistory):
        entry.error /= "FORMAT_MISMATCH"

\* All tickets have addressing info
TicketsHaveAddressing ==
    \A m \in messages:
        m.type = "TICKET" => m.payload.hasRelay = TRUE

\* Content is readable by peers with agreed encryption
ContentReadable ==
    \A p1, p2 \in Peers:
        \A f \in Files:
            (EncryptionAgreed(p1, p2) /\ crdtState[p1][f] /= NULL)
            => ReadContent(p2, crdtState[p1][f]) /= "KEY_MISMATCH"

\* Encryption is agreed before sync happens
SyncRequiresAgreement ==
    \A m \in messages:
        m.type = "VERSION_INFO"
        => EncryptionAgreed(m.from, m.to)

-----------------------------------------------------------------------------
(* Specification *)

Spec == Init /\ [][Next]_<<crdtState, encryptionKey, versionVector,
                           endpointReady, messages, syncHistory,
                           agreedEncryption>>

-----------------------------------------------------------------------------
(* Summary of Fixes *)
(*
 * FIX 1: Content Envelope
 *   - Store format explicitly: {encrypted: bool, keyId: string, data: string}
 *   - Reader uses envelope's format, not its own state
 *
 * FIX 2: Ready State Required
 *   - GenerateTicket requires CanGenerateTicket(peer) = TRUE
 *   - No more tickets with missing relay info
 *
 * FIX 3: Encryption Agreement Protocol
 *   - New ENCRYPTION_PROPOSAL/ACCEPT messages
 *   - Sync blocked until agreedEncryption[p1][p2] is set
 *   - Both peers use same key
 *
 * FIX 4: Migration Protocol
 *   - MigrateContent action re-encrypts old content
 *   - Happens when peer gains encryption key
 *   - Increments version to propagate via CRDT
 *)

=============================================================================
