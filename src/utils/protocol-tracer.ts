/**
 * Protocol Tracer - Detailed tracing for transport and sync protocol debugging
 *
 * Provides structured trace events with correlation IDs that can be exported
 * and correlated across multiple Obsidian instances.
 */

import type { App } from "obsidian";

export type TraceLevel = "minimal" | "standard" | "verbose";
export type TraceCategory = "transport" | "sync" | "blob" | "peer" | "crdt" | "vault" | "plugin";

/**
 * A single trace event capturing protocol activity.
 */
export interface TraceEvent {
  /** Unix timestamp in milliseconds */
  ts: number;
  /** Session correlation ID (e.g., "cf5b-1706-abc") */
  sid: string;
  /** Shortened peer ID (8 chars) */
  pid: string;
  /** Stream identifier (optional) */
  stm?: string;
  /** Event category */
  cat: TraceCategory;
  /** Event name (e.g., "message.sent", "state.changed") */
  evt: string;
  /** Additional event data */
  data?: Record<string, unknown>;
  /** Duration in milliseconds (for timed operations) */
  dur?: number;
}

/**
 * Configuration for which events to trace at each level.
 */
const TRACE_LEVEL_CONFIG: Record<TraceLevel, Set<string>> = {
  minimal: new Set([
    // State changes and lifecycle only
    "session.started",
    "session.ended",
    "state.changed",
    "error",
    "connection.opened",
    "connection.closed",
  ]),
  standard: new Set([
    // Minimal + message flow
    "session.started",
    "session.ended",
    "state.changed",
    "error",
    "connection.opened",
    "connection.closed",
    "message.sending",
    "message.sent",
    "message.receiving",
    "message.received",
    "message.timeout",
    "stream.opened",
    "stream.closed",
    "stream.pending",
    "stream.callback.registered",
    "stream.callback.fired",
    "stream.handling",
  ]),
  verbose: new Set([
    // All events
    "*",
  ]),
};

/**
 * Check if an event should be traced at the given level.
 */
function shouldTrace(level: TraceLevel, event: string): boolean {
  const config = TRACE_LEVEL_CONFIG[level];
  return config.has("*") || config.has(event);
}

/**
 * Generate a short session ID for correlation.
 * Format: {first4chars-of-peerId}-{timestamp-suffix}-{random}
 */
function generateSessionId(peerId: string): string {
  const peerPart = peerId.slice(0, 4);
  const timePart = (Date.now() % 10000).toString(36);
  const randPart = Math.random().toString(36).slice(2, 5);
  return `${peerPart}-${timePart}-${randPart}`;
}

/**
 * Protocol Tracer for detailed debugging of transport and sync protocols.
 *
 * Features:
 * - Session-based correlation IDs
 * - Configurable trace levels (minimal/standard/verbose)
 * - Ring buffer with configurable size
 * - NDJSON export to clipboard and file
 * - Automatic file rotation
 */
export class ProtocolTracer {
  private enabled = false;
  private level: TraceLevel = "standard";
  private events: TraceEvent[] = [];
  private maxEvents = 1000;
  private activeSessions = new Map<string, { peerId: string; startTime: number }>();
  private app: App | null = null;
  private traceFilePath = ".peervault/traces.ndjson";
  private maxFileSizeBytes = 10 * 1024 * 1024; // 10 MB
  private writeQueue: TraceEvent[] = [];
  private writeInProgress = false;

  /**
   * Initialize the tracer with an Obsidian App instance for file operations.
   */
  initialize(app: App): void {
    this.app = app;
  }

  /**
   * Enable or disable tracing.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if tracing is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Set the trace level.
   */
  setLevel(level: TraceLevel): void {
    this.level = level;
  }

  /**
   * Get the current trace level.
   */
  getLevel(): TraceLevel {
    return this.level;
  }

  /**
   * Set the maximum number of events to keep in the ring buffer.
   */
  setMaxEvents(max: number): void {
    this.maxEvents = max;
    this.trimBuffer();
  }

