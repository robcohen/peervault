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

  /** Loro/CRDT operations */
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
| `SYNC_MERGE_FAILED` | Loro merge failed | ERROR | Partial | Manual review |

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
  category: 'sync' | 'network' | 'crdt' | 'storage' | 'ui';
  message: string;
  data?: Record<string, unknown>;
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

## Debug/Diagnostic Mode

A comprehensive diagnostic mode for troubleshooting sync issues.

### Enabling Debug Mode

```typescript
interface DebugConfig {
  /** Enable verbose logging */
  verboseLogging: boolean;

  /** Log sync operations */
  logSyncOps: boolean;

  /** Log network activity */
  logNetwork: boolean;

  /** Log CRDT operations */
  logCrdt: boolean;

  /** Store logs to file */
  persistLogs: boolean;

  /** Max log file size in MB */
  maxLogSize: number;

  /** Log retention in days */
  logRetentionDays: number;
}

const DEFAULT_DEBUG_CONFIG: DebugConfig = {
  verboseLogging: false,
  logSyncOps: false,
  logNetwork: false,
  logCrdt: false,
  persistLogs: false,
  maxLogSize: 10,
  logRetentionDays: 7,
};
```

### Diagnostic Logger

```typescript
/**
 * Enhanced logger for debug mode.
 */
class DiagnosticLogger {
  private logs: LogEntry[] = [];
  private fileHandle: FileHandle | null = null;
  private config: DebugConfig;

  constructor(config: DebugConfig) {
    this.config = config;

    if (config.persistLogs) {
      this.initializeLogFile();
    }
  }

  /**
   * Log with category and optional data.
   */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    category: 'sync' | 'network' | 'crdt' | 'storage' | 'ui',
    message: string,
    data?: Record<string, unknown>
  ): void {
    // Check if this category is enabled
    if (!this.shouldLog(category)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data,
    };

    this.logs.push(entry);

    // Trim in-memory logs
    if (this.logs.length > 10000) {
      this.logs = this.logs.slice(-5000);
    }

    // Console output
    const prefix = `[PeerVault:${category}]`;
    const logFn = console[level] || console.log;
    logFn(prefix, message, data || '');

    // Persist if enabled
    if (this.config.persistLogs) {
      this.appendToFile(entry);
    }
  }

  private shouldLog(category: string): boolean {
    if (this.config.verboseLogging) return true;

    switch (category) {
      case 'sync': return this.config.logSyncOps;
      case 'network': return this.config.logNetwork;
      case 'crdt': return this.config.logCrdt;
      default: return true;
    }
  }

  /**
   * Export logs for support.
   * Note: Plugin version from manifest, Obsidian version not exposed in public API.
   */
  exportLogs(manifest: PluginManifest): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      pluginVersion: manifest.version,
      platform: Platform.isMobile ? 'mobile' : 'desktop',
      logs: this.logs,
    }, null, 2);
  }

  /**
   * Export anonymized logs (removes file paths, peer IDs).
   */
  exportAnonymizedLogs(manifest: PluginManifest): string {
    const anonymized = this.logs.map(entry => ({
      ...entry,
      message: this.anonymize(entry.message),
      data: entry.data ? this.anonymizeData(entry.data) : undefined,
    }));

    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      pluginVersion: manifest.version,
      platform: Platform.isMobile ? 'mobile' : 'desktop',
      logs: anonymized,
    }, null, 2);
  }

  private anonymize(text: string): string {
    // Replace file paths
    text = text.replace(/\/[^\s]+\.(md|canvas)/g, '/[path]/[file].$1');

    // Replace peer IDs
    text = text.replace(/[a-f0-9]{32,}/gi, '[peer-id]');

    // Replace vault names
    text = text.replace(/vault:\s*\w+/gi, 'vault: [name]');

    return text;
  }

  private anonymizeData(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (key.includes('path') || key.includes('Path')) {
        result[key] = '[redacted]';
      } else if (key.includes('id') || key.includes('Id')) {
        result[key] = '[redacted]';
      } else if (typeof value === 'string') {
        result[key] = this.anonymize(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
```

### Debug Panel UI

