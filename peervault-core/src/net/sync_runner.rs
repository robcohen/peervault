//! Sync Runner - bridges sync protocol with Iroh streams
//!
//! This module runs the sync protocol over actual network connections.
//! Uses Loro's export/import for efficient delta sync.

use anyhow::{anyhow, Result};
use tracing::{debug, warn};

use crate::net::transport::IrohStream;
use crate::protocol::sync::{self as proto, Message, PROTOCOL_VERSION};
use crate::sync::{SyncEngine, SyncSession, SyncState};
use crate::store::SyncStats;

/// Configuration for sync session
pub struct SyncConfig {
    /// Vault ID
    pub vault_id: [u8; 32],
    /// Device hostname
    pub hostname: String,
    /// Device nickname
    pub nickname: Option<String>,
    /// Whether we have the vault encryption key
    pub has_vault_key: bool,
    /// Plugin version
    pub plugin_version: Option<String>,
}

/// Run a sync session as the initiator (we opened the stream)
pub async fn run_initiator_sync(
    stream: &mut IrohStream,
    engine: &SyncEngine,
    session: &mut SyncSession,
    config: &SyncConfig,
) -> Result<SyncStats> {
    let start = web_time::Instant::now();
    let mut stats = SyncStats::default();

    session.start();

    // Step 1: Send VERSION_INFO
    let version_info = Message::VersionInfo(proto::VersionInfo {
        protocol_version: PROTOCOL_VERSION,
        vault_id: config.vault_id,
        version_bytes: engine.version_vector(),
        hostname: config.hostname.clone(),
        nickname: config.nickname.clone(),
        has_vault_key: config.has_vault_key,
        plugin_version: config.plugin_version.clone(),
        pairing_nonce: None,
        supports_iroh_blobs: true,
    });

    debug!("Initiator: sending VERSION_INFO");
    send_message(stream, &version_info, &mut stats).await?;

    // Step 2: Wait for peer's VERSION_INFO
    let msg = recv_message(stream, &mut stats).await?;
    match msg {
        Message::VersionInfo(peer_info) => {
            debug!("Initiator: received VERSION_INFO from {}", peer_info.hostname);

            // Check vault ID match
            if peer_info.vault_id != config.vault_id {
                let err = Message::Error(proto::SyncError {
                    code: proto::error_codes::VAULT_MISMATCH,
                    message: "Vault ID mismatch".into(),
                });
                send_message(stream, &err, &mut stats).await?;
                return Err(anyhow!("Vault ID mismatch"));
            }

            session.set_peer_version(peer_info.version_bytes.clone());
            session.set_peer_has_vault_key(peer_info.has_vault_key);

            // Check if we're already synced
            if engine.is_synced_with(&peer_info.version_bytes) {
                debug!("Initiator: already in sync");
                let complete = Message::SyncComplete(proto::SyncComplete {
                    version_bytes: engine.version_vector(),
                });
                send_message(stream, &complete, &mut stats).await?;
                session.complete();
                return Ok(finalize_stats(stats, start));
            }

            // Export updates since peer's version and send
            let updates = engine.export_updates_since(&peer_info.version_bytes)?;
            let updates_msg = Message::Updates(proto::Updates {
                data: updates,
                op_count: 0, // We don't track individual ops
            });
            debug!("Initiator: sending UPDATES");
            send_message(stream, &updates_msg, &mut stats).await?;
        }
        Message::Error(e) => {
            return Err(anyhow!("Peer error: {}", e.message));
        }
        other => {
            return Err(anyhow!("Expected VERSION_INFO, got {:?}", other.message_type()));
        }
    }

    // Step 3: Wait for peer's UPDATES or SYNC_COMPLETE
    loop {
        if session.state() == SyncState::Live {
            break;
        }

        let msg = recv_message(stream, &mut stats).await?;
        match msg {
            Message::Updates(updates) => {
                debug!("Initiator: received UPDATES ({} bytes)", updates.data.len());
                engine.import_updates(&updates.data)?;
                stats.ops_received += updates.op_count;
            }
            Message::Snapshot(snapshot) => {
                debug!("Initiator: received SNAPSHOT ({} bytes)", snapshot.data.len());
                engine.import_snapshot(&snapshot.data)?;
            }
            Message::SyncComplete(complete) => {
                debug!("Initiator: received SYNC_COMPLETE");
                session.set_peer_version(complete.version_bytes);
                session.complete();

                // Send our completion
                let our_complete = Message::SyncComplete(proto::SyncComplete {
                    version_bytes: engine.version_vector(),
                });
                send_message(stream, &our_complete, &mut stats).await?;
                break;
            }
            Message::Ping(ping) => {
                let pong = Message::Pong(proto::Pong {
                    seq: ping.seq,
                    timestamp: ping.timestamp,
                });
                send_message(stream, &pong, &mut stats).await?;
            }
            Message::Error(e) => {
                return Err(anyhow!("Peer error: {}", e.message));
            }
            other => {
                warn!("Unexpected message: {:?}", other.message_type());
            }
        }
    }

    Ok(finalize_stats(stats, start))
}

