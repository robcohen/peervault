/**
 * Type augmentations for Obsidian internal APIs.
 *
 * These APIs are not officially documented but are commonly used
 * and are stable across versions.
 */

import "obsidian";

declare module "obsidian" {
  interface App {
    /** Internal settings modal controller */
    setting: {
      /** Open the settings modal */
      open(): void;
      /** Open a specific settings tab by ID */
      openTabById(id: string): void;
      /** Close the settings modal */
      close(): void;
    };
  }
}
