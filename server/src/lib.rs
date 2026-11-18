//! Blind relay server for e2ee-chat.
//!
//! The server never sees plaintext or private keys. It only knows:
//! - usernames and their *public* keys (directory),
//! - opaque encrypted envelopes, held until the recipient comes online and acks them.
//!
//! Authentication is a challenge/response signed with the user's Ed25519 key, so
//! there are no passwords to store either.

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::get,
};
use axum::http::{HeaderValue, StatusCode, header};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signature, VerifyingKey};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

/// Domain separation prefix for the login challenge signature.
pub const AUTH_CONTEXT: &str = "e2ee-chat-auth-v1:";
/// Largest websocket message accepted (encrypted files are base64 inside JSON).
pub const MAX_MESSAGE_BYTES: usize = 24 * 1024 * 1024;
/// Undelivered envelopes are dropped after this many days.
pub const QUEUE_TTL_DAYS: i64 = 30;
/// Max bytes waiting in one user's offline mailbox.
pub const MAX_MAILBOX_BYTES: i64 = 256 * 1024 * 1024;
/// Max bytes queued for sending to one connected client before it's considered too slow.
const MAX_SESSION_BACKLOG: usize = 64 * 1024 * 1024;
/// Max connections that haven't logged in yet.
const MAX_PENDING_AUTH: usize = 64;
/// Queued envelopes are loaded from the database this many at a time.
const DELIVERY_PAGE: i64 = 32;

