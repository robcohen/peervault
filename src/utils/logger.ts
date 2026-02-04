/**
 * Logger - Structured logging with debug mode support
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Patterns for sensitive data that should be redacted in logs.
 */
const SENSITIVE_PATTERNS = [
  // Node IDs (64-char hex strings)
  { pattern: /\b[a-f0-9]{64}\b/gi, replacement: "[NODE_ID]" },
  // Iroh tickets
  { pattern: /iroh:\/\/[a-zA-Z0-9_-]+/g, replacement: "[TICKET]" },
  // Base64-encoded keys (32+ chars)
  { pattern: /\b[A-Za-z0-9+/]{32,}={0,2}\b/g, replacement: "[KEY]" },
] as const;

/**
 * Redact sensitive information from a string.
 */
function redactSensitive(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Log entry for the buffer */
export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  prefix: string;
  message: string;
  /** Structured event name (e.g., "sync.started", "peer.connected") */
  event?: string;
  /** Structured metadata */
  data?: Record<string, unknown>;
}

/** Structured log event for machine-parseable logs */
export interface StructuredLogEvent {
  event: string;
  data?: Record<string, unknown>;
}

/** Log level priority for filtering */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Minimum log level for console output (default: info) */
let minLogLevel: LogLevel = "info";

/** Global log buffer for "Copy Logs" feature */
const LOG_BUFFER: LogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

function addToBuffer(
  level: LogLevel,
  prefix: string,
  args: unknown[],
  event?: string,
  data?: Record<string, unknown>,
): void {
  const message = args.map(arg => {
    let str: string;
    if (arg instanceof Error) {
      str = `${arg.name}: ${arg.message}`;
    } else if (typeof arg === "object") {
      try { str = JSON.stringify(arg); } catch { str = String(arg); }
    } else {
      str = String(arg);
    }
    // Redact sensitive data in log buffer
    return redactSensitive(str);
  }).join(" ");

  // Redact sensitive data from structured data
  const redactedData = data ? redactDataObject(data) : undefined;

  LOG_BUFFER.push({ timestamp: Date.now(), level, prefix, message, event, data: redactedData });

  // Trim buffer if too large
  if (LOG_BUFFER.length > MAX_LOG_ENTRIES) {
    LOG_BUFFER.splice(0, LOG_BUFFER.length - MAX_LOG_ENTRIES);
  }
}

/**
 * Redact sensitive data from an object.
 */
function redactDataObject(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      result[key] = redactSensitive(value);
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactDataObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Check if a log level should be output based on minimum level.
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[minLogLevel];
}

/**
 * Set the minimum log level for console output.
 */
export function setMinLogLevel(level: LogLevel): void {
  minLogLevel = level;
}

/**
 * Get the current minimum log level.
 */
export function getMinLogLevel(): LogLevel {
  return minLogLevel;
}

/** Get all buffered logs as a string */
export function getLogBuffer(): string {
  return LOG_BUFFER.map(entry => {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    return `${time} [${entry.level.toUpperCase().padEnd(5)}] ${entry.prefix} ${entry.message}`;
  }).join("\n");
}

/** Clear the log buffer */
export function clearLogBuffer(): void {
  LOG_BUFFER.length = 0;
}

/** Get recent logs (last N entries) */
export function getRecentLogs(count = 100): string {
  const recent = LOG_BUFFER.slice(-count);
  return recent.map(entry => {
    const time = new Date(entry.timestamp).toISOString().slice(11, 23);
    return `${time} [${entry.level.toUpperCase().padEnd(5)}] ${entry.prefix} ${entry.message}`;
  }).join("\n");
}

/** Get logs as JSON array for machine parsing */
export function getLogsAsJson(count?: number): LogEntry[] {
  const logs = count ? LOG_BUFFER.slice(-count) : [...LOG_BUFFER];
  return logs;
}

/** Get only structured events (logs with event names) */
export function getStructuredEvents(count?: number): LogEntry[] {
  const logs = LOG_BUFFER.filter(entry => entry.event);
  return count ? logs.slice(-count) : logs;
}

