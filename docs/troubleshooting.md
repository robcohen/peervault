# PeerVault Troubleshooting Guide

## Common Issues

### WASM Memory Exhausted

**Symptom**: Plugin fails to load with error:
```
Plugin failure: peervault RangeError: WebAssembly.instantiate(): Out of memory
```

**Cause**: WASM memory in Electron is grow-only. Repeated plugin reloads accumulate memory that isn't freed until Obsidian restarts.

**Solution**:
1. Restart Obsidian completely
2. The plugin will initialize with fresh WASM memory

**Note**: Multiple vaults CAN run PeerVault simultaneously with a fresh Obsidian start. The issue only occurs after repeated plugin enable/disable cycles.

---

### Peers Not Connecting

**Symptom**: Peers show as "disconnected" and don't sync.

**Possible Causes & Solutions**:

1. **Relay server unreachable**
   - Check Settings > PeerVault > Relay Servers
   - Test relay URL in browser (should return a page)
   - Try Iroh's default relays by clearing custom relay settings

2. **Firewall blocking QUIC**
   - QUIC uses UDP, some networks block it
   - Relay servers should work around this, but verify relay is reachable

3. **Stale peer ticket**
   - If peer changed relay servers, old ticket is invalid
   - Generate a new invite and re-pair

4. **Plugin not initialized**
   - Check Settings > PeerVault > Node ID exists
   - If blank, see "WASM Memory Exhausted" above

---

### Sync Not Starting

**Symptom**: Peers connected but files don't sync.

**Possible Causes & Solutions**:

1. **Sync interval set to 0**
   - Check Settings > PeerVault > Sync Interval
   - Set to at least 30 seconds for automatic sync
   - Use manual "Sync Now" command for immediate sync

2. **Vault ID mismatch**
   - Each vault has unique ID stored in CRDT
   - If peers were paired to different vaults, sync will fail
   - Check logs for "vault ID mismatch" errors

3. **Read-only peer**
   - Check if peer is marked read-only in settings
   - Read-only peers receive but don't send updates

---

### Files Not Appearing After Sync

**Symptom**: Sync completes but some files missing.

**Possible Causes & Solutions**:

1. **Binary files pending**
   - Binary files sync after text (blobs are separate)
   - Wait for "blob sync" phase to complete
   - Check Settings > Status for blob sync progress

2. **File in .obsidian or excluded**
   - Plugin files and settings don't sync by default
   - Check if file path is in exclusion list

3. **Empty files**
   - Known limitation: 0-byte files may not sync
   - Add at least one character to the file

---

### High Memory Usage

**Symptom**: Obsidian using excessive RAM after sync.

**Possible Causes & Solutions**:

1. **Large vault**
   - CRDT keeps full history in memory
   - Consider periodic "Compact CRDT" if available

2. **Many binary files**
   - Blobs are loaded during sync
   - Should be released after sync completes

3. **Multiple vaults**
   - Each vault's PeerVault instance uses WASM memory
   - Close unused vaults or disable PeerVault in them

---

### Pairing Fails

**Symptom**: "Add Device" doesn't complete pairing.

**Possible Causes & Solutions**:

1. **Invite expired or invalid**
   - Generate fresh invite on Device A
   - Paste complete invite string on Device B

2. **Pairing request not accepted**
   - Check Device A's Settings > PeerVault > Pending Requests
   - Accept the pairing request manually

3. **Both devices initiating**
   - Only Device B (pasting invite) should initiate
   - Device A waits for incoming connection

---

### Conflict Resolution Issues

**Symptom**: Unexpected content after concurrent edits.

**Understanding**:
- PeerVault uses CRDTs which auto-merge without conflicts
- "Last write wins" at the character level
- Deletions are permanent (delete + edit = deleted)

**Viewing History**:
- Check Settings > PeerVault > Merge History
- Shows recent merge operations with timestamps

---

## Debugging

### Enable Debug Logging

1. Settings > PeerVault > Debug Mode: ON
2. Open Developer Console (Ctrl+Shift+I / Cmd+Opt+I)
3. Filter for "PeerVault" in console

### Copy Logs

Settings > PeerVault > Advanced > "Copy Logs" copies last 200 log entries to clipboard.

### Mobile Debugging (Android)

```bash
# Connect device via USB, enable USB debugging
adb devices -l

# Find Obsidian PID
adb logcat | grep obsidian

# Forward debug port
adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>

# Access via Chrome DevTools
open http://localhost:9222
```

### Check Plugin State

In Developer Console:
```javascript
// Get plugin instance
const plugin = app.plugins.plugins['peervault'];

// Check transport
plugin.transport?.isReady();  // Should be true
plugin.transport?.getNodeId();  // Should return node ID

// Check peers
plugin.peerManager?.getPeers();  // List of peers

// Check CRDT state
plugin.documentManager?.getAllFilePaths();  // Files in CRDT
```

---

## Error Codes Reference

| Code | Meaning | Recovery |
|------|---------|----------|
| `TRANSPORT_WASM_OOM` | WASM memory exhausted | Restart Obsidian |
| `TRANSPORT_WASM_LOAD` | WASM failed to load | Check browser compatibility |
| `TRANSPORT_RECONNECT_FAILED` | Peer reconnection failed | Check network, re-pair |
| `SYNC_VAULT_MISMATCH` | Different vault IDs | Re-pair with correct vault |
| `SYNC_TIMEOUT` | Sync operation timed out | Retry, check network |
| `SYNC_BLOB_FAILED` | Binary file sync failed | Will retry automatically |
| `NET_RELAY_UNREACHABLE` | Can't reach relay server | Check relay URL, network |
| `PEER_DISCONNECTED` | Peer connection lost | Auto-reconnect in progress |

---

## Getting Help

1. **Copy Logs**: Settings > PeerVault > Advanced > Copy Logs
2. **Check GitHub Issues**: [github.com/your-repo/peervault/issues](https://github.com/your-repo/peervault/issues)
3. **Include**:
   - Obsidian version
   - PeerVault version
   - Platform (Windows/Mac/Linux/iOS/Android)
   - Error messages and logs
   - Steps to reproduce