/// Content-Security-Policy for the web app. Same as the desktop app's, plus no framing.
const CSP: &str = "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; \
    style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none'; \
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// ---------------------------------------------------------------------------
// Wire protocol (JSON text frames)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    #[serde(rename_all = "camelCase")]
    Register {
        name: String,
        invite: String,
        sign_pk: String,
        enc_pk: String,
        sig: String,
    },
    Login {
        name: String,
        sig: String,
    },
    /// `envelope` is opaque to the server apart from `from` and `keys[].to`.
    Send {
        envelope: Value,
    },
    Ack {
        qids: Vec<i64>,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub name: String,
    pub sign_pk: String,
    pub enc_pk: String,
    pub online: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg<'a> {
    Challenge { nonce: String },
    Welcome { name: &'a str },
    Directory { users: Vec<UserInfo> },
    User { user: UserInfo },
    Presence { name: &'a str, online: bool },
    Deliver { qid: i64, envelope: &'a Value },
    Sent { id: &'a str },
    /// A `send` was rejected; nothing was queued.
    Failed { id: &'a str, message: &'a str },
    Pong,
    Error { message: &'a str },
}

impl ServerMsg<'_> {
    fn json(&self) -> String {
        serde_json::to_string(self).expect("server message serializes")
    }
}

#[derive(Deserialize)]
struct EnvelopeMeta {
    id: String,
    from: String,
    keys: Vec<KeyMeta>,
}

#[derive(Deserialize)]
struct KeyMeta {
    to: String,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Session {
    id: u64,
    /// Each frame carries a permit for its size from `budget`, released once written.
    tx: mpsc::UnboundedSender<(String, OwnedSemaphorePermit)>,
    budget: Arc<Semaphore>,
    /// Ends the session with this message (another login, or too slow to keep up).
    kick: oneshot::Sender<&'static str>,
}

impl Session {
    /// Queues a frame. Returns false if the client is too far behind.
    fn push(&self, text: String) -> bool {
        let Ok(n) = u32::try_from(text.len()) else { return false };
        match self.budget.clone().try_acquire_many_owned(n.max(1)) {
            Ok(permit) => {
                let _ = self.tx.send((text, permit));
                true
            }
            Err(_) => false,
        }
    }
}

pub struct AppState {
    db: Mutex<Connection>,
    online: Mutex<HashMap<String, Session>>,
    invite: String,
    invite_from_config: bool,
    next_session: AtomicU64,
    pending_auth: Arc<Semaphore>,
}

impl AppState {
    pub fn open(db_path: &Path, invite: Option<String>) -> Result<Arc<Self>> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        let conn = Connection::open(db_path)
            .with_context(|| format!("opening database {}", db_path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS users (
                 name TEXT PRIMARY KEY,
                 sign_pk TEXT NOT NULL,
                 enc_pk TEXT NOT NULL,
                 created_at INTEGER NOT NULL DEFAULT (unixepoch())
             );
             CREATE TABLE IF NOT EXISTS queue (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 recipient TEXT NOT NULL,
                 envelope TEXT NOT NULL,
                 size INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL DEFAULT (unixepoch())
             );
             CREATE INDEX IF NOT EXISTS queue_recipient ON queue(recipient, id);
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;

        let has_size: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('queue') WHERE name = 'size'")?
            .exists([])?;
        if !has_size {
            conn.execute_batch(
                "ALTER TABLE queue ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
                 UPDATE queue SET size = length(CAST(envelope AS BLOB));",
            )?;
        }

        let invite = invite.filter(|s| !s.trim().is_empty());
        let invite_from_config = invite.is_some();
        let invite = match invite {
            Some(code) => code.trim().to_string(),
            None => {
                let stored: Option<String> = conn
                    .query_row("SELECT value FROM settings WHERE key='invite'", [], |r| r.get(0))
                    .optional()?;
                match stored {
                    Some(code) => code,
                    None => {
                        let code = random_token(12);
                        conn.execute(
                            "INSERT INTO settings(key, value) VALUES ('invite', ?1)",
                            [&code],
                        )?;
                        code
                    }
                }
            }
        };

        Ok(Arc::new(Self {
            db: Mutex::new(conn),
            online: Mutex::new(HashMap::new()),
            invite,
            invite_from_config,
            next_session: AtomicU64::new(1),
            pending_auth: Arc::new(Semaphore::new(MAX_PENDING_AUTH)),
        }))
    }

    pub fn invite_code(&self) -> &str {
        &self.invite
    }

    /// True if the invite came from configuration (so the operator already knows it).
    pub fn invite_from_config(&self) -> bool {
        self.invite_from_config
    }

    pub fn prune_queue(&self) -> Result<usize> {
        let db = self.db.lock().unwrap();
        Ok(db.execute(
            "DELETE FROM queue WHERE created_at < unixepoch() - ?1",
            [QUEUE_TTL_DAYS * 86_400],
        )?)
    }

    fn user_keys(&self, name: &str) -> Result<Option<(String, String)>> {
        let db = self.db.lock().unwrap();
        Ok(db
            .query_row(
                "SELECT sign_pk, enc_pk FROM users WHERE name = ?1",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    fn directory(&self) -> Result<Vec<UserInfo>> {
        let online: HashSet<String> = self.online.lock().unwrap().keys().cloned().collect();
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare("SELECT name, sign_pk, enc_pk FROM users ORDER BY name")?;
        let users = stmt
            .query_map([], |r| {
                let name: String = r.get(0)?;
                Ok(UserInfo {
                    online: online.contains(&name),
                    name,
                    sign_pk: r.get(1)?,
                    enc_pk: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(users)
    }

    fn mailbox_bytes(&self, name: &str) -> Result<i64> {
        let db = self.db.lock().unwrap();
        Ok(db.query_row("SELECT coalesce(sum(size), 0) FROM queue WHERE recipient = ?1", [name], |r| r.get(0))?)
    }

    fn broadcast(&self, text: &str, except: Option<&str>) {
        let names: Vec<String> = {
            let online = self.online.lock().unwrap();
            online.keys().filter(|n| Some(n.as_str()) != except).cloned().collect()
        };
        for name in names {
            self.send_to(&name, text.to_string());
        }
    }

    /// Sends a frame to a connected user. A client that falls too far behind is
    /// disconnected; it reconnects and picks up the rest from its mailbox.
    fn send_to(&self, name: &str, text: String) {
        let slow = {
            let mut online = self.online.lock().unwrap();
            match online.get(name) {
                Some(s) if !s.push(text) => online.remove(name),
                _ => None,
            }
        };
        if let Some(s) = slow {
            tracing::debug!(user = %name, "client too slow, disconnecting");
            let _ = s.kick.send("Connection too slow, reconnecting");
            self.broadcast(&ServerMsg::Presence { name, online: false }.json(), Some(name));
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

pub fn router(state: Arc<AppState>, web_dir: Option<PathBuf>) -> Router {
    let mut app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state);
    if let Some(dir) = web_dir {
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }
    let set = |name, value: &'static str| {
        SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
    };
    app.layer(set(header::CONTENT_SECURITY_POLICY, CSP))
        .layer(set(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(set(header::REFERRER_POLICY, "no-referrer"))
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> axum::response::Response {
    // Bound the number of sockets sitting in the login handshake.
    let Ok(permit) = state.pending_auth.clone().try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "busy, try again").into_response();
    };
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(e) = handle_socket(socket, state, permit).await {
                tracing::debug!("connection ended: {e:#}");
            }
        })
}

pub async fn serve(addr: SocketAddr, app: Router) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// WebSocket session
// ---------------------------------------------------------------------------

async fn send_text(socket: &mut WebSocket, msg: &ServerMsg<'_>) -> Result<()> {
    socket.send(Message::Text(msg.json().into())).await?;
    Ok(())
}

async fn recv_client(socket: &mut WebSocket) -> Result<Option<ClientMsg>> {
    loop {
        match socket.recv().await {
            None => return Ok(None),
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(Message::Text(t))) => return Ok(Some(serde_json::from_str(t.as_str())?)),
            Some(Ok(Message::Close(_))) => return Ok(None),
            Some(Ok(_)) => continue, // ping/pong/binary
        }
    }
}

/// Names reach other clients as object keys; keep them boring.
const RESERVED_NAMES: &[&str] = &["constructor", "prototype", "hasownproperty", "isprototypeof", "tostring", "valueof"];

fn valid_name(name: &str) -> bool {
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (2..=32).contains(&name.len())
        && name.bytes().next().is_some_and(alnum)
        && name.bytes().all(|b| alnum(b) || b == b'_' || b == b'-' || b == b'.')
        && !RESERVED_NAMES.contains(&name)
}

/// Slows down guessing invite codes and keys.
async fn fail_slowly(socket: &mut WebSocket, message: &'static str) -> Result<()> {
    tokio::time::sleep(Duration::from_secs(1)).await;
    send_text(socket, &ServerMsg::Error { message }).await
}

fn decode_32(s: &str) -> Option<[u8; 32]> {
    B64.decode(s).ok()?.try_into().ok()
}

fn verify_auth(sign_pk: &str, nonce: &str, sig: &str) -> bool {
    let Some(pk) = decode_32(sign_pk).and_then(|b| VerifyingKey::from_bytes(&b).ok()) else {
        return false;
    };
    let Some(sig) = B64
        .decode(sig)
        .ok()
        .and_then(|b| <[u8; 64]>::try_from(b).ok())
        .map(|b| Signature::from_bytes(&b))
    else {
        return false;
    };
    pk.verify_strict(format!("{AUTH_CONTEXT}{nonce}").as_bytes(), &sig).is_ok()
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Runs the auth handshake. Returns the authenticated user name.
async fn authenticate(socket: &mut WebSocket, state: &AppState) -> Result<Option<String>> {
    let nonce = random_token(32);
    send_text(socket, &ServerMsg::Challenge { nonce: nonce.clone() }).await?;

    let reply = tokio::time::timeout(Duration::from_secs(30), recv_client(socket)).await;
    let Ok(Ok(Some(msg))) = reply else {
        return Ok(None);
    };
    let fail = |m: &'static str| ServerMsg::Error { message: m };
    match msg {
        ClientMsg::Register { name, invite, sign_pk, enc_pk, sig } => {
            if !constant_time_eq(invite.trim(), &state.invite) {
                fail_slowly(socket, "Wrong invite code").await?;
                return Ok(None);
            }
            if !valid_name(&name) {
                send_text(socket, &fail("Name must be 2-32 chars (a-z, 0-9, _ . -) and start with a letter or digit"))
                    .await?;
                return Ok(None);
            }
            if decode_32(&enc_pk).is_none() || !verify_auth(&sign_pk, &nonce, &sig) {
                send_text(socket, &fail("Invalid keys or signature")).await?;
                return Ok(None);
            }
            let inserted = {
                let db = state.db.lock().unwrap();
                db.execute(
                    "INSERT OR IGNORE INTO users(name, sign_pk, enc_pk) VALUES (?1, ?2, ?3)",
                    params![name, sign_pk, enc_pk],
                )?
            };
            if inserted == 0 {
                send_text(socket, &fail("That name is already taken")).await?;
                return Ok(None);
            }
            tracing::info!(user = %name, "registered");
            let user = UserInfo { name: name.clone(), sign_pk, enc_pk, online: true };
            state.broadcast(&ServerMsg::User { user }.json(), None);
            Ok(Some(name))
        }
        ClientMsg::Login { name, sig } => match state.user_keys(&name)? {
            Some((sign_pk, _)) if verify_auth(&sign_pk, &nonce, &sig) => Ok(Some(name)),
            _ => {
                fail_slowly(socket, "Unknown user or bad signature").await?;
                Ok(None)
            }
        },
        _ => {
            send_text(socket, &fail("Log in first")).await?;
            Ok(None)
        }
    }
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, permit: OwnedSemaphorePermit) -> Result<()> {
    let me = authenticate(&mut socket, &state).await;
    drop(permit);
    let Some(me) = me? else {
        let _ = socket.send(Message::Close(None)).await;
        return Ok(());
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let (kick, mut kicked) = oneshot::channel();
    let budget = Arc::new(Semaphore::new(MAX_SESSION_BACKLOG));
    let session_id = state.next_session.fetch_add(1, Ordering::Relaxed);
    let old = state
        .online
        .lock()
        .unwrap()
        .insert(me.clone(), Session { id: session_id, tx, budget, kick });
    if let Some(old) = old {
        let _ = old.kick.send("Signed in from another window");
    }

    let result = run_session(&mut socket, &state, &me, &mut rx, &mut kicked).await;

    // Only clean up if we are still the active session for this user.
    let removed = {
        let mut online = state.online.lock().unwrap();
        if online.get(&me).is_some_and(|s| s.id == session_id) {
            online.remove(&me);
            true
        } else {
            false
        }
    };
    if removed {
        state.broadcast(&ServerMsg::Presence { name: &me, online: false }.json(), None);
    }
    result
}

async fn run_session(
    socket: &mut WebSocket,
    state: &AppState,
    me: &str,
    rx: &mut mpsc::UnboundedReceiver<(String, OwnedSemaphorePermit)>,
    kicked: &mut oneshot::Receiver<&'static str>,
) -> Result<()> {
    send_text(socket, &ServerMsg::Welcome { name: me }).await?;
    send_text(socket, &ServerMsg::Directory { users: state.directory()? }).await?;
    state.broadcast(&ServerMsg::Presence { name: me, online: true }.json(), Some(me));

    // Flush anything that arrived while we were offline, a page at a time. Envelopes
    // that arrive meanwhile are both queued and pushed live; the client dedupes them.
    let mut after = 0i64;
    loop {
        let page: Vec<(i64, String)> = {
            let db = state.db.lock().unwrap();
            let mut stmt = db.prepare_cached(
                "SELECT id, envelope FROM queue WHERE recipient = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
            )?;
            stmt.query_map(params![me, after, DELIVERY_PAGE], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let Some(&(last, _)) = page.last() else { break };
        after = last;
        for (qid, env) in page {
            let envelope: Value = serde_json::from_str(&env)?;
            send_text(socket, &ServerMsg::Deliver { qid, envelope: &envelope }).await?;
        }
    }

    loop {
        tokio::select! {
            reason = &mut *kicked => {
                let message = reason.unwrap_or("Disconnected");
                let _ = send_text(socket, &ServerMsg::Error { message }).await;
                let _ = socket.send(Message::Close(None)).await;
                return Ok(());
            },
            out = rx.recv() => match out {
                Some((text, _permit)) => socket.send(Message::Text(text.into())).await?,
                None => return Ok(()),
            },
            msg = recv_client(socket) => {
                let Some(msg) = msg? else { return Ok(()) };
                handle_client_msg(socket, state, me, msg).await?;
            }
        }
    }
}

async fn handle_client_msg(socket: &mut WebSocket, state: &AppState, me: &str, msg: ClientMsg) -> Result<()> {
    match msg {
        ClientMsg::Ping => send_text(socket, &ServerMsg::Pong).await,
        ClientMsg::Ack { qids } => {
            let db = state.db.lock().unwrap();
            let mut stmt = db.prepare_cached("DELETE FROM queue WHERE id = ?1 AND recipient = ?2")?;
            for qid in qids {
                stmt.execute(params![qid, me])?;
            }
            Ok(())
        }
        ClientMsg::Send { envelope } => {
            let meta: EnvelopeMeta = match serde_json::from_value(envelope.clone()) {
                Ok(m) => m,
                Err(_) => return send_text(socket, &ServerMsg::Error { message: "Malformed envelope" }).await,
            };
            let id = meta.id.as_str();
            let failed = |message| ServerMsg::Failed { id, message };
            if meta.from != me {
                return send_text(socket, &failed("Envelope sender mismatch")).await;
            }
            let recipients: HashSet<&str> = meta.keys.iter().map(|k| k.to.as_str()).filter(|n| *n != me).collect();
            let env_text = serde_json::to_string(&envelope)?;
            let size = env_text.len() as i64;
            for r in &recipients {
                if state.user_keys(r)?.is_none() {
                    return send_text(socket, &failed("Unknown recipient")).await;
                }
                if state.mailbox_bytes(r)? + size > MAX_MAILBOX_BYTES {
                    return send_text(socket, &failed("A recipient's mailbox is full. Try again after they come online."))
                        .await;
                }
            }
            let mut deliveries = Vec::with_capacity(recipients.len());
            {
                let mut db = state.db.lock().unwrap();
                let tx = db.transaction()?;
                {
                    let mut stmt = tx.prepare_cached("INSERT INTO queue(recipient, envelope, size) VALUES (?1, ?2, ?3)")?;
                    for r in &recipients {
                        stmt.execute(params![r, env_text, size])?;
                        deliveries.push((*r, tx.last_insert_rowid()));
                    }
                }
                tx.commit()?;
            }
            for (r, qid) in deliveries {
                state.send_to(r, ServerMsg::Deliver { qid, envelope: &envelope }.json());
            }
            send_text(socket, &ServerMsg::Sent { id: &meta.id }).await
        }
        ClientMsg::Register { .. } | ClientMsg::Login { .. } => {
            send_text(socket, &ServerMsg::Error { message: "Already logged in" }).await
        }
    }
}

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS randomness available");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}
