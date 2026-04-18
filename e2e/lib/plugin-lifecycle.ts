/**
 * Plugin Lifecycle Manager
 *
 * Controls plugin enable/disable/reload operations via CDP.
 */

import type { CDPClient } from "./cdp-client";
import { cp, rm, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getDelay } from "../config";

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
    const cleanupDelay = getDelay(500);
    await this.client.evaluate(`
      (async function() {
        const plugins = window.app.plugins;

        // Disable
        await plugins.disablePlugin("peervault");

        // Reload manifests to pick up any file changes
        await plugins.loadManifests();

        // Wait a bit for cleanup
        await new Promise(r => setTimeout(r, ${cleanupDelay}));

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
  private async waitForPluginReady(timeoutMs: number = 20000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = getDelay(100);

    while (Date.now() - startTime < timeoutMs) {
      const ready = await this.client.evaluate<boolean>(`
        (function() {
          const plugin = window.app?.plugins?.plugins?.["peervault"];
          // Check if plugin exists and has initialized client
          return !!(plugin && plugin.client && plugin.client.isInitialized);
        })()
      `);

      if (ready) return;

      await new Promise((r) => setTimeout(r, pollInterval));
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

  /**
   * Get the vault path from Obsidian.
   */
  async getVaultPath(): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        // Get the vault adapter's basePath
        const adapter = window.app.vault.adapter;
        return adapter?.basePath || "";
      })()
    `);
  }

  /**
   * Completely reinstall the plugin by:
   * 1. Disabling the plugin
   * 2. Deleting the plugin folder (except data.json)
   * 3. Copying fresh files from dist/
   * 4. Re-enabling the plugin
   *
   * This ensures the latest code is loaded.
   */
  async reinstall(distPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Get vault path
      const vaultPath = await this.getVaultPath();
      if (!vaultPath) {
        return { success: false, error: "Could not get vault path" };
      }

      const pluginDir = join(vaultPath, ".obsidian", "plugins", "peervault");

      // Step 1: Disable the plugin
      const wasEnabled = await this.isEnabled();
      if (wasEnabled) {
        await this.disable();
        await new Promise(r => setTimeout(r, 500));
      }

      // Step 2: Backup data.json if it exists
      let dataJson: string | null = null;
      try {
        const { readFile } = await import("node:fs/promises");
        const dataPath = join(pluginDir, "data.json");
        dataJson = await readFile(dataPath, "utf-8");
      } catch {
        // No data.json to backup
      }

      // Step 3: Delete the plugin folder
      try {
        await rm(pluginDir, { recursive: true, force: true });
      } catch {
        // Folder might not exist
      }

      // Step 4: Create plugin folder and copy fresh files
      await mkdir(pluginDir, { recursive: true });

      // Copy all files from dist/
      const distFiles = await readdir(distPath);
      for (const file of distFiles) {
        const srcPath = join(distPath, file);
        const destPath = join(pluginDir, file);
        const fileStat = await stat(srcPath);

        if (fileStat.isFile()) {
          await cp(srcPath, destPath);
        }
      }

      // Step 5: Restore data.json if we had one
      if (dataJson) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(pluginDir, "data.json"), dataJson);
      }

      // Step 6: Re-enable the plugin
      await this.client.evaluate(`
        (async function() {
          const plugins = window.app.plugins;
          // Reload manifests to pick up new plugin
          await plugins.loadManifests();
          await new Promise(r => setTimeout(r, 200));
          // Enable the plugin
          await plugins.enablePlugin("peervault");
        })()
      `);

      // Wait for plugin to initialize
      await this.waitForPluginReady();

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
}
