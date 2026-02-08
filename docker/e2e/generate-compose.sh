#!/usr/bin/env bash
# Generate docker-compose.yml with N client instances
# Usage: ./generate-compose.sh <num_clients> [output_file]
# Example: ./generate-compose.sh 5 docker-compose.generated.yml

set -e

NUM_CLIENTS="${1:-3}"
OUTPUT_FILE="${2:-}"

if [ "$NUM_CLIENTS" -lt 1 ]; then
    echo "Error: Number of clients must be at least 1" >&2
    exit 1
fi

generate_compose() {
    cat << 'HEADER'
# Auto-generated docker-compose for scalable E2E testing
# Generated with: ./generate-compose.sh NUM_CLIENTS

version: '3.8'

services:
  # Infrastructure services
  relay:
    build:
      context: ./relay
      dockerfile: Dockerfile
    ports:
      - "3340:3340"
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:3340/"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
    networks:
      - e2e-network

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:9000/minio/health/live"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 5s
    networks:
      - e2e-network

  minio-init:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin;
      mc mb local/peervault-test --ignore-existing;
      mc anonymous set public local/peervault-test;
      exit 0;
      "
    networks:
      - e2e-network

HEADER

    # Generate client services (based on linuxserver/obsidian)
    for i in $(seq 1 $NUM_CLIENTS); do
        CDP_PORT=$((9221 + i))  # 9222, 9223, 9224, ...
        WEB_PORT=$((3000 + i - 1))  # 3000, 3001, 3002, ... (for debugging via browser)

        cat << EOF
  # Client $i (linuxserver/obsidian based)
  client-$i:
    build:
      context: ./client
      dockerfile: Dockerfile
    ports:
      - "$CDP_PORT:19222"     # CDP for E2E testing (forwarded from internal 9222)
      - "$WEB_PORT:3000"      # Web UI for debugging (optional)
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - VAULT_NAME=client-$i
      - CDP_PORT=9222
      - RELAY_URL=http://relay:3340
    volumes:
      - ../../dist:/plugin-dist:ro
      - client-$i-config:/config
    shm_size: '2gb'
    security_opt:
      - seccomp:unconfined
    depends_on:
      relay:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:9222/json/version"]
      interval: 15s
      timeout: 10s
      retries: 12
      start_period: 60s
    networks:
      - e2e-network

EOF
    done

    # Networks section
    cat << 'NETWORKS'
networks:
  e2e-network:
    driver: bridge

NETWORKS

    # Volumes section
    echo "volumes:"
    echo "  minio-data:"
    for i in $(seq 1 $NUM_CLIENTS); do
        echo "  client-$i-config:"
    done
}

if [ -n "$OUTPUT_FILE" ]; then
    generate_compose > "$OUTPUT_FILE"
    echo "Generated $OUTPUT_FILE with $NUM_CLIENTS client(s)" >&2
else
    generate_compose
fi
