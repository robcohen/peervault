//! S3 Client - AWS Signature V4 compatible S3 client
//!
//! Supports any S3-compatible storage:
//! - AWS S3
//! - MinIO
//! - Cloudflare R2
//! - Backblaze B2
//! - DigitalOcean Spaces

use hmac::{Hmac, Mac};
use sha2::{Sha256, Digest};
use reqwest::Client;
use web_time::SystemTime;

use crate::cloud::types::{CloudConfig, is_retryable_error};

/// S3 client with AWS Signature V4 authentication
pub struct S3Client {
    config: CloudConfig,
    client: Client,
}

/// S3 operation result
pub type S3Result<T> = Result<T, S3Error>;

/// S3 errors
#[derive(Debug, Clone, thiserror::Error)]
pub enum S3Error {
    #[error("Network error: {0}")]
    Network(String),

    #[error("S3 error {status}: {code} - {message}")]
    S3 {
        status: u16,
        code: String,
        message: String,
    },

    #[error("Invalid configuration: {0}")]
    Config(String),

    #[error("Object not found: {0}")]
    NotFound(String),
}

impl S3Client {
    /// Create a new S3 client
    pub fn new(config: CloudConfig) -> S3Result<Self> {
        // Require TLS. `http://` is permitted only for an explicit localhost dev
        // endpoint (e.g. a local MinIO), since SigV4 keeps the secret off the wire
        // but does not stop an on-path attacker tampering with plaintext requests.
        // Parse the URL and compare the exact scheme/host — a prefix check like
        // `starts_with("http://localhost")` also matches `http://localhost.evil.com`.
        let url = reqwest::Url::parse(&config.endpoint)
            .map_err(|e| S3Error::Config(format!("Invalid endpoint URL: {}", e)))?;
        let allowed = match url.scheme() {
            "https" => true,
            "http" => matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("::1") | Some("[::1]")
            ),
            _ => false,
        };
        if !allowed {
            return Err(S3Error::Config(
                "Cloud endpoint must use https:// (http is allowed only for localhost)".into(),
            ));
        }

        let client = Client::builder()
            .build()
            .map_err(|e| S3Error::Network(e.to_string()))?;

