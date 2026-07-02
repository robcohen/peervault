//! peervaultd — PeerVault sync daemon.
//!
//! Runs the host-agnostic `PeerVault` engine natively and syncs one directory
//! peer-to-peer. Editor-agnostic: run it in a workspace and any editor (Zed,
//! vim, …) sees synced files appear; the Zed extension merely launches this
//! binary as a workspace sidecar (`--lsp` mode).
//!
//!   peervaultd run  [--dir D] [--relay URL] [--join TICKET]
//!   peervaultd ctl  <ticket|status|add-peer TICKET> [--dir D]
//!   peervaultd lsp  [--relay URL]        # stdio LSP shim (root from initialize)
//!
//! Host duties implemented here (see docs/EMBEDDING.md): file watching →
//! CRDT ingest, applying core reconcile plans to disk, pairing UX (tickets via
//! a control socket), and state persistence.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use peervault_core::pairing;
use rand::Rng as _;
use peervault_core::vault::PeerVault;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tracing::{info, warn};

const EXCLUDED_DIRS: &[&str] = &[".peervault", ".git", ".vscode", ".zed", "node_modules", "target"];
const FILE_DEBOUNCE: Duration = Duration::from_millis(1500);
const RECONCILE_DEBOUNCE: Duration = Duration::from_millis(1000);
const PAIRING_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

struct Args {
    cmd: String,
    dir: PathBuf,
    relay: Option<String>,
    join: Option<String>,
    log_file: Option<PathBuf>,
    ctl_args: Vec<String>,
}

fn parse_args() -> Result<Args> {
    let mut argv = std::env::args().skip(1).peekable();
    let cmd = match argv.peek().map(|s| s.as_str()) {
        Some("run") | Some("ctl") | Some("lsp") => argv.next().unwrap(),
        Some("--help") | Some("-h") | None => {
            println!(
                "peervaultd — PeerVault sync daemon\n\n\
                 USAGE:\n  peervaultd run [--dir D] [--relay URL] [--join TICKET]\n  \
                 peervaultd ctl <ticket|status|add-peer TICKET> [--dir D]\n  \
                 peervaultd lsp [--relay URL]"
            );
            std::process::exit(0);
        }
        _ => "run".to_string(),
    };

    let mut dir = std::env::current_dir()?;
    let mut relay = None;
    let mut join = None;
    let mut log_file = None;
    let mut ctl_args = Vec::new();
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--dir" => dir = PathBuf::from(argv.next().context("--dir needs a value")?),
            "--relay" => relay = Some(argv.next().context("--relay needs a value")?),
            "--join" => join = Some(argv.next().context("--join needs a value")?),
            "--log-file" => log_file = Some(PathBuf::from(argv.next().context("--log-file needs a value")?)),
            other => ctl_args.push(other.to_string()),
        }
    }
    // absolute() keeps symlinks unresolved: unix-socket paths are SUN_LEN-limited
    // and users may deliberately reach a deep dir through a short symlink.
    Ok(Args { cmd, dir: std::path::absolute(&dir).unwrap_or(dir), relay, join, log_file, ctl_args })
}

fn main() -> Result<()> {
    let args = parse_args()?;
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info,iroh=warn,iroh_gossip=warn".into())
    };
    match &args.log_file {
        Some(path) => {
            let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
            tracing_subscriber::fmt()
                .with_env_filter(filter())
                .with_writer(std::sync::Mutex::new(file))
                .with_ansi(false)
                .init();
        }
        None => {
            tracing_subscriber::fmt()
                .with_env_filter(filter())
                .with_writer(std::io::stderr)
                .init();
        }
    }
    let rt = tokio::runtime::Runtime::new()?;
    match args.cmd.as_str() {
        "ctl" => rt.block_on(ctl(&args)),
        "lsp" => rt.block_on(lsp_main(args)),
        _ => rt.block_on(run(args, None)),
    }
}

// ---------------------------------------------------------------------------
// Control socket client
// ---------------------------------------------------------------------------

