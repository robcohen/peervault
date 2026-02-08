# Build stage: compile iroh-relay from source
# Using latest Rust as iroh-relay requires Rust 1.89+
FROM rust:latest AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install iroh-relay with server feature
RUN cargo install iroh-relay --features="server"

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the compiled binary
COPY --from=builder /usr/local/cargo/bin/iroh-relay /usr/local/bin/iroh-relay

# Expose relay port
EXPOSE 3340

# Run in dev mode (no TLS, localhost binding)
ENV RUST_LOG=info,iroh_relay=debug

CMD ["iroh-relay", "--dev"]
