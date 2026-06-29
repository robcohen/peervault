//! Sync Runner - Orchestrates the sync protocol on a stream
//!
//! This is the core piece that runs the sync protocol:
//! 1. Exchange VERSION_INFO
//! 2. Exchange CRDT UPDATES
//! 3. Exchange BLOB_HASHES and transfer blobs
//! 4. Send SYNC_COMPLETE
//! 5. Enter live mode (PING/PONG keepalive, incremental updates)

use web_time::Instant;

use crate::protocol::sync::{
    Message, VersionInfo, Updates,
    SyncComplete, Ping, Pong, SyncError, BlobHashes, BlobRequest, BlobData,
    BlobSyncComplete, PROTOCOL_VERSION, error_codes,
};
use crate::sync::SyncEngine;
use crate::session::{LiveModeSession, SessionConfig, SessionState};
use crate::error::CoreError;
use iroh_blobs::Hash;

/// Configuration for the sync runner
#[derive(Debug, Clone)]
pub struct RunnerConfig {
    /// Our device hostname
    pub hostname: String,
    /// Our device nickname (optional)
    pub nickname: Option<String>,
    /// Plugin version for compatibility
    pub plugin_version: Option<String>,
    /// One-time pairing nonce (sent by initiator for new pairing)
    pub pairing_nonce: Option<String>,
    /// Timeout for receiving messages (ms)
    pub receive_timeout_ms: u64,
    /// Ping interval in live mode (ms)
    pub ping_interval_ms: u64,
    /// Maximum blob size to inline (larger blobs chunked)
    pub max_inline_blob_size: usize,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            hostname: "Unknown".into(),
            nickname: None,
            plugin_version: None,
            pairing_nonce: None,
            receive_timeout_ms: 30000,
            ping_interval_ms: 15000,
            max_inline_blob_size: 1024 * 1024, // 1MB
        }
    }
}

/// Result of a sync run
#[derive(Debug, Clone)]
pub struct SyncRunResult {
    /// Number of CRDT updates sent
    pub updates_sent: usize,
    /// Number of CRDT updates received
    pub updates_received: usize,
    /// Number of blobs sent
    pub blobs_sent: usize,
    /// Number of blobs received
    pub blobs_received: usize,
    /// Bytes sent
    pub bytes_sent: u64,
    /// Bytes received
    pub bytes_received: u64,
    /// Whether we're now in live mode
    pub is_live: bool,
    /// Peer's device name
    pub peer_hostname: String,
    /// Peer's nickname
    pub peer_nickname: Option<String>,
    /// Error if sync failed
    pub error: Option<String>,
}

impl Default for SyncRunResult {
    fn default() -> Self {
        Self {
            updates_sent: 0,
            updates_received: 0,
            blobs_sent: 0,
            blobs_received: 0,
            bytes_sent: 0,
            bytes_received: 0,
            is_live: false,
            peer_hostname: String::new(),
            peer_nickname: None,
            error: None,
        }
    }
}

/// Stream abstraction for the runner
///
/// This is simpler than the full Transport trait - just send/recv bytes.
/// The WASM bindings will implement this.
pub trait SyncStream: Send + Sync {
    /// Send a message (length-prefixed)
    fn send(&mut self, data: &[u8]) -> Result<(), CoreError>;

    /// Receive a message with timeout
    fn recv(&mut self, timeout_ms: u64) -> Result<Vec<u8>, CoreError>;

    /// Close the stream
    fn close(&mut self) -> Result<(), CoreError>;
}

/// Blob operations interface (provided by caller)
pub trait BlobOps {
    /// List all blob hashes we have
    fn list_hashes(&self) -> Vec<Hash>;

    /// Get blob data by hash
    fn get(&self, hash: &Hash) -> Option<Vec<u8>>;

    /// Store blob data (returns hash)
    fn store(&mut self, hash: &Hash, data: &[u8]) -> Result<(), CoreError>;
}

/// No-op blob ops for when blobs aren't needed
pub struct NoBlobOps;

