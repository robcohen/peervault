import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const isWatch = process.argv.includes('--watch');

// Iroh WASM files that need to be copied (loaded dynamically at runtime)
const irohWasmFiles = [
  { src: 'peervault-iroh/pkg/peervault_iroh.js', dest: 'peervault_iroh.js' },
  { src: 'peervault-iroh/pkg/peervault_iroh_bg.wasm', dest: 'peervault_iroh_bg.wasm' },
];

// Plugin files to copy to dist
const pluginFiles = [
  'manifest.json',
  'styles.css',
];

// Copy plugin files to dist
function copyFilesToDist() {
  const distDir = 'dist';
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  for (const file of pluginFiles) {
    if (existsSync(file)) {
      const destFile = join(distDir, file);
      copyFileSync(file, destFile);
      console.log(`Copied ${file} -> ${destFile}`);
    } else {
      console.warn(`Plugin file not found: ${file}`);
    }
  }

  // Copy Iroh WASM files (loaded dynamically at runtime)
  for (const { src, dest } of irohWasmFiles) {
    if (existsSync(src)) {
      const destFile = join(distDir, dest);
      copyFileSync(src, destFile);
      console.log(`Copied ${src} -> ${destFile}`);
    } else {
      console.warn(`Iroh WASM file not found: ${src}`);
    }
  }
}

// Plugin to patch loro-crdt WASM loading for mobile compatibility
// Mobile browsers block sync WebAssembly.Module() for buffers > 4KB
// We patch to use async WebAssembly.instantiate() instead
const loroMobilePlugin = {
  name: 'loro-mobile',
  setup(build) {
    build.onLoad({ filter: /loro-crdt[\/\\]nodejs[\/\\]loro_wasm\.js$/ }, async (args) => {
      const wasmPath = path.join(path.dirname(args.path), 'loro_wasm_bg.wasm');
      const wasmBuffer = fs.readFileSync(wasmPath);
      const wasmBase64 = wasmBuffer.toString('base64');

      let contents = fs.readFileSync(args.path, 'utf8');

      // Replace the sync WASM loading with async loading
      // Original:
      //   const path = require('path').join(__dirname, 'loro_wasm_bg.wasm');
      //   const bytes = require('fs').readFileSync(path);
      //   const wasmModule = new WebAssembly.Module(bytes);
      //   const wasmInstance = new WebAssembly.Instance(wasmModule, imports);
      //   wasm = wasmInstance.exports;
      //   module.exports.__wasm = wasm;
      //   wasm.__wbindgen_start();
      const wasmLoadPattern = /const path = require\('path'\)\.join\(__dirname, 'loro_wasm_bg\.wasm'\);\s*const bytes = require\('fs'\)\.readFileSync\(path\);\s*const wasmModule = new WebAssembly\.Module\(bytes\);\s*const wasmInstance = new WebAssembly\.Instance\(wasmModule, imports\);\s*wasm = wasmInstance\.exports;\s*module\.exports\.__wasm = wasm;\s*wasm\.__wbindgen_start\(\);/;

      // Use async WebAssembly.instantiate() which works on mobile
      // The trick: we store a promise and make all exports async-aware
      const replacement = `
// WASM inlined as base64 for bundling
const wasmBase64 = "${wasmBase64}";

// Decode base64 to bytes
function decodeBase64(b64) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64');
  } else {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

// Initialize WASM asynchronously (required for mobile - sync compilation blocked for >4KB)
let wasmReady = (async () => {
  const bytes = decodeBase64(wasmBase64);
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  wasm = instance.exports;
  module.exports.__wasm = wasm;
  wasm.__wbindgen_start();
})();

// Export the ready promise so callers can await if needed
module.exports.__wasmReady = wasmReady;
`;

      contents = contents.replace(wasmLoadPattern, replacement);
      return { contents, loader: 'js' };
    });
  },
};

const config = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  sourcemap: isWatch ? 'inline' : false,
  minify: !isWatch,
  treeShaking: true,
  logLevel: 'info',
  plugins: [loroMobilePlugin],
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
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
