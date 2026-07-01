//! Iroh Transport Layer
//!
//! Provides P2P networking using Iroh's QUIC-based transport with
//! automatic relay fallback and NAT traversal.

use crate::net::peer::{PeerId, Ticket};
use crate::sync_handler::{SyncHandler, PEERVAULT_SYNC_ALPN};
use anyhow::{anyhow, Result};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::protocol::Router;
use iroh::{Endpoint, EndpointAddr, RelayMap, RelayMode, RelayUrl, SecretKey};
use iroh_blobs::store::mem::MemStore;
use iroh_blobs::BlobsProtocol;
use iroh_gossip::net::Gossip;
use tokio::sync::Mutex;
use std::sync::Arc;
use tracing::{debug, info, warn, error, trace};

// WASM logging support
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
use wasm_bindgen::JsValue;
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
use web_sys;

/// Re-export for backward compatibility
pub const PEERVAULT_ALPN: &[u8] = PEERVAULT_SYNC_ALPN;

/// Default Iroh relay URL
pub const DEFAULT_RELAY_URL: &str = "https://use1-1.relay.n0.computer";

/// Iroh-based P2P transport
///
/// Manages the Iroh endpoint with Router for protocol multiplexing.
/// Handles both PeerVault sync ALPN and iroh-blobs ALPN.
pub struct IrohTransport {
    /// The Iroh endpoint
    endpoint: Endpoint,
    /// Our secret key
    secret_key: SecretKey,
    /// Router keeps the accept loop alive and dispatches by ALPN
    _router: Router,
    /// Incoming sync connections from the SyncHandler
    incoming_rx: Arc<Mutex<tokio::sync::mpsc::Receiver<Connection>>>,
}

impl IrohTransport {
    /// Create a new transport with a random secret key and default relay
    pub async fn new() -> Result<Self> {
        Self::with_relay(None).await
    }

    /// Create a new transport with a specific relay URL
    pub async fn with_relay(relay_url: Option<&str>) -> Result<Self> {
        let secret_key = SecretKey::generate(&mut rand::rng());
        Self::with_secret_key_and_relay(secret_key, relay_url).await
    }

    /// Create a new transport with a specific secret key
    pub async fn with_secret_key(secret_key: SecretKey) -> Result<Self> {
        Self::with_secret_key_and_relay(secret_key, None).await
    }

    /// Create a new transport with a specific secret key and relay URL
    pub async fn with_secret_key_and_relay(secret_key: SecretKey, relay_url: Option<&str>) -> Result<Self> {
        // Create a temporary endpoint to get the gossip instance
        // Note: for full functionality, use with_all_protocols() directly
        let mem_store = MemStore::new();
        // We need the endpoint to create Gossip, but the endpoint is created inside
        // with_all_protocols. Create a placeholder Gossip with a temporary endpoint.
        // This is only used for backward-compat constructors that don't need gossip.
        Self::with_secret_key_relay_and_blobs(secret_key, relay_url, mem_store).await
    }

    /// Create a new transport with iroh-blobs MemStore (no gossip).
    /// For gossip support, use `from_endpoint` with a pre-created Gossip instance.
    pub async fn with_secret_key_relay_and_blobs(
        secret_key: SecretKey,
        relay_url: Option<&str>,
        mem_store: MemStore,
    ) -> Result<Self> {
        let relay_mode = match relay_url {
            Some(url) => {
                let relay: RelayUrl = url.parse()
                    .map_err(|e| anyhow!("Invalid relay URL '{}': {}", url, e))?;
                RelayMode::Custom(RelayMap::from_iter(vec![relay]))
            }
            None => {
                let relay: RelayUrl = DEFAULT_RELAY_URL.parse()
                    .map_err(|e| anyhow!("Invalid default relay URL: {}", e))?;
                RelayMode::Custom(RelayMap::from_iter(vec![relay]))
            }
        };

        let endpoint = Endpoint::builder()
            .secret_key(secret_key.clone())
            .relay_mode(relay_mode)
            .bind()
            .await?;

        let (sync_handler, incoming_rx) = SyncHandler::new(32);
        let blobs_protocol = BlobsProtocol::new(&mem_store, None);

        // No gossip — only sync + blobs
        let router = Router::builder(endpoint.clone())
            .accept(PEERVAULT_SYNC_ALPN, sync_handler)
            .accept(iroh_blobs::ALPN, blobs_protocol)
            .spawn();

        Ok(Self {
            endpoint,
            secret_key,
            _router: router,
            incoming_rx: Arc::new(Mutex::new(incoming_rx)),
        })
    }

