//! Gossip Bridge - Real-time CRDT delta broadcast via iroh-gossip
//!
//! Uses HyParView + PlumTree epidemic broadcast to propagate Loro CRDT
//! deltas to all peers subscribed to the vault topic.
//!
//! - One topic per vault (TopicId = vault_id bytes)
//! - Messages are encrypted CRDT deltas (up to 64KB)
//! - Peers subscribe after initial sync completes
//! - Receiver task imports deltas into SyncEngine and updates LoroStore

use iroh::Endpoint;
use iroh_gossip::net::{Gossip, GOSSIP_ALPN};
use iroh_gossip::proto::TopicId;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::crypto::VaultKey;
use crate::error::CoreError;

/// Maximum gossip message size (64KB — covers most CRDT deltas)
const MAX_GOSSIP_MESSAGE_SIZE: usize = 65536;

/// Re-export for Router registration
pub use iroh_gossip::net::GOSSIP_ALPN as GOSSIP_PROTOCOL_ALPN;

/// Debounce window for batching gossip broadcasts (milliseconds)
const GOSSIP_DEBOUNCE_MS: u64 = 200;

/// Bridge between iroh-gossip and PeerVault's CRDT sync
pub struct GossipBridge {
    /// The gossip protocol instance (registered on Router)
    gossip: Gossip,
    /// Vault topic ID (derived from vault_id)
    vault_topic: TopicId,
    /// Sender for broadcasting (set after subscription)
    sender: Arc<RwLock<Option<iroh_gossip::api::GossipSender>>>,
    /// Whether we've subscribed to the topic
    subscribed: Arc<RwLock<bool>>,
    /// Version vector captured before first pending change (for delta export)
    pending_vv: Arc<RwLock<Option<Vec<u8>>>>,
    /// Notify channel to signal the debounce timer
    change_notify: Arc<tokio::sync::Notify>,
}

