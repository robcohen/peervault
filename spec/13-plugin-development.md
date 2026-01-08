# Plugin Development Spec

## Purpose

Define how PeerVault is built as an Obsidian plugin, including project structure, build configuration, API usage patterns, and submission requirements.

## Requirements

- **REQ-PD-01**: Plugin MUST use TypeScript with strict type checking
- **REQ-PD-02**: Plugin MUST support both desktop and mobile platforms
- **REQ-PD-03**: Plugin MUST follow Obsidian plugin guidelines
- **REQ-PD-04**: Plugin MUST use esbuild for bundling
- **REQ-PD-05**: Plugin MUST properly clean up resources on unload

## Project Structure

```
peervault/
├── .github/
│   └── workflows/
│       ├── release.yml          # Automated release workflow
│       └── lint.yml             # ESLint CI
├── src/
│   ├── main.ts                  # Plugin entry point
│   ├── types.ts                 # Shared TypeScript interfaces
│   ├── core/
│   │   ├── document-manager.ts  # Automerge doc management
│   │   ├── storage-adapter.ts   # .crdt file persistence
│   │   ├── file-watcher.ts      # Vault change detection
│   │   └── sync-engine.ts       # Sync orchestration
│   ├── transport/
│   │   ├── iroh-transport.ts    # Iroh WASM wrapper
│   │   ├── peer-connection.ts   # Connection abstraction
│   │   └── stream.ts            # Framed stream implementation
│   ├── peer/
│   │   ├── peer-manager.ts      # Peer lifecycle
│   │   └── pairing.ts           # Ticket/QR pairing flow
│   ├── ui/
│   │   ├── settings-tab.ts      # Plugin settings
│   │   ├── status-bar.ts        # Sync status indicator
│   │   ├── add-device-modal.ts  # QR code display
│   │   ├── join-modal.ts        # Ticket entry
│   │   └── history-view.ts      # Document version history
│   └── utils/
│       ├── logger.ts            # Structured logging
│       ├── errors.ts            # Error classes
│       └── text-diff.ts         # Content diffing for Automerge
├── styles.css                   # Plugin styles
├── manifest.json                # Plugin metadata
├── versions.json                # Version compatibility map
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript configuration
├── esbuild.config.mjs           # Build configuration
├── .eslintrc.js                 # ESLint configuration
└── README.md                    # User documentation
```

## Manifest Configuration

### manifest.json

```json
{
  "id": "peervault",
  "name": "PeerVault",
  "version": "1.0.0",
  "minAppVersion": "1.4.0",
  "description": "Peer-to-peer vault synchronization using CRDTs",
  "author": "PeerVault Contributors",
  "authorUrl": "https://github.com/peervault",
  "isDesktopOnly": false,
  "fundingUrl": {
    "GitHub": "https://github.com/sponsors/peervault"
  }
}
```

**Key fields:**
- `id`: Must match plugin folder name, cannot contain "obsidian"
- `minAppVersion`: Minimum Obsidian version (1.4.0 for stable WASM support)
- `isDesktopOnly`: `false` - we support mobile via pure WASM

### versions.json

Maps plugin versions to minimum Obsidian versions:

```json
{
  "1.0.0": "1.4.0",
  "1.1.0": "1.4.0"
}
```

## Build Configuration

### package.json

```json
{
  "name": "peervault",
  "version": "1.0.0",
  "description": "P2P vault sync for Obsidian",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit",
    "version": "node version-bump.mjs && git add manifest.json versions.json"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.20.0",
    "eslint": "^8.0.0",
    "obsidian": "latest",
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "@automerge/automerge": "^2.0.0",
    "@aspect/iroh": "^0.1.0"
  }
}
```

### esbuild.config.mjs

