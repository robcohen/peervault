/**
 * PeerVault VSCode extension — a thin host adapter over the shared
 * PeerVaultClient (which wraps the host-agnostic Rust/wasm engine).
 *
 * Host duties only (see docs/EMBEDDING.md):
 *  - HostStorage over VSCode's workspace storage
 *  - file watching → ingest local edits into the CRDT
 *  - applying core-computed reconcile plans to the workspace with VSCode's fs
 *  - pairing UX (copy ticket / add peer), status bar, commands
 */

import * as vscode from "vscode";
import * as os from "node:os";
import {
  PeerVaultClient,
  type ClientConfig,
  type ClientEvent,
  type HostStorage,
} from "../../../src/core/peer-vault-client";

// Paths never synced (relative, forward-slash).
const EXCLUDED = [".git/", ".vscode/", ".peervault/", "node_modules/"];
const FILE_DEBOUNCE_MS = 1500;
const RECONCILE_DEBOUNCE_MS = 1000;

/** The vault key never touches disk: it lives in VSCode SecretStorage (OS keychain). */
const SECRET_KEYS = new Set(["encryption-key"]);

/**
 * HostStorage over the workspace-scoped extension storage directory, with
 * secret material routed to `vscode.SecretStorage` (keychain-backed).
 */
class VscodeStorage implements HostStorage {
  constructor(
    private base: vscode.Uri,
    private secrets: vscode.SecretStorage,
    private secretScope: string,
  ) {}

  private uri(key: string): vscode.Uri {
    return vscode.Uri.joinPath(this.base, key);
  }

  private secretName(key: string): string {
    return `peervault.${this.secretScope}.${key}`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (SECRET_KEYS.has(key)) {
      const b64 = await this.secrets.get(this.secretName(key));
      return b64 ? new Uint8Array(Buffer.from(b64, "base64")) : null;
    }
    try {
      return await vscode.workspace.fs.readFile(this.uri(key));
    } catch {
      return null;
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    if (SECRET_KEYS.has(key)) {
      await this.secrets.store(this.secretName(key), Buffer.from(value).toString("base64"));
      return;
    }
    await vscode.workspace.fs.createDirectory(this.base);
    await vscode.workspace.fs.writeFile(this.uri(key), value);
  }

  async delete(key: string): Promise<void> {
    if (SECRET_KEYS.has(key)) {
      await this.secrets.delete(this.secretName(key));
      return;
    }
    try {
      await vscode.workspace.fs.delete(this.uri(key));
    } catch {
      // already gone
    }
  }
}

class PeerVaultExtension {
  private client: PeerVaultClient | null = null;
  private status: vscode.StatusBarItem;
  private fileTimers = new Map<string, NodeJS.Timeout>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private applying = new Set<string>(); // suppress watcher echo of our own writes
  private root: vscode.Uri;

  constructor(
    private context: vscode.ExtensionContext,
    workspaceRoot: vscode.Uri,
  ) {
    this.root = workspaceRoot;
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.text = "$(sync) PeerVault: starting";
    this.status.command = "peervault.showStatus";
    this.status.show();
    context.subscriptions.push(this.status);
  }

  async start(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("peervault");

    // Stable per-workspace vault id (adopted from a peer's ticket on first pairing).
    let vaultId = this.context.workspaceState.get<string>("peervault.vaultId");
    if (!vaultId) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      vaultId = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      await this.context.workspaceState.update("peervault.vaultId", vaultId);
    }

    const storageBase = this.context.storageUri;
    if (!storageBase) throw new Error("PeerVault requires a workspace");

    const config: ClientConfig = {
      vaultId,
      deviceName: cfg.get<string>("deviceName") || os.hostname(),
      ...(cfg.get<string>("relayUrl") ? { relayUrl: cfg.get<string>("relayUrl")! } : {}),
    };

    this.client = new PeerVaultClient(
      new VscodeStorage(storageBase, this.context.secrets, vaultId.slice(0, 16)),
      config,
    );
    this.client.on((event) => this.onClientEvent(event));
    await this.client.initialize();

