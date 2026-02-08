/**
 * Scaled Test Context
 *
 * Supports arbitrary numbers of clients for large-scale testing.
 * Each client is a separate Obsidian container with its own CDP endpoint.
 */

import { CDPClient } from "./cdp-client";
import { VaultController } from "./vault-controller";
import { PluginAPI } from "./plugin-api";
import { SyncWaiter } from "./sync-waiter";
import { StateManager } from "./state-manager";
import { PluginLifecycleManager } from "./plugin-lifecycle";
import type { CDPEndpoint } from "../config";
import { getCDPEndpoints, getConfig, delay } from "../config";

/** Single client context */
export interface ClientContext {
  /** Client name (e.g., "client-1") */
  name: string;

  /** CDP endpoint info */
  endpoint: CDPEndpoint;

  /** CDP client for this vault */
  client: CDPClient;

  /** Vault file operations */
  vault: VaultController;

  /** Plugin API */
  plugin: PluginAPI;

  /** Sync waiting utilities */
  sync: SyncWaiter;

  /** State management */
  state: StateManager;

  /** Plugin lifecycle management */
  lifecycle: PluginLifecycleManager;
}

/** Scaled test context with N clients */
export interface ScaledTestContext {
  /** All connected clients */
  clients: ClientContext[];

  /** Get client by index (0-based) */
  getClient(index: number): ClientContext;

  /** Get client by name */
  getClientByName(name: string): ClientContext | undefined;

  /** Number of clients */
  readonly numClients: number;

  /** Reset all clients */
  resetAll(): Promise<void>;

  /** Close all connections */
  close(): Promise<void>;

  /** Wait for all clients to have synced content */
  waitForConvergence(timeoutMs?: number): Promise<boolean>;

  /** Create a mesh where all clients are paired with each other */
  createFullMesh(): Promise<void>;

  /** Pair two specific clients */
  pairClients(client1: ClientContext, client2: ClientContext): Promise<void>;
}

/** CDP target from /json endpoint */
interface CDPTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/**
 * Accept the "Trust folder" modal if present.
 * Obsidian shows this when opening a new vault with community plugins.
 */
async function acceptTrustDialog(client: CDPClient, maxAttempts: number = 3): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await client.evaluate<{ clicked: boolean; error?: string }>(`
        (function() {
          // Look for the trust folder modal
          const modal = document.querySelector('.modal.mod-trust-folder');
          if (!modal) {
            return { clicked: false };
          }

          // Find the trust button
          const buttons = modal.querySelectorAll('button');
          const trustButton = Array.from(buttons).find(b =>
            b.textContent.toLowerCase().includes('trust') ||
            b.textContent.toLowerCase().includes('enable')
          );

          if (trustButton) {
            trustButton.click();
            return { clicked: true };
          }

          return { clicked: false, error: 'Trust button not found in modal' };
        })()
      `);

      if (result.clicked) {
        console.log(`  Accepted trust dialog`);
        // Wait for plugin loading to start
        await delay(2000);
        return;
      }

      // No modal found - this is fine, vault might already be trusted
      return;
    } catch (error) {
      if (attempt < maxAttempts - 1) {
        await delay(500);
      }
    }
  }
}

/**
 * Discover client from CDP endpoint with retries.
 * Each endpoint should have exactly one vault window.
 */