```javascript
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  // IMPORTANT: Use 'browser' platform for mobile compatibility
  platform: "browser",
  // Handle WASM imports
  loader: {
    ".wasm": "file",
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES6",
    "allowJs": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "moduleResolution": "node",
    "importHelpers": true,
    "isolatedModules": true,
    "lib": ["DOM", "ES5", "ES6", "ES7", "ES2020"],
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

## Plugin Entry Point

### src/main.ts

```typescript
import {
  App,
  Plugin,
  PluginSettingTab,
  TFile,
  TAbstractFile,
  Notice,
  Platform,
} from 'obsidian';

import { DocumentManager } from './core/document-manager';
import { StorageAdapter } from './core/storage-adapter';
import { FileWatcher } from './core/file-watcher';
import { SyncEngine } from './core/sync-engine';
import { IrohTransport } from './transport/iroh-transport';
import { PeerManager } from './peer/peer-manager';
import { PeerVaultSettingTab } from './ui/settings-tab';
import { SyncStatusBar } from './ui/status-bar';
import { DEFAULT_SETTINGS, PeerVaultSettings } from './types';

export default class PeerVaultPlugin extends Plugin {
  settings: PeerVaultSettings;

  // Core components
  private storage: StorageAdapter;
  private documentManager: DocumentManager;
  private fileWatcher: FileWatcher;
  private syncEngine: SyncEngine;
  private transport: IrohTransport;
  private peerManager: PeerManager;

  // UI components
  private statusBar: SyncStatusBar;

  async onload(): Promise<void> {
    console.log('Loading PeerVault plugin');

    // Load settings
    await this.loadSettings();

    // Initialize storage (creates directories if needed)
    this.storage = new StorageAdapter(this.app.vault, this.manifest.dir!);
    await this.storage.initialize();

    // Initialize document manager
    this.documentManager = new DocumentManager(this.storage);

    // Initialize transport (loads WASM)
    this.transport = new IrohTransport(this.storage);
    await this.transport.initialize();

    // Initialize peer manager
    this.peerManager = new PeerManager(
      this.transport,
      this.settings.peers,
      (peers) => this.updateSettings({ peers })
    );

    // Initialize sync engine
    this.syncEngine = new SyncEngine(
      this.documentManager,
      this.peerManager,
      this.storage
    );

    // Initialize file watcher
    this.fileWatcher = new FileWatcher(this.app.vault);

    // Wire up file events using registerEvent for automatic cleanup
    this.registerEvent(
      this.app.vault.on('create', (file) => this.onFileCreate(file))
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => this.onFileModify(file))
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.onFileDelete(file))
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) =>
        this.onFileRename(file, oldPath)
      )
    );

    // Add settings tab
    this.addSettingTab(new PeerVaultSettingTab(this.app, this));

    // Add status bar item
    this.statusBar = new SyncStatusBar(this);

    // Add commands
    this.addCommand({
      id: 'show-sync-status',
      name: 'Show sync status',
      callback: () => this.showSyncStatus(),
    });

    this.addCommand({
      id: 'add-device',
      name: 'Add device',
      callback: () => this.showAddDeviceModal(),
    });

    this.addCommand({
      id: 'force-sync',
      name: 'Force sync now',
      callback: () => this.syncEngine.syncAll(),
    });

    // Connect to peers after layout is ready
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoSync) {
        this.peerManager.connectAll();
      }
    });

    // Handle incoming connections
    this.transport.onIncomingConnection((conn) => {
      this.peerManager.handleIncoming(conn);
    });
  }

  async onunload(): Promise<void> {
    console.log('Unloading PeerVault plugin');

    // Flush pending syncs
    await this.syncEngine?.flush();

    // Disconnect from peers
    await this.peerManager?.disconnectAll();

    // Shut down transport
    await this.transport?.shutdown();

    // Note: registerEvent() handlers are automatically cleaned up
  }

  // File event handlers
  private async onFileCreate(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (this.fileWatcher.isIgnored(file.path)) return;

    const content = await this.app.vault.read(file);
    await this.documentManager.createDoc(file.path, content);
  }

  private async onFileModify(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (this.fileWatcher.isIgnored(file.path)) return;

    const content = await this.app.vault.read(file);
    await this.documentManager.updateDoc(file.path, content);
  }

  private async onFileDelete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    await this.documentManager.deleteDoc(file.path);
  }

  private async onFileRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    await this.documentManager.renameDoc(oldPath, file.path);
  }

  // Settings management
  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async updateSettings(updates: Partial<PeerVaultSettings>): Promise<void> {
    this.settings = { ...this.settings, ...updates };
    await this.saveData(this.settings);
  }

  // UI helpers
  private showSyncStatus(): void {
    const stats = this.syncEngine.getStats();
    new Notice(
      `PeerVault: ${stats.connectedPeers} peers, ${stats.syncedDocs} docs synced`
    );
  }

  private showAddDeviceModal(): void {
    // Import dynamically to reduce initial load
    import('./ui/add-device-modal').then(({ AddDeviceModal }) => {
      new AddDeviceModal(this.app, this.transport, this.peerManager).open();
    });
  }
}
```

## API Usage Patterns

### Event Registration

Always use `registerEvent()` for automatic cleanup:

```typescript
// CORRECT: Auto-cleanup on plugin unload
this.registerEvent(
  this.app.vault.on('modify', (file) => this.handleModify(file))
);