  /**
   * Start a new trace session for a peer.
   * Returns a session ID that should be used for all subsequent trace calls.
   */
  startSession(peerId: string): string {
    if (!this.enabled) return "";

    const sessionId = generateSessionId(peerId);
    this.activeSessions.set(sessionId, {
      peerId,
      startTime: Date.now(),
    });

    this.trace(sessionId, peerId, "sync", "session.started", {
      role: "unknown", // Will be updated by caller
    });

    return sessionId;
  }

  /**
   * End a trace session.
   */
  endSession(sessionId: string, finalState?: string): void {
    if (!this.enabled || !sessionId) return;

    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const durationMs = Date.now() - session.startTime;
    this.trace(sessionId, session.peerId, "sync", "session.ended", {
      finalState,
      durationMs,
    });

    this.activeSessions.delete(sessionId);
  }

  /**
   * Record a trace event.
   *
   * @param sessionId - Correlation ID from startSession (or empty if no session)
   * @param peerId - Full or partial peer ID
   * @param category - Event category
   * @param event - Event name (e.g., "message.sent")
   * @param data - Optional event data
   * @param durationMs - Optional duration for timed operations
   */
  trace(
    sessionId: string,
    peerId: string,
    category: TraceCategory,
    event: string,
    data?: Record<string, unknown>,
    durationMs?: number,
  ): void {
    if (!this.enabled) return;
    if (!shouldTrace(this.level, event)) return;

    const traceEvent: TraceEvent = {
      ts: Date.now(),
      sid: sessionId || "no-session",
      pid: peerId.slice(0, 8),
      cat: category,
      evt: event,
    };

    if (data && Object.keys(data).length > 0) {
      traceEvent.data = data;
    }

    if (durationMs !== undefined) {
      traceEvent.dur = durationMs;
    }

    this.events.push(traceEvent);
    this.trimBuffer();

    // Queue for file write
    this.writeQueue.push(traceEvent);
    this.flushWriteQueue();
  }

  /**
   * Record a trace event with a stream ID.
   */
  traceStream(
    sessionId: string,
    peerId: string,
    streamId: string,
    category: TraceCategory,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.enabled) return;
    if (!shouldTrace(this.level, event)) return;

    const traceEvent: TraceEvent = {
      ts: Date.now(),
      sid: sessionId || "no-session",
      pid: peerId.slice(0, 8),
      stm: streamId.slice(0, 8),
      cat: category,
      evt: event,
    };

    if (data && Object.keys(data).length > 0) {
      traceEvent.data = data;
    }

    this.events.push(traceEvent);
    this.trimBuffer();

