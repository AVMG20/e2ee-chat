# E2EE Chat

A small, self-hosted chat app for you and your friends, with **end-to-end encryption**.
Run the server on your own box. Chat in the browser or with the desktop app (Windows, macOS, Linux).

The server can never read your messages, files or group names. It only relays encrypted
blobs and deletes them once they've been delivered.

- Direct messages and group chats (as many groups as you like)
- Rich text (bold, italic, code, lists, quotes, links) with a Tiptap editor
- Encrypted file and image sharing (up to 10 MB)
- Offline delivery: messages wait (encrypted) on the server until your friend comes online
- Key fingerprints to verify each other, plus warnings if someone's key changes
- One small Rust server binary with SQLite. No other services needed.

MIT licensed. Built with Rust (axum, Tauri), Vue 3, shadcn-vue, Tiptap and the audited
[`@noble`](https://paulmillr.com/noble/) crypto libraries.

## How the encryption works

Each device generates its own keys. Private keys never leave the device.

| Key | Algorithm | Used for |
|---|---|---|
| Signing key | Ed25519 | logging in (challenge/response, no passwords) and signing every message |
| Encryption key | X25519 | receiving message keys |

Sending a message (DM or group):

1. The payload (text, file, or group update) is encrypted with a fresh random key using **XChaCha20-Poly1305**.
2. That key is wrapped separately for each recipient using an ephemeral X25519 key exchange + **HKDF-SHA256**.
3. The whole envelope (sender, time, ciphertext, a hash commitment to the message key, recipient
   list) is **signed with Ed25519**.
4. Recipients check the signature against the sender's **pinned** key before decrypting, so the
   server can't forge, alter or re-route messages. Each device remembers which messages it has
   already processed and refuses old ones, so the server can't replay them either.

Groups exist only inside encrypted messages. The server never learns a group's name or id.

**What the server *can* see:** usernames, public keys, and for every message: who sent it, who it
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
- Private keys are stored unencrypted in the browser/app storage (IndexedDB) on your device.
- One device per account. Using the web and the desktop app means two accounts.
- The **web version** trusts the JavaScript served by your server. If you don't trust the server
  operator, use the **desktop app**, which ships its own copy of the UI.
- The crypto design hasn't been professionally audited (the libraries it uses have been).

## Self-hosting

### Docker

```bash
docker build -t e2ee-chat .
docker run -d --name e2ee-chat -p 8080:8080 -v e2ee-chat-data:/data \
  -e INVITE_CODE=pick-a-long-random-code e2ee-chat
```

Open `http://your-server:8080`, create an account with the invite code, and send the invite
code to your friends. **Put it behind HTTPS** (e.g. Caddy: `chat.example.com { reverse_proxy localhost:8080 }`).

### Without Docker

```bash
cd web && bun install && bun run build && cd ..
cargo build --release -p e2ee-chat-server
INVITE_CODE=pick-a-long-random-code WEB_DIR=web/dist ./target/release/e2ee-chat-server
```

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | port to listen on |
| `BIND` | `0.0.0.0` | address to listen on |
| `DATA_DIR` | `./data` | where `chat.db` lives |
| `INVITE_CODE` | generated, printed at start | needed to create an account |
| `WEB_DIR` | none | built web app (`web/dist`) to serve |

Undelivered messages are dropped after 30 days. Each user's mailbox of undelivered messages is
capped at 256 MB.

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
INVITE_CODE=dev cargo run -p e2ee-chat-server
# terminal 2: web UI with hot reload (proxies /ws to :8080)
cd web && bun install && bun run dev
# desktop app with hot reload
cd web && bunx tauri dev
```

Tests: `cargo test -p e2ee-chat-server` and `cd web && bun test`.

## License

[MIT](LICENSE)