// WRONG: Manual cleanup required, easy to leak
this.app.vault.on('modify', this.handleModify.bind(this));
```

### DOM Event Registration

Use `registerDomEvent()` for DOM listeners:

```typescript
// CORRECT: Auto-cleanup
this.registerDomEvent(document, 'click', (evt) => {
  // handle click
});

// WRONG: Memory leak on unload
document.addEventListener('click', this.handleClick);
```

### Interval Registration

Use `registerInterval()` for timers:

```typescript
// CORRECT: Auto-cleanup
this.registerInterval(
  window.setInterval(() => this.periodicSync(), 60000)
);

// WRONG: Keeps running after unload
setInterval(() => this.periodicSync(), 60000);
```

### File Operations

```typescript
// Reading a file
const file = this.app.vault.getAbstractFileByPath('Notes/example.md');
if (file instanceof TFile) {
  const content = await this.app.vault.read(file);
}

// Writing a file
await this.app.vault.modify(file, newContent);

// Creating a file
await this.app.vault.create('Notes/new.md', content);

// Deleting a file
await this.app.vault.delete(file);

// Checking if path exists
const exists = await this.app.vault.adapter.exists(path);
```

### Platform Detection

```typescript
import { Platform } from 'obsidian';

// Check platform for conditional behavior
if (Platform.isMobile) {
  // Reduce sync frequency on mobile
  this.syncInterval = 120000;
} else {
  this.syncInterval = 30000;
}

// iOS-specific handling (no regex lookbehind)
if (Platform.isIosApp) {
  // Use alternative regex pattern
}
```

### Settings Tab

```typescript
import { PluginSettingTab, Setting } from 'obsidian';

export class PeerVaultSettingTab extends PluginSettingTab {
  plugin: PeerVaultPlugin;

  constructor(app: App, plugin: PeerVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Use sentence case for headings
    containerEl.createEl('h2', { text: 'PeerVault settings' });

    new Setting(containerEl)
      .setName('Auto-sync on startup')  // Sentence case
      .setDesc('Automatically connect to peers when Obsidian opens')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ autoSync: value });
          })
      );
  }
}
```

## Mobile Compatibility

### WASM Loading

```typescript
async function loadIrohWasm(): Promise<void> {
  // WASM works on mobile but may need special handling
  if (Platform.isMobile) {
    // Mobile may need smaller WASM bundle or lazy loading
    const wasmModule = await import('@aspect/iroh/lite');
    return wasmModule.initialize();
  } else {
    const wasmModule = await import('@aspect/iroh');
    return wasmModule.initialize();
  }
}
```

### Avoiding Node.js APIs

```typescript
// WRONG: Node.js API, crashes on mobile
import * as fs from 'fs';
const data = fs.readFileSync(path);

// CORRECT: Use Obsidian Vault API
const data = await this.app.vault.adapter.read(path);