    // Queue for file write
    this.writeQueue.push(traceEvent);
    this.flushWriteQueue();
  }

  /**
   * Time an async operation and record it as a trace.
   */
  async traceWithDuration<T>(
    sessionId: string,
    peerId: string,
    category: TraceCategory,
    event: string,
    fn: () => Promise<T>,
    data?: Record<string, unknown>,
  ): Promise<T> {
    const startTime = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;
      this.trace(sessionId, peerId, category, event, data, durationMs);
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.trace(sessionId, peerId, category, "error", {
        ...data,
        event,
        errorMessage: error instanceof Error ? error.message : String(error),
        durationMs,
      });
      throw error;
    }
  }

  /**
   * Get all events for a specific session.
   */
  getSessionTrace(sessionId: string): TraceEvent[] {
    return this.events.filter((e) => e.sid === sessionId);
  }

  /**
   * Get all events in the buffer.
   */
  getAllEvents(): TraceEvent[] {
    return [...this.events];
  }

  /**
   * Get recent events (last N).
   */
  getRecentEvents(count = 100): TraceEvent[] {
    return this.events.slice(-count);
  }

  /**
   * Export all events as NDJSON string.
   */
  exportAsNdjson(count?: number): string {
    const events = count ? this.events.slice(-count) : this.events;
    return events.map((e) => JSON.stringify(e)).join("\n");
  }

  /**
   * Clear all events from the buffer.
   */
  clear(): void {
    this.events = [];
    this.activeSessions.clear();
    this.writeQueue = [];
  }

  /**
   * Get the number of events in the buffer.
   */
  getEventCount(): number {
    return this.events.length;
  }

  /**
   * Get active session count.
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Copy traces to clipboard.
   */
  async copyToClipboard(count?: number): Promise<void> {
    const ndjson = this.exportAsNdjson(count);
    await navigator.clipboard.writeText(ndjson);
  }

  /**
   * Trim the buffer to the maximum size.
   */
  private trimBuffer(): void {
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  /**
   * Flush the write queue to the trace file.
   */
  private async flushWriteQueue(): Promise<void> {
    if (!this.app || this.writeInProgress || this.writeQueue.length === 0) {
      return;
    }

    this.writeInProgress = true;

    try {
      const vault = this.app.vault;

      // Ensure .peervault directory exists
      const dirPath = ".peervault";
      const dirExists = await vault.adapter.exists(dirPath);
      if (!dirExists) {
        await vault.adapter.mkdir(dirPath);
      }

      // Check if file needs rotation
      const fileExists = await vault.adapter.exists(this.traceFilePath);
      if (fileExists) {
        const stat = await vault.adapter.stat(this.traceFilePath);
        if (stat && stat.size > this.maxFileSizeBytes) {
          // Rotate: delete old file (simple rotation)
          await vault.adapter.remove(this.traceFilePath);
        }
      }

      // Take all queued events
      const eventsToWrite = this.writeQueue.splice(0, this.writeQueue.length);
      const ndjson = eventsToWrite.map((e) => JSON.stringify(e)).join("\n") + "\n";

      // Append to file
      if (fileExists) {
        const existing = await vault.adapter.read(this.traceFilePath);
        await vault.adapter.write(this.traceFilePath, existing + ndjson);
      } else {
        await vault.adapter.write(this.traceFilePath, ndjson);
      }
    } catch (error) {
      // Re-queue failed events (at front)
      // But limit to prevent infinite growth on persistent errors
      if (this.writeQueue.length < 100) {
        console.warn("[ProtocolTracer] Failed to write traces:", error);
      }
    } finally {
      this.writeInProgress = false;

      // If more events accumulated during write, flush again
      if (this.writeQueue.length > 0) {
        setTimeout(() => this.flushWriteQueue(), 100);
      }
    }
  }

  /**
   * Force flush all pending writes to file.
   */
  async flush(): Promise<void> {
    // Wait for any in-progress write
    while (this.writeInProgress) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // Flush remaining
    await this.flushWriteQueue();
  }

  /**
   * Get the trace file path.
   */
  getTraceFilePath(): string {
    return this.traceFilePath;
  }

  /**
   * Read traces from the file.
   */
  async readTraceFile(): Promise<TraceEvent[]> {
    if (!this.app) return [];

    try {
      const exists = await this.app.vault.adapter.exists(this.traceFilePath);
      if (!exists) return [];

      const content = await this.app.vault.adapter.read(this.traceFilePath);
      const lines = content.trim().split("\n").filter((l) => l);
      return lines.map((line) => JSON.parse(line) as TraceEvent);
    } catch (error) {
      console.warn("[ProtocolTracer] Failed to read trace file:", error);
      return [];
    }
  }

  /**
   * Clear the trace file.
   */
  async clearTraceFile(): Promise<void> {
    if (!this.app) return;

    try {
      const exists = await this.app.vault.adapter.exists(this.traceFilePath);
      if (exists) {
        await this.app.vault.adapter.remove(this.traceFilePath);
      }
    } catch (error) {
      console.warn("[ProtocolTracer] Failed to clear trace file:", error);
    }
  }
}

/**
 * Global protocol tracer instance.
 */
export const protocolTracer = new ProtocolTracer();

/**
 * Convenience function to get the global tracer.
 */
export function getProtocolTracer(): ProtocolTracer {
  return protocolTracer;
}