impl BlobOps for NoBlobOps {
    fn list_hashes(&self) -> Vec<Hash> { vec![] }
    fn get(&self, _hash: &Hash) -> Option<Vec<u8>> { None }
    fn store(&mut self, _hash: &Hash, _data: &[u8]) -> Result<(), CoreError> { Ok(()) }
}

/// Pairing validator - checks if a peer is allowed to connect
///
/// Called by the acceptor when receiving VERSION_INFO from a peer.
/// Returns Ok(()) if the peer is authorized, Err with reason if not.
pub trait PairingValidator: Send + Sync {
    /// Validate a pairing request
    ///
    /// - `peer_node_id`: The node ID of the connecting peer
    /// - `pairing_nonce`: Optional one-time nonce from the pairing ticket
    ///
    /// Returns Ok(true) if peer was newly validated (should be auto-added)
    /// Returns Ok(false) if peer was already known
    /// Returns Err if pairing is rejected
    fn validate(&self, peer_node_id: &str, pairing_nonce: Option<&str>) -> Result<bool, String>;
}

/// Default validator that accepts all peers (for backwards compatibility)
pub struct AcceptAllValidator;

impl PairingValidator for AcceptAllValidator {
    fn validate(&self, _peer_node_id: &str, _pairing_nonce: Option<&str>) -> Result<bool, String> {
        Ok(false) // Accept but don't auto-add
    }
}

/// The sync runner - runs the protocol on a stream
pub struct SyncRunner<'a, V: PairingValidator = AcceptAllValidator> {
    config: RunnerConfig,
    engine: &'a SyncEngine,
    session: LiveModeSession,
    result: SyncRunResult,
    /// Whether we initiated the connection (affects who sends first)
    is_initiator: bool,
    /// Peer node ID (for validation)
    peer_node_id: String,
    /// Pairing validator (for acceptor to validate incoming peers)
    validator: V,
    /// Whether the peer supports iroh-blobs transfer (determined during version exchange)
    peer_supports_iroh_blobs: bool,
    /// Peer's version vector (captured during version exchange)
    peer_vv: Vec<u8>,
}

impl<'a> SyncRunner<'a, AcceptAllValidator> {
    /// Create a new sync runner with default (accept-all) validation
    pub fn new(
        config: RunnerConfig,
        engine: &'a SyncEngine,
        peer_id: String,
        is_initiator: bool,
    ) -> Self {
        Self::with_validator(config, engine, peer_id, is_initiator, AcceptAllValidator)
    }
}

impl<'a, V: PairingValidator> SyncRunner<'a, V> {
    /// Create a new sync runner with custom pairing validation
    pub fn with_validator(
        config: RunnerConfig,
        engine: &'a SyncEngine,
        peer_id: String,
        is_initiator: bool,
        validator: V,
    ) -> Self {
        let session_config = SessionConfig {
            ping_interval_ms: config.ping_interval_ms,
            receive_timeout_ms: config.receive_timeout_ms,
            ..Default::default()
        };

        Self {
            config,
            engine,
            session: LiveModeSession::new(peer_id.clone(), session_config),
            result: SyncRunResult::default(),
            is_initiator,
            peer_node_id: peer_id,
            validator,
            peer_supports_iroh_blobs: false,
            peer_vv: Vec::new(),
        }
    }

    /// Run the sync protocol
    ///
    /// Returns when sync is complete (entering live mode) or on error.
    pub fn run<S: SyncStream, B: BlobOps>(
        &mut self,
        stream: &mut S,
        blobs: &mut B,
    ) -> Result<SyncRunResult, CoreError> {
        // Start the session
        self.session.start()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;

        // Phase 1: Exchange version info
        self.exchange_versions(stream)?;

        // Phase 2: Exchange CRDT updates
        self.exchange_updates(stream)?;

        // Phase 3: Exchange blobs
        self.exchange_blobs(stream, blobs)?;

        // Phase 4: Complete sync
        self.complete_sync(stream)?;

        // Enter live mode
        self.session.enter_live_mode()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;
        self.result.is_live = true;

        Ok(self.result.clone())
    }

    /// Run sync without blob exchange (simpler for CRDT-only sync)
    pub fn run_without_blobs<S: SyncStream>(
        &mut self,
        stream: &mut S,
    ) -> Result<SyncRunResult, CoreError> {
        self.run(stream, &mut NoBlobOps)
    }

