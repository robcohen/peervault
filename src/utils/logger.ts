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
}

/** Global log buffer for "Copy Logs" feature */
const LOG_BUFFER: LogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

function addToBuffer(level: LogLevel, prefix: string, args: unknown[]): void {
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

  LOG_BUFFER.push({ timestamp: Date.now(), level, prefix, message });

  // Trim buffer if too large
  if (LOG_BUFFER.length > MAX_LOG_ENTRIES) {
    LOG_BUFFER.splice(0, LOG_BUFFER.length - MAX_LOG_ENTRIES);
  }
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
    if (this.isDebugEnabled()) {
      console.debug(this.prefix, ...args);
    }
  }

  /**
   * Log an info message.
   */
  info(...args: unknown[]): void {
    addToBuffer("info", this.prefix, args);
    console.info(this.prefix, ...args);
  }

  /**
   * Log a warning message.
   */
  warn(...args: unknown[]): void {
    addToBuffer("warn", this.prefix, args);
    console.warn(this.prefix, ...args);
  }

  /**
   * Log an error message.
   */
  error(...args: unknown[]): void {
    addToBuffer("error", this.prefix, args);
    console.error(this.prefix, ...args);
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
