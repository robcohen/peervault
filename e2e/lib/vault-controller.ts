/**
 * Vault Controller
 *
 * Controls vault file operations via CDP by calling Obsidian's vault API.
 * All file operations go through Obsidian rather than direct filesystem access
 * to ensure proper event triggering and plugin integration.
 */

import type { CDPClient } from "./cdp-client";

/** File metadata */
export interface FileStat {
  size: number;
  ctime: number;
  mtime: number;
}

/** Result of deleteAllFiles operation */
export interface DeleteAllResult {
  deleted: number;
  failed: number;
  failedPaths: string[];
}

/**
 * Controller for vault file operations.
 */
export class VaultController {
  constructor(
    private client: CDPClient,
    public readonly vaultName: string
  ) {}

  /**
   * Create a new file in the vault.
   *
   * @param overwrite - If true, overwrites existing file. If false (default), throws if file exists.
   */
  async createFile(
    path: string,
    content: string | Uint8Array,
    overwrite = false
  ): Promise<void> {
    const contentStr =
      content instanceof Uint8Array
        ? Buffer.from(content).toString("base64")
        : content;
    const isBinary = content instanceof Uint8Array;

    await this.client.evaluate(`
      (async function() {
        const vault = window.app.vault;
        const path = ${JSON.stringify(path)};
        const content = ${JSON.stringify(contentStr)};
        const isBinary = ${isBinary};
        const overwrite = ${overwrite};

        // Ensure parent folders exist
        const parts = path.split('/');
        if (parts.length > 1) {
          const folderPath = parts.slice(0, -1).join('/');
          const folder = vault.getAbstractFileByPath(folderPath);
          if (!folder) {
            await vault.createFolder(folderPath);
          }
        }

        // Check if file exists
        const existing = vault.getAbstractFileByPath(path);
        if (existing) {
          if (!overwrite) {
            throw new Error('File already exists.');
          }
          // Delete existing to replace
          await vault.delete(existing);
        }

        // Create the file
        if (isBinary) {
          // Decode base64 and create binary file
          const binary = Uint8Array.from(atob(content), c => c.charCodeAt(0));
          await vault.createBinary(path, binary);
        } else {
          await vault.create(path, content);
        }
      })()
    `);
  }

  /**
   * Read a file from the vault.
   */
  async readFile(path: string): Promise<string> {
    return await this.client.evaluate<string>(`
      (async function() {
        const vault = window.app.vault;
        const file = vault.getAbstractFileByPath(${JSON.stringify(path)});
        if (!file) {
          throw new Error('File not found: ${path}');
        }
        return await vault.read(file);
      })()
    `);
  }

  /**
   * Read a binary file from the vault.
   */
  async readBinaryFile(path: string): Promise<Uint8Array> {
    const base64 = await this.client.evaluate<string>(`
      (async function() {
        const vault = window.app.vault;
        const file = vault.getAbstractFileByPath(${JSON.stringify(path)});
        if (!file) {
          throw new Error('File not found: ${path}');
        }
        const data = await vault.readBinary(file);
        // Convert to base64 for transport
        const bytes = new Uint8Array(data);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      })()
    `);
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }

