//! WASM Bindings for PeerVault Core
//!
//! A thin wasm-bindgen shim over the host-agnostic engine in [`crate::vault`].
//! Every method here only marshals types (hex/`Uint8Array`/`Promise`/JSON) and
//! maps [`CoreError`] to a coded JS `Error`; all behaviour lives in
//! [`crate::vault::PeerVault`].

#![cfg(feature = "wasm")]

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
use js_sys::{Promise, Function, Uint8Array};

use crate::error::CoreError;
use crate::vault::PeerVault;

/// Initialize the WASM module (call once at startup)
#[wasm_bindgen(start)]
pub fn init() {
    // Set up better panic messages in browser console
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();

    // Initialize tracing to output to browser console
    init_tracing();
}

/// Initialize tracing subscriber for WASM
///
/// This routes all tracing::debug!, tracing::info!, etc. to the browser console.
fn init_tracing() {
    use tracing_subscriber::prelude::*;

    // NOTE: We explicitly avoid using any timer since std::time doesn't work in WASM
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)  // Browser console doesn't support ANSI colors
        .without_time()    // Critical: skip time since std::time panics in WASM
        .with_level(true)
        .with_target(true) // Show module paths
        .with_writer(tracing_subscriber_wasm::MakeConsoleWriter::default());

    // Use try_init to avoid panic if already initialized
    let _ = tracing_subscriber::registry()
        .with(fmt_layer)
        .with(tracing_subscriber::filter::LevelFilter::INFO)
        .try_init();
}

/// Set the logging level dynamically
///
/// Valid levels: "trace", "debug", "info", "warn", "error", "off"
#[wasm_bindgen(js_name = setLogLevel)]
pub fn set_log_level(level: &str) -> Result<(), JsValue> {
    web_sys::console::info_1(&JsValue::from_str(
        &format!("Log level hint: {}. Use browser console filtering for dynamic control.", level)
    ));
    Ok(())
}

/// Build a JS `Error` carrying a stable machine-readable `code` alongside the
/// human message, so the TypeScript layer can branch on the failure kind instead
/// of string-matching. Backward compatible: `.message` is unchanged; `.code` is
/// additive.
fn js_error(code: &str, message: &str) -> JsValue {
    let err = js_sys::Error::new(message);
    let _ = js_sys::Reflect::set(&err, &JsValue::from_str("code"), &JsValue::from_str(code));
    err.into()
}

/// Map a `CoreError` to a coded JS error, preserving the actionable variants
/// (e.g. `KEY_CONFLICT`, `DELTA_TOO_LARGE`) that the plugin needs to distinguish.
fn core_err_to_js(e: CoreError) -> JsValue {
    let code = match &e {
        CoreError::KeyConflict { .. } => "KEY_CONFLICT",
        CoreError::DeltaTooLarge { .. } => "DELTA_TOO_LARGE",
        CoreError::Crypto(_) => "CRYPTO",
        CoreError::Timeout(_) => "TIMEOUT",
        CoreError::Protocol(_) => "PROTOCOL",
        CoreError::Crdt(_) => "CRDT",
        CoreError::Host(_) => "HOST",
        CoreError::Store(_) => "STORE",
        CoreError::Config(_) => "CONFIG",
        CoreError::Internal(_) => "INTERNAL",
    };
    js_error(code, &e.to_string())
}

fn bytes_to_js(data: Vec<u8>) -> JsValue {
    let arr = Uint8Array::new_with_length(data.len() as u32);
    arr.copy_from(&data);
    arr.into()
}

/// Main PeerVault instance for WASM
///
/// This is the primary interface for JavaScript code to interact with PeerVault.
#[wasm_bindgen]
pub struct WasmPeerVault {
    inner: PeerVault,
}

#[wasm_bindgen]
impl WasmPeerVault {
    /// Create a new PeerVault instance
    ///
    /// @param vault_id - 32-byte vault identifier (hex string)
    /// @param device_name - Human-readable device name
    #[wasm_bindgen(constructor)]
    pub fn new(vault_id: &str, device_name: &str) -> Result<WasmPeerVault, JsValue> {
        Ok(WasmPeerVault {
            inner: PeerVault::new(vault_id, device_name).map_err(core_err_to_js)?,
        })
    }

