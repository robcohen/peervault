{
  description = "PeerVault - P2P sync for Obsidian using Loro CRDT and Iroh transport";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        # Rust toolchain for potential native builds (Iroh, wasm-pack)
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
          targets = [ "wasm32-unknown-unknown" ];
        };

      in {
        devShells.default = pkgs.mkShell {
          name = "peervault-dev";

          buildInputs = with pkgs; [
            # JavaScript/TypeScript (using Bun instead of npm)
            bun
            nodejs_22  # Still needed for Obsidian plugin compatibility

            # TypeScript tooling
            typescript
            nodePackages.typescript-language-server

            # Rust (for potential Iroh/WASM compilation)
            rustToolchain
            wasm-pack
            wasm-bindgen-cli

            # Python via uv
            uv
            python312

            # Build tools
            pkg-config
            openssl

            # Development utilities
            jq
            yq-go
            just  # Command runner
            watchexec  # File watcher for dev

            # Testing
            playwright-driver.browsers

            # Git
            git
            gh  # GitHub CLI

            # Android debugging
            android-tools  # adb, fastboot
          ];

          shellHook = ''
            echo "🔐 PeerVault Development Environment"
            echo ""
            echo "Tools available:"
            echo "  bun      - JavaScript runtime & package manager"
            echo "  node     - Node.js (for Obsidian compatibility)"
            echo "  uv       - Python package manager"
            echo "  rust     - Rust toolchain with WASM target"
            echo "  wasm-pack - Build Rust to WASM"
            echo ""

            # Set up Playwright browsers path
            export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true

            # Bun cache in project
            export BUN_INSTALL="$PWD/.bun"
            export PATH="$BUN_INSTALL/bin:$PATH"

            # Python/uv setup
            export UV_CACHE_DIR="$PWD/.uv-cache"

            # Rust/Cargo setup
            export CARGO_HOME="$PWD/.cargo"
            export PATH="$CARGO_HOME/bin:$PATH"

            # Node modules binaries
            export PATH="$PWD/node_modules/.bin:$PATH"

            # Initialize project if package.json doesn't exist
            if [ ! -f package.json ]; then
              echo ""
              echo "No package.json found. Run 'bun init' to initialize the project."
            fi
          '';

          # Environment variables
          RUST_BACKTRACE = "1";
          RUST_LOG = "info";
        };

        # Package for building the plugin
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "peervault";
          version = "0.1.0";
          src = ./.;

          nativeBuildInputs = with pkgs; [
            bun
            nodejs_22
          ];

          buildPhase = ''
            export HOME=$(mktemp -d)
            bun install --frozen-lockfile
            bun run build
          '';

          installPhase = ''
            mkdir -p $out
            cp -r dist/* $out/
            cp manifest.json $out/ 2>/dev/null || true
            cp styles.css $out/ 2>/dev/null || true
          '';
        };
      }
    );
}