/** Export logs as NDJSON (newline-delimited JSON) for log aggregation */
export function exportLogsAsNdjson(count?: number): string {
  const logs = count ? LOG_BUFFER.slice(-count) : LOG_BUFFER;
  return logs.map(entry => JSON.stringify(entry)).join("\n");
}

/** Filter logs by level */
export function getLogsByLevel(level: LogLevel, count?: number): LogEntry[] {
  const minPriority = LOG_LEVEL_PRIORITY[level];
  const filtered = LOG_BUFFER.filter(
    entry => LOG_LEVEL_PRIORITY[entry.level] >= minPriority,
  );
  return count ? filtered.slice(-count) : filtered;
}

export class Logger {
  private readonly prefix: string;

  constructor(
    name: string,
    private isDebugEnabled: () => boolean = () => false,
  ) {
    this.prefix = `[${name}]`;
  }

  /**
   * Create a child logger with a sub-prefix.
   */
  child(name: string): Logger {
    return new Logger(
      `${this.prefix.slice(1, -1)}:${name}`,
      this.isDebugEnabled,
    );
  }

  /**
   * Log a debug message (only in debug mode).
   */
  debug(...args: unknown[]): void {
    addToBuffer("debug", this.prefix, args);
    if (this.isDebugEnabled() && shouldLog("debug")) {
      console.debug(this.prefix, ...args);
    }
  }

  /**
   * Log an info message.
   */
  info(...args: unknown[]): void {
    addToBuffer("info", this.prefix, args);
    if (shouldLog("info")) {
      console.info(this.prefix, ...args);
    }
  }

  /**
   * Log a warning message.
   */
  warn(...args: unknown[]): void {
    addToBuffer("warn", this.prefix, args);
    if (shouldLog("warn")) {
      console.warn(this.prefix, ...args);
    }
  }

  /**
   * Log an error message.
   */
  error(...args: unknown[]): void {
    addToBuffer("error", this.prefix, args);
    if (shouldLog("error")) {
      console.error(this.prefix, ...args);
    }
  }

  /**
   * Log a structured event with optional data.
   * Useful for machine-parseable logs and analytics.
   *
   * @param level Log level
   * @param event Event name (e.g., "sync.started", "peer.connected")
   * @param data Optional structured data
   * @param message Optional human-readable message
   */
  event(
    level: LogLevel,
    event: string,
    data?: Record<string, unknown>,
    message?: string,
  ): void {
    const displayMessage = message || event;
    const args: unknown[] = [displayMessage];
    if (data) {
      args.push(data);
    }
    addToBuffer(level, this.prefix, args, event, data);

    // Only output to console if level is enabled
    const shouldOutput = level === "debug"
      ? this.isDebugEnabled() && shouldLog(level)
      : shouldLog(level);

    if (shouldOutput) {
      const consoleMethod = console[level] || console.log;
      if (data) {
        consoleMethod(this.prefix, displayMessage, data);
      } else {
        consoleMethod(this.prefix, displayMessage);
      }
    }
  }

  /**
   * Log with a specific level.
   */
  log(level: LogLevel, ...args: unknown[]): void {
    switch (level) {
      case "debug":
        this.debug(...args);
        break;
      case "info":
        this.info(...args);
        break;
      case "warn":
        this.warn(...args);
        break;
      case "error":
        this.error(...args);
        break;
    }
  }

  /**
   * Time an async operation.
   */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const duration = performance.now() - start;
      this.debug(`${label} completed in ${duration.toFixed(2)}ms`);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.error(`${label} failed after ${duration.toFixed(2)}ms:`, error);
      throw error;
    }
  }

  /**
   * Time a sync operation.
   */
  timeSync<T>(label: string, fn: () => T): T {
    const start = performance.now();
    try {
      const result = fn();
      const duration = performance.now() - start;
      this.debug(`${label} completed in ${duration.toFixed(2)}ms`);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.error(`${label} failed after ${duration.toFixed(2)}ms:`, error);
      throw error;
    }
  }
}

/**
 * Global logger instance.
 */
let globalDebugEnabled = false;

export function setGlobalDebugMode(enabled: boolean): void {
  globalDebugEnabled = enabled;
}

export function createLogger(name: string): Logger {
  return new Logger(name, () => globalDebugEnabled);
}
