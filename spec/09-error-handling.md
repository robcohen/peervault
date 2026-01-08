# Error Handling Spec

## Purpose

Define a consistent error handling strategy across all PeerVault components, including error taxonomy, recovery procedures, and user communication.

## Requirements

- **REQ-EH-01**: All errors MUST be categorized by severity and recoverability
- **REQ-EH-02**: Recoverable errors MUST be retried automatically where appropriate
- **REQ-EH-03**: Users MUST be informed of errors that affect their data
- **REQ-EH-04**: Errors MUST be logged with sufficient context for debugging
- **REQ-EH-05**: Error handling MUST NOT cause data loss

## Error Taxonomy

### Severity Levels

```typescript
enum ErrorSeverity {
  /** Informational, operation continues */
  INFO = 'info',

  /** Something unexpected, but recovered */
  WARNING = 'warning',

  /** Operation failed, but plugin continues */
  ERROR = 'error',

  /** Plugin cannot function, requires restart */
  CRITICAL = 'critical',
}
```

### Error Categories

```typescript
enum ErrorCategory {
  /** Network connectivity issues */
  NETWORK = 'network',

  /** File system operations */
  STORAGE = 'storage',

  /** Automerge/CRDT operations */
  SYNC = 'sync',

  /** Iroh transport layer */
  TRANSPORT = 'transport',

  /** Peer connection/management */
  PEER = 'peer',

  /** Plugin configuration */
  CONFIG = 'config',

  /** Obsidian API issues */
  PLATFORM = 'platform',
}
```

### Base Error Class

```typescript
class PeerVaultError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly category: ErrorCategory,
    public readonly severity: ErrorSeverity,
    public readonly recoverable: boolean,
    public readonly context?: Record<string, unknown>,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'PeerVaultError';
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      recoverable: this.recoverable,
      context: this.context,
      stack: this.stack,
    };
  }
}
```

## Error Catalog

### Network Errors

| Code | Message | Severity | Recoverable | Recovery Action |
|------|---------|----------|-------------|-----------------|
| `NET_OFFLINE` | Device is offline | WARNING | Yes | Wait for connectivity |
| `NET_TIMEOUT` | Connection timed out | ERROR | Yes | Retry with backoff |
| `NET_RELAY_UNREACHABLE` | Cannot reach relay server | ERROR | Yes | Try direct connection |
| `NET_HOLE_PUNCH_FAILED` | NAT traversal failed | WARNING | Yes | Fall back to relay |

```typescript
const NetworkErrors = {
  offline: () => new PeerVaultError(
    'Device is offline',
    'NET_OFFLINE',
    ErrorCategory.NETWORK,
    ErrorSeverity.WARNING,
    true,
  ),

  timeout: (host: string, timeoutMs: number) => new PeerVaultError(
    `Connection to ${host} timed out after ${timeoutMs}ms`,
    'NET_TIMEOUT',
    ErrorCategory.NETWORK,
    ErrorSeverity.ERROR,
    true,
    { host, timeoutMs },
  ),
};
```

### Storage Errors

| Code | Message | Severity | Recoverable | Recovery Action |
|------|---------|----------|-------------|-----------------|
| `STOR_DISK_FULL` | Disk is full | CRITICAL | No | Alert user |
| `STOR_PERMISSION` | Permission denied | CRITICAL | No | Check permissions |
| `STOR_CORRUPT` | Document file corrupted | ERROR | Partial | Recover from peers |
| `STOR_NOT_FOUND` | Document not found | WARNING | Yes | Create new |
| `STOR_WRITE_FAILED` | Failed to write file | ERROR | Yes | Retry |

```typescript
const StorageErrors = {
  diskFull: (path: string) => new PeerVaultError(
    'Cannot save document: disk is full',
    'STOR_DISK_FULL',
    ErrorCategory.STORAGE,
    ErrorSeverity.CRITICAL,
    false,
    { path },
  ),

  corrupt: (docId: string, details: string) => new PeerVaultError(
    `Document ${docId} is corrupted: ${details}`,
    'STOR_CORRUPT',
    ErrorCategory.STORAGE,
    ErrorSeverity.ERROR,
    true, // Can recover from peers
    { docId, details },
  ),
};
```

### Sync Errors

| Code | Message | Severity | Recoverable | Recovery Action |
|------|---------|----------|-------------|-----------------|
| `SYNC_VERSION_MISMATCH` | Protocol version mismatch | ERROR | No | Update plugin |
| `SYNC_VAULT_MISMATCH` | Vault ID mismatch | ERROR | No | Check pairing |
| `SYNC_DOC_TOO_LARGE` | Document exceeds size limit | WARNING | No | Exclude file |
| `SYNC_INTERRUPTED` | Sync interrupted | WARNING | Yes | Resume |
| `SYNC_MERGE_FAILED` | Automerge merge failed | ERROR | Partial | Manual review |

