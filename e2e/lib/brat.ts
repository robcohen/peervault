/**
 * BRAT Integration
 *
 * Controls BRAT (Beta Reviewers Auto-update Tester) plugin for
 * checking and installing PeerVault updates from GitHub releases.
 */

import type { CDPClient } from "./cdp-client";

/** BRAT plugin settings */
export interface BRATSettings {
  pluginList: string[];
  updateAtStartup: boolean;
  notificationsEnabled: boolean;
}

/**
 * Manager for BRAT plugin operations.
 */
export class BRATManager {
  constructor(
    private client: CDPClient,
    public readonly vaultName: string
  ) {}

  /**
   * Check if BRAT plugin is installed.
   */
  async isInstalled(): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (function() {
        return !!window.app?.plugins?.plugins?.["obsidian42-brat"];
      })()
    `);
  }

  /**
   * Check if PeerVault is registered in BRAT.
   */
  async isPeerVaultRegistered(): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (function() {
        const brat = window.app?.plugins?.plugins?.["obsidian42-brat"];
        if (!brat?.settings?.pluginList) return false;
        return brat.settings.pluginList.some(p =>
          p.toLowerCase().includes("peervault")
        );
      })()
    `);
  }

  /**
   * Get BRAT settings.
   */
  async getSettings(): Promise<BRATSettings | null> {
    return await this.client.evaluate<BRATSettings | null>(`
      (function() {
        const brat = window.app?.plugins?.plugins?.["obsidian42-brat"];
        if (!brat?.settings) return null;
        return {
          pluginList: brat.settings.pluginList || [],
          updateAtStartup: brat.settings.updateAtStartup ?? true,
          notificationsEnabled: brat.settings.notificationsEnabled ?? true,
        };
      })()
    `);
  }

  /**
   * Trigger BRAT to check for updates and install them.
   */
  async checkForUpdatesAndUpdate(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const app = window.app;

        // Execute BRAT's check for updates command
        await app.commands.executeCommandById(
          "obsidian42-brat:BRAT-checkForUpdatesAndUpdate"
        );
      })()
    `);

    // Wait for BRAT to finish (it's async)
    await new Promise((r) => setTimeout(r, 5000));
  }

  /**
   * Trigger BRAT to check for updates only (no install).
   */
  async checkForUpdates(): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const app = window.app;

        // Execute BRAT's check for updates command
        await app.commands.executeCommandById(
          "obsidian42-brat:BRAT-checkForUpdatesStartup"
        );
      })()
    `);

    // Wait for BRAT to finish
    await new Promise((r) => setTimeout(r, 3000));
  }

  /**
   * Get the current installed PeerVault version.
   */
  async getCurrentVersion(): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        const plugin = window.app?.plugins?.plugins?.["peervault"];
        return plugin?.manifest?.version || "unknown";
      })()
    `);
  }

  /**
   * Get the latest available version from GitHub (via BRAT).
   * Note: This requires BRAT to have checked for updates recently.
   */
  async getLatestVersion(): Promise<string | null> {
    // BRAT doesn't expose the latest version directly, so we need to
    // fetch it from GitHub ourselves
    try {
      const response = await fetch(
        "https://api.github.com/repos/robcohen/peervault/releases/latest"
      );
      if (!response.ok) return null;
      const release = (await response.json()) as { tag_name: string };
      // Remove 'v' prefix if present
      return release.tag_name.replace(/^v/, "");
    } catch {
      return null;
    }
  }

  /**
   * Update PeerVault to the latest version using BRAT.
   * Returns true if an update was performed.
   */
  async update(): Promise<boolean> {
    const beforeVersion = await this.getCurrentVersion();

    // Trigger BRAT update
    await this.checkForUpdatesAndUpdate();

    // Reload the plugin to pick up new version
    await this.client.evaluate(`
      (async function() {
        const plugins = window.app.plugins;
        await plugins.disablePlugin("peervault");
        await plugins.loadManifests();
        await new Promise(r => setTimeout(r, 1000));
        await plugins.enablePlugin("peervault");
      })()
    `);

    // Wait for plugin to initialize
    await new Promise((r) => setTimeout(r, 2000));

    const afterVersion = await this.getCurrentVersion();

    return beforeVersion !== afterVersion;
  }

  /**
   * Ensure PeerVault is at the latest version.
   * Returns the version after update check.
   */
  async ensureLatestVersion(): Promise<{
    currentVersion: string;
    latestVersion: string | null;
    updated: boolean;
  }> {
    const latestVersion = await this.getLatestVersion();
    const currentVersion = await this.getCurrentVersion();

    // Check if update is needed
    if (latestVersion && currentVersion !== latestVersion) {
      const updated = await this.update();
      return {
        currentVersion: await this.getCurrentVersion(),
        latestVersion,
        updated,
      };
    }

    return {
      currentVersion,
      latestVersion,
      updated: false,
    };
  }
}
