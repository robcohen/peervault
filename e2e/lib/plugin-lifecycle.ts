/**
 * Plugin Lifecycle Manager
 *
 * Controls plugin enable/disable/reload operations via CDP.
 */

import type { CDPClient } from "./cdp-client";

/**
 * Manager for plugin lifecycle operations.
 */
export class PluginLifecycleManager {
  constructor(
    private client: CDPClient,
    public readonly vaultName: string
  ) {}

  /**
   * Check if the plugin is enabled.
   */
  async isEnabled(): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (function() {
        return !!window.app?.plugins?.plugins?.["peervault"];
      })()
    `);
  }

  /**
   * Enable the plugin.
   */
  async enable(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugins = window.app.plugins;
        await plugins.enablePlugin("peervault");
      })()
    `);

    // Wait for plugin to initialize
    await this.waitForPluginReady();
  }

  /**
   * Disable the plugin.
   */
  async disable(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugins = window.app.plugins;
        await plugins.disablePlugin("peervault");
      })()
    `);
  }

  /**
   * Reload the plugin (disable then enable).
   */
  async reload(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const plugins = window.app.plugins;

        // Disable
        await plugins.disablePlugin("peervault");

        // Reload manifests to pick up any file changes
        await plugins.loadManifests();

        // Wait a bit for cleanup
        await new Promise(r => setTimeout(r, 500));

        // Re-enable
        await plugins.enablePlugin("peervault");
      })()
    `);

    // Wait for plugin to initialize
    await this.waitForPluginReady();
  }

  /**
   * Wait for the plugin to be ready after enable/reload.
   */
  private async waitForPluginReady(timeoutMs: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const ready = await this.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          // Check if plugin exists and has initialized (has peerManager)
          return !!(plugin && plugin.peerManager);
        })()
      `);

      if (ready) return;

      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error(`Plugin not ready after ${timeoutMs}ms`);
  }

  /**
   * Get the current plugin version from manifest.
   */
  async getVersion(): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.manifest?.version || "unknown";
      })()
    `);
  }

  /**
   * Get the manifest version from the plugin folder (may differ if not reloaded).
   */
  async getManifestVersion(): Promise<string> {
    return await this.client.evaluate<string>(`
      (async function() {
        const plugins = window.app.plugins;
        const manifest = plugins.manifests?.["peervault"];
        return manifest?.version || "unknown";
      })()
    `);
  }
}
