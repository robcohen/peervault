/**
 * Vault Sync Service
 *
 * Handles bidirectional sync between Obsidian vault files and the
 * Loro document. Reads file contents on local changes and writes
 * file contents on remote changes.
 */

import type { App, TFile, TAbstractFile, Vault } from "obsidian";
import type { DocumentManager, FileChangeEvent } from "./document-manager";
import type { BlobStore } from "./blob-store";
import { isBinaryFile } from "./blob-store";
import type { Logger } from "../utils/logger";
import { isPathInExcludedFolders } from "../utils/validation";

/** Configuration for vault sync */
export interface VaultSyncConfig {
  /** Folders to exclude from sync */
  excludedFolders: string[];
  /** Maximum file size in bytes to sync */
  maxFileSize: number;
  /** Debounce delay for file changes (ms) */
  debounceMs: number;
}

const DEFAULT_CONFIG: VaultSyncConfig = {
  excludedFolders: [".obsidian/plugins", ".obsidian/themes"],
  maxFileSize: 100 * 1024 * 1024, // 100 MB
  debounceMs: 150, // Reduced from 500 for lower latency
};

/**
 * Syncs files between Obsidian vault and Loro document.
 */
export class VaultSync {
  private config: VaultSyncConfig;
  private pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribeDocChanges: (() => void) | null = null;
  private isProcessingRemote = false;

  /**
   * Per-peer excluded folders - union of all connected peers' group exclusions.
   * Files in these folders won't be written to vault from remote changes.
   */
  private peerExcludedFolders = new Set<string>();

  constructor(
    private app: App,
    private documentManager: DocumentManager,
    private blobStore: BlobStore,
    private logger: Logger,
    config?: Partial<VaultSyncConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start vault sync.
   */
  start(): void {
    // Subscribe to document changes (remote updates)
    this.unsubscribeDocChanges = this.documentManager.onFileChange((event) => {
      if (event.origin === "remote") {
        this.handleRemoteChange(event);
      }
    });

    this.logger.info("VaultSync started");
  }

  /**
   * Stop vault sync.
   */
  stop(): void {
    // Clear pending changes
    for (const timeout of this.pendingChanges.values()) {
      clearTimeout(timeout);
    }
    this.pendingChanges.clear();

    // Unsubscribe from document changes
    if (this.unsubscribeDocChanges) {
      this.unsubscribeDocChanges();
      this.unsubscribeDocChanges = null;
    }

    this.logger.info("VaultSync stopped");
  }

  // ===========================================================================
  // Vault -> Document (Local Changes)
  // ===========================================================================

  /**
   * Handle a file creation in the vault.
   */
  async handleFileCreate(file: TAbstractFile): Promise<void> {
    if (!this.shouldSync(file.path)) return;
    if (this.isProcessingRemote) return;

    this.debounceChange(file.path, async () => {
      await this.documentManager.handleFileCreate(file.path);
      await this.syncFileContent(file.path);
    });
  }

  /**
   * Handle a file modification in the vault.
   */
  async handleFileModify(file: TAbstractFile): Promise<void> {
    if (!this.shouldSync(file.path)) return;
    if (this.isProcessingRemote) return;

    this.debounceChange(file.path, async () => {
      await this.documentManager.handleFileModify(file.path);
      await this.syncFileContent(file.path);
    });
  }

  /**
   * Handle a file deletion in the vault.
   */
  async handleFileDelete(file: TAbstractFile): Promise<void> {
    if (!this.shouldSync(file.path)) return;
    if (this.isProcessingRemote) return;

    // Cancel any pending changes
    const pending = this.pendingChanges.get(file.path);
    if (pending) {
      clearTimeout(pending);
      this.pendingChanges.delete(file.path);
    }

    await this.documentManager.handleFileDelete(file.path);
  }

  /**
   * Handle a file rename in the vault.
   */
  async handleFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
    const shouldSyncNew = this.shouldSync(file.path);
    const shouldSyncOld = this.shouldSync(oldPath);

    if (!shouldSyncNew && !shouldSyncOld) return;
    if (this.isProcessingRemote) return;

    // Cancel any pending changes for old path
    const pending = this.pendingChanges.get(oldPath);
    if (pending) {
      clearTimeout(pending);
      this.pendingChanges.delete(oldPath);
    }

    await this.documentManager.handleFileRename(oldPath, file.path);
  }

