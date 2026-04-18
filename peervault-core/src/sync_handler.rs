//! Sync Protocol Handler
//!
//! Implements `iroh::protocol::ProtocolHandler` for PeerVault's sync ALPN.
//! Incoming sync connections are queued to a channel for the accept loop to consume.

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use tokio::sync::mpsc;

/// ALPN protocol identifier for PeerVault sync
pub const PEERVAULT_SYNC_ALPN: &[u8] = b"peervault/sync/1";

/// Protocol handler that queues incoming sync connections
#[derive(Debug, Clone)]
pub struct SyncHandler {
    incoming_tx: mpsc::Sender<Connection>,
}

impl SyncHandler {
    /// Create a new sync handler with a channel for incoming connections
    pub fn new(buffer: usize) -> (Self, mpsc::Receiver<Connection>) {
        let (tx, rx) = mpsc::channel(buffer);
        (Self { incoming_tx: tx }, rx)
    }
}

impl ProtocolHandler for SyncHandler {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        self.incoming_tx
            .send(connection)
            .await
            .map_err(|e| AcceptError::from_err(e))?;
        // Don't return — keep this task alive so the connection isn't dropped.
        // The receiver will handle the connection and eventually close it.
        // We use a future that never resolves; the Router will abort it on shutdown.
        std::future::pending::<()>().await;
        Ok(())
    }
}
