# PeerVault E2E Testing Framework

End-to-end testing framework for PeerVault that runs against real Obsidian instances using Chrome DevTools Protocol (CDP).

## Prerequisites

1. **Obsidian** must be running with remote debugging enabled:
   ```bash
   obsidian --remote-debugging-port=9222
   ```

2. **Two vaults** must be open: `TEST` and `TEST2`
   - Default paths: `/home/user/Documents/TEST` and `/home/user/Documents/TEST2`
   - Override with environment variables (see below)

3. **PeerVault plugin** must be installed in both vaults

## Running Tests

```bash
# Run all test suites
bun run test:e2e

# Run a specific suite
bun run test:e2e --suite=02-sync-basic

# Verbose output
bun run test:e2e --verbose

# Just discover available vaults (no tests)
bun run test:e2e --discover

# Show help
bun run test:e2e --help
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CDP_PORT` | Chrome DevTools Protocol port | `9222` |
| `TEST_VAULT_PATH` | Path to TEST vault | `/home/user/Documents/TEST` |
| `TEST2_VAULT_PATH` | Path to TEST2 vault | `/home/user/Documents/TEST2` |

## Test Suites

Tests run in sequential order. Each suite builds on the previous state.

| Suite | Description |
|-------|-------------|
| `00-setup` | Verify CDP connection, plugin presence, reset state |
| `01-pairing` | Generate invite, exchange tickets, establish peer connection |
| `02-sync-basic` | File create/modify/delete/rename synchronization |
| `03-sync-advanced` | Bulk operations, binary files, deep nesting |
| `04-conflicts` | Concurrent edit CRDT resolution |
| `05-error-recovery` | Plugin reload, disconnect recovery |
| `06-edge-cases` | Unicode filenames, special characters, edge cases |

## Architecture

```
e2e/
├── config.ts           # Configuration constants
├── runner.ts           # Test orchestrator
├── lib/
│   ├── cdp-client.ts       # WebSocket CDP client
│   ├── cdp-discovery.ts    # Dynamic vault discovery
│   ├── vault-controller.ts # File operations via Obsidian API
│   ├── plugin-api.ts       # PeerVault method wrappers
│   ├── plugin-lifecycle.ts # Enable/disable/reload
│   ├── brat.ts             # BRAT update integration
│   ├── state-manager.ts    # Reset state between tests
│   ├── sync-waiter.ts      # Wait for sync completion
│   ├── context.ts          # Test context factory
│   ├── assertions.ts       # Custom test assertions
│   └── fixtures.ts         # Fixture file loader
├── fixtures/           # Test fixture files
│   ├── binary/             # Binary files (images)
│   ├── text/               # Markdown fixtures
│   └── edge-cases/         # Unicode, special chars
└── tests/              # Test suites
    ├── 00-setup/
    ├── 01-pairing/
    └── ...
```

## Writing Tests

Tests are TypeScript files exporting an array of test definitions:

```typescript
import type { TestContext } from "../../lib/context";
import { assertFileExists, assertFileContent } from "../../lib/assertions";

export default [
  {
    name: "My test name",
    async fn(ctx: TestContext) {
      // Create file in TEST vault
      await ctx.test.vault.createFile("test.md", "# Hello");

      // Wait for sync to TEST2
      await ctx.test2.sync.waitForFile("test.md", { timeoutMs: 30000 });

      // Verify content
      await assertFileContent(ctx.test2.vault, "test.md", "# Hello");
    },
  },
];
```

### TestContext API

```typescript
interface TestContext {
  test: VaultContext;   // TEST vault
  test2: VaultContext;  // TEST2 vault

  // Cross-vault utilities
  waitForConvergence(timeoutMs?: number): Promise<void>;
  waitForFileListMatch(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

interface VaultContext {
  name: string;
  client: CDPClient;           // Raw CDP access
  vault: VaultController;      // File operations
  plugin: PluginAPI;           // Plugin methods
  lifecycle: PluginLifecycleManager;
  brat: BRATManager;
  state: StateManager;         // Reset state
  sync: SyncWaiter;            // Wait for sync
}
```

