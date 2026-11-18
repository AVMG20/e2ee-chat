//! End-to-end tests of the relay over real websockets.

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use e2ee_chat_server::{AUTH_CONTEXT, AppState, router};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct User {
    name: &'static str,
    key: SigningKey,
}

impl User {
    fn new(name: &'static str, seed: u8) -> Self {
        Self { name, key: SigningKey::from_bytes(&[seed; 32]) }
    }
    fn sign_pk(&self) -> String {
        B64.encode(self.key.verifying_key().to_bytes())
    }
    fn sig(&self, nonce: &str) -> String {
        B64.encode(self.key.sign(format!("{AUTH_CONTEXT}{nonce}").as_bytes()).to_bytes())
    }
}

async fn start() -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::open(&dir.path().join("chat.db"), Some("secret-invite".into())).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(state, None)).await.unwrap() });
    (format!("ws://{addr}/ws"), dir)
}

async fn recv(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for server")
            .expect("stream ended")
            .unwrap();
        if let Message::Text(t) = msg {
            return serde_json::from_str(t.as_str()).unwrap();
        }
    }
}

/// Receive until a message of the given type arrives.
async fn recv_type(ws: &mut Ws, ty: &str) -> Value {
    loop {
        let v = recv(ws).await;
        if v["type"] == ty {
            return v;
        }
    }
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

async fn connect(url: &str) -> (Ws, String) {
    let (mut ws, _) = connect_async(url).await.unwrap();
    let ch = recv(&mut ws).await;
    assert_eq!(ch["type"], "challenge");
    let nonce = ch["nonce"].as_str().unwrap().to_string();
    (ws, nonce)
}

async fn register(url: &str, u: &User, invite: &str) -> (Ws, Value) {
    let (mut ws, nonce) = connect(url).await;
    send(
        &mut ws,
        json!({"type": "register", "name": u.name, "invite": invite, "signPk": u.sign_pk(),
               "encPk": B64.encode([7u8; 32]), "sig": u.sig(&nonce)}),
    )
    .await;
    let reply = recv(&mut ws).await;
    (ws, reply)
}

async fn login(url: &str, u: &User) -> (Ws, Value) {
    let (mut ws, nonce) = connect(url).await;
    send(&mut ws, json!({"type": "login", "name": u.name, "sig": u.sig(&nonce)})).await;
    let reply = recv(&mut ws).await;
    (ws, reply)
}

fn envelope(id: &str, from: &str, to: &[&str]) -> Value {
    json!({"v": 1, "id": id, "from": from, "ts": 0, "eph": "", "nonce": "", "ct": "Q0lQSEVSVEVYVA==",
           "keys": to.iter().map(|t| json!({"to": t, "nonce": "", "ct": ""})).collect::<Vec<_>>(), "sig": ""})
}

#[tokio::test]
async fn registration_rules() {
    let (url, _dir) = start().await;
    let alice = User::new("alice", 1);

    let (_, r) = register(&url, &alice, "wrong").await;
    assert_eq!(r["type"], "error");
    assert_eq!(r["message"], "Wrong invite code");

    let (_, r) = register(&url, &User::new("Bad Name!", 2), "secret-invite").await;
    assert_eq!(r["type"], "error");

    let (_ws, r) = register(&url, &alice, "secret-invite").await;
    assert_eq!(r["type"], "welcome");

    // Someone else can't take the name, even with a valid invite.
    let (_, r) = register(&url, &User::new("alice", 9), "secret-invite").await;
    assert_eq!(r["message"], "That name is already taken");

    // ...or log in as alice without her key.
    let (_, r) = login(&url, &User::new("alice", 9)).await;
    assert_eq!(r["type"], "error");
}

#[tokio::test]
async fn offline_delivery_and_ack() {
    let (url, dir) = start().await;
    let alice = User::new("alice", 1);
    let bob = User::new("bob", 2);
    let (mut a, _) = register(&url, &alice, "secret-invite").await;
    let (b, r) = register(&url, &bob, "secret-invite").await;
    assert_eq!(r["type"], "welcome");
    drop(b); // bob goes offline

    // Alice can't pretend to be bob.
    send(&mut a, json!({"type": "send", "envelope": envelope("x", "bob", &["alice"])})).await;
    let f = recv_type(&mut a, "failed").await;
    assert_eq!((f["id"].as_str(), f["message"].as_str()), (Some("x"), Some("Envelope sender mismatch")));

    send(&mut a, json!({"type": "send", "envelope": envelope("m1", "alice", &["bob"])})).await;
    assert_eq!(recv_type(&mut a, "sent").await["id"], "m1");

    // Bob logs back in and gets the queued envelope.
    let (mut b, r) = login(&url, &bob).await;
    assert_eq!(r["type"], "welcome");
    let d = recv_type(&mut b, "deliver").await;
    assert_eq!(d["envelope"]["id"], "m1");
    let qid = d["qid"].as_i64().unwrap();

    // Alice can't ack (delete) bob's queue entries.
    send(&mut a, json!({"type": "ack", "qids": [qid]})).await;
    send(&mut b, json!({"type": "ack", "qids": [qid]})).await;
    send(&mut b, json!({"type": "ping"})).await;
    recv_type(&mut b, "pong").await;

    let db = rusqlite::Connection::open(dir.path().join("chat.db")).unwrap();
    let left: i64 = db.query_row("SELECT count(*) FROM queue", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "acked envelope is deleted");

    // Live delivery while online.
    send(&mut a, json!({"type": "send", "envelope": envelope("m2", "alice", &["bob"])})).await;
    assert_eq!(recv_type(&mut b, "deliver").await["envelope"]["id"], "m2");
}

#[tokio::test]
async fn unknown_recipient_rejected() {
    let (url, _dir) = start().await;
    let (mut a, _) = register(&url, &User::new("alice", 1), "secret-invite").await;
    send(&mut a, json!({"type": "send", "envelope": envelope("m", "alice", &["nobody"])})).await;
    assert_eq!(recv_type(&mut a, "failed").await["message"], "Unknown recipient");
}

#[tokio::test]
async fn reserved_names_rejected() {
    let (url, _dir) = start().await;
    for (i, name) in ["__proto__", "constructor", "_alice", ".x"].into_iter().enumerate() {
        let (_, r) = register(&url, &User::new(name, 10 + i as u8), "secret-invite").await;
        assert_eq!(r["type"], "error", "{name} should be rejected");
    }
}

#[tokio::test]
async fn security_headers_on_web_app() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
    let state = AppState::open(&dir.path().join("chat.db"), Some("x".into())).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let web = dir.path().to_path_buf();
    tokio::spawn(async move { axum::serve(listener, router(state, Some(web))).await.unwrap() });

    let mut stream = TcpStream::connect(addr).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream.write_all(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut resp = String::new();
    stream.read_to_string(&mut resp).await.unwrap();
    let lower = resp.to_lowercase();
    assert!(lower.contains("content-security-policy: default-src 'self'"), "{resp}");
    assert!(lower.contains("frame-ancestors 'none'"));
    assert!(lower.contains("x-content-type-options: nosniff"));
}