    /// Create transport from a pre-built endpoint with all protocols.
    /// Use this when you need to share the Endpoint with GossipBridge.
    pub fn from_endpoint(
        endpoint: Endpoint,
        secret_key: SecretKey,
        mem_store: MemStore,
        gossip: Gossip,
    ) -> Self {
        info!(node_id = %endpoint.id(), "Transport started (from_endpoint)");

        let (sync_handler, incoming_rx) = SyncHandler::new(32);
        let blobs_protocol = BlobsProtocol::new(&mem_store, None);

        let router = Router::builder(endpoint.clone())
            .accept(PEERVAULT_SYNC_ALPN, sync_handler)
            .accept(iroh_blobs::ALPN, blobs_protocol)
            .accept(iroh_gossip::net::GOSSIP_ALPN, gossip)
            .spawn();

        Self {
            endpoint,
            secret_key,
            _router: router,
            incoming_rx: Arc::new(Mutex::new(incoming_rx)),
        }
    }

    /// Get the endpoint (for Downloader creation)
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Get our node ID
    pub fn node_id(&self) -> PeerId {
        PeerId::from(self.endpoint.id())
    }

    /// Get our secret key
    pub fn secret_key(&self) -> &SecretKey {
        &self.secret_key
    }

    /// Create a ticket for sharing with peers
    pub async fn create_ticket(&self) -> Result<Ticket> {
        // Wait for endpoint to be online (connected to relay)
        // This ensures the relay URL is available in the ticket
        self.endpoint.online().await;
        let node_addr = self.endpoint.addr();

        // Get relay URLs and fix trailing dot issue
        // Iroh's RelayUrl adds a trailing dot to hostnames (FQDN format)
        // but Docker DNS doesn't recognize it, so we strip it
        let relay_urls: Vec<String> = node_addr.relay_urls()
            .map(|url| {
                let s = url.to_string();
                // Fix URLs like "http://relay.:3340/" -> "http://relay:3340/"
                // The dot appears after the hostname but before the port
                s.replace(".:",":")
            })
            .collect();
        let relay_url = relay_urls.first().cloned();

        let addrs: Vec<String> = node_addr
            .ip_addrs()
            .map(|addr| addr.to_string())
            .collect();

        let mut ticket = Ticket::new(self.node_id());
        if let Some(url) = relay_url {
            ticket.relay_url = Some(url);
        }
        ticket.addrs = addrs;

        Ok(ticket)
    }

    /// Connect to a peer using their ticket
    pub async fn connect(&self, ticket: &Ticket) -> Result<IrohConnection> {
        #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
        web_sys::console::log_1(&JsValue::from_str(&format!(
            "[WASM] IrohTransport::connect - starting, ticket.relay_url={:?}",
            ticket.relay_url
        )));

        // Wait for our endpoint to be online (connected to relay)
        // This is needed before we can connect to other peers via relay
        self.endpoint.online().await;

        #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
        web_sys::console::log_1(&JsValue::from_str("[WASM] IrohTransport::connect - endpoint is online"));

        let node_addr = self.ticket_to_endpoint_addr(ticket)?;

        #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
        web_sys::console::log_1(&JsValue::from_str("[WASM] IrohTransport::connect - got endpoint addr, calling iroh connect"));

        info!(
            peer_id = %ticket.node_id,
            relay = ?ticket.relay_url,
            addrs = ?ticket.addrs,
            "Connecting to peer"
        );

        let connection = match self.endpoint.connect(node_addr, PEERVAULT_SYNC_ALPN).await {
            Ok(conn) => {
                info!(peer_id = %ticket.node_id, "Successfully connected to peer");
                conn
            }
            Err(e) => {
                error!(
                    peer_id = %ticket.node_id,
                    error = %e,
                    "Failed to connect to peer"
                );
                return Err(e.into());
            }
        };

        Ok(IrohConnection::new(connection, ticket.node_id))
    }

