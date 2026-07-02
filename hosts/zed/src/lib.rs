//! Zed extension for PeerVault.
//!
//! Zed extensions run in a sandboxed WASI environment with no networking or
//! filesystem-watching APIs, so the sync engine cannot run in-process. This
//! extension is a thin launcher: it starts the native `peervaultd` daemon as a
//! per-worktree sidecar (via Zed's language-server mechanism — peervaultd
//! speaks a minimal LSP handshake on stdio and takes the workspace root from
//! `initialize`). All sync behaviour lives in the daemon; pairing is done with
//! `peervaultd ctl ticket` / `ctl add-peer` in a terminal.

use zed_extension_api::{self as zed, Result};

struct PeerVaultExtension;

impl zed::Extension for PeerVaultExtension {
    fn new() -> Self {
        PeerVaultExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let path = worktree
            .which("peervaultd")
            .ok_or_else(|| {
                "peervaultd not found on PATH — install it with \
                 `cargo install --path hosts/peervaultd` from the PeerVault repo"
                    .to_string()
            })?;
        Ok(zed::Command {
            command: path,
            args: vec!["lsp".to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(PeerVaultExtension);
