// Bundle the PeerVault VSCode extension.
//
// The extension host is Node, so the wasm is inlined as base64 and passed to
// wasm-bindgen's init as bytes (same pattern as the Obsidian build, minus the
// browser polyfills — Node has Buffer/crypto/WebSocket natively on >=22).

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..", "..", "peervault-core", "pkg");

/** Inline the peervault-core wasm into the bundle and load it from bytes. */
const wasmInlinePlugin = {
  name: "peervault-wasm-inline",
  setup(build) {
    build.onResolve({ filter: /peervault_core\.js$/ }, () => {
      return { path: path.join(pkgDir, "peervault_core.js"), namespace: "peervault-wasm" };
    });

    build.onLoad({ filter: /.*/, namespace: "peervault-wasm" }, async (args) => {
      let code = await fs.promises.readFile(args.path, "utf8");
      const wasmBin = await fs.promises.readFile(path.join(pkgDir, "peervault_core_bg.wasm"));
      const inline = `
// PeerVault Core WASM inlined as base64 (Node extension host)
const __peervaultWasmBytes = Buffer.from("${wasmBin.toString("base64")}", "base64");
`;
      // Replace the browser URL-based default load with the inlined bytes.
      code = code.replace(
        /module_or_path = new URL\('peervault_core_bg\.wasm', import\.meta\.url\);/,
        "module_or_path = __peervaultWasmBytes;"
      );
      code = inline + code;
      console.log(`[wasm-inline] Inlined ${(wasmBin.length / 1024 / 1024).toFixed(2)}MB WASM`);
      return { contents: code, loader: "js" };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(here, "src", "extension.ts")],
  bundle: true,
  outfile: path.join(here, "dist", "extension.js"),
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: false,
  minify: true,
  logLevel: "info",
  plugins: [wasmInlinePlugin],
});

console.log("VSCode extension build complete");