fn sock_path(dir: &Path) -> PathBuf {
    dir.join(".peervault").join("ctl.sock")
}

async fn ctl(args: &Args) -> Result<()> {
    let sock = sock_path(&args.dir);
    let mut stream = UnixStream::connect(&sock)
        .await
        .with_context(|| format!("no daemon running for {} (socket {:?})", args.dir.display(), sock))?;
    stream.write_all(format!("{}\n", args.ctl_args.join(" ")).as_bytes()).await?;
    stream.shutdown().await?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).await?;
    print!("{reply}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

struct Identity {
    vault_id: String,
    key_hex: Option<String>,
}

fn load_or_create_identity(state_dir: &Path, join: Option<&pairing::PairingTicket>) -> Result<Identity> {
    std::fs::create_dir_all(state_dir)?;
    let id_path = state_dir.join("vault-id");
    let key_path = state_dir.join("key.hex");

    if let Some(t) = join {
        // Adopt the inviter's identity (overwrites any local one — joining a vault).
        std::fs::write(&id_path, &t.vault_id)?;
        std::fs::write(&key_path, &t.key_hex)?;
        return Ok(Identity { vault_id: t.vault_id.clone(), key_hex: Some(t.key_hex.clone()) });
    }

    let vault_id = match std::fs::read_to_string(&id_path) {
        Ok(s) => s.trim().to_string(),
        Err(_) => {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            let id = hex::encode(bytes);
            std::fs::write(&id_path, &id)?;
            id
        }
    };
    let key_hex = std::fs::read_to_string(&key_path).ok().map(|s| s.trim().to_string());
    Ok(Identity { vault_id, key_hex })
}

fn rel_path(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        return None;
    }
    let first = s.split('/').next().unwrap_or("");
    if EXCLUDED_DIRS.contains(&first) {
        return None;
    }
    Some(s)
}

