#!/usr/bin/env bash
# E2E Test Runner with Dynamic Scaling
# Usage:
#   ./e2e.sh up N       - Start infrastructure + N clients
#   ./e2e.sh down       - Stop everything
#   ./e2e.sh test N     - Run tests with N clients (starts if needed)
#   ./e2e.sh status     - Show running containers
#   ./e2e.sh logs [N]   - Show logs (optionally for client N)

set -e
cd "$(dirname "$0")"

COMPOSE_PROJECT="e2e"
COMPOSE_FILE="docker-compose.yml"
BASE_CDP_PORT=9222
BASE_WEB_PORT=3000

# Detect docker or podman
if command -v podman-compose &> /dev/null; then
    COMPOSE_CMD="podman-compose"
    CONTAINER_CMD="podman"
elif command -v docker &> /dev/null; then
    COMPOSE_CMD="docker compose"
    CONTAINER_CMD="docker"
else
    echo "Error: Neither docker nor podman found"
    exit 1
fi

# Get the client image name
get_client_image() {
    # Build if needed and get image name
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" build client 2>/dev/null || true
    echo "${COMPOSE_PROJECT}_client"
}

# Start infrastructure services
start_infra() {
    echo "Starting infrastructure services..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" up -d relay minio minio-init
    
    echo "Waiting for relay to be healthy..."
    for i in {1..30}; do
        if curl -sf http://localhost:3340/ > /dev/null 2>&1; then
            echo "Relay is ready"
            return 0
        fi
        sleep 1
    done
    echo "Warning: Relay health check timed out"
}

# Start N client containers
start_clients() {
    local num_clients=$1
    echo "Starting $num_clients client(s)..."
    
    # Build client image first
    echo "Building client image..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" build client 2>/dev/null || {
        # Fallback: build from client directory
        $CONTAINER_CMD build -t "${COMPOSE_PROJECT}-client" ./client
    }
    
    local image="${COMPOSE_PROJECT}-client"
    local network="${COMPOSE_PROJECT}_e2e-network"
    
    # Ensure network exists
    $CONTAINER_CMD network inspect "$network" > /dev/null 2>&1 || \
        $CONTAINER_CMD network create "$network"
    
    for i in $(seq 1 $num_clients); do
        local container_name="${COMPOSE_PROJECT}-client-$i"
        local cdp_port=$((BASE_CDP_PORT + i - 1))
        local web_port=$((BASE_WEB_PORT + i - 1))
        
        # Remove existing container if any
        $CONTAINER_CMD rm -f "$container_name" 2>/dev/null || true
        
        echo "  Starting client-$i (CDP: $cdp_port, Web: $web_port)..."
        $CONTAINER_CMD run -d \
            --name "$container_name" \
            --network "$network" \
            --shm-size=2g \
            --security-opt seccomp=unconfined \
            -e PUID=1000 \
            -e PGID=1000 \
            -e TZ=Etc/UTC \
            -e "VAULT_NAME=client-$i" \
            -e CDP_PORT=9222 \
            -e RELAY_URL=http://relay:3340 \
            -v "$(cd ../.. && pwd)/dist:/plugin-dist:ro" \
            -p "$cdp_port:19222" \
            -p "$web_port:3000" \
            "$image" > /dev/null
    done
    
    echo "Waiting for clients to be healthy..."
    local all_healthy=false
    for attempt in {1..60}; do
        all_healthy=true
        for i in $(seq 1 $num_clients); do
            local cdp_port=$((BASE_CDP_PORT + i - 1))
            if ! curl -sf "http://localhost:$cdp_port/json/version" > /dev/null 2>&1; then
                all_healthy=false
                break
            fi
        done
        if $all_healthy; then
            echo "All $num_clients client(s) are healthy"
            return 0
        fi
        printf "."
        sleep 2
    done
    echo ""
    echo "Warning: Some clients may not be healthy yet"
}

# Stop all containers
stop_all() {
    echo "Stopping all containers..."
    
    # Stop client containers
    for container in $($CONTAINER_CMD ps -a --filter "name=${COMPOSE_PROJECT}-client-" --format '{{.Names}}' 2>/dev/null); do
        echo "  Stopping $container..."
        $CONTAINER_CMD rm -f "$container" > /dev/null 2>&1 || true
    done
    
    # Stop infrastructure
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" down 2>/dev/null || true
    
    echo "Done"
}

# Get CDP endpoints string for test runner
get_cdp_endpoints() {
    local num_clients=$1
    local endpoints=""
    for i in $(seq 1 $num_clients); do
        local port=$((BASE_CDP_PORT + i - 1))
        if [ -n "$endpoints" ]; then
            endpoints="$endpoints,"
        fi
        endpoints="${endpoints}localhost:$port"
    done
    echo "$endpoints"
}

# Show status
show_status() {
    echo "=== Infrastructure ==="
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT" ps 2>/dev/null || true
    
    echo ""
    echo "=== Clients ==="
    $CONTAINER_CMD ps --filter "name=${COMPOSE_PROJECT}-client-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "No clients running"
}

# Run tests
run_tests() {
    local num_clients=$1
    local endpoints=$(get_cdp_endpoints $num_clients)
    
    echo "Running E2E tests with $num_clients client(s)..."
    echo "CDP Endpoints: $endpoints"
    echo ""
    
    cd ../..
    E2E_CDP_ENDPOINTS="$endpoints" bun run e2e/scaled-runner.ts --clients=$num_clients "${@:2}"
}

# Main
case "${1:-}" in
    up)
        num=${2:-2}
        start_infra
        start_clients $num
        echo ""
        echo "CDP Endpoints: $(get_cdp_endpoints $num)"
        echo ""
        echo "Run tests with: ./e2e.sh test $num"
        ;;
    down)
        stop_all
        ;;
    test)
        num=${2:-2}
        # Check if clients are running
        running=$($CONTAINER_CMD ps --filter "name=${COMPOSE_PROJECT}-client-" --format '{{.Names}}' 2>/dev/null | wc -l)
        if [ "$running" -lt "$num" ]; then
            echo "Starting $num clients..."
            start_infra
            start_clients $num
        fi
        run_tests $num "${@:3}"
        ;;
    status)
        show_status
        ;;
    logs)
        if [ -n "${2:-}" ]; then
            $CONTAINER_CMD logs -f "${COMPOSE_PROJECT}-client-$2"
        else
            $CONTAINER_CMD logs -f $($CONTAINER_CMD ps --filter "name=${COMPOSE_PROJECT}-client-" --format '{{.Names}}' | head -1)
        fi
        ;;
    endpoints)
        num=${2:-2}
        get_cdp_endpoints $num
        ;;
    *)
        echo "E2E Test Runner"
        echo ""
        echo "Usage:"
        echo "  $0 up N        Start infrastructure + N clients"
        echo "  $0 down        Stop everything"
        echo "  $0 test N      Run tests with N clients"
        echo "  $0 status      Show container status"
        echo "  $0 logs [N]    Show logs for client N (or first client)"
        echo "  $0 endpoints N Output CDP endpoints string for N clients"
        echo ""
        echo "Examples:"
        echo "  $0 up 5        # Start 5 clients"
        echo "  $0 test 5      # Run tests (starts clients if needed)"
        echo "  $0 down        # Stop everything"
        ;;
esac
