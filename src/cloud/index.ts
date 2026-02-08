/**
 * Cloud Sync Module
 *
 * Provides S3-compatible cloud storage for offline sync scenarios.
 * All data is encrypted with the vault key before upload.
 */

export * from "./types";
export { S3Client, S3Error, createS3Client, type ListResult, type ObjectMetadata } from "./s3-client";
export { CloudSync, createCloudSync } from "./cloud-sync";