    /// Accept incoming sync connections (dispatched by Router)
    pub async fn accept(&self) -> Result<IrohConnection> {
        trace!("Waiting for incoming sync connection...");

        let mut rx = self.incoming_rx.lock().await;
        let connection = rx
            .recv()
            .await
            .ok_or_else(|| {
                warn!("Sync handler channel closed");
                anyhow!("Sync handler channel closed")
            })?;

        let peer_id = PeerId::from(connection.remote_id());
        info!(peer_id = %peer_id, "Accepted sync connection from peer");

        Ok(IrohConnection::new(connection, peer_id))
    }

    /// Convert a ticket to EndpointAddr for connection
    fn ticket_to_endpoint_addr(&self, ticket: &Ticket) -> Result<EndpointAddr> {
        let endpoint_id = ticket.node_id.0;

        let mut addr = EndpointAddr::new(endpoint_id);

        #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
        web_sys::console::log_1(&JsValue::from_str(&format!(
            "[WASM] ticket_to_endpoint_addr: node_id={}, relay_url={:?}, addrs={:?}",
            ticket.node_id, ticket.relay_url, ticket.addrs
        )));

        // Add relay URL if available
        if let Some(ref relay_url) = ticket.relay_url {
            let url: iroh::RelayUrl = relay_url.parse()?;
            #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
            web_sys::console::log_1(&JsValue::from_str(&format!(
                "[WASM] Adding relay URL: {}", url
            )));
            addr = addr.with_relay_url(url);
        }

        // Add direct addresses if available
        for addr_str in &ticket.addrs {
            if let Ok(socket_addr) = addr_str.parse() {
                addr = addr.with_ip_addr(socket_addr);
            }
        }

        // Log final address state
        #[cfg(all(target_arch = "wasm32", feature = "wasm"))]
        web_sys::console::log_1(&JsValue::from_str(&format!(
            "[WASM] Final EndpointAddr: has_relay={}, direct_addrs={}",
            addr.relay_urls().next().is_some(),
            addr.ip_addrs().count()
        )));

        Ok(addr)
    }

    /// Close the transport
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// A connection to a peer
pub struct IrohConnection {
    /// The underlying QUIC connection
    connection: Connection,
    /// The peer's ID
    peer_id: PeerId,
}

impl IrohConnection {
    /// Create a new connection wrapper
    pub fn new(connection: Connection, peer_id: PeerId) -> Self {
        Self { connection, peer_id }
    }

    /// Get the peer's ID
    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    /// Open a new bidirectional stream
    pub async fn open_stream(&self) -> Result<IrohStream> {
        trace!(peer_id = %self.peer_id, "Opening bidirectional stream...");

        match self.connection.open_bi().await {
            Ok((send, recv)) => {
                debug!(peer_id = %self.peer_id, "Opened stream to peer");
                Ok(IrohStream::new(send, recv))
            }
            Err(e) => {
                error!(peer_id = %self.peer_id, error = %e, "Failed to open stream");
                Err(e.into())
            }
        }
    }

    /// Accept an incoming bidirectional stream
    pub async fn accept_stream(&self) -> Result<IrohStream> {
        trace!(peer_id = %self.peer_id, "Waiting for incoming stream...");

        match self.connection.accept_bi().await {
            Ok((send, recv)) => {
                debug!(peer_id = %self.peer_id, "Accepted stream from peer");
                Ok(IrohStream::new(send, recv))
            }
            Err(e) => {
                error!(peer_id = %self.peer_id, error = %e, "Failed to accept stream");
                Err(e.into())
            }
        }
    }