async function discoverClient(
  endpoint: CDPEndpoint,
  maxRetries: number = 5,
  retryDelayMs: number = 3000
): Promise<ClientContext | null> {
  const config = getConfig();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Query CDP endpoint for targets
      const url = `http://${endpoint.host}:${endpoint.port}/json`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const targets = (await response.json()) as CDPTarget[];

      // Find the vault window (should be a page with Obsidian in the title)
      const vaultTarget = targets.find(
        (t) => t.type === "page" && t.title.includes("Obsidian")
      );

      if (!vaultTarget) {
        if (attempt < maxRetries) {
          console.log(`  ${endpoint.name}: waiting for vault window (attempt ${attempt + 1}/${maxRetries + 1})...`);
          await delay(retryDelayMs);
          continue;
        }
        console.warn(`No vault window found at ${endpoint.host}:${endpoint.port}`);
        return null;
      }

      // Create CDP client
      const client = new CDPClient(vaultTarget.webSocketDebuggerUrl, {
        connectionTimeout: config.cdp.connectionTimeout,
        evaluateTimeout: config.cdp.evaluateTimeout,
      });

      await client.connect();

      // Accept trust dialog if present (for new Docker vaults)
      await acceptTrustDialog(client);

      // Extract vault name from title (e.g., "Note - VaultName - Obsidian v1.x.x")
      const titleMatch = vaultTarget.title.match(/^(?:.+ - )?(.+?) - Obsidian/);
      const vaultName = titleMatch ? titleMatch[1].trim() : endpoint.name;

      // Create controllers
      const vault = new VaultController(client, vaultName);
      const plugin = new PluginAPI(client, vaultName);
      const sync = new SyncWaiter(client, vaultName);
      const state = new StateManager(client, vaultName);
      const lifecycle = new PluginLifecycleManager(client, vaultName);

      return {
        name: endpoint.name,
        endpoint,
        client,
        vault,
        plugin,
        sync,
        state,
        lifecycle,
      };
    } catch (error) {
      if (attempt < maxRetries) {
        console.log(`  ${endpoint.name}: connection failed, retrying (attempt ${attempt + 1}/${maxRetries + 1})...`);
        await delay(retryDelayMs);
      } else {
        console.error(
          `Failed to connect to ${endpoint.name} at ${endpoint.host}:${endpoint.port}:`,
          error
        );
        return null;
      }
    }
  }

  return null;
}

/**
 * Create a scaled test context with N clients.
 */
