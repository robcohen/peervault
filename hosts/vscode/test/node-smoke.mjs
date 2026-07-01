// Node smoke test for the VSCode host runtime.
//
// VSCode extensions run in the Node extension host (not a browser). This proves
// the wasm engine works there: load the pkg with explicit bytes (no fetch/URL),
// spin two vaults against a local relay, pair with a one-time nonce, and
// converge a document — the exact runtime path the .vsix will use.
//
// Run:  PEERVAULT_TEST_RELAY=http://localhost:3340 node hosts/vscode/test/node-smoke.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..", "..", "..", "peervault-core", "pkg");

const init = (await import(join(pkgDir, "peervault_core.js"))).default;
const { WasmPeerVault } = await import(join(pkgDir, "peervault_core.js"));

// Node has no fetch-able import.meta wasm URL — pass bytes explicitly,
// exactly as the extension bundle will.
await init({ module_or_path: readFileSync(join(pkgDir, "peervault_core_bg.wasm")) });

const VAULT_ID = "bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22";
const KEY = "0202020202020202020202020202020202020202020202020202020202020202";
const RELAY = process.env.PEERVAULT_TEST_RELAY ?? null;

function makeVault(name, events) {
  const v = new WasmPeerVault(VAULT_ID, name);
  if (RELAY) v.setRelayUrl(RELAY);
  v.setEventCallback((json) => events.push(JSON.parse(json)));
  return v;
}

const aEvents = [], bEvents = [];
const a = makeVault("node-a", aEvents);
const b = makeVault("node-b", bEvents);

await a.setEncryptionKey(KEY);
await b.setEncryptionKey(KEY);

console.log("[smoke] starting engines...");
await a.start();
await b.start();

const ticket = await a.getTicket();
const nonce = "cafebabecafebabecafebabecafebabe";
a.registerPairingNonce(nonce, Date.now() + 60_000);

console.log("[smoke] pairing b -> a...");
const peerId = await b.connectPeerWithPairing(ticket, nonce, "node-b");
if (!peerId) throw new Error("connect returned empty peer id");
console.log(`[smoke] paired with ${peerId.slice(0, 12)}...`);

if (a.getKnownPeers().length === 0) throw new Error("acceptor did not record peer");

console.log("[smoke] writing document on b...");
await b.set("notes/from-node.md", new TextEncoder().encode("hello from the VSCode host runtime"));

let converged = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const bytes = await a.get("notes/from-node.md");
  if (bytes) {
    const text = new TextDecoder().decode(bytes);
    if (text !== "hello from the VSCode host runtime") throw new Error(`content mismatch: ${text}`);
    converged = true;
    break;
  }
}
if (!converged) {
  console.error("a events:", JSON.stringify(aEvents));
  throw new Error("document did not converge within 30s");
}
console.log("[smoke] converged ✓");

// Reconcile plan API (what the extension uses to apply changes to disk)
const plan = JSON.parse(await a.reconcilePlan([]));
if (!plan.upserts.includes("notes/from-node.md")) throw new Error(`plan missing upsert: ${JSON.stringify(plan)}`);
console.log(`[smoke] reconcile plan ✓ (${plan.upserts.length} upserts, ${plan.deletes.length} deletes)`);

console.log("[smoke] stopping...");
await b.stop();
await a.stop();

const sawPairing = aEvents.some((e) => e.type === "pairing_complete" || e.type === "peer_connected");
if (!sawPairing) throw new Error(`no pairing/connection events: ${JSON.stringify(aEvents)}`);

console.log("NODE SMOKE TEST PASSED — the engine runs in the VSCode extension-host runtime");
process.exit(0);