  /**
   * Sync file content from vault to document.
   */
  private async syncFileContent(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      this.logger.debug("File not found:", path);
      return;
    }

    // Use type guard to check if it's a TFile (not a folder)
    if (!("stat" in file)) {
      // Not a file (might be a folder)
      return;
    }

    try {
      const tfile = file as TFile;

      // Check file size
      if (tfile.stat.size > this.config.maxFileSize) {
        this.logger.warn("File too large to sync:", path, tfile.stat.size);
        return;
      }

      if (isBinaryFile(path)) {
        // Binary file - read and store in blob store
        const content = await this.app.vault.readBinary(tfile);
        const hash = await this.blobStore.add(new Uint8Array(content));
        this.documentManager.setBlobHash(path, hash);
        this.logger.debug("Synced binary file to document:", path);
      } else {
        // Text file - read and store in document
        const content = await this.app.vault.read(tfile);
        this.documentManager.setTextContent(path, content);
        this.logger.debug("Synced text file to document:", path);
      }
    } catch (error) {
      this.logger.error("Failed to sync file content:", path, error);
    }
  }

  /**
   * Do initial sync of all vault files to document.
   * Use this when you have local files and want to sync them to the document.
   */
  async initialSync(): Promise<void> {
    this.logger.info("Starting initial vault sync (vault -> document)...");

    const files = this.app.vault.getFiles();
    let synced = 0;
    let skipped = 0;

    for (const file of files) {
      if (!this.shouldSync(file.path)) {
        skipped++;
        continue;
      }

      try {
        // Create file node if not exists
        await this.documentManager.handleFileCreate(file.path);

        // Sync content
        await this.syncFileContent(file.path);
        synced++;
      } catch (error) {
        this.logger.error("Failed to sync file:", file.path, error);
      }
    }

    this.logger.info(
      `Initial sync complete: ${synced} files synced, ${skipped} skipped`,
    );
  }

  /**
   * Sync all files from document to vault.
   * Use this when a new device joins and needs to receive all files.
   */
  async syncFromDocument(): Promise<{
    created: number;
    updated: number;
    failed: number;
  }> {
    this.logger.info("Starting document -> vault sync...");
    this.isProcessingRemote = true;

    const stats = { created: 0, updated: 0, failed: 0 };

    try {
      // Get all file paths from the document
      const docPaths = this.documentManager.listAllPaths();
      this.logger.info(`Document has ${docPaths.length} files`);

      // Group paths by depth to ensure parents are created before children
      // Files at the same depth can be processed in parallel
      const pathsByDepth = new Map<number, string[]>();
      for (const path of docPaths) {
        if (!this.shouldSync(path)) continue;

        const content = this.documentManager.getContent(path);
        if (!content || content.type === "folder") continue;

        const depth = path.split("/").length;
        const group = pathsByDepth.get(depth) ?? [];
        group.push(path);
        pathsByDepth.set(depth, group);
      }

      // Process each depth level in order, with parallel processing within each level
      const CONCURRENCY = 5; // Max concurrent file operations
      const depths = Array.from(pathsByDepth.keys()).sort((a, b) => a - b);

      for (const depth of depths) {
        const paths = pathsByDepth.get(depth) ?? [];

        // Process in batches of CONCURRENCY
        for (let i = 0; i < paths.length; i += CONCURRENCY) {
          const batch = paths.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async (path) => {
              const existingFile = this.app.vault.getAbstractFileByPath(path);
              const isNew = !existingFile;
              await this.writeFileToVault(path);
              return isNew ? "created" : "updated";
            }),
          );

          // Tally results
          for (const result of results) {
            if (result.status === "fulfilled") {
              if (result.value === "created") stats.created++;
              else stats.updated++;
            } else {
              this.logger.error("Failed to sync file from document:", result.reason);
              stats.failed++;
            }
          }
        }
      }

      this.logger.info(
        `Document sync complete: ${stats.created} created, ${stats.updated} updated, ${stats.failed} failed`,
      );
    } finally {
      this.isProcessingRemote = false;
    }

    return stats;
  }

  /**
   * Check if the vault is empty (no syncable files).
   * Used to determine if we should sync from document on first connect.
   */
  isVaultEmpty(): boolean {
    const files = this.app.vault.getFiles();
    return !files.some((f) => this.shouldSync(f.path));
  }

  /**
   * Check if the document has files.
   */
  hasDocumentContent(): boolean {
    const paths = this.documentManager.listAllPaths();
    return paths.length > 0;
  }

  // ===========================================================================
  // Document -> Vault (Remote Changes)
  // ===========================================================================

  /**
   * Handle a remote file change from the document.
   *
   * Applies changes from peer's CRDT updates to the local vault filesystem.
   * Respects peer group exclusion policies - files in excluded folders
   * won't be written to vault even if they exist in the document.
   *
   * Special rename handling:
   * - Both paths excluded: skip entirely
   * - Old excluded, new included: treat as create (file appears)
   * - Old included, new excluded: treat as delete (file disappears)
   * - Neither excluded: normal rename operation
   */
  private async handleRemoteChange(event: FileChangeEvent): Promise<void> {
    // Check if path is excluded by peer group policies
    if (this.isExcludedByPeers(event.path)) {
      this.logger.debug(
        "Skipping remote change for peer-excluded path:",
        event.path,
      );
      return;
    }

    this.isProcessingRemote = true;

    try {
      switch (event.type) {
        case "create":
        case "modify":
          await this.retryVaultOperation(
            () => this.writeFileToVault(event.path),
            `Write file ${event.path}`,
          );
          break;

        case "delete":
          await this.retryVaultOperation(
            () => this.deleteFileFromVault(event.path),
            `Delete file ${event.path}`,
          );
          break;

        case "rename":
          if (event.oldPath) {
            // For renames, check both old and new paths
            const oldExcluded = this.isExcludedByPeers(event.oldPath);
            const newExcluded = this.isExcludedByPeers(event.path);

            if (oldExcluded && newExcluded) {
              // Both excluded, skip entirely
              return;
            } else if (oldExcluded && !newExcluded) {
              // Moving from excluded to included - treat as create
              await this.retryVaultOperation(
                () => this.writeFileToVault(event.path),
                `Write file ${event.path}`,
              );
            } else if (!oldExcluded && newExcluded) {
              // Moving from included to excluded - treat as delete
              await this.retryVaultOperation(
                () => this.deleteFileFromVault(event.oldPath!),
                `Delete file ${event.oldPath}`,
              );
            } else {
              // Neither excluded - normal rename
              await this.retryVaultOperation(
                () => this.renameFileInVault(event.oldPath!, event.path),
                `Rename ${event.oldPath} to ${event.path}`,
              );
            }
          }
          break;
      }
    } catch (error) {
      // This should only happen if retryVaultOperation itself throws unexpectedly
      this.logger.error("Unexpected error applying remote change:", event, error);
    } finally {
      this.isProcessingRemote = false;
    }
  }

  /**
   * Check if a path is excluded by peer group policies.
   */
  private isExcludedByPeers(path: string): boolean {
    return isPathInExcludedFolders(path, [...this.peerExcludedFolders]);
  }

  /**
   * Write file content from document to vault.
   */
  private async writeFileToVault(path: string): Promise<void> {
    const content = this.documentManager.getContent(path);
    if (!content) {
      this.logger.warn("No content found for remote file:", path);
      return;
    }

    // Ensure parent folder exists
    const parts = path.split("/");
    if (parts.length > 1) {
      const folderPath = parts.slice(0, -1).join("/");
      await this.ensureFolder(folderPath);
    }

    if (content.type === "text" && content.text !== undefined) {
      // Write text file
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && "stat" in existing) {
        // It's a TFile, safe to modify
        await this.app.vault.modify(existing as TFile, content.text);
      } else if (!existing) {
        await this.app.vault.create(path, content.text);
      } else {
        // It's a folder with the same name, can't write file
        this.logger.warn("Cannot write file, folder exists at path:", path);
        return;
      }
      this.logger.debug("Wrote text file from document:", path);
    } else if (content.type === "binary" && content.blobHash) {
      // Write binary file
      const blobData = await this.blobStore.get(content.blobHash);
      if (!blobData) {
        this.logger.warn(
          `Blob not found for remote file "${path}" (hash: ${content.blobHash.slice(0, 16)}...). ` +
          "File will be skipped. Try re-syncing with the peer that has this file.",
        );
        return;
      }

      // Convert to ArrayBuffer (Obsidian API requires ArrayBuffer, not Uint8Array)
      const arrayBuffer = new ArrayBuffer(blobData.length);
      new Uint8Array(arrayBuffer).set(blobData);

      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && "stat" in existing) {
        // It's a TFile, safe to modify
        await this.app.vault.modifyBinary(existing as TFile, arrayBuffer);
      } else if (!existing) {
        await this.app.vault.createBinary(path, arrayBuffer);
      } else {
        // It's a folder with the same name, can't write file
        this.logger.warn("Cannot write binary, folder exists at path:", path);
        return;
      }
      this.logger.debug("Wrote binary file from document:", path);
    }
  }

  /**
   * Delete file from vault.
   */
  private async deleteFileFromVault(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) {
      await this.app.vault.delete(file);
      this.logger.debug("Deleted file from vault:", path);
    }
  }

  /**
   * Rename file in vault.
   */
  private async renameFileInVault(
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (file) {
      // Ensure new parent folder exists
      const parts = newPath.split("/");
      if (parts.length > 1) {
        const folderPath = parts.slice(0, -1).join("/");
        await this.ensureFolder(folderPath);
      }

      await this.app.vault.rename(file, newPath);
      this.logger.debug("Renamed file in vault:", oldPath, "->", newPath);
    }
  }

  /**
   * Ensure a folder exists in the vault.
   */
  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!existing) {
      await this.app.vault.createFolder(path);
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  /**
   * Check if a path should be synced.
   */
  private shouldSync(path: string): boolean {
    return !isPathInExcludedFolders(path, this.config.excludedFolders);
  }

  /**
   * Update excluded folders list (global exclusions).
   */
  updateExcludedFolders(folders: string[]): void {
    this.config.excludedFolders = folders;
    this.logger.info("Updated excluded folders:", folders);
  }

  /**
   * Get current excluded folders (global).
   */
  getExcludedFolders(): string[] {
    return [...this.config.excludedFolders];
  }

  /**
   * Update peer-based excluded folders.
   * Called by PeerManager when peer connections or group policies change.
   *
   * @param folders Union of excluded folders from all connected peers' groups
   */
  updatePeerExcludedFolders(folders: string[]): void {
    this.peerExcludedFolders = new Set(folders);
    this.logger.debug("Updated peer excluded folders:", folders);
  }

  /**
   * Get current peer-based excluded folders.
   */
  getPeerExcludedFolders(): string[] {
    return [...this.peerExcludedFolders];
  }

  /** Maximum number of pending changes to prevent memory leaks */
  private static readonly MAX_PENDING_CHANGES = 1000;

  /** Max retries for vault write operations */
  private static readonly MAX_WRITE_RETRIES = 3;

  /**
   * Retry a vault operation with exponential backoff.
   * @param operation - The async operation to retry
   * @param operationName - Name for logging
   * @returns true if operation succeeded, false if all retries failed
   */
  private async retryVaultOperation(
    operation: () => Promise<void>,
    operationName: string,
  ): Promise<boolean> {
    const baseDelayMs = 200;

    for (let attempt = 1; attempt <= VaultSync.MAX_WRITE_RETRIES; attempt++) {
      try {
        await operation();
        return true;
      } catch (error) {
        if (attempt === VaultSync.MAX_WRITE_RETRIES) {
          this.logger.error(
            `${operationName} failed after ${attempt} attempts:`,
            error,
          );
          return false;
        }

        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        this.logger.warn(
          `${operationName} failed (attempt ${attempt}/${VaultSync.MAX_WRITE_RETRIES}), retrying in ${delay}ms:`,
          error,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return false;
  }

  /**
   * Debounce a file change operation.
   */
  private debounceChange(path: string, fn: () => Promise<void>): void {
    // Cancel existing timeout for this path (updates to same path always allowed)
    const existing = this.pendingChanges.get(path);
    if (existing) {
      clearTimeout(existing);
    }

    // Enforce limit - drop new paths when at capacity (but allow updates to existing paths)
    if (this.pendingChanges.size >= VaultSync.MAX_PENDING_CHANGES && !existing) {
      this.logger.warn(
        `Pending changes limit reached (${VaultSync.MAX_PENDING_CHANGES}), ` +
        `dropping change for "${path}"`,
      );
      return; // Actually drop the change
    }

    // Set new timeout
    const timeout = setTimeout(async () => {
      this.pendingChanges.delete(path);
      try {
        await fn();
      } catch (error) {
        this.logger.error("Error in debounced change handler:", error);
      }
    }, this.config.debounceMs);

    this.pendingChanges.set(path, timeout);
  }
}
