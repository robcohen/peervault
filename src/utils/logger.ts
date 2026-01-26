/**
 * Logger - Structured logging with debug mode support
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

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
    if (this.isDebugEnabled()) {
      console.debug(this.prefix, ...args);
    }
  }

  /**
   * Log an info message.
   */
  info(...args: unknown[]): void {
    console.info(this.prefix, ...args);
  }

  /**
   * Log a warning message.
   */
  warn(...args: unknown[]): void {
    console.warn(this.prefix, ...args);
  }

  /**
   * Log an error message.
   */
  error(...args: unknown[]): void {
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
