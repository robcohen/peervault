//! Cloud Sync - S3-compatible cloud backup for vault sync
//!
//! Provides encrypted cloud storage as a complement to P2P sync:
//! - Works with any S3-compatible provider (AWS, MinIO, R2, B2, etc.)
//! - End-to-end encryption using vault key (XSalsa20-Poly1305)
//! - Snapshot + delta model for efficient incremental sync
//! - Content-addressed blob storage with deduplication

pub mod types;
pub mod encryption;
pub mod s3_client;
pub mod sync;

pub use types::*;
pub use encryption::{CloudEncryption, EncryptionError};
pub use s3_client::{S3Client, S3Error, S3Object, S3ObjectMeta};
pub use sync::{CloudSync, CloudSyncError, CloudSyncable};