        Ok(Self { config, client })
    }

    /// Get an object from S3
    pub async fn get_object(&self, key: &str) -> S3Result<Vec<u8>> {
        let full_key = self.config.object_path(key);
        let url = format!("{}/{}/{}", self.config.endpoint, self.config.bucket, full_key);

        let canonical_uri = format!("/{}/{}", self.config.bucket, full_key);
        let request = self.sign_request("GET", &canonical_uri, "", None)?;

        let response = self.client
            .get(&url)
            .headers(request.headers)
            .send()
            .await
            .map_err(|e| S3Error::Network(e.to_string()))?;

        let status = response.status().as_u16();

        if status == 404 {
            return Err(S3Error::NotFound(key.to_string()));
        }

        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            let (code, message) = parse_s3_error(&body);
            return Err(S3Error::S3 { status, code, message });
        }

        response.bytes().await
            .map(|b| b.to_vec())
            .map_err(|e| S3Error::Network(e.to_string()))
    }

    /// Put an object to S3
    pub async fn put_object(&self, key: &str, data: Vec<u8>, content_type: Option<&str>) -> S3Result<()> {
        let full_key = self.config.object_path(key);
        let url = format!("{}/{}/{}", self.config.endpoint, self.config.bucket, full_key);

        let canonical_uri = format!("/{}/{}", self.config.bucket, full_key);
        let request = self.sign_request("PUT", &canonical_uri, "", Some(&data))?;

        let mut req = self.client
            .put(&url)
            .headers(request.headers)
            .body(data);

        if let Some(ct) = content_type {
            req = req.header("Content-Type", ct);
        }

        let response = req.send().await
            .map_err(|e| S3Error::Network(e.to_string()))?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let (code, message) = parse_s3_error(&body);
            return Err(S3Error::S3 { status, code, message });
        }

        Ok(())
    }

    /// Delete an object from S3
    pub async fn delete_object(&self, key: &str) -> S3Result<()> {
        let full_key = self.config.object_path(key);
        let url = format!("{}/{}/{}", self.config.endpoint, self.config.bucket, full_key);

        let canonical_uri = format!("/{}/{}", self.config.bucket, full_key);
        let request = self.sign_request("DELETE", &canonical_uri, "", None)?;

        let response = self.client
            .delete(&url)
            .headers(request.headers)
            .send()
            .await
            .map_err(|e| S3Error::Network(e.to_string()))?;

        // 404 is OK for delete (idempotent)
        if response.status().as_u16() == 404 {
            return Ok(());
        }

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let (code, message) = parse_s3_error(&body);
            return Err(S3Error::S3 { status, code, message });
        }

        Ok(())
    }

    /// List objects with a prefix.
    ///
    /// Follows `NextContinuationToken` so result sets larger than the 1000-key
    /// ListObjectsV2 page limit are fully enumerated.
    pub async fn list_objects(&self, prefix: &str) -> S3Result<Vec<S3Object>> {
        let full_prefix = self.config.object_path(prefix);
        let encoded_prefix = aws_uri_encode(&full_prefix);
        let canonical_uri = format!("/{}", self.config.bucket);

        let mut objects = Vec::new();
        let mut continuation: Option<String> = None;

        loop {
            // Canonical query string: parameters sorted by key, values AWS-URI-encoded.
            // The exact same string is used for both signing and the request URL so
            // the server-side signature can never disagree with the wire request.
            let canonical_query = match &continuation {
                Some(token) => format!(
                    "continuation-token={}&list-type=2&prefix={}",
                    aws_uri_encode(token),
                    encoded_prefix
                ),
                None => format!("list-type=2&prefix={}", encoded_prefix),
            };

            let url = format!(
                "{}/{}?{}",
                self.config.endpoint, self.config.bucket, canonical_query
            );

            let request = self.sign_request("GET", &canonical_uri, &canonical_query, None)?;

            let response = self.client
                .get(&url)
                .headers(request.headers)
                .send()
                .await
                .map_err(|e| S3Error::Network(e.to_string()))?;

            if !response.status().is_success() {
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                let (code, message) = parse_s3_error(&body);
                return Err(S3Error::S3 { status, code, message });
            }

            let body = response.text().await
                .map_err(|e| S3Error::Network(e.to_string()))?;

            let (mut page, next) = parse_list_objects_response(&body, &self.config.path_prefix);
            objects.append(&mut page);

            match next {
                Some(token) => continuation = Some(token),
                None => break,
            }
        }

        Ok(objects)
    }

    /// Check if an object exists
    pub async fn head_object(&self, key: &str) -> S3Result<Option<S3ObjectMeta>> {
        let full_key = self.config.object_path(key);
        let url = format!("{}/{}/{}", self.config.endpoint, self.config.bucket, full_key);

        let canonical_uri = format!("/{}/{}", self.config.bucket, full_key);
        let request = self.sign_request("HEAD", &canonical_uri, "", None)?;

        let response = self.client
            .head(&url)
            .headers(request.headers)
            .send()
            .await
            .map_err(|e| S3Error::Network(e.to_string()))?;

        if response.status().as_u16() == 404 {
            return Ok(None);
        }

        if !response.status().is_success() {
            let status = response.status().as_u16();
            return Err(S3Error::S3 {
                status,
                code: "Unknown".into(),
                message: "HEAD request failed".into(),
            });
        }

        let size = response.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let etag = response.headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim_matches('"').to_string());

        let last_modified = response.headers()
            .get("last-modified")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        Ok(Some(S3ObjectMeta {
            size,
            etag,
            last_modified,
        }))
    }

    /// Sign a request using AWS Signature V4.
    ///
    /// `canonical_uri` and `canonical_query` MUST exactly correspond to the path
    /// and (sorted, URI-encoded) query string of the actual HTTP request, or the
    /// server will reject the signature.
    fn sign_request(
        &self,
        method: &str,
        canonical_uri: &str,
        canonical_query: &str,
        body: Option<&[u8]>,
    ) -> S3Result<SignedRequest> {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|_| S3Error::Config("System time error".into()))?;

        let datetime = format_datetime(now.as_secs());
        let date = &datetime[..8];

        // Parse host from endpoint
        let host = self.config.endpoint
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or(&self.config.endpoint);

        // Payload hash
        let payload_hash = match body {
            Some(data) => hex::encode(Sha256::digest(data)),
            None => "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(), // Empty hash
        };

        // Canonical request
        let canonical_headers = format!(
            "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
            host, payload_hash, datetime
        );
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";

        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method,
            canonical_uri,
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash
        );

        // String to sign
        let credential_scope = format!("{}/{}/s3/aws4_request", date, self.config.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            datetime,
            credential_scope,
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );

        // Signing key
        let signing_key = derive_signing_key(
            &self.config.secret_access_key,
            date,
            &self.config.region,
        );

        // Signature
        let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes()));

        // Authorization header
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.config.access_key_id,
            credential_scope,
            signed_headers,
            signature
        );

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("Host", host.parse().unwrap());
        headers.insert("x-amz-date", datetime.parse().unwrap());
        headers.insert("x-amz-content-sha256", payload_hash.parse().unwrap());
        headers.insert("Authorization", authorization.parse().unwrap());

        Ok(SignedRequest { headers })
    }

    /// Check if an error is retryable
    pub fn is_retryable(&self, error: &S3Error) -> bool {
        match error {
            S3Error::Network(_) => true,
            S3Error::S3 { status, code, .. } => is_retryable_error(*status, Some(code)),
            _ => false,
        }
    }
}

