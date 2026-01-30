/**
 * E2E Test Configuration
 *
 * Configuration for CDP connections, vault paths, and test settings.
 */

export interface E2EConfig {
  /** CDP (Chrome DevTools Protocol) settings */
  cdp: {
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

  /** Vault configuration */
  vaults: {
    TEST: { name: string; path: string };
    TEST2: { name: string; path: string };
  };

  /** Sync operation settings */
  sync: {
    /** Default timeout for waiting for sync completion */
    defaultTimeout: number;
    /** Polling interval for sync status checks */
    pollInterval: number;
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
    port: 9222,
    connectionTimeout: 10000,
    evaluateTimeout: 30000,
    retryCount: 3,
    retryDelay: 1000,
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
  },
  sync: {
    defaultTimeout: 30000,
    pollInterval: 500,
  },
  fixtures: {
    path: "./e2e/fixtures",
  },
  logging: {
    verbose: process.argv.includes("--verbose"),
    collectConsoleLogs: true,
  },
};

/** Get config with environment variable overrides */
export function getConfig(): E2EConfig {
  const cfg = { ...config };

  // Allow CDP port override
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

  return cfg;
}
