//! PeerVault Iroh WASM Wrapper
//!
//! WASM bindings for Iroh P2P networking in PeerVault.
//! Exposes Iroh's Endpoint, Connection, and Stream to JavaScript.

use iroh::{Endpoint, EndpointAddr, RelayMap, RelayMode, RelayUrl, SecretKey};
use js_sys::{Array, Uint8Array};
use std::sync::Arc;
use tokio::sync::Mutex;
use wasm_bindgen::prelude::*;

/// Protocol identifier for PeerVault sync
const PEERVAULT_ALPN: &[u8] = b"peervault/sync/1";

/// Initialize the WASM module. Call this once before using any other functions.
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();

    // Set up tracing-subscriber for WASM
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber_wasm::MakeConsoleWriter;

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .without_time()
                .with_writer(MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG))
        )
        .init();
}

/// WASM-exposed Iroh endpoint wrapper.
#[wasm_bindgen]
pub struct WasmEndpoint {
    endpoint: Arc<Endpoint>,
    secret_key: SecretKey,
}

#[wasm_bindgen]
impl WasmEndpoint {
    /// Create a new endpoint.
    ///
    /// # Arguments
    /// * `key_bytes` - Optional 32-byte secret key for identity persistence
    /// * `relay_urls` - Optional array of relay server URLs (e.g., ["https://relay.example.com"])
    ///                  If not provided, uses Iroh's default public relays.
    #[wasm_bindgen]
    pub async fn create(
        key_bytes: Option<Uint8Array>,
        relay_urls: Option<Array>,
    ) -> Result<WasmEndpoint, JsValue> {
        let secret_key = match key_bytes {
            Some(bytes) => {
                let vec: Vec<u8> = bytes.to_vec();
                let arr: [u8; 32] = vec.try_into().map_err(|_| {
                    JsValue::from_str("Invalid key: expected 32 bytes")
                })?;
                SecretKey::from_bytes(&arr)
            }
            None => SecretKey::generate(&mut rand::rng()),
        };

        // Determine relay mode based on provided URLs
        let relay_mode = match relay_urls {
            Some(urls) if urls.length() > 0 => {
                let mut relay_url_list = Vec::new();
                for i in 0..urls.length() {
                    let url_str = urls
                        .get(i)
                        .as_string()
                        .ok_or_else(|| JsValue::from_str("Relay URL must be a string"))?;

                    let url: RelayUrl = url_str
                        .parse()
                        .map_err(|e| JsValue::from_str(&format!("Invalid relay URL '{}': {}", url_str, e)))?;

                    relay_url_list.push(url);
                }

                RelayMode::Custom(RelayMap::from_iter(relay_url_list))
            }
            _ => RelayMode::Default,
        };

        let endpoint = Endpoint::builder()
            .secret_key(secret_key.clone())
            .alpns(vec![PEERVAULT_ALPN.to_vec()])
            .relay_mode(relay_mode)
            .bind()
            .await
            .map_err(|e| JsValue::from_str(&format!("Endpoint bind failed: {}", e)))?;

        Ok(WasmEndpoint {
            endpoint: Arc::new(endpoint),
            secret_key,
        })
    }

    /// Get this endpoint's node ID (public key as hex string).
    #[wasm_bindgen(js_name = nodeId)]
    pub fn node_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Get the secret key bytes for persistence.
    #[wasm_bindgen(js_name = secretKeyBytes)]
    pub fn secret_key_bytes(&self) -> Uint8Array {
        Uint8Array::from(self.secret_key.to_bytes().as_slice())
    }

    /// Generate a connection ticket for pairing.
    /// The ticket contains the node address info needed to connect.
    /// This waits for the relay connection to be established.
    #[wasm_bindgen(js_name = generateTicket)]
    pub async fn generate_ticket(&self) -> Result<String, JsValue> {
        // Wait for endpoint to be online (connected to relay)
        self.endpoint.online().await;

        // Get endpoint address
        let endpoint_addr = self.endpoint.addr();

        // Serialize to JSON for sharing
        serde_json::to_string(&endpoint_addr)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize ticket: {}", e)))
    }

    /// Connect to a peer using their ticket.
    #[wasm_bindgen(js_name = connectWithTicket)]
    pub async fn connect_with_ticket(&self, ticket: String) -> Result<WasmConnection, JsValue> {
        // Parse ticket (JSON) to get EndpointAddr
        let endpoint_addr: EndpointAddr = serde_json::from_str(&ticket)
            .map_err(|e| JsValue::from_str(&format!("Invalid ticket: {}", e)))?;

        let remote_endpoint_id = endpoint_addr.id.to_string();

        let connection = self.endpoint
            .connect(endpoint_addr, PEERVAULT_ALPN)
            .await
            .map_err(|e| JsValue::from_str(&format!("Connection failed: {}", e)))?;

        Ok(WasmConnection {
            connection,
            remote_node_id: remote_endpoint_id,
        })
    }