```typescript
/**
 * Debug panel accessible via command palette.
 */
class DebugPanelModal extends Modal {
  private logger: DiagnosticLogger;

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('peervault-debug-panel');

    contentEl.createEl('h2', { text: 'PeerVault Diagnostics' });

    // Tabs
    const tabs = contentEl.createDiv({ cls: 'debug-tabs' });
    const logsTab = tabs.createEl('button', { text: 'Logs', cls: 'active' });
    const statusTab = tabs.createEl('button', { text: 'Status' });
    const actionsTab = tabs.createEl('button', { text: 'Actions' });

    const content = contentEl.createDiv({ cls: 'debug-content' });

    logsTab.onclick = () => this.showLogs(content);
    statusTab.onclick = () => this.showStatus(content);
    actionsTab.onclick = () => this.showActions(content);

    this.showLogs(content);
  }

  private showLogs(container: HTMLElement): void {
    container.empty();

    // Filter controls
    const filters = container.createDiv({ cls: 'log-filters' });

    const levelSelect = filters.createEl('select');
    ['all', 'debug', 'info', 'warn', 'error'].forEach(level => {
      levelSelect.createEl('option', { value: level, text: level });
    });

    const categorySelect = filters.createEl('select');
    ['all', 'sync', 'network', 'crdt', 'storage', 'ui'].forEach(cat => {
      categorySelect.createEl('option', { value: cat, text: cat });
    });

    const searchInput = filters.createEl('input', {
      type: 'text',
      placeholder: 'Search logs...',
    });

    // Log list
    const logList = container.createDiv({ cls: 'log-list' });
    this.renderLogs(logList, 'all', 'all', '');

    // Update on filter change
    const updateLogs = () => {
      this.renderLogs(
        logList,
        levelSelect.value,
        categorySelect.value,
        searchInput.value
      );
    };

    levelSelect.onchange = updateLogs;
    categorySelect.onchange = updateLogs;
    searchInput.oninput = updateLogs;
  }

  private renderLogs(
    container: HTMLElement,
    level: string,
    category: string,
    search: string
  ): void {
    container.empty();

    const logs = this.logger.getLogs()
      .filter(log => level === 'all' || log.level === level)
      .filter(log => category === 'all' || log.category === category)
      .filter(log => !search || log.message.toLowerCase().includes(search.toLowerCase()))
      .slice(-200); // Show last 200

    for (const log of logs) {
      const entry = container.createDiv({ cls: `log-entry log-${log.level}` });
      entry.createSpan({ text: log.timestamp.slice(11, 23), cls: 'log-time' });
      entry.createSpan({ text: log.level, cls: 'log-level' });
      entry.createSpan({ text: log.category, cls: 'log-category' });
      entry.createSpan({ text: log.message, cls: 'log-message' });

      if (log.data) {
        const dataEl = entry.createEl('pre', { cls: 'log-data' });
        dataEl.setText(JSON.stringify(log.data, null, 2));
      }
    }
  }

  private showStatus(container: HTMLElement): void {
    container.empty();

    const stats = this.plugin.getStats();

    const table = container.createEl('table', { cls: 'status-table' });

    const rows = [
      ['Plugin Version', this.plugin.manifest.version],
      ['Platform', Platform.isMobile ? 'Mobile' : 'Desktop'],
      ['Connected Peers', stats.connectedPeers.toString()],
      ['Total Peers', stats.totalPeers.toString()],
      ['Synced Files', stats.syncedFiles.toString()],
      ['Pending Changes', stats.pendingChanges.toString()],
      ['Document Size', formatBytes(stats.docSize)],
      ['Last Sync', stats.lastSync ? new Date(stats.lastSync).toLocaleString() : 'Never'],
      ['Iroh Status', stats.transportStatus],
      ['WASM Memory', formatBytes(stats.wasmMemory)],
    ];

    for (const [label, value] of rows) {
      const row = table.createEl('tr');
      row.createEl('td', { text: label });
      row.createEl('td', { text: value });
    }
  }

  private showActions(container: HTMLElement): void {
    container.empty();

    container.createEl('h3', { text: 'Diagnostic Actions' });

    // Export logs
    new Setting(container)
      .setName('Export logs')
      .setDesc('Download logs as JSON file')
      .addButton(btn => {
        btn.setButtonText('Export');
        btn.onClick(() => this.exportLogs(false));
      })
      .addButton(btn => {
        btn.setButtonText('Export (Anonymized)');
        btn.onClick(() => this.exportLogs(true));
      });

    // Force sync
    new Setting(container)
      .setName('Force full sync')
      .setDesc('Request full sync with all peers')
      .addButton(btn => {
        btn.setButtonText('Force Sync');
        btn.setWarning();
        btn.onClick(() => this.plugin.forceSyncAll());
      });

    // Rebuild index
    new Setting(container)
      .setName('Rebuild document')
      .setDesc('Rebuild CRDT document from vault files (last resort)')
      .addButton(btn => {
        btn.setButtonText('Rebuild');
        btn.setWarning();
        btn.onClick(() => this.confirmRebuild());
      });

    // Clear logs
    new Setting(container)
      .setName('Clear logs')
      .setDesc('Clear in-memory and persisted logs')
      .addButton(btn => {
        btn.setButtonText('Clear');
        btn.onClick(() => {
          this.logger.clear();
          new Notice('Logs cleared');
        });
      });

    // Copy support info
    new Setting(container)
      .setName('Copy support info')
      .setDesc('Copy system info to clipboard for bug reports')
      .addButton(btn => {
        btn.setButtonText('Copy');
        btn.onClick(() => this.copySupportInfo());
      });
  }

  private async exportLogs(anonymized: boolean): Promise<void> {
    const content = anonymized
      ? this.logger.exportAnonymizedLogs()
      : this.logger.exportLogs();

    const filename = `peervault-logs-${Date.now()}.json`;
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
    new Notice(`Logs exported to ${filename}`);
  }

  private copySupportInfo(): void {
    const stats = this.plugin.getStats();
    const info = `
