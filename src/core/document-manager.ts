/**
 * Document Manager - Loro CRDT document management
 *
 * Handles the core Loro document operations including file tree management,
 * content storage, and synchronization.
 */

import {
  LoroDoc,
  LoroTree,
  LoroMap,
  LoroText,
  LoroList,
  LoroTreeNode,
  VersionVector,
} from "loro-crdt";
import type {
  StorageAdapter,
  FileNodeMeta,
  SerializedVersionVector,
} from "../types";
import type { Logger } from "../utils/logger";
import { isBinaryFile } from "./blob-store";
import { computeTextEdits } from "../utils/text-diff";

/**
 * Wait for loro-crdt WASM to be initialized.
 * This is required because on mobile, WASM must be loaded asynchronously.
 * Call this before using any loro-crdt functions.
 */
export async function waitForLoroWasm(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loroModule = (await import("loro-crdt")) as any;
  if (loroModule.__wasmReady) {
    await loroModule.__wasmReady;
  }
}

const SNAPSHOT_KEY = "peervault-snapshot";

// TreeID is a string in format `${counter}@${peer}` where peer is a number
type TreeID = `${number}@${number}`;

/** Content type stored in the document */
export type ContentType = "text" | "binary" | "folder";

/** File content info */
export interface FileContent {
  type: ContentType;
  /** Text content (for text files) */
  text?: string;
  /** Blob hash (for binary files) */
  blobHash?: string;
}

/** Change event for external listeners */
export interface FileChangeEvent {
  type: "create" | "modify" | "delete" | "rename";
  path: string;
  oldPath?: string;
  origin: "local" | "remote";
}

export class DocumentManager {
  private doc: LoroDoc;
  private tree: LoroTree;
  private meta: LoroMap;
  private contents: LoroMap; // Map of nodeId -> LoroText or blob hash
  private pathCache = new Map<string, TreeID>();
  private nodePathCache = new Map<string, string>(); // TreeID string -> path
  private initialized = false;
  private changeCallbacks: Array<(event: FileChangeEvent) => void> = [];

