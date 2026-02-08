/**
 * S3 Client
 *
 * Minimal S3-compatible client using AWS Signature V4 authentication.
 * Designed for browser environments without native AWS SDK dependencies.
 *
 * Supported Services:
 * - AWS S3
 * - MinIO
 * - Cloudflare R2
 * - Backblaze B2 (S3 API)
 * - DigitalOcean Spaces
 * - Any S3-compatible storage
 *
 * Operations:
 * - putObject: Upload files
 * - getObject: Download files
 * - headObject: Get metadata
 * - deleteObject: Remove files
 * - listObjects: List with prefix
 * - listObjectsWithSize: List with sizes for storage stats
 * - getStorageUsage: Calculate total usage
 * - testConnection: Verify credentials
 */

import type { CloudStorageConfig } from "./types";

/**
 * S3 API error response.
 */
export class S3Error extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

/**
 * Result of a list operation.
 */
export interface ListResult {
  /** Object keys */
  keys: string[];
  /** Whether there are more results */
  isTruncated: boolean;
  /** Continuation token for pagination */
  continuationToken?: string;
}

/**
 * Object info with size.
 */
export interface ObjectInfo {
  /** Object key */
  key: string;
  /** Size in bytes */
  size: number;
  /** Last modified date */
  lastModified?: Date;
}

/**
 * Result of a list operation with sizes.
 */
export interface ListWithSizeResult {
  /** Object info */
  objects: ObjectInfo[];
  /** Whether there are more results */
  isTruncated: boolean;
  /** Continuation token for pagination */
  continuationToken?: string;
  /** Total size of listed objects */
  totalSize: number;
}

/**
 * Object metadata from HEAD request.
 */
export interface ObjectMetadata {
  /** Content length in bytes */
  contentLength: number;
  /** Content type */
  contentType?: string;
  /** ETag (usually MD5 hash) */
  etag?: string;
  /** Last modified timestamp */
  lastModified?: Date;
}

/**
 * Minimal S3 client for cloud sync.
 */
export class S3Client {
  private config: Required<CloudStorageConfig>;
  private encoder = new TextEncoder();

  constructor(config: CloudStorageConfig) {
    this.config = {
      endpoint: config.endpoint.replace(/\/$/, ""), // Remove trailing slash
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region || "auto",
      pathPrefix: config.pathPrefix || "v1",
    };
  }

  /**
   * Get the full path for an object key.
   */
  private getFullPath(key: string): string {
    const prefix = this.config.pathPrefix;
    if (prefix) {
      return `${prefix}/${key}`;
    }
    return key;
  }

  /**
   * Get the URL for an object.
   */
  private getUrl(key: string): string {
    const fullPath = this.getFullPath(key);
    return `${this.config.endpoint}/${this.config.bucket}/${fullPath}`;
  }

  /**
   * Sign a request using AWS Signature V4.
   */
  private async signRequest(
    method: string,
    url: string,
    headers: Headers,
    body?: Uint8Array,
  ): Promise<void> {
    const parsedUrl = new URL(url);
    const host = parsedUrl.host;
    const path = parsedUrl.pathname;
    const query = parsedUrl.search.slice(1); // Remove leading "?"

    // Current time
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    // Set required headers
    headers.set("Host", host);
    headers.set("X-Amz-Date", amzDate);

    // Calculate payload hash
    const payloadHash = body
      ? await this.sha256Hex(body)
      : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // Empty string hash
    headers.set("X-Amz-Content-Sha256", payloadHash);

    // Create canonical request
    const signedHeaders = this.getSignedHeaders(headers);
    const canonicalHeaders = this.getCanonicalHeaders(headers, signedHeaders);
    const canonicalRequest = [
      method,
      path,
      query,
      canonicalHeaders,
      signedHeaders.join(";"),
      payloadHash,
    ].join("\n");

    // Create string to sign
    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await this.sha256Hex(this.encoder.encode(canonicalRequest)),
    ].join("\n");

    // Calculate signature
    const signingKey = await this.getSignatureKey(dateStamp);
    const signature = await this.hmacHex(signingKey, stringToSign);

    // Create authorization header
    const authorization = [
      `${algorithm} Credential=${this.config.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders.join(";")}`,
      `Signature=${signature}`,
    ].join(", ");