// WRONG: Electron API, crashes on mobile
const { ipcRenderer } = require('electron');

// CORRECT: Platform check if you must use it
if (Platform.isDesktopApp) {
  const { ipcRenderer } = require('electron');
}
```

### Regex Compatibility

```typescript
// WRONG: Lookbehind not supported on iOS
const pattern = /(?<=@)\w+/;

// CORRECT: Use alternative approach
const pattern = /@(\w+)/;
const match = text.match(pattern);
const result = match ? match[1] : null;
```

## Plugin Guidelines Compliance

### UI/UX Rules

| Rule | Requirement |
|------|-------------|
| Text case | Use sentence case for all UI text |
| Command names | No "command" in name, no default hotkeys |
| Command IDs | No plugin ID prefix in command IDs |
| Icon buttons | Provide ARIA labels for accessibility |
| Focus indicators | Clear visual focus for keyboard navigation |

### Security Rules

| Rule | Requirement |
|------|-------------|
| DOM manipulation | Never use `innerHTML` or `outerHTML` |
| User input | Sanitize all user-provided content |
| External requests | Inform users of network activity |
| Sensitive data | Don't log sensitive information |

### Memory Management

```typescript
// Store references to clean up
class MyPlugin extends Plugin {
  // DON'T: Store view references
  // private view: View;

  // DO: Look up views when needed
  getView(): MyView | null {
    const leaves = this.app.workspace.getLeavesOfType('my-view');
    return leaves[0]?.view as MyView;
  }
}
```

## Release Process

### Version Bumping

```bash
# Update manifest.json minAppVersion manually first, then:
npm version patch  # 1.0.0 -> 1.0.1
npm version minor  # 1.0.1 -> 1.1.0
npm version major  # 1.1.0 -> 2.0.0
```

### GitHub Release

1. Update version in `manifest.json`
2. Update `versions.json` if minAppVersion changed
3. Run `npm run build`
4. Create GitHub release with tag matching version exactly (e.g., `1.0.0`, not `v1.0.0`)
5. Attach release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`

### Submission Checklist

- [ ] `id`, `name`, `description` in manifest match submission
- [ ] Version tag matches manifest version exactly
- [ ] No "obsidian" in plugin ID
- [ ] `isDesktopOnly` set correctly
- [ ] README.md documents features and usage
- [ ] No console errors on load/unload
- [ ] Settings persist across restarts
- [ ] Works on both desktop and mobile (if not desktop-only)

## Development Workflow

### Local Development

```bash
# Clone into vault plugins folder
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/peervault/peervault

# Install dependencies
cd peervault
npm install

# Start dev build (watches for changes)
npm run dev

# In Obsidian:
# 1. Settings > Community plugins > Enable PeerVault
# 2. Ctrl+P > "Reload app without saving" to pick up changes
```

### Testing Vault

Always use a dedicated test vault, never your personal vault:

```bash
# Create test vault
mkdir ~/obsidian-test-vault
cd ~/obsidian-test-vault/.obsidian/plugins
ln -s /path/to/peervault peervault
```

### Debugging

```typescript
// Use console.log for development
console.log('PeerVault:', data);

// For production, use structured logging
this.logger.debug('Sync started', { peerId, docCount });
```

Open DevTools: `Ctrl+Shift+I` (desktop) or use remote debugging (mobile)

## Dependencies

| Package | Purpose | Mobile Safe |
|---------|---------|-------------|
| `obsidian` | Plugin API types | Yes |
| `@automerge/automerge` | CRDT implementation | Yes (WASM) |
| `@aspect/iroh` | P2P transport | Yes (WASM) |
| `esbuild` | Build tool | Dev only |
| `typescript` | Type checking | Dev only |

## References

- [Obsidian Developer Documentation](https://docs.obsidian.md/Home)
- [Sample Plugin Template](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Plugin API Types](https://github.com/obsidianmd/obsidian-api)
- [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Submission Requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [Mobile Development](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
