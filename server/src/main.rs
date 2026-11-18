use std::{net::SocketAddr, path::PathBuf, time::Duration};

use clap::Parser;
use e2ee_chat_server::{AppState, Config, router, serve};

/// Relay and mailbox server for e2ee-chat. It stores only public keys, password-locked
/// key bundles and encrypted blobs; it can't read messages.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// Address to listen on.
    #[arg(long, env = "BIND", default_value = "0.0.0.0")]
    bind: String,
    /// Port to listen on.
    #[arg(long, env = "PORT", default_value_t = 8080)]
    port: u16,
    /// Directory for the SQLite database.
    #[arg(long, env = "DATA_DIR", default_value = "./data")]
    data_dir: PathBuf,
    /// Directory with the built web app (web/dist). Omit to run the API only.
    #[arg(long, env = "WEB_DIR")]
    web_dir: Option<PathBuf>,
    /// Days to keep encrypted messages (so new devices can download history).
    #[arg(long, env = "RETENTION_DAYS", default_value_t = 180)]
    retention_days: i64,
    /// Trust the X-Forwarded-For header (set when running behind a reverse proxy).
    #[arg(long, env = "TRUST_PROXY", default_value_t = false)]
    trust_proxy: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let args = Args::parse();

    let config = Config { retention_days: args.retention_days.max(1), trust_proxy: args.trust_proxy };
    let state = AppState::open(&args.data_dir.join("chat.db"), config)?;

    let pruner = state.clone();
    tokio::spawn(async move {
        loop {
            match pruner.prune() {
                Ok(n @ 1..) => tracing::info!("deleted {n} expired messages"),
                Ok(_) => {}
                Err(e) => tracing::warn!("prune failed: {e:#}"),
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });

    let web_dir = args.web_dir.filter(|d| d.join("index.html").exists());
    if web_dir.is_none() {
        tracing::warn!("no web app directory found; serving websocket API only");
    }
    let addr: SocketAddr = format!("{}:{}", args.bind, args.port).parse()?;
    serve(addr, router(state, web_dir)).await
}