async fn run(args: Args, lsp_root: Option<PathBuf>) -> Result<()> {
    let root = lsp_root.unwrap_or_else(|| args.dir.clone());
    let state_dir = root.join(".peervault");
    let join_ticket = match &args.join {
        Some(t) => Some(pairing::decode(t).context("--join: not a valid pairing ticket")?),
        None => None,
    };
    let identity = load_or_create_identity(&state_dir, join_ticket.as_ref())?;

    let hostname = std::fs::read_to_string("/etc/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "peervaultd".into());

    let mut vault = PeerVault::new(&identity.vault_id, &hostname)
        .map_err(|e| anyhow::anyhow!("engine init: {e}"))?;
    if let Some(relay) = &args.relay {
        vault.set_relay_url(relay);
    }

    // Engine events → the main loop.
    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel();
    vault.set_event_callback(Arc::new(move |event| {
        let _ = ev_tx.send(event.clone());
    }));

    if let Some(key) = &identity.key_hex {
        vault.set_encryption_key(key).await.map_err(|e| anyhow::anyhow!("set key: {e}"))?;
    } else {
        let key = vault.generate_encryption_key().await.map_err(|e| anyhow::anyhow!("gen key: {e}"))?;
        std::fs::write(state_dir.join("key.hex"), &key)?;
    }

    // Boot from persisted state when present.
    let state_path = state_dir.join("state.bin");
    match std::fs::read(&state_path) {
        Ok(state) => vault.start_with_state(&state).await.map_err(|e| anyhow::anyhow!("start: {e}"))?,
        Err(_) => vault.start().await.map_err(|e| anyhow::anyhow!("start: {e}"))?,
    }
    info!("peervaultd syncing {} (vault {})", root.display(), &identity.vault_id[..8]);

    // First run on an existing directory: seed the CRDT from disk.
    if vault.list(None).await.map(|j| j == "[]").unwrap_or(true) {
        let mut count = 0usize;
        let mut stack = vec![root.clone()];
        while let Some(d) = stack.pop() {
            for entry in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if rel_path(&root, &p).is_some() {
                        stack.push(p);
                    }
                } else if let Some(rel) = rel_path(&root, &p) {
                    if entry.metadata().map(|m| m.len() <= MAX_FILE_SIZE).unwrap_or(false) {
                        if let Ok(bytes) = std::fs::read(&p) {
                            if vault.set(&rel, &bytes).await.is_ok() {
                                count += 1;
                            }
                        }
                    }
                }
            }
        }
        info!("initial scan ingested {count} files");
    }

    // Join a peer's vault if asked.
    if let Some(t) = &join_ticket {
        info!("pairing with inviter…");
        let peer = vault
            .connect_peer_with_pairing(&t.transport, t.nonce.clone(), Some(hostname.clone()))
            .await
            .map_err(|e| anyhow::anyhow!("pairing failed: {e}"))?;
        info!("paired with {}…", &peer[..16.min(peer.len())]);
    }

    // Filesystem watcher (notify thread → tokio channel).
    let (fs_tx, mut fs_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = {
        use notify::Watcher as _;
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let _ = fs_tx.send(event);
            }
        })?;
        w.watch(&root, notify::RecursiveMode::Recursive)?;
        w
    };
    let _keep_watcher = &mut watcher;

    // Control socket.
    let sock = sock_path(&root);
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock)?;

    // Main loop state.
    let mut pending: HashMap<String, Instant> = HashMap::new(); // dirty local edits
    let mut deleted: HashSet<String> = HashSet::new();
    // Deterministic echo detection for our own fs operations — no time windows
    // (they race the watcher's delivery). `applied` remembers the exact content
    // hash we last wrote per path (None = we deleted it). A watcher event whose
    // disk state matches the applied state is our own echo; anything else is a
    // real user action and must be ingested.
    let mut applied: HashMap<String, Option<u64>> = HashMap::new();
    let mut reconcile_at: Option<Instant> = None;
    let mut persist_at: Option<Instant> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(300));

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("shutting down…");
                break;
            }
            Some(event) = fs_rx.recv() => {
                // Access events are READS (our own apply/compare passes, editors
                // previewing, etc.) — never an edit signal. Feeding them into
                // `pending` polluted the dirty-set: dirty paths are shielded from
                // plan.deletes, so a remotely-deleted file's stale disk copy
                // survived reconciliation and was later re-ingested as a "user
                // edit" (the store said None post-delete) — resurrecting it on
                // every peer. Ignore reads entirely.
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    continue;
                }
                for p in event.paths {
                    let Some(rel) = rel_path(&root, &p) else { continue };
                    tracing::debug!("watch: {:?} {rel}", event.kind);
                    let event_is_remove = matches!(event.kind, notify::EventKind::Remove(_)) || !p.exists();
                    // Echo check: does the disk now look exactly like what WE last
                    // applied? (missing file matches an applied delete; matching
                    // hash matches an applied write.)
                    if let Some(applied_state) = applied.get(&rel) {
                        let disk_state = std::fs::read(&p).ok().map(|b| content_hash(&b));
                        if disk_state == *applied_state {
                            tracing::debug!("watch: echo of our own apply, skipping {rel}");
                            continue;
                        }
                    }
                    if event_is_remove {
                        pending.remove(&rel);
                        deleted.insert(rel);
                    } else if p.is_file() {
                        deleted.remove(&rel);
                        pending.insert(rel, Instant::now());
                    }
                }
            }
            Some(event) = ev_rx.recv() => {
                use peervault_core::events::Event::*;
                match event {
                    DocumentChanged { .. } | SyncComplete { .. } => {
                        reconcile_at = Some(Instant::now() + RECONCILE_DEBOUNCE);
                    }
                    SyncNeeded { .. } => info!("large delta — a full point-to-point sync is needed"),
                    PairingComplete { peer_id, device_name } => {
                        info!("paired: {device_name} ({}…)", &peer_id[..16.min(peer_id.len())]);
                        persist_at = Some(Instant::now());
                    }
                    _ => {}
                }
            }
            Ok((stream, _)) = listener.accept() => {
                if let Err(e) = handle_ctl(stream, &vault, &identity.vault_id).await {
                    warn!("ctl: {e}");
                }
            }
            _ = tick.tick() => {
                // Flush debounced local edits into the CRDT.
                let due: Vec<String> = pending
                    .iter()
                    .filter(|(_, t)| t.elapsed() >= FILE_DEBOUNCE)
                    .map(|(k, _)| k.clone())
                    .collect();
                for rel in due {
                    pending.remove(&rel);
                    applied.remove(&rel);
                    let p = root.join(&rel);
                    if let Ok(bytes) = std::fs::read(&p) {
                        // Skip no-op ingests (e.g. our own reconcile writes whose
                        // watcher events straggled past the suppression window) —
                        // they'd mint redundant CRDT ops and gossip echoes.
                        if matches!(vault.get(&rel).await, Ok(Some(existing)) if existing == bytes) {
                            continue;
                        }
                        tracing::debug!("ingest set: {rel}");
                        if let Err(e) = vault.set(&rel, &bytes).await {
                            warn!("ingest {rel}: {e}");
                        }
                        persist_at = Some(Instant::now() + Duration::from_secs(2));
                    }
                }
                for rel in deleted.drain() {
                    applied.remove(&rel);
                    tracing::debug!("ingest delete: {rel}");
                    if let Err(e) = vault.delete(&rel).await {
                        warn!("delete {rel}: {e}");
                    }
                    persist_at = Some(Instant::now() + Duration::from_secs(2));
                }
                // Apply due reconcile.
                if reconcile_at.is_some_and(|t| Instant::now() >= t) {
                    reconcile_at = None;
                    let dirty: Vec<String> = pending.keys().cloned().collect();
                    if let Err(e) = apply_plan(&vault, &root, dirty, &mut applied).await {
                        warn!("reconcile: {e}");
                    }
                    persist_at = Some(Instant::now());
                }
                // Persist state after activity settles.
                if persist_at.is_some_and(|t| Instant::now() >= t) {
                    persist_at = None;
                    if let Ok(state) = vault.export().await {
                        let _ = std::fs::write(&state_path, state);
                    }
                }
            }
        }
    }

    if let Ok(state) = vault.export().await {
        let _ = std::fs::write(&state_path, state);
    }
    vault.stop().await.ok();
    let _ = std::fs::remove_file(&sock);
    Ok(())
}

