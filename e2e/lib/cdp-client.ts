/**
 * Chrome DevTools Protocol Client
 *
 * WebSocket client for communicating with Obsidian via CDP.
 * Enables JavaScript evaluation and console log collection.
 */

import { config } from "../config";

/** CDP protocol message */
interface CDPMessage {
  id: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string; code?: number };
}

/** Evaluate result from CDP */
export interface CDPEvaluateResult<T> {
  success: boolean;
  value?: T;
  error?: string;
}

/** Console message from CDP */
export interface ConsoleMessage {
  type: "log" | "debug" | "info" | "warn" | "error";
  text: string;
  timestamp: number;
}

/** Filter for console messages */
export interface ConsoleFilter {
  types?: ConsoleMessage["type"][];
  textContains?: string;
}

/** CDP Client options */
export interface CDPClientOptions {
  connectionTimeout?: number;
  evaluateTimeout?: number;
  /** Maximum number of console messages to retain (default: 1000) */
  maxConsoleMessages?: number;
  /** Maximum reconnection attempts (default: 3) */
  maxReconnectAttempts?: number;
  /** Delay between reconnection attempts in ms (default: 1000) */
  reconnectDelay?: number;
  /** Whether to auto-reconnect on connection loss (default: true) */
  autoReconnect?: boolean;
}

/**
 * CDP Client for communicating with an Obsidian vault window.
 */
export class CDPClient {
  readonly id: string;
  readonly wsUrl: string;

  private ws: WebSocket | null = null;
  private messageId = 0;
  private pendingMessages = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private consoleMessages: ConsoleMessage[] = [];
  private consoleEnabled = false;
  private options: Required<CDPClientOptions>;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private intentionallyClosed = false;

  /** Maximum console messages to retain before dropping oldest */
  private static readonly DEFAULT_MAX_CONSOLE_MESSAGES = 1000;
  private static readonly DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly DEFAULT_RECONNECT_DELAY = 1000;

  constructor(wsUrl: string, options: CDPClientOptions = {}) {
    this.id = `cdp-${Date.now()}`;
    this.wsUrl = wsUrl;
    this.options = {
      connectionTimeout: options.connectionTimeout ?? config.cdp.connectionTimeout,
      evaluateTimeout: options.evaluateTimeout ?? config.cdp.evaluateTimeout,
      maxConsoleMessages: options.maxConsoleMessages ?? CDPClient.DEFAULT_MAX_CONSOLE_MESSAGES,
      maxReconnectAttempts: options.maxReconnectAttempts ?? CDPClient.DEFAULT_MAX_RECONNECT_ATTEMPTS,
      reconnectDelay: options.reconnectDelay ?? CDPClient.DEFAULT_RECONNECT_DELAY,
      autoReconnect: options.autoReconnect ?? true,
    };
  }

