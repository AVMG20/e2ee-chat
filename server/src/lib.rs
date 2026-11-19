//! Blind relay and mailbox server for e2ee-chat.
//!
//! The server never sees plaintext or private keys. It stores:
//! - accounts: username, public keys, and the user's private keys *encrypted on
//!   their device* with a key derived from their password (the server never gets
//!   the password or that key, only a separate hash used to log in),
//! - who is friends with whom, pending friend requests, and who blocked whom,
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
/// Locked keys: the current pair plus up to 20 earlier ones (kept after changing keys).
const MAX_BUNDLE_BYTES: usize = 16 * 1024;
const MAX_RECIPIENTS: usize = 256;
const MAX_PENDING_REQUESTS: i64 = 100;
/// Signals (typing indicators) are tiny, and limited per session.
const MAX_SIGNAL_BYTES: usize = 8 * 1024;
const SIGNAL_INTERVAL: Duration = Duration::from_millis(500);
/// Sessions (signed-in devices) unused for this long are deleted.
const SESSION_IDLE_DAYS: i64 = 180;
/// User IDs: 8 chars of Crockford base32 (no I, L, O, U).
const ID_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// Max length of a device name ("Firefox on Linux").
const MAX_DEVICE_NAME: usize = 64;
/// Max length of a device's own id and of a signed revoke/delete proof.
const MAX_DEVICE_ID: usize = 64;
/// A proof holds a signature by each of the account's key generations (up to 21).
const MAX_PROOF: usize = 4096;
/// A deleted account's username can't be registered again for this long.
const NAME_HOLD_DAYS: i64 = 365;
/// Sent (with code "revoked") to a device that was signed out from another device.
const REVOKED: &str = "This device was signed out from another device.";
/// Sent (with code "deleted") to the other devices of an account that was deleted.
const DELETED: &str = "This account was deleted.";

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
        /// Shown in the list of signed-in devices.
        #[serde(default)]
        device: String,
        /// Random id the device picked for itself (revoke proofs name it).
        #[serde(default)]
        device_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Login {
        username: String,
        auth_key: String,
        #[serde(default)]
        cursor: i64,
        #[serde(default)]
        device: String,
        #[serde(default)]
        device_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Resume {
        token: String,
        #[serde(default)]
        cursor: i64,
        #[serde(default)]
        device: String,
        #[serde(default)]
        device_id: String,
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
    /// Ends any friendship and pending requests, and stops delivering the user's messages to me.
    Block {
        #[serde(default)]
        req: u64,
        id: String,
    },
    Unblock {
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
    /// Replaces my public keys and locked key bundle (needs the password). Other devices are
    /// signed out; friends get the new keys and their apps ask them to accept the change.
    /// Only applied if my current signing key is still `old_sign_pk` (so two devices changing keys
    /// at once can't leave keys behind). `vault` is re-sealed with the new keys; a new password is optional.
    #[serde(rename_all = "camelCase")]
    RotateKeys {
        #[serde(default)]
        req: u64,
        auth_key: String,
        old_sign_pk: String,
        sign_pk: String,
        enc_pk: String,
        bundle: String,
        #[serde(default)]
        vault: Option<String>,
        #[serde(default)]
        new_salt: Option<String>,
        #[serde(default)]
        new_auth_key: Option<String>,
    },
    /// The newest stored message seq (my own messages signed with keys I replace count up to there).
    Head {
        #[serde(default)]
        req: u64,
    },
    /// Lists my signed-in devices.
    Sessions {
        #[serde(default)]
        req: u64,
    },
    /// Signs out one of my other devices (by its public session id). `proof` is signed by my
    /// key; the server only passes it on (the device checks it before deleting its data).
    RevokeSession {
        #[serde(default)]
        req: u64,
        id: String,
        #[serde(default)]
        proof: String,
    },
    /// Deletes my account and everything the server stores for it. Needs the password.
    #[serde(rename_all = "camelCase")]
    DeleteAccount {
        #[serde(default)]
        req: u64,
        auth_key: String,
        #[serde(default)]
        proof: String,
    },
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

/// An error the client acts on (by `code`), with the signed proof it checks first.
fn err_proof(req: u64, code: &str, message: &str, proof: Option<&str>) -> String {
    json!({"type": "error", "req": req, "code": code, "message": message, "proof": proof}).to_string()
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Why a connection is ended, with the signed proof for revoked / deleted.
struct Kick {
    reason: &'static str,
    proof: Option<String>,
}

struct Session {
    id: u64,
    /// Public id of the device session (sessions.sid).
    sid: String,
    /// Each frame carries a permit for its size from `budget`, released once written.
    tx: mpsc::UnboundedSender<(String, OwnedSemaphorePermit)>,
    budget: Arc<Semaphore>,
    /// Ends the session with this message (too slow to keep up).
    kick: Option<oneshot::Sender<Kick>>,
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
        let mut conn = Connection::open(db_path)
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
             CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
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
             -- a blocked b
             CREATE TABLE IF NOT EXISTS blocks (
                 a TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 b TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                 PRIMARY KEY (a, b)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS blocks_b ON blocks(b);
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

        // 0.3: sessions got a public id, a device name, the device's own id, and a revoked flag
        // with the signed proof the revoked device checks before deleting its data.
        {
            let tx = conn.transaction()?;
            let cols: Vec<String> = tx
                .prepare("SELECT name FROM pragma_table_info('sessions')")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for (col, def) in [
                ("sid", "TEXT"),
                ("name", "TEXT NOT NULL DEFAULT ''"),
                ("device_id", "TEXT NOT NULL DEFAULT ''"),
                ("revoked", "INTEGER NOT NULL DEFAULT 0"),
                ("proof", "TEXT"),
            ] {
                if !cols.iter().any(|c| c == col) {
                    tx.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {col} {def};"))?;
                }
            }
            tx.execute_batch(
                "UPDATE sessions SET sid = lower(hex(randomblob(9))) WHERE sid IS NULL;
                 CREATE UNIQUE INDEX IF NOT EXISTS sessions_sid ON sessions(sid);
                 -- Usernames of deleted accounts stay reserved for a while, so nobody can pose as them.
                 CREATE TABLE IF NOT EXISTS released_names (
                     username TEXT PRIMARY KEY COLLATE NOCASE,
                     released_at INTEGER NOT NULL DEFAULT (unixepoch())
                 );",
            )?;
            tx.commit()?;
        }

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
        db.execute("DELETE FROM released_names WHERE released_at < unixepoch() - ?1", [NAME_HOLD_DAYS * 86_400])?;
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

    fn has_blocked(&self, a: &str, b: &str) -> Result<bool> {
        let db = self.db.lock().unwrap();
        Ok(db.query_row("SELECT 1 FROM blocks WHERE a = ?1 AND b = ?2", [a, b], |_| Ok(())).optional()?.is_some())
    }

    /// Users who blocked `id`: nothing `id` sends reaches them.
    fn blocked_by(&self, id: &str) -> Result<HashSet<String>> {
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare_cached("SELECT a FROM blocks WHERE b = ?1")?;
        let ids = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    /// Friends (with keys and presence), pending requests both ways, and blocked users.
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
        // Requests from blocked users stay pending on their side but are never shown.
        let incoming = requests(
            "SELECT r.from_id, a.username, r.created_at FROM friend_requests r
             JOIN accounts a ON a.id = r.from_id WHERE r.to_id = ?1
             AND NOT EXISTS (SELECT 1 FROM blocks WHERE a = ?1 AND b = r.from_id) ORDER BY r.created_at",
        )?;
        let outgoing = requests(
            "SELECT r.to_id, a.username, r.created_at FROM friend_requests r
             JOIN accounts a ON a.id = r.to_id WHERE r.from_id = ?1 ORDER BY r.created_at",
        )?;
        let blocked = requests(
            "SELECT k.b, a.username, 0 FROM blocks k JOIN accounts a ON a.id = k.b WHERE k.a = ?1 ORDER BY a.username",
        )?;
        Ok(json!({"type": "friends", "friends": friends, "incoming": incoming, "outgoing": outgoing, "blocked": blocked})
            .to_string())
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
                let _ = kick.send(Kick { reason: "Connection too slow, reconnecting", proof: None });
            }
        }
        if now_offline {
            self.presence_changed(user, false);
        }
    }

    /// Disconnects a user's devices (except one).
    fn kick_user(&self, user: &str, except: Option<u64>, reason: &'static str, proof: Option<&str>) {
        self.kick_where(user, reason, proof, |s| Some(s.id) != except);
    }

    /// Disconnects the user's connections that match.
    fn kick_where(&self, user: &str, reason: &'static str, proof: Option<&str>, matches: impl Fn(&Session) -> bool) {
        let mut online = self.online.lock().unwrap();
        if let Some(list) = online.get_mut(user) {
            for s in list.iter_mut().filter(|s| matches(s)) {
                if let Some(k) = s.kick.take() {
                    let _ = k.send(Kick { reason, proof: proof.map(str::to_string) });
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

    /// Returns the new session's token and public id.
    fn create_session(&self, user_id: &str, device: &str, device_id: &str) -> Result<(String, String)> {
        let token = random_token(32);
        let sid = random_token(9);
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO sessions(token_hash, user_id, sid, name, device_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![sha256(token.as_bytes()), user_id, sid, device_name(device), device_id_of(device_id)],
        )?;
        Ok((token, sid))
    }

    /// Ok(None): unknown token. Err(proof) inside: the session was signed out from another
    /// device (said on every attempt until the idle cleanup removes it).
    fn resume_session(
        &self,
        token: &str,
        device: &str,
        device_id: &str,
    ) -> Result<Option<std::result::Result<(String, String, String), Option<String>>>> {
        let db = self.db.lock().unwrap();
        let hash = sha256(token.as_bytes());
        let row: Option<(String, String, String, bool, Option<String>)> = db
            .query_row(
                "SELECT a.id, a.username, s.sid, s.revoked, s.proof FROM sessions s JOIN accounts a ON a.id = s.user_id
                 WHERE s.token_hash = ?1",
                [&hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((id, username, sid, revoked, proof)) = row else { return Ok(None) };
        if revoked {
            return Ok(Some(Err(proof)));
        }
        db.execute(
            "UPDATE sessions SET last_used = unixepoch(),
                 name = CASE WHEN ?2 = '' THEN name ELSE ?2 END,
                 device_id = CASE WHEN ?3 = '' THEN device_id ELSE ?3 END
             WHERE token_hash = ?1",
            params![hash, device_name(device), device_id_of(device_id)],
        )?;
        Ok(Some(Ok((id, username, sid))))
    }

    /// False once the session is revoked or gone (checked again after going online, so a
    /// revoke that raced with the sign-in isn't missed).
    fn session_active(&self, token_hash: &[u8]) -> Result<bool> {
        let db = self.db.lock().unwrap();
        Ok(db
            .query_row("SELECT 1 FROM sessions WHERE token_hash = ?1 AND NOT revoked", [token_hash], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// My signed-in devices, most recently used first.
    fn sessions_of(&self, user: &str, current: &str) -> Result<Value> {
        let online: HashSet<String> =
            self.online.lock().unwrap().get(user).map(|l| l.iter().map(|s| s.sid.clone()).collect()).unwrap_or_default();
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare_cached(
            "SELECT sid, name, created_at, last_used, device_id FROM sessions WHERE user_id = ?1 AND NOT revoked
             ORDER BY last_used DESC",
        )?;
        let rows = stmt
            .query_map([user], |r| {
                let sid: String = r.get(0)?;
                Ok(json!({"id": sid, "name": r.get::<_, String>(1)?, "created": r.get::<_, i64>(2)? * 1000,
                          "lastUsed": r.get::<_, i64>(3)? * 1000, "current": sid == current,
                          "online": online.contains(&sid), "deviceId": r.get::<_, String>(4)?}))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Value::Array(rows))
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
        // Built files: a missing one is a 404, never the app page (an old tab asking for a file
        // from before a deploy must fail clearly, and the service worker must not cache HTML as JS).
        app = app
            .nest_service("/assets", ServeDir::new(dir.join("assets")))
            .fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
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

/// A device's own id: letters, digits, - and _ only.
fn device_id_of(input: &str) -> String {
    if input.len() <= MAX_DEVICE_ID && input.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        input.to_string()
    } else {
        String::new()
    }
}

/// A device label chosen by the client: printable, trimmed and short.
fn device_name(input: &str) -> String {
    let clean: String = input.chars().filter(|c| !c.is_control() && !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')).collect();
    clean.trim().chars().take(MAX_DEVICE_NAME).collect()
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
    /// Public id of this device's session.
    sid: String,
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
            ClientMsg::Register { username, salt, auth_key, sign_pk, enc_pk, bundle, device, device_id } => {
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
                    let held = db
                        .query_row(
                            "SELECT 1 FROM released_names WHERE username = ?1 AND released_at > unixepoch() - ?2",
                            params![username, NAME_HOLD_DAYS * 86_400],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some();
                    for _ in 0..if held { 0 } else { 5 } {
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
                let (token, sid) = state.create_session(&id, &device, &device_id)?;
                let token_hash = sha256(token.as_bytes());
                return Ok(Some(Authed { id, username, cursor: 0, token_hash, sid, ip, last_signal: Mutex::new(None), welcome: json!({"token": token}) }));
            }
            ClientMsg::Login { username, auth_key, cursor, device, device_id } => {
                let account = state.account_by_username(&username)?;
                let Some(a) = account.filter(|a| auth_matches(a, &auth_key)) else {
                    fail_auth(socket, state, ip, "Wrong username or password").await?;
                    return Ok(None);
                };
                let (token, sid) = state.create_session(&a.id, &device, &device_id)?;
                let token_hash = sha256(token.as_bytes());
                let welcome = json!({"token": token, "bundle": a.bundle, "salt": a.salt});
                return Ok(Some(Authed { id: a.id, username: a.username, cursor, token_hash, sid, ip, last_signal: Mutex::new(None), welcome }));
            }
            ClientMsg::Resume { token, cursor, device, device_id } => {
                let (id, username, sid) = match state.resume_session(&token, &device, &device_id)? {
                    Some(Ok(row)) => row,
                    Some(Err(proof)) => {
                        send_text(socket, err_proof(0, "revoked", REVOKED, proof.as_deref())).await?;
                        return Ok(None);
                    }
                    None => {
                        fail_auth(socket, state, ip, "Session expired. Sign in again.").await?;
                        return Ok(None);
                    }
                };
                let token_hash = sha256(token.as_bytes());
                return Ok(Some(Authed { id, username, cursor, token_hash, sid, ip, last_signal: Mutex::new(None), welcome: json!({}) }));
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
                let _ = k.send(Kick { reason: "Signed in on too many devices at once", proof: None });
            }
        }
        list.push(Session { id: session_id, sid: me.sid.clone(), tx, budget, kick: Some(kick) });
        list.len() == 1
    };
    if came_online {
        state.presence_changed(&me.id, true);
    }

    let result = if state.session_active(&me.token_hash)? {
        run_session(&mut socket, &state, &me, session_id, &mut rx, &mut kicked).await
    } else {
        // Revoked while signing in.
        let _ = send_text(&mut socket, err(0, "Session expired. Sign in again.")).await;
        Ok(())
    };

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
    kicked: &mut oneshot::Receiver<Kick>,
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
                let kick = reason.unwrap_or(Kick { reason: "Disconnected", proof: None });
                let frame = match kick.reason {
                    REVOKED => err_proof(0, "revoked", REVOKED, kick.proof.as_deref()),
                    DELETED => err_proof(0, "deleted", DELETED, kick.proof.as_deref()),
                    message => err(0, message),
                };
                let _ = send_text(socket, frame).await;
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
            if state.has_blocked(my, &id)? {
                send_text(socket, err(req, "You blocked this user. Unblock them first.")).await?;
                return Ok(true);
            }
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
        ClientMsg::Block { req, id } => {
            if !valid_user_id(&id) || id == my || state.username_of(&id)?.is_none() {
                send_text(socket, err(req, "No user with that ID")).await?;
                return Ok(true);
            }
            {
                let mut db = state.db.lock().unwrap();
                let tx = db.transaction()?;
                tx.execute("DELETE FROM friends WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)", [my, &id])?;
                tx.execute(
                    "DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)",
                    [my, &id],
                )?;
                tx.execute("INSERT OR IGNORE INTO blocks(a, b) VALUES (?1, ?2)", [my, &id])?;
                tx.commit()?;
            }
            state.push_friends_snapshot(my);
            state.push_friends_snapshot(&id);
            send_text(socket, ok(req)).await?;
        }
        ClientMsg::Unblock { req, id } => {
            {
                let db = state.db.lock().unwrap();
                db.execute("DELETE FROM blocks WHERE a = ?1 AND b = ?2", [my, &id])?;
            }
            state.push_friends_snapshot(my);
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
            // Only one-to-one envelopes are held back from someone who blocked me. Group messages
            // still reach them (their client hides them), so every member sees the same group state.
            let blockers = state.blocked_by(my)?;
            let skip = |r: &str| blockers.contains(r) && recipients.iter().all(|x| *x == my || *x == r);
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
                    // Deleted accounts are skipped (a group with a deleted member keeps working);
                    // there must be someone besides me.
                    let mut known = HashSet::new();
                    {
                        let mut stmt = tx.prepare_cached("SELECT 1 FROM accounts WHERE id = ?1")?;
                        for r in &recipients {
                            if stmt.exists([r])? {
                                known.insert(*r);
                            }
                        }
                    }
                    if !known.iter().any(|r| *r != my) && recipients.iter().any(|r| *r != my) {
                        Some(Err("Unknown recipient"))
                    } else {
                        tx.execute(
                            "INSERT INTO messages(sender, envelope, size) VALUES (?1, ?2, ?3)",
                            params![my, env_text, size],
                        )?;
                        let seq = tx.last_insert_rowid();
                        {
                            let mut stmt = tx.prepare_cached("INSERT INTO inbox(user_id, msg_id) VALUES (?1, ?2)")?;
                            for r in known.iter().filter(|r| !skip(r)) {
                                stmt.execute(params![r, seq])?;
                            }
                        }
                        tx.commit()?;
                        Some(Ok((seq, known)))
                    }
                }
            };
            let reply = match seq {
                None => failed("You've used all your message storage. Old messages expire over time."),
                Some(Err(e)) => failed(e),
                Some(Ok((seq, known))) => {
                    let text = format!(r#"{{"type":"deliver","seq":{seq},"envelope":{env_text}}}"#);
                    for r in known.iter().filter(|r| !skip(r)) {
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
            let blockers = state.blocked_by(my)?;
            let skip = |r: &str| blockers.contains(r) && recipients.iter().all(|x| *x == my || *x == r);
            let text = format!(r#"{{"type":"signal","envelope":{env_text}}}"#);
            for r in recipients.iter().filter(|r| !skip(r)) {
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
                // A new password signs out every other device (signed-out ones keep their row and proof).
                db.execute(
                    "DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2 AND NOT revoked",
                    params![my, me.token_hash],
                )?;
            }
            state.kick_user(my, Some(session_id), "Your password was changed. Sign in again.", None);
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

        ClientMsg::Head { req } => {
            let seq: i64 = {
                let db = state.db.lock().unwrap();
                db.query_row("SELECT coalesce(max(id), 0) FROM messages", [], |r| r.get(0))?
            };
            send_text(socket, json!({"type": "head", "req": req, "seq": seq}).to_string()).await?;
        }

        ClientMsg::RotateKeys { req, auth_key, old_sign_pk, sign_pk, enc_pk, bundle, vault, new_salt, new_auth_key } => {
            if !state.auth_failures.allowed(me.ip) {
                send_text(socket, err(req, "Too many failed attempts. Try again in a few minutes.")).await?;
                return Ok(true);
            }
            let account = state.account_by_username(&me.username)?;
            if !account.is_some_and(|a| a.id == my && auth_matches(&a, &auth_key)) {
                state.auth_failures.hit(me.ip);
                tokio::time::sleep(Duration::from_secs(1)).await;
                send_text(socket, err(req, "Password is wrong")).await?;
                return Ok(true);
            }
            let new_password = match (new_salt, new_auth_key) {
                (Some(salt), Some(key)) => match (decode_len(&salt, 16), decode_len(&key, 32)) {
                    (Some(_), Some(key)) => Some((salt, sha256(&key))),
                    _ => None,
                },
                (None, None) => None,
                _ => {
                    send_text(socket, err(req, "Invalid data")).await?;
                    return Ok(true);
                }
            };
            let bad = decode_len(&sign_pk, 32).is_none()
                || decode_len(&enc_pk, 32).is_none()
                || bundle.len() > MAX_BUNDLE_BYTES
                || vault.as_ref().is_some_and(|v| v.len() > MAX_VAULT_BYTES);
            if bad {
                send_text(socket, err(req, "Invalid data")).await?;
                return Ok(true);
            }
            let changed = {
                let mut db = state.db.lock().unwrap();
                let tx = db.transaction()?;
                let n = tx.execute(
                    "UPDATE accounts SET sign_pk = ?1, enc_pk = ?2, bundle = ?3, vault = coalesce(?4, vault)
                     WHERE id = ?5 AND sign_pk = ?6",
                    params![sign_pk, enc_pk, bundle, vault, my, old_sign_pk],
                )?;
                if n == 1 {
                    if let Some((salt, hash)) = &new_password {
                        tx.execute("UPDATE accounts SET salt = ?1, auth_hash = ?2 WHERE id = ?3", params![salt, hash, my])?;
                    }
                    // Other devices hold the old keys: they sign in again to get the new ones.
                    // Signed-out devices keep their row, so they still learn to delete their data.
                    tx.execute(
                        "DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2 AND NOT revoked",
                        params![my, me.token_hash],
                    )?;
                }
                tx.commit()?;
                n == 1
            };
            if !changed {
                send_text(socket, err(req, "Your keys were just changed on another device. Sign in again.")).await?;
                return Ok(true);
            }
            tracing::info!(user = %my, "keys changed");
            state.kick_user(my, Some(session_id), "Your security keys were changed. Sign in again.", None);
            for friend in state.friend_ids(my)? {
                state.push_friends_snapshot(&friend);
            }
            send_text(socket, ok(req)).await?;
        }

        ClientMsg::Sessions { req } => {
            let sessions = state.sessions_of(my, &me.sid)?;
            send_text(socket, json!({"type": "sessions", "req": req, "sessions": sessions}).to_string()).await?;
        }

        ClientMsg::RevokeSession { req, id, proof } => {
            if id == me.sid {
                send_text(socket, err(req, "Use Sign out to sign out this device")).await?;
                return Ok(true);
            }
            let proof = (!proof.is_empty() && proof.len() <= MAX_PROOF).then_some(proof);
            let n = {
                let db = state.db.lock().unwrap();
                db.execute(
                    "UPDATE sessions SET revoked = 1, proof = ?3 WHERE user_id = ?1 AND sid = ?2 AND NOT revoked",
                    params![my, id, proof],
                )?
            };
            if n == 0 {
                send_text(socket, err(req, "That device is already signed out")).await?;
                return Ok(true);
            }
            state.kick_where(my, REVOKED, proof.as_deref(), |s| s.sid == id);
            send_text(socket, ok(req)).await?;
        }

        ClientMsg::DeleteAccount { req, auth_key, proof } => {
            if !state.auth_failures.allowed(me.ip) {
                send_text(socket, err(req, "Too many failed attempts. Try again in a few minutes.")).await?;
                return Ok(true);
            }
            let account = state.account_by_username(&me.username)?;
            if !account.is_some_and(|a| a.id == my && auth_matches(&a, &auth_key)) {
                state.auth_failures.hit(me.ip);
                tokio::time::sleep(Duration::from_secs(1)).await;
                send_text(socket, err(req, "Password is wrong")).await?;
                return Ok(true);
            }
            // Everyone who might show me in their friends list or requests.
            let affected: Vec<String> = {
                let mut db = state.db.lock().unwrap();
                let tx = db.transaction()?;
                let affected = {
                    let mut stmt = tx.prepare(
                        "SELECT b FROM friends WHERE a = ?1 UNION SELECT to_id FROM friend_requests WHERE from_id = ?1
                         UNION SELECT from_id FROM friend_requests WHERE to_id = ?1 UNION SELECT a FROM blocks WHERE b = ?1",
                    )?;
                    stmt.query_map([my], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
                };
                tx.execute("INSERT OR REPLACE INTO released_names(username) VALUES (?1)", [&me.username])?;
                tx.execute("DELETE FROM inbox WHERE user_id = ?1", [my])?;
                tx.execute("DELETE FROM messages WHERE sender = ?1", [my])?;
                // Cascades to sessions, friends, friend requests and blocks.
                tx.execute("DELETE FROM accounts WHERE id = ?1", [my])?;
                tx.commit()?;
                affected
            };
            tracing::info!(user = %my, "account deleted");
            let proof = (!proof.is_empty() && proof.len() <= MAX_PROOF).then_some(proof);
            state.kick_user(my, Some(session_id), DELETED, proof.as_deref());
            for id in &affected {
                state.push_friends_snapshot(id);
            }
            send_text(socket, ok(req)).await?;
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
    if state.has_blocked(me, to)? {
        return Ok(Err("You blocked this user. Unblock them first."));
    }
    {
        let mut db = state.db.lock().unwrap();
        let tx = db.transaction()?;
        // A request to someone who blocked me is kept (so it looks pending) but never shown to them.
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