/// Apply a core-computed reconcile plan to disk.
fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

async fn apply_plan(
    vault: &PeerVault,
    root: &Path,
    dirty: Vec<String>,
    applied: &mut HashMap<String, Option<u64>>,
) -> Result<()> {
    let plan = vault.reconcile_plan(dirty).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    tracing::debug!("plan: upserts={:?} deletes={:?}", plan.upserts, plan.deletes);
    for rel in &plan.upserts {
        let Ok(Some(content)) = vault.get(rel).await else { continue };
        let p = root.join(rel);
        if std::fs::read(&p).map(|disk| disk == content).unwrap_or(false) {
            continue;
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        applied.insert(rel.clone(), Some(content_hash(&content)));
        tracing::debug!("apply write: {rel}");
        if let Err(e) = std::fs::write(&p, &content) {
            warn!("write {rel}: {e}");
        }
    }
    for rel in &plan.deletes {
        applied.insert(rel.clone(), None);
        let _ = std::fs::remove_file(root.join(rel));
    }
    if !plan.upserts.is_empty() || !plan.deletes.is_empty() {
        info!("reconciled: {} upserts, {} deletes", plan.upserts.len(), plan.deletes.len());
    }
    Ok(())
}

/// One control-socket request: `ticket` | `status` | `add-peer <ticket>`.
async fn handle_ctl(stream: UnixStream, vault: &PeerVault, vault_id: &str) -> Result<()> {
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    BufReader::new(read).read_line(&mut line).await?;
    let mut parts = line.trim().split_whitespace();
    let reply = match parts.next() {
        Some("ticket") => {
            let key = vault
                .get_encryption_key()
                .await
                .ok()
                .flatten()
                .context("no vault key yet")?;
            let transport = vault.get_ticket().await.map_err(|e| anyhow::anyhow!("{e}"))?;
            let mut nonce_bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut nonce_bytes);
            let nonce = hex::encode(nonce_bytes);
            vault.register_pairing_nonce(&nonce, now_ms() + PAIRING_TIMEOUT_MS);
            pairing::encode(&pairing::PairingTicket {
                transport,
                key_hex: key,
                vault_id: vault_id.to_string(),
                nonce: Some(nonce),
            })
        }
        Some("list") => {
            vault.list(None).await.map_err(|e| anyhow::anyhow!("{e}"))?
        }
        Some("status") => {
            let node = vault.get_node_id().await.unwrap_or_else(|_| "?".into());
            let peers = vault.get_known_peers();
            format!("node: {node}\npeers: {}", if peers.is_empty() { "none".into() } else { peers.join(", ") })
        }
        Some("add-peer") => {
            let ticket = parts.next().context("usage: add-peer <ticket>")?;
            match pairing::decode(ticket) {
                Some(t) if t.vault_id != vault_id => {
                    "this ticket is for a different vault — rejoin with: peervaultd run --join <ticket>".to_string()
                }
                Some(t) => {
                    let peer = vault
                        .connect_peer_with_pairing(&t.transport, t.nonce.clone(), None)
                        .await
                        .map_err(|e| anyhow::anyhow!("pairing failed: {e}"))?;
                    format!("paired with {peer}")
                }
                None => "not a pairing ticket".to_string(),
            }
        }
        _ => "commands: ticket | status | list | add-peer <ticket>".to_string(),
    };
    write.write_all(reply.as_bytes()).await?;
    write.write_all(b"\n").await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// LSP shim (Zed sidecar): minimal stdio handshake, then run the daemon with
// the workspace root from `initialize`.
// ---------------------------------------------------------------------------

async fn lsp_main(args: Args) -> Result<()> {
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();

    let root = loop {
        let msg = read_lsp_message(&mut stdin).await?;
        let v: serde_json::Value = serde_json::from_slice(&msg)?;
        if v["method"] == "initialize" {
            let reply = serde_json::json!({
                "jsonrpc": "2.0",
                "id": v["id"],
                "result": {
                    "capabilities": {},
                    "serverInfo": { "name": "peervaultd", "version": env!("CARGO_PKG_VERSION") }
                }
            });
            write_lsp_message(&mut stdout, &reply).await?;
            let root_uri = v["params"]["rootUri"].as_str()
                .or_else(|| v["params"]["workspaceFolders"][0]["uri"].as_str())
                .map(|s| s.trim_start_matches("file://").to_string())
                .or_else(|| v["params"]["rootPath"].as_str().map(String::from));
            match root_uri {
                Some(p) => break PathBuf::from(p),
                None => bail!("initialize carried no workspace root"),
            }
        }
    };

    // Keep answering the LSP session (shutdown/exit) while the daemon runs.
    tokio::spawn(async move {
        loop {
            let Ok(msg) = read_lsp_message(&mut stdin).await else { break };
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&msg) else { continue };
            match v["method"].as_str() {
                Some("shutdown") => {
                    let reply = serde_json::json!({"jsonrpc":"2.0","id":v["id"],"result":null});
                    let _ = write_lsp_message(&mut stdout, &reply).await;
                }
                Some("exit") => std::process::exit(0),
                _ => {}
            }
        }
        // Editor went away — stop syncing.
        std::process::exit(0);
    });

    run(args, Some(root)).await
}

async fn read_lsp_message(r: &mut BufReader<tokio::io::Stdin>) -> Result<Vec<u8>> {
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).await? == 0 {
            bail!("stdin closed");
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            content_length = v.trim().parse()?;
        }
    }
    let mut buf = vec![0u8; content_length];
    r.read_exact(&mut buf).await?;
    Ok(buf)
}

async fn write_lsp_message(w: &mut tokio::io::Stdout, v: &serde_json::Value) -> Result<()> {
    let body = serde_json::to_vec(v)?;
    w.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}