/// Object info from list operation
#[derive(Debug, Clone)]
pub struct S3Object {
    pub key: String,
    pub size: usize,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// Object metadata from HEAD operation
#[derive(Debug, Clone)]
pub struct S3ObjectMeta {
    pub size: usize,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// Signed request with headers
struct SignedRequest {
    headers: reqwest::header::HeaderMap,
}

/// Format datetime for AWS Signature V4
fn format_datetime(epoch_secs: u64) -> String {
    // Convert to UTC datetime string: YYYYMMDD'T'HHMMSS'Z'
    let secs_per_day = 86400u64;
    let secs_per_hour = 3600u64;
    let secs_per_min = 60u64;

    // Days since 1970-01-01
    let days = epoch_secs / secs_per_day;
    let remaining = epoch_secs % secs_per_day;

    let hours = remaining / secs_per_hour;
    let remaining = remaining % secs_per_hour;

    let mins = remaining / secs_per_min;
    let secs = remaining % secs_per_min;

    // Calculate year, month, day (simplified - doesn't handle leap years perfectly)
    let (year, month, day) = days_to_ymd(days);

    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        year, month, day, hours, mins, secs
    )
}

/// Convert days since epoch to year/month/day
fn days_to_ymd(days: u64) -> (u32, u32, u32) {
    // Simplified algorithm - good enough for our purposes
    let mut remaining = days as i64;
    let mut year = 1970i32;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let days_in_months: [i64; 12] = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u32;
    for days_in_month in days_in_months {
        if remaining < days_in_month {
            break;
        }
        remaining -= days_in_month;
        month += 1;
    }

    (year as u32, month, remaining as u32 + 1)
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

/// Derive signing key for AWS Signature V4
fn derive_signing_key(secret_key: &str, date: &str, region: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{}", secret_key).as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    hmac_sha256(&k_service, b"aws4_request")
}

/// HMAC-SHA256
fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Parse S3 error response (XML)
fn parse_s3_error(body: &str) -> (String, String) {
    // Simple XML parsing for error response
    let code = extract_xml_value(body, "Code").unwrap_or_else(|| "Unknown".into());
    let message = extract_xml_value(body, "Message").unwrap_or_else(|| "Unknown error".into());
    (code, message)
}

/// Parse ListObjectsV2 response
/// Parse a ListObjectsV2 XML response.
///
/// Returns the parsed objects and, when the result is truncated, the
/// `NextContinuationToken` to fetch the following page.
fn parse_list_objects_response(body: &str, prefix_to_strip: &str) -> (Vec<S3Object>, Option<String>) {
    let mut objects = Vec::new();

    // Find all <Contents> elements
    for content in body.split("<Contents>").skip(1) {
        if let Some(end) = content.find("</Contents>") {
            let element = &content[..end];

            let key = extract_xml_value(element, "Key");
            let size = extract_xml_value(element, "Size")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let etag = extract_xml_value(element, "ETag")
                .map(|s| s.trim_matches('"').to_string());
            let last_modified = extract_xml_value(element, "LastModified");

            if let Some(mut key) = key {
                // Strip prefix if present
                if !prefix_to_strip.is_empty() {
                    let prefix_with_slash = format!("{}/", prefix_to_strip.trim_end_matches('/'));
                    if key.starts_with(&prefix_with_slash) {
                        key = key[prefix_with_slash.len()..].to_string();
                    }
                }

                objects.push(S3Object {
                    key,
                    size,
                    etag,
                    last_modified,
                });
            }
        }
    }

    let is_truncated = extract_xml_value(body, "IsTruncated")
        .map(|v| v.trim() == "true")
        .unwrap_or(false);
    let next_token = if is_truncated {
        extract_xml_value(body, "NextContinuationToken")
    } else {
        None
    };

    (objects, next_token)
}

/// URI-encode a value for an AWS SigV4 canonical query string (RFC 3986,
/// unreserved characters left as-is, everything else percent-encoded).
fn aws_uri_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &b in value.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Extract value from XML element
fn extract_xml_value(xml: &str, tag: &str) -> Option<String> {
    let start_tag = format!("<{}>", tag);
    let end_tag = format!("</{}>", tag);

    let start = xml.find(&start_tag)?;
    let value_start = start + start_tag.len();
    let end = xml[value_start..].find(&end_tag)?;

    Some(xml[value_start..value_start + end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_datetime() {
        // 2024-01-01 00:00:00 UTC
        let dt = format_datetime(1704067200);
        assert_eq!(dt, "20240101T000000Z");
    }

    #[test]
    fn test_days_to_ymd() {
        // 1970-01-01
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        // 2024-01-01 (1704067200 seconds / 86400 = 19723 days since epoch)
        assert_eq!(days_to_ymd(19723), (2024, 1, 1));
    }

    #[test]
    fn test_parse_s3_error() {
        let body = r#"<?xml version="1.0" encoding="UTF-8"?>
            <Error>
                <Code>NoSuchBucket</Code>
                <Message>The specified bucket does not exist</Message>
            </Error>"#;

        let (code, message) = parse_s3_error(body);
        assert_eq!(code, "NoSuchBucket");
        assert_eq!(message, "The specified bucket does not exist");
    }

    #[test]
    fn test_parse_list_objects() {
        let body = r#"<?xml version="1.0" encoding="UTF-8"?>
            <ListBucketResult>
                <Contents>
                    <Key>prefix/deltas/123.enc</Key>
                    <Size>1024</Size>
                    <ETag>"abc123"</ETag>
                    <LastModified>2024-01-01T00:00:00.000Z</LastModified>
                </Contents>
                <Contents>
                    <Key>prefix/deltas/456.enc</Key>
                    <Size>2048</Size>
                </Contents>
            </ListBucketResult>"#;

        let (objects, _next) = parse_list_objects_response(body, "prefix");
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].key, "deltas/123.enc");
        assert_eq!(objects[0].size, 1024);
        assert_eq!(objects[1].key, "deltas/456.enc");
        assert_eq!(objects[1].size, 2048);
    }

    #[test]
    fn test_signing_key_derivation() {
        let key = derive_signing_key("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1");
        // The key should be 32 bytes (SHA-256 output)
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn test_hmac_sha256() {
        let key = b"key";
        let data = b"The quick brown fox jumps over the lazy dog";
        let result = hmac_sha256(key, data);

        // Known HMAC-SHA256 value
        let expected = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";
        assert_eq!(hex::encode(&result), expected);
    }
}
