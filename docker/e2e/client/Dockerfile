# Scaled E2E Client based on linuxserver/obsidian
# Adds CDP (Chrome DevTools Protocol) support for E2E testing
#
# Based on: https://docs.linuxserver.io/images/docker-obsidian/

FROM lscr.io/linuxserver/obsidian:latest

# Install socat for CDP port forwarding and websocat for WebSocket communication
RUN apt-get update && apt-get install -y --no-install-recommends \
    socat \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -L https://github.com/vi/websocat/releases/download/v1.13.0/websocat.x86_64-unknown-linux-musl -o /usr/local/bin/websocat \
    && chmod +x /usr/local/bin/websocat

# Create directory for our custom scripts
RUN mkdir -p /custom-cont-init.d /custom-services.d

# Copy initialization script that sets up the vault and plugin
COPY --chmod=755 init-vault.sh /custom-cont-init.d/99-init-vault

# Copy CDP forwarder service and trust dialog JSON
COPY --chmod=755 cdp-forwarder.sh /custom-services.d/cdp-forwarder
COPY accept-trust-dialog.json /opt/accept-trust-dialog.json

# Replace /usr/bin/obsidian with our CDP-enabled wrapper
COPY --chmod=755 obsidian-cdp-wrapper.sh /usr/bin/obsidian

# Expose CDP forwarded port (in addition to linuxserver's 3000/3001)
# Internal CDP is on 9222, forwarded via socat to 19222
EXPOSE 19222

# Environment variables for E2E testing
ENV CDP_PORT=9222
ENV VAULT_NAME=client
ENV RELAY_URL=http://relay:3340
