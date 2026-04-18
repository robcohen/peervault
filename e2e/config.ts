/**
 * E2E Test Configuration
 *
 * Configuration for CDP connections, vault paths, and test settings.
 */

export interface E2EConfig {
  /** CDP (Chrome DevTools Protocol) settings */
  cdp: {
    /** DevTools host (default: localhost) */
    host: string;
    /** DevTools port (Obsidian must be started with --remote-debugging-port) */
    port: number;
    /** Timeout for establishing WebSocket connection */
    connectionTimeout: number;
    /** Timeout for evaluate() calls */
    evaluateTimeout: number;
    /** Retry count for transient failures */
    retryCount: number;
    /** Delay between retries in ms */
    retryDelay: number;
  };

  /** Transport settings */
  transport: {
    /** Relay URL for P2P connections (local relay for E2E testing) */
    relayUrl: string;
  };

  /** Vault configuration */
  vaults: {
    TEST: { name: string; path: string };
    TEST2: { name: string; path: string };
    TEST3?: { name: string; path: string };
  };

  /** Sync operation settings */
  sync: {
    /** Default timeout for waiting for sync completion */
    defaultTimeout: number;
    /** Timeout for pairing operations */
    pairingTimeout: number;
    /** Timeout for waiting for CRDT convergence */
    convergenceTimeout: number;
    /** Timeout for peer connection establishment */
    connectionTimeout: number;
    /** Timeout for session to reach live state */
    liveSessionTimeout: number;
    /** Delay to allow operations to settle before checking state */
    settleDelay: number;
    /** Polling interval for sync status checks */
    pollInterval: number;
    /** Minimum poll interval for exponential backoff */
    minPollInterval: number;
    /** Maximum poll interval for exponential backoff */
    maxPollInterval: number;
    /** Backoff multiplier */
    backoffMultiplier: number;
  };

  /** Fixture settings */
  fixtures: {
    /** Path to fixture files */
    path: string;
  };

  /** Logging settings */
  logging: {
    /** Enable verbose logging */
    verbose: boolean;
    /** Collect console logs from vaults */
    collectConsoleLogs: boolean;
  };
}

export const config: E2EConfig = {
  cdp: {
    host: "localhost",
    port: 9222,
    connectionTimeout: 10000,
    evaluateTimeout: 30000,
    retryCount: 3,
    retryDelay: 1000,
  },
  transport: {
    relayUrl: process.env.E2E_RELAY_URL || "http://localhost:3340",
  },
  vaults: {
    TEST: {
      name: "TEST",
      path: "/home/user/Documents/TEST",
    },
    TEST2: {
      name: "TEST2",
      path: "/home/user/Documents/TEST2",
    },
    TEST3: {
      name: "TEST3",
      path: "/home/user/Documents/TEST3",
    },
  },
  sync: {
    defaultTimeout: 20000,
    pairingTimeout: 60000,      // 60s for pairing (includes relay connection)
    convergenceTimeout: 30000,  // 30s for CRDT convergence
    connectionTimeout: 30000,   // 30s for peer connection
    liveSessionTimeout: 60000,  // 60s for session to reach live state
    settleDelay: 3000,          // 3s settle delay after concurrent operations
    pollInterval: 100,
    minPollInterval: 50,
    maxPollInterval: 500,
    backoffMultiplier: 1.5,
  },
  fixtures: {
    path: "./e2e/fixtures",
  },
  logging: {
    verbose: process.argv.includes("--verbose"),
    collectConsoleLogs: true,
  },
};

/** Check if --slow flag is set */
export const isSlowMode = process.argv.includes("--slow");

/** Check if running in Docker mode (skip reinstall tests) */
export const isDockerMode = process.argv.includes("--docker") ||
  process.env.E2E_DOCKER === "1";

/** Check if using mock transport (fast mode) */
export const isMockTransport = process.argv.includes("--mock") ||
  process.argv.some(arg => arg.startsWith("--transport=mock"));

/** CDP endpoint for a client */
export interface CDPEndpoint {
  host: string;
  port: number;
  name: string;
}

/** Get number of clients from --clients=N argument */
export function getNumClients(): number {
  const clientsArg = process.argv.find(arg => arg.startsWith("--clients="));
  if (clientsArg) {
    return parseInt(clientsArg.split("=")[1], 10) || 3;
  }
  return 3; // Default to 3 clients
}

/**
 * Parse CDP endpoints from environment or generate defaults.
 * E2E_CDP_ENDPOINTS format: "host1:port1,host2:port2,..."
 * Example: "localhost:9222,localhost:9223,localhost:9224"
 */
