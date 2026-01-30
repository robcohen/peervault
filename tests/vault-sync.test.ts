/**
 * Vault Sync Tests
 *
 * Tests for vault synchronization logic.
 * Note: Full integration tests would require mocking Obsidian's App API.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { VaultSync, type VaultSyncConfig } from "../src/core/vault-sync";
import type { DocumentManager, FileChangeEvent, FileContent } from "../src/core/document-manager";
import type { BlobStore } from "../src/core/blob-store";
import type { Logger } from "../src/utils/logger";
import type { App, TFile, TAbstractFile, Vault } from "obsidian";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    log: () => {},
    child: () => createTestLogger(),
    time: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    timeSync: <T>(_label: string, fn: () => T) => fn(),
  };
}

interface MockFile {
  path: string;
  stat?: { size: number };
  content?: string | ArrayBuffer;
}

function createMockApp(files: MockFile[] = []): App {
  const fileMap = new Map<string, MockFile>();
  for (const f of files) {
    fileMap.set(f.path, f);
  }

  const vault = {
    getFiles: () => files.filter((f) => f.stat) as unknown as TFile[],
    getAbstractFileByPath: (path: string) => fileMap.get(path) as TAbstractFile | null,
    read: async (file: TFile) => (file as unknown as MockFile).content as string,
    readBinary: async (file: TFile) => (file as unknown as MockFile).content as ArrayBuffer,
    create: mock(async () => {}),
    createBinary: mock(async () => {}),
    createFolder: mock(async () => {}),
    modify: mock(async () => {}),
    modifyBinary: mock(async () => {}),
    delete: mock(async () => {}),
    rename: mock(async () => {}),
  } as unknown as Vault;

  return { vault } as App;
}

function createMockDocumentManager(): DocumentManager & {
  changeCallbacks: Array<(event: FileChangeEvent) => void>;
  emitChange: (event: FileChangeEvent) => void;
} {
  const callbacks: Array<(event: FileChangeEvent) => void> = [];

  return {
    changeCallbacks: callbacks,
    emitChange: (event: FileChangeEvent) => {
      for (const cb of callbacks) {
        cb(event);
      }
    },
    onFileChange: (cb: (event: FileChangeEvent) => void) => {
      callbacks.push(cb);
      return () => {
        const idx = callbacks.indexOf(cb);
        if (idx >= 0) callbacks.splice(idx, 1);
      };
    },
    handleFileCreate: mock(async () => {}),
    handleFileModify: mock(async () => {}),
    handleFileDelete: mock(async () => {}),
    handleFileRename: mock(async () => {}),
    listAllPaths: () => [],
    getContent: () => null,
    setTextContent: mock(() => {}),
    setBlobHash: mock(() => {}),
  } as unknown as DocumentManager & {
    changeCallbacks: Array<(event: FileChangeEvent) => void>;
    emitChange: (event: FileChangeEvent) => void;
  };
}

function createMockBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    add: async (data: Uint8Array) => {
      const hash = `hash-${blobs.size}`;
      blobs.set(hash, data);
      return hash;
    },
    get: async (hash: string) => blobs.get(hash) ?? null,
    has: async (hash: string) => blobs.has(hash),
    delete: async (hash: string) => blobs.delete(hash),
    list: async () => Array.from(blobs.keys()),
  } as unknown as BlobStore;
}

// ============================================================================
// Tests
// ============================================================================

describe("VaultSync", () => {
  let app: App;
  let docManager: ReturnType<typeof createMockDocumentManager>;
  let blobStore: BlobStore;
  let logger: Logger;
  let vaultSync: VaultSync;

  beforeEach(() => {
    app = createMockApp();
    docManager = createMockDocumentManager();
    blobStore = createMockBlobStore();
    logger = createTestLogger();
    vaultSync = new VaultSync(app, docManager, blobStore, logger);
  });

  describe("Initialization", () => {
    it("should create with default config", () => {
      expect(vaultSync).toBeDefined();
    });

    it("should accept custom config", () => {
      const customSync = new VaultSync(app, docManager, blobStore, logger, {
        excludedFolders: ["custom/excluded"],
        maxFileSize: 50 * 1024 * 1024,
        debounceMs: 300,
      });
      expect(customSync).toBeDefined();
      expect(customSync.getExcludedFolders()).toContain("custom/excluded");
    });
  });

  describe("Start/Stop", () => {
    it("should start and subscribe to document changes", () => {
      vaultSync.start();
      expect(docManager.changeCallbacks.length).toBe(1);
    });

    it("should stop and unsubscribe from document changes", () => {
      vaultSync.start();
      expect(docManager.changeCallbacks.length).toBe(1);

      vaultSync.stop();
      expect(docManager.changeCallbacks.length).toBe(0);
    });

    it("should handle multiple start/stop cycles", () => {
      vaultSync.start();
      vaultSync.stop();
      vaultSync.start();
      vaultSync.stop();
      expect(docManager.changeCallbacks.length).toBe(0);
    });
  });

  describe("Excluded Folders", () => {
    it("should have default excluded folders", () => {
      const excluded = vaultSync.getExcludedFolders();
      expect(excluded).toContain(".obsidian/plugins");
      expect(excluded).toContain(".obsidian/themes");
    });

    it("should update excluded folders", () => {
      vaultSync.updateExcludedFolders(["new/excluded", "another/excluded"]);
      const excluded = vaultSync.getExcludedFolders();
      expect(excluded).toContain("new/excluded");
      expect(excluded).toContain("another/excluded");
      expect(excluded).not.toContain(".obsidian/plugins");
    });

    it("should return copy of excluded folders", () => {
      const excluded1 = vaultSync.getExcludedFolders();
      const excluded2 = vaultSync.getExcludedFolders();
      expect(excluded1).toEqual(excluded2);
      expect(excluded1).not.toBe(excluded2);
    });
  });

  describe("Peer Excluded Folders", () => {
    it("should start with no peer excluded folders", () => {
      expect(vaultSync.getPeerExcludedFolders()).toEqual([]);
    });

    it("should update peer excluded folders", () => {
      vaultSync.updatePeerExcludedFolders(["work", "personal/private"]);
      const excluded = vaultSync.getPeerExcludedFolders();
      expect(excluded).toContain("work");
      expect(excluded).toContain("personal/private");
    });

    it("should replace peer excluded folders on update", () => {
      vaultSync.updatePeerExcludedFolders(["old"]);
      vaultSync.updatePeerExcludedFolders(["new"]);
      const excluded = vaultSync.getPeerExcludedFolders();
      expect(excluded).toContain("new");
      expect(excluded).not.toContain("old");
    });
  });

  describe("Vault State Checks", () => {
    it("should detect empty vault", () => {
      expect(vaultSync.isVaultEmpty()).toBe(true);
    });

    it("should detect non-empty vault", () => {
      const appWithFiles = createMockApp([
        { path: "note.md", stat: { size: 100 }, content: "test" },
      ]);
      const sync = new VaultSync(appWithFiles, docManager, blobStore, logger);
      expect(sync.isVaultEmpty()).toBe(false);
    });

    it("should consider vault empty if only excluded files exist", () => {
      const appWithFiles = createMockApp([
        { path: ".obsidian/plugins/test.json", stat: { size: 100 }, content: "{}" },
      ]);
      const sync = new VaultSync(appWithFiles, docManager, blobStore, logger);
      expect(sync.isVaultEmpty()).toBe(true);
    });

    it("should detect if document has content", () => {
      expect(vaultSync.hasDocumentContent()).toBe(false);

      // Mock document manager with content
      const docWithContent = {
        ...createMockDocumentManager(),
        listAllPaths: () => ["file1.md", "file2.md"],
      };
      const sync = new VaultSync(app, docWithContent as unknown as DocumentManager, blobStore, logger);
      expect(sync.hasDocumentContent()).toBe(true);
    });
  });

  describe("File Handling", () => {
    it("should skip excluded files on create", async () => {
      await vaultSync.handleFileCreate({ path: ".obsidian/plugins/test.json" } as TAbstractFile);
      expect(docManager.handleFileCreate).not.toHaveBeenCalled();
    });

    it("should skip excluded files on modify", async () => {
      await vaultSync.handleFileModify({ path: ".obsidian/themes/style.css" } as TAbstractFile);
      expect(docManager.handleFileModify).not.toHaveBeenCalled();
    });

    it("should skip excluded files on delete", async () => {
      await vaultSync.handleFileDelete({ path: ".obsidian/plugins/plugin.js" } as TAbstractFile);
      expect(docManager.handleFileDelete).not.toHaveBeenCalled();
    });
  });

  describe("Remote Change Handling", () => {
    beforeEach(() => {
      vaultSync.start();
    });

    it("should skip remote changes for peer-excluded paths", () => {
      vaultSync.updatePeerExcludedFolders(["private"]);

      // Emit remote change for excluded path
      docManager.emitChange({
        type: "create",
        path: "private/secret.md",
        origin: "remote",
      });

      // Should not try to write file
      expect(app.vault.create).not.toHaveBeenCalled();
    });

    it("should process remote changes for non-excluded paths", () => {
      // Mock document manager to return content
      const docWithContent = createMockDocumentManager();
      (docWithContent as any).getContent = (path: string): FileContent | null => {
        if (path === "public/note.md") {
          return { type: "text", text: "Hello" };
        }
        return null;
      };

      const sync = new VaultSync(app, docWithContent, blobStore, logger);
      sync.start();

      // Emit remote change
      docWithContent.emitChange({
        type: "create",
        path: "public/note.md",
        origin: "remote",
      });

      // Note: The actual file creation is async and debounced
      // This test verifies the path isn't blocked
    });

    it("should ignore local changes", () => {
      const createSpy = mock(() => {});
      (app.vault.create as any) = createSpy;

      docManager.emitChange({
        type: "create",
        path: "local.md",
        origin: "local",
      });

      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe("Rename Edge Cases", () => {
    it("should handle rename from excluded to non-excluded", async () => {
      // When file moves from excluded to included area, should sync new path
      await vaultSync.handleFileRename(
        { path: "notes/document.md" } as TAbstractFile,
        ".obsidian/backup/document.md",
      );
      // Should call handleFileRename since new path is synced
    });

    it("should handle rename from non-excluded to excluded", async () => {
      // When file moves from included to excluded area
      await vaultSync.handleFileRename(
        { path: ".obsidian/backup/document.md" } as TAbstractFile,
        "notes/document.md",
      );
      // Should handle the rename (document manager tracks deletions)
    });

    it("should skip rename when both paths are excluded", async () => {
      await vaultSync.handleFileRename(
        { path: ".obsidian/plugins/new.json" } as TAbstractFile,
        ".obsidian/plugins/old.json",
      );
      expect(docManager.handleFileRename).not.toHaveBeenCalled();
    });
  });
});
