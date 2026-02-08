# Dockerfile for running Obsidian E2E tests
# Uses Xvfb for headless display and socat for CDP port forwarding

FROM debian:bookworm-slim

ARG OBSIDIAN_VERSION=1.7.7
ARG DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Display and graphics
    xvfb \
    libgbm1 \
    libxss1 \
    libnss3 \
    libgtk-3-0 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc-s1 \
    libglib2.0-0 \
    libnspr4 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxext6 \
    fonts-liberation \
    # Obsidian dependencies
    libnotify4 \
    libxtst6 \
    xdg-utils \
    libsecret-1-0 \
    # Network tools
    socat \
    curl \
    wget \
    ca-certificates \
    # Process management
    supervisor \
    # Utilities
    procps \
    && rm -rf /var/lib/apt/lists/*

# Download and install Obsidian
RUN wget -q "https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/obsidian_${OBSIDIAN_VERSION}_amd64.deb" \
    && dpkg -i "obsidian_${OBSIDIAN_VERSION}_amd64.deb" \
    ; apt-get install -f -y \
    && rm "obsidian_${OBSIDIAN_VERSION}_amd64.deb" \
    && test -f /opt/Obsidian/obsidian && echo "Obsidian installed successfully"

# Create user for running Obsidian (Electron doesn't like running as root)
RUN useradd -m -s /bin/bash obsidian

# Create vault directories
RUN mkdir -p /vaults/TEST /vaults/TEST2 /vaults/TEST3 \
    && mkdir -p /home/obsidian/.config/obsidian \
    && chown -R obsidian:obsidian /vaults /home/obsidian

# Copy configuration files
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
COPY obsidian-config.json /home/obsidian/.config/obsidian/obsidian.json

RUN chmod +x /entrypoint.sh \
    && chown -R obsidian:obsidian /home/obsidian/.config

# Expose CDP port (via socat forwarding)
EXPOSE 19222

# Set environment
ENV DISPLAY=:99
ENV HOME=/home/obsidian

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s \
    CMD curl -s http://localhost:9222/json/version || exit 1

# Run as root initially - entrypoint will switch to obsidian for Obsidian processes
WORKDIR /home/obsidian

ENTRYPOINT ["/entrypoint.sh"]