    headers.set("Authorization", authorization);
  }

  /**
   * Get headers to sign (sorted, lowercase).
   */
  private getSignedHeaders(headers: Headers): string[] {
    const signed: string[] = [];
    headers.forEach((_, key) => {
      signed.push(key.toLowerCase());
    });
    return signed.sort();
  }

  /**
   * Get canonical headers string.
   */
  private getCanonicalHeaders(headers: Headers, signedHeaders: string[]): string {
    return signedHeaders
      .map((key) => `${key}:${headers.get(key)?.trim() || ""}\n`)
      .join("");
  }

  /**
   * Derive the signing key.
   */
  private async getSignatureKey(dateStamp: string): Promise<ArrayBuffer> {
    const kDate = await this.hmac(
      this.encoder.encode(`AWS4${this.config.secretAccessKey}`),
      dateStamp,
    );
    const kRegion = await this.hmac(kDate, this.config.region);
    const kService = await this.hmac(kRegion, "s3");
    return this.hmac(kService, "aws4_request");
  }

  /**
   * HMAC-SHA256.
   */
  private async hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
    // Ensure we have a proper ArrayBuffer for importKey
    // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
    let keyBuffer: ArrayBuffer;
    if (key instanceof Uint8Array) {
      keyBuffer = new ArrayBuffer(key.byteLength);
      new Uint8Array(keyBuffer).set(key);
    } else {
      keyBuffer = key;
    }
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return crypto.subtle.sign("HMAC", cryptoKey, this.encoder.encode(data));
  }

  /**
   * HMAC-SHA256 returning hex string.
   */
  private async hmacHex(key: ArrayBuffer, data: string): Promise<string> {
    const result = await this.hmac(key, data);
    return this.arrayBufferToHex(result);
  }

  /**
   * SHA-256 hash returning hex string.
   */
  private async sha256Hex(data: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
    return this.arrayBufferToHex(hash);
  }

  /**
   * Convert ArrayBuffer to hex string.
   */
  private arrayBufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Make a signed request to S3.
   */
  private async request(
    method: string,
    key: string,
    options: {
      body?: Uint8Array;
      contentType?: string;
      query?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    let url = this.getUrl(key);

    // Add query parameters
    if (options.query && Object.keys(options.query).length > 0) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const headers = new Headers();
    if (options.contentType) {
      headers.set("Content-Type", options.contentType);
    }
    if (options.body) {
      headers.set("Content-Length", options.body.length.toString());
    }

    await this.signRequest(method, url, headers, options.body);

    // Convert Uint8Array to ArrayBuffer for fetch compatibility
    let bodyData: ArrayBuffer | undefined;
    if (options.body) {
      bodyData = new ArrayBuffer(options.body.byteLength);
      new Uint8Array(bodyData).set(options.body);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: bodyData,
    });

    return response;
  }

  /**
   * Check if an error response indicates "not found".
   */
  private isNotFound(response: Response): boolean {
    return response.status === 404;
  }

  /**
   * Parse error response.
   */
  private async parseError(response: Response): Promise<S3Error> {
    const text = await response.text();
    // Try to extract error code from XML
    const codeMatch = text.match(/<Code>([^<]+)<\/Code>/);
    const messageMatch = text.match(/<Message>([^<]+)<\/Message>/);
    const code = codeMatch?.[1];
    const message = messageMatch?.[1] || text || `HTTP ${response.status}`;
    return new S3Error(message, response.status, code);
  }

  /**
   * Upload an object.
   */
  async putObject(key: string, data: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    const response = await this.request("PUT", key, {
      body: data,
      contentType,
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }
  }

  /**
   * Download an object.
   * Returns null if object doesn't exist.
   */
  async getObject(key: string): Promise<Uint8Array | null> {
    const response = await this.request("GET", key);

    if (this.isNotFound(response)) {
      return null;
    }

    if (!response.ok) {
      throw await this.parseError(response);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * Get object metadata without downloading.
   * Returns null if object doesn't exist.
   */
  async headObject(key: string): Promise<ObjectMetadata | null> {
    const response = await this.request("HEAD", key);

    if (this.isNotFound(response)) {
      return null;
    }

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return {
      contentLength: parseInt(response.headers.get("Content-Length") || "0", 10),
      contentType: response.headers.get("Content-Type") || undefined,
      etag: response.headers.get("ETag") || undefined,
      lastModified: response.headers.get("Last-Modified")
        ? new Date(response.headers.get("Last-Modified")!)
        : undefined,
    };
  }

  /**
   * Delete an object.
   */
  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", key);

    // 204 No Content is success, 404 means already deleted
    if (!response.ok && !this.isNotFound(response)) {
      throw await this.parseError(response);
    }
  }

  /**
   * List objects with a prefix.
   */
  async listObjects(prefix: string, continuationToken?: string): Promise<ListResult> {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix: this.getFullPath(prefix),
    };

    if (continuationToken) {
      query["continuation-token"] = continuationToken;
    }

    // Request to bucket root with query params
    const url = `${this.config.endpoint}/${this.config.bucket}`;
    const fullUrl = `${url}?${new URLSearchParams(query).toString()}`;

    const headers = new Headers();
    await this.signRequest("GET", fullUrl, headers);

    const response = await fetch(fullUrl, { method: "GET", headers });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    const text = await response.text();

    // Parse XML response
    const keys: string[] = [];
    const keyMatches = text.matchAll(/<Key>([^<]+)<\/Key>/g);
    for (const match of keyMatches) {
      // Remove the path prefix from returned keys
      let key = match[1]!;
      const fullPrefix = this.getFullPath("");
      if (key.startsWith(fullPrefix)) {
        key = key.slice(fullPrefix.length);
      }
      keys.push(key);
    }

    const isTruncated = text.includes("<IsTruncated>true</IsTruncated>");
    const tokenMatch = text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);

    return {
      keys,
      isTruncated,
      continuationToken: tokenMatch?.[1],
    };
  }

  /**
   * List objects with sizes.
   */
  async listObjectsWithSize(
    prefix: string,
    continuationToken?: string,
  ): Promise<ListWithSizeResult> {
    const query: Record<string, string> = {
      "list-type": "2",
      prefix: this.getFullPath(prefix),
    };

    if (continuationToken) {
      query["continuation-token"] = continuationToken;
    }

    const url = `${this.config.endpoint}/${this.config.bucket}`;
    const fullUrl = `${url}?${new URLSearchParams(query).toString()}`;

    const headers = new Headers();
    await this.signRequest("GET", fullUrl, headers);

    const response = await fetch(fullUrl, { method: "GET", headers });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    const text = await response.text();
    const objects: ObjectInfo[] = [];
    let totalSize = 0;

    // Parse <Contents> elements which contain Key, Size, LastModified
    const contentMatches = text.matchAll(
      /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?(?:<LastModified>([^<]+)<\/LastModified>)?[\s\S]*?<\/Contents>/g,
    );

    const fullPrefix = this.getFullPath("");

    for (const match of contentMatches) {
      let key = match[1]!;
      const size = parseInt(match[2]!, 10);
      const lastModifiedStr = match[3];

      // Remove the path prefix from returned keys
      if (key.startsWith(fullPrefix)) {
        key = key.slice(fullPrefix.length);
      }

      objects.push({
        key,
        size,
        lastModified: lastModifiedStr ? new Date(lastModifiedStr) : undefined,
      });
      totalSize += size;
    }

    const isTruncated = text.includes("<IsTruncated>true</IsTruncated>");
    const tokenMatch = text.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
    );

    return {
      objects,
      isTruncated,
      continuationToken: tokenMatch?.[1],
      totalSize,
    };
  }

  /**
   * Get total storage usage for a prefix.
   * Iterates through all pages to get complete count.
   */
  async getStorageUsage(prefix: string): Promise<{ totalBytes: number; objectCount: number }> {
    let totalBytes = 0;
    let objectCount = 0;
    let continuationToken: string | undefined;

    do {
      const result = await this.listObjectsWithSize(prefix, continuationToken);
      totalBytes += result.totalSize;
      objectCount += result.objects.length;
      continuationToken = result.isTruncated ? result.continuationToken : undefined;
    } while (continuationToken);

    return { totalBytes, objectCount };
  }

  /**
   * Check if the bucket is accessible.
   */
  async testConnection(): Promise<boolean> {
    try {
      // Try to list objects with a limit of 1
      const url = `${this.config.endpoint}/${this.config.bucket}?list-type=2&max-keys=1`;
      const headers = new Headers();
      await this.signRequest("GET", url, headers);

      const response = await fetch(url, { method: "GET", headers });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Create an S3 client from configuration.
 */
export function createS3Client(config: CloudStorageConfig): S3Client {
  return new S3Client(config);
}
