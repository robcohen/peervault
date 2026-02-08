# Obsidian E2E Testing Container

Docker setup for running Obsidian with CDP (Chrome DevTools Protocol) for E2E testing.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Docker Network (e2e-network)                       │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     obsidian-e2e container                              │ │
│  │                                                                         │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │ │
│  │  │    TEST      │  │    TEST2     │  │    TEST3     │                  │ │
│  │  │   Vault      │  │    Vault     │  │    Vault     │                  │ │
│  │  │  PeerVault   │  │  PeerVault   │  │  PeerVault   │                  │ │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │ │
│  │         └─────────────────┴─────────────────┘                          │ │
│  │                           │                                             │ │
│  │              Iroh Transport (QUIC via relay)                           │ │
│  │                           │                                             │ │
│  └───────────────────────────┼─────────────────────────────────────────────┘ │
│                              │                                               │
│                              ▼                                               │
│  ┌──────────────────────────────────────┐  ┌─────────────────────────────┐  │
│  │         relay container              │  │      minio container        │  │
│  │                                      │  │                             │  │
│  │  iroh-relay (QUIC relay server)      │  │  MinIO (S3-compatible)      │  │
│  │  http://relay:3340                   │  │  http://minio:9000          │  │
│  │                                      │  │                             │  │
│  └──────────────────────────────────────┘  └─────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                    │                                  │
                    ▼                                  ▼
            Host: localhost:3340               Host: localhost:9000
                    │                                  │
                    └──────────────┬───────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │      E2E Test Runner         │
                    │      (bun on host)           │
                    │                              │
                    │  CDP → localhost:9222        │
                    └──────────────────────────────┘
```

## Services

| Service | Description | Host Port |
|---------|-------------|-----------|
| `obsidian-e2e` | Obsidian with 3 vault windows | 9222 (CDP) |
| `relay` | iroh-relay for P2P connections | 3340 |
| `minio` | S3-compatible storage for cloud sync | 9000, 9001 (console) |
| `minio-init` | Creates test bucket (runs once) | - |

## Quick Start

```bash
# From project root
just docker-e2e-build    # Build all containers (includes relay compilation)
just docker-e2e-up       # Start all services
just docker-e2e-test     # Run E2E tests
just docker-e2e-down     # Stop all services
```

Or manually:

```bash
cd docker/e2e

# Build (first time takes ~10min for relay compilation)
docker compose build

# Start (detached)
docker compose up -d

# Wait ~60s for Obsidian to start and open vaults
sleep 60

# Check services are healthy
docker compose ps
curl -s http://localhost:9222/json/list | jq -r '.[].title'
curl -s http://localhost:3340/
curl -s http://localhost:9000/minio/health/live

# Run tests from project root
E2E_DOCKER=1 bun run test:e2e --docker

# Stop
docker compose down
```

## Ports

| Port | Service | Description |
|------|---------|-------------|
| 9222 | obsidian-e2e | CDP for all vault windows |
| 3340 | relay | iroh-relay HTTP/QUIC endpoint |
| 9000 | minio | S3 API endpoint |
| 9001 | minio | MinIO web console |

## Volumes

The compose file uses:
- `../../dist:/plugin-dist:ro` - PeerVault plugin (built with `bun run build`)
- Named volumes for vault data and MinIO storage

## Important Notes

### Plugin Trust Button

After the container starts, you need to click "Trust author and enable plugins" in each vault. The entrypoint attempts this automatically, but may not always succeed. If tests fail with "plugin not loaded", manually click trust via CDP:

```bash
# Check if trust button is visible
curl -s http://localhost:9222/json/list | jq -r '.[0].webSocketDebuggerUrl'
# Then use the websocket to click the button
```

### Docker Mode Flag

When running tests against Docker, use `--docker` flag or `E2E_DOCKER=1`:
- Relay URL is configured to `http://relay:3340` (Docker network hostname)
- MinIO URL is configured to `http://minio:9000` (Docker network hostname)
- Plugin reinstall is skipped (plugin is pre-installed)

### First Build Time

The relay container compiles `iroh-relay` from source, which takes ~10 minutes on first build. Subsequent builds are cached.

## Troubleshooting

### CDP connection refused

The container needs ~60s to fully start. Check health:

```bash
docker compose ps
curl http://localhost:9222/json/version
```

### Plugin not loading

1. Ensure plugin is built: `bun run build`
2. Check if trust button needs clicking
3. Restart: `docker compose restart obsidian-e2e`

### Relay not healthy

Check relay logs:
```bash
docker compose logs relay
```

### MinIO not accessible

Check MinIO health:
```bash
curl http://localhost:9000/minio/health/live
docker compose logs minio
```

### View Obsidian UI (debugging)

Use VNC or X11 forwarding to see the actual Obsidian windows:

```bash
# With x11docker (if installed)
x11docker --desktop --share /path/to/peervault/dist peervault-e2e
```

## Architecture Notes

### Why socat?

Chromium M113+ restricts CDP to localhost only. The socat proxy forwards external connections (from host) to the internal CDP server.

### Why separate relay container?

Running iroh-relay inside the Obsidian container would complicate networking. A separate container on the same Docker network allows clean service discovery via hostname (`http://relay:3340`).

### Why MinIO?

MinIO provides S3-compatible storage for testing the cloud sync feature without requiring AWS credentials or internet access.

### Memory requirements

Electron/Chromium needs significant shared memory. The compose file sets `shm_size: 2gb` to prevent crashes.