    // First run in an existing workspace: seed the CRDT from disk.
    const existing = await this.client.listFiles();
    if (existing.length === 0) {
      await this.initialScan(cfg.get<number>("maxFileSizeMb") ?? 10);
    }

    this.wireWatcher();
    this.updateStatus();
  }

  private relPath(uri: vscode.Uri): string | null {
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    if (rel.startsWith("..") || rel === uri.fsPath) return null; // outside workspace
    if (EXCLUDED.some((p) => rel.startsWith(p))) return null;
    return rel;
  }

  private async initialScan(maxMb: number): Promise<void> {
    const files = await vscode.workspace.findFiles(
      "**/*",
      "{**/.git/**,**/node_modules/**,**/.vscode/**,**/.peervault/**}",
    );
    let count = 0;
    for (const uri of files) {
      const rel = this.relPath(uri);
      if (!rel || !this.client) continue;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File) continue;
        if (stat.size > maxMb * 1024 * 1024) {
          console.log(`[PeerVault] Skipping large file: ${rel} (${stat.size} bytes)`);
          continue;
        }
        await this.client.setFile(rel, await vscode.workspace.fs.readFile(uri));
        count++;
      } catch (e) {
        console.warn(`[PeerVault] Scan failed for ${rel}:`, e);
      }
    }
    console.log(`[PeerVault] Initial scan ingested ${count} files`);
  }

  private wireWatcher(): void {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.context.subscriptions.push(watcher);

    const schedule = (uri: vscode.Uri) => {
      const rel = this.relPath(uri);
      if (!rel || this.applying.has(rel)) return;
      const prev = this.fileTimers.get(rel);
      if (prev) clearTimeout(prev);
      this.fileTimers.set(
        rel,
        setTimeout(async () => {
          this.fileTimers.delete(rel);
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type !== vscode.FileType.File) return;
            await this.client?.setFile(rel, await vscode.workspace.fs.readFile(uri));
          } catch {
            // File vanished between event and read — the delete handler covers it.
          }
        }, FILE_DEBOUNCE_MS),
      );
    };

    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(async (uri) => {
      const rel = this.relPath(uri);
      if (!rel || this.applying.has(rel)) return;
      const prev = this.fileTimers.get(rel);
      if (prev) {
        clearTimeout(prev);
        this.fileTimers.delete(rel);
      }
      await this.client?.deleteFile(rel);
    });
  }

  private onClientEvent(event: ClientEvent): void {
    switch (event.type) {
      case "gossip-update":
        this.scheduleReconcile();
        break;
      case "sync-complete":
        if (event.result.updatesReceived > 0) this.scheduleReconcile();
        this.updateStatus();
        break;
      case "peer-connected":
      case "peer-disconnected":
        this.updateStatus();
        break;
      case "error":
        vscode.window.showWarningMessage(`PeerVault: ${event.message}`);
        break;
    }
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.applyReconcilePlan().catch((e) =>
        console.error("[PeerVault] Reconcile failed:", e),
      );
    }, RECONCILE_DEBOUNCE_MS);
  }

  /** Apply the core-computed plan: write changed upserts, remove deletes. */
  private async applyReconcilePlan(): Promise<void> {
    if (!this.client) return;
    const dirty = Array.from(this.fileTimers.keys());
    const plan = await this.client.reconcilePlan(dirty);

    for (const rel of plan.upserts) {
      const content = await this.client.getFile(rel);
      if (!content) continue;
      const uri = vscode.Uri.joinPath(this.root, rel);
      let disk: Uint8Array | null = null;
      try {
        disk = await vscode.workspace.fs.readFile(uri);
      } catch {
        // new file
      }
      if (disk && bytesEqual(disk, content)) continue;
      this.applying.add(rel);
      try {
        await vscode.workspace.fs.writeFile(uri, content);
      } finally {
        setTimeout(() => this.applying.delete(rel), 2000);
      }
    }

    for (const rel of plan.deletes) {
      this.applying.add(rel);
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.root, rel));
      } catch {
        // already gone locally
      } finally {
        setTimeout(() => this.applying.delete(rel), 2000);
      }
    }
  }

  private updateStatus(): void {
    const peers = this.client?.getPeers().length ?? 0;
    this.status.text = `$(sync) PeerVault: ${peers} peer${peers === 1 ? "" : "s"}`;
  }

  // --- commands ---

  async copyTicket(): Promise<void> {
    if (!this.client) return;
    const ticket = await this.client.getPairingTicket();
    await vscode.env.clipboard.writeText(ticket);
    vscode.window.showInformationMessage(
      "PeerVault: pairing ticket copied (valid 10 minutes, single use)",
    );
  }

  async addPeer(): Promise<void> {
    if (!this.client) return;
    const ticket = await vscode.window.showInputBox({
      prompt: "Paste the peer's pairing ticket",
      ignoreFocusOut: true,
      password: true,
    });
    if (!ticket) return;

    // Adopt the inviter's vault id so both sides share one logical vault.
    const theirVaultId = this.client.peekVaultId(ticket);
    const ourVaultId = this.context.workspaceState.get<string>("peervault.vaultId");
    if (theirVaultId && theirVaultId !== ourVaultId) {
      await this.context.workspaceState.update("peervault.vaultId", theirVaultId);
      await this.context.workspaceState.update("peervault.pendingTicket", ticket);
      const pick = await vscode.window.showInformationMessage(
        "PeerVault: adopting the peer's vault identity requires a window reload. Reload now?",
        "Reload",
      );
      if (pick === "Reload") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
      return;
    }

    await this.connectWithProgress(ticket);
  }

  /** Complete a pairing deferred across the vault-id adoption reload. */
  async resumePendingPairing(): Promise<void> {
    const pending = this.context.workspaceState.get<string>("peervault.pendingTicket");
    if (!pending) return;
    await this.context.workspaceState.update("peervault.pendingTicket", undefined);
    await this.connectWithProgress(pending);
  }

  private async connectWithProgress(ticket: string): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PeerVault: pairing…" },
      async () => {
        try {
          const peerId = await this.client!.addPeer(ticket);
          vscode.window.showInformationMessage(
            `PeerVault: paired with ${peerId.slice(0, 8)}…`,
          );
          this.updateStatus();
          this.scheduleReconcile();
        } catch (e) {
          vscode.window.showErrorMessage(`PeerVault: pairing failed — ${e}`);
        }
      },
    );
  }

  async syncNow(): Promise<void> {
    await this.client?.syncAll();
    this.scheduleReconcile();
  }

  showStatus(): void {
    const peers = this.client?.getPeers() ?? [];
    const lines = [
      `Node: ${this.client?.nodeId ?? "not started"}`,
      `Peers: ${peers.length ? peers.map((p) => `${p.name} (${p.isConnected ? "online" : "offline"})`).join(", ") : "none"}`,
    ];
    vscode.window.showInformationMessage(`PeerVault — ${lines.join(" · ")}`);
  }

  async dispose(): Promise<void> {
    for (const t of this.fileTimers.values()) clearTimeout(t);
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    await this.client?.shutdown();
  }
}

let ext: PeerVaultExtension | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("peervault");
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;

  const needsWorkspace = () =>
    vscode.window.showWarningMessage("PeerVault: open a folder to enable sync.");

  context.subscriptions.push(
    vscode.commands.registerCommand("peervault.copyTicket", () =>
      ext ? ext.copyTicket() : needsWorkspace(),
    ),
    vscode.commands.registerCommand("peervault.addPeer", () =>
      ext ? ext.addPeer() : needsWorkspace(),
    ),
    vscode.commands.registerCommand("peervault.syncNow", () =>
      ext ? ext.syncNow() : needsWorkspace(),
    ),
    vscode.commands.registerCommand("peervault.showStatus", () =>
      ext ? ext.showStatus() : needsWorkspace(),
    ),
  );

  if (!root || !cfg.get<boolean>("enabled")) return;

  ext = new PeerVaultExtension(context, root);
  try {
    await ext.start();
    await ext.resumePendingPairing();
  } catch (e) {
    console.error("[PeerVault] Activation failed:", e);
    vscode.window.showErrorMessage(`PeerVault failed to start: ${e}`);
  }
}

export async function deactivate(): Promise<void> {
  await ext?.dispose();
  ext = null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
