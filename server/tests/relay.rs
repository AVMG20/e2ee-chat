//! End-to-end tests of the server over real websockets.

use std::net::SocketAddr;

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use e2ee_chat_server::{AppState, Config, router};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start_with_web(web: Option<std::path::PathBuf>) -> (String, SocketAddr, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::open(&dir.path().join("chat.db"), Config::default()).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(state, web).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("ws://{addr}/ws"), addr, dir)
}

async fn start() -> (String, tempfile::TempDir) {
    let (url, _, dir) = start_with_web(None).await;
    (url, dir)
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

fn b64(fill: u8, len: usize) -> String {
    B64.encode(vec![fill; len])
}

struct User {
    id: String,
    token: String,
    ws: Ws,
}

async fn register(url: &str, name: &str, seed: u8) -> Result<User, String> {
    let (mut ws, _) = connect_async(url).await.unwrap();
    send(
        &mut ws,
        json!({"type": "register", "username": name, "salt": b64(seed, 16), "authKey": b64(seed, 32),
               "signPk": b64(seed, 32), "encPk": b64(seed, 32), "bundle": "locked-keys"}),
    )
    .await;
    let r = recv(&mut ws).await;
    if r["type"] != "welcome" {
        return Err(r["message"].as_str().unwrap_or_default().to_string());
    }
    Ok(User { id: r["me"]["id"].as_str().unwrap().into(), token: r["token"].as_str().unwrap().into(), ws })
}

async fn resume(url: &str, token: &str, cursor: i64) -> Ws {
    let (mut ws, _) = connect_async(url).await.unwrap();
    send(&mut ws, json!({"type": "resume", "token": token, "cursor": cursor})).await;
    assert_eq!(recv(&mut ws).await["type"], "welcome");
    ws
}

async fn befriend(a: &mut User, b: &mut User) {
    send(&mut a.ws, json!({"type": "friend_request", "req": 1, "id": b.id})).await;
    assert_eq!(recv_type(&mut a.ws, "ok").await["req"], 1);
    let snap = recv_type(&mut b.ws, "friends").await;
    let snap = if snap["incoming"].as_array().unwrap().is_empty() { recv_type(&mut b.ws, "friends").await } else { snap };
    assert_eq!(snap["incoming"][0]["id"], a.id.as_str());
    send(&mut b.ws, json!({"type": "friend_accept", "req": 2, "id": a.id})).await;
    assert_eq!(recv_type(&mut b.ws, "ok").await["req"], 2);
}

fn envelope(id: &str, from: &str, to: &[&str]) -> Value {
    json!({"v": 1, "id": id, "from": from, "ts": 0, "eph": "", "nonce": "", "ct": "Q0lQSEVSVEVYVA==", "kc": "",
           "keys": to.iter().map(|t| json!({"to": t, "nonce": "", "ct": ""})).collect::<Vec<_>>(), "sig": ""})
}

#[tokio::test]
async fn registration_and_login() {
    let (url, _dir) = start().await;
    let alice = register(&url, "alice", 1).await.unwrap();
    assert_eq!(alice.id.len(), 8);
    assert_eq!(register(&url, "alice", 2).await.err().unwrap(), "That username is taken");
    for bad in ["__proto__", "al", "a b c", "_alice", "Alice"] {
        assert!(register(&url, bad, 3).await.is_err(), "{bad} should be rejected");
    }

    // Prelogin gives the real salt for alice, and a stable fake one for unknown names.
    let (mut ws, _) = connect_async(&url).await.unwrap();
    send(&mut ws, json!({"type": "prelogin", "username": "alice"})).await;
    assert_eq!(recv(&mut ws).await["salt"], b64(1, 16));
    send(&mut ws, json!({"type": "prelogin", "username": "nobody"})).await;
    let fake = recv(&mut ws).await["salt"].clone();
    send(&mut ws, json!({"type": "prelogin", "username": "nobody"})).await;
    assert_eq!(recv(&mut ws).await["salt"], fake);

    // Wrong password.
    send(&mut ws, json!({"type": "login", "username": "alice", "authKey": b64(9, 32)})).await;
    assert_eq!(recv(&mut ws).await["message"], "Wrong username or password");

    // Right password: new session token plus the locked key bundle.
    let (mut ws, _) = connect_async(&url).await.unwrap();
    send(&mut ws, json!({"type": "login", "username": "alice", "authKey": b64(1, 32)})).await;
    let w = recv(&mut ws).await;
    assert_eq!((w["type"].as_str(), w["bundle"].as_str()), (Some("welcome"), Some("locked-keys")));
    assert_eq!(w["me"]["id"], alice.id.as_str());
    assert!(w["token"].is_string());

    // Resume with the first device's token; a bad token fails.
    resume(&url, &alice.token, 0).await;
    let (mut ws, _) = connect_async(&url).await.unwrap();
    send(&mut ws, json!({"type": "resume", "token": "nope"})).await;
    assert_eq!(recv(&mut ws).await["type"], "error");
}

#[tokio::test]
async fn friends_by_id() {
    let (url, _dir) = start().await;
    let mut a = register(&url, "alice", 1).await.unwrap();
    let mut b = register(&url, "bob", 2).await.unwrap();

    send(&mut a.ws, json!({"type": "friend_request", "req": 7, "id": "ZZZZZZZZ"})).await;
    assert_eq!(recv_type(&mut a.ws, "error").await["message"], "No user with that ID");
    send(&mut a.ws, json!({"type": "friend_request", "req": 8, "id": a.id})).await;
    assert_eq!(recv_type(&mut a.ws, "error").await["message"], "That's your own ID");

    // IDs are accepted with dashes / lower case.
    let pretty = format!("{}-{}", &b.id[..4], &b.id[4..]).to_lowercase();
    send(&mut a.ws, json!({"type": "friend_request", "req": 9, "id": pretty})).await;
    assert_eq!(recv_type(&mut a.ws, "ok").await["req"], 9);
    let snap = loop {
        let s = recv_type(&mut b.ws, "friends").await;
        if !s["incoming"].as_array().unwrap().is_empty() {
            break s;
        }
    };
    assert_eq!(snap["incoming"][0]["name"], "alice");
    send(&mut b.ws, json!({"type": "friend_accept", "req": 1, "id": a.id})).await;
    let snap = loop {
        let s = recv_type(&mut a.ws, "friends").await;
        if s["friends"].as_array().unwrap().len() == 1 {
            break s;
        }
    };
    assert_eq!(snap["friends"][0]["name"], "bob");
    assert_eq!(snap["friends"][0]["online"], true);
    assert_eq!(snap["friends"][0]["signPk"], b64(2, 32));

    // Removing works both ways.
    send(&mut b.ws, json!({"type": "friend_remove", "req": 2, "id": a.id})).await;
    loop {
        let s = recv_type(&mut a.ws, "friends").await;
        if s["friends"].as_array().unwrap().is_empty() {
            break;
        }
    }
}

#[tokio::test]
async fn multi_device_sync() {
    let (url, _dir) = start().await;
    let mut a = register(&url, "alice", 1).await.unwrap();
    let mut b = register(&url, "bob", 2).await.unwrap();
    befriend(&mut a, &mut b).await;
    let (bob_id, bob_token) = (b.id.clone(), b.token.clone());
    drop(b); // bob goes offline

    // Alice can't pretend to be bob.
    send(&mut a.ws, json!({"type": "send", "envelope": envelope("x", &bob_id, &[&a.id])})).await;
    assert_eq!(recv_type(&mut a.ws, "failed").await["message"], "Envelope sender mismatch");

    send(&mut a.ws, json!({"type": "send", "envelope": envelope("m1", &a.id, &[&bob_id, &a.id])})).await;
    let seq1 = recv_type(&mut a.ws, "sent").await["seq"].as_i64().unwrap();
    // Alice's own copy is delivered to her devices too.
    assert_eq!(recv_type(&mut a.ws, "deliver").await["envelope"]["id"], "m1");
    send(&mut a.ws, json!({"type": "send", "envelope": envelope("m2", &a.id, &[&bob_id, &a.id])})).await;
    let seq2 = recv_type(&mut a.ws, "sent").await["seq"].as_i64().unwrap();

    // Bob's "phone" syncs from scratch and gets both.
    let mut phone = resume(&url, &bob_token, 0).await;
    assert_eq!(recv_type(&mut phone, "deliver").await["envelope"]["id"], "m1");
    assert_eq!(recv_type(&mut phone, "deliver").await["envelope"]["id"], "m2");
    assert_eq!(recv_type(&mut phone, "synced").await["seq"], seq2);

    // Bob's "laptop" already has m1 and only gets m2.
    let mut laptop = resume(&url, &bob_token, seq1).await;
    let d = recv_type(&mut laptop, "deliver").await;
    assert_eq!((d["envelope"]["id"].as_str(), d["seq"].as_i64()), (Some("m2"), Some(seq2)));

    // Live delivery reaches every device.
    send(&mut a.ws, json!({"type": "send", "envelope": envelope("m3", &a.id, &[&bob_id])})).await;
    assert_eq!(recv_type(&mut phone, "deliver").await["envelope"]["id"], "m3");
    assert_eq!(recv_type(&mut laptop, "deliver").await["envelope"]["id"], "m3");

    // Unknown recipients are refused.
    send(&mut a.ws, json!({"type": "send", "envelope": envelope("m4", &a.id, &["ZZZZZZZZ"])})).await;
    assert_eq!(recv_type(&mut a.ws, "failed").await["message"], "Unknown recipient");
}

#[tokio::test]
async fn vault_syncs_to_other_devices() {
    let (url, _dir) = start().await;
    let mut a = register(&url, "alice", 1).await.unwrap();
    let mut other = resume(&url, &a.token, 0).await;
    recv_type(&mut other, "synced").await;

    send(&mut a.ws, json!({"type": "vault_put", "req": 5, "vault": "sealed"})).await;
    assert_eq!(recv_type(&mut a.ws, "ok").await["req"], 5);
    assert_eq!(recv_type(&mut other, "vault").await["vault"], "sealed");

    let (mut third, _) = connect_async(&url).await.unwrap();
    send(&mut third, json!({"type": "resume", "token": a.token})).await;
    assert_eq!(recv_type(&mut third, "welcome").await["vault"], "sealed");
}

#[tokio::test]
async fn password_change() {
    let (url, _dir) = start().await;
    let mut a = register(&url, "alice", 1).await.unwrap();
    send(&mut a.ws, json!({"type": "password", "req": 1, "authKey": b64(9, 32), "newSalt": b64(4, 16),
                           "newAuthKey": b64(4, 32), "bundle": "relocked"}))
    .await;
    assert_eq!(recv_type(&mut a.ws, "error").await["message"], "Current password is wrong");
    send(&mut a.ws, json!({"type": "password", "req": 2, "authKey": b64(1, 32), "newSalt": b64(4, 16),
                           "newAuthKey": b64(4, 32), "bundle": "relocked"}))
    .await;
    assert_eq!(recv_type(&mut a.ws, "ok").await["req"], 2);

    let (mut ws, _) = connect_async(&url).await.unwrap();
    send(&mut ws, json!({"type": "login", "username": "alice", "authKey": b64(4, 32)})).await;
    assert_eq!(recv(&mut ws).await["bundle"], "relocked");
    // The existing session keeps working.
    resume(&url, &a.token, 0).await;
}

#[tokio::test]
async fn security_headers_on_web_app() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
    let (_, addr, _db) = start_with_web(Some(dir.path().to_path_buf())).await;

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
