//! WASM Transport Implementation
//!
//! Implements the Transport trait using Iroh for WASM environments.
//! This consolidates the peervault-iroh crate into peervault-core.

use crate::sync_handler::{SyncHandler, PEERVAULT_SYNC_ALPN};
use crate::transport::{
    Connection, ConnectionStats, PeerAddress, Stream, Transport, TransportError, TransportResult,
};

use iroh::{Endpoint, RelayMap, RelayMode, RelayUrl, SecretKey, Watcher};
use iroh::protocol::Router;
use iroh_blobs::BlobsProtocol;
use iroh_blobs::store::mem::MemStore;
use iroh_tickets::{endpoint::EndpointTicket, Ticket as _};
use js_sys::{Promise, Uint8Array};
use std::sync::Arc;
use tokio::sync::Mutex;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

/// WASM Iroh Transport
///
/// Wraps an Iroh endpoint with Router for protocol multiplexing.
/// Handles both PeerVault sync ALPN and iroh-blobs ALPN.
#[wasm_bindgen]
pub struct WasmTransport {
    endpoint: Arc<Endpoint>,
    secret_key: SecretKey,
    node_id: String,
    /// Router keeps the accept loop alive and dispatches by ALPN
    _router: Router,
    /// Incoming sync connections from the SyncHandler
    incoming_rx: Arc<Mutex<tokio::sync::mpsc::Receiver<iroh::endpoint::Connection>>>,
}

// Rust-only API (not exposed to JS via wasm_bindgen)
impl WasmTransport {
    /// Create a new WASM transport with Router-based protocol multiplexing.
    ///
    /// # Arguments
    /// * `key_bytes` - Optional 32-byte secret key for identity persistence
    /// * `relay_url` - Optional relay server URL
    /// * `mem_store` - iroh-blobs MemStore for blob transfer protocol
    pub async fn create(
        key_bytes: Option<Vec<u8>>,
        relay_url: Option<String>,
        mem_store: MemStore,
    ) -> Result<WasmTransport, String> {
        let secret_key = match key_bytes {
            Some(bytes) => {
                let arr: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| "Invalid key: expected 32 bytes".to_string())?;
                SecretKey::from_bytes(&arr)
            }
            None => SecretKey::generate(&mut rand::rng()),
        };

        let relay_mode = match relay_url {
            Some(url) => {
                let relay: RelayUrl = url
                    .parse()
                    .map_err(|e| format!("Invalid relay URL: {}", e))?;
                RelayMode::Custom(RelayMap::from_iter(vec![relay]))
            }
            None => RelayMode::Default,
        };

        // Build endpoint without ALPNs — Router handles ALPN registration
        let endpoint = Endpoint::builder()
            .secret_key(secret_key.clone())
            .relay_mode(relay_mode)
            .bind()
            .await
            .map_err(|e| format!("Endpoint bind failed: {}", e))?;

        let node_id = endpoint.id().to_string();

        // Create protocol handlers
        let (sync_handler, incoming_rx) = SyncHandler::new(32);
        let blobs_protocol = BlobsProtocol::new(&mem_store, None);

        // Build and spawn Router (dispatches incoming connections by ALPN)
        let router = Router::builder(endpoint.clone())
            .accept(PEERVAULT_SYNC_ALPN, sync_handler)
            .accept(iroh_blobs::ALPN, blobs_protocol)
            .spawn();

        Ok(WasmTransport {
            endpoint: Arc::new(endpoint),
            secret_key,
            node_id,
            _router: router,
            incoming_rx: Arc::new(Mutex::new(incoming_rx)),
        })
    }
}

#[wasm_bindgen]
impl WasmTransport {
    /// Create a new WASM transport (JS-compatible constructor).
    #[wasm_bindgen(constructor)]
    pub async fn new(
        key_bytes: Option<Uint8Array>,
        relay_url: Option<String>,
    ) -> Result<WasmTransport, JsValue> {
        let key_vec = key_bytes.map(|b| b.to_vec());
        Self::create(key_vec, relay_url, MemStore::new())
            .await
            .map_err(|e| JsValue::from_str(&e))
    }

    /// Get this transport's node ID.
    #[wasm_bindgen(js_name = nodeId)]
    pub fn node_id_js(&self) -> String {
        self.node_id.clone()
    }

    /// Get the secret key bytes for persistence.
    #[wasm_bindgen(js_name = secretKeyBytes)]
    pub fn secret_key_bytes(&self) -> Uint8Array {
        Uint8Array::from(self.secret_key.to_bytes().as_slice())
    }

