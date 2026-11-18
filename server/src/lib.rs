//! Blind relay and mailbox server for e2ee-chat.
//!
//! The server never sees plaintext or private keys. It stores:
//! - accounts: username, public keys, and the user's private keys *encrypted on
//!   their device* with a key derived from their password (the server never gets
//!   the password or that key, only a separate hash used to log in),
//! - who is friends with whom, and pending friend requests,
//! - opaque encrypted envelopes, kept for a retention period so every device of
//!   a user can download its history,
//! - an opaque encrypted "vault" per user (contact pins, groups) for syncing devices.

use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::{
        ConnectInfo, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

/// Largest websocket message accepted (encrypted files are base64 inside JSON).
pub const MAX_MESSAGE_BYTES: usize = 15 * 1024 * 1024;
/// Max bytes of messages one user can have stored (sent within the retention period).
pub const MAX_USER_STORAGE: i64 = 512 * 1024 * 1024;
/// Max bytes queued for sending to one connected client before it's considered too slow.
const MAX_SESSION_BACKLOG: usize = 64 * 1024 * 1024;
/// Max connections that haven't logged in yet.
const MAX_PENDING_AUTH: usize = 64;
/// Max connections per IP that haven't logged in yet.
const MAX_PENDING_AUTH_PER_IP: u32 = 8;
/// Max connected devices per user; the oldest is disconnected beyond this.
const MAX_SESSIONS_PER_USER: usize = 10;
/// Stored envelope ids are fetched this many at a time when a device catches up.
const SYNC_PAGE: i64 = 256;
const MAX_VAULT_BYTES: usize = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES: usize = 4096;
const MAX_RECIPIENTS: usize = 256;
const MAX_PENDING_REQUESTS: i64 = 100;
/// Signals (typing indicators) are tiny, and limited per session.
const MAX_SIGNAL_BYTES: usize = 8 * 1024;
const SIGNAL_INTERVAL: Duration = Duration::from_millis(500);
/// Sessions (signed-in devices) unused for this long are deleted.
const SESSION_IDLE_DAYS: i64 = 180;
/// User IDs: 8 chars of Crockford base32 (no I, L, O, U).
const ID_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Content-Security-Policy for the web app. Same as the desktop app's, plus no framing.
const CSP: &str = "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; \
    style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none'; \
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

#[derive(Debug, Clone)]
pub struct Config {
    /// Stored messages are deleted after this many days.
    pub retention_days: i64,
    /// Take the client IP from the last X-Forwarded-For entry (behind a reverse proxy).
    pub trust_proxy: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { retention_days: 180, trust_proxy: false }
    }
}

// ---------------------------------------------------------------------------
// Wire protocol (JSON text frames)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    /// Before sign-in: salt for a username. When signed in: own salt (for password change).
    Prelogin {
        #[serde(default)]
        req: u64,
        #[serde(default)]
        username: String,
    },
    #[serde(rename_all = "camelCase")]
    Register {
        username: String,
        salt: String,
        auth_key: String,
        sign_pk: String,
        enc_pk: String,
        bundle: String,
    },
    #[serde(rename_all = "camelCase")]
    Login {
        username: String,
        auth_key: String,
        #[serde(default)]
        cursor: i64,
    },
    Resume {
        token: String,
        #[serde(default)]
        cursor: i64,
    },
    FriendRequest {
        #[serde(default)]
        req: u64,
        id: String,
    },
    FriendAccept {
        #[serde(default)]
        req: u64,
        id: String,
    },
    FriendDecline {
        #[serde(default)]
        req: u64,
        id: String,
    },
    FriendRemove {
        #[serde(default)]
        req: u64,
        id: String,
    },
    Lookup {
        #[serde(default)]
        req: u64,
        ids: Vec<String>,
    },
    /// `envelope` is opaque to the server apart from `id`, `from` and `keys[].to`.
    Send {
        envelope: Value,
    },
    /// Like `Send`, but not stored: only relayed to recipients that are online right now
    /// (typing indicators). Dropped silently when over the size or rate limit.
    Signal {
        envelope: Value,
    },
    VaultPut {
        #[serde(default)]
        req: u64,
        vault: String,
    },
    #[serde(rename_all = "camelCase")]
    Password {
        #[serde(default)]
        req: u64,
        auth_key: String,
        new_salt: String,
        new_auth_key: String,
        bundle: String,
    },
    Logout,
    Ping,
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

fn ok(req: u64) -> String {
    json!({"type": "ok", "req": req}).to_string()
}