export function getCDPEndpoints(): CDPEndpoint[] {
  const endpointsStr = process.env.E2E_CDP_ENDPOINTS;

  if (endpointsStr) {
    // Parse from environment variable
    return endpointsStr.split(",").map((endpoint, index) => {
      const [host, portStr] = endpoint.trim().split(":");
      return {
        host: host || "localhost",
        port: parseInt(portStr, 10) || (9222 + index),
        name: `client-${index + 1}`,
      };
    });
  }

  // Default: generate endpoints based on --clients argument
  const numClients = getNumClients();
  const endpoints: CDPEndpoint[] = [];

  for (let i = 0; i < numClients; i++) {
    endpoints.push({
      host: "localhost",
      port: 9222 + i,
      name: `client-${i + 1}`,
    });
  }

  return endpoints;
}

/** Check if running in scaled mode (multiple separate containers) */
export const isScaledMode = !!process.env.E2E_CDP_ENDPOINTS ||
  process.argv.some(arg => arg.startsWith("--clients="));

/** Timeout multiplier from environment (default 1.0) */
export const timeoutMultiplier = parseFloat(process.env.E2E_TIMEOUT_MULTIPLIER || "1");

/** Apply timeout multiplier to a value */
export function applyTimeout(baseMs: number): number {
  return Math.round(baseMs * timeoutMultiplier);
}

/**
 * Get a delay value adjusted for transport mode.
 * For mock transport, delays are reduced by 20x (min 5ms).
 */
export function getDelay(baseMs: number): number {
  if (isMockTransport) {
    return Math.max(5, Math.round(baseMs / 20));
  }
  return baseMs;
}

/** Promise-based delay that respects mock-fast mode */
export function delay(baseMs: number): Promise<void> {
  return new Promise(r => setTimeout(r, getDelay(baseMs)));
}

/** Get config with environment variable overrides */
export function getConfig(): E2EConfig {
  const cfg = { ...config };

  // Allow CDP host/port override
  if (process.env.CDP_HOST) {
    cfg.cdp.host = process.env.CDP_HOST;
  }
  if (process.env.CDP_PORT) {
    cfg.cdp.port = parseInt(process.env.CDP_PORT, 10);
  }

  // Allow vault path overrides
  if (process.env.TEST_VAULT_PATH) {
    cfg.vaults.TEST.path = process.env.TEST_VAULT_PATH;
  }
  if (process.env.TEST2_VAULT_PATH) {
    cfg.vaults.TEST2.path = process.env.TEST2_VAULT_PATH;
  }
  if (process.env.TEST3_VAULT_PATH && cfg.vaults.TEST3) {
    cfg.vaults.TEST3.path = process.env.TEST3_VAULT_PATH;
  }

  // Apply timeout multiplier to all sync timeouts
  cfg.sync = {
    ...cfg.sync,
    defaultTimeout: applyTimeout(cfg.sync.defaultTimeout),
    pairingTimeout: applyTimeout(cfg.sync.pairingTimeout),
    convergenceTimeout: applyTimeout(cfg.sync.convergenceTimeout),
    connectionTimeout: applyTimeout(cfg.sync.connectionTimeout),
    liveSessionTimeout: applyTimeout(cfg.sync.liveSessionTimeout),
    settleDelay: applyTimeout(cfg.sync.settleDelay),
  };

  // Slow mode uses conservative timeouts for debugging
  if (isSlowMode) {
    cfg.sync = {
      ...cfg.sync,
      defaultTimeout: applyTimeout(30000),
      pairingTimeout: applyTimeout(90000),
      convergenceTimeout: applyTimeout(60000),
      pollInterval: 500,
      minPollInterval: 200,
      maxPollInterval: 1000,
    };
  }

  // Mock transport uses aggressive timeouts (no network latency)
  if (isMockTransport && !isSlowMode) {
    cfg.sync = {
      ...cfg.sync,
      defaultTimeout: 1000,        // 1s instead of 20s
      pairingTimeout: 2000,        // 2s instead of 60s
      convergenceTimeout: 1000,    // 1s instead of 30s
      connectionTimeout: 1000,     // 1s instead of 30s
      liveSessionTimeout: 2000,    // 2s instead of 60s
      settleDelay: 20,             // 20ms instead of 3s
      pollInterval: 5,             // 5ms instead of 100ms
      minPollInterval: 2,
      maxPollInterval: 20,
    };
  }

  return cfg;
}