PeerVault Support Info
======================
Plugin Version: ${this.plugin.manifest.version}
Platform: ${Platform.isMobile ? 'Mobile' : 'Desktop'}
OS: ${Platform.isIosApp ? 'iOS' : Platform.isAndroidApp ? 'Android' : navigator.platform}
Connected Peers: ${stats.connectedPeers}
Document Size: ${formatBytes(stats.docSize)}
Last Sync: ${stats.lastSync ? new Date(stats.lastSync).toISOString() : 'Never'}
WASM Memory: ${formatBytes(stats.wasmMemory)}
    `.trim();

    navigator.clipboard.writeText(info);
    new Notice('Support info copied to clipboard');
  }
}
```

### Debug Commands

```typescript
// Register debug commands
this.addCommand({
  id: 'open-debug-panel',
  name: 'Open debug panel',
  callback: () => new DebugPanelModal(this.app, this).open(),
});

this.addCommand({
  id: 'toggle-verbose-logging',
  name: 'Toggle verbose logging',
  callback: () => {
    this.settings.debug.verboseLogging = !this.settings.debug.verboseLogging;
    new Notice(`Verbose logging ${this.settings.debug.verboseLogging ? 'enabled' : 'disabled'}`);
  },
});

this.addCommand({
  id: 'export-debug-logs',
  name: 'Export debug logs',
  callback: () => this.exportDebugLogs(),
});
```

### Debug CSS

```css
.peervault-debug-panel {
  min-width: 600px;
}

.debug-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--background-modifier-border);
  padding-bottom: 8px;
}

.debug-tabs button {
  padding: 8px 16px;
  background: none;
  border: none;
  cursor: pointer;
}

.debug-tabs button.active {
  border-bottom: 2px solid var(--interactive-accent);
}

.log-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.log-list {
  max-height: 400px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 12px;
}

.log-entry {
  padding: 4px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.log-debug { opacity: 0.7; }
.log-warn { background: var(--background-modifier-warning); }
.log-error { background: var(--background-modifier-error); }

.log-time { color: var(--text-muted); margin-right: 8px; }
.log-level { font-weight: bold; margin-right: 8px; text-transform: uppercase; }
.log-category { color: var(--text-accent); margin-right: 8px; }

.log-data {
  margin: 4px 0 0 20px;
  padding: 4px;
  background: var(--background-secondary);
  font-size: 11px;
  max-height: 100px;
  overflow: auto;
}

.status-table {
  width: 100%;
}

.status-table td {
  padding: 8px;
  border-bottom: 1px solid var(--background-modifier-border);
}

.status-table td:first-child {
  font-weight: 500;
  width: 40%;
}
```

## Dependencies

```json
{
  "dependencies": {
    "loro-crdt": "^1.0.0"
  }
}
```

- Obsidian Notice API for user notifications
- Console API for development logging