### Common Operations

```typescript
// File operations
await ctx.test.vault.createFile("path.md", "content");
await ctx.test.vault.modifyFile("path.md", "new content");
await ctx.test.vault.deleteFile("path.md");
await ctx.test.vault.renameFile("old.md", "new.md");
const content = await ctx.test.vault.readFile("path.md");
const files = await ctx.test.vault.listFiles();

// Wait for sync
await ctx.test2.sync.waitForFile("path.md", { timeoutMs: 30000 });
await ctx.test2.sync.waitForContent("path.md", "expected");
await ctx.test2.sync.waitForFileDeletion("path.md");
await ctx.waitForConvergence();

// Plugin operations
const nodeId = await ctx.test.plugin.getNodeId();
const peers = await ctx.test.plugin.getConnectedPeers();
const ticket = await ctx.test.plugin.generateInvite();
await ctx.test2.plugin.addPeer(ticket);

// State management
await ctx.test.state.resetAll();  // Clear files, peers, CRDT
await ctx.test.lifecycle.reload(); // Reload plugin
```

### Assertions

```typescript
// Basic
assert(condition, "message");
assertEqual(actual, expected);
assertTruthy(value);

// File assertions
await assertFileExists(vault, "path.md");
await assertFileNotExists(vault, "path.md");
await assertFileContent(vault, "path.md", "expected");
await assertVaultEmpty(vault);

// Plugin assertions
await assertPluginEnabled(plugin);
await assertNoPeers(plugin);
await assertPeerConnected(plugin, nodeId);
await assertInCrdt(plugin, "path.md");

// Sync assertions
await assertVaultsInSync(vault1, vault2);
await assertFileInSync(vault1, vault2, "path.md");
```

## Fixtures

Load predefined fixture files into vaults:

```typescript
import { loadFixturesByName, createStandardTestSet, loadInlineFixtures } from "../../lib/fixtures";

// Load from fixtures directory
await loadFixturesByName(ctx.test.vault, "text");
await loadFixturesByName(ctx.test.vault, "edge-cases");

// Load inline fixtures
const fixtures = createStandardTestSet();
await loadInlineFixtures(ctx.test.vault, fixtures);
```

## Local Relay Server

For reliable E2E testing, use a local relay server instead of the public relays which can be unreliable.

### Starting the Local Relay

```bash
# Start local relay server (installs if needed)
just relay-start

# Check relay status
just relay-status

# View relay logs (follow mode)
just relay-logs

# Stop relay
just relay-stop
```

The relay runs on `http://localhost:3340` by default.

### Configuring Vaults to Use Local Relay

In each vault's PeerVault settings:
1. Open Settings > PeerVault > Advanced
2. Set "Custom Relay Servers" to: `http://localhost:3340`
3. Reload the plugin

Or via the settings file (`.obsidian/plugins/peervault/data.json`):
```json
{
  "relayServers": ["http://localhost:3340"]
}
```

### Running Tests with Local Relay

```bash
# Start relay and run tests
just e2e-local

# Or manually
just relay-start
bun run test:e2e
just relay-stop
```

## Troubleshooting

### "Failed to connect to CDP endpoint"
- Ensure Obsidian is running with `--remote-debugging-port=9222`
- Check that port 9222 is not blocked by firewall

### "Timeout waiting for vaults"
- Ensure both TEST and TEST2 vaults are open in Obsidian
- Vault names must match exactly (case-sensitive)

### "Plugin not enabled"
- Install PeerVault in both vaults
- Enable the plugin in Obsidian settings

### Tests hang or timeout
- Check Obsidian console for errors (Ctrl+Shift+I)
- Try reloading plugins: Settings > Community Plugins > Reload
- Restart Obsidian if sync state is corrupted

### "Lost connection to relay server"
- The public Iroh relays can be unreliable
- Use a local relay: `just relay-start`
- Configure vaults to use `http://localhost:3340`
- Check relay logs: `just relay-logs`

### Sync not working after pairing
- Verify both vaults are using the same relay
- Check relay logs for connection activity
- Ensure sessions reach "live" state (not "error")