fn err(req: u64, message: &str) -> String {
    json!({"type": "error", "req": req, "message": message}).to_string()
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct Session {
    id: u64,
    /// Each frame carries a permit for its size from `budget`, released once written.
    tx: mpsc::UnboundedSender<(String, OwnedSemaphorePermit)>,
    budget: Arc<Semaphore>,
    /// Ends the session with this message (too slow to keep up).
    kick: Option<oneshot::Sender<&'static str>>,
}

impl Session {
    /// Queues a frame. Returns false if the client is too far behind.
    fn push(&self, text: &str) -> bool {
        let Ok(n) = u32::try_from(text.len()) else { return false };
        match self.budget.clone().try_acquire_many_owned(n.max(1)) {
            Ok(permit) => {
                let _ = self.tx.send((text.to_string(), permit));
                true
            }
            Err(_) => false,
        }
    }
}

/// Fixed-window counter per IP address.
struct Limiter {
    hits: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    max: u32,
    window: Duration,
}

impl Limiter {
    fn new(max: u32, window: Duration) -> Self {
        Self { hits: Mutex::new(HashMap::new()), max, window }
    }

    fn allowed(&self, ip: IpAddr) -> bool {
        let hits = self.hits.lock().unwrap();
        match hits.get(&ip) {
            Some((n, start)) if start.elapsed() < self.window => *n < self.max,
            _ => true,
        }
    }

    fn hit(&self, ip: IpAddr) {
        let mut hits = self.hits.lock().unwrap();
        if hits.len() > 10_000 {
            hits.retain(|_, (_, start)| start.elapsed() < self.window);
        }
        let e = hits.entry(ip).or_insert((0, Instant::now()));
        if e.1.elapsed() >= self.window {
            *e = (0, Instant::now());
        }
        e.0 += 1;
    }
}

pub struct AppState {
    db: Mutex<Connection>,
    /// Connected devices per user ID.
    online: Mutex<HashMap<String, Vec<Session>>>,
    config: Config,
    /// Server secret used to make fake salts for unknown usernames.
    secret: String,
    next_session: AtomicU64,
    pending_auth: Arc<Semaphore>,
    pending_per_ip: Mutex<HashMap<IpAddr, u32>>,
    /// Held from storing a message until it's queued for every recipient, so
    /// live deliveries always arrive in seq order.
    send_order: Mutex<()>,
    auth_failures: Limiter,
    registrations: Limiter,
}

struct Account {
    id: String,
    username: String,
    salt: String,
    auth_hash: Vec<u8>,
    bundle: String,
}

impl AppState {
    pub fn open(db_path: &Path, config: Config) -> Result<Arc<Self>> {
        if let Some(dir) = db_path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        let conn = Connection::open(db_path)
            .with_context(|| format!("opening database {}", db_path.display()))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             -- tables of the earlier invite-only version
             DROP TABLE IF EXISTS queue;
             DROP TABLE IF EXISTS users;
             CREATE TABLE IF NOT EXISTS accounts (
                 id TEXT PRIMARY KEY,
                 username TEXT NOT NULL UNIQUE,
                 sign_pk TEXT NOT NULL,
                 enc_pk TEXT NOT NULL,
                 salt TEXT NOT NULL,
                 auth_hash BLOB NOT NULL,
                 bundle TEXT NOT NULL,
                 vault TEXT,
                 created_at INTEGER NOT NULL DEFAULT (unixepoch())
             );
             CREATE TABLE IF NOT EXISTS sessions (
                 token_hash BLOB PRIMARY KEY,
                 user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                 last_used INTEGER NOT NULL DEFAULT (unixepoch())
             );
             CREATE TABLE IF NOT EXISTS friends (
                 a TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 b TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 PRIMARY KEY (a, b)
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS friend_requests (
                 from_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 to_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                 PRIMARY KEY (from_id, to_id)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests(to_id);
             CREATE TABLE IF NOT EXISTS messages (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 sender TEXT NOT NULL,
                 envelope TEXT NOT NULL,
                 size INTEGER NOT NULL,
                 created_at INTEGER NOT NULL DEFAULT (unixepoch())
             );
             -- Usernames keep their casing for display but are unique ignoring case.
             CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_nocase ON accounts(username COLLATE NOCASE);
             DROP INDEX IF EXISTS messages_sender;
             CREATE INDEX IF NOT EXISTS messages_sender_size ON messages(sender, size);
             CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
             CREATE TABLE IF NOT EXISTS inbox (
                 user_id TEXT NOT NULL,
                 msg_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                 PRIMARY KEY (user_id, msg_id)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS inbox_msg ON inbox(msg_id);
             CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;

        let secret: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'secret'", [], |r| r.get(0))
            .optional()?;
        let secret = match secret {
            Some(s) => s,
            None => {
                let s = random_token(32);
                conn.execute("INSERT INTO settings(key, value) VALUES ('secret', ?1)", [&s])?;
                s
            }
        };

        Ok(Arc::new(Self {
            db: Mutex::new(conn),
            online: Mutex::new(HashMap::new()),
            config,
            secret,
            next_session: AtomicU64::new(1),
            pending_auth: Arc::new(Semaphore::new(MAX_PENDING_AUTH)),
            pending_per_ip: Mutex::new(HashMap::new()),
            send_order: Mutex::new(()),
            auth_failures: Limiter::new(20, Duration::from_secs(600)),
            registrations: Limiter::new(10, Duration::from_secs(3600)),
        }))
    }

    /// Deletes expired messages and idle sessions. Returns the number of messages deleted.
    pub fn prune(&self) -> Result<usize> {
        let db = self.db.lock().unwrap();
        let n = db.execute(
            "DELETE FROM messages WHERE created_at < unixepoch() - ?1",
            [self.config.retention_days * 86_400],
        )?;
        db.execute(
            "DELETE FROM sessions WHERE last_used < unixepoch() - ?1",
            [SESSION_IDLE_DAYS * 86_400],
        )?;
        db.execute("DELETE FROM friend_requests WHERE created_at < unixepoch() - ?1", [90 * 86_400])?;
        Ok(n)
    }

    fn account_by_username(&self, username: &str) -> Result<Option<Account>> {
        let db = self.db.lock().unwrap();
        Ok(db
            .query_row(
                "SELECT id, username, salt, auth_hash, bundle FROM accounts WHERE username = ?1 COLLATE NOCASE",
                [username],
                |r| {
                    Ok(Account {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        salt: r.get(2)?,
                        auth_hash: r.get(3)?,
                        bundle: r.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    fn username_of(&self, id: &str) -> Result<Option<String>> {
        let db = self.db.lock().unwrap();
        Ok(db.query_row("SELECT username FROM accounts WHERE id = ?1", [id], |r| r.get(0)).optional()?)
    }

    fn vault_of(&self, id: &str) -> Result<Option<String>> {
        let db = self.db.lock().unwrap();
        Ok(db.query_row("SELECT vault FROM accounts WHERE id = ?1", [id], |r| r.get(0))?)
    }

    /// Public info for the given user IDs (unknown IDs are skipped).
    /// `with_presence`: include online status (only for friends).
    fn users(&self, ids: &[String], with_presence: bool) -> Result<Vec<Value>> {
        let online: HashSet<String> =
            if with_presence { self.online.lock().unwrap().keys().cloned().collect() } else { HashSet::new() };
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare_cached("SELECT id, username, sign_pk, enc_pk FROM accounts WHERE id = ?1")?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(v) = stmt
                .query_row([id], |r| {
                    let id: String = r.get(0)?;
                    Ok(json!({"id": id, "name": r.get::<_, String>(1)?, "signPk": r.get::<_, String>(2)?,
                              "encPk": r.get::<_, String>(3)?, "online": online.contains(&id)}))
                })
                .optional()?
            {
                out.push(v);
            }
        }
        Ok(out)
    }

    fn friend_ids(&self, id: &str) -> Result<Vec<String>> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare_cached("SELECT b FROM friends WHERE a = ?1")?;
        let ids = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    fn are_friends(&self, a: &str, b: &str) -> Result<bool> {
        let db = self.db.lock().unwrap();
        Ok(db.query_row("SELECT 1 FROM friends WHERE a = ?1 AND b = ?2", [a, b], |_| Ok(())).optional()?.is_some())
    }

    /// Friends (with keys and presence) plus pending requests both ways.
    fn friends_snapshot(&self, id: &str) -> Result<String> {
        let friends = self.users(&self.friend_ids(id)?, true)?;
        let db = self.db.lock().unwrap();
        let requests = |sql: &str| -> Result<Vec<Value>> {
            let mut stmt = db.prepare_cached(sql)?;
            let rows = stmt
                .query_map([id], |r| {
                    Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                              "ts": r.get::<_, i64>(2)? * 1000}))
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        };
        let incoming = requests(
            "SELECT r.from_id, a.username, r.created_at FROM friend_requests r
             JOIN accounts a ON a.id = r.from_id WHERE r.to_id = ?1 ORDER BY r.created_at",
        )?;
        let outgoing = requests(
            "SELECT r.to_id, a.username, r.created_at FROM friend_requests r
             JOIN accounts a ON a.id = r.to_id WHERE r.from_id = ?1 ORDER BY r.created_at",
        )?;
        Ok(json!({"type": "friends", "friends": friends, "incoming": incoming, "outgoing": outgoing}).to_string())
    }

    fn push_friends_snapshot(&self, id: &str) {
        if !self.online.lock().unwrap().contains_key(id) {
            return;
        }
        match self.friends_snapshot(id) {
            Ok(text) => self.push_user(id, &text, None),
            Err(e) => tracing::warn!("friends snapshot failed: {e:#}"),
        }
    }

    /// Sends a frame to every connected device of a user (optionally except one session).
    /// A device that falls too far behind is disconnected; it reconnects and catches up.
    fn push_user(&self, user: &str, text: &str, except: Option<u64>) {
        let (slow, now_offline) = {
            let mut online = self.online.lock().unwrap();
            let Some(list) = online.get_mut(user) else { return };
            let mut slow = Vec::new();
            let mut i = 0;
            while i < list.len() {
                if Some(list[i].id) == except || list[i].push(text) {
                    i += 1;
                } else {
                    slow.push(list.swap_remove(i));
                }
            }
            let now_offline = list.is_empty();
            if now_offline {
                online.remove(user);
            }
            (slow, now_offline)
        };
        for mut s in slow {
            tracing::debug!(user, "client too slow, disconnecting");
            if let Some(kick) = s.kick.take() {
                let _ = kick.send("Connection too slow, reconnecting");
            }
        }
        if now_offline {
            self.presence_changed(user, false);
        }
    }

    /// Disconnects a user's devices (except one).
    fn kick_user(&self, user: &str, except: Option<u64>, reason: &'static str) {
        let mut online = self.online.lock().unwrap();
        if let Some(list) = online.get_mut(user) {
            for s in list.iter_mut().filter(|s| Some(s.id) != except) {
                if let Some(k) = s.kick.take() {
                    let _ = k.send(reason);
                }
            }
        }
    }

    fn presence_changed(&self, user: &str, online: bool) {
        let text = json!({"type": "presence", "id": user, "online": online}).to_string();
        for friend in self.friend_ids(user).unwrap_or_default() {
            self.push_user(&friend, &text, None);
        }
    }

    fn fake_salt(&self, username: &str) -> String {
        let h = Sha256::new()
            .chain_update(self.secret.as_bytes())
            .chain_update(b"/salt/")
            .chain_update(username.to_ascii_lowercase().as_bytes())
            .finalize();
        B64.encode(&h[..16])
    }

    fn create_session(&self, user_id: &str) -> Result<String> {
        let token = random_token(32);
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO sessions(token_hash, user_id) VALUES (?1, ?2)",
            params![sha256(token.as_bytes()), user_id],
        )?;
        Ok(token)
    }

    fn resume_session(&self, token: &str) -> Result<Option<(String, String)>> {
        let db = self.db.lock().unwrap();
        let hash = sha256(token.as_bytes());
        let row: Option<(String, String)> = db
            .query_row(
                "SELECT a.id, a.username FROM sessions s JOIN accounts a ON a.id = s.user_id WHERE s.token_hash = ?1",
                [&hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if row.is_some() {
            db.execute("UPDATE sessions SET last_used = unixepoch() WHERE token_hash = ?1", [&hash])?;
        }
        Ok(row)
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
    let set = |name, value: &'static str| SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value));
    app.layer(set(header::CONTENT_SECURITY_POLICY, CSP))
        .layer(set(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(set(header::REFERRER_POLICY, "no-referrer"))
}

/// The address used for rate limits. X-Forwarded-For is only believed when
/// TRUST_PROXY is set and the connection comes from a local/private address
/// (the proxy); its last entry is the one the proxy added.
fn client_ip(state: &AppState, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let peer_ip = canonical_ip(peer.ip());
    let from_proxy = match peer_ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    };
    let mut ip = peer_ip;
    if state.config.trust_proxy && from_proxy {
        let last = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .last();
        if let Some(Ok(forwarded)) = last.map(|s| s.trim().parse::<IpAddr>()) {
            ip = canonical_ip(forwarded);
        }
    }
    limit_key(ip)
}

fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    }
}

/// IPv6 users get a whole /64, so limits apply per /64 rather than per address.
fn limit_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => {
            let s = v6.segments();
            IpAddr::V6(std::net::Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        v4 => v4,
    }
}

/// A connection in the login handshake: holds a global slot and a per-IP slot.
struct PendingAuth {
    _permit: OwnedSemaphorePermit,
    state: Arc<AppState>,
    ip: IpAddr,
}

impl PendingAuth {
    fn new(state: &Arc<AppState>, ip: IpAddr) -> Option<Self> {
        let permit = state.pending_auth.clone().try_acquire_owned().ok()?;
        let mut per_ip = state.pending_per_ip.lock().unwrap();
        let n = per_ip.entry(ip).or_insert(0);
        if *n >= MAX_PENDING_AUTH_PER_IP {
            return None;
        }
        *n += 1;
        Some(Self { _permit: permit, state: state.clone(), ip })
    }
}

impl Drop for PendingAuth {
    fn drop(&mut self) {
        let mut per_ip = self.state.pending_per_ip.lock().unwrap();
        if let Some(n) = per_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                per_ip.remove(&self.ip);
            }
        }
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    // Bound the number of sockets sitting in the login handshake.
    let ip = client_ip(&state, peer, &headers);
    let Some(permit) = PendingAuth::new(&state, ip) else {
        return (StatusCode::SERVICE_UNAVAILABLE, "busy, try again").into_response();
    };
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(e) = handle_socket(socket, state, permit, ip).await {
                tracing::debug!("connection ended: {e:#}");
            }
        })
}

pub async fn serve(addr: SocketAddr, app: Router) -> Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{}", listener.local_addr()?);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn valid_username(name: &str) -> bool {
    let alnum = |b: u8| b.is_ascii_alphanumeric();
    (3..=24).contains(&name.len())
        && name.bytes().next().is_some_and(alnum)
        && name.bytes().all(|b| alnum(b) || b == b'_' || b == b'.')
}

pub fn valid_user_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|b| ID_ALPHABET.contains(&b))
}

fn decode_len(s: &str, len: usize) -> Option<Vec<u8>> {
    B64.decode(s).ok().filter(|b| b.len() == len)
}

fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn auth_matches(account: &Account, auth_key: &str) -> bool {
    match decode_len(auth_key, 32) {
        Some(key) => constant_time_eq(&sha256(&key), &account.auth_hash),
        None => false,
    }
}

fn new_user_id() -> String {
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).expect("OS randomness available");
    buf.iter().map(|b| ID_ALPHABET[(b & 31) as usize] as char).collect()
}

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS randomness available");
    B64URL.encode(buf)
}

// ---------------------------------------------------------------------------
// WebSocket session
// ---------------------------------------------------------------------------

async fn send_text(socket: &mut WebSocket, text: String) -> Result<()> {
    socket.send(Message::Text(text.into())).await?;
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

struct Authed {
    id: String,
    username: String,
    cursor: i64,
    /// Hash of this device's session token (deleted on logout).
    token_hash: Vec<u8>,
    ip: IpAddr,
    /// When this session last relayed a signal (rate limit).
    last_signal: Mutex<Option<Instant>>,
    /// Sent with the welcome message: token (new sessions) and locked keys (login).
    welcome: Value,
}

/// Slows down password guessing, and counts the failure against the IP.
async fn fail_auth(socket: &mut WebSocket, state: &AppState, ip: IpAddr, message: &str) -> Result<()> {
    state.auth_failures.hit(ip);
    tokio::time::sleep(Duration::from_secs(1)).await;
    send_text(socket, err(0, message)).await
}

/// Runs the login handshake. Returns the authenticated user.
async fn authenticate(socket: &mut WebSocket, state: &AppState, ip: IpAddr) -> Result<Option<Authed>> {
    let start = tokio::time::Instant::now();
    for i in 0..5 {
        // The first message must come quickly; the whole handshake within a minute.
        let deadline = start + Duration::from_secs(if i == 0 { 10 } else { 60 });
        let Ok(Ok(Some(msg))) = tokio::time::timeout_at(deadline, recv_client(socket)).await else {
            return Ok(None);
        };
        if !state.auth_failures.allowed(ip) {
            send_text(socket, err(0, "Too many failed attempts. Try again in a few minutes.")).await?;
            return Ok(None);
        }
        match msg {
            ClientMsg::Prelogin { username, .. } => {
                let salt = match state.account_by_username(&username)? {
                    Some(a) => a.salt,
                    None => state.fake_salt(&username),
                };
                send_text(socket, json!({"type": "prelogin", "salt": salt}).to_string()).await?;
            }
            ClientMsg::Register { username, salt, auth_key, sign_pk, enc_pk, bundle } => {
                if !valid_username(&username) {
                    send_text(socket, err(0, "Username must be 3-24 characters: letters, digits, _ and .")).await?;
                    return Ok(None);
                }
                let keys_ok = decode_len(&salt, 16).is_some()
                    && decode_len(&sign_pk, 32).is_some()
                    && decode_len(&enc_pk, 32).is_some()
                    && bundle.len() <= MAX_BUNDLE_BYTES;
                let Some(auth) = decode_len(&auth_key, 32).filter(|_| keys_ok) else {
                    send_text(socket, err(0, "Invalid registration data")).await?;
                    return Ok(None);
                };
                if !state.registrations.allowed(ip) {
                    send_text(socket, err(0, "Too many new accounts from your network. Try again later.")).await?;
                    return Ok(None);
                }
                let id = {
                    let db = state.db.lock().unwrap();
                    let mut created = None;
                    for _ in 0..5 {
                        let id = new_user_id();
                        let n = db.execute(
                            "INSERT INTO accounts(id, username, sign_pk, enc_pk, salt, auth_hash, bundle)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING",
                            params![id, username, sign_pk, enc_pk, salt, sha256(&auth), bundle],
                        )?;
                        if n == 1 {
                            created = Some(id);
                            break;
                        }
                        let taken: bool = db
                            .query_row("SELECT 1 FROM accounts WHERE username = ?1 COLLATE NOCASE", [&username], |_| Ok(()))
                            .optional()?
                            .is_some();
                        if taken {
                            break;
                        }
                    }
                    created
                };
                let Some(id) = id else {
                    send_text(socket, err(0, "That username is taken")).await?;
                    return Ok(None);
                };
                state.registrations.hit(ip);
                tracing::info!(user = %id, "registered");
                let token = state.create_session(&id)?;
                let token_hash = sha256(token.as_bytes());
                return Ok(Some(Authed { id, username, cursor: 0, token_hash, ip, last_signal: Mutex::new(None), welcome: json!({"token": token}) }));
            }
            ClientMsg::Login { username, auth_key, cursor } => {
                let account = state.account_by_username(&username)?;
                let Some(a) = account.filter(|a| auth_matches(a, &auth_key)) else {
                    fail_auth(socket, state, ip, "Wrong username or password").await?;
                    return Ok(None);
                };
                let token = state.create_session(&a.id)?;
                let token_hash = sha256(token.as_bytes());
                let welcome = json!({"token": token, "bundle": a.bundle, "salt": a.salt});
                return Ok(Some(Authed { id: a.id, username: a.username, cursor, token_hash, ip, last_signal: Mutex::new(None), welcome }));
            }
            ClientMsg::Resume { token, cursor } => {
                let Some((id, username)) = state.resume_session(&token)? else {
                    fail_auth(socket, state, ip, "Session expired. Sign in again.").await?;
                    return Ok(None);
                };
                let token_hash = sha256(token.as_bytes());
                return Ok(Some(Authed { id, username, cursor, token_hash, ip, last_signal: Mutex::new(None), welcome: json!({}) }));
            }
            _ => {
                send_text(socket, err(0, "Sign in first")).await?;
                return Ok(None);
            }
        }
    }
    Ok(None)
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, permit: PendingAuth, ip: IpAddr) -> Result<()> {
    let authed = authenticate(&mut socket, &state, ip).await;
    drop(permit);
    let Some(me) = authed? else {
        let _ = socket.send(Message::Close(None)).await;
        return Ok(());
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let (kick, mut kicked) = oneshot::channel();
    let budget = Arc::new(Semaphore::new(MAX_SESSION_BACKLOG));
    let session_id = state.next_session.fetch_add(1, Ordering::Relaxed);
    let came_online = {
        let mut online = state.online.lock().unwrap();
        let list = online.entry(me.id.clone()).or_default();
        if list.len() >= MAX_SESSIONS_PER_USER {
            let mut oldest = list.remove(0);
            if let Some(k) = oldest.kick.take() {
                let _ = k.send("Signed in on too many devices at once");
            }
        }
        list.push(Session { id: session_id, tx, budget, kick: Some(kick) });
        list.len() == 1
    };
    if came_online {
        state.presence_changed(&me.id, true);
    }

    let result = run_session(&mut socket, &state, &me, session_id, &mut rx, &mut kicked).await;

    let went_offline = {
        let mut online = state.online.lock().unwrap();
        match online.get_mut(&me.id) {
            Some(list) => {
                let before = list.len();
                list.retain(|s| s.id != session_id);
                let removed = list.len() < before;
                if list.is_empty() {
                    online.remove(&me.id);
                }
                removed && !online.contains_key(&me.id)
            }
            None => false,
        }
    };
    if went_offline {
        state.presence_changed(&me.id, false);
    }
    result
}

async fn run_session(
    socket: &mut WebSocket,
    state: &AppState,
    me: &Authed,
    session_id: u64,
    rx: &mut mpsc::UnboundedReceiver<(String, OwnedSemaphorePermit)>,
    kicked: &mut oneshot::Receiver<&'static str>,
) -> Result<()> {
    let mut welcome = me.welcome.clone();
    welcome["type"] = json!("welcome");
    welcome["me"] = json!({"id": me.id, "username": me.username});
    welcome["vault"] = json!(state.vault_of(&me.id)?);
    send_text(socket, welcome.to_string()).await?;
    send_text(socket, state.friends_snapshot(&me.id)?).await?;

    // Catch up on everything stored since this device's cursor, a page at a time.
    // Envelopes that arrive meanwhile are queued on `rx`; the client skips any
    // with a seq it has already seen.
    let mut after = me.cursor.max(0);
    loop {
        let page: Vec<i64> = {
            let db = state.db.lock().unwrap();
            let mut stmt = db.prepare_cached(
                "SELECT msg_id FROM inbox WHERE user_id = ?1 AND msg_id > ?2 ORDER BY msg_id LIMIT ?3",
            )?;
            stmt.query_map(params![me.id, after, SYNC_PAGE], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
        };
        let Some(&last) = page.last() else { break };
        after = last;
        // One envelope in memory at a time (they can be several MB each).
        for seq in page {
            let env: Option<String> = {
                let db = state.db.lock().unwrap();
                db.query_row("SELECT envelope FROM messages WHERE id = ?1", [seq], |r| r.get(0)).optional()?
            };
            if let Some(env) = env {
                send_text(socket, format!(r#"{{"type":"deliver","seq":{seq},"envelope":{env}}}"#)).await?;
            }
        }
    }
    send_text(socket, json!({"type": "synced", "seq": after}).to_string()).await?;

    loop {
        tokio::select! {
            reason = &mut *kicked => {
                let message = reason.unwrap_or("Disconnected");
                let _ = send_text(socket, err(0, message)).await;
                let _ = socket.send(Message::Close(None)).await;
                return Ok(());
            },
            out = rx.recv() => match out {
                Some((text, _permit)) => socket.send(Message::Text(text.into())).await?,
                None => return Ok(()),
            },
            msg = recv_client(socket) => {
                let Some(msg) = msg? else { return Ok(()) };
                if !handle_client_msg(socket, state, me, session_id, msg).await? {
                    let _ = socket.send(Message::Close(None)).await;
                    return Ok(());
                }
            }
        }
    }
}

/// Handles one message from a signed-in client. Returns false to end the session.
async fn handle_client_msg(
    socket: &mut WebSocket,
    state: &AppState,
    me: &Authed,
    session_id: u64,
    msg: ClientMsg,
) -> Result<bool> {
    let my = me.id.as_str();
    match msg {
        ClientMsg::Ping => send_text(socket, json!({"type": "pong"}).to_string()).await?,

        ClientMsg::FriendRequest { req, id } => {
            let id: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase();
            let reply = friend_request(state, my, &id)?;
            send_text(socket, reply.map_or_else(|e| err(req, e), |()| ok(req))).await?;
        }
        ClientMsg::FriendAccept { req, id } => {
            let accepted = {
                let mut db = state.db.lock().unwrap();
                let tx = db.transaction()?;
                let n = tx.execute("DELETE FROM friend_requests WHERE from_id = ?1 AND to_id = ?2", [&id, my])?;
                if n == 1 {
                    tx.execute("DELETE FROM friend_requests WHERE from_id = ?1 AND to_id = ?2", [my, &id])?;
                    tx.execute("INSERT OR IGNORE INTO friends(a, b) VALUES (?1, ?2), (?2, ?1)", [my, &id])?;
                }
                tx.commit()?;
                n == 1
            };
            if accepted {
                state.push_friends_snapshot(my);
                state.push_friends_snapshot(&id);
                send_text(socket, ok(req)).await?;
            } else {
                send_text(socket, err(req, "That friend request no longer exists")).await?;
            }
        }
        ClientMsg::FriendDecline { req, id } => {
            {
                let db = state.db.lock().unwrap();
                db.execute(
                    "DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)",
                    [my, &id],
                )?;
            }
            state.push_friends_snapshot(my);
            state.push_friends_snapshot(&id);
            send_text(socket, ok(req)).await?;
        }
        ClientMsg::FriendRemove { req, id } => {
            {
                let db = state.db.lock().unwrap();
                db.execute("DELETE FROM friends WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)", [my, &id])?;
            }
            state.push_friends_snapshot(my);
            state.push_friends_snapshot(&id);
            send_text(socket, ok(req)).await?;
        }

        ClientMsg::Lookup { req, ids } => {
            let ids: Vec<String> = ids.into_iter().filter(|i| valid_user_id(i)).take(MAX_RECIPIENTS).collect();
            let users = state.users(&ids, false)?;
            send_text(socket, json!({"type": "users", "req": req, "users": users}).to_string()).await?;
        }

        ClientMsg::Send { envelope } => {
            let meta: EnvelopeMeta = match serde_json::from_value(envelope.clone()) {
                Ok(m) => m,
                Err(_) => {
                    send_text(socket, err(0, "Malformed envelope")).await?;
                    return Ok(true);
                }
            };
            let failed = |message: &str| json!({"type": "failed", "id": meta.id, "message": message}).to_string();
            if meta.from != my {
                send_text(socket, failed("Envelope sender mismatch")).await?;
                return Ok(true);
            }
            let recipients: HashSet<&str> = meta.keys.iter().map(|k| k.to.as_str()).collect();
            if recipients.is_empty() || recipients.len() > MAX_RECIPIENTS || !recipients.iter().all(|r| valid_user_id(r)) {
                send_text(socket, failed("Invalid recipients")).await?;
                return Ok(true);
            }
            let env_text = serde_json::to_string(&envelope)?;
            let size = env_text.len() as i64;
            let _order = state.send_order.lock().unwrap();
            let seq = {
                let mut db = state.db.lock().unwrap();
                let tx = db.transaction()?;
                let used: i64 =
                    tx.query_row("SELECT coalesce(sum(size), 0) FROM messages WHERE sender = ?1", [my], |r| r.get(0))?;
                if used + size > MAX_USER_STORAGE {
                    None
                } else {
                    let mut known = 0;
                    {
                        let mut stmt = tx.prepare_cached("SELECT 1 FROM accounts WHERE id = ?1")?;
                        for r in &recipients {
                            if stmt.exists([r])? {
                                known += 1;
                            }
                        }
                    }
                    if known != recipients.len() {
                        Some(Err("Unknown recipient"))
                    } else {
                        tx.execute(
                            "INSERT INTO messages(sender, envelope, size) VALUES (?1, ?2, ?3)",
                            params![my, env_text, size],
                        )?;
                        let seq = tx.last_insert_rowid();
                        {
                            let mut stmt = tx.prepare_cached("INSERT INTO inbox(user_id, msg_id) VALUES (?1, ?2)")?;
                            for r in &recipients {
                                stmt.execute(params![r, seq])?;
                            }
                        }
                        tx.commit()?;
                        Some(Ok(seq))
                    }
                }
            };
            let reply = match seq {
                None => failed("You've used all your message storage. Old messages expire over time."),
                Some(Err(e)) => failed(e),
                Some(Ok(seq)) => {
                    let text = format!(r#"{{"type":"deliver","seq":{seq},"envelope":{env_text}}}"#);
                    for r in &recipients {
                        state.push_user(r, &text, None);
                    }
                    json!({"type": "sent", "id": meta.id, "seq": seq}).to_string()
                }
            };
            drop(_order);
            send_text(socket, reply).await?;
        }

        ClientMsg::Signal { envelope } => {
            {
                let mut last = me.last_signal.lock().unwrap();
                if last.is_some_and(|t| t.elapsed() < SIGNAL_INTERVAL) {
                    return Ok(true);
                }
                *last = Some(Instant::now());
            }
            let Ok(meta) = serde_json::from_value::<EnvelopeMeta>(envelope.clone()) else { return Ok(true) };
            let recipients: HashSet<&str> = meta.keys.iter().map(|k| k.to.as_str()).collect();
            if meta.from != my || recipients.len() > MAX_RECIPIENTS || !recipients.iter().all(|r| valid_user_id(r)) {
                return Ok(true);
            }
            let env_text = serde_json::to_string(&envelope)?;
            if env_text.len() > MAX_SIGNAL_BYTES {
                return Ok(true);
            }
            let text = format!(r#"{{"type":"signal","envelope":{env_text}}}"#);
            for r in &recipients {
                state.push_user(r, &text, if *r == my { Some(session_id) } else { None });
            }
        }

        ClientMsg::VaultPut { req, vault } => {
            if vault.len() > MAX_VAULT_BYTES {
                send_text(socket, err(req, "Settings are too large to sync")).await?;
                return Ok(true);
            }
            {
                let db = state.db.lock().unwrap();
                db.execute("UPDATE accounts SET vault = ?1 WHERE id = ?2", params![vault, my])?;
            }
            state.push_user(my, &json!({"type": "vault", "vault": vault}).to_string(), Some(session_id));
            send_text(socket, ok(req)).await?;
        }

        ClientMsg::Password { req, auth_key, new_salt, new_auth_key, bundle } => {
            if !state.auth_failures.allowed(me.ip) {
                send_text(socket, err(req, "Too many failed attempts. Try again in a few minutes.")).await?;
                return Ok(true);
            }
            let account = state.account_by_username(&me.username)?;
            if !account.is_some_and(|a| auth_matches(&a, &auth_key)) {
                state.auth_failures.hit(me.ip);
                tokio::time::sleep(Duration::from_secs(1)).await;
                send_text(socket, err(req, "Current password is wrong")).await?;
                return Ok(true);
            }
            let Some(new_auth) = decode_len(&new_auth_key, 32)
                .filter(|_| decode_len(&new_salt, 16).is_some() && bundle.len() <= MAX_BUNDLE_BYTES)
            else {
                send_text(socket, err(req, "Invalid data")).await?;
                return Ok(true);
            };
            {
                let db = state.db.lock().unwrap();
                db.execute(
                    "UPDATE accounts SET salt = ?1, auth_hash = ?2, bundle = ?3 WHERE id = ?4",
                    params![new_salt, sha256(&new_auth), bundle, my],
                )?;
                // A new password signs out every other device.
                db.execute("DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2", params![my, me.token_hash])?;
            }
            state.kick_user(my, Some(session_id), "Your password was changed. Sign in again.");
            send_text(socket, ok(req)).await?;
        }

        ClientMsg::Logout => {
            // Only this device's session ends; other devices stay signed in.
            {
                let db = state.db.lock().unwrap();
                db.execute("DELETE FROM sessions WHERE token_hash = ?1", [&me.token_hash])?;
            }
            return Ok(false);
        }

        ClientMsg::Prelogin { req, .. } => {
            let salt: String = {
                let db = state.db.lock().unwrap();
                db.query_row("SELECT salt FROM accounts WHERE id = ?1", [my], |r| r.get(0))?
            };
            send_text(socket, json!({"type": "prelogin", "req": req, "salt": salt}).to_string()).await?
        }
        ClientMsg::Register { .. } | ClientMsg::Login { .. } | ClientMsg::Resume { .. } => {
            send_text(socket, err(0, "Already signed in")).await?
        }
    }
    Ok(true)
}

fn friend_request(state: &AppState, me: &str, to: &str) -> Result<std::result::Result<(), &'static str>> {
    if !valid_user_id(to) {
        return Ok(Err("That doesn't look like a user ID (8 letters and digits)"));
    }
    if to == me {
        return Ok(Err("That's your own ID"));
    }
    if state.username_of(to)?.is_none() {
        return Ok(Err("No user with that ID"));
    }
    if state.are_friends(me, to)? {
        return Ok(Err("You're already friends"));
    }
    {
        let mut db = state.db.lock().unwrap();
        let tx = db.transaction()?;
        let reverse = tx.execute("DELETE FROM friend_requests WHERE from_id = ?1 AND to_id = ?2", [to, me])?;
        if reverse == 1 {
            // They already asked us: that's a yes from both sides.
            tx.execute("DELETE FROM friend_requests WHERE from_id = ?1 AND to_id = ?2", [me, to])?;
            tx.execute("INSERT OR IGNORE INTO friends(a, b) VALUES (?1, ?2), (?2, ?1)", [me, to])?;
        } else {
            let pending: i64 =
                tx.query_row("SELECT count(*) FROM friend_requests WHERE from_id = ?1", [me], |r| r.get(0))?;
            if pending >= MAX_PENDING_REQUESTS {
                return Ok(Err("You have too many pending friend requests"));
            }
            tx.execute("INSERT OR IGNORE INTO friend_requests(from_id, to_id) VALUES (?1, ?2)", [me, to])?;
        }
        tx.commit()?;
    }
    state.push_friends_snapshot(me);
    state.push_friends_snapshot(to);
    Ok(Ok(()))
}
