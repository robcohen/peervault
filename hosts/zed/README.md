# PeerVault for Zed

P2P sync for any Zed workspace, powered by the `peervaultd` daemon (the same
Rust engine as the PeerVault Obsidian and VSCode plugins).

Zed extensions are sandboxed WASI modules without networking or file-watching,
so the engine runs as a **native sidecar**: this extension just launches
`peervaultd lsp` for the worktree (via Zed's language-server mechanism), and the
daemon does everything — file watching, CRDT sync over iroh, encryption.

## Setup

1. Install the daemon:
   ```sh
   cargo install --path hosts/peervaultd   # from the PeerVault repo
   ```
2. Install this extension: Zed → Extensions → *Install Dev Extension* →
   select `hosts/zed/`. (Zed compiles it with your Rust toolchain.)
3. Open a Markdown/text file in your workspace — Zed starts the daemon for the
   worktree automatically.

## Pairing

In a terminal, in the workspace directory:

```sh
peervaultd ctl ticket            # on the inviting machine — share the output
peervaultd ctl add-peer <TICKET> # on a machine already in the same vault
# to JOIN a new vault from scratch instead:
peervaultd run --join <TICKET>   # once; adopts the inviter's vault identity
```

`peervaultd ctl status` shows the node id and peers. Synced changes appear on
disk and Zed picks them up automatically.

## No Zed at all?

The extension is optional — `peervaultd run` in any directory syncs it for
*every* editor (vim, Helix, anything).