  /**
   * Modify an existing file.
   */
  async modifyFile(path: string, content: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const vault = window.app.vault;
        const file = vault.getAbstractFileByPath(${JSON.stringify(path)});
        if (!file) {
          throw new Error('File not found: ${path}');
        }
        await vault.modify(file, ${JSON.stringify(content)});
      })()
    `);
  }

  /**
   * Delete a file from the vault.
   */
  async deleteFile(path: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const vault = window.app.vault;
        const file = vault.getAbstractFileByPath(${JSON.stringify(path)});
        if (!file) {
          throw new Error('File not found: ${path}');
        }
        await vault.delete(file);
      })()
    `);
  }

  /**
   * Rename or move a file.
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const vault = window.app.vault;
        const file = vault.getAbstractFileByPath(${JSON.stringify(oldPath)});
        if (!file) {
          throw new Error('File not found: ${oldPath}');
        }

        // Ensure parent folders exist for new path
        const parts = ${JSON.stringify(newPath)}.split('/');
        if (parts.length > 1) {
          const folderPath = parts.slice(0, -1).join('/');
          const folder = vault.getAbstractFileByPath(folderPath);
          if (!folder) {
            await vault.createFolder(folderPath);
          }
        }

        await vault.rename(file, ${JSON.stringify(newPath)});
      })()
    `);
  }

  /**
   * Create a folder.
   */
  async createFolder(path: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const vault = window.app.vault;
        const existing = vault.getAbstractFileByPath(${JSON.stringify(path)});
        if (!existing) {
          await vault.createFolder(${JSON.stringify(path)});
        }
      })()
    `);
  }

  /**
   * Delete a folder and all its contents.
   */
  async deleteFolder(path: string): Promise<void> {
    await this.client.evaluate(`
      (async function() {
        const vault = window.app.vault;
        const folder = vault.getAbstractFileByPath(${JSON.stringify(path)});
        if (!folder) {
          throw new Error('Folder not found: ${path}');
        }
        await vault.delete(folder, true); // true = force delete contents
      })()
    `);
  }

  /**
   * List all files in the vault (excluding .obsidian folder).
   */
  async listFiles(): Promise<string[]> {
    return await this.client.evaluate<string[]>(`
      (function() {
        const vault = window.app.vault;
        return vault.getFiles()
          .map(f => f.path)
          .filter(p => !p.startsWith('.obsidian/'));
      })()
    `);
  }

  /**
   * List all markdown files in the vault.
   */
  async listMarkdownFiles(): Promise<string[]> {
    return await this.client.evaluate<string[]>(`
      (function() {
        const vault = window.app.vault;
        return vault.getMarkdownFiles()
          .map(f => f.path)
          .filter(p => !p.startsWith('.obsidian/'));
      })()
    `);
  }

  /**
   * Check if a file exists.
   */
  async fileExists(path: string): Promise<boolean> {
    return await this.client.evaluate<boolean>(`
      (function() {
        const vault = window.app.vault;
        const file = vault.getAbstractFileByPath(${JSON.stringify(path)});
        return file !== null;
      })()
    `);
  }

  /**
   * Get file metadata.
   */
  async getFileStat(path: string): Promise<FileStat | null> {
    return await this.client.evaluate<FileStat | null>(`
      (function() {
        const vault = window.app.vault;
        const file = vault.getAbstractFileByPath(${JSON.stringify(path)});
        if (!file || !file.stat) return null;
        return {
          size: file.stat.size,
          ctime: file.stat.ctime,
          mtime: file.stat.mtime,
        };
      })()
    `);
  }

  /**
   * Delete all files in the vault (except .obsidian folder).
   * Used for test cleanup.
   *
   * @param throwOnFailure - If true, throws an error if any files fail to delete
   * @returns Statistics about the deletion operation
   */
  async deleteAllFiles(throwOnFailure = false): Promise<DeleteAllResult> {
    const result = await this.client.evaluate<DeleteAllResult>(`
      (async function() {
        const vault = window.app.vault;
        const files = vault.getFiles().filter(f => !f.path.startsWith('.obsidian/'));

        let deleted = 0;
        let failed = 0;
        const failedPaths = [];

        for (const file of files) {
          try {
            await vault.delete(file);
            deleted++;
          } catch (e) {
            failed++;
            failedPaths.push(file.path);
            console.warn('Failed to delete:', file.path, e);
          }
        }

        // Also delete empty folders
        const folders = vault.getAllLoadedFiles()
          .filter(f => f.children !== undefined) // Is a folder
          .filter(f => !f.path.startsWith('.obsidian'))
          .filter(f => f.path !== '/') // Not root
          .sort((a, b) => b.path.length - a.path.length); // Delete deepest first

        for (const folder of folders) {
          try {
            if (folder.children?.length === 0) {
              await vault.delete(folder);
            }
          } catch (e) {
            // Ignore errors for non-empty folders - this is expected
          }
        }

        return { deleted, failed, failedPaths };
      })()
    `);

    if (throwOnFailure && result.failed > 0) {
      throw new Error(
        `Failed to delete ${result.failed} file(s): ${result.failedPaths.join(", ")}`
      );
    }

    return result;
  }

  /**
   * Get the vault path on disk.
   */
  async getVaultPath(): Promise<string> {
    return await this.client.evaluate<string>(`
      (function() {
        return window.app.vault.adapter.basePath;
      })()
    `);
  }
}