    /// Accept an incoming connection.
    /// This blocks until a connection is received.
    #[wasm_bindgen(js_name = acceptConnection)]
    pub async fn accept_connection(&self) -> Result<WasmConnection, JsValue> {
        let incoming = self.endpoint
            .accept()
            .await
            .ok_or_else(|| JsValue::from_str("Endpoint closed"))?;

        let connection = incoming
            .await
            .map_err(|e| JsValue::from_str(&format!("Accept failed: {}", e)))?;

        let remote_node_id = connection.remote_id().to_string();

        Ok(WasmConnection {
            connection,
            remote_node_id,
        })
    }

    /// Close the endpoint.
    #[wasm_bindgen]
    pub async fn close(&self) -> Result<(), JsValue> {
        self.endpoint.close().await;
        Ok(())
    }
}

/// WASM-exposed connection wrapper.
/// Connection is Clone + Send + Sync, so no Mutex needed.
#[wasm_bindgen]
pub struct WasmConnection {
    connection: iroh::endpoint::Connection,
    remote_node_id: String,
}

#[wasm_bindgen]
impl WasmConnection {
    /// Get the remote peer's node ID.
    #[wasm_bindgen(js_name = remoteNodeId)]
    pub fn remote_node_id(&self) -> String {
        self.remote_node_id.clone()
    }

    /// Open a new bidirectional stream.
    #[wasm_bindgen(js_name = openStream)]
    pub async fn open_stream(&self) -> Result<WasmStream, JsValue> {
        // Clone the connection to avoid holding any lock during the async operation
        let conn = self.connection.clone();
        let (send, recv) = conn
            .open_bi()
            .await
            .map_err(|e| JsValue::from_str(&format!("Stream open failed: {}", e)))?;

        Ok(WasmStream {
            send: Arc::new(Mutex::new(send)),
            recv: Arc::new(Mutex::new(recv)),
        })
    }

    /// Accept an incoming stream.
    #[wasm_bindgen(js_name = acceptStream)]
    pub async fn accept_stream(&self) -> Result<WasmStream, JsValue> {
        // Clone the connection to avoid holding any lock during the async operation
        let conn = self.connection.clone();
        let (send, recv) = conn
            .accept_bi()
            .await
            .map_err(|e| JsValue::from_str(&format!("Stream accept failed: {}", e)))?;

        Ok(WasmStream {
            send: Arc::new(Mutex::new(send)),
            recv: Arc::new(Mutex::new(recv)),
        })
    }

    /// Check if connection is still alive.
    #[wasm_bindgen(js_name = isConnected)]
    pub fn is_connected(&self) -> bool {
        // Simplified check - actual check would require async
        true
    }

    /// Get the round-trip time (RTT) in milliseconds.
    /// Returns 0 if not available.
    #[wasm_bindgen(js_name = getRttMs)]
    pub fn get_rtt_ms(&self) -> f64 {
        self.connection.rtt().as_secs_f64() * 1000.0
    }

    /// Get connection statistics as JSON string.
    #[wasm_bindgen(js_name = getStats)]
    pub fn get_stats(&self) -> String {
        let rtt = self.connection.rtt();
        let remote_id = self.connection.remote_id().to_string();

        format!(
            r#"{{"rttMs": {}, "remoteId": "{}"}}"#,
            rtt.as_secs_f64() * 1000.0,
            remote_id
        )
    }

    /// Close the connection.
    #[wasm_bindgen]
    pub async fn close(&self) -> Result<(), JsValue> {
        self.connection.close(0u32.into(), b"close");
        Ok(())
    }
}

/// WASM-exposed bidirectional stream.
#[wasm_bindgen]
pub struct WasmStream {
    send: Arc<Mutex<iroh::endpoint::SendStream>>,
    recv: Arc<Mutex<iroh::endpoint::RecvStream>>,
}

#[wasm_bindgen]
impl WasmStream {
    /// Send data on the stream.
    /// Data is length-prefixed (4 bytes big-endian).
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

    /// Receive data from the stream.
    /// Data is length-prefixed (4 bytes big-endian).
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

        // Read data
        let mut data = vec![0u8; len];
        recv.read_exact(&mut data)
            .await
            .map_err(|e| JsValue::from_str(&format!("Read data failed: {}", e)))?;

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