    /// Generate a connection ticket.
    #[wasm_bindgen(js_name = getTicket)]
    pub async fn get_ticket_js(&self) -> Result<String, JsValue> {
        self.endpoint.online().await;
        let endpoint_addr = self.endpoint.addr();
        let ticket = EndpointTicket::new(endpoint_addr);
        Ok(ticket.serialize())
    }

    /// Connect to a peer using their ticket.
    #[wasm_bindgen(js_name = connect)]
    pub async fn connect_js(&self, ticket: String) -> Result<WasmConnection, JsValue> {
        let endpoint_addr = Self::parse_ticket_internal(&ticket)?;
        let remote_node_id = endpoint_addr.id.to_string();

        let connection = self
            .endpoint
            .connect(endpoint_addr, PEERVAULT_SYNC_ALPN)
            .await
            .map_err(|e| JsValue::from_str(&format!("Connection failed: {}", e)))?;

        Ok(WasmConnection {
            connection,
            remote_node_id,
            endpoint: Arc::clone(&self.endpoint),
        })
    }

    /// Accept an incoming sync connection (dispatched by Router).
    #[wasm_bindgen(js_name = accept)]
    pub async fn accept_js(&self) -> Result<WasmConnection, JsValue> {
        let mut rx = self.incoming_rx.lock().await;
        let connection = rx
            .recv()
            .await
            .ok_or_else(|| JsValue::from_str("Sync handler channel closed"))?;

        let remote_node_id = connection.remote_id().to_string();

        Ok(WasmConnection {
            connection,
            remote_node_id,
            endpoint: Arc::clone(&self.endpoint),
        })
    }

    /// Close the transport.
    #[wasm_bindgen]
    pub async fn close(&self) -> Result<(), JsValue> {
        self.endpoint.close().await;
        Ok(())
    }

    fn parse_ticket_internal(
        ticket: &str,
    ) -> Result<iroh::EndpointAddr, JsValue> {
        let ticket = ticket.trim();

        // Try base32 format first
        if ticket.starts_with("endpoint") {
            return EndpointTicket::deserialize(ticket)
                .map(|t| t.endpoint_addr().clone())
                .map_err(|e| JsValue::from_str(&format!("Invalid ticket: {}", e)));
        }

        // Try JSON format
        if ticket.starts_with('{') {
            return serde_json::from_str(ticket)
                .map_err(|e| JsValue::from_str(&format!("Invalid JSON ticket: {}", e)));
        }

        // Try both
        if let Ok(t) = EndpointTicket::deserialize(ticket) {
            return Ok(t.endpoint_addr().clone());
        }

        serde_json::from_str(ticket)
            .map_err(|_| JsValue::from_str("Invalid ticket format"))
    }
}

// Implement the Transport trait for native Rust usage
impl Transport for WasmTransport {
    type Connection = WasmConnection;

    fn node_id(&self) -> String {
        self.node_id.clone()
    }

    fn get_ticket(&self) -> String {
        // This is sync but needs async - return cached or empty
        // For proper usage, call get_ticket_js() async method
        String::new()
    }

    fn connect(&self, peer: &PeerAddress) -> TransportResult<Self::Connection> {
        let ticket = peer.ticket.clone().unwrap_or_default();
        let endpoint = Arc::clone(&self.endpoint);

        Box::pin(async move {
            let endpoint_addr = Self::parse_ticket_internal(&ticket)
                .map_err(|e| TransportError::InvalidTicket(format!("{:?}", e)))?;
            let remote_node_id = endpoint_addr.id.to_string();

            let connection = endpoint
                .connect(endpoint_addr, PEERVAULT_SYNC_ALPN)
                .await
                .map_err(|e| TransportError::ConnectionFailed(e.to_string()))?;

            Ok(WasmConnection {
                connection,
                remote_node_id,
                endpoint,
            })
        })
    }

    fn accept(&self) -> TransportResult<Self::Connection> {
        let endpoint = Arc::clone(&self.endpoint);
        let incoming_rx = Arc::clone(&self.incoming_rx);

        Box::pin(async move {
            let mut rx = incoming_rx.lock().await;
            let connection = rx
                .recv()
                .await
                .ok_or(TransportError::ConnectionClosed)?;

            let remote_node_id = connection.remote_id().to_string();

            Ok(WasmConnection {
                connection,
                remote_node_id,
                endpoint,
            })
        })
    }

    fn parse_ticket(&self, ticket: &str) -> Result<PeerAddress, TransportError> {
        let endpoint_addr = Self::parse_ticket_internal(ticket)
            .map_err(|e| TransportError::InvalidTicket(format!("{:?}", e)))?;

        Ok(PeerAddress {
            peer_id: endpoint_addr.id.to_string(),
            ticket: Some(ticket.to_string()),
            relay_addrs: endpoint_addr
                .relay_urls()
                .map(|r| r.to_string())
                .collect(),
            direct_addrs: endpoint_addr
                .ip_addrs()
                .map(|a| a.to_string())
                .collect(),
        })
    }
}