impl GossipBridge {
    /// Create a new gossip bridge. Call before Router::builder().
    pub fn new(endpoint: &Endpoint, vault_id: [u8; 32]) -> Self {
        let gossip = Gossip::builder()
            .max_message_size(MAX_GOSSIP_MESSAGE_SIZE)
            .spawn(endpoint.clone());

        let vault_topic = TopicId::from_bytes(vault_id);

        Self {
            gossip,
            vault_topic,
            sender: Arc::new(RwLock::new(None)),
            subscribed: Arc::new(RwLock::new(false)),
            pending_vv: Arc::new(RwLock::new(None)),
            change_notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// Get the Gossip instance for Router registration.
    pub fn gossip(&self) -> &Gossip {
        &self.gossip
    }

    /// Get the ALPN for Router registration.
    pub fn alpn(&self) -> &[u8] {
        GOSSIP_ALPN
    }

    /// Subscribe to the vault topic with bootstrap peers.
    /// Called after initial sync with a peer completes.
    /// Safe to call multiple times — only subscribes once, adds new peers.
    pub async fn subscribe(
        &self,
        bootstrap_peers: Vec<iroh::EndpointId>,
    ) -> Result<(), CoreError> {
        let already = *self.subscribed.read().await;

        if already {
            // Already subscribed — just add the new peers
            if let Some(sender) = self.sender.read().await.as_ref() {
                if !bootstrap_peers.is_empty() {
                    sender.join_peers(bootstrap_peers).await
                        .map_err(|e| CoreError::Internal(format!("Gossip join_peers: {}", e)))?;
                }
            }
            return Ok(());
        }

        info!("Subscribing to vault gossip topic with {} bootstrap peers", bootstrap_peers.len());

        let topic = self.gossip.subscribe_and_join(self.vault_topic, bootstrap_peers).await
            .map_err(|e| CoreError::Internal(format!("Gossip subscribe: {}", e)))?;

        let (sender, receiver) = topic.split();

        *self.sender.write().await = Some(sender);
        *self.subscribed.write().await = true;

        info!("Subscribed to vault gossip topic");

        // Return the receiver — caller is responsible for spawning the receive loop
        // We store it via spawn_receiver() below
        // For now, just drop the receiver — it will be handled by the caller
        // TODO: The receiver needs to be passed to spawn_receiver
        drop(receiver);

        Ok(())
    }

    /// Subscribe and return the receiver for the caller to spawn a receive loop.
    pub async fn subscribe_with_receiver(
        &self,
        bootstrap_peers: Vec<iroh::EndpointId>,
    ) -> Result<Option<iroh_gossip::api::GossipReceiver>, CoreError> {
        let already = *self.subscribed.read().await;

        if already {
            // Already subscribed — just add peers
            if let Some(sender) = self.sender.read().await.as_ref() {
                if !bootstrap_peers.is_empty() {
                    sender.join_peers(bootstrap_peers).await
                        .map_err(|e| CoreError::Internal(format!("Gossip join_peers: {}", e)))?;
                }
            }
            return Ok(None);
        }

        info!("Subscribing to vault gossip topic with {} bootstrap peers", bootstrap_peers.len());

        let topic = self.gossip.subscribe_and_join(self.vault_topic, bootstrap_peers).await
            .map_err(|e| CoreError::Internal(format!("Gossip subscribe: {}", e)))?;

        let (sender, receiver) = topic.split();

        *self.sender.write().await = Some(sender);
        *self.subscribed.write().await = true;

        info!("Subscribed to vault gossip topic");

        Ok(Some(receiver))
    }

    /// Broadcast an encrypted CRDT delta to all peers.
    /// Returns Err with "too_large" if delta exceeds gossip max message size.
    pub async fn broadcast_delta(&self, encrypted_delta: &[u8]) -> Result<(), CoreError> {
        if encrypted_delta.len() > MAX_GOSSIP_MESSAGE_SIZE {
            return Err(CoreError::DeltaTooLarge {
                size: encrypted_delta.len(),
                max: MAX_GOSSIP_MESSAGE_SIZE,
            });
        }

        let sender_guard = self.sender.read().await;
        let sender = sender_guard.as_ref()
            .ok_or_else(|| CoreError::Internal("Not subscribed to gossip topic".into()))?;

        sender.broadcast(encrypted_delta.to_vec().into()).await
            .map_err(|e| CoreError::Internal(format!("Gossip broadcast: {}", e)))?;

        debug!("Broadcast {} bytes via gossip", encrypted_delta.len());
        Ok(())
    }

    /// Check if we're subscribed to the gossip topic
    pub async fn is_subscribed(&self) -> bool {
        *self.subscribed.read().await
    }

    /// Mark that a local change happened. Stores the VV if not already pending.
    /// The debounce timer will export and broadcast the delta.
    pub async fn notify_change(&self, version_vector_before: Vec<u8>) {
        let mut vv = self.pending_vv.write().await;
        if vv.is_none() {
            *vv = Some(version_vector_before);
        }
        drop(vv);
        self.change_notify.notify_one();
    }

    /// Get the pending VV and clear it (used by the debounce flush).
    pub async fn take_pending_vv(&self) -> Option<Vec<u8>> {
        self.pending_vv.write().await.take()
    }

    /// Get the change notify handle (for spawning the debounce task).
    pub fn change_notify(&self) -> Arc<tokio::sync::Notify> {
        self.change_notify.clone()
    }

    /// Re-subscribe after a connection drop. Resets state and subscribes again.
    /// Returns a new receiver if successful.
    pub async fn resubscribe(
        &self,
        bootstrap_peers: Vec<iroh::EndpointId>,
    ) -> Result<iroh_gossip::api::GossipReceiver, CoreError> {
        // Reset state
        *self.sender.write().await = None;
        *self.subscribed.write().await = false;

        info!("Re-subscribing to vault gossip topic with {} peers", bootstrap_peers.len());

        let topic = self.gossip.subscribe_and_join(self.vault_topic, bootstrap_peers).await
            .map_err(|e| CoreError::Internal(format!("Gossip resubscribe: {}", e)))?;

        let (sender, receiver) = topic.split();

        *self.sender.write().await = Some(sender);
        *self.subscribed.write().await = true;

        info!("Re-subscribed to vault gossip topic");
        Ok(receiver)
    }
}
