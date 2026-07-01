// Headless extension-host simulation: loads the BUNDLED dist/extension.js in
// plain Node with a minimal `vscode` API stub and drives the real extension
// end to end. Run as two processes:
//
//   node ext-host-sim.cjs acceptor  <workdir>   # prints TICKET:<...> then waits
//   node ext-host-sim.cjs initiator <workdir> <ticket>
//
// The initiator exercises the vault-id adoption path: addPeer → adoption →
// (simulated) window reload → resumePendingPairing → sync. PASS is printed on
// the acceptor when the initiator's file lands on its disk, and on the
// initiator when the acceptor's pre-existing file lands on its disk.

const Module = require("module");
const fsp = require("node:fs/promises");
const fss = require("node:fs");
const path = require("node:path");

const [, , role, workdir, ticketArg] = process.argv;
if (!role || !workdir) {
  console.error("usage: ext-host-sim.cjs <acceptor|initiator> <workdir> [ticket]");
  process.exit(2);
}
const ROOT = path.resolve(workdir, "workspace");
const STORAGE = path.resolve(workdir, "storage");
fss.mkdirSync(ROOT, { recursive: true });
fss.mkdirSync(STORAGE, { recursive: true });

const RELAY = process.env.PEERVAULT_TEST_RELAY ?? "http://localhost:3340";

// ---------------------------------------------------------------------------
// Minimal vscode stub
// ---------------------------------------------------------------------------
const uriOf = (fsPath) => ({
  fsPath,
  path: fsPath,
  toString: () => `file://${fsPath}`,
});

const registeredCommands = new Map();
const watcherHandlers = { change: null, create: null, delete: null };
let clipboard = "";
let inputBoxQueue = [];
let reloadRequested = false;

const FileType = { File: 1, Directory: 2 };

const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  ProgressLocation: { Notification: 15 },
  FileType,
  Uri: {
    joinPath: (base, ...parts) => uriOf(path.join(base.fsPath, ...parts)),
    file: (p) => uriOf(p),
  },
  workspace: {
    workspaceFolders: [{ uri: uriOf(ROOT), name: "sim", index: 0 }],
    getConfiguration: () => ({
      get: (key) =>
        ({
          enabled: true,
          deviceName: `sim-${role}`,
          relayUrl: RELAY,
          maxFileSizeMb: 10,
        })[key],
    }),
    asRelativePath: (uri) => path.relative(ROOT, uri.fsPath),
    findFiles: async () => {
      const out = [];
      const walk = async (dir) => {
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (![".git", ".vscode", "node_modules", ".peervault"].includes(e.name)) await walk(p);
          } else out.push(uriOf(p));
        }
      };
      await walk(ROOT);
      return out;
    },
    createFileSystemWatcher: () => ({
      onDidChange: (h) => (watcherHandlers.change = h),
      onDidCreate: (h) => (watcherHandlers.create = h),
      onDidDelete: (h) => (watcherHandlers.delete = h),
      dispose: () => {},
    }),
    fs: {
      readFile: async (uri) => new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri, data) => {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, data);
      },
      delete: async (uri) => fsp.rm(uri.fsPath, { recursive: true }),
      createDirectory: async (uri) => fsp.mkdir(uri.fsPath, { recursive: true }),
      stat: async (uri) => {
        const s = await fsp.stat(uri.fsPath);
        return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size };
      },
    },
  },
  window: {
    createStatusBarItem: () => ({ text: "", command: "", show: () => {}, dispose: () => {} }),
    showInformationMessage: (_msg, ...items) =>
      Promise.resolve(items.includes("Reload") ? "Reload" : undefined),
    showWarningMessage: (msg) => {
      console.error(`[warn] ${msg}`);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (msg) => {
      console.error(`[error] ${msg}`);
      return Promise.resolve(undefined);
    },
    showInputBox: async () => inputBoxQueue.shift(),
    withProgress: (_opts, task) => task({ report: () => {} }),
  },
  commands: {
    registerCommand: (id, fn) => {
      registeredCommands.set(id, fn);
      return { dispose: () => {} };
    },
    executeCommand: async (id) => {
      if (id === "workbench.action.reloadWindow") {
        reloadRequested = true;
        return;
      }
      return registeredCommands.get(id)?.();
    },
  },
  env: {
    clipboard: {
      writeText: async (t) => {
        clipboard = t;
      },
    },
  },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscodeStub;
  return origLoad.apply(this, [request, ...rest]);
};

// Persistent-ish extension context (workspaceState survives our simulated reload).
const state = new Map();
const makeContext = () => ({
  subscriptions: [],
  storageUri: uriOf(STORAGE),
  workspaceState: {
    get: (k) => state.get(k),
    update: async (k, v) => {
      if (v === undefined) state.delete(k);
      else state.set(k, v);
    },
  },
});

// ---------------------------------------------------------------------------
// Drive it
// ---------------------------------------------------------------------------
const ext = require("../dist/extension.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(rel, timeoutMs) {
  const p = path.join(ROOT, rel);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fsp.readFile(p, "utf8");
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`timed out waiting for ${rel}`);
}

(async () => {
  if (role === "acceptor") {
    // Pre-existing content that the joiner must receive.
    fss.writeFileSync(path.join(ROOT, "from-acceptor.md"), "acceptor content");

    await ext.activate(makeContext());
    await vscodeStub.commands.executeCommand("peervault.copyTicket");
    console.log(`TICKET:${clipboard}`);

    // Wait for the initiator's file to arrive on OUR disk via reconcile.
    const body = await waitForFile("from-initiator.md", 90_000);
    if (body !== "initiator content") throw new Error(`bad content: ${body}`);
    console.log("PASS:acceptor");
    await ext.deactivate();
    process.exit(0);
  }

  if (role === "initiator") {
    if (!ticketArg) throw new Error("initiator needs the ticket");
    await ext.activate(makeContext());

    // addPeer with a foreign vault id → adoption → simulated window reload.
    inputBoxQueue.push(ticketArg);
    await vscodeStub.commands.executeCommand("peervault.addPeer");
    if (!reloadRequested) throw new Error("expected vault-id adoption to request a reload");
    console.log("[sim] adoption requested reload — simulating…");
    await ext.deactivate();
    registeredCommands.clear();
    await ext.activate(makeContext()); // resumePendingPairing completes the pairing

    // Initial sync should deliver the acceptor's file to our disk.
    await waitForFile("from-acceptor.md", 90_000);
    console.log("[sim] received acceptor's file ✓");

    // Now author a file locally and fire the watcher (as VSCode would).
    const p = path.join(ROOT, "from-initiator.md");
    fss.writeFileSync(p, "initiator content");
    watcherHandlers.create?.(uriOf(p));

    // Give ingest debounce + gossip a moment, then hold until the acceptor confirms.
    await sleep(20_000);
    console.log("PASS:initiator");
    await ext.deactivate();
    process.exit(0);
  }

  throw new Error(`unknown role ${role}`);
})().catch((e) => {
  console.error(`FAIL:${role}:`, e.message ?? e);
  process.exit(1);
});