/// WASM Connection wrapper
#[wasm_bindgen]
pub struct WasmConnection {
    connection: iroh::endpoint::Connection,
    remote_node_id: String,
    endpoint: Arc<Endpoint>,
}

#[wasm_bindgen]
impl WasmConnection {
    /// Get the remote peer's node ID.
    #[wasm_bindgen(js_name = remoteNodeId)]
    pub fn remote_node_id_js(&self) -> String {
        self.remote_node_id.clone()
    }

    /// Open a new bidirectional stream.
    #[wasm_bindgen(js_name = openStream)]
    pub fn open_stream_js(&self) -> Promise {
        let conn = self.connection.clone();
        future_to_promise(async move {
            let (send, recv) = conn
                .open_bi()
                .await
                .map_err(|e| JsValue::from_str(&format!("Stream open failed: {}", e)))?;

            Ok(JsValue::from(WasmStream {
                send: Arc::new(Mutex::new(send)),
                recv: Arc::new(Mutex::new(recv)),
                id: format!("{}", rand::random::<u32>()),
            }))
        })
    }

    /// Accept an incoming stream.
    #[wasm_bindgen(js_name = acceptStream)]
    pub fn accept_stream_js(&self) -> Promise {
        let conn = self.connection.clone();
        future_to_promise(async move {
            let (send, recv) = conn
                .accept_bi()
                .await
                .map_err(|e| JsValue::from_str(&format!("Stream accept failed: {}", e)))?;

            Ok(JsValue::from(WasmStream {
                send: Arc::new(Mutex::new(send)),
                recv: Arc::new(Mutex::new(recv)),
                id: format!("{}", rand::random::<u32>()),
            }))
        })
    }

    /// Get RTT in milliseconds.
    #[wasm_bindgen(js_name = getRttMs)]
    pub fn get_rtt_ms(&self) -> f64 {
        self.connection.rtt().as_secs_f64() * 1000.0
    }

    /// Get connection type.
    #[wasm_bindgen(js_name = getConnectionType)]
    pub fn get_connection_type(&self) -> String {
        use iroh::endpoint::ConnectionType;

        let remote_id = self.connection.remote_id();
        match self.endpoint.conn_type(remote_id) {
            Some(mut watcher) => match Watcher::get(&mut watcher) {
                ConnectionType::Direct(_) => "direct".to_string(),
                ConnectionType::Relay(_) => "relay".to_string(),
                ConnectionType::Mixed(_, _) => "mixed".to_string(),
                ConnectionType::None => "none".to_string(),
            },
            None => "none".to_string(),
        }
    }

    /// Close the connection.
    #[wasm_bindgen]
    pub async fn close(&self) -> Result<(), JsValue> {
        self.connection.close(0u32.into(), b"close");
        Ok(())
    }
}

// Implement Connection trait
impl Connection for WasmConnection {
    type Stream = WasmStream;

    fn peer_id(&self) -> String {
        self.remote_node_id.clone()
    }

    fn open_stream(&self, _protocol: &str) -> TransportResult<Self::Stream> {
        let conn = self.connection.clone();
        Box::pin(async move {
            let (send, recv) = conn
                .open_bi()
                .await
                .map_err(|e| TransportError::IoError(e.to_string()))?;

            Ok(WasmStream {
                send: Arc::new(Mutex::new(send)),
                recv: Arc::new(Mutex::new(recv)),
                id: format!("{}", rand::random::<u32>()),
            })
        })
    }

    fn accept_stream(&self) -> TransportResult<(String, Self::Stream)> {
        let conn = self.connection.clone();
        Box::pin(async move {
            let (send, recv) = conn
                .accept_bi()
                .await
                .map_err(|e| TransportError::IoError(e.to_string()))?;

            Ok((
                "sync".to_string(),
                WasmStream {
                    send: Arc::new(Mutex::new(send)),
                    recv: Arc::new(Mutex::new(recv)),
                    id: format!("{}", rand::random::<u32>()),
                },
            ))
        })
    }

    fn close(&self) -> TransportResult<()> {
        self.connection.close(0u32.into(), b"close");
        Box::pin(async { Ok(()) })
    }

    fn is_alive(&self) -> bool {
        true
    }

    fn stats(&self) -> ConnectionStats {
        ConnectionStats {
            rtt_ms: Some(self.connection.rtt().as_millis() as u32),
            is_relayed: self.get_connection_type() == "relay",
            ..Default::default()
        }
    }
}