    /// Set the event callback (receives events as JSON strings)
    #[wasm_bindgen(js_name = setEventCallback)]
    pub fn set_event_callback(&mut self, callback: Function) {
        self.inner.set_event_callback(std::rc::Rc::new(move |event| {
            if let Ok(json) = serde_json::to_string(event) {
                let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&json));
            }
        }));
    }

    /// Set the storage change callback (receives exported state as Uint8Array)
    #[wasm_bindgen(js_name = setStorageCallback)]
    pub fn set_storage_callback(&mut self, callback: Function) {
        self.inner.set_storage_callback(std::rc::Rc::new(move |bytes: &[u8]| {
            let arr = Uint8Array::new_with_length(bytes.len() as u32);
            arr.copy_from(bytes);
            let _ = callback.call1(&JsValue::NULL, &arr);
        }));
    }

    #[wasm_bindgen(js_name = setRelayUrl)]
    pub fn set_relay_url(&mut self, url: &str) {
        self.inner.set_relay_url(url);
    }

    #[wasm_bindgen(js_name = getRelayUrl)]
    pub fn get_relay_url(&self) -> Option<String> {
        self.inner.get_relay_url()
    }

    #[wasm_bindgen(js_name = generateEncryptionKey)]
    pub fn generate_encryption_key(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.generate_encryption_key().await
                .map(|hex| JsValue::from_str(&hex))
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = setEncryptionKey)]
    pub fn set_encryption_key(&self, key_hex: &str) -> Promise {
        let inner = self.inner.clone();
        let key_hex = key_hex.to_string();
        future_to_promise(async move {
            inner.set_encryption_key(&key_hex).await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = deriveEncryptionKey)]
    pub fn derive_encryption_key(&self, passphrase: &str) -> Promise {
        let inner = self.inner.clone();
        let passphrase = passphrase.to_string();
        future_to_promise(async move {
            inner.derive_encryption_key(&passphrase).await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = hasEncryptionKey)]
    pub fn has_encryption_key(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.has_encryption_key().await
                .map(JsValue::from_bool)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = getEncryptionKey)]
    pub fn get_encryption_key(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.get_encryption_key().await
                .map(|opt| match opt {
                    Some(hex) => JsValue::from_str(&hex),
                    None => JsValue::NULL,
                })
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = clearEncryptionKey)]
    pub fn clear_encryption_key(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.clear_encryption_key().await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = encryptBlob)]
    pub fn encrypt_blob(&self, data: &Uint8Array) -> Promise {
        let inner = self.inner.clone();
        let data = data.to_vec();
        future_to_promise(async move {
            inner.encrypt_blob(&data).await
                .map(bytes_to_js)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = decryptBlob)]
    pub fn decrypt_blob(&self, encrypted_data: &Uint8Array) -> Promise {
        let inner = self.inner.clone();
        let data = encrypted_data.to_vec();
        future_to_promise(async move {
            inner.decrypt_blob(&data).await
                .map(bytes_to_js)
                .map_err(core_err_to_js)
        })
    }

    pub fn start(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.start().await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = startWithState)]
    pub fn start_with_state(&self, initial_state: &Uint8Array) -> Promise {
        let inner = self.inner.clone();
        let state = initial_state.to_vec();
        future_to_promise(async move {
            inner.start_with_state(&state).await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    pub fn stop(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.stop().await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = getTicket)]
    pub fn get_ticket(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.get_ticket().await
                .map(|t| JsValue::from_str(&t))
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = getNodeId)]
    pub fn get_node_id(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.get_node_id().await
                .map(|id| JsValue::from_str(&id))
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = registerPairingNonce)]
    pub fn register_pairing_nonce(&self, nonce: &str, expires_at_ms: f64) {
        self.inner.register_pairing_nonce(nonce, expires_at_ms as u64);
    }

    #[wasm_bindgen(js_name = validatePairingNonce)]
    pub fn validate_pairing_nonce(&self, nonce: &str) -> bool {
        self.inner.validate_pairing_nonce(nonce)
    }

    #[wasm_bindgen(js_name = isKnownPeer)]
    pub fn is_known_peer(&self, peer_id: &str) -> bool {
        self.inner.is_known_peer(peer_id)
    }

    #[wasm_bindgen(js_name = addKnownPeer)]
    pub fn add_known_peer(&self, peer_id: &str) {
        self.inner.add_known_peer(peer_id);
    }

    #[wasm_bindgen(js_name = removeKnownPeer)]
    pub fn remove_known_peer(&self, peer_id: &str) {
        self.inner.remove_known_peer(peer_id);
    }

    #[wasm_bindgen(js_name = getKnownPeers)]
    pub fn get_known_peers(&self) -> Vec<JsValue> {
        self.inner.get_known_peers().iter().map(|k| JsValue::from_str(k)).collect()
    }

    #[wasm_bindgen(js_name = connectPeer)]
    pub fn connect_peer(&self, ticket_str: &str) -> Promise {
        let inner = self.inner.clone();
        let ticket = ticket_str.to_string();
        future_to_promise(async move {
            inner.connect_peer(&ticket).await
                .map(|peer_id| JsValue::from_str(&peer_id))
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = connectPeerWithPairing)]
    pub fn connect_peer_with_pairing(
        &self,
        ticket_str: &str,
        pairing_nonce: JsValue,
        our_device_name: JsValue,
    ) -> Promise {
        let inner = self.inner.clone();
        let ticket = ticket_str.to_string();
        let nonce: Option<String> = if pairing_nonce.is_null() || pairing_nonce.is_undefined() {
            None
        } else {
            pairing_nonce.as_string()
        };
        let device_name: Option<String> = if our_device_name.is_null() || our_device_name.is_undefined() {
            None
        } else {
            our_device_name.as_string()
        };
        future_to_promise(async move {
            inner.connect_peer_with_pairing(&ticket, nonce, device_name).await
                .map(|peer_id| JsValue::from_str(&peer_id))
                .map_err(core_err_to_js)
        })
    }

    pub fn set(&self, key: &str, content: &Uint8Array) -> Promise {
        let inner = self.inner.clone();
        let key = key.to_string();
        let content = content.to_vec();
        future_to_promise(async move {
            inner.set(&key, &content).await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    pub fn get(&self, key: &str) -> Promise {
        let inner = self.inner.clone();
        let key = key.to_string();
        future_to_promise(async move {
            inner.get(&key).await
                .map(|opt| match opt {
                    Some(bytes) => bytes_to_js(bytes),
                    None => JsValue::NULL,
                })
                .map_err(core_err_to_js)
        })
    }

    pub fn delete(&self, key: &str) -> Promise {
        let inner = self.inner.clone();
        let key = key.to_string();
        future_to_promise(async move {
            inner.delete(&key).await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    pub fn list(&self, prefix: Option<String>) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.list(prefix).await
                .map(|json| JsValue::from_str(&json))
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = getVersionVector)]
    pub fn get_version_vector(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.get_version_vector().await
                .map(|hex| JsValue::from_str(&hex))
                .map_err(core_err_to_js)
        })
    }

    pub fn export(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.export().await
                .map(bytes_to_js)
                .map_err(core_err_to_js)
        })
    }

    pub fn import(&self, data: &Uint8Array) -> Promise {
        let inner = self.inner.clone();
        let data = data.to_vec();
        future_to_promise(async move {
            inner.import(&data).await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = configureCloudStorage)]
    pub fn configure_cloud_storage(&self, config_json: &str) -> Promise {
        let inner = self.inner.clone();
        let config = config_json.to_string();
        future_to_promise(async move {
            inner.configure_cloud_storage(&config).await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = syncCloud)]
    pub fn sync_cloud(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.sync_cloud().await
                .map(|json| JsValue::from_str(&json))
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = getCloudStatus)]
    pub fn get_cloud_status(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.get_cloud_status().await
                .map(|json| JsValue::from_str(&json))
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = uploadCloudBlob)]
    pub fn upload_cloud_blob(&self, data: &Uint8Array, mime_type: Option<String>) -> Promise {
        let inner = self.inner.clone();
        let data = data.to_vec();
        future_to_promise(async move {
            inner.upload_cloud_blob(&data, mime_type).await
                .map(|hash| JsValue::from_str(&hash))
                .map_err(core_err_to_js)
        })
    }

    #[wasm_bindgen(js_name = downloadCloudBlob)]
    pub fn download_cloud_blob(&self, hash: &str) -> Promise {
        let inner = self.inner.clone();
        let hash = hash.to_string();
        future_to_promise(async move {
            inner.download_cloud_blob(&hash).await
                .map(bytes_to_js)
                .map_err(core_err_to_js)
        })
    }

    /// Compute the disk-reconciliation plan (see `vault::ReconcilePlan`).
    /// `dirty_paths`: paths with local edits not yet ingested into the CRDT —
    /// shielded from deletion. Returns `{ upserts: string[], deletes: string[] }`.
    #[wasm_bindgen(js_name = reconcilePlan)]
    pub fn reconcile_plan(&self, dirty_paths: Vec<String>) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            let plan = inner.reconcile_plan(dirty_paths).await.map_err(core_err_to_js)?;
            serde_json::to_string(&plan)
                .map(|json| JsValue::from_str(&json))
                .map_err(|e| js_error("INTERNAL", &format!("serialize plan: {}", e)))
        })
    }

    #[wasm_bindgen(js_name = clearCloudStorage)]
    pub fn clear_cloud_storage(&self) -> Promise {
        let inner = self.inner.clone();
        future_to_promise(async move {
            inner.clear_cloud_storage().await
                .map(|_| JsValue::TRUE)
                .map_err(core_err_to_js)
        })
    }
}