  constructor(
    private storage: StorageAdapter,
    private logger: Logger,
  ) {
    this.doc = new LoroDoc();
    this.tree = this.doc.getTree("files");
    this.meta = this.doc.getMap("meta");
    this.contents = this.doc.getMap("contents");
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize the document, loading from storage if available.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Try to load existing document
      const snapshot = await this.storage.read(SNAPSHOT_KEY);
      if (snapshot) {
        this.logger.info("Loading document from snapshot...");
        this.doc.import(snapshot);
        this.rebuildPathCache();
        this.logger.info("Document loaded successfully");
      } else {
        this.logger.info("No existing document found, starting fresh");
        this.initializeSchema();
      }

      // Subscribe to document changes
      this.doc.subscribe((event) => {
        this.handleDocChange(event);
      });

      this.initialized = true;
    } catch (error) {
      this.logger.error("Failed to initialize document:", error);
      throw error;
    }
  }

  /**
   * Initialize the document schema for a new document.
   */
  private initializeSchema(): void {
    // Set up metadata
    this.meta.set("version", 1);
    this.meta.set("createdAt", Date.now());
    this.meta.set("vaultId", crypto.randomUUID());

    this.doc.commit();
  }

  /**
   * Get the schema version from the document metadata.
   * Returns 1 for documents created before version tracking was added.
   */
  getSchemaVersion(): number {
    const version = this.meta.get("version");
    return typeof version === "number" ? version : 1;
  }

  /**
   * Set the schema version in the document metadata.
   * Called after successful migrations.
   */
  setSchemaVersion(version: number): void {
    this.meta.set("version", version);
    this.meta.set("versionUpdatedAt", Date.now());
    this.doc.commit();
  }

  /**
   * Rebuild path cache from the document tree.
   */
  private rebuildPathCache(): void {
    this.pathCache.clear();
    this.nodePathCache.clear();

    const roots = this.tree.roots();
    for (const root of roots) {
      this.cacheNodePath(root, "");
    }
  }

  private cacheNodePath(node: LoroTreeNode, parentPath: string): void {
    const meta = node.data;
    const name = meta?.get("name") as string | undefined;
    if (!name) return;

    const deleted = meta?.get("deleted") as boolean | undefined;
    if (deleted) return;

    const path = parentPath ? `${parentPath}/${name}` : name;
    const nodeId = this.getNodeId(node);
    this.pathCache.set(path, nodeId);
    this.nodePathCache.set(nodeId, path);

    // Recursively cache children
    const children = node.children() ?? [];
    for (const child of children) {
      this.cacheNodePath(child, path);
    }
  }

  /**
   * Get the TreeID string from a LoroTreeNode.
   */
  private getNodeId(node: LoroTreeNode): TreeID {
    const id = node.creationId();
    return `${id.counter}@${id.peer}` as TreeID;
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Save the document to storage.
   */
  async save(): Promise<void> {
    try {
      const snapshot = this.doc.export({ mode: "snapshot" });
      await this.storage.write(SNAPSHOT_KEY, snapshot);
      this.logger.debug("Document saved");
    } catch (error) {
      this.logger.error("Failed to save document:", error);
      throw error;
    }
  }

  /**
   * Export incremental updates since a version.
   */
  exportUpdates(sinceVersion?: VersionVector): Uint8Array {
    if (sinceVersion) {
      return this.doc.export({ mode: "update", from: sinceVersion });
    }
    return this.doc.export({ mode: "update" });
  }

  /**
   * Get the current document size in bytes.
   */
  getDocumentSize(): number {
    const snapshot = this.doc.export({ mode: "snapshot" });
    return snapshot.length;
  }

  /**
   * Compact the document by creating a shallow snapshot.
   * This discards detailed history while preserving current state.
   *
   * WARNING: After compaction, incremental sync with peers that haven't
   * synced recently may require a full sync instead.
   *
   * @returns Size before and after compaction
   */
  async compact(): Promise<{ beforeSize: number; afterSize: number }> {
    const beforeSize = this.getDocumentSize();

    // Get current frontiers for shallow snapshot
    const frontiers = this.doc.oplogFrontiers();

    // Export as shallow snapshot (discards detailed operation history)
    // Note: shallow-snapshot mode requires peers to have synced recently
    // to be able to continue incremental sync
    const compacted = this.doc.export({ mode: "shallow-snapshot", frontiers });

    // Create a new document from the compacted export
    const newDoc = new LoroDoc();
    newDoc.import(compacted);

    // Replace current document internals
    this.doc = newDoc;
    this.tree = this.doc.getTree("files");
    this.meta = this.doc.getMap("meta");
    this.contents = this.doc.getMap("contents");

    // Rebuild caches
    this.rebuildPathCache();

    // Re-subscribe to document changes
    this.doc.subscribe((event) => {
      this.handleDocChange(event);
    });

    const afterSize = compacted.length;

    this.logger.info(
      `Document compacted: ${beforeSize} -> ${afterSize} bytes (${((1 - afterSize / beforeSize) * 100).toFixed(1)}% reduction)`,
    );

    return { beforeSize, afterSize };
  }

  /**
   * Import updates from a peer.
   */
  importUpdates(updates: Uint8Array): void {
    this.doc.import(updates);
    this.rebuildPathCache();
  }

  /**
   * Get the current version vector.
   */
  getVersion(): VersionVector {
    return this.doc.oplogVersion();
  }

  /**
   * Export the version vector as bytes for network transmission.
   */
  getVersionBytes(): Uint8Array {
    return this.doc.oplogVersion().encode();
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Handle a file creation event from the vault.
   */
  async handleFileCreate(path: string): Promise<void> {
    if (this.pathCache.has(path)) {
      // File already exists in document
      return;
    }

    const parts = path.split("/");
    const fileName = parts.pop()!;
    const parentPath = parts.join("/");

    // Ensure parent folders exist
    let parentId: TreeID | undefined;
    if (parentPath) {
      parentId = await this.ensureFolderPath(parentPath);
    }

    // Create file node
    const node = this.tree.createNode(parentId);
    const nodeId = this.getNodeId(node);
    const meta = node.data;
    const now = Date.now();

    meta.set("name", fileName);
    meta.set("type", this.getMimeType(fileName));
    meta.set("mtime", now);
    meta.set("ctime", now);

    // Cache the path
    this.pathCache.set(path, nodeId);
    this.nodePathCache.set(nodeId, path);

    this.doc.commit();
    this.logger.debug("Created file node:", path);
  }

  /**
   * Handle a file modification event from the vault.
   */
  async handleFileModify(path: string): Promise<void> {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) {
      // File doesn't exist in document, create it
      await this.handleFileCreate(path);
      return;
    }

    const node = this.getNodeById(nodeId);
    if (!node) return;

    const meta = node.data;
    meta.set("mtime", Date.now());

    this.doc.commit();
    this.logger.debug("Modified file node:", path);
  }

  /**
   * Handle a file deletion event from the vault.
   */
  async handleFileDelete(path: string): Promise<void> {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) return;

    const node = this.getNodeById(nodeId);
    if (!node) return;

    // Soft delete - set deleted flag
    const meta = node.data;
    meta.set("deleted", true);
    meta.set("deletedAt", Date.now());

    // Remove from cache
    this.pathCache.delete(path);
    this.nodePathCache.delete(nodeId);

    this.doc.commit();
    this.logger.debug("Deleted file node:", path);
  }

  /**
   * Handle a file rename event from the vault.
   */
  async handleFileRename(oldPath: string, newPath: string): Promise<void> {
    const nodeId = this.pathCache.get(oldPath);
    if (!nodeId) {
      // Old file doesn't exist, just create the new one
      await this.handleFileCreate(newPath);
      return;
    }

    const node = this.getNodeById(nodeId);
    if (!node) return;

    const oldParts = oldPath.split("/");
    const newParts = newPath.split("/");
    const newFileName = newParts.pop()!;
    const newParentPath = newParts.join("/");

    // Update name
    const meta = node.data;
    meta.set("name", newFileName);
    meta.set("mtime", Date.now());

    // Move to new parent if needed
    const oldParentPath = oldParts.slice(0, -1).join("/");
    if (oldParentPath !== newParentPath) {
      const newParentId = newParentPath
        ? await this.ensureFolderPath(newParentPath)
        : undefined;

      const newParentNode = newParentId
        ? this.getNodeById(newParentId)
        : undefined;
      node.move(newParentNode);
    }

    // Update caches
    this.pathCache.delete(oldPath);
    this.pathCache.set(newPath, nodeId);
    this.nodePathCache.set(nodeId, newPath);

    this.doc.commit();
    this.logger.debug("Renamed file node:", oldPath, "->", newPath);
  }

  /**
   * Ensure a folder path exists, creating intermediate folders as needed.
   */
  private async ensureFolderPath(folderPath: string): Promise<TreeID> {
    // Check cache first
    const cached = this.pathCache.get(folderPath);
    if (cached) return cached;

    const parts = folderPath.split("/");
    let currentPath = "";
    let parentId: TreeID | undefined;

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let nodeId = this.pathCache.get(currentPath);
      if (!nodeId) {
        // Create folder
        const node = this.tree.createNode(parentId);
        nodeId = this.getNodeId(node);

        const meta = node.data;
        const now = Date.now();

        meta.set("name", part);
        meta.set("type", "folder");
        meta.set("mtime", now);
        meta.set("ctime", now);

        this.pathCache.set(currentPath, nodeId);
        this.nodePathCache.set(nodeId, currentPath);
      }

      parentId = nodeId;
    }

    return parentId!;
  }

  /**
   * Get a LoroTreeNode by its TreeID.
   */
  private getNodeById(nodeId: TreeID): LoroTreeNode | undefined {
    const nodes = this.tree.getNodes({ withDeleted: true });
    return nodes.find((n) => this.getNodeId(n) === nodeId);
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  /**
   * Get a file node ID by path.
   */
  getNodeByPath(path: string): TreeID | undefined {
    return this.pathCache.get(path);
  }

  /**
   * Get the path for a node ID.
   */
  getPathByNode(nodeId: TreeID): string | undefined {
    return this.nodePathCache.get(nodeId);
  }

  /**
   * Get file metadata for a path.
   */
  getFileMeta(path: string): FileNodeMeta | undefined {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) return undefined;

    const node = this.getNodeById(nodeId);
    if (!node) return undefined;

    const meta = node.data;
    return {
      name: meta.get("name") as string,
      type: meta.get("type") as string,
      mtime: meta.get("mtime") as number,
      ctime: meta.get("ctime") as number,
      deleted: meta.get("deleted") as boolean | undefined,
      blobHash: meta.get("blobHash") as string | undefined,
    };
  }

  /**
   * List all file paths in the document.
   */
  listAllPaths(): string[] {
    return Array.from(this.pathCache.keys());
  }

  /**
   * Get the vault ID.
   */
  getVaultId(): string {
    return this.meta.get("vaultId") as string;
  }

  /**
   * Get the underlying Loro document (for advanced operations).
   */
  getLoro(): LoroDoc {
    return this.doc;
  }

  /**
   * Get version history for time-travel.
   * Returns frontiers that can be used to checkout historical states.
   */
  getVersionHistory(): Array<{ version: VersionVector; timestamp?: number }> {
    // Get the current version
    const currentVersion = this.doc.oplogVersion();

    // For now, return just the current state
    // A full implementation would iterate through the oplog
    return [{ version: currentVersion }];
  }

  /**
   * Checkout a historical version of the document.
   * Returns a new LoroDoc at that version (does not modify the current doc).
   */
  checkoutVersion(version: VersionVector): LoroDoc {
    // Export current state
    const snapshot = this.doc.export({ mode: "snapshot" });

    // Create a new doc and import
    const historicalDoc = new LoroDoc();
    historicalDoc.import(snapshot);

    // Checkout to the specified version using frontiers
    // Loro's checkout API uses frontiers (array of IDs)
    try {
      const frontiers = this.doc.oplogFrontiers();
      historicalDoc.checkout(frontiers);
    } catch (err) {
      this.logger.warn("Checkout failed, returning current state:", err);
    }

    return historicalDoc;
  }

  /**
   * Get text content from a historical document state.
   */
  getTextContentFromDoc(doc: LoroDoc, path: string): string | undefined {
    // Rebuild path cache for the historical doc
    const tree = doc.getTree("files");
    const contents = doc.getMap("contents");

    // Find the node by path
    const roots = tree.roots();
    for (const root of roots) {
      const result = this.findNodeByPathInTree(root, path, "");
      if (result) {
        const nodeId = `${result.creationId().counter}@${result.creationId().peer}`;
        const textContainer = contents.get(nodeId);
        if (
          textContainer &&
          typeof textContainer === "object" &&
          "toString" in textContainer
        ) {
          return (textContainer as { toString(): string }).toString();
        }
      }
    }

    return undefined;
  }

  /**
   * Helper to find a node by path in a tree.
   */
  private findNodeByPathInTree(
    node: LoroTreeNode,
    targetPath: string,
    currentPath: string,
  ): LoroTreeNode | undefined {
    const meta = node.data;
    const name = meta?.get("name") as string | undefined;
    if (!name) return undefined;

    const deleted = meta?.get("deleted") as boolean | undefined;
    if (deleted) return undefined;

    const path = currentPath ? `${currentPath}/${name}` : name;

    if (path === targetPath) {
      return node;
    }

    // Search children
    const children = node.children() ?? [];
    for (const child of children) {
      const result = this.findNodeByPathInTree(child, targetPath, path);
      if (result) return result;
    }

    return undefined;
  }

  // ===========================================================================
  // Content Management
  // ===========================================================================

  /**
   * Set text content for a file.
   * Uses LoroText for CRDT-based text merging with minimal diffs.
   */
  setTextContent(path: string, content: string): void {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) {
      this.logger.warn("Cannot set content: file not found:", path);
      return;
    }

    // Get or create LoroText for this file
    let textContainer = this.contents.get(nodeId) as LoroText | undefined;
    if (!textContainer) {
      textContainer = this.contents.setContainer(nodeId, new LoroText());
    }

    // Get current content and compute minimal edits
    const currentContent = textContainer.toString();

    // Fast path: no changes
    if (currentContent === content) {
      return;
    }

    // Compute diff and apply minimal edits
    const edits = computeTextEdits(currentContent, content);

    // Apply edits in reverse order (from end to start) to preserve positions
    for (let i = edits.length - 1; i >= 0; i--) {
      const edit = edits[i]!;

      // Delete old text
      if (edit.deleteCount > 0) {
        textContainer.delete(edit.position, edit.deleteCount);
      }

      // Insert new text
      if (edit.insertText.length > 0) {
        textContainer.insert(edit.position, edit.insertText);
      }
    }

    // Update metadata
    const node = this.getNodeById(nodeId);
    if (node) {
      node.data.set("contentType", "text");
      node.data.set("mtime", Date.now());
    }

    this.doc.commit();
    this.logger.debug(
      "Set text content for:",
      path,
      "edits:",
      edits.length,
      "length:",
      content.length,
    );
  }

  /**
   * Get text content for a file.
   */
  getTextContent(path: string): string | undefined {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) return undefined;

    const textContainer = this.contents.get(nodeId) as LoroText | undefined;
    if (!textContainer) return undefined;

    return textContainer.toString();
  }

  /**
   * Set binary content reference (blob hash) for a file.
   */
  setBlobHash(path: string, blobHash: string): void {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) {
      this.logger.warn("Cannot set blob hash: file not found:", path);
      return;
    }

    // Store blob hash directly (not as LoroText)
    this.contents.set(nodeId, blobHash);

    // Update metadata
    const node = this.getNodeById(nodeId);
    if (node) {
      node.data.set("contentType", "binary");
      node.data.set("blobHash", blobHash);
      node.data.set("mtime", Date.now());
    }

    this.doc.commit();
    this.logger.debug(
      "Set blob hash for:",
      path,
      "hash:",
      blobHash.substring(0, 8),
    );
  }

  /**
   * Get blob hash for a binary file.
   */
  getBlobHash(path: string): string | undefined {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) return undefined;

    const node = this.getNodeById(nodeId);
    if (!node) return undefined;

    // Check metadata first
    const metaHash = node.data.get("blobHash") as string | undefined;
    if (metaHash) return metaHash;

    // Fall back to contents map
    const content = this.contents.get(nodeId);
    if (typeof content === "string") {
      return content;
    }

    return undefined;
  }

  /**
   * Get content info for a file.
   */
  getContent(path: string): FileContent | undefined {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) return undefined;

    const node = this.getNodeById(nodeId);
    if (!node) return undefined;

    const contentType = node.data.get("contentType") as ContentType | undefined;
    const mimeType = node.data.get("type") as string;

    if (mimeType === "folder") {
      return { type: "folder" };
    }

    if (contentType === "binary") {
      return {
        type: "binary",
        blobHash: this.getBlobHash(path),
      };
    }

    // Default to text
    return {
      type: "text",
      text: this.getTextContent(path),
    };
  }

  /**
   * Check if a path is a binary file based on extension.
   */
  isBinaryPath(path: string): boolean {
    return isBinaryFile(path);
  }

  /**
   * Subscribe to file change events (for syncing changes to vault).
   */
  onFileChange(callback: (event: FileChangeEvent) => void): () => void {
    this.changeCallbacks.push(callback);
    return () => {
      const idx = this.changeCallbacks.indexOf(callback);
      if (idx >= 0) this.changeCallbacks.splice(idx, 1);
    };
  }

  /**
   * Emit a file change event.
   */
  private emitFileChange(event: FileChangeEvent): void {
    for (const callback of this.changeCallbacks) {
      try {
        callback(event);
      } catch (err) {
        this.logger.error("Error in file change callback:", err);
      }
    }
  }

  /**
   * Get all files that need content (have no content stored yet).
   */
  getFilesNeedingContent(): string[] {
    const result: string[] = [];

    for (const [path, nodeId] of this.pathCache) {
      const node = this.getNodeById(nodeId);
      if (!node) continue;

      const mimeType = node.data.get("type") as string;
      if (mimeType === "folder") continue;

      const hasContent = this.contents.get(nodeId) !== undefined;
      if (!hasContent) {
        result.push(path);
      }
    }

    return result;
  }

  /**
   * Get all blob hashes referenced in the document.
   */
  getAllBlobHashes(): string[] {
    const hashes: string[] = [];

    for (const [path, nodeId] of this.pathCache) {
      const hash = this.getBlobHash(path);
      if (hash) {
        hashes.push(hash);
      }
    }

    return hashes;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private getMimeType(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      md: "text/markdown",
      txt: "text/plain",
      json: "application/json",
      canvas: "application/json",
      css: "text/css",
      js: "application/javascript",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      pdf: "application/pdf",
    };
    return mimeTypes[ext ?? ""] ?? "application/octet-stream";
  }

  private handleDocChange(event: unknown): void {
    // Handle document changes from Loro
    this.logger.debug("Document changed:", event);
  }
}
