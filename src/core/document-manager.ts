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
  type Change,
  type OpId,
} from "loro-crdt";
import type {
  StorageAdapter,
  FileNodeMeta,
  FileNodeType,
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

/** A historical version entry with frontiers for checkout. */
export interface HistoricalVersion {
  /** Frontiers (OpIds) that can be used to checkout this version */
  frontiers: OpId[];
  /** Timestamp when this version was created (Unix seconds) */
  timestamp: number;
  /** Peer ID that created this change */
  peerId: string;
  /** Lamport timestamp for ordering */
  lamport: number;
  /** Optional commit message */
  message?: string;
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
    const nodeMeta = node.data;
    const now = Date.now();

    // Determine if binary based on extension
    const isBinary = isBinaryFile(fileName);

    nodeMeta.set("name", fileName);
    nodeMeta.set("type", isBinary ? "binary" : "file"); // 'file' | 'folder' | 'binary'
    nodeMeta.set("mimeType", this.getMimeType(fileName));
    nodeMeta.set("mtime", now);
    nodeMeta.set("ctime", now);
    nodeMeta.set("deleted", false);

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

        const nodeMeta = node.data;
        const now = Date.now();

        nodeMeta.set("name", part);
        nodeMeta.set("type", "folder"); // 'file' | 'folder' | 'binary'
        nodeMeta.set("mtime", now);
        nodeMeta.set("ctime", now);
        nodeMeta.set("deleted", false);

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

    const nodeMeta = node.data;
    const nodeType = nodeMeta.get("type") as string;

    // Validate and normalize type field
    let type: FileNodeType;
    if (nodeType === "file" || nodeType === "folder" || nodeType === "binary") {
      type = nodeType;
    } else {
      // Legacy: MIME type was stored in type field, convert to new format
      type = nodeType === "folder" ? "folder" : isBinaryFile(path) ? "binary" : "file";
    }

    return {
      name: nodeMeta.get("name") as string,
      type,
      mimeType: nodeMeta.get("mimeType") as string | undefined,
      mtime: nodeMeta.get("mtime") as number,
      ctime: nodeMeta.get("ctime") as number,
      deleted: (nodeMeta.get("deleted") as boolean) ?? false,
      blobHash: nodeMeta.get("blobHash") as string | undefined,
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
   * Set the vault ID (used when adopting a peer's vault ID during first sync).
   */
  setVaultId(vaultId: string): void {
    this.meta.set("vaultId", vaultId);
  }

  /**
   * Get the underlying Loro document (for advanced operations).
   */
  getLoro(): LoroDoc {
    return this.doc;
  }

  /**
   * Subscribe to local document updates (for sync).
   * Returns the raw bytes of local updates as they happen.
   * Use this to push updates to peers in real-time.
   *
   * @returns Unsubscribe function
   */
  subscribeLocalUpdates(callback: (updates: Uint8Array) => void): () => void {
    return this.doc.subscribeLocalUpdates(callback);
  }

  /**
   * Get version history for time-travel.
   * Returns all changes in the oplog that can be checked out.
   */
  getVersionHistory(): HistoricalVersion[] {
    const versions: HistoricalVersion[] = [];

    try {
      // Get all changes from the oplog
      const allChanges = this.doc.getAllChanges();

      // Flatten and collect all changes with their info
      for (const [peerId, changes] of allChanges.entries()) {
        for (const change of changes) {
          // Create frontiers for this change (the end of this change)
          const frontiers: OpId[] = [
            { peer: change.peer, counter: change.counter + change.length - 1 },
          ];

          versions.push({
            frontiers,
            timestamp: change.timestamp,
            peerId: peerId,
            lamport: change.lamport,
            message: change.message,
          });
        }
      }

      // Sort by lamport (causal order), then by timestamp
      versions.sort((a, b) => {
        if (a.lamport !== b.lamport) {
          return b.lamport - a.lamport; // Descending (newest first)
        }
        return b.timestamp - a.timestamp;
      });
    } catch (err) {
      this.logger.warn("Failed to get version history:", err);
    }

    return versions;
  }

  /**
   * Checkout a historical version of the document using frontiers.
   * Returns a new LoroDoc at that version (does not modify the current doc).
   */
  checkoutToFrontiers(frontiers: OpId[]): LoroDoc {
    // Export current state (full snapshot to preserve all history)
    const snapshot = this.doc.export({ mode: "snapshot" });

    // Create a new doc and import
    const historicalDoc = new LoroDoc();
    historicalDoc.import(snapshot);

    // Checkout to the specified frontiers
    try {
      historicalDoc.checkout(frontiers);
    } catch (err) {
      this.logger.warn("Checkout failed, returning current state:", err);
      // Return to latest state on failure
      historicalDoc.checkoutToLatest();
    }

    return historicalDoc;
  }

  /**
   * Checkout a historical version of the document.
   * @deprecated Use checkoutToFrontiers instead for proper version checkout.
   * Returns a new LoroDoc at that version (does not modify the current doc).
   */
  checkoutVersion(version: VersionVector): LoroDoc {
    // Export current state
    const snapshot = this.doc.export({ mode: "snapshot" });

    // Create a new doc and import
    const historicalDoc = new LoroDoc();
    historicalDoc.import(snapshot);

    // Use current frontiers as fallback (this method is deprecated)
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
   * Content is stored inside node.data per Loro best practices.
   */
  getTextContentFromDoc(doc: LoroDoc, path: string): string | undefined {
    // Find the node by path in the historical doc
    const tree = doc.getTree("files");
    const roots = tree.roots();

    for (const root of roots) {
      const result = this.findNodeByPathInTree(root, path, "");
      if (result) {
        // Content is stored in node.data.content
        const textContainer = result.data.get("content");
        if (textContainer) {
          if (typeof textContainer === "string") {
            return textContainer;
          }
          if (
            typeof textContainer === "object" &&
            "toString" in textContainer
          ) {
            return (textContainer as { toString(): string }).toString();
          }
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
   * Content is stored inside node.data per Loro best practices.
   */
  setTextContent(path: string, content: string): void {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) {
      this.logger.warn("Cannot set content: file not found:", path);
      return;
    }

    const node = this.getNodeById(nodeId);
    if (!node) {
      this.logger.warn("Cannot set content: node not found:", nodeId);
      return;
    }

    const nodeMeta = node.data;

    // Get or create LoroText container inside node.data
    let textContainer = nodeMeta.get("content") as LoroText | undefined;
    if (!textContainer || !(textContainer instanceof LoroText)) {
      // Create new LoroText container inside node metadata
      textContainer = nodeMeta.setContainer("content", new LoroText());
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
    nodeMeta.set("type", "file");
    nodeMeta.set("mtime", Date.now());

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
   * Content is stored inside node.data per Loro best practices.
   */
  getTextContent(path: string): string | undefined {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) return undefined;

    const node = this.getNodeById(nodeId);
    if (!node) return undefined;

    const textContainer = node.data.get("content") as LoroText | undefined;
    if (!textContainer) return undefined;

    // Handle both LoroText and legacy string content
    if (typeof textContainer === "string") {
      return textContainer;
    }

    return textContainer.toString();
  }

  /**
   * Set binary content reference (blob hash) for a file.
   * Blob hash is stored in node.data.blobHash per Loro best practices.
   */
  setBlobHash(path: string, blobHash: string): void {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) {
      this.logger.warn("Cannot set blob hash: file not found:", path);
      return;
    }

    const node = this.getNodeById(nodeId);
    if (!node) {
      this.logger.warn("Cannot set blob hash: node not found:", nodeId);
      return;
    }

    // Store blob hash in node metadata
    const nodeMeta = node.data;
    nodeMeta.set("type", "binary");
    nodeMeta.set("blobHash", blobHash);
    nodeMeta.set("mtime", Date.now());

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
   * Blob hash is stored in node.data.blobHash per Loro best practices.
   */
  getBlobHash(path: string): string | undefined {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) return undefined;

    const node = this.getNodeById(nodeId);
    if (!node) return undefined;

    return node.data.get("blobHash") as string | undefined;
  }

  /**
   * Get content info for a file.
   */
  getContent(path: string): FileContent | undefined {
    const nodeId = this.pathCache.get(path);
    if (!nodeId) return undefined;

    const node = this.getNodeById(nodeId);
    if (!node) return undefined;

    const nodeType = node.data.get("type") as string;

    if (nodeType === "folder") {
      return { type: "folder" };
    }

    if (nodeType === "binary") {
      return {
        type: "binary",
        blobHash: this.getBlobHash(path),
      };
    }

    // Default to text (type === "file")
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

      const nodeType = node.data.get("type") as string;
      if (nodeType === "folder") continue;

      // Check if content exists in node.data
      const hasTextContent = node.data.get("content") !== undefined;
      const hasBlobHash = node.data.get("blobHash") !== undefined;

      if (!hasTextContent && !hasBlobHash) {
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