    /// Run phases 1-2 only (version exchange + CRDT sync).
    /// Returns the list of blob hashes to exchange.
    /// Call `exchange_blobs_inline` or handle blobs externally, then `complete_and_enter_live`.
    pub fn run_crdt_only<S: SyncStream>(
        &mut self,
        stream: &mut S,
    ) -> Result<(), CoreError> {
        self.session.start()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;
        self.exchange_versions(stream)?;
        self.exchange_updates(stream)?;
        Ok(())
    }

    /// Exchange blob hash lists on the sync stream and compute diffs.
    /// Returns (hashes_we_need, hashes_peer_needs).
    pub fn exchange_blob_hashes<S: SyncStream, B: BlobOps>(
        &mut self,
        stream: &mut S,
        blobs: &B,
    ) -> Result<(Vec<Hash>, Vec<Hash>), CoreError> {
        self.session.begin_blob_sync()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;

        let our_hashes = blobs.list_hashes();

        // Send our hashes
        let msg = Message::BlobHashes(BlobHashes {
            hashes: our_hashes.clone(),
        });
        self.send_message(stream, &msg)?;

        // Receive peer's hashes
        let peer_hashes = self.recv_blob_hashes(stream)?;

        // Compute diffs
        let our_set: std::collections::HashSet<_> = our_hashes.iter().collect();
        let need_from_peer: Vec<_> = peer_hashes.iter()
            .filter(|h| !our_set.contains(h))
            .cloned()
            .collect();

        let peer_set: std::collections::HashSet<_> = peer_hashes.iter().collect();
        let send_to_peer: Vec<_> = our_hashes.iter()
            .filter(|h| !peer_set.contains(h))
            .cloned()
            .collect();

        Ok((need_from_peer, send_to_peer))
    }

    /// Send BlobSyncComplete on the sync stream (after external blob transfer).
    pub fn send_blob_sync_complete<S: SyncStream>(
        &mut self,
        stream: &mut S,
        blob_count: usize,
    ) -> Result<(), CoreError> {
        let msg = Message::BlobSyncComplete(BlobSyncComplete {
            blob_count,
        });
        self.send_message(stream, &msg)?;

        // Wait for peer's BlobSyncComplete
        loop {
            let data = stream.recv(self.config.receive_timeout_ms)?;
            self.result.bytes_received += data.len() as u64;
            let msg = Message::decode(&data)
                .map_err(|e| CoreError::Protocol(e.to_string()))?;
            match msg {
                Message::BlobSyncComplete(_) => break,
                _ => continue,
            }
        }
        Ok(())
    }

    /// Complete sync and enter live mode (phase 4).
    pub fn complete_and_enter_live<S: SyncStream>(
        &mut self,
        stream: &mut S,
    ) -> Result<SyncRunResult, CoreError> {
        self.complete_sync(stream)?;
        self.session.enter_live_mode()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;
        self.result.is_live = true;
        Ok(self.result.clone())
    }

    /// Whether the peer supports iroh-blobs (determined during version exchange)
    pub fn peer_supports_iroh_blobs(&self) -> bool {
        self.peer_supports_iroh_blobs
    }

