use std::{net::SocketAddr, path::PathBuf, time::Duration};

use clap::Parser;
use e2ee_chat_server::{AppState, router, serve};

/// Blind relay server for e2ee-chat. It stores only public keys and encrypted blobs.
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
    /// Invite code required to create an account. Generated and stored if not set.
    #[arg(long, env = "INVITE_CODE")]
    invite: Option<String>,
    /// Directory with the built web app (web/dist). Omit to run the API only.
    #[arg(long, env = "WEB_DIR")]
    web_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let args = Args::parse();

    let state = AppState::open(&args.data_dir.join("chat.db"), args.invite)?;
    if state.invite_from_config() {
        tracing::info!("using the invite code from INVITE_CODE");
    } else {
        tracing::info!("invite code: {}", state.invite_code());
    }

    let pruner = state.clone();
    tokio::spawn(async move {
        loop {
            if let Ok(n @ 1..) = pruner.prune_queue() {
                tracing::info!("dropped {n} expired undelivered messages");
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
