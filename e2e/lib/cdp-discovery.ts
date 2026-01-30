/**
 * CDP Page Discovery
 *
 * Dynamically discovers Obsidian vault pages via the DevTools HTTP endpoint.
 * No hardcoded page IDs - discovers vaults by their window titles.
 */

import { config } from "../config";

/** CDP target information from /json endpoint */
export interface CDPTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Discovered vault page */
export interface VaultPage {
  name: string;
  id: string;
  wsUrl: string;
  title: string;
}

/**
 * Query the CDP endpoint for available targets.
 */
async function getTargets(port: number = config.cdp.port): Promise<CDPTarget[]> {
  const url = `http://127.0.0.1:${port}/json`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return (await response.json()) as CDPTarget[];
  } catch (err) {
    throw new Error(
      `Failed to connect to CDP endpoint at ${url}. ` +
        `Ensure Obsidian is running with --remote-debugging-port=${port}. ` +
        `Error: ${err instanceof Error ? err.message : err}`
    );
  }
}

/**
 * Extract vault name from Obsidian page title.
 * Obsidian titles are typically: "Note Title - VaultName - Obsidian vX.X.X"
 * or just "VaultName - Obsidian vX.X.X" when no note is open.
 */
function extractVaultName(title: string): string | null {
  // Match pattern: "... - VaultName - Obsidian vX.X.X"
  const match = title.match(/^(?:.+ - )?(.+?) - Obsidian/);
  if (match) {
    return match[1].trim();
  }
  return null;
}

/**
 * Discover all Obsidian vault pages.
 */
export async function discoverVaults(
  port: number = config.cdp.port
): Promise<Map<string, VaultPage>> {
  const targets = await getTargets(port);
  const vaults = new Map<string, VaultPage>();

  for (const target of targets) {
    // Only consider page targets with Obsidian URLs
    if (target.type !== "page") continue;
    if (!target.url.includes("app://obsidian.md")) continue;

    const vaultName = extractVaultName(target.title);
    if (vaultName) {
      vaults.set(vaultName, {
        name: vaultName,
        id: target.id,
        wsUrl: target.webSocketDebuggerUrl,
        title: target.title,
      });
    }
  }

  return vaults;
}

/**
 * Discover and return a specific vault by name.
 */
export async function discoverVault(
  vaultName: string,
  port: number = config.cdp.port
): Promise<VaultPage | null> {
  const vaults = await discoverVaults(port);
  return vaults.get(vaultName) || null;
}

/**
 * Wait for specific vaults to be available.
 */
export async function waitForVaults(
  vaultNames: string[],
  options: {
    port?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<Map<string, VaultPage>> {
  const {
    port = config.cdp.port,
    timeoutMs = 60000,
    pollIntervalMs = 1000,
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const vaults = await discoverVaults(port);

    const allFound = vaultNames.every((name) => vaults.has(name));
    if (allFound) {
      // Return only the requested vaults
      const result = new Map<string, VaultPage>();
      for (const name of vaultNames) {
        result.set(name, vaults.get(name)!);
      }
      return result;
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout - report which vaults are missing
  const vaults = await discoverVaults(port);
  const missing = vaultNames.filter((name) => !vaults.has(name));
  const found = vaultNames.filter((name) => vaults.has(name));

  throw new Error(
    `Timeout waiting for vaults. ` +
      `Missing: [${missing.join(", ")}]. ` +
      `Found: [${found.join(", ")}]. ` +
      `All available: [${Array.from(vaults.keys()).join(", ")}].`
  );
}

/**
 * Print discovered vaults for debugging.
 */
export async function printDiscoveredVaults(
  port: number = config.cdp.port
): Promise<void> {
  console.log(`Discovering vaults on port ${port}...`);

  try {
    const vaults = await discoverVaults(port);

    if (vaults.size === 0) {
      console.log("No Obsidian vaults found.");
      console.log("Make sure Obsidian is running with vault windows open.");
    } else {
      console.log(`Found ${vaults.size} vault(s):`);
      for (const [name, page] of vaults) {
        console.log(`  - ${name}`);
        console.log(`    Title: ${page.title}`);
        console.log(`    ID: ${page.id}`);
        console.log(`    WS: ${page.wsUrl}`);
      }
    }
  } catch (err) {
    console.error("Discovery failed:", err);
  }
}
