import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

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

// Plugin to inline WASM as base64
const inlineWasmPlugin = {
  name: 'inline-wasm',
  setup(build) {
    // Intercept the loro-crdt Node.js WASM loader and inline the WASM
    build.onLoad({ filter: /loro-crdt[\/\\]nodejs[\/\\]loro_wasm\.js$/ }, async (args) => {
      const wasmPath = path.join(path.dirname(args.path), 'loro_wasm_bg.wasm');
      const wasmBuffer = fs.readFileSync(wasmPath);
      const wasmBase64 = wasmBuffer.toString('base64');

      let contents = fs.readFileSync(args.path, 'utf8');

      // Replace the WASM loading code with inline base64
      const wasmLoadPattern = /const path = require\('path'\)\.join\(__dirname, 'loro_wasm_bg\.wasm'\);\s*const bytes = require\('fs'\)\.readFileSync\(path\);\s*const wasmModule = new WebAssembly\.Module\(bytes\);/;

      const replacement = `const bytes = (function(){
        var b64 = "${wasmBase64}";
        if (typeof Buffer !== 'undefined') {
          return Buffer.from(b64, 'base64');
        } else {
          var binary = atob(b64);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return bytes;
        }
      })();
      const wasmModule = new WebAssembly.Module(bytes);`;

      contents = contents.replace(wasmLoadPattern, replacement);
      return { contents, loader: 'js' };
    });

    // Intercept the Iroh WASM loader and inline the WASM
    build.onLoad({ filter: /peervault-iroh[\/\\]pkg[\/\\]peervault_iroh\.js$/ }, async (args) => {
      const wasmPath = path.join(path.dirname(args.path), 'peervault_iroh_bg.wasm');
      const wasmBuffer = fs.readFileSync(wasmPath);
      const wasmBase64 = wasmBuffer.toString('base64');

      let contents = fs.readFileSync(args.path, 'utf8');

      // The Iroh WASM uses import.meta.url to find the WASM file
      // Replace the __wbg_init function to use inlined WASM
      // Original: module_or_path = new URL('peervault_iroh_bg.wasm', import.meta.url);
      const initPattern = /if \(module_or_path === undefined\) \{\s*module_or_path = new URL\('peervault_iroh_bg\.wasm', import\.meta\.url\);\s*\}/;

      const initReplacement = `if (module_or_path === undefined) {
        // Inlined WASM as base64
        const b64 = "${wasmBase64}";
        let bytes;
        if (typeof Buffer !== 'undefined') {
          bytes = Buffer.from(b64, 'base64');
        } else {
          const binary = atob(b64);
          bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        }
        module_or_path = bytes;
      }`;

      contents = contents.replace(initPattern, initReplacement);
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
  plugins: [inlineWasmPlugin],
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