```typescript
const SyncErrors = {
  vaultMismatch: (localId: string, remoteId: string) => new PeerVaultError(
    'Cannot sync: vault IDs do not match',
    'SYNC_VAULT_MISMATCH',
    ErrorCategory.SYNC,
    ErrorSeverity.ERROR,
    false,
    { localId, remoteId },
  ),

  docTooLarge: (path: string, sizeBytes: number, limitBytes: number) => new PeerVaultError(
    `File ${path} exceeds sync size limit`,
    'SYNC_DOC_TOO_LARGE',
    ErrorCategory.SYNC,
    ErrorSeverity.WARNING,
    false,
    { path, sizeBytes, limitBytes },
  ),
};
```

### Transport Errors

| Code | Message | Severity | Recoverable | Recovery Action |
|------|---------|----------|-------------|-----------------|
| `TRANS_WASM_LOAD` | Failed to load Iroh WASM | CRITICAL | No | Reload plugin |
| `TRANS_INVALID_TICKET` | Invalid connection ticket | ERROR | No | Request new ticket |
| `TRANS_STREAM_CLOSED` | Stream unexpectedly closed | WARNING | Yes | Reopen stream |
| `TRANS_ENDPOINT_INIT` | Failed to initialize endpoint | CRITICAL | Yes | Retry once |

### Peer Errors

| Code | Message | Severity | Recoverable | Recovery Action |
|------|---------|----------|-------------|-----------------|
| `PEER_UNKNOWN` | Unknown peer attempted connection | WARNING | No | Reject |
| `PEER_REJECTED` | Peer rejected connection | ERROR | No | Check configuration |
| `PEER_DISCONNECTED` | Peer disconnected | INFO | Yes | Auto-reconnect |
| `PEER_SYNC_TIMEOUT` | Peer sync timed out | WARNING | Yes | Retry |

## Error Handling Patterns

### Retry with Backoff

```typescript
interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  shouldRetry: (error: Error) => boolean = () => true,
): Promise<T> {
  let lastError: Error | null = null;
  let delay = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (!shouldRetry(lastError) || attempt === config.maxAttempts) {
        throw lastError;
      }

      logger.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
        error: lastError.message,
      });

      await sleep(delay);
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError;
}

// Usage
async function connectToPeer(ticket: string): Promise<PeerConnection> {
  return withRetry(
    () => transport.connectWithTicket(ticket),
    { ...DEFAULT_RETRY_CONFIG, maxAttempts: 3 },
    (error) => error instanceof PeerVaultError && error.recoverable,
  );
}
```

### Error Boundary for Sync Operations

```typescript
class SyncErrorBoundary {
  private errors: PeerVaultError[] = [];
  private readonly maxErrors = 10;

  async execute<T>(
    operation: () => Promise<T>,
    context: string,
  ): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      const pvError = this.wrapError(error, context);
      this.recordError(pvError);

      if (pvError.severity === ErrorSeverity.CRITICAL) {
        throw pvError; // Propagate critical errors
      }

      if (this.errors.length >= this.maxErrors) {
        throw new PeerVaultError(
          'Too many sync errors, stopping sync',
          'SYNC_ERROR_LIMIT',
          ErrorCategory.SYNC,
          ErrorSeverity.CRITICAL,
          false,
          { errorCount: this.errors.length },
        );
      }

      return null; // Continue with other operations
    }
  }

  private wrapError(error: unknown, context: string): PeerVaultError {
    if (error instanceof PeerVaultError) {
      return error;
    }

    return new PeerVaultError(
      `Unexpected error during ${context}: ${error}`,
      'SYNC_UNEXPECTED',
      ErrorCategory.SYNC,
      ErrorSeverity.ERROR,
      false,
      { context },
      error instanceof Error ? error : undefined,
    );
  }

  getErrors(): PeerVaultError[] {
    return [...this.errors];
  }

  clear(): void {
    this.errors = [];
  }
}
```

### Graceful Degradation

