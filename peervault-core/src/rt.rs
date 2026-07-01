//! Runtime shim — the only place that knows which async runtime we're on.
//!
//! The host-agnostic core (`vault.rs`) spawns background tasks (accept loop,
//! gossip receiver/debounce) and sleeps (debounce window) through these two
//! functions, so the same orchestration code runs on:
//! - **wasm32** (browser/Electron): `wasm_bindgen_futures::spawn_local` +
//!   `setTimeout` — single-threaded, no `Send` bound.
//! - **native**: `tokio::spawn` + `tokio::time::sleep` — futures must be `Send`.

/// Spawn a detached background task.
#[cfg(target_arch = "wasm32")]
pub fn spawn<F>(future: F)
where
    F: std::future::Future<Output = ()> + 'static,
{
    wasm_bindgen_futures::spawn_local(future);
}

/// Spawn a detached background task.
#[cfg(not(target_arch = "wasm32"))]
pub fn spawn<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(future);
}

/// Sleep for `ms` milliseconds.
///
/// On wasm this uses `setTimeout`; if no `window` is available (e.g. a worker
/// context) it resolves immediately, degrading a debounce into a passthrough —
/// the same behaviour the inline implementation had.
#[cfg(target_arch = "wasm32")]
pub async fn sleep(ms: u32) {
    use wasm_bindgen::{JsCast, JsValue};
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        // Look up setTimeout on the global object so this works in every JS
        // environment (browser window, worker, AND Node — e.g. the VSCode
        // extension host). Falls back to resolving immediately if absent.
        let global = js_sys::global();
        let set_timeout = js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout"))
            .ok()
            .and_then(|v| v.dyn_into::<js_sys::Function>().ok());
        match set_timeout {
            Some(f) => {
                if f.call2(&JsValue::NULL, &resolve, &JsValue::from_f64(ms as f64)).is_err() {
                    let _ = resolve.call0(&JsValue::NULL);
                }
            }
            None => {
                let _ = resolve.call0(&JsValue::NULL);
            }
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

/// Sleep for `ms` milliseconds.
#[cfg(not(target_arch = "wasm32"))]
pub async fn sleep(ms: u32) {
    tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await;
}
