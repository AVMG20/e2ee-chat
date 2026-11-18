# E2EE Chat

A small, self-hosted chat app for you and your friends, with **end-to-end encryption**.
Run the server on your own box. Chat in the browser or with the desktop app (Windows, macOS, Linux).

The server can never read your messages, files or group names. It only stores and relays
encrypted blobs.

- Open sign-up with a username and password. One account works in the browser and the desktop app, on as many devices as you like
- Add friends by their user ID (like `7K3Q-X9PA`), Discord style
- Direct messages and group chats (as many groups as you like)
- Rich text (bold, italic, code, lists, quotes, links) with a Tiptap editor
- Encrypted file and image sharing (up to 10 MB)
- Message history on every device you sign in to (kept encrypted on the server for 180 days)
- Key fingerprints to verify each other, plus warnings if someone's key changes
- One small Rust server binary with SQLite. No other services needed.

MIT licensed. Built with Rust (axum, Tauri), Vue 3, shadcn-vue, Tiptap and the audited
[`@noble`](https://paulmillr.com/noble/) crypto libraries.

## How the encryption works

Your keys are created on your device when you sign up.

| Key | Algorithm | Used for |
|---|---|---|
| Signing key | Ed25519 | signing every message |
| Encryption key | X25519 | receiving message keys |

To use the same account on several devices, the private keys are stored on the server
**locked with your password**:

- Your password goes through **Argon2id** (64 MB, 3 passes) on your device. Two keys are derived from the result.
- The *login key* is sent to the server, which stores only its hash.
- The *lock key* never leaves your device. It encrypts your private keys (XChaCha20-Poly1305) before they're uploaded.
- Signing in on a new device downloads the locked keys and unlocks them with your password.

The server never sees your password, so it can't unlock your keys. Contact keys you've pinned,
"verified" marks and your groups are synced between your devices the same way, encrypted.

Sending a message (DM or group):

1. The payload (text, file, or group update) is encrypted with a fresh random key using **XChaCha20-Poly1305**.
2. That key is wrapped separately for each recipient using an ephemeral X25519 key exchange + **HKDF-SHA256**.
3. The whole envelope (sender, time, ciphertext, a hash commitment to the message key, recipient
   list) is **signed with Ed25519**.
4. Recipients check the signature against the sender's **pinned** key before decrypting, so the
   server can't forge, alter or re-route messages. Each device remembers which messages it has
   already processed and refuses repeats, so the server can't replay them either.

Groups exist only inside encrypted messages. The server never learns a group's name or id.

**What the server *can* see:** usernames, user IDs, who is friends with whom, public keys, and for every message: who sent it, who it
goes to, when, and how big it is. A group message is sent to all members at once, so the server
can see who tends to talk together (a likely member list), just not what the group is called or
what is said.

### Verifying your friends

The first time you see someone's key, the app trusts it ("trust on first use"). To rule out
a malicious server swapping keys at that moment, open a DM, click **Verify**, and compare
the fingerprint with your friend in person or on a call. If someone's key ever changes, the
app blocks the conversation until you accept the new key.

### Known limitations

This is a hobby-scale app, not Signal. In particular:

- No forward secrecy: if someone steals a device's keys, they can decrypt that device's past messages that they captured.
- **Your password protects your keys.** Whoever has the server's database can try to guess it
  offline (Argon2id makes each guess slow, but a weak password will still fall). Use a long one.
  There is no password reset: if you forget it, your account is gone.
- On a signed-in device, keys and history sit unencrypted in the browser/app storage (IndexedDB).
  Signing out deletes them from that device.
- The **web version** trusts the JavaScript served by your server. If you don't trust the server
  operator, use the **desktop app**, which ships its own copy of the UI.
- The crypto design hasn't been professionally audited (the libraries it uses have been).

## Self-hosting

### Docker

```bash
docker build -t e2ee-chat .
docker run -d --name e2ee-chat -p 8080:8080 -v e2ee-chat-data:/data e2ee-chat
```

Open `http://your-server:8080`, create an account, and send your user ID to your friends.
**Put it behind HTTPS** (e.g. Caddy: `chat.example.com { reverse_proxy localhost:8080 }`).

### Without Docker

```bash
cd web && bun install && bun run build && cd ..
cargo build --release -p e2ee-chat-server
WEB_DIR=web/dist ./target/release/e2ee-chat-server
```

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | port to listen on |
| `BIND` | `0.0.0.0` | address to listen on |
| `DATA_DIR` | `./data` | where `chat.db` lives |
| `WEB_DIR` | none | built web app (`web/dist`) to serve |
| `RETENTION_DAYS` | `180` | encrypted messages older than this are deleted from the server |
| `TRUST_PROXY` | `false` | set to `true` behind a reverse proxy, so rate limits use the client's IP from `X-Forwarded-For` |

Each user can store up to 512 MB of (encrypted) messages and files on the server. Sign-in and
sign-up are rate-limited per IP.

The server sends a strict Content-Security-Policy with the web app. If you put it behind a reverse
proxy, don't let the proxy strip or replace that header.

## Desktop app

Download it from [Releases](../../releases), or build it yourself:

```bash
cd web && bun install && bunx tauri build
```

On first start, enter your server's address (e.g. `https://chat.example.com`).
Links in messages open in your normal browser.
The macOS and Windows builds aren't code-signed, so you may need to allow them in your OS security settings.

## Development

```bash
# terminal 1: server (API only)
cargo run -p e2ee-chat-server
# terminal 2: web UI with hot reload (proxies /ws to :8080)
cd web && bun install && bun run dev
# desktop app with hot reload
cd web && bunx tauri dev
```

Tests: `cargo test -p e2ee-chat-server` and `cd web && bun test`.

## License

[MIT](LICENSE)