/// WASM Stream wrapper
#[wasm_bindgen]
pub struct WasmStream {
    send: Arc<Mutex<iroh::endpoint::SendStream>>,
    recv: Arc<Mutex<iroh::endpoint::RecvStream>>,
    id: String,
}

#[wasm_bindgen]
impl WasmStream {
    /// Send data (length-prefixed).
    #[wasm_bindgen]
    pub async fn send(&self, data: Uint8Array) -> Result<(), JsValue> {
        let bytes: Vec<u8> = data.to_vec();
        let mut send = self.send.lock().await;

        // Write length prefix (4 bytes, big-endian)
        let len = (bytes.len() as u32).to_be_bytes();
        send.write_all(&len)
            .await
            .map_err(|e| JsValue::from_str(&format!("Write length failed: {}", e)))?;

        // Write data
        send.write_all(&bytes)
            .await
            .map_err(|e| JsValue::from_str(&format!("Write data failed: {}", e)))?;

        Ok(())
    }

    /// Receive data (length-prefixed).
    #[wasm_bindgen]
    pub async fn receive(&self) -> Result<Uint8Array, JsValue> {
        let mut recv = self.recv.lock().await;

        // Read length prefix
        let mut len_buf = [0u8; 4];
        recv.read_exact(&mut len_buf)
            .await
            .map_err(|e| JsValue::from_str(&format!("Read length failed: {}", e)))?;
        let len = u32::from_be_bytes(len_buf) as usize;

        // Validate length (max 64MB)
        if len > 64 * 1024 * 1024 {
            return Err(JsValue::from_str("Message too large"));
        }

        // Read the data in bounded chunks so a forged length prefix cannot make us
        // pre-allocate a huge buffer before any payload arrives.
        let mut data = Vec::new();
        let mut remaining = len;
        let mut buf = [0u8; 64 * 1024];
        while remaining > 0 {
            let n = remaining.min(buf.len());
            recv.read_exact(&mut buf[..n])
                .await
                .map_err(|e| JsValue::from_str(&format!("Read data failed: {}", e)))?;
            data.extend_from_slice(&buf[..n]);
            remaining -= n;
        }

        Ok(Uint8Array::from(data.as_slice()))
    }

    /// Close the stream.
    #[wasm_bindgen]
    pub async fn close(&self) -> Result<(), JsValue> {
        let mut send = self.send.lock().await;
        send.finish()
            .map_err(|e| JsValue::from_str(&format!("Finish failed: {}", e)))?;
        Ok(())
    }
}

// Implement Stream trait
impl Stream for WasmStream {
    fn id(&self) -> String {
        self.id.clone()
    }

    fn send(&self, data: &[u8]) -> TransportResult<()> {
        let send = Arc::clone(&self.send);
        let data = data.to_vec();

        Box::pin(async move {
            let mut send = send.lock().await;

            // Write length prefix
            let len = (data.len() as u32).to_be_bytes();
            send.write_all(&len)
                .await
                .map_err(|e| TransportError::IoError(e.to_string()))?;

            // Write data
            send.write_all(&data)
                .await
                .map_err(|e| TransportError::IoError(e.to_string()))?;

            Ok(())
        })
    }

    fn recv(&self) -> TransportResult<Vec<u8>> {
        let recv = Arc::clone(&self.recv);

        Box::pin(async move {
            let mut recv = recv.lock().await;

            // Read length prefix
            let mut len_buf = [0u8; 4];
            recv.read_exact(&mut len_buf)
                .await
                .map_err(|e| TransportError::IoError(e.to_string()))?;
            let len = u32::from_be_bytes(len_buf) as usize;

            if len > 64 * 1024 * 1024 {
                return Err(TransportError::ProtocolError("Message too large".into()));
            }

            // Read the data in bounded chunks so a forged length prefix cannot make
            // us pre-allocate a huge buffer before any payload arrives.
            let mut data = Vec::new();
            let mut remaining = len;
            let mut buf = [0u8; 64 * 1024];
            while remaining > 0 {
                let n = remaining.min(buf.len());
                recv.read_exact(&mut buf[..n])
                    .await
                    .map_err(|e| TransportError::IoError(e.to_string()))?;
                data.extend_from_slice(&buf[..n]);
                remaining -= n;
            }

            Ok(data)
        })
    }

    fn recv_timeout(&self, _timeout_ms: u64) -> TransportResult<Vec<u8>> {
        // TODO: Implement proper timeout
        self.recv()
    }

    fn close(&self) -> TransportResult<()> {
        let send = Arc::clone(&self.send);

        Box::pin(async move {
            let mut send = send.lock().await;
            send.finish()
                .map_err(|e| TransportError::IoError(e.to_string()))?;
            Ok(())
        })
    }
}
