---------------------------- MODULE sync_protocol ----------------------------
(*
 * TLA+ Specification for PeerVault Sync Protocol
 *
 * This spec models the peer-to-peer sync protocol to find design flaws
 * before they manifest as bugs in implementation.
 *
 * Run with TLC model checker to find invariant violations.
 *)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Peers,          \* Set of peer IDs, e.g., {"A", "B", "C"}
    Files,          \* Set of file paths, e.g., {"file1.md", "file2.md"}
    MaxVersion,     \* Maximum version number to bound state space
    NULL            \* Model value for null/uninitialized

VARIABLES
    \* --- Per-peer state ---
    crdtState,      \* crdtState[peer][file] = record of content
    encryptionKey,  \* encryptionKey[peer] = key or NULL
    versionVector,  \* versionVector[peer] = [peer -> version]
    endpointReady,  \* endpointReady[peer] = TRUE when connected to relay

    \* --- Network state ---
    messages,       \* Set of in-flight messages

    \* --- Global state for analysis ---
    syncHistory     \* Log of sync operations for debugging

-----------------------------------------------------------------------------
(* Type Definitions *)

ContentFormat == {"raw", "encrypted"}

\* Content stored in CRDT - note: format is implicit in current design!
ContentRecord == [
    data: STRING,           \* The actual content (raw or base64)
    format: ContentFormat,  \* How it was written - BUT THIS ISN'T STORED!
    version: Nat
]

\* What the CRDT actually stores (the bug: no format field!)
ActualCrdtRecord == [
    data: STRING,
    version: Nat
]

Message == [
    type: {"VERSION_INFO", "UPDATES", "TICKET"},
    from: Peers,
    to: Peers,
    payload: STRING
]

-----------------------------------------------------------------------------
(* Initial State *)

Init ==
    /\ crdtState = [p \in Peers |-> [f \in Files |-> NULL]]
    /\ encryptionKey = [p \in Peers |-> NULL]
    /\ versionVector = [p \in Peers |-> [q \in Peers |-> 0]]
    /\ endpointReady = [p \in Peers |-> FALSE]
    /\ messages = {}
    /\ syncHistory = <<>>

-----------------------------------------------------------------------------
(* Helper Operators *)

\* Range of a sequence (set of all elements)
Range(seq) == {seq[i] : i \in 1..Len(seq)}

\* Increment version for a peer
IncVersion(peer) ==
    versionVector' = [versionVector EXCEPT ![peer][peer] = @ + 1]

\* Check if peer has encryption enabled
HasEncryption(peer) == encryptionKey[peer] /= NULL

\* Simulate content transformation based on encryption state
\* BUG: This is what the current code does - format depends on READER's key
TransformForRead(peer, content) ==
    IF HasEncryption(peer) THEN
        \* Try to decrypt - fails if content wasn't encrypted
        IF content.format = "encrypted" THEN
            content.data  \* Success
        ELSE
            "DECODE_ERROR"  \* Base64 decode fails on raw content
    ELSE
        content.data  \* Return as-is

-----------------------------------------------------------------------------
(* Actions *)

\* Peer connects to relay and becomes ready
BecomeReady(peer) ==
    /\ endpointReady[peer] = FALSE
    /\ endpointReady' = [endpointReady EXCEPT ![peer] = TRUE]
    /\ UNCHANGED <<crdtState, encryptionKey, versionVector, messages, syncHistory>>

\* Peer enables encryption (e.g., during pairing)
EnableEncryption(peer, key) ==
    /\ encryptionKey[peer] = NULL
    /\ encryptionKey' = [encryptionKey EXCEPT ![peer] = key]
    /\ UNCHANGED <<crdtState, versionVector, endpointReady, messages, syncHistory>>

\* Peer writes a file - format depends on encryption state at write time
WriteFile(peer, file, content) ==
    /\ versionVector[peer][peer] < MaxVersion
    /\ LET format == IF HasEncryption(peer) THEN "encrypted" ELSE "raw"
           record == [data |-> content, format |-> format,
                      version |-> versionVector[peer][peer] + 1]
       IN crdtState' = [crdtState EXCEPT ![peer][file] = record]
    /\ IncVersion(peer)
    /\ UNCHANGED <<encryptionKey, endpointReady, messages, syncHistory>>

\* Generate a ticket - BUG: may not have relay info if not ready!
GenerateTicket(peer) ==
    \* Current buggy behavior: can generate ticket before ready
    /\ LET hasRelay == endpointReady[peer]
           ticket == [peer |-> peer, hasRelay |-> hasRelay]
       IN messages' = messages \cup {[
              type |-> "TICKET",
              from |-> peer,
              to |-> peer,  \* Ticket is for sharing
              payload |-> ticket
          ]}
    /\ UNCHANGED <<crdtState, encryptionKey, versionVector, endpointReady, syncHistory>>

\* Initiate sync - send version vector to peer
InitiateSync(from, to) ==
    /\ endpointReady[from]
    /\ endpointReady[to]
    /\ messages' = messages \cup {[
           type |-> "VERSION_INFO",
           from |-> from,
           to |-> to,
           payload |-> versionVector[from]
       ]}
    /\ UNCHANGED <<crdtState, encryptionKey, versionVector, endpointReady, syncHistory>>