export async function createScaledContext(): Promise<ScaledTestContext> {
  const endpoints = getCDPEndpoints();
  const config = getConfig();

  console.log(`Connecting to ${endpoints.length} client(s)...`);

  // Connect to all endpoints in parallel
  const clientPromises = endpoints.map((ep) => discoverClient(ep));
  const results = await Promise.all(clientPromises);

  // Filter out failed connections
  const clients = results.filter((c): c is ClientContext => c !== null);

  if (clients.length === 0) {
    throw new Error("No clients could be connected");
  }

  console.log(`Connected to ${clients.length}/${endpoints.length} client(s)`);

  // Log client info
  for (const client of clients) {
    const nodeId = await client.plugin.getNodeId().catch(() => "unknown");
    console.log(`  ${client.name}: ${nodeId.slice(0, 16)}...`);
  }

  // Enable auto-accept for vault adoption on all clients
  console.log("Enabling auto-accept for vault adoption...");
  await Promise.all(clients.map((c) => c.plugin.enableAutoAcceptVaultAdoption()));

  return {
    clients,

    get numClients() {
      return clients.length;
    },

    getClient(index: number): ClientContext {
      if (index < 0 || index >= clients.length) {
        throw new Error(`Client index ${index} out of range (0-${clients.length - 1})`);
      }
      return clients[index];
    },

    getClientByName(name: string): ClientContext | undefined {
      return clients.find((c) => c.name === name);
    },

    async resetAll(): Promise<void> {
      console.log(`Resetting ${clients.length} clients...`);
      await Promise.all(clients.map((c) => c.state.resetAll()));
      console.log("All clients reset");
    },

    async close(): Promise<void> {
      await Promise.all(clients.map((c) => c.client.close()));
    },

    async waitForConvergence(timeoutMs = 30000): Promise<boolean> {
      const startTime = Date.now();
      const requiredStableChecks = 3; // Must be stable for 3 consecutive checks
      let stableCount = 0;
      let lastMatchedState: string | null = null;

      while (Date.now() - startTime < timeoutMs) {
        // Get CRDT versions AND file lists from all clients
        const states = await Promise.all(
          clients.map(async (c) => {
            try {
              return await c.client.evaluate<{ version: string; files: string[] } | null>(`
                (function() {
                  const plugin = window.app?.plugins?.plugins?.["peervault"];
                  const dm = plugin?.documentManager;
                  if (!dm) return null;
                  const version = dm.doc?.version?.();
                  const files = dm.doc?.getMap("files")?.keys() || [];
                  return {
                    version: version ? JSON.stringify(version) : null,
                    files: Array.from(files).sort()
                  };
                })()
              `);
            } catch {
              return null;
            }
          })
        );

        // Check if all clients have valid states
        const validStates = states.filter((s): s is { version: string; files: string[] } =>
          s !== null && s.version !== null
        );

        if (validStates.length === clients.length) {
          // Check both version AND file list equality
          const firstVersion = validStates[0].version;
          const firstFiles = JSON.stringify(validStates[0].files);

          const allVersionsEqual = validStates.every((s) => s.version === firstVersion);
          const allFilesEqual = validStates.every((s) => JSON.stringify(s.files) === firstFiles);

          if (allVersionsEqual && allFilesEqual) {
            // Create a combined state hash for stability checking
            const stateHash = `${firstVersion}:${firstFiles}`;

            if (lastMatchedState === stateHash) {
              stableCount++;
            } else {
              lastMatchedState = stateHash;
              stableCount = 1;
            }

            // If stable for N checks, wait for vault writes and return
            if (stableCount >= requiredStableChecks) {
              // CRDT converged - now wait for vault writes to complete
              await Promise.all(
                clients.map(async (c) => {
                  try {
                    await c.sync.waitForVaultSync(5000);
                  } catch {
                    // Timeout is ok - just means no pending writes
                  }
                })
              );
              return true;
            }
          } else {
            // States don't match - reset
            stableCount = 0;
            lastMatchedState = null;
          }
        } else {
          // Not all clients have valid states - reset
          stableCount = 0;
          lastMatchedState = null;
        }

        await delay(500);
      }

      return false;
    },

    async pairClients(
      client1: ClientContext,
      client2: ClientContext
    ): Promise<void> {
      console.log(`Pairing ${client1.name} with ${client2.name}...`);

      // Generate invite from client1
      const invite = await client1.plugin.generateInvite();

      // Add peer on client2
      const addPeerPromise = client2.plugin.addPeer(invite);

      // Wait a bit for connection to establish
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(resolve, 5000);
      });

      await Promise.race([addPeerPromise, timeoutPromise]);
      await delay(500);

      // Accept pairing request on client1 if needed
      const requests = await client1.plugin.getPendingPairingRequests();
      if (requests.length > 0) {
        await client1.plugin.acceptPairingRequest(requests[0].nodeId);
      }

      // Wait for connection
      await delay(2000);

      console.log(`  ${client1.name} <-> ${client2.name} paired`);
    },

    async createFullMesh(): Promise<void> {
      const numClients = clients.length;
      console.log(`Creating mesh with ${numClients} clients using hub-and-spoke + gossip...`);

      // Hub-and-spoke: client-1 pairs with all others
      // The gossip protocol will propagate peer info to form the full mesh
      const hub = clients[0];
      const spokes = clients.slice(1);

      console.log(`  ${hub.name} pairing with ${spokes.length} clients...`);

      // Pair hub with each spoke sequentially (parallel causes race conditions)
      for (const spoke of spokes) {
        await this.pairClients(hub, spoke);
      }

      // Wait for gossip to propagate and mesh to form
      // Each node should discover others through the hub
      const gossipTime = 5000 + (numClients * 2000); // More time for larger meshes
      console.log(`  Waiting ${gossipTime / 1000}s for gossip to propagate mesh...`);
      await delay(gossipTime);

      // Verify connectivity - each client should see all others via gossip
      let allConnected = true;
      const expectedPeers = numClients - 1;

      for (const client of clients) {
        const peers = await client.plugin.getConnectedPeers();
        if (peers.length < expectedPeers) {
          console.warn(`  ${client.name} has ${peers.length}/${expectedPeers} peers`);
          allConnected = false;
        } else {
          console.log(`  ${client.name}: ${peers.length} peers (OK)`);
        }
      }

      if (allConnected) {
        console.log("Full mesh formed via gossip");
      } else {
        console.warn("Gossip mesh incomplete - some direct connections may be needed");
      }
    },
  };
}
