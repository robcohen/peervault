/**
 * Shared types for settings sections
 */

import type { App } from "obsidian";
import type PeerVaultPlugin from "../../main";

/** Context passed to each settings section */
export interface SectionContext {
  app: App;
  plugin: PeerVaultPlugin;
  /** Trigger a full refresh of the settings tab */
  refresh: () => void;
  /** Track expanded state of collapsible sections */
  expandedSections: Set<string>;
}

/** A settings section renderer */
export type SectionRenderer = (container: HTMLElement, ctx: SectionContext) => void;