    /// Run the live mode loop (ping/pong, incremental updates)
    ///
    /// This runs until the connection is closed or an error occurs.
    /// Call this after `run()` succeeds.
    pub fn run_live<S: SyncStream>(
        &mut self,
        stream: &mut S,
        on_update: impl Fn(&[u8]) -> Result<(), CoreError>,
    ) -> Result<(), CoreError> {
        if !self.session.is_live() {
            return Err(CoreError::Protocol("Not in live mode".into()));
        }

        let mut last_ping = Instant::now();

        loop {
            // Check if we should send a ping
            if self.session.should_send_ping() {
                let seq = self.session.create_ping();
                let ping = Message::Ping(Ping {
                    seq,
                    timestamp: now_ms(),
                });
                self.send_message(stream, &ping)?;
                last_ping = Instant::now();
            }

            // Try to receive a message (non-blocking with short timeout)
            match stream.recv(100) {
                Ok(data) => {
                    self.result.bytes_received += data.len() as u64;
                    let msg = Message::decode(&data)
                        .map_err(|e| CoreError::Protocol(e.to_string()))?;

                    match msg {
                        Message::Ping(ping) => {
                            // Respond with pong
                            let pong = Message::Pong(Pong {
                                seq: ping.seq,
                                timestamp: now_ms(),
                            });
                            self.send_message(stream, &pong)?;
                        }
                        Message::Pong(pong) => {
                            self.session.handle_pong(pong.seq)
                                .map_err(|e| CoreError::Protocol(e.to_string()))?;
                        }
                        Message::Updates(updates) => {
                            // Received incremental update
                            on_update(&updates.data)?;
                            self.result.updates_received += 1;
                        }
                        Message::Error(err) => {
                            return Err(CoreError::Protocol(format!(
                                "Peer error: {} ({})", err.message, err.code
                            )));
                        }
                        _ => {
                            // Ignore unexpected messages in live mode
                        }
                    }
                }
                Err(CoreError::Timeout(_)) => {
                    // No message, check for ping timeout
                    if self.session.is_ping_overdue() {
                        self.session.handle_missed_pong();
                        if self.session.is_connection_dead() {
                            return Err(CoreError::Protocol("Connection dead (missed pongs)".into()));
                        }
                    }
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Send an incremental update (call from live mode)
    pub fn send_update<S: SyncStream>(
        &mut self,
        stream: &mut S,
        data: &[u8],
    ) -> Result<(), CoreError> {
        let msg = Message::Updates(Updates {
            data: data.to_vec(),
            op_count: 1,
        });
        self.send_message(stream, &msg)?;
        self.result.updates_sent += 1;
        Ok(())
    }

    /// Get the current session state
    pub fn state(&self) -> SessionState {
        self.session.state()
    }

    /// Get the sync result so far
    pub fn result(&self) -> &SyncRunResult {
        &self.result
    }

    // =========================================================================
    // Protocol Phases
    // =========================================================================

    fn exchange_versions<S: SyncStream>(&mut self, stream: &mut S) -> Result<(), CoreError> {
        // Build our VERSION_INFO
        let our_info = VersionInfo {
            protocol_version: PROTOCOL_VERSION,
            vault_id: *self.engine.vault_id(),
            version_bytes: self.engine.version_vector(),
            hostname: self.config.hostname.clone(),
            nickname: self.config.nickname.clone(),
            has_vault_key: true, // We always require vault key now
            plugin_version: self.config.plugin_version.clone(),
            // Only initiator sends pairing nonce (for new connections)
            pairing_nonce: if self.is_initiator { self.config.pairing_nonce.clone() } else { None },
            supports_iroh_blobs: true,
        };

        // Initiator sends first
        if self.is_initiator {
            self.send_message(stream, &Message::VersionInfo(our_info.clone()))?;
        }

        // Receive peer's VERSION_INFO
        let peer_info = self.recv_version_info(stream)?;

        // Validate basic handshake invariants (vault id, protocol version) BEFORE
        // consuming any one-time pairing nonce. Otherwise a peer presenting a valid
        // nonce but a mismatched vault/version could burn the legitimate pairing nonce.
        if peer_info.vault_id != *self.engine.vault_id() {
            self.send_error(stream, error_codes::VAULT_MISMATCH, "Vault ID mismatch")?;
            return Err(CoreError::Protocol("Vault ID mismatch".into()));
        }
        if peer_info.protocol_version < 2 {
            self.send_error(stream, error_codes::VERSION_MISMATCH, "Protocol version too old")?;
            return Err(CoreError::Protocol(format!(
                "Protocol version too old: {} (minimum 2)",
                peer_info.protocol_version,
            )));
        }

        // Acceptor validates pairing (before sending our VERSION_INFO)
        // This allows us to reject unknown peers with invalid nonces
        if !self.is_initiator {
            match self.validator.validate(&self.peer_node_id, peer_info.pairing_nonce.as_deref()) {
                Ok(_is_new) => {
                    // Pairing validated - proceed with sync.
                    // `get(..16)` avoids panicking on a non-UTF-8-boundary nonce.
                    tracing::info!(
                        peer_id = %self.peer_node_id,
                        nonce = peer_info.pairing_nonce.as_deref().map(|n| n.get(..16).unwrap_or(n)),
                        "Pairing validated for peer"
                    );
                }
                Err(reason) => {
                    self.send_error(stream, error_codes::PAIRING_REJECTED, &reason)?;
                    return Err(CoreError::Protocol(format!("Pairing rejected: {}", reason)));
                }
            }
        }

        // Acceptor sends after receiving (and validating)
        if !self.is_initiator {
            self.send_message(stream, &Message::VersionInfo(our_info))?;
        }

        // Store peer info
        self.result.peer_hostname = peer_info.hostname;
        self.result.peer_nickname = peer_info.nickname;
        self.peer_supports_iroh_blobs = peer_info.supports_iroh_blobs;
        self.peer_vv = peer_info.version_bytes.clone();

        // Transition to syncing updates
        self.session.begin_version_exchange()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;

        Ok(())
    }

    fn exchange_updates<S: SyncStream>(&mut self, stream: &mut S) -> Result<(), CoreError> {
        self.session.begin_update_sync()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;

        // Export updates since peer's version (encrypted)
        let our_updates = self.engine.export_updates_since(&self.peer_vv)?;

        // Send our updates
        if !our_updates.is_empty() {
            let msg = Message::Updates(Updates {
                data: our_updates.clone(),
                op_count: 1,
            });
            self.send_message(stream, &msg)?;
            self.result.updates_sent += 1;
        }

        // Signal end of updates with SyncComplete
        let complete_msg = Message::SyncComplete(SyncComplete {
            version_bytes: self.engine.version_vector(),
        });
        self.send_message(stream, &complete_msg)?;

        // Receive peer's updates
        loop {
            let data = stream.recv(self.config.receive_timeout_ms)?;
            self.result.bytes_received += data.len() as u64;

            let msg = Message::decode(&data)
                .map_err(|e| CoreError::Protocol(e.to_string()))?;

            match msg {
                Message::Updates(updates) => {
                    // Import peer's updates (decrypts internally)
                    // If decryption fails, this is likely a key conflict
                    match self.engine.import_updates(&updates.data) {
                        Ok(()) => {
                            self.result.updates_received += 1;
                        }
                        Err(CoreError::Crypto(_)) => {
                            // Decryption failed - this is a key conflict
                            // Both peers have different vault keys
                            self.send_error(
                                stream,
                                error_codes::KEY_CONFLICT,
                                "Vault key mismatch - both devices have different encryption keys"
                            )?;
                            return Err(CoreError::KeyConflict {
                                our_device: self.config.hostname.clone(),
                                peer_device: self.result.peer_hostname.clone(),
                            });
                        }
                        Err(e) => return Err(e),
                    }
                }
                Message::SyncComplete(_) => {
                    // Peer is done sending updates
                    break;
                }
                Message::BlobHashes(_) => {
                    // Peer skipped to blob phase - handle in next phase
                    break;
                }
                Message::Error(err) => {
                    // Check if peer detected key conflict
                    if err.code == error_codes::KEY_CONFLICT {
                        return Err(CoreError::KeyConflict {
                            our_device: self.config.hostname.clone(),
                            peer_device: self.result.peer_hostname.clone(),
                        });
                    }
                    return Err(CoreError::Protocol(format!(
                        "Peer error: {} ({})", err.message, err.code
                    )));
                }
                _ => {
                    // Unexpected message type
                    return Err(CoreError::Protocol(format!(
                        "Unexpected message type during update sync: {:?}",
                        msg.message_type()
                    )));
                }
            }
        }

        Ok(())
    }

    /// V2 inline blob exchange (sends/receives blobs on the sync stream).
    /// Use `exchange_blob_hashes` + external iroh-blobs transfer for V3.
    pub fn exchange_blobs<S: SyncStream, B: BlobOps>(
        &mut self,
        stream: &mut S,
        blobs: &mut B,
    ) -> Result<(), CoreError> {
        self.session.begin_blob_sync()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;

        // Get our blob hashes
        let our_hashes = blobs.list_hashes();

        // Send our hashes
        let msg = Message::BlobHashes(BlobHashes {
            hashes: our_hashes.clone(),
        });
        self.send_message(stream, &msg)?;

        // Receive peer's hashes
        let peer_hashes = self.recv_blob_hashes(stream)?;

        // Compute what we need from peer
        let our_set: std::collections::HashSet<_> = our_hashes.iter().collect();
        let need_from_peer: Vec<_> = peer_hashes.iter()
            .filter(|h| !our_set.contains(h))
            .cloned()
            .collect();

        // Compute what peer needs from us
        let peer_set: std::collections::HashSet<_> = peer_hashes.iter().collect();
        let send_to_peer: Vec<_> = our_hashes.iter()
            .filter(|h| !peer_set.contains(h))
            .cloned()
            .collect();

        // Request blobs we need
        if !need_from_peer.is_empty() {
            let msg = Message::BlobRequest(BlobRequest {
                hashes: need_from_peer.clone(),
            });
            self.send_message(stream, &msg)?;
        }

        // Handle blob exchange (send and receive interleaved).
        //
        // The loop is bounded on three axes so a malicious or buggy peer cannot
        // hang the sync forever:
        //   * `idle_timeouts` — consecutive receive timeouts with nothing left to
        //     send (peer advertised a blob but never sends it).
        //   * `messages` — total messages processed (peer floods unexpected msgs).
        //   * progress on send — if we cannot satisfy a blob locally we still
        //     advance `sent`, instead of retrying the same missing hash forever.
        let mut received = 0;
        let mut sent = 0;
        let mut idle_timeouts: u32 = 0;
        let mut messages: usize = 0;
        const MAX_IDLE_TIMEOUTS: u32 = 30;
        let max_messages = need_from_peer
            .len()
            .saturating_add(send_to_peer.len())
            .saturating_mul(4)
            .saturating_add(64);

        while received < need_from_peer.len() || sent < send_to_peer.len() {
            // Try to receive
            match stream.recv(1000) {
                Ok(data) => {
                    messages += 1;
                    if messages > max_messages {
                        tracing::warn!(messages, "Blob exchange exceeded message budget, aborting");
                        break;
                    }
                    idle_timeouts = 0;
                    self.result.bytes_received += data.len() as u64;
                    let msg = Message::decode(&data)
                        .map_err(|e| CoreError::Protocol(e.to_string()))?;

                    match msg {
                        Message::BlobData(blob) => {
                            // Decrypt and store the blob
                            let plaintext = self.engine.decrypt_blob(&blob.data)?;
                            blobs.store(&blob.hash, &plaintext)?;

                            received += 1;
                            self.result.blobs_received += 1;
                        }
                        Message::BlobRequest(req) => {
                            // Send requested blobs
                            for hash in req.hashes {
                                if let Some(data) = blobs.get(&hash) {
                                    // Encrypt blob data
                                    let encrypted = self.engine.encrypt_blob(&data)?;

                                    let msg = Message::BlobData(BlobData {
                                        hash: hash.clone(),
                                        data: encrypted,
                                        mime_type: None,
                                    });
                                    self.send_message(stream, &msg)?;
                                    self.result.blobs_sent += 1;
                                }
                            }
                        }
                        Message::BlobSyncComplete(_) => {
                            break;
                        }
                        _ => {}
                    }
                }
                Err(CoreError::Timeout(_)) => {
                    // Send the next pending blob. If we don't have it locally, skip
                    // it (advance `sent`) rather than retrying forever.
                    if sent < send_to_peer.len() {
                        let hash = send_to_peer[sent].clone();
                        match blobs.get(&hash) {
                            Some(data) => {
                                let encrypted = self.engine.encrypt_blob(&data)?;

                                let msg = Message::BlobData(BlobData {
                                    hash: hash.clone(),
                                    data: encrypted,
                                    mime_type: None,
                                });
                                self.send_message(stream, &msg)?;
                                self.result.blobs_sent += 1;
                            }
                            None => {
                                tracing::warn!(hash = %hash, "Blob not available locally, skipping");
                            }
                        }
                        sent += 1;
                        idle_timeouts = 0;
                    } else {
                        // Nothing left to send; only waiting on the peer now.
                        idle_timeouts += 1;
                        if idle_timeouts >= MAX_IDLE_TIMEOUTS {
                            tracing::warn!(
                                received,
                                needed = need_from_peer.len(),
                                "Blob exchange timed out waiting for peer"
                            );
                            break;
                        }
                    }
                }
                Err(e) => return Err(e),
            }
        }

        // Send blob sync complete
        let msg = Message::BlobSyncComplete(BlobSyncComplete {
            blob_count: self.result.blobs_sent,
        });
        self.send_message(stream, &msg)?;

        Ok(())
    }

    fn complete_sync<S: SyncStream>(&mut self, stream: &mut S) -> Result<(), CoreError> {
        // Send SYNC_COMPLETE
        let msg = Message::SyncComplete(SyncComplete {
            version_bytes: self.engine.version_vector(),
        });
        self.send_message(stream, &msg)?;

        // Wait for peer's SYNC_COMPLETE
        loop {
            let data = stream.recv(self.config.receive_timeout_ms)?;
            self.result.bytes_received += data.len() as u64;

            let msg = Message::decode(&data)
                .map_err(|e| CoreError::Protocol(e.to_string()))?;

            match msg {
                Message::SyncComplete(_) => {
                    break;
                }
                Message::Error(err) => {
                    return Err(CoreError::Protocol(format!(
                        "Peer error: {} ({})", err.message, err.code
                    )));
                }
                _ => {
                    // Ignore other messages while waiting for SYNC_COMPLETE
                }
            }
        }

        Ok(())
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    fn send_message<S: SyncStream>(&mut self, stream: &mut S, msg: &Message) -> Result<(), CoreError> {
        let data = msg.encode()
            .map_err(|e| CoreError::Protocol(e.to_string()))?;
        self.result.bytes_sent += data.len() as u64;
        self.session.metrics_mut().record_sent(data.len());
        stream.send(&data)
    }

    fn send_error<S: SyncStream>(
        &mut self,
        stream: &mut S,
        code: u8,
        message: &str,
    ) -> Result<(), CoreError> {
        let msg = Message::Error(SyncError {
            code,
            message: message.into(),
        });
        self.send_message(stream, &msg)
    }

    fn recv_version_info<S: SyncStream>(&mut self, stream: &mut S) -> Result<VersionInfo, CoreError> {
        let data = stream.recv(self.config.receive_timeout_ms)?;
        self.result.bytes_received += data.len() as u64;
        self.session.metrics_mut().record_received(data.len());

        let msg = Message::decode(&data)
            .map_err(|e| CoreError::Protocol(e.to_string()))?;

        match msg {
            Message::VersionInfo(info) => Ok(info),
            Message::Error(err) => Err(CoreError::Protocol(format!(
                "Peer error: {} ({})", err.message, err.code
            ))),
            _ => Err(CoreError::Protocol(format!(
                "Expected VERSION_INFO, got {:?}", msg.message_type()
            ))),
        }
    }

    fn recv_blob_hashes<S: SyncStream>(&mut self, stream: &mut S) -> Result<Vec<Hash>, CoreError> {
        let data = stream.recv(self.config.receive_timeout_ms)?;
        self.result.bytes_received += data.len() as u64;

        let msg = Message::decode(&data)
            .map_err(|e| CoreError::Protocol(e.to_string()))?;

        match msg {
            Message::BlobHashes(hashes) => Ok(hashes.hashes),
            Message::BlobSyncComplete(_) => Ok(vec![]), // Peer has no blobs
            _ => Err(CoreError::Protocol(format!(
                "Expected BLOB_HASHES, got {:?}", msg.message_type()
            ))),
        }
    }
}

/// Get current timestamp in milliseconds
fn now_ms() -> u64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use crate::host::mock::MockHost;
    use crate::crypto::VaultKey;

    /// In-memory stream for testing
    struct TestStream {
        send_buf: Arc<Mutex<VecDeque<Vec<u8>>>>,
        recv_buf: Arc<Mutex<VecDeque<Vec<u8>>>>,
    }

    impl TestStream {
        fn new_pair() -> (Self, Self) {
            let buf1 = Arc::new(Mutex::new(VecDeque::new()));
            let buf2 = Arc::new(Mutex::new(VecDeque::new()));

            let s1 = TestStream {
                send_buf: buf1.clone(),
                recv_buf: buf2.clone(),
            };
            let s2 = TestStream {
                send_buf: buf2,
                recv_buf: buf1,
            };

            (s1, s2)
        }
    }

    impl SyncStream for TestStream {
        fn send(&mut self, data: &[u8]) -> Result<(), CoreError> {
            self.send_buf.lock().unwrap().push_back(data.to_vec());
            Ok(())
        }

        fn recv(&mut self, _timeout_ms: u64) -> Result<Vec<u8>, CoreError> {
            self.recv_buf.lock().unwrap()
                .pop_front()
                .ok_or_else(|| CoreError::Timeout("No data".into()))
        }

        fn close(&mut self) -> Result<(), CoreError> {
            Ok(())
        }
    }

    fn create_engine() -> (Arc<MockHost>, SyncEngine) {
        let host = Arc::new(MockHost::new());
        let key = VaultKey::generate();
        let engine = SyncEngine::new_with_key(host.clone(), key).unwrap();
        (host, engine)
    }

    #[test]
    fn test_version_exchange() {
        // Create engines with shared vault key
        let host1 = Arc::new(MockHost::new());
        let host2 = Arc::new(MockHost::new());
        let key = VaultKey::generate();
        let mut engine1 = SyncEngine::new_with_key(host1, key.clone()).unwrap();
        let mut engine2 = SyncEngine::new_with_key(host2, key).unwrap();

        // Make sure both have same vault ID
        let vault_id = [42u8; 32];
        engine1.init_vault(vault_id);
        engine2.init_vault(vault_id);

        let (mut s1, mut s2) = TestStream::new_pair();

        let config = RunnerConfig::default();

        let mut runner1 = SyncRunner::new(
            config.clone(),
            &engine1,
            "peer2".into(),
            true, // initiator
        );

        let mut runner2 = SyncRunner::new(
            config,
            &engine2,
            "peer1".into(),
            false, // acceptor
        );

        // Run phase 1 only - exchange versions
        runner1.session.start().unwrap();
        runner2.session.start().unwrap();

        // Initiator sends VERSION_INFO
        let our_info = VersionInfo {
            protocol_version: PROTOCOL_VERSION,
            vault_id,
            version_bytes: engine1.version_vector(),
            hostname: "test1".into(),
            nickname: None,
            has_vault_key: true,
            plugin_version: None,
            pairing_nonce: None,
            supports_iroh_blobs: true,
        };
        runner1.send_message(&mut s1, &Message::VersionInfo(our_info)).unwrap();

        // Acceptor receives and sends
        let peer_info = runner2.recv_version_info(&mut s2).unwrap();
        assert_eq!(peer_info.hostname, "test1");

        let our_info2 = VersionInfo {
            protocol_version: PROTOCOL_VERSION,
            vault_id,
            version_bytes: engine2.version_vector(),
            hostname: "test2".into(),
            nickname: None,
            has_vault_key: true,
            plugin_version: None,
            pairing_nonce: None,
            supports_iroh_blobs: true,
        };
        runner2.send_message(&mut s2, &Message::VersionInfo(our_info2)).unwrap();

        // Initiator receives
        let peer_info = runner1.recv_version_info(&mut s1).unwrap();
        assert_eq!(peer_info.hostname, "test2");
    }

    #[test]
    fn test_message_roundtrip() {
        let ping = Message::Ping(Ping { seq: 42, timestamp: 12345 });
        let encoded = ping.encode().unwrap();
        let decoded = Message::decode(&encoded).unwrap();

        match decoded {
            Message::Ping(p) => {
                assert_eq!(p.seq, 42);
                assert_eq!(p.timestamp, 12345);
            }
            _ => panic!("Wrong message type"),
        }
    }
}