```typescript
class SyncEngine {
  async syncWithPeer(connection: PeerConnection): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      syncedDocs: [],
      failedDocs: [],
      errors: [],
    };

    const boundary = new SyncErrorBoundary();

    // Try to sync index first
    const index = await boundary.execute(
      () => this.syncIndex(connection),
      'index sync',
    );

    if (!index) {
      // Can't continue without index
      return {
        ...result,
        success: false,
        errors: boundary.getErrors(),
      };
    }

    // Sync individual documents, continue on failures
    for (const [path, entry] of Object.entries(index.files)) {
      const doc = await boundary.execute(
        () => this.syncDocument(entry.docId, connection),
        `sync ${path}`,
      );

      if (doc) {
        result.syncedDocs.push(path);
      } else {
        result.failedDocs.push(path);
      }
    }

    result.errors = boundary.getErrors();
    result.success = result.failedDocs.length === 0;

    return result;
  }
}
```

## User Notification

### Notification Levels

```typescript
enum NotificationLevel {
  /** Silent, log only */
  SILENT = 'silent',

  /** Brief notice, auto-dismiss */
  NOTICE = 'notice',

  /** Persistent notice, requires dismissal */
  WARNING = 'warning',

  /** Modal dialog, requires action */
  ALERT = 'alert',
}

function getNotificationLevel(error: PeerVaultError): NotificationLevel {
  if (error.severity === ErrorSeverity.INFO) {
    return NotificationLevel.SILENT;
  }

  if (error.severity === ErrorSeverity.WARNING && error.recoverable) {
    return NotificationLevel.NOTICE;
  }

  if (error.severity === ErrorSeverity.ERROR) {
    return NotificationLevel.WARNING;
  }

  return NotificationLevel.ALERT;
}
```

### User-Facing Messages

```typescript
const USER_MESSAGES: Record<string, string> = {
  'NET_OFFLINE': 'You are offline. Sync will resume when connected.',
  'NET_TIMEOUT': 'Connection timed out. Retrying...',
  'STOR_DISK_FULL': 'Cannot save: your disk is full. Free up space to continue syncing.',
  'STOR_CORRUPT': 'A sync file was corrupted. Attempting recovery from other devices.',
  'SYNC_VAULT_MISMATCH': 'This device is paired with a different vault. Please re-pair.',
  'PEER_DISCONNECTED': 'Lost connection to peer. Reconnecting...',
};

function notifyUser(error: PeerVaultError): void {
  const level = getNotificationLevel(error);
  const message = USER_MESSAGES[error.code] ?? error.message;

  switch (level) {
    case NotificationLevel.SILENT:
      // Log only
      break;
    case NotificationLevel.NOTICE:
      new Notice(message, 5000);
      break;
    case NotificationLevel.WARNING:
      new Notice(message, 0); // Persistent
      break;
    case NotificationLevel.ALERT:
      showErrorModal(error, message);
      break;
  }
}
```

## Logging

### Log Structure

```typescript
interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
  error?: {
    code: string;
    category: string;
    stack?: string;
  };
}

class Logger {
  private entries: LogEntry[] = [];
  private readonly maxEntries = 1000;

  error(message: string, error?: PeerVaultError, context?: Record<string, unknown>): void {
    this.log('error', message, context, error);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  private log(
    level: LogEntry['level'],
    message: string,
    context?: Record<string, unknown>,
    error?: PeerVaultError,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };

    if (error) {
      entry.error = {
        code: error.code,
        category: error.category,
        stack: error.stack,
      };
    }

    this.entries.push(entry);

    // Trim old entries
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    // Also log to console in development
    console[level](`[PeerVault] ${message}`, context, error);
  }

  export(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}
```

## Recovery Procedures

### Corrupted Document Recovery

```
┌─────────────────┐
│ Detect corrupt  │
│    document     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     Yes    ┌─────────────────┐
│  Have backup?   │───────────►│ Restore backup  │
└────────┬────────┘            └─────────────────┘
         │ No
         ▼
┌─────────────────┐     Yes    ┌─────────────────┐
│ Peers online?   │───────────►│ Request from    │
└────────┬────────┘            │     peer        │
         │ No                  └─────────────────┘
         ▼
┌─────────────────┐
│  Rebuild from   │
│  markdown file  │
└─────────────────┘
```

### Connection Recovery

```
┌─────────────────┐
│  Connection     │
│     lost        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Wait 5 seconds  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     Success  ┌─────────────────┐
│  Try reconnect  │─────────────►│  Resume sync    │
└────────┬────────┘              └─────────────────┘
         │ Fail
         ▼
┌─────────────────┐
│ Exponential     │
│ backoff retry   │──────┐
│ (max 5 min)     │      │
└────────┬────────┘      │
         │               │
         ▼               │
┌─────────────────┐      │
│  Max retries?   │──No──┘
└────────┬────────┘
         │ Yes
         ▼
┌─────────────────┐
│ Mark peer       │
│ unavailable     │
└─────────────────┘
```

## Dependencies

- Obsidian Notice API for user notifications
- Console API for development logging