  /**
   * Connect to the CDP WebSocket endpoint.
   */
  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`CDP connection timeout`));
      }, this.options.connectionTimeout);

      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.setupMessageHandler();
        resolve();
      };

      this.ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(new Error(`CDP connection error: ${err}`));
      };

      this.ws.onclose = () => {
        // Reject any pending messages
        for (const [id, pending] of this.pendingMessages) {
          clearTimeout(pending.timer);
          pending.reject(new Error("CDP connection closed"));
          this.pendingMessages.delete(id);
        }

        // Trigger auto-reconnect if enabled and not intentionally closed
        if (this.options.autoReconnect && !this.intentionallyClosed && !this.reconnecting) {
          this.attemptReconnect();
        }
      };
    });
  }

  /**
   * Attempt to reconnect after connection loss.
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting || this.intentionallyClosed) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error(`[CDP] Max reconnect attempts (${this.options.maxReconnectAttempts}) reached`);
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;

    console.log(`[CDP] Attempting reconnect ${this.reconnectAttempts}/${this.options.maxReconnectAttempts}...`);

    // Wait before reconnecting
    await new Promise((r) => setTimeout(r, this.options.reconnectDelay));

    try {
      await this.connect();
      // Re-enable console if it was enabled before
      if (this.consoleEnabled) {
        this.consoleEnabled = false; // Reset flag so enableConsole() runs
        await this.enableConsole();
      }
      console.log(`[CDP] Reconnected successfully`);
      this.reconnectAttempts = 0;
    } catch (err) {
      console.warn(`[CDP] Reconnect attempt ${this.reconnectAttempts} failed:`, err);
      // attemptReconnect will be called again by onclose handler
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Ensure connection is active, attempting reconnect if needed.
   * Call this before operations that require a connection.
   */
  async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;

    if (this.intentionallyClosed) {
      throw new Error("CDP client was closed intentionally");
    }

    // Try to reconnect
    if (!this.reconnecting) {
      await this.attemptReconnect();
    }

    // Wait for reconnection to complete
    const maxWait = this.options.maxReconnectAttempts * (this.options.reconnectDelay + this.options.connectionTimeout);
    const startTime = Date.now();

    while (!this.isConnected() && Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!this.isConnected()) {
      throw new Error("CDP client not connected and reconnection failed");
    }
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.onmessage = (event) => {
      const msg: CDPMessage = JSON.parse(event.data as string);

      // Handle console messages
      if (msg.method === "Console.messageAdded" || msg.method === "Runtime.consoleAPICalled") {
        const text =
          (msg.params as { message?: { text?: string }; args?: Array<{ value?: string }> })?.message
            ?.text ||
          (msg.params as { args?: Array<{ value?: string }> })?.args?.[0]?.value ||
          "";

        this.consoleMessages.push({
          type: this.getConsoleType(msg.method, msg.params),
          text,
          timestamp: Date.now(),
        });

        // Enforce bounded buffer - remove oldest messages when limit exceeded
        if (this.consoleMessages.length > this.options.maxConsoleMessages) {
          this.consoleMessages = this.consoleMessages.slice(-this.options.maxConsoleMessages);
        }
        return;
      }

      // Handle response messages
      if (msg.id !== undefined) {
        const pending = this.pendingMessages.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingMessages.delete(msg.id);

          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    };
  }

  private getConsoleType(
    method: string,
    params: unknown
  ): ConsoleMessage["type"] {
    if (method === "Runtime.consoleAPICalled") {
      const type = (params as { type?: string })?.type;
      if (type === "warning") return "warn";
      if (type === "error") return "error";
      if (type === "debug") return "debug";
      if (type === "info") return "info";
    }
    return "log";
  }

  /**
   * Send a CDP command and wait for response.
   * Automatically attempts reconnection if not connected.
   */
  private async sendCommand(
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    // Ensure we're connected, attempt reconnect if needed
    await this.ensureConnected();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP client not connected");
    }

    const id = ++this.messageId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, this.options.evaluateTimeout);

      this.pendingMessages.set(id, { resolve, reject, timer });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Enable console message collection.
   */
  async enableConsole(): Promise<void> {
    if (this.consoleEnabled) return;

    await this.sendCommand("Runtime.enable");
    await this.sendCommand("Console.enable");
    this.consoleEnabled = true;
  }

  /**
   * Evaluate JavaScript expression in the Obsidian context.
   * Returns the value directly (must be JSON-serializable).
   */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    const evalResult = result as {
      result?: { value?: T; type?: string; description?: string };
      exceptionDetails?: { exception?: { description?: string } };
    };

    if (evalResult.exceptionDetails) {
      throw new Error(
        evalResult.exceptionDetails.exception?.description || "Evaluation error"
      );
    }

    return evalResult.result?.value as T;
  }

  /**
   * Evaluate with explicit result handling.
   */
  async evaluateWithResult<T>(expression: string): Promise<CDPEvaluateResult<T>> {
    try {
      const value = await this.evaluate<T>(expression);
      return { success: true, value };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get collected console messages, optionally filtered.
   */
  getConsoleMessages(filter?: ConsoleFilter): ConsoleMessage[] {
    let messages = [...this.consoleMessages];

    if (filter?.types) {
      messages = messages.filter((m) => filter.types!.includes(m.type));
    }

    if (filter?.textContains) {
      const search = filter.textContains.toLowerCase();
      messages = messages.filter((m) => m.text.toLowerCase().includes(search));
    }

    return messages;
  }

  /**
   * Clear collected console messages.
   */
  clearConsoleMessages(): void {
    this.consoleMessages = [];
  }

  /**
   * Close the CDP connection.
   */
  async close(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pendingMessages.clear();
    this.consoleMessages = [];
  }

  /**
   * Check if the client is connected.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

/**
 * Create a CDP client and connect to a vault.
 */
export async function createCDPClient(
  wsUrl: string,
  options?: CDPClientOptions
): Promise<CDPClient> {
  const client = new CDPClient(wsUrl, options);
  await client.connect();
  await client.enableConsole();
  return client;
}