/// Run a sync session as the acceptor (we received the stream)
pub async fn run_acceptor_sync(
    stream: &mut IrohStream,
    engine: &SyncEngine,
    session: &mut SyncSession,
    config: &SyncConfig,
) -> Result<SyncStats> {
    let start = web_time::Instant::now();
    let mut stats = SyncStats::default();

    // Step 1: Wait for VERSION_INFO
    let msg = recv_message(stream, &mut stats).await?;
    match msg {
        Message::VersionInfo(peer_info) => {
            debug!("Acceptor: received VERSION_INFO from {}", peer_info.hostname);

            // Check vault ID match
            if peer_info.vault_id != config.vault_id {
                let err = Message::Error(proto::SyncError {
                    code: proto::error_codes::VAULT_MISMATCH,
                    message: "Vault ID mismatch".into(),
                });
                send_message(stream, &err, &mut stats).await?;
                return Err(anyhow!("Vault ID mismatch"));
            }

            session.set_peer_version(peer_info.version_bytes.clone());
            session.set_peer_has_vault_key(peer_info.has_vault_key);

            // Send our VERSION_INFO
            let our_info = Message::VersionInfo(proto::VersionInfo {
                protocol_version: PROTOCOL_VERSION,
                vault_id: config.vault_id,
                version_bytes: engine.version_vector(),
                hostname: config.hostname.clone(),
                nickname: config.nickname.clone(),
                has_vault_key: config.has_vault_key,
                plugin_version: config.plugin_version.clone(),
                pairing_nonce: None,
                supports_iroh_blobs: true,
            });
            send_message(stream, &our_info, &mut stats).await?;

            // Check if we're already synced
            if engine.is_synced_with(&peer_info.version_bytes) {
                debug!("Acceptor: already in sync");
                let complete = Message::SyncComplete(proto::SyncComplete {
                    version_bytes: engine.version_vector(),
                });
                send_message(stream, &complete, &mut stats).await?;
                session.complete();
                return Ok(finalize_stats(stats, start));
            }

            // Export updates since peer's version and send
            let updates = engine.export_updates_since(&peer_info.version_bytes)?;
            let updates_msg = Message::Updates(proto::Updates {
                data: updates,
                op_count: 0,
            });
            debug!("Acceptor: sending UPDATES");
            send_message(stream, &updates_msg, &mut stats).await?;
        }
        other => {
            return Err(anyhow!("Expected VERSION_INFO, got {:?}", other.message_type()));
        }
    }

    // Step 2: Process messages until sync complete
    loop {
        if session.state() == SyncState::Live {
            break;
        }

        let msg = recv_message(stream, &mut stats).await?;
        match msg {
            Message::Updates(updates) => {
                debug!("Acceptor: received UPDATES ({} bytes)", updates.data.len());
                engine.import_updates(&updates.data)?;
                stats.ops_received += updates.op_count;
            }
            Message::Snapshot(snapshot) => {
                debug!("Acceptor: received SNAPSHOT ({} bytes)", snapshot.data.len());
                engine.import_snapshot(&snapshot.data)?;
            }
            Message::SyncComplete(complete) => {
                debug!("Acceptor: received SYNC_COMPLETE");
                session.set_peer_version(complete.version_bytes);
                session.complete();

                // Send our completion
                let our_complete = Message::SyncComplete(proto::SyncComplete {
                    version_bytes: engine.version_vector(),
                });
                send_message(stream, &our_complete, &mut stats).await?;
                break;
            }
            Message::Ping(ping) => {
                let pong = Message::Pong(proto::Pong {
                    seq: ping.seq,
                    timestamp: ping.timestamp,
                });
                send_message(stream, &pong, &mut stats).await?;
            }
            Message::Error(e) => {
                return Err(anyhow!("Peer error: {}", e.message));
            }
            other => {
                warn!("Unexpected message: {:?}", other.message_type());
            }
        }
    }

    Ok(finalize_stats(stats, start))
}

/// Send a protocol message
async fn send_message(stream: &mut IrohStream, msg: &Message, stats: &mut SyncStats) -> Result<()> {
    let data = msg.encode()?;
    stats.bytes_sent += data.len() as u64;
    stream.send(&data).await
}

/// Receive a protocol message
async fn recv_message(stream: &mut IrohStream, stats: &mut SyncStats) -> Result<Message> {
    let data = stream.recv().await?;
    stats.bytes_received += data.len() as u64;
    Message::decode(&data).map_err(|e| anyhow!("Decode error: {}", e))
}

/// Finalize stats with timing
fn finalize_stats(stats: SyncStats, _start: web_time::Instant) -> SyncStats {
    // TODO: Add timing statistics when needed
    stats
}

#[cfg(test)]
pub mod test_utils {
    use super::*;
    use tokio::sync::mpsc;

    /// Create a pair of connected in-memory streams for testing
    pub fn create_stream_pair() -> (TestStream, TestStream) {
        let (tx1, rx1) = mpsc::channel(32);
        let (tx2, rx2) = mpsc::channel(32);

        (
            TestStream { tx: tx1, rx: rx2 },
            TestStream { tx: tx2, rx: rx1 },
        )
    }

    /// Simple test stream using channels
    pub struct TestStream {
        tx: mpsc::Sender<Vec<u8>>,
        rx: mpsc::Receiver<Vec<u8>>,
    }

    impl TestStream {
        pub async fn send(&self, data: &[u8]) -> Result<()> {
            self.tx.send(data.to_vec()).await
                .map_err(|_| anyhow!("Channel closed"))
        }

        pub async fn recv(&mut self) -> Result<Vec<u8>> {
            self.rx.recv().await
                .ok_or_else(|| anyhow!("Channel closed"))
        }

        pub async fn send_message<T: serde::Serialize>(&self, msg: &T) -> Result<()> {
            let data = bincode::serialize(msg)?;
            self.send(&data).await
        }

        pub async fn recv_message<T: serde::de::DeserializeOwned>(&mut self) -> Result<T> {
            let data = self.recv().await?;
            let msg = bincode::deserialize(&data)?;
            Ok(msg)
        }
    }
}
