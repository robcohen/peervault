import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const isWatch = process.argv.includes('--watch');

// Iroh WASM files that need to be copied (loaded dynamically at runtime)
const irohWasmFiles = [
  { src: 'peervault-iroh/pkg/peervault_iroh.js', dest: 'peervault_iroh.js' },
  { src: 'peervault-iroh/pkg/peervault_iroh_bg.wasm', dest: 'peervault_iroh_bg.wasm' },
];

// Plugin files to copy to dist
const pluginFiles = ['manifest.json', 'styles.css'];

function copyFilesToDist() {
  const distDir = 'dist';
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  for (const file of pluginFiles) {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, path.join(distDir, file));
      console.log(`Copied ${file} -> dist/${file}`);
    }
  }

  for (const { src, dest } of irohWasmFiles) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(distDir, dest));
      console.log(`Copied ${src} -> dist/${dest}`);
    }
  }
}

/**
 * Plugin to transform loro-crdt for browser/mobile compatibility.
 *
 * This follows the same pattern as obsidian-plugin-wasm-image's fixJsquash plugin:
 * - Inline WASM as base64 data URL
 * - Replace Node.js-specific APIs with browser equivalents
 * - Use async WebAssembly.instantiate (required for mobile)
 *
 * loro-crdt/nodejs uses:
 * - require('util') for TextEncoder/TextDecoder -> use browser globals
 * - require('fs')/require('path') for WASM loading -> inline as base64
 * - sync WebAssembly.Module() -> async WebAssembly.instantiate()
 * - require('crypto') polyfill -> not needed (browsers have crypto)
 */
const loroTransformPlugin = {
  name: 'loro-transform',
  setup(build) {
    // Force loro-crdt to use nodejs version (we'll transform it for browser compatibility)
    build.onResolve({ filter: /^loro-crdt$/ }, () => {
      return { path: require.resolve('loro-crdt/nodejs') };
    });

    // Transform loro-crdt nodejs files
    build.onLoad({ filter: /loro-crdt[\\/]nodejs[\\/].*\.js$/ }, async (args) => {
      let code = await fs.promises.readFile(args.path, 'utf8');
      const dir = path.dirname(args.path);

      // 1. Replace require('util') with browser globals
      // Original: const { TextEncoder, TextDecoder } = require(`util`);
      code = code.replace(
        /const\s*\{\s*TextEncoder\s*,\s*TextDecoder\s*\}\s*=\s*require\s*\([`'"]util[`'"]\)\s*;?/g,
        '// Browser globals\nconst TextEncoder = globalThis.TextEncoder;\nconst TextDecoder = globalThis.TextDecoder;'
      );

      // 2. Remove the crypto polyfill (browsers have globalThis.crypto)
      // The if block checks !globalThis.crypto which is false in browsers,
      // so this code never runs. We just need to remove the require("crypto") to avoid bundler errors.
      code = code.replace(
        /const\s*\{\s*webcrypto\s*\}\s*=\s*require\s*\(\s*["']crypto["']\s*\)\s*;/g,
        'const webcrypto = globalThis.crypto; // Browsers have crypto natively'
      );

      // 3. Check if this file has the WASM loading code
      if (code.includes("require('path').join(__dirname, 'loro_wasm_bg.wasm')")) {
        // Read and inline the WASM file as base64
        const wasmPath = path.join(dir, 'loro_wasm_bg.wasm');
        const wasmBin = await fs.promises.readFile(wasmPath);
        const wasmBase64 = wasmBin.toString('base64');

        // Replace sync WASM loading with async loading
        // Original pattern:
        //   const path = require('path').join(__dirname, 'loro_wasm_bg.wasm');
        //   const bytes = require('fs').readFileSync(path);
        //   const wasmModule = new WebAssembly.Module(bytes);
        //   const wasmInstance = new WebAssembly.Instance(wasmModule, imports);
        //   wasm = wasmInstance.exports;
        //   module.exports.__wasm = wasm;
        //   wasm.__wbindgen_start();
        const syncPattern = /const path = require\('path'\)\.join\(__dirname, 'loro_wasm_bg\.wasm'\);\s*const bytes = require\('fs'\)\.readFileSync\(path\);\s*const wasmModule = new WebAssembly\.Module\(bytes\);\s*const wasmInstance = new WebAssembly\.Instance\(wasmModule, imports\);\s*wasm = wasmInstance\.exports;\s*module\.exports\.__wasm = wasm;\s*wasm\.__wbindgen_start\(\);/;

        const asyncReplacement = `
// WASM inlined as base64 (mobile-compatible)
const _loroWasmBase64 = "${wasmBase64}";

function _decodeBase64(b64) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64');
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Async initialization (required for mobile - sync WebAssembly.Module blocked for >4KB)
const __wasmReady = (async () => {
  const bytes = _decodeBase64(_loroWasmBase64);
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  wasm = instance.exports;
  module.exports.__wasm = wasm;
  wasm.__wbindgen_start();
})();

module.exports.__wasmReady = __wasmReady;
`;

        code = code.replace(syncPattern, asyncReplacement);
        console.log(`[loro-transform] Transformed ${path.basename(args.path)} with inlined WASM`);
      }

      return { contents: code, loader: 'js' };
    });
  },
};

const config = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  platform: 'browser',  // Browser platform for mobile compatibility
  format: 'cjs',
  target: 'es2020',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  sourcemap: isWatch ? 'inline' : false,
  minify: !isWatch,
  treeShaking: true,
  logLevel: 'info',
  plugins: [loroTransformPlugin],
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
    'global': 'globalThis',
  },
};

if (isWatch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  copyFilesToDist();
  console.log('Watching for changes...');
} else {
  await esbuild.build(config);
  copyFilesToDist();
  console.log('Build complete!');
}