\* Receive version vector and send updates
ReceiveVersionAndSendUpdates(from, to, theirVV) ==
    /\ \E m \in messages:
        /\ m.type = "VERSION_INFO"
        /\ m.from = from
        /\ m.to = to
    \* Send files they don't have
    /\ LET filesToSend == {f \in Files:
               /\ crdtState[to][f] /= NULL
               /\ crdtState[to][f].version > theirVV[to]}
       IN messages' = (messages \ {m \in messages:
               m.type = "VERSION_INFO" /\ m.from = from /\ m.to = to})
           \cup {[
               type |-> "UPDATES",
               from |-> to,
               to |-> from,
               payload |-> [f \in filesToSend |-> crdtState[to][f]]
           ]}
    /\ UNCHANGED <<crdtState, encryptionKey, versionVector, endpointReady, syncHistory>>

\* Apply received updates - THIS IS WHERE FORMAT MISMATCH BUGS OCCUR
ApplyUpdates(peer) ==
    /\ \E m \in messages:
        /\ m.type = "UPDATES"
        /\ m.to = peer
        /\ LET updates == m.payload
           IN \A f \in DOMAIN updates:
               \* BUG: We try to read based on OUR encryption state
               \* not the FORMAT the content was written in
               LET content == updates[f]
                   readResult == TransformForRead(peer, content)
               IN IF readResult = "DECODE_ERROR" THEN
                      \* Record the error - this is the bug!
                      syncHistory' = Append(syncHistory,
                          [peer |-> peer, file |-> f, error |-> "FORMAT_MISMATCH"])
                  ELSE
                      crdtState' = [crdtState EXCEPT ![peer][f] = content]
    /\ messages' = messages \ {m \in messages: m.type = "UPDATES" /\ m.to = peer}
    /\ UNCHANGED <<encryptionKey, versionVector, endpointReady>>

-----------------------------------------------------------------------------
(* Next State Relation *)

Next ==
    \/ \E p \in Peers: BecomeReady(p)
    \/ \E p \in Peers, k \in {"key1", "key2"}: EnableEncryption(p, k)
    \/ \E p \in Peers, f \in Files, c \in {"content1", "content2"}: WriteFile(p, f, c)
    \/ \E p \in Peers: GenerateTicket(p)
    \/ \E p1, p2 \in Peers: p1 /= p2 /\ InitiateSync(p1, p2)
    \/ \E p \in Peers: ApplyUpdates(p)

-----------------------------------------------------------------------------
(* Invariants - Properties That Should Always Hold *)

\* INVARIANT 1: If two peers are synced, they should have identical content
\* This is the core CRDT guarantee
ContentConvergence ==
    \A p1, p2 \in Peers:
        \A f \in Files:
            (crdtState[p1][f] /= NULL /\ crdtState[p2][f] /= NULL)
            => crdtState[p1][f].data = crdtState[p2][f].data

\* INVARIANT 2: No format mismatch errors should occur
\* This WILL BE VIOLATED by current design!
NoFormatErrors ==
    \A entry \in Range(syncHistory):
        entry.error /= "FORMAT_MISMATCH"

\* INVARIANT 3: Tickets generated when ready should have relay info
\* This WILL BE VIOLATED by current design!
TicketsHaveAddressing ==
    \A m \in messages:
        m.type = "TICKET" => m.payload.hasRelay = TRUE

\* INVARIANT 4: Content can be read by any peer with the same key
\* This is what SHOULD hold but doesn't due to format ambiguity
ContentReadable ==
    \A p1, p2 \in Peers:
        \A f \in Files:
            (encryptionKey[p1] = encryptionKey[p2]
             /\ crdtState[p1][f] /= NULL)
            => TransformForRead(p2, crdtState[p1][f]) /= "DECODE_ERROR"

-----------------------------------------------------------------------------
(* Temporal Properties *)

\* Eventually all peers converge
EventualConvergence ==
    <>[]ContentConvergence

\* If a file is written, eventually all peers have it
EventualDelivery ==
    \A p1 \in Peers, f \in Files:
        (crdtState[p1][f] /= NULL)
        ~> (\A p2 \in Peers: crdtState[p2][f] /= NULL)

-----------------------------------------------------------------------------
(* Specification *)

Spec == Init /\ [][Next]_<<crdtState, encryptionKey, versionVector,
                           endpointReady, messages, syncHistory>>

-----------------------------------------------------------------------------
(* What TLC Will Find *)
(*
 * Running TLC on this spec will find counterexamples for:
 *
 * 1. NoFormatErrors - VIOLATED when:
 *    - Peer A writes file WITHOUT encryption (raw format)
 *    - Peer B enables encryption
 *    - Peer A syncs to Peer B
 *    - Peer B tries to base64-decode raw content -> ERROR
 *
 * 2. TicketsHaveAddressing - VIOLATED when:
 *    - Peer generates ticket before BecomeReady
 *    - Ticket has hasRelay = FALSE
 *
 * 3. ContentReadable - VIOLATED due to format ambiguity
 *
 * These are exactly the bugs we found empirically!
 *)

=============================================================================