    /// Check if the connection is still alive
    pub fn is_closed(&self) -> bool {
        let closed = self.connection.close_reason().is_some();
        if closed {
            trace!(peer_id = %self.peer_id, "Connection is closed");
        }
        closed
    }

    /// Close the connection
    pub fn close(&self) {
        info!(peer_id = %self.peer_id, "Closing connection");
        self.connection.close(0u32.into(), b"closed");
    }
}

/// A bidirectional stream for sync communication
pub struct IrohStream {
    /// Send half of the stream
    send: SendStream,
    /// Receive half of the stream
    recv: RecvStream,
}

impl IrohStream {
    /// Create a new stream wrapper
    pub fn new(send: SendStream, recv: RecvStream) -> Self {
        Self { send, recv }
    }

    /// Send data on the stream
    pub async fn send(&mut self, data: &[u8]) -> Result<()> {
        trace!(bytes = data.len(), "Sending data on stream");

        // Write length prefix (4 bytes, big endian)
        let len = data.len() as u32;
        self.send.write_all(&len.to_be_bytes()).await?;
        // Write the data
        self.send.write_all(data).await?;

        trace!(bytes = data.len(), "Data sent successfully");
        Ok(())
    }

    /// Receive data from the stream
    pub async fn recv(&mut self) -> Result<Vec<u8>> {
        trace!("Receiving data from stream...");

        // Read length prefix
        let mut len_buf = [0u8; 4];
        self.recv.read_exact(&mut len_buf).await?;
        let len = u32::from_be_bytes(len_buf) as usize;

        // Sanity check on length (max 64MB per message)
        if len > 64 * 1024 * 1024 {
            error!(bytes = len, "Message too large");
            return Err(anyhow!("Message too large: {} bytes", len));
        }

        // Read the data in bounded chunks. This avoids pre-allocating a buffer the
        // size of the (attacker-controlled) length prefix before any payload arrives:
        // memory grows only with bytes actually received.
        let mut data = Vec::new();
        let mut remaining = len;
        let mut buf = [0u8; 64 * 1024];
        while remaining > 0 {
            let n = remaining.min(buf.len());
            self.recv.read_exact(&mut buf[..n]).await?;
            data.extend_from_slice(&buf[..n]);
            remaining -= n;
        }

        trace!(bytes = len, "Data received successfully");
        Ok(data)
    }

    /// Send a message (serialized with bincode)
    pub async fn send_message<T: serde::Serialize>(&mut self, msg: &T) -> Result<()> {
        let data = bincode::serialize(msg)?;
        self.send(&data).await
    }

    /// Receive a message (deserialized with bincode)
    pub async fn recv_message<T: serde::de::DeserializeOwned>(&mut self) -> Result<T> {
        let data = self.recv().await?;
        let msg = bincode::deserialize(&data)?;
        Ok(msg)
    }

    /// Finish sending (signal end of stream)
    pub async fn finish(&mut self) -> Result<()> {
        self.send.finish()?;
        Ok(())
    }

    /// Split into send and receive halves
    pub fn split(self) -> (SendStream, RecvStream) {
        (self.send, self.recv)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "creates a real iroh endpoint + relay connection; needs network. Run with --ignored."]
    async fn test_transport_creation() {
        let transport = IrohTransport::new().await.unwrap();
        let node_id = transport.node_id();
        println!("Created transport with node ID: {}", node_id);
        transport.close().await;
    }

    #[tokio::test]
    #[ignore = "creates a real iroh endpoint + relay connection; needs network. Run with --ignored."]
    async fn test_ticket_creation() {
        let transport = IrohTransport::new().await.unwrap();
        let ticket = transport.create_ticket().await.unwrap();

        println!("Ticket: {}", ticket);
        println!("Node ID: {}", ticket.node_id);
        println!("Relay: {:?}", ticket.relay_url);
        println!("Addrs: {:?}", ticket.addrs);

        // Verify roundtrip
        let encoded = ticket.to_string();
        let decoded = Ticket::from_string(&encoded).unwrap();
        assert_eq!(ticket.node_id, decoded.node_id);

        transport.close().await;
    }
}
