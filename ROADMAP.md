# PeerVault Roadmap

## Current State

PeerVault uses Iroh WASM for P2P networking. All connections go through Iroh relay servers (QUIC over WebSocket). This works reliably but adds latency, especially for devices on the same local network.

## Planned: WebRTC Transport for Direct LAN Connections

### Problem

WASM cannot use raw UDP sockets. Even when two devices are on the same WiFi network, traffic must traverse an external relay server. This adds:
- 50-200ms+ latency per round trip
- Dependency on relay server availability
- Unnecessary bandwidth through external infrastructure

### Solution: WebRTC DataChannel

WebRTC can establish direct UDP connections between peers on the same LAN using ICE "host" candidates. The browser handles NAT traversal automatically.

### Proof of Concept (Verified)

Tested on 2026-01-31 using the following test script:

```javascript
const pc = new RTCPeerConnection({ iceServers: [] });
pc.createDataChannel('test');
await pc.createOffer().then(o => pc.setLocalDescription(o));
// Result: Host candidates gathered without any STUN server
```

#### Desktop Results (Obsidian Electron)

```json
{
  "available": true,
  "candidates": [
    { "type": "host", "protocol": "udp", "address": "100.110.167.224", "port": 38978 },
    { "type": "host", "protocol": "udp", "address": "100.103.102.77", "port": 51992 },
    { "type": "host", "protocol": "udp", "address": "[2605:ad80:3d:a0cb:...]", "port": 43578 },
    { "type": "host", "protocol": "tcp", "address": "100.110.167.224", "port": 9 }
  ]
}
```

- Multiple host candidates (IPv4, IPv6, UDP, TCP)
- No STUN servers required
- Tailscale IPs visible (100.x.x.x), regular LAN IPs also available

#### Android Results (Waydroid - Android 13 WebView)

```json
{
  "available": true,
  "candidates": [
    { "type": "host", "protocol": "udp", "address": "192.168.240.112", "port": 53731 }
  ]
}
```

- WebRTC fully functional in Android WebView
- Host candidate with local IP gathered
- Direct LAN connections possible on Android

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Signaling Layer                          │
│                    (Iroh Relay - always on)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                    SDP Offer/Answer Exchange
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      WebRTC DataChannel                         │
│         (Direct UDP if same LAN, else falls back)               │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Plan

#### Phase 1: WebRTC Transport Layer

1. Create `src/transport/webrtc-transport.ts`
   - RTCPeerConnection management
   - DataChannel abstraction matching existing transport interface
   - ICE candidate gathering and exchange

2. Signaling via Iroh
   - Add message types: `webrtc-offer`, `webrtc-answer`, `webrtc-ice-candidate`
   - Exchange SDP through existing Iroh relay connection
   - Handle location where Iroh connection exists but WebRTC upgrade desired

3. Connection upgrade flow:
   ```
   1. Establish Iroh relay connection (existing flow)
   2. Initiate WebRTC handshake over Iroh
   3. If WebRTC connects with host candidates → use direct path
   4. If WebRTC fails or only relay candidates → keep using Iroh
   ```

#### Phase 2: Hybrid Transport

1. `src/transport/hybrid-transport.ts`
   - Wraps both Iroh and WebRTC transports
   - Automatic upgrade when WebRTC direct path available
   - Seamless fallback to Iroh relay
   - Connection quality monitoring to choose best path

2. Metrics and switching logic:
   - Compare RTT between Iroh and WebRTC paths
   - Switch to lower-latency path
   - Fall back if connection degrades

#### Phase 3: Mobile Verification

Test matrix:
| Platform | WebView | WebRTC Support | Host Candidates | Status |
|----------|---------|----------------|-----------------|--------|
| Desktop (Electron) | Chromium | Full | Yes (UDP+TCP, IPv4+IPv6) | **Verified** |
| Android | Chrome WebView | Full | Yes (UDP) | **Verified** (Waydroid) |
| iOS | WKWebView | Partial (iOS 14.3+) | Unknown | Untested |

Mobile test script (for iOS verification):
```javascript
// Run in Obsidian Mobile dev console
(async () => {
  if (typeof RTCPeerConnection === 'undefined') {
    return 'WebRTC not available';
  }
  const pc = new RTCPeerConnection({ iceServers: [] });
  const candidates = [];
  pc.onicecandidate = e => e.candidate && candidates.push(e.candidate.type);
  pc.createDataChannel('test');
  await pc.createOffer().then(o => pc.setLocalDescription(o));
  await new Promise(r => setTimeout(r, 3000));
  pc.close();
  return { available: true, candidateTypes: [...new Set(candidates)] };
})();
```

**iOS Status**: Untested but expected to work. WKWebView has full WebRTC support since iOS 14.3. The WebRTC DataChannel API is identical across all platforms - if it works on Android WebView, it should work on iOS WKWebView. Test on real device when available.

### Configuration

```typescript
interface TransportConfig {
  // Always use Iroh relay for initial connection and signaling
  irohRelay: string;

  // WebRTC upgrade settings
  webrtc: {
    enabled: boolean;           // Default: true on desktop, test on mobile
    upgradeTimeout: number;     // How long to wait for WebRTC (default: 5000ms)
    iceServers: RTCIceServer[]; // Empty for LAN-only, add STUN for internet
    preferDirectPath: boolean;  // Switch to WebRTC if lower latency (default: true)
  };
}
```

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| WebRTC unavailable on some platforms | Feature detection, graceful fallback to Iroh |
| ICE gathering slow/fails | Timeout and continue with Iroh relay |
| Mobile WebView restrictions | Test thoroughly, disable WebRTC upgrade if broken |
| Complexity increase | Keep Iroh as primary, WebRTC as optional upgrade |

### Success Criteria

1. Same-LAN sync latency reduced from ~100ms to <10ms
2. No regression in cross-network sync (Iroh relay still works)
3. Mobile platforms either work with WebRTC or gracefully fall back
4. No additional external server dependencies for LAN sync

---

## Other Future Improvements

### Sync Improvements
- [ ] Conflict resolution UI for simultaneous edits
- [ ] Selective folder sync
- [ ] Bandwidth throttling options

### Security
- [ ] End-to-end encryption for relay traffic
- [ ] Peer verification via QR code signing

### UX
- [ ] Sync history/timeline view
- [ ] Per-file sync status indicators
- [ ] Background sync on mobile
